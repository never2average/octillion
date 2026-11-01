/**
 * Hermetic test of Vercel Sandbox worker sandboxes (orchestrator/core/sandbox-provider.ts vercelProvider + vmRunner,
 * src/worker-sandboxes.ts broker, src/vercel-sandbox.ts client) end to end:
 *
 *   real worker.ts (RUNNER=boat, no provider in its env) --worker token--> broker routes (real module, temp PGlite)
 *     --OIDC-shaped token--> mock Vercel Sandbox (scripts/lib/mock-providers.ts, a scripted VM: state.vsbExec)
 *
 *  - the server's choice (orchestrator credentials sandbox_provider: "vercel") switches the workers to Vercel Sandbox
 *  - full sessions complete: harness ensured, prepare, detached launch, log follow, final drain, exit status, diff
 *  - commands longer than one broker call (setup, prepare: 600 s) run detached and are polled
 *  - files reach the VM through fs/write (tar.gz); env files hold only the session's ogw_ gateway token, never the
 *    worker token; a private run gets the network policy (gateway + registries) and its probe, no in-VM proxy
 *  - one Vercel sandbox per session, all deleted; the ownership rows say so; metadata carries the neutral sandbox_* keys
 *
 *   npx tsx orchestrator/test/vercel-workers.ts
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const tmp = mkdtempSync(path.join(tmpdir(), "octillion-vwtest-"));
const WORKER_TOKEN = `wt_SECRET_${randomBytes(12).toString("hex")}`;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const OIDC = `${b64({ alg: "RS256" })}.${b64({ owner_id: "team_vw", project_id: "prj_vw", iss: "https://oidc.vercel.com/vw" })}.c2ln`;
const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (...a: unknown[]) => console.log(`[vwtest ${new Date().toISOString().slice(11, 19)}]`, ...a);
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok, detail }); log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- mock Vercel Sandbox (a scripted VM)
const { startMockProviders } = await import("../../scripts/lib/mock-providers.js");
const mock = await startMockProviders();
Object.assign(process.env, {
  PGLITE_DIR: path.join(tmp, "pglite"), OCTILLION_VAULT_KEY: randomBytes(32).toString("base64"), OCTILLION_WORKER_TOKEN: WORKER_TOKEN,
  PUBLIC_URL: "https://octi.example", VERCEL_OIDC_TOKEN: OIDC, OCTILLION_VERCEL_SANDBOX_API_URL: `${mock.url}/vercel-sandbox`,
  OCTILLION_ORG_MONTHLY_BUDGET_USD: "1000", // accounts without a plan get $0 (prepaid, invite-only)
  OCTILLION_REGISTRY: process.env.OCTILLION_REGISTRY ?? "scripts/fixtures/registry.json", // agents that are running in the population
});
delete process.env.DATABASE_URL; delete process.env.CLICKHOUSE_URL;

const RUN_MS = 1200;
const runs = new Map<string, number>();
const CLAUDE = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "11111111-2222-3333-4444-555555555555", model: "m" }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done.", total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 } }),
];
const DIFF = 'diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-{}\n+{"dependencies":{"left-pad":"^1.3.0"}}\n';
const scripts: string[] = [];
const vm = (sb: string, script: string, files: Map<string, Buffer>): { exitCode?: number; stdout?: string; stderr?: string; durationMs?: number } => {
  scripts.push(script);
  let m: RegExpExecArray | null;
  // A long command (> one broker call): run the script file, keep its output for the `cat` that reads it back.
  // Its files appear when it ends (as in a VM), not when it starts; "STUCK" never ends.
  if ((m = /bash (\/tmp\/\.octi-x\/\w+)\.sh > \1\.out/.exec(script))) {
    const f = m[1]!, inner = files.get(`${f}.sh`)?.toString("utf8") ?? "";
    if (inner === "STUCK") return { durationMs: 1e9 };
    const r = vm(sb, inner, files), d = Math.min(r.durationMs ?? 0, 500) + 300;
    setTimeout(() => { files.set(`${f}.out`, Buffer.from(r.stdout ?? "")); files.set(`${f}.err`, Buffer.from(r.stderr ?? "")); files.set(`${f}.rc`, Buffer.from(String(r.exitCode ?? 0))); }, d);
    return { durationMs: d };
  }
  if ((m = /^test -e (\/tmp\/\.octi-x\/\w+)\.rc/.exec(script))) return { stdout: files.has(`${m[1]}.rc`) ? "done\n" : "" };
  if ((m = /^test -e \/tmp\/octi\/exit-(\d+)/.exec(script))) return { stdout: Date.now() >= (runs.get(`${sb}:${m[1]}`) ?? Infinity) ? "exited\n" : "" };
  if ((m = /o (\/tmp\/\.octi-x\/\w+)\.out/.exec(script)))
    return { stdout: files.get(`${m[1]}.out`)?.toString() ?? "", stderr: files.get(`${m[1]}.err`)?.toString() ?? "", exitCode: Number(files.get(`${m[1]}.rc`)?.toString() ?? 1) };
  if (/cur=/.test(script)) return { stdout: "harness claude-code: preinstalled (2.1.296)\n" };
  if ((m = /launch-(\d+)\.sh/.exec(script))) { runs.set(`${sb}:${m[1]}`, Date.now() + RUN_MS); return { durationMs: RUN_MS }; }
  if ((m = /tail -n \+(\d+)( -F)?.*out-(\d+)\.jsonl/.exec(script))) {
    const lines = CLAUDE.slice(Math.max(0, Number(m[1]) - 1));
    return { stdout: lines.length ? lines.join("\n") + "\n" : "", durationMs: m[2] ? Math.max(0, (runs.get(`${sb}:${m[3]}`) ?? 0) - Date.now()) : 0 };
  }
  if (/cat \/tmp\/octi\/exit-/.test(script)) return { stdout: "0\n" };
  if (/diff\.sh/.test(script)) return { stdout: DIFF };
  if (/egress-probe\.mjs/.test(script)) return { stdout: '{"ok":true,"checks":[{"name":"gateway","want":true,"got":true}]}\n' };
  return {};
};
mock.state.vsbExec = ({ sandbox, script, files }) => vm(sandbox, script, files);

// ---------------------------------------------------------------- server modules (after env): DB, sessions, broker
const { getDb } = await import("../../src/db.js");
const { createOrg } = await import("../../src/auth.js");
const q = await import("../../src/queries.js");
const { resolveWorkerToken } = await import("../../src/workerauth.js");
const { workerSandboxRouter } = await import("../../src/worker-sandboxes.js");
const kv = await import("../../src/keyvault.js");
const db = await getDb();
await kv.addCredential("anthropic", `sk-ant-mock-${randomBytes(12).toString("hex")}`); // the run needs a key for its agent (never reaches the mock VM)
const { org } = await createOrg("Vercel Workers Test", "vwtest");
await q.saveProduct(org, { name: "left-pad", packages: ["left-pad"] });
await q.saveScenarios(org, "left-pad", Array.from({ length: 3 }, (_, i) => ({ title: `t${i}`, prompt: `Task ${i}: add zero padding to the invoice numbers in this small Node project.` })));
// Session rows for the broker's checks (exists, running, token may act on it); the claim below hands out claude-code jobs for them.
await q.runSimulation(org, { product: "left-pad", agents: ["cursor-agent/default"], repeats: 1 });
const sessions = await db.query<any>("SELECT id, simulation_id FROM agent_sessions ORDER BY id");
await db.query("UPDATE agent_sessions SET status = 'running', started_at = now(), heartbeat_at = now() WHERE id = ANY($1)", [sessions.map((s) => s.id)]);
const queue = sessions.map((s, i) => ({ session_id: s.id, simulation_id: s.simulation_id, org_id: org.orgId, product_id: 1, harness: "claude-code", agent_id: "claude-code/sonnet",
  model: "claude-sonnet-5-5", attempt: 1, prompt: "Add left-pad to this project.", repo_url: null, language: null, max_user_turns: 0, profile: null, private: i === 0 }));

const completed = new Map<string, any>();
const app = express();
app.use(express.json({ limit: "32mb" }));
app.use(express.text({ type: ["application/x-ndjson"], limit: "32mb" }));
app.use("/api/worker", (req, res, next) => {
  resolveWorkerToken(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "")).then((auth) => {
    if (!auth) return void res.status(401).json({ error: "Invalid worker token" });
    res.locals.worker = auth;
    next();
  }, next);
});
app.use("/api/worker/sandboxes", workerSandboxRouter((res) => res.locals.worker));
app.post("/api/worker/orchestrator/credentials", (_req, res) => void res.json({ boat: null, llm: null, sandbox_provider: "vercel" }));
app.post("/api/worker/fleet", async (req, res) => {
  // The check-in row the broker reads (a fleet orchestrator must have one; its capacity sizes the cap), as src/fleet.ts writes it.
  await db.query(`INSERT INTO orchestrators (id, capacity, meta) VALUES ($1, $2, '{}') ON CONFLICT (id) DO UPDATE SET capacity = EXCLUDED.capacity, last_seen = now()`,
    [String(req.body?.orchestrator_id), Number(req.body?.capacity ?? 1)]);
  res.json({ orchestrator_id: req.body?.orchestrator_id, next_checkin_seconds: 30,
    assignment: [{ agent_id: "claude-code/sonnet", harness: "claude-code", model: "claude-sonnet-5-5", pods: 2 }] });
});
app.delete("/api/worker/fleet/:id", (_req, res) => void res.status(204).end());
app.post("/api/worker/claim", (req, res) => {
  const jobs = [];
  while (queue.length && jobs.length < Number(req.body?.limit ?? 1)) jobs.push(queue.shift());
  res.json({ jobs });
});
app.post("/api/worker/sessions/:id/credentials", (_req, res) => void res.json({ expires_at: new Date(Date.now() + 3600e3).toISOString(),
  providers: { anthropic: { mode: "gateway", base_url: "https://octi.example/gw/anthropic", api_key: "ogw_session_token_x" } } }));
app.post("/api/worker/sessions/:id/complete", (req, res) => { completed.set(String(req.params.id), req.body); res.json({ verdict: null }); });
app.post("/api/worker/research/claim", (_req, res) => void res.json({ jobs: [] }));
app.use("/api/worker", (_req, res) => void res.json({}));
const server = http.createServer(app);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const OCTI = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// ---------------------------------------------------------------- the real worker
const worker = spawn(TSX, ["orchestrator/worker.ts"], {
  cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
  env: { PATH: process.env.PATH, HOME: process.env.HOME, OCTILLION_URL: OCTI, OCTILLION_WORKER_TOKEN: WORKER_TOKEN, RUNNER: "boat", POD_CAPACITY: "2",
    ORCHESTRATOR_ID: "vwtest", OCTILLION_DEV_ALLOW_LOCAL: "1", POLL_INTERVAL_SECONDS: "1", HEARTBEAT_SECONDS: "30", OCTILLION_EGRESS: "private",
    OCTILLION_VERCEL_EXEC_MAX_SECONDS: "60", OCTILLION_REGISTRY: process.env.OCTILLION_REGISTRY! },
});
let wlog = "";
worker.stdout!.on("data", (d) => (wlog += d));
worker.stderr!.on("data", (d) => (wlog += d));
for (const t = Date.now(); completed.size < sessions.length && Date.now() - t < 120_000; ) await sleep(500);
worker.kill("SIGTERM");
await new Promise((r) => { worker.once("exit", r); setTimeout(r, 15_000); });

const st = mock.state;
const statuses = [...completed.values()].map((c) => c.status);
check("server's choice (sandbox_provider: vercel) puts the workers on Vercel Sandbox", /runner=vercel/.test(wlog) && /vercel sandbox broker OK/.test(wlog),
  wlog.split("\n").find((l) => /runner=/.test(l))?.slice(0, 160) ?? "");
check(`all ${sessions.length} sessions completed through Vercel worker sandboxes`, completed.size === sessions.length && statuses.every((s) => s === "completed"),
  `${completed.size} completed: ${[...new Set(statuses)].join(",")} ${[...completed.values()].map((c) => c.error_message).filter(Boolean).join(" | ").slice(0, 300)}`);
const rows = await db.query<any>("SELECT * FROM worker_sandboxes ORDER BY id");
check("one Vercel sandbox per session, owned by this fleet orchestrator (fleet:vwtest), all deleted by the orchestrator",
  rows.length === sessions.length && rows.every((r) => r.owner === "fleet:vwtest" && r.orchestrator_id === "vwtest" && r.deleted_at && r.delete_reason === "orchestrator") && st.vsbSandboxes.size === 0,
  `${rows.length} rows, ${rows.filter((r) => !r.deleted_at).length} live, ${st.vsbSandboxes.size} left at Vercel`);
check("sessions map to their own sandbox", new Set(rows.map((r) => r.session_id)).size === sessions.length);
check("the diff was taken in every sandbox (streamed through the broker)", scripts.filter((s) => /bash \/tmp\/octi\/diff\.sh/.test(s)).length >= sessions.length);
const meta = [...completed.values()].map((c) => c.metadata ?? {});
check("metadata: provider-neutral sandbox_* keys (vercel, size, seconds, est. cost); no boat_* keys",
  meta.every((m) => m.sandbox_provider === "vercel" && m.sandbox_type === "default" && typeof m.sandbox_seconds === "number" && m.sandbox_est_cost_usd > 0 && m.boat_est_cost_usd === undefined && m.runner === "vercel"),
  JSON.stringify(meta[0] ? { p: meta[0].sandbox_provider, t: meta[0].sandbox_type, s: meta[0].sandbox_seconds, c: meta[0].sandbox_est_cost_usd, r: meta[0].runner } : null));
check("commands longer than one broker call ran detached and were read back", scripts.some((s) => /timeout -k 10 600 bash \/tmp\/\.octi-x\//.test(s)) && scripts.some((s) => /prepare\.sh/.test(s)));
const allFiles = [...st.vsbFiles.values()].flatMap((m: Map<string, Buffer>) => [...m.entries()]);
const envFiles = allFiles.filter(([p]) => /^\/tmp\/octi\/env-\d+$/.test(p)).map(([, c]) => c.toString());
const leaks = [...allFiles.map(([, c]) => c.toString()), ...scripts].filter((x) => x.includes(WORKER_TOKEN) || x.includes(OIDC));
check("files arrive through fs/write; env files hold only the session's ogw_ token; the worker token and the Vercel token never reach a sandbox",
  envFiles.length === sessions.length && envFiles.every((c) => /ANTHROPIC_API_KEY='ogw_/.test(c) && !/OCTILLION|WORKER|VERCEL/.test(c)) && !leaks.length,
  `${envFiles.length} env files, ${leaks.length} leaks`);
const policies = [...st.vsbPolicies.values()];
check("the private run is locked down by the network policy (gateway + registries, private subnets denied), probed, no in-VM proxy",
  policies.length === 1 && policies[0].allow.includes("octi.example") && policies[0].allow.includes("registry.npmjs.org") && policies[0].subnets?.deny?.includes("169.254.0.0/16")
  && scripts.some((s) => /egress-probe\.mjs/.test(s)) && !scripts.some((s) => /egress-setup\.sh/.test(s)) && rows.filter((r) => r.network_policy).length === 1,
  JSON.stringify(policies.map((p) => p.allow.length)));
const launches = allFiles.filter(([p]) => /launch-\d+\.sh$/.test(p)).map(([, c]) => c.toString());
check("launch scripts record their pid for the follower (no pid from Vercel)", launches.length > 0 && launches.every((c) => /echo \$\$ > \/tmp\/octi\/pid-\d+/.test(c)));

// ---- the production bug (sim_r6OJKC3PFtUE): a plain GET of a finished command kept answering exitCode null ----
// The mock does the same (vsbPlainGetStale): everything above completed only because "finished?" no longer trusts it.
check("the mock reproduces the stale plain GET (as production did)", st.vsbPlainGetStale === true);
const { CFG, SANDBOX } = await import("../core/config.js");
Object.assign(CFG, { url: OCTI, token: WORKER_TOKEN, orchestratorId: "vwtest" });
SANDBOX.vercelExecMaxSeconds = 30;
const { vercelProvider } = await import("../core/sandbox-provider.js");
const vp = vercelProvider({ graceSec: 2 });
await db.query("UPDATE agent_sessions SET status = 'running' WHERE id = $1", [sessions[0].id]);
await db.query("INSERT INTO orchestrators (id, capacity, meta) VALUES ('vwtest', 2, '{}') ON CONFLICT (id) DO UPDATE SET last_seen = now()");
const sbx = await vp.create({ size: "small", timeoutSec: 3600, name: "stuck-check", sessionId: sessions[0].id });
await vp.waitReady(sbx, 10_000);
const realVm = st.vsbExec;
st.vsbExec = () => ({ durationMs: 50, exitCode: 7 });
const fin = await vp.execDetached(sbx, "true");
await sleep(300);
const vsid = st.vsbSandboxes.get(sbx)?.session;
const plain = await (await fetch(`${mock.url}/vercel-sandbox/v2/sandboxes/sessions/${vsid}/cmd/${fin.handle}?teamId=team_vw`, { headers: { authorization: `Bearer ${OIDC}` } })).json();
const viaBroker = await (await fetch(`${OCTI}/api/worker/sandboxes/${sbx}/commands/${fin.handle}`, { headers: { authorization: `Bearer ${WORKER_TOKEN}`, "x-octillion-orchestrator": "vwtest" } })).json();
check("a finished detached command: Vercel's plain GET still says exitCode null, the broker says finished with its exit code (the old mapping said running forever)",
  plain?.command?.exitCode === null && viaBroker.running === false && viaBroker.exit_code === 7, `plain ${JSON.stringify(plain?.command?.exitCode)} broker ${JSON.stringify(viaBroker)}`);
const stillRunning = await vp.execDetached(sbx, "sleep");
st.vsbExec = () => ({ durationMs: 60_000 });
const busy = await vp.execDetached(sbx, "sleep");
check("a running command still reads as running", (await vp.running(sbx, busy.handle)) === true);
void stillRunning;
st.vsbExec = realVm;
// A setup step that never ends fails at its timeout (+ grace) with a clear error, instead of being polled forever.
const t0 = Date.now();
let stuck = "";
try { await vp.exec(sbx, "STUCK", { timeoutSec: 31 }); } catch (e) { stuck = String(e instanceof Error ? e.message : e); }
check("a stuck setup step fails after its timeout with a clear error", /setup step did not finish within 31s \(\+2s\): STUCK/.test(stuck) && Date.now() - t0 < 60_000,
  `${stuck} after ${Math.round((Date.now() - t0) / 1000)}s`);
await vp.delete(sbx);

// Selection rules (orchestrator/core/runners.ts selectRunner): boat unless told otherwise; this process's env wins.
const rn = await import("../core/runners.js");
check("selection: boat by default; the server's vercel switches RUNNER=boat; env overrides either way; docker/local untouched",
  rn.selectRunner("boat", undefined, null) === rn.boatRunner && rn.selectRunner("boat", "boat", null) === rn.boatRunner
  && rn.selectRunner("boat", "vercel", null) === rn.vercelRunner && rn.selectRunner("boat", "vercel", "boat") === rn.boatRunner
  && rn.selectRunner("boat", null, "vercel") === rn.vercelRunner && rn.selectRunner("vercel", null, null) === rn.vercelRunner
  && rn.selectRunner("docker", "vercel", null)?.name === "docker" && rn.selectRunner("local", "vercel", "vercel")?.name === "local");

server.close(); await mock.close();
if (results.some((r) => !r.ok)) console.log("--- worker log tail\n" + wlog.split("\n").slice(-40).join("\n"));
const pass = results.every((r) => r.ok);
console.log(`\n${pass ? "VERCEL WORKERS TEST PASS" : "VERCEL WORKERS TEST FAIL"} (${results.filter((r) => r.ok).length}/${results.length} assertions)`);
process.exit(pass ? 0 : 1);
