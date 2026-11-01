/**
 * Orchestrators on Vercel Sandbox (the `vercel` OrchestratorHost, deploy/orchestrator-host.ts). Driven only by the
 * API's autoscaler, through the API's Vercel REST client (src/vercel-sandbox.ts, the function's OIDC token). The token
 * never enters a sandbox: the orchestrator gets its job's worker token in a 0600 env file, and asks the API's broker for
 * its worker sandboxes (/api/worker/sandboxes, phase 1).
 *
 * Lifecycle (the boat steps, by the same names, so launch errors classify the same way):
 *   create      POST /v2/sandboxes, named `<ns>-vo-<env>-v<hex>` (non-persistent, node24, OCTILLION_VERCEL_ORCH_TIMEOUT_MINUTES),
 *               or from the current code's snapshot (OCTILLION_ORCH_SNAPSHOT=on). The name is the sandbox id we record.
 *   ready       the session runs; find Node (/vercel/runtimes/node*\/bin)
 *   code upload the boat tarball (deploy/boat-lib.ts tarball()) in chunks through fs/write, then `npm ci` under /opt/octillion
 *   configure   the service user `octi` (no sudo), the 0600 env file it owns, the supervisor script and the root-owned
 *               marker /etc/octillion/host-role {"role":"vercel-orchestrator",...}; optional network policy
 *   preflight   as `octi` with its env: the host guard passes here, and OCTILLION_URL/healthz answers
 *   start       the supervisor as a detached Vercel command (Vercel Sandbox has no systemd)
 *
 * The supervisor (SUPERVISOR below) is what the boat unit's Restart=on-failure does: it restarts a crashed orchestrator
 * after 10 s (60 s while it keeps dying within a minute), stays down after a clean exit (the idle / job-over exit 0), and
 * forwards SIGTERM for a graceful stop. It logs to /var/lib/octi/orchestrator.log.
 *
 * Lifetime: Vercel stops a session at its timeout (at most 24 h on Pro, 45 min on Hobby). The launch records when, and
 * the autoscaler retires the orchestrator OCTILLION_VERCEL_ORCH_RELAUNCH_MINUTES before that (claims nothing new, a fresh
 * orchestrator takes over the job, the old one is deleted once its sessions finish).
 */
import { randomBytes } from "node:crypto";
import { VERCEL_SIZES, vercelEstCostUsd } from "../core/config.js";
import { sleep } from "../core/util.js";
import * as lib from "./boat-lib.js";
import type { HostLaunchOpts, HostLaunchResult, HostLimits, HostSandbox, OrchestratorHost } from "./orchestrator-host.js";

/** The subset of the API's Vercel client (src/vercel-sandbox.ts VercelClient) a host needs. Structural: no import of src/. */
export interface VercelSandboxApi {
  create(o: { name: string; vcpus: number; memoryMb: number; timeoutMs: number; tags?: Record<string, string>; snapshotId?: string | null }): Promise<{ name: string; session: string | null }>;
  get(name: string): Promise<{ status: string; session: string | null; sessionStatus: string }>;
  remove(name: string): Promise<void>;
  list(prefix: string, deadline?: number): Promise<{ name: string; createdAt: number | null; status: string }[]>;
  run(session: string, script: string): Promise<string>;
  status(session: string, cmd: string, wait?: boolean, timeoutMs?: number): Promise<{ exitCode: number | null }>;
  logs(session: string, cmd: string, signal: AbortSignal): AsyncGenerator<{ stream: string; data: string }>;
  kill(session: string, cmd: string, signal?: number): Promise<void>;
  writeFile(session: string, path: string, content: Buffer): Promise<void>;
  networkPolicy(session: string, allow: string[]): Promise<void>;
  snapshot(session: string, expirationMs: number): Promise<{ id: string; status: string }>;
  listSnapshots(name: string): Promise<{ id: string; status: string; createdAt: number | null }[]>;
  deleteSnapshot(id: string): Promise<void>;
}

const env = process.env;
const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

/** Tuning (environment variables on the API; read at call time). */
export const VERCEL_ORCH = {
  /** Session timeout. Vercel's maximum: 24 h on Pro and Enterprise, 45 min on Hobby (vercel.com/docs/sandbox/pricing). */
  timeoutMinutes: () => Math.max(10, Math.min(1440, num(env.OCTILLION_VERCEL_ORCH_TIMEOUT_MINUTES, 1440))),
  /**
   * Retire and replace an orchestrator this long before its timeout: one session's limit plus a margin, so the sessions
   * it still runs finish first. Never more than half the timeout (a short timeout must not retire it on launch).
   */
  relaunchMinutes: () => Math.max(5, Math.min(Math.floor(VERCEL_ORCH.timeoutMinutes() / 2),
    num(env.OCTILLION_VERCEL_ORCH_RELAUNCH_MINUTES, num(env.MAX_SESSION_MINUTES, 45) + 15))),
  size: () => (VERCEL_SIZES[env.OCTILLION_VERCEL_ORCH_SIZE ?? ""] ? env.OCTILLION_VERCEL_ORCH_SIZE! : "small"),
  /** Static limits: Vercel has no limits API. Pro: 10,000 concurrent sandboxes. */
  maxConcurrent: () => Math.max(1, num(env.OCTILLION_VERCEL_MAX_CONCURRENT, 10_000)),
  /** Our own cap on orchestrator launches (Vercel's vCPU allocation rate is far higher): against runaway launch loops. */
  startsPerHour: () => Math.max(1, num(env.OCTILLION_VERCEL_ORCH_STARTS_PER_HOUR, 120)),
  /** `locked`: apply a network policy (OCTILLION_URL's host, the npm registry, OCTILLION_VERCEL_ORCH_EGRESS_HOSTS). */
  egress: () => ((env.OCTILLION_VERCEL_ORCH_EGRESS ?? "open").trim().toLowerCase() === "locked" ? "locked" : "open") as "locked" | "open",
  egressHosts: () => (env.OCTILLION_VERCEL_ORCH_EGRESS_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter((h) => /^(\*\.)?[a-z0-9.-]+\.[a-z]{2,}$/.test(h)),
  snapshotDays: () => Math.max(1, num(env.OCTILLION_VERCEL_ORCH_SNAPSHOT_DAYS, 7)),
  /** Longest single command we wait on (the launch runs in a 300 s function). */
  execMaxSeconds: () => Math.max(30, Math.min(280, num(env.OCTILLION_VERCEL_ORCH_EXEC_MAX_SECONDS, 240))),
};

/** Where things live inside a Vercel orchestrator sandbox. */
export const VHOME = "/opt/octillion";
export const VSTATE = "/var/lib/octi";
export const VENV = `${VHOME}/orchestrator.env`;
export const VLOG = `${VSTATE}/orchestrator.log`;
export const VPID = `${VSTATE}/supervisor.pid`;
const STAGE = "/tmp/octi-stage";
const CHUNK = 3_500_000;

/** `<ns>-vo-<env>-`: Vercel orchestrator names for this deployment (production and previews share one project). */
export const vercelOrchPrefix = (namespace: string, envTag: string) => `${namespace}-vo-${envTag}-`;
const imagePrefixOf = (namespace: string, envTag: string) => `${namespace}-vimg-${envTag}-`;

export const vercelOrchCostUsd = (seconds: number) => vercelEstCostUsd(VERCEL_ORCH.size(), Math.max(0, seconds));

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The supervisor. Runs as `octi` (started through sudo with a clean environment: PATH and HOME only). Each start reads
 * the env file in a subshell, so nothing of the Vercel command runner's environment reaches the orchestrator.
 */
export const SUPERVISOR = `#!/bin/bash
# Octillion orchestrator supervisor (Vercel Sandbox has no systemd): restart after a crash, stay down after a clean exit.
set -u
umask 077
LOG=${VLOG}
echo $$ > ${VPID}
child=0; stopping=0; crashes=0
stop() { stopping=1; if [ "$child" -gt 0 ]; then kill -TERM "$child" 2>/dev/null; fi; }
trap stop TERM INT HUP
cd ${VHOME}/app || exit 1
note() { echo "[supervisor $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >>"$LOG"; }
note "start"
while :; do
  ( set -a; . ${VENV}; set +a; exec ${VHOME}/app/orchestrator/node_modules/.bin/tsx orchestrator/pi-octillion/main.ts ) >>"$LOG" 2>&1 &
  child=$!; started=$(date +%s)
  wait "$child"; code=$?
  # A trapped signal interrupts wait: keep waiting until the orchestrator has finished its graceful stop.
  while kill -0 "$child" 2>/dev/null; do wait "$child"; code=$?; done
  child=0
  note "orchestrator exited with $code"
  [ "$stopping" = 1 ] && break
  [ "$code" = 0 ] && break
  if [ $(( $(date +%s) - started )) -lt 60 ]; then crashes=$((crashes + 1)); else crashes=0; fi
  if [ "$crashes" -gt 5 ]; then delay=60; else delay=10; fi
  note "restarting in \${delay}s"
  sleep "$delay" & wait $!
  [ "$stopping" = 1 ] && break
done
note "stopped"
rm -f ${VPID}
`;

/** Run a command to the end (or `timeoutSec`) and read its output. */
export async function vexec(c: VercelSandboxApi, session: string, script: string, timeoutSec = 60): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const id = await c.run(session, script);
  const deadline = Date.now() + timeoutSec * 1000;
  let exitCode: number | null = null;
  while (exitCode == null && Date.now() < deadline) {
    const left = Math.max(1000, Math.min(60_000, deadline - Date.now()));
    try { exitCode = (await c.status(session, id, true, left + 2000)).exitCode; }
    catch (e) { if (!/abort|timeout/i.test(String((e as Error)?.name) + String((e as Error)?.message))) throw e; }
  }
  if (exitCode == null) { await c.kill(session, id).catch(() => {}); throw new Error(`command did not finish within ${timeoutSec}s`); }
  let stdout = "", stderr = "";
  try {
    for await (const f of c.logs(session, id, AbortSignal.timeout(30_000))) {
      if (f.stream === "stdout") stdout += f.data; else if (f.stream === "stderr") stderr += f.data;
    }
  } catch { /* output is best effort; the exit code is what counts */ }
  return { code: exitCode, stdout, stderr };
}

/** As `octi`, with the orchestrator's env file loaded (preflight, guard). */
const asService = (path: string, cmd: string) =>
  `sudo -n -u octi env -i PATH=${q(path)} HOME=${VSTATE} bash -c ${q(`cd ${VHOME}/app/orchestrator && set -a && . ${VENV} && set +a && ${cmd}`)}`;

const ENV_VALUE = /^[A-Za-z0-9._:\/=+-]{1,4096}$/;

export interface VercelHostOptions { client: VercelSandboxApi; namespace: string; envTag: string }

export function vercelHost(o: VercelHostOptions): OrchestratorHost {
  const c = o.client;
  const orchPrefix = vercelOrchPrefix(o.namespace, o.envTag);
  const imagePrefix = imagePrefixOf(o.namespace, o.envTag);
  const sessions = new Map<string, string>(); // name -> session id (this process)
  const isLiveStatus = (s: string) => !["stopped", "stopping", "failed", "aborted", "snapshotting", "deleted"].includes(s);
  const sessionOf = async (name: string) => {
    const known = sessions.get(name);
    if (known) return known;
    const g = await c.get(name);
    if (!g.session) throw new Error(`sandbox ${name} has no running session (${g.sessionStatus || g.status})`);
    sessions.set(name, g.session);
    return g.session;
  };
  const write = (session: string, path: string, body: Buffer | string) => c.writeFile(session, path, Buffer.isBuffer(body) ? body : Buffer.from(body));
  const run = async (session: string, script: string, timeoutSec = 60) => vexec(c, session, script, Math.min(timeoutSec, VERCEL_ORCH.execMaxSeconds()));

  async function waitRunning(name: string, timeoutMs = 120_000): Promise<string> {
    for (const t0 = Date.now(); Date.now() - t0 < timeoutMs; await sleep(1500)) {
      const g = await c.get(name);
      const st = g.sessionStatus || g.status;
      if (st === "running" && g.session) { sessions.set(name, g.session); return g.session; }
      if (["failed", "aborted", "stopped", "stopping"].includes(st)) throw new Error(`sandbox ${name} is ${st}`);
    }
    throw new Error(`sandbox ${name} not running after ${timeoutMs / 1000}s`);
  }

  async function nodeDir(session: string): Promise<string> {
    const r = await run(session, "d=$(ls -d /vercel/runtimes/node*/bin 2>/dev/null | sort -V -r | head -1); [ -n \"$d\" ] || d=$(dirname \"$(command -v node)\" 2>/dev/null); echo \"$d\"", 30);
    const d = r.stdout.trim().split("\n").pop() ?? "";
    if (!/^\/[\w./-]+$/.test(d)) throw new Error(`no node found in the sandbox (${(r.stderr || r.stdout).slice(-200)})`);
    return d;
  }
  const pathOf = (node: string) => `${node}:/usr/local/bin:/usr/bin:/bin`;

  /** The code: boat's tarball through fs/write in chunks, assembled and installed as root under /opt/octillion. */
  async function uploadCode(session: string, node: string, root?: string): Promise<number> {
    const tgz = lib.tarball(root);
    let r = await run(session, `rm -rf ${STAGE} && install -d -m 700 ${STAGE}`, 30);
    if (r.code !== 0) throw new Error(`staging failed: ${r.stderr.slice(-300)}`);
    const parts = Math.ceil(tgz.length / CHUNK);
    for (let i = 0; i < parts; i++) await write(session, `${STAGE}/code.tgz.part${String(i).padStart(3, "0")}`, tgz.subarray(i * CHUNK, (i + 1) * CHUNK));
    r = await run(session, `set -e; export PATH=${q(pathOf(node))}
sudo -n cat ${STAGE}/code.tgz.part* > ${STAGE}/code.tgz
sudo -n install -d -m 755 ${VHOME}; cd ${VHOME}; sudo -n rm -rf app.new; sudo -n mkdir app.new
sudo -n tar -xzf ${STAGE}/code.tgz -C app.new --no-same-owner; rm -rf ${STAGE}
cd app.new/orchestrator && sudo -n env PATH="$PATH" HOME=/root npm ci --omit=dev --no-audit --no-fund >/dev/null 2>/tmp/octi-npm.err || { tail -20 /tmp/octi-npm.err >&2; exit 1; }
cd ${VHOME}; sudo -n rm -rf app.old; if [ -d app ]; then sudo -n mv app app.old; fi; sudo -n mv app.new app; sudo -n rm -rf app.old; sudo -n chmod -R a+rX app`, VERCEL_ORCH.execMaxSeconds());
    if (r.code !== 0) throw new Error(`code deploy failed: ${r.stderr.slice(-800)}`);
    return tgz.length;
  }

  async function configure(session: string, name: string, orchId: string, ctx: lib.LaunchContext) {
    const token = ctx.placeholderToken ? "selftest-placeholder-not-a-token" : ctx.workerToken;
    if (!/^https:\/\//.test(ctx.url) || !ENV_VALUE.test(ctx.url)) throw new Error(`OCTILLION_URL must be a plain https URL (got ${ctx.url.slice(0, 80)})`);
    if (!ENV_VALUE.test(token)) throw new Error("the worker token has characters an env file cannot hold");
    const tuning = Object.entries(ctx.tuning ?? {}).filter(([k, v]) => (lib.TUNING_VARS as readonly string[]).includes(k) && /^[A-Za-z0-9._-]{1,32}$/.test(v)).map(([k, v]) => `${k}=${v}`);
    const envBody = [
      `OCTILLION_URL=${ctx.url}`, `OCTILLION_WORKER_TOKEN=${token}`, `ORCHESTRATOR_ID=${orchId}`,
      // RUNNER=boat: the server's choice picks the workers (OCTILLION_SANDBOX_PROVIDER), as on boat orchestrators.
      "RUNNER=boat", `POD_CAPACITY=${ctx.podCapacity}`, "OCTILLION_HOST_ROLE=vercel-orchestrator", `OCTILLION_SANDBOX_ID=${name}`, ...tuning, "",
    ].join("\n");
    await write(session, `/tmp/octi-orchestrator.env.new`, envBody);
    await write(session, `/tmp/octi-supervisor.sh`, SUPERVISOR);
    const marker = JSON.stringify({ role: "vercel-orchestrator", provider: "vercel", sandbox_id: name, orchestrator_id: orchId });
    const r = await run(session, `set -e
id octi >/dev/null 2>&1 || sudo -n useradd -r -m -d ${VSTATE} -s /sbin/nologin octi
g=$(id -gn octi)
sudo -n install -d -m 700 -o octi -g "$g" ${VSTATE}
sudo -n install -d -m 755 ${VHOME}
sudo -n install -m 600 -o octi -g "$g" /tmp/octi-orchestrator.env.new ${VENV}; sudo -n rm -f /tmp/octi-orchestrator.env.new
sudo -n install -m 755 -o root -g root /tmp/octi-supervisor.sh ${VHOME}/supervisor.sh; sudo -n rm -f /tmp/octi-supervisor.sh
sudo -n install -d -m 755 /etc/octillion
printf '%s' ${q(marker)} | sudo -n tee /etc/octillion/host-role >/dev/null
sudo -n chown root:root /etc/octillion/host-role; sudo -n chmod 644 /etc/octillion/host-role`, 60);
    if (r.code !== 0) throw new Error(`configure failed: ${r.stderr.slice(-500)}`);
  }

  async function lockEgress(session: string, url: string) {
    const host = new URL(url).hostname.toLowerCase();
    await c.networkPolicy(session, [...new Set([host, "registry.npmjs.org", ...VERCEL_ORCH.egressHosts()])]);
  }

  const parseLast = (s: string) => { try { return JSON.parse(s.trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? ""); } catch { return null; } };

  async function preflight(session: string, node: string): Promise<{ ok: boolean; reason: string; guard: { ok: boolean; problems: string[] } }> {
    const g = await run(session, asService(pathOf(node), "node_modules/.bin/tsx deploy/in-sandbox.ts guard"), 60);
    const gj = parseLast(g.stdout);
    const guard = { ok: !!gj?.ok, problems: Array.isArray(gj?.problems) ? gj.problems.map(String) : [(g.stderr || g.stdout).slice(-300)] };
    const p = await run(session, asService(pathOf(node), "node_modules/.bin/tsx deploy/in-sandbox.ts preflight"), 60);
    const pj = parseLast(p.stdout);
    return { ok: !!pj?.ok, reason: pj ? String(pj.reason ?? "") : (p.stderr || p.stdout).slice(-300), guard };
  }

  async function start(session: string, node: string): Promise<string> {
    // Detached and never waited on: the supervisor lives as long as the sandbox (the Vercel analogue of a service).
    await c.run(session, `exec sudo -n -u octi env -i PATH=${q(pathOf(node))} HOME=${VSTATE} bash ${VHOME}/supervisor.sh </dev/null >/dev/null 2>&1`);
    const r = await run(session, `for i in 1 2 3 4 5 6; do sleep 1; p=$(sudo -n cat ${VPID} 2>/dev/null); if [ -n "$p" ] && sudo -n kill -0 "$p" 2>/dev/null; then echo active; exit 0; fi; done; echo failed`, 30);
    return r.stdout.trim().split("\n").pop() ?? "";
  }

  const launchErr = (e: unknown, step: string, t0: number): lib.LaunchError => {
    const err = e instanceof Error ? e : new Error(String(e));
    const raw = err.message;
    return Object.assign(err, { message: `${step} (${Math.round((Date.now() - t0) / 1000)}s): ${raw}`, launchStep: step, launchError: raw });
  };

  const host: OrchestratorHost = {
    provider: "vercel", label: "Vercel Sandbox", orchPrefix,
    orchIdOf: (id) => `orch-${id.startsWith(orchPrefix) ? id.slice(orchPrefix.length) : id}`,
    isImageBuilder: (name) => !!name?.startsWith(imagePrefix),
    async list() {
      const all = [...await c.list(orchPrefix), ...await c.list(imagePrefix)];
      return all.map((s) => ({ id: s.name, name: s.name, state: s.status, live: isLiveStatus(s.status), createdAt: s.createdAt ? new Date(s.createdAt).toISOString() : undefined }));
    },
    async get(id) {
      try {
        const g = await c.get(id);
        const st = g.sessionStatus || g.status;
        return { id, name: id, state: st, live: isLiveStatus(g.status) && isLiveStatus(st) };
      } catch (e) {
        if ([404, 410].includes(Number((e as { status?: number }).status))) return null;
        throw e;
      }
    },
    async delete(id) { sessions.delete(id); await c.remove(id); },
    async limits(): Promise<HostLimits> {
      const perHour = VERCEL_ORCH.startsPerHour();
      return { activeSandboxes: VERCEL_ORCH.maxConcurrent(), startsPerMinute: perHour, startsPerHour: perHour, startsPerDay: perHour * 24, activeNow: 0, static: true };
    },
    async launch(ctx: lib.LaunchContext, opts: HostLaunchOpts = {}): Promise<HostLaunchResult> {
      const t0 = Date.now();
      const timings: Record<string, number> = {};
      const mark = (k: string) => { timings[k] = Date.now() - t0; };
      let step = "create";
      const suffix = `v${randomBytes(5).toString("hex")}`;
      const name = `${orchPrefix}${suffix}`, orchId = `orch-${suffix}`;
      const size = VERCEL_SIZES[VERCEL_ORCH.size()]!;
      const timeoutMs = (opts.ttlSeconds ? Math.min(opts.ttlSeconds / 60, VERCEL_ORCH.timeoutMinutes()) : VERCEL_ORCH.timeoutMinutes()) * 60_000;
      let created: { name: string; session: string | null };
      try {
        created = await c.create({ name, vcpus: size.vcpus, memoryMb: size.memoryMb, timeoutMs, snapshotId: opts.image ?? null,
          tags: { octillion: "orchestrator", orchestrator: orchId } });
      } catch (e) { throw launchErr(e, step, t0); }
      const expiresAt = t0 + timeoutMs;
      if (created.session) sessions.set(name, created.session);
      mark("created");
      try {
        step = "name"; // Vercel names at create; this step only records the sandbox
        await opts.onCreated?.(name, orchId, { expiresAt: new Date(expiresAt) });
        step = "ready";
        const session = await waitRunning(name);
        const node = await nodeDir(session);
        mark("ready");
        let fromImage = false;
        if (opts.image) fromImage = (await run(session, `test -x ${VHOME}/app/orchestrator/node_modules/.bin/tsx && echo yes || echo no`, 30)).stdout.includes("yes");
        step = "code upload";
        if (!fromImage) { await uploadCode(session, node, ctx.root); mark("code"); }
        step = "configure";
        await configure(session, name, orchId, ctx);
        if (VERCEL_ORCH.egress() === "locked") await lockEgress(session, ctx.url);
        mark("configured");
        step = "preflight";
        const pf = await preflight(session, node);
        mark("preflight");
        // The guard must pass here, or the orchestrator would refuse to start and crash-loop: fail the launch instead.
        if (!pf.guard.ok && !ctx.placeholderToken) throw new Error(`host guard refused this sandbox: ${pf.guard.problems.join("; ")}`);
        if (!pf.ok && opts.requirePreflight !== false) throw new Error(`preflight failed: ${pf.reason}`);
        step = "start";
        const svc = await start(session, node);
        mark("started");
        if (svc !== "active") throw new Error(`supervisor is ${svc || "not running"}`);
        return { sandboxId: name, orchId, fromImage, timings, preflight: { ok: pf.ok, reason: pf.reason }, expiresAt };
      } catch (e) {
        await host.delete(name).catch(() => {});
        throw launchErr(e, step, t0);
      }
    },
    async stop(id) {
      const session = await sessionOf(id);
      const r = await run(session, `p=$(sudo -n cat ${VPID} 2>/dev/null); [ -n "$p" ] || { echo stopped; exit 0; }
sudo -n kill -TERM "$p"; for i in $(seq 1 200); do sudo -n kill -0 "$p" 2>/dev/null || { echo stopped; exit 0; }; sleep 1; done; echo still-running`, 230)
        .catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
      return r.stdout.trim() || "stopped";
    },
    async logs(id, lines) {
      const r = await run(await sessionOf(id), `sudo -n tail -n ${Math.max(1, Math.min(5000, Math.trunc(lines)))} ${VLOG}`, 60);
      return r.stdout || r.stderr;
    },
    sandboxType: `vercel-${VERCEL_ORCH.size()}`,
    estCostUsd: (seconds) => vercelOrchCostUsd(seconds),
    image: {
      async ready(hash) {
        const snaps = await c.listSnapshots(`${imagePrefix}${hash}`.slice(0, 63)).catch(() => []);
        return snaps.find((s) => s.status === "created")?.id ?? null;
      },
      /** A builder sandbox named for the code hash gets the code + `npm ci` (no env file, no marker, no token), then is snapshotted. */
      async build(ctx) {
        const t0 = Date.now();
        const name = `${imagePrefix}${lib.codeHash(ctx.root)}`.slice(0, 63);
        const size = VERCEL_SIZES[VERCEL_ORCH.size()]!;
        await c.remove(name).catch(() => {});
        const cr = await c.create({ name, vcpus: size.vcpus, memoryMb: size.memoryMb, timeoutMs: 30 * 60_000, tags: { octillion: "orchestrator-image" } });
        try {
          const session = cr.session ?? await waitRunning(name);
          await waitRunning(name);
          await uploadCode(session, await nodeDir(session), ctx.root);
          const s = await c.snapshot(session, VERCEL_ORCH.snapshotDays() * 86_400_000); // Vercel stops the builder after this
          if (s.status === "failed") throw new Error(`snapshot ${s.id} failed`);
        } finally {
          await c.remove(name).catch(() => {});
        }
        ctx.log?.(`orchestrator image ${name} ready in ${Math.round((Date.now() - t0) / 1000)}s`);
        return { name, ms: Date.now() - t0 };
      },
    },
  };
  return host;
}
