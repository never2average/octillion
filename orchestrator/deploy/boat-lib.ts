/**
 * Orchestrator-sandbox library, shared by the CLI launcher (deploy/boat-orchestrators.ts) and the server's autoscaler
 * (src/autoscaler.ts). API calls only: nothing here runs agent code on the calling machine.
 *
 * Callers set the boat key first (`BOAT.apiKey = …`, from the broker or the vault) and pass an explicit
 * LaunchContext (public server URL, worker token, pod capacity, tuning). The worker token only ever goes into the
 * orchestrator sandbox's 0600 env file.
 *
 * Cold start (measured live 2026-10-10): code upload as a tarball through the files API + `npm ci` there -> service
 * active ~8s after the create call. Optional named snapshot image "octi-orch-img-<code hash>" (code + node_modules):
 * ~22s (lazy disk hydration) and a ~170s build per code change, so it is opt-in (OCTILLION_ORCH_SNAPSHOT=on).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BOAT } from "../core/config.js";
import { boatApi, boatCreate, boatExec, BoatError } from "../core/boat.js";
import { sleep } from "../core/util.js";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ORCH_PREFIX = "octi-orch-";
export const WORKER_PREFIX = "octi-w-";
export const IMAGE_PREFIX = "octi-orch-img-";
export const IMAGE_BUILDER_NAME = "octi-img-build";
export const MAX_TTL_SECONDS = 2_592_000; // 30 days: boat's maximum numeric TTL (docs.boat.dev/long-running-tasks)
export const HOME = "/home/user/octillion";
export const UNIT = "octillion-orchestrator";
const CHUNK = 3_500_000; // raw bytes per files-API PUT (limit: 5 MiB after base64 decoding)

/** Non-secret tuning knobs that may go into an orchestrator's env file (nothing else is ever written). */
export const TUNING_VARS = ["MAX_SESSION_MINUTES", "MAX_BUDGET_USD", "MAX_USER_TURNS", "ORCHESTRATOR_THINKING", "BOAT_SANDBOX_SIZE",
  "RESEARCH_MAX_COST_USD", "OCTILLION_ORCH_IDLE_MINUTES", "MAX_AGENT_TURNS", "GIVE_UP_RUNS", "ORCHESTRATOR_JOB", "OCTILLION_ZED_ACP"] as const;

export interface LaunchContext {
  url: string;               // public HTTPS server URL
  workerToken: string;       // goes ONLY into the orchestrator sandbox's 0600 env file
  podCapacity: number;
  tuning?: Record<string, string>;
  root?: string;             // repo root holding orchestrator/ + harnesses/registry.json
  log?: (msg: string) => void;
  placeholderToken?: boolean; // selftest: never ship the real token
}

// ---------------------------------------------------------------- budget (pure; unit-tested)

export interface BoatLimits { activeSandboxes: number; startsPerMinute: number; startsPerHour: number; startsPerDay: number; activeNow: number }
export interface Budget {
  plan: number; perOrchestrator: number; maxOrchestrators: number; requested: number; requestedSandboxes: number;
  otherActive: number; available: number; ok: boolean; startsPerDay: number; sessionsPerDayCeiling: number; reason?: string;
}

/** Each orchestrator = 1 sandbox + up to podCapacity worker sandboxes, all counted against plan concurrency. */
export function computeBudget(limits: BoatLimits, n: number, podCapacity: number, oursActive = 0): Budget {
  const perOrchestrator = 1 + podCapacity;
  const otherActive = Math.max(0, limits.activeNow - oursActive);
  const available = limits.activeSandboxes - otherActive;
  const requestedSandboxes = n * perOrchestrator;
  const maxOrchestrators = Math.max(0, Math.floor(available / perOrchestrator));
  const ok = n >= 0 && requestedSandboxes <= available;
  return {
    plan: limits.activeSandboxes, perOrchestrator, maxOrchestrators, requested: n, requestedSandboxes, otherActive, available, ok,
    startsPerDay: limits.startsPerDay, sessionsPerDayCeiling: Math.max(0, limits.startsPerDay - n),
    reason: ok ? undefined : `${n} orchestrators x (1 + ${podCapacity}) = ${requestedSandboxes} sandboxes > ${available} available (plan ${limits.activeSandboxes} - ${otherActive} other active); max ${maxOrchestrators}`,
  };
}

export async function boatLimits(): Promise<BoatLimits> {
  const l = await boatApi("/limits");
  return {
    activeSandboxes: Number(l?.currentLimits?.activeSandboxes ?? l?.maxActiveSandboxes ?? 100),
    startsPerMinute: Number(l?.startLimits?.perMinute ?? 12), startsPerHour: Number(l?.startLimits?.perHour ?? 60),
    startsPerDay: Number(l?.startLimits?.perDay ?? 200), activeNow: Number(l?.activeSandboxes ?? 0),
  };
}

// ---------------------------------------------------------------- boat helpers

export interface Sb { id: string; name?: string; state: string; createdAt?: string; archiveAfter?: string | null; type?: string }

export async function listSandboxes(): Promise<Sb[]> {
  const all: Sb[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const r = await boatApi(`/sandboxes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
    all.push(...(r?.sandboxes ?? []));
    cursor = r?.pageInfo?.nextCursor ?? null;
    if (!cursor) break;
  }
  return all;
}

export const isLive = (s: Sb) => !["archived", "archiving", "cancelled", "error", "deleted"].includes(s.state);
export const orchIdOf = (sandboxId: string) => `orch-${sandboxId.replace(/^bx_/, "")}`;
export const workerPrefixOf = (orchId: string) => `${WORKER_PREFIX}${orchId}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-");

export async function waitReady(id: string, timeoutMs = 300_000) {
  for (const t0 = Date.now(); Date.now() - t0 < timeoutMs; await sleep(2000)) {
    const st = (await boatApi(`/sandboxes/${id}`)).sandbox.state;
    if (["ready", "idle", "running"].includes(st)) return;
    if (["error", "cancelled"].includes(st)) throw new Error(`sandbox ${id} is ${st}`);
  }
  throw new Error(`sandbox ${id} not ready after ${timeoutMs / 1000}s`);
}

export async function put(id: string, p: string, content: string, encoding: "utf8" | "base64" = "utf8") {
  await boatApi(`/sandboxes/${id}/files`, { method: "PUT", json: { path: p, content, encoding } });
}

export async function run(id: string, cmd: string, timeout = 300): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const r = await boatExec(id, cmd, timeout);
  return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

export async function deleteSandbox(id: string) {
  await boatApi(`/sandboxes/${id}`, { method: "DELETE", headers: { "X-Ascii-Confirm-Delete": id } }).catch((e) => {
    if (!(e instanceof BoatError && e.status === 404)) throw e;
  });
}

// ---------------------------------------------------------------- code: files, hash, tarball

const CODE_EXCLUDE = /(^|\/)(node_modules|\.pi-upstream|pi-upstream|test)(\/|$)|^orchestrator\/harnesses\/fixtures(\/|$)/;

/** The files an orchestrator needs: orchestrator/ (no node_modules, Pi clone, tests, fixtures) + the registry. */
export function codeFiles(root = REPO_ROOT): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (CODE_EXCLUDE.test(r)) continue;
      if (e.isDirectory()) walk(r); else if (e.isFile()) out.push(r);
    }
  };
  walk("orchestrator");
  if (statSync(path.join(root, "harnesses/registry.json"), { throwIfNoEntry: false })) out.push("harnesses/registry.json");
  return out.sort();
}

/** Content hash of the orchestrator code: keys the named snapshot image. */
export function codeHash(root = REPO_ROOT): string {
  const h = createHash("sha256");
  for (const f of codeFiles(root)) { h.update(f + "\0"); h.update(readFileSync(path.join(root, f))); h.update("\0"); }
  return h.digest("hex").slice(0, 16);
}

export function tarball(root = REPO_ROOT): Buffer {
  const r = spawnSync("tar", ["-czf", "-", ...codeFiles(root)], { cwd: root, maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`);
  return r.stdout;
}

export async function uploadCode(id: string, root = REPO_ROOT): Promise<number> {
  const tgz = tarball(root);
  await run(id, `install -d -m 700 ${HOME} && rm -rf ${HOME}/code.tgz.part*`, 30);
  const parts = Math.ceil(tgz.length / CHUNK);
  for (let i = 0; i < parts; i++) await put(id, `${HOME}/code.tgz.part${String(i).padStart(3, "0")}`, tgz.subarray(i * CHUNK, (i + 1) * CHUNK).toString("base64"), "base64");
  const r = await run(id, `set -e; cd ${HOME}; cat code.tgz.part* > code.tgz; rm -f code.tgz.part*; rm -rf app.new; mkdir app.new; tar -xzf code.tgz -C app.new; rm code.tgz
cd app.new/orchestrator && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>npm.err || { tail -20 npm.err >&2; exit 1; }
cd ${HOME}; rm -rf app.old; [ -d app ] && mv app app.old; mv app.new app; rm -rf app.old`, 600);
  if (r.code !== 0) throw new Error(`code deploy failed: ${r.stderr.slice(-800)}`);
  return tgz.length;
}

// ---------------------------------------------------------------- configure / preflight / service

/** Env file (0600), host marker (root-owned) and systemd unit (Restart=on-failure: an idle exit 0 stays down). */
export async function configure(id: string, orchId: string, ctx: LaunchContext) {
  const tuning = Object.entries(ctx.tuning ?? {}).filter(([k, v]) => (TUNING_VARS as readonly string[]).includes(k) && /^[A-Za-z0-9._-]{1,32}$/.test(v)).map(([k, v]) => `${k}=${v}`);
  const envBody = [
    `OCTILLION_URL=${ctx.url}`, `OCTILLION_WORKER_TOKEN=${ctx.placeholderToken ? "selftest-placeholder-not-a-token" : ctx.workerToken}`, `ORCHESTRATOR_ID=${orchId}`,
    "RUNNER=boat", `POD_CAPACITY=${ctx.podCapacity}`, "OCTILLION_HOST_ROLE=boat-orchestrator", ...tuning, "",
  ].join("\n");
  await run(id, `install -d -m 700 ${HOME}`, 30);
  await put(id, `${HOME}/orchestrator.env.new`, envBody);
  const unit = `[Unit]
Description=Octillion orchestrator (${orchId})
After=network-online.target
[Service]
User=user
WorkingDirectory=${HOME}/app
EnvironmentFile=${HOME}/orchestrator.env
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=${HOME}/app/orchestrator/node_modules/.bin/tsx orchestrator/pi-octillion/main.ts
Restart=on-failure
RestartSec=10
KillSignal=SIGTERM
KillMode=mixed
TimeoutStopSec=240
StandardOutput=journal
StandardError=journal
[Install]
WantedBy=multi-user.target
`;
  await put(id, `${HOME}/${UNIT}.service`, unit);
  const r = await run(id, `set -e; cd ${HOME}
{ cat orchestrator.env.new; env | grep -E '^(BOAT_ID|BOX_ID)=' || true; } > orchestrator.env; rm -f orchestrator.env.new; chmod 600 orchestrator.env
sudo install -d -m 755 /etc/octillion
printf '%s' '{"role":"boat-orchestrator","sandbox_id":"${id}","orchestrator_id":"${orchId}"}' | sudo tee /etc/octillion/host-role >/dev/null
sudo chmod 644 /etc/octillion/host-role
sudo install -m 644 ${UNIT}.service /etc/systemd/system/${UNIT}.service && rm -f ${UNIT}.service
sudo systemctl daemon-reload`, 120);
  if (r.code !== 0) throw new Error(`configure failed: ${r.stderr.slice(-500)}`);
}

/** From inside the sandbox, with the orchestrator's own env: is OCTILLION_URL reachable over public HTTPS? */
export async function preflight(id: string): Promise<{ ok: boolean; reason: string }> {
  const r = await run(id, `cd ${HOME}/app/orchestrator && set -a && . ${HOME}/orchestrator.env && set +a && node_modules/.bin/tsx deploy/in-sandbox.ts preflight`, 60);
  try { const j = JSON.parse(r.stdout.trim().split("\n").pop()!); return { ok: !!j.ok, reason: j.reason }; }
  catch { return { ok: false, reason: (r.stderr || r.stdout).slice(-300) }; }
}

export async function guard(id: string): Promise<any> {
  const r = await run(id, `cd ${HOME}/app/orchestrator && set -a && . ${HOME}/orchestrator.env && set +a && node_modules/.bin/tsx deploy/in-sandbox.ts guard; RUNNER=local node_modules/.bin/tsx deploy/in-sandbox.ts guard | sed 's/^/LOCAL /'`, 60);
  const lines = r.stdout.trim().split("\n");
  const parse = (l?: string) => { try { return JSON.parse(l ?? ""); } catch { return { raw: l }; } };
  return { boat: parse(lines.find((l) => l.startsWith("{"))), runner_local: parse(lines.find((l) => l.startsWith("LOCAL "))?.slice(6)) };
}

export async function startService(id: string): Promise<string> {
  const r = await run(id, `sudo systemctl enable --now ${UNIT} && sleep 2 && systemctl is-active ${UNIT}`, 60);
  return (r.stdout.trim() || r.stderr.trim()).split("\n").pop() ?? "";
}

/** Graceful stop: SIGTERM -> the orchestrator kills its sessions (deleting their workers) and leaves the fleet. */
export async function stopService(id: string): Promise<string> {
  const r = await run(id, `sudo systemctl stop ${UNIT}; systemctl is-active ${UNIT} || true`, 300).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
  return r.stdout.trim() || "stopped";
}

// ---------------------------------------------------------------- image snapshot (cold start)

export const imageName = (hash: string) => `${IMAGE_PREFIX}${hash}`.slice(0, 63);

export async function imageStatus(name: string): Promise<"ready" | "saving" | "failed" | "missing"> {
  try { return (await boatApi(`/named-snapshots/${encodeURIComponent(name)}`))?.snapshot?.status ?? "missing"; }
  catch (e) { if (e instanceof BoatError && e.status === 404) return "missing"; throw e; }
}

/**
 * Build the orchestrator image for the current code: a builder sandbox gets the code + `npm ci` (no env file, no
 * marker, no token), is saved as the named snapshot, then deleted. Older octi-orch-img-* snapshots are removed.
 */
export async function buildImage(ctx: Pick<LaunchContext, "root" | "log">): Promise<{ name: string; ms: number }> {
  const t0 = Date.now();
  const name = imageName(codeHash(ctx.root));
  const c = await boatCreate({ type: "small", ttlSeconds: 1800, noEnv: true });
  const id: string = c.sandbox.id;
  try {
    await boatApi(`/sandboxes/${id}`, { method: "PATCH", json: { name: IMAGE_BUILDER_NAME } }).catch(() => {});
    await waitReady(id);
    await uploadCode(id, ctx.root);
    await boatApi("/named-snapshots", { method: "POST", json: { sandboxId: id, name } });
    for (let i = 0; i < 180; i++) {
      const st = await imageStatus(name);
      if (st === "ready") break;
      if (st === "failed") throw new Error(`named snapshot ${name} failed`);
      await sleep(5000);
    }
    if ((await imageStatus(name)) !== "ready") throw new Error(`named snapshot ${name} not ready after 15 min`);
  } finally {
    await deleteSandbox(id).catch(() => {});
  }
  // Keep only the current image (each named snapshot above the free 10 costs money).
  const all = (await boatApi("/named-snapshots").catch(() => null))?.snapshots ?? [];
  for (const s of all) if (typeof s?.name === "string" && s.name.startsWith(IMAGE_PREFIX) && s.name !== name)
    await boatApi(`/named-snapshots/${encodeURIComponent(s.name)}`, { method: "DELETE" }).catch(() => {});
  ctx.log?.(`orchestrator image ${name} ready in ${Math.round((Date.now() - t0) / 1000)}s`);
  return { name, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------- launch

export interface LaunchResult { sandboxId: string; orchId: string; fromImage: boolean; timings: Record<string, number>; preflight: { ok: boolean; reason: string } }

/**
 * Create one orchestrator sandbox and start it. `onCreated` fires right after the create (so callers can record the
 * sandbox id before anything else can fail). Throws after deleting the sandbox if anything fails.
 */
export async function launchOrchestrator(ctx: LaunchContext, opts: { image?: string | null; ttlSeconds?: number; onCreated?: (sandboxId: string, orchId: string) => Promise<void> | void; requirePreflight?: boolean } = {}): Promise<LaunchResult> {
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const mark = (k: string) => { timings[k] = Date.now() - t0; };
  const c = await boatCreate({ type: "small", ttlSeconds: opts.ttlSeconds ?? MAX_TTL_SECONDS, noEnv: true, snapshots: false, ...(opts.image ? { from: opts.image } : {}) });
  const id: string = c.sandbox.id;
  const orchId = orchIdOf(id);
  mark("created");
  try {
    await opts.onCreated?.(id, orchId);
    await boatApi(`/sandboxes/${id}`, { method: "PATCH", json: { name: `${ORCH_PREFIX}${id.replace(/^bx_/, "")}` } });
    await waitReady(id);
    mark("ready");
    let fromImage = false;
    if (opts.image) fromImage = (await run(id, `test -x ${HOME}/app/orchestrator/node_modules/.bin/tsx && echo yes || echo no`, 30)).stdout.includes("yes");
    if (!fromImage) { await uploadCode(id, ctx.root); mark("code"); }
    await configure(id, orchId, ctx);
    mark("configured");
    const pf = await preflight(id);
    mark("preflight");
    if (!pf.ok && opts.requirePreflight !== false) throw new Error(`preflight failed: ${pf.reason}`);
    const svc = await startService(id);
    mark("started");
    // "activating" = (re)starting; a crash loop never checks in and the autoscaler's stale reaper deletes it.
    if (svc !== "active" && svc !== "activating") throw new Error(`service is ${svc}`);
    return { sandboxId: id, orchId, fromImage, timings, preflight: pf };
  } catch (e) {
    await deleteSandbox(id).catch(() => {});
    throw e;
  }
}

/** BOAT.apiKey must be set by the caller; this just documents the dependency. */
export const requireBoatKey = () => { if (!BOAT.apiKey) throw new Error("boat key not set"); };
