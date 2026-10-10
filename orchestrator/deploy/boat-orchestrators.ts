/**
 * Launcher for Octillion orchestrators. Orchestrators run ONLY inside boat.dev sandboxes ("orchestrator sandboxes")
 * and create their worker sandboxes from there (sandbox from sandbox). Run this from the main VM or a laptop; it
 * needs only OCTILLION_URL + OCTILLION_WORKER_TOKEN and gets the boat key from the credential broker.
 *
 *   npm run boat-orchestrators -- budget [n]                 plan limits vs n orchestrators x (1 + POD_CAPACITY)
 *   npm run boat-orchestrators -- up <n> [--skip-preflight]  ensure n orchestrator sandboxes exist and run
 *   npm run boat-orchestrators -- status                     sandboxes, uptime, TTL left, fleet check-in, workers
 *   npm run boat-orchestrators -- logs <sandbox-id> [lines]  orchestrator journal (secrets redacted)
 *   npm run boat-orchestrators -- renew                      reset every orchestrator's TTL to the maximum
 *   npm run boat-orchestrators -- update                     redeploy code to every orchestrator, restart gracefully
 *   npm run boat-orchestrators -- down <sandbox-id>|--all    graceful stop (leaves the fleet, deletes its workers), delete
 *   npm run boat-orchestrators -- selftest                   live check: boot one orchestrator sandbox, guard, preflight,
 *                                                            nested worker create/delete, tear down, verify nothing left
 *
 * Each orchestrator sandbox: size `small`, TTL 30 days (boat's max numeric TTL; `renew` resets it), noEnv, code
 * uploaded as a tarball through the files API (no node_modules), `npm ci` there, a 0600 env file with ONLY
 * OCTILLION_URL / OCTILLION_WORKER_TOKEN / ORCHESTRATOR_ID / RUNNER=boat / POD_CAPACITY / OCTILLION_HOST_ROLE
 * (+ boat's own BOAT_ID, captured inside the VM), a root-owned host marker, and a systemd unit (Restart=always,
 * SIGTERM on stop). The worker token never leaves orchestrator sandboxes: worker sandboxes get only per-session
 * gateway tokens.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BOAT, CFG } from "../core/config.js";
import { boatApi, boatCreate, boatExec, BoatError } from "../core/boat.js";
import { api, sleep } from "../core/util.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ORCH_PREFIX = "octi-orch-";
export const WORKER_PREFIX = "octi-w-";
export const MAX_TTL_SECONDS = 2_592_000; // 30 days: boat's maximum numeric TTL (docs.boat.dev/long-running-tasks)
const POD_CAPACITY = Math.max(1, Math.min(20, Number(process.env.POD_CAPACITY ?? 20)));
const HOME = "/home/user/octillion";
const UNIT = "octillion-orchestrator";
const CHUNK = 3_500_000; // raw bytes per files-API PUT (limit: 5 MiB after base64 decoding)

const secrets = () => [CFG.token, BOAT.apiKey].filter((s) => s && s.length > 6);
const redact = (s: string) => secrets().reduce((a, k) => a.split(k).join("***"), s).replace(/\b(ogw_|boat_|oct_)[A-Za-z0-9-]{16,}/g, "$1***");
const out = (...a: unknown[]) => console.log(redact(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x, null, 1))).join(" ")));

// ---------------------------------------------------------------- budget (pure; unit-tested)

export interface BoatLimits { activeSandboxes: number; startsPerMinute: number; startsPerHour: number; startsPerDay: number; activeNow: number }
export interface Budget {
  plan: number; perOrchestrator: number; maxOrchestrators: number; requested: number; requestedSandboxes: number;
  otherActive: number; available: number; ok: boolean; startsPerDay: number; sessionsPerDayCeiling: number; reason?: string;
}

/**
 * Every orchestrator holds 1 sandbox for itself + up to POD_CAPACITY concurrent worker sandboxes, all counted against
 * the plan's concurrent-sandbox limit. Sandboxes that are not ours (otherActive) reduce what is available.
 */
export function computeBudget(limits: BoatLimits, n: number, podCapacity: number, oursActive = 0): Budget {
  const perOrchestrator = 1 + podCapacity;
  const otherActive = Math.max(0, limits.activeNow - oursActive);
  const available = limits.activeSandboxes - otherActive;
  const requestedSandboxes = n * perOrchestrator;
  const maxOrchestrators = Math.max(0, Math.floor(available / perOrchestrator));
  const ok = n >= 0 && requestedSandboxes <= available;
  return {
    plan: limits.activeSandboxes, perOrchestrator, maxOrchestrators, requested: n, requestedSandboxes, otherActive, available, ok,
    startsPerDay: limits.startsPerDay,
    // Every session is one fresh worker sandbox = one boat "start"; orchestrators restart rarely.
    sessionsPerDayCeiling: Math.max(0, limits.startsPerDay - n),
    reason: ok ? undefined : `${n} orchestrators x (1 + ${podCapacity}) = ${requestedSandboxes} sandboxes > ${available} available (plan ${limits.activeSandboxes} - ${otherActive} other active); max ${maxOrchestrators}`,
  };
}

async function boatLimits(): Promise<BoatLimits> {
  const l = await boatApi("/limits");
  return {
    activeSandboxes: Number(l?.currentLimits?.activeSandboxes ?? l?.maxActiveSandboxes ?? 100),
    startsPerMinute: Number(l?.startLimits?.perMinute ?? 12), startsPerHour: Number(l?.startLimits?.perHour ?? 60),
    startsPerDay: Number(l?.startLimits?.perDay ?? 200), activeNow: Number(l?.activeSandboxes ?? 0),
  };
}

function printBudget(b: Budget, l: BoatLimits) {
  out(`boat plan: ${b.plan} concurrent sandboxes, starts ${l.startsPerMinute}/min ${l.startsPerHour}/h ${l.startsPerDay}/day; active now ${l.activeNow} (${b.otherActive} not ours)`);
  out(`per orchestrator: 1 orchestrator sandbox + ${b.perOrchestrator - 1} worker sandboxes = ${b.perOrchestrator}; max orchestrators: ${b.maxOrchestrators}`);
  out(`requested ${b.requested} -> ${b.requestedSandboxes} sandboxes of ${b.available} available: ${b.ok ? "OK" : "REFUSED"}`);
  out(`throughput ceiling: ~${b.sessionsPerDayCeiling} agent sessions/day (each session = 1 fresh worker sandbox = 1 boat start; plan ${b.startsPerDay} starts/day)`);
}

// ---------------------------------------------------------------- boat helpers

async function boatKey(): Promise<void> {
  if (!CFG.token) throw new Error("OCTILLION_WORKER_TOKEN is required");
  const r = (await api("/api/worker/orchestrator/credentials", { json: { orchestrator_id: "launcher" } })) as { boat?: { api_key?: string } | null };
  if (!r?.boat?.api_key) throw new Error("the credential broker returned no boat key (store one: npm run keyvault -- set boat)");
  BOAT.apiKey = r.boat.api_key;
}

interface Sb { id: string; name?: string; state: string; createdAt?: string; archiveAfter?: string | null; type?: string }

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

const live = (s: Sb) => !["archived", "cancelled", "error", "deleted"].includes(s.state);
const orchestrators = async () => (await listSandboxes()).filter((s) => s.name?.startsWith(ORCH_PREFIX) && live(s));
const workersOf = (all: Sb[], orchId: string) => all.filter((s) => s.name?.startsWith(`${WORKER_PREFIX}${orchId}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-")) && live(s));

async function waitReady(id: string) {
  for (let i = 0; i < 150; i++) {
    const st = (await boatApi(`/sandboxes/${id}`)).sandbox.state;
    if (["ready", "idle", "running"].includes(st)) return;
    if (["error", "cancelled"].includes(st)) throw new Error(`sandbox ${id} is ${st}`);
    await sleep(2000);
  }
  throw new Error(`sandbox ${id} not ready after 5 minutes`);
}

async function put(id: string, p: string, content: string, encoding: "utf8" | "base64" = "utf8") {
  await boatApi(`/sandboxes/${id}/files`, { method: "PUT", json: { path: p, content, encoding } });
}

async function run(id: string, cmd: string, timeout = 300): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const r = await boatExec(id, cmd, timeout);
  return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

async function deleteSandbox(id: string) {
  await boatApi(`/sandboxes/${id}`, { method: "DELETE", headers: { "X-Ascii-Confirm-Delete": id } }).catch((e) => {
    if (!(e instanceof BoatError && e.status === 404)) throw e;
  });
}

/** Code tarball: orchestrator/ (no node_modules, Pi clone, fixtures) + harnesses/registry.json. */
function tarball(): Buffer {
  const r = spawnSync("tar", ["-czf", "-", "--exclude=orchestrator/node_modules", "--exclude=orchestrator/.pi-upstream", "--exclude=orchestrator/pi-upstream",
    "--exclude=orchestrator/harnesses/fixtures", "--exclude=orchestrator/test", "orchestrator", "harnesses/registry.json"], { cwd: ROOT, maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`);
  return r.stdout;
}

async function uploadCode(id: string) {
  const tgz = tarball();
  await run(id, `install -d -m 700 ${HOME} && rm -rf ${HOME}/code.tgz.part*`, 30);
  const parts = Math.ceil(tgz.length / CHUNK);
  for (let i = 0; i < parts; i++) await put(id, `${HOME}/code.tgz.part${String(i).padStart(3, "0")}`, tgz.subarray(i * CHUNK, (i + 1) * CHUNK).toString("base64"), "base64");
  const r = await run(id, `set -e; cd ${HOME}; cat code.tgz.part* > code.tgz; rm -f code.tgz.part*; rm -rf app.new; mkdir app.new; tar -xzf code.tgz -C app.new; rm code.tgz
cd app.new/orchestrator && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>npm.err || { tail -20 npm.err >&2; exit 1; }
cd ${HOME}; rm -rf app.old; [ -d app ] && mv app app.old; mv app.new app; rm -rf app.old`, 600);
  if (r.code !== 0) throw new Error(`code deploy failed: ${r.stderr.slice(-800)}`);
  return tgz.length;
}

/** Env file (0600), host marker (root-owned) and systemd unit; nothing else is written. */
/** Non-secret tuning knobs the launcher may forward from its own env (nothing else is ever written). */
export const TUNING_VARS = ["MAX_SESSION_MINUTES", "MAX_BUDGET_USD", "MAX_USER_TURNS", "ORCHESTRATOR_THINKING", "BOAT_SANDBOX_SIZE", "RESEARCH_MAX_COST_USD"] as const;

async function configure(id: string, orchId: string, opts: { placeholderToken?: boolean } = {}) {
  const tuning = TUNING_VARS.filter((k) => process.env[k] && /^[A-Za-z0-9._-]{1,32}$/.test(process.env[k]!)).map((k) => `${k}=${process.env[k]}`);
  const envBody = [
    `OCTILLION_URL=${CFG.url}`, `OCTILLION_WORKER_TOKEN=${opts.placeholderToken ? "selftest-placeholder-not-a-token" : CFG.token}`, `ORCHESTRATOR_ID=${orchId}`,
    "RUNNER=boat", `POD_CAPACITY=${POD_CAPACITY}`, "OCTILLION_HOST_ROLE=boat-orchestrator", ...tuning, "",
  ].join("\n");
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
Restart=always
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
  // BOAT_ID / BOX_ID come from boat itself (the exec environment), not from the launcher.
  const r = await run(id, `set -e; cd ${HOME}
{ cat orchestrator.env.new; env | grep -E '^(BOAT_ID|BOX_ID)=' || true; } > orchestrator.env; rm -f orchestrator.env.new; chmod 600 orchestrator.env
sudo install -d -m 755 /etc/octillion
printf '%s' '{"role":"boat-orchestrator","sandbox_id":"${id}","orchestrator_id":"${orchId}"}' | sudo tee /etc/octillion/host-role >/dev/null
sudo chmod 644 /etc/octillion/host-role
sudo install -m 644 ${UNIT}.service /etc/systemd/system/${UNIT}.service && rm -f ${UNIT}.service
sudo systemctl daemon-reload`, 120);
  if (r.code !== 0) throw new Error(`configure failed: ${r.stderr.slice(-500)}`);
}

/** Inside the sandbox, with the orchestrator's own env: is OCTILLION_URL reachable (public HTTPS)? */
async function preflight(id: string): Promise<{ ok: boolean; reason: string }> {
  const r = await run(id, `cd ${HOME}/app/orchestrator && set -a && . ${HOME}/orchestrator.env && set +a && node_modules/.bin/tsx deploy/in-sandbox.ts preflight`, 60);
  try { const j = JSON.parse(r.stdout.trim().split("\n").pop()!); return { ok: !!j.ok, reason: j.reason }; }
  catch { return { ok: false, reason: (r.stderr || r.stdout).slice(-300) }; }
}

async function guard(id: string): Promise<any> {
  const r = await run(id, `cd ${HOME}/app/orchestrator && set -a && . ${HOME}/orchestrator.env && set +a && node_modules/.bin/tsx deploy/in-sandbox.ts guard; RUNNER=local node_modules/.bin/tsx deploy/in-sandbox.ts guard | sed 's/^/LOCAL /'`, 60);
  const lines = r.stdout.trim().split("\n");
  const parse = (l?: string) => { try { return JSON.parse(l ?? ""); } catch { return { raw: l }; } };
  return { boat: parse(lines.find((l) => l.startsWith("{"))), runner_local: parse(lines.find((l) => l.startsWith("LOCAL "))?.slice(6)) };
}

async function createOrchestrator(ttl = MAX_TTL_SECONDS): Promise<{ id: string; orchId: string }> {
  const c = await boatCreate({ type: "small", ttlSeconds: ttl, noEnv: true, snapshots: false });
  const id: string = c.sandbox.id;
  const orchId = `orch-${id.replace(/^bx_/, "")}`;
  await boatApi(`/sandboxes/${id}`, { method: "PATCH", json: { name: `${ORCH_PREFIX}${id.replace(/^bx_/, "")}` } });
  await waitReady(id);
  return { id, orchId };
}

const orchIdOf = (s: Sb) => `orch-${s.id.replace(/^bx_/, "")}`;

// ---------------------------------------------------------------- commands

async function cmdUp(n: number, skipPreflight: boolean) {
  const existing = await orchestrators();
  const all = await listSandboxes();
  const ours = all.filter((s) => (s.name?.startsWith(ORCH_PREFIX) || s.name?.startsWith(WORKER_PREFIX)) && live(s)).length;
  const limits = await boatLimits();
  const b = computeBudget(limits, n, POD_CAPACITY, ours);
  printBudget(b, limits);
  if (!b.ok) throw new Error(`refusing: ${b.reason}`);
  out(`${existing.length} orchestrator sandbox(es) exist; target ${n}`);
  for (let i = existing.length; i < n; i++) {
    const { id, orchId } = await createOrchestrator();
    out(`created ${id} (${orchId}); deploying code`);
    try {
      const bytes = await uploadCode(id);
      await configure(id, orchId);
      const pf = await preflight(id);
      if (!pf.ok && !skipPreflight) throw new Error(`preflight failed: ${pf.reason}`);
      const r = await run(id, `sudo systemctl enable --now ${UNIT} && sleep 3 && systemctl is-active ${UNIT}`, 60);
      out(`${id}: code ${bytes} bytes, preflight ${pf.ok ? "OK" : `SKIPPED (${pf.reason})`}, service ${r.stdout.trim() || r.stderr.trim()}`);
    } catch (e) {
      out(`${id}: ${String(e)}; deleting it`);
      await deleteSandbox(id);
      throw e;
    }
  }
  if (existing.length > n) out(`note: ${existing.length - n} more orchestrator(s) than requested; use \`down <id>\` to remove`);
}

async function cmdStatus() {
  const all = await listSandboxes();
  const orchs = all.filter((s) => s.name?.startsWith(ORCH_PREFIX) && live(s));
  const fleet = (await api("/api/worker/fleet", { method: "GET" }).catch(() => null)) as any;
  out(`fleet: ${fleet?.orchestrators ?? "?"} orchestrator(s) checked in, ${fleet?.total_pods ?? "?"} worker slots planned, queue ${JSON.stringify(fleet?.queue ?? {})}`);
  for (const s of orchs) {
    const orchId = orchIdOf(s);
    const svc = await run(s.id, `systemctl is-active ${UNIT}; systemctl show ${UNIT} -p ActiveEnterTimestamp --value`, 30).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
    const [active, since] = svc.stdout.trim().split("\n");
    const ttlLeft = s.archiveAfter ? Math.round((Date.parse(s.archiveAfter) - Date.now()) / 3600_000) : null;
    out(`${s.id} ${orchId} state=${s.state} service=${active ?? "?"} since=${since ?? "?"} up=${s.createdAt ? Math.round((Date.now() - Date.parse(s.createdAt)) / 3600_000) : "?"}h ttl_left=${ttlLeft ?? "none"}h ` +
      `fleet=${fleet?.assignments?.[orchId] ? JSON.stringify(fleet.assignments[orchId]) : "not checked in"} workers=${workersOf(all, orchId).length}`);
  }
  if (!orchs.length) out("no orchestrator sandboxes");
}

async function cmdLogs(id: string, lines = 200) {
  const r = await run(id, `journalctl -u ${UNIT} -n ${lines} --no-pager 2>&1 | tail -n ${lines}`, 60);
  out(r.stdout || r.stderr);
}

async function cmdRenew() {
  for (const s of await orchestrators()) {
    await boatApi(`/sandboxes/${s.id}`, { method: "PATCH", json: { ttlSeconds: MAX_TTL_SECONDS } });
    const after = (await boatApi(`/sandboxes/${s.id}`)).sandbox.archiveAfter;
    out(`${s.id}: archiveAfter ${s.archiveAfter ?? "none"} -> ${after ?? "none"}`);
  }
}

async function cmdUpdate() {
  for (const s of await orchestrators()) {
    const bytes = await uploadCode(s.id);
    await configure(s.id, orchIdOf(s));
    const r = await run(s.id, `sudo systemctl restart ${UNIT} && sleep 3 && systemctl is-active ${UNIT}`, 300);
    out(`${s.id}: redeployed ${bytes} bytes, service ${r.stdout.trim()}`);
  }
}

async function cmdDown(target: string) {
  const orchs = await orchestrators();
  const victims = target === "--all" ? orchs : orchs.filter((s) => s.id === target);
  if (!victims.length) throw new Error(target === "--all" ? "no orchestrator sandboxes" : `no orchestrator sandbox ${target}`);
  for (const s of victims) {
    // Graceful: SIGTERM -> the orchestrator kills its sessions (deleting their worker sandboxes) and leaves the fleet.
    const r = await run(s.id, `sudo systemctl stop ${UNIT}; systemctl is-active ${UNIT} || true`, 300).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
    const left = workersOf(await listSandboxes(), orchIdOf(s));
    for (const w of left) await deleteSandbox(w.id);
    await deleteSandbox(s.id);
    out(`${s.id}: service ${r.stdout.trim() || "stopped"}, ${left.length} leftover worker(s) deleted, sandbox deleted`);
  }
}

/** Live selftest: everything created here is deleted here, then the listing is checked. */
async function cmdSelftest() {
  const created: string[] = [];
  const evidence: Record<string, unknown> = {};
  try {
    const limits = await boatLimits();
    printBudget(computeBudget(limits, 1, POD_CAPACITY), limits);
    const { id, orchId } = await createOrchestrator(1200);
    created.push(id);
    evidence.orchestrator_sandbox = id;
    out(`orchestrator sandbox ${id} ready; uploading code`);
    evidence.code_bytes = await uploadCode(id);
    await configure(id, orchId, { placeholderToken: true }); // selftest: the real worker token is not needed in there
    evidence.guard = await guard(id);
    out("guard inside the sandbox:", evidence.guard);
    const pf = await preflight(id);
    evidence.preflight = pf;
    out(`preflight (expected to fail while the server is not public): ${pf.ok ? "reachable" : pf.reason}`);
    const envCheck = await run(id, `stat -c '%a %U' ${HOME}/orchestrator.env; cut -d= -f1 ${HOME}/orchestrator.env | tr '\\n' ' '`, 30);
    evidence.env_file = envCheck.stdout.trim().split("\n");
    // Nested create/delete with the boat key passed for this test only (0600 file, deleted by the helper on read).
    await put(id, `${HOME}/selftest-boat.key`, BOAT.apiKey);
    await run(id, `chmod 600 ${HOME}/selftest-boat.key`, 30);
    const nested = await run(id, `cd ${HOME}/app/orchestrator && node_modules/.bin/tsx deploy/in-sandbox.ts nested ${HOME}/selftest-boat.key; rm -f ${HOME}/selftest-boat.key`, 300);
    try { evidence.nested = JSON.parse(nested.stdout.trim().split("\n").pop()!); } catch { evidence.nested = { raw: (nested.stdout + nested.stderr).slice(-500) }; }
    out("nested worker sandbox from inside the orchestrator sandbox:", evidence.nested);
    const w = (evidence.nested as any)?.worker_sandbox;
    if (w) created.push(w);
  } finally {
    for (const id of created) await deleteSandbox(id).catch((e) => out(`delete ${id}: ${String(e)}`));
    await sleep(5000);
    const after = await listSandboxes();
    const ours = after.filter((s) => created.includes(s.id) || s.name?.startsWith(ORCH_PREFIX) || s.name?.startsWith(WORKER_PREFIX));
    evidence.created = created;
    evidence.final_listing = { total: after.length, ours: ours.map((s) => `${s.id}:${s.state}`) };
    out("final GET /sandboxes:", evidence.final_listing);
  }
  return evidence;
}

// ---------------------------------------------------------------- main

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, a, b] = process.argv.slice(2);
  (async () => {
    if (cmd === "budget") {
      await boatKey();
      const l = await boatLimits();
      printBudget(computeBudget(l, Number(a ?? 1), POD_CAPACITY), l);
      return;
    }
    if (!["up", "status", "logs", "renew", "update", "down", "selftest"].includes(cmd ?? "")) {
      console.error(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith(" *   npm run")).join("\n"));
      process.exit(2);
    }
    await boatKey();
    if (cmd === "up") await cmdUp(Number(a ?? 1), process.argv.includes("--skip-preflight"));
    if (cmd === "status") await cmdStatus();
    if (cmd === "logs") await cmdLogs(a!, Number(b ?? 200));
    if (cmd === "renew") await cmdRenew();
    if (cmd === "update") await cmdUpdate();
    if (cmd === "down") await cmdDown(a ?? "");
    if (cmd === "selftest") await cmdSelftest();
  })().catch((e) => { console.error(redact(String(e instanceof Error ? e.message : e))); process.exit(1); });
}
