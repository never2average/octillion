/**
 * Hermetic tests for production topology (orchestrators only inside Vercel Sandbox orchestrator sandboxes; worker
 * sandboxes through the API's broker):
 *  - host guard: refuses a non-sandbox host, refuses RUNNER=pool|docker|local without OCTILLION_DEV_ALLOW_LOCAL=1,
 *    refuses the retired boat.dev (RUNNER=boat, its host role), accepts a Vercel Sandbox with the launcher's markers;
 *    the real entry point refuses on this (non-sandbox) machine, and RUNNER=boat fails with a clear error
 *  - fleet semantics: the server assignment caps concurrent worker sandboxes per agent group, claims carry
 *    {agent_ids:[group]} with limit = free slots, one fresh worker sandbox per session, deleted afterwards
 *  - network drops after a run exited (final drain, exit status) are retried, not failed sessions
 *  - the worker token never reaches a worker sandbox (files, commands, env files)
 *
 *   npx tsx orchestrator/test/fleet-guard.ts
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkHost, type HostProbe } from "../core/host-guard.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const OCTI_PORT = Number(process.env.FTEST_OCTI_PORT ?? 3402);
const WORKER_TOKEN = `wt_SECRET_${randomBytes(12).toString("hex")}`;
const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (...a: unknown[]) => console.log(`[ftest ${new Date().toISOString().slice(11, 19)}]`, ...a);
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok, detail }); log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 1. guard (pure)

const probe = (env: Record<string, string>, files: Record<string, string | true>): HostProbe => ({
  env, exists: (p) => p in files, read: (p) => (typeof files[p] === "string" ? (files[p] as string) : null),
});
const vName = "octi-vo-prod-v0a1b2c3d4e";
const vEnv = { OCTILLION_HOST_ROLE: "vercel-orchestrator", OCTILLION_SANDBOX_ID: vName };
const vMarker = JSON.stringify({ role: "vercel-orchestrator", provider: "vercel", sandbox_id: vName, orchestrator_id: "orch-v0a1b2c3d4e" });
const vFiles = { "/etc/pki/ca-trust/source/anchors/vercel-proxy-ca.pem": true as const, "/vercel/runtimes": true as const, "/etc/octillion/host-role": vMarker };
const g1 = checkHost("vercel", probe({}, {}));
const g2 = checkHost("local", probe(vEnv, vFiles));
const g3 = checkHost("pool", probe({ OCTILLION_DEV_ALLOW_LOCAL: "1" }, {}));
check("guard refuses a non-sandbox host", !g1.ok && g1.problems.length >= 3, g1.problems.join(" | ").slice(0, 160));
check("guard refuses RUNNER=local on an orchestrator sandbox without the dev flag", !g2.ok && /RUNNER=local is not allowed/.test(g2.problems.join()), g2.problems[0] ?? "");
check("dev flag bypasses with a loud warning", g3.ok && g3.dev && /HOST GUARD DISABLED/.test(g3.warning ?? ""), (g3.warning ?? "").split("\n")[1] ?? "");
// Vercel Sandbox orchestrators (deploy/vercel-orch.ts): their env role, the marker, and Vercel's own indicators.
const v1 = checkHost("vercel", probe(vEnv, vFiles));
const v2 = checkHost("vercel", probe(vEnv, { "/etc/octillion/host-role": vMarker })); // our VM with a copied env file and marker
const v3 = checkHost("vercel", probe({ ...vEnv, OCTILLION_SANDBOX_ID: "octi-vo-prod-vffffffffff" }, vFiles));
const v4 = checkHost("vercel", probe(vEnv, { ...vFiles, "/etc/octillion/host-role": '{"role":"boat-orchestrator"}' }));
const v5 = checkHost("vercel", probe({ ...vEnv, VERCEL_REGION: "iad1" }, vFiles));
const v6 = checkHost("vercel", probe({ OCTILLION_HOST_ROLE: "vercel-orchestrator" }, vFiles));
const v8 = checkHost("vercel", probe(vEnv, { ...vFiles, "/etc/octillion/host-role": '{"role":"vercel-orchestrator","provider":"vercel"}' }));
check("guard accepts a Vercel orchestrator sandbox (env role + marker + proxy CA + /vercel)", v1.ok && v1.provider === "vercel", v1.problems.join());
check("guard refuses a non-sandbox host claiming Vercel (no proxy CA, no /vercel): our VM", !v2.ok && /proxy CA/.test(v2.problems.join()) && /\/vercel\/runtimes/.test(v2.problems.join()), v2.problems.join(" | "));
check("guard refuses when OCTILLION_SANDBOX_ID does not match the marker", !v3.ok && /does not match/.test(v3.problems.join()), v3.problems.join());
check("guard refuses another role's marker under a Vercel env role", !v4.ok && /marker/.test(v4.problems.join()), v4.problems.join());
check("guard refuses a Vercel function (the API never runs orchestrators)", !v5.ok && /Vercel function/.test(v5.problems.join()), v5.problems.join());
check("guard refuses a Vercel env file without its sandbox id", !v6.ok && /OCTILLION_SANDBOX_ID/.test(v6.problems.join()), v6.problems.join());
check("guard refuses a Vercel marker without sandbox_id", !v8.ok && /names no sandbox_id/.test(v8.problems.join()), v8.problems.join());
// boat.dev was retired: its runner and its host role are refused, with the reason.
const b1 = checkHost("boat", probe(vEnv, vFiles));
const b2 = checkHost("vercel", probe({ OCTILLION_HOST_ROLE: "boat-orchestrator", BOAT_ID: "bx_abcd2345" },
  { "/etc/ascii": true, "/home/user/.ascii": true, "/etc/octillion/host-role": '{"role":"boat-orchestrator","sandbox_id":"bx_abcd2345"}' }));
check("guard refuses RUNNER=boat, saying boat.dev was retired", !b1.ok && /RUNNER=boat is retired \(boat\.dev was retired on 2026-11-01\)/.test(b1.problems.join()), b1.problems.join());
check("guard refuses a boat.dev host (its role, marker and files), saying it was retired", !b2.ok && /boat-orchestrator: boat\.dev was retired/.test(b2.problems.join()) && /proxy CA/.test(b2.problems.join()), b2.problems.join(" | "));
const real = spawnSync(TSX, ["orchestrator/worker.ts"], { cwd: ROOT, encoding: "utf8", timeout: 60_000,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, OCTILLION_URL: "http://127.0.0.1:1", OCTILLION_WORKER_TOKEN: "x", RUNNER: "local" } });
check("the real entry point refuses to start on this machine", real.status !== 0 && /Refusing to start/.test(real.stderr + real.stdout),
  (real.stderr + real.stdout).split("\n").find((l) => /Refusing/.test(l))?.slice(0, 140) ?? `exit ${real.status}`);
const realBoat = spawnSync(TSX, ["orchestrator/worker.ts"], { cwd: ROOT, encoding: "utf8", timeout: 60_000,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, OCTILLION_URL: "http://127.0.0.1:1", OCTILLION_WORKER_TOKEN: "x", RUNNER: "boat", OCTILLION_DEV_ALLOW_LOCAL: "1", CREDENTIALS_MODE: "env" } });
check("RUNNER=boat (even with the guard bypassed) fails at startup with a clear error", realBoat.status !== 0 && /RUNNER=boat: boat\.dev was retired/.test(realBoat.stderr + realBoat.stdout),
  (realBoat.stderr + realBoat.stdout).split("\n").find((l) => /boat/.test(l))?.slice(0, 160) ?? `exit ${realBoat.status}`);

// ---------------------------------------------------------------- 2. mock Octillion (fleet + the worker sandbox broker), real worker

const GROUPS = { "claude-code/opus": 2, "claude-code/sonnet": 1 };
interface Sb { id: string; name: string; alive: boolean; files: Map<string, string>; cmds: string[]; procs: Map<string, { end: number; n: number }> }
const sandboxes = new Map<string, Sb>();
let created = 0;
const liveByGroup: Record<string, number> = {}, maxByGroup: Record<string, number> = {};
const groupOf = (name: string) => (/opus/.test(name) ? "claude-code/opus" : /sonnet/.test(name) ? "claude-code/sonnet" : "?");
const RUN_MS = 1500;
let drainFaults = 2, exitFaults = 2; // network drops injected after a run has exited (see the stream / exit handlers)

const streamLines = (from: number) => [
  JSON.stringify({ type: "system", subtype: "init", session_id: "11111111-2222-3333-4444-555555555555", model: "m" }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done.", total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 } }),
].slice(Math.max(0, from - 1));
const json = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

/** What a script run in the mock VM prints: the harness is preinstalled at the pin; everything else prints nothing. */
const outputOf = (script: string) => (/cur=/.test(script) ? "harness claude-code: preinstalled (2.1.296)\n" : "");

/** The broker (src/worker-sandboxes.ts) as the vercel provider (core/sandbox-provider.ts) calls it, with a scripted VM. */
async function broker(req: http.IncomingMessage, res: http.ServerResponse, u: string, b: any) {
  const route = u.replace(/^\/api\/worker\/sandboxes/, "").split("?")[0]!;
  if (route === "/config") return json(res, 200, { configured: true, via: "mock", region: "iad1" });
  if (route === "" && req.method === "POST") {
    const id = `octi-vw-test-${randomBytes(4).toString("hex")}`;
    created++;
    const g = groupOf(String(b.name)); liveByGroup[g] = (liveByGroup[g] ?? 0) + 1; maxByGroup[g] = Math.max(maxByGroup[g] ?? 0, liveByGroup[g]!);
    sandboxes.set(id, { id, name: String(b.name), alive: true, files: new Map(), cmds: [], procs: new Map() });
    return json(res, 200, { id });
  }
  if (route === "" && req.method === "GET") return json(res, 200, { sandboxes: [] });
  const m = /^\/([^/]+)(\/.*)?$/.exec(route);
  const sb = m ? sandboxes.get(decodeURIComponent(m[1]!)) : undefined;
  if (!sb) return json(res, 404, { error: "not found" });
  if (!sb.alive) return json(res, 410, { error: "deleted" });
  const rest = m![2] ?? "";
  if (req.method === "GET" && rest === "") return json(res, 200, { state: "ready" });
  if (req.method === "DELETE" && rest === "") { sb.alive = false; liveByGroup[groupOf(sb.name)]!--; return json(res, 200, { ok: true }); }
  if (req.method === "PUT" && rest === "/files") { sb.files.set(b.path, String(b.content ?? Buffer.from(b.content_base64 ?? "", "base64").toString())); return json(res, 200, { ok: true }); }
  if (req.method === "POST" && rest === "/commands") {
    const cmd = String(b.command);
    sb.cmds.push(cmd);
    const cid = `cmd_${randomBytes(4).toString("hex")}`;
    const n = Number(/launch-(\d+)\.sh/.exec(cmd)?.[1] ?? 0);
    sb.procs.set(cid, { end: Date.now() + (n ? RUN_MS : 0), n });
    // A long step (setup, prepare) runs detached and writes its rc file: done at once here.
    const f = /bash (\/tmp\/\.octi-x\/[0-9a-f]+)\.sh/.exec(cmd)?.[1];
    if (f) { sb.files.set(`${f}.rc`, "0"); sb.files.set(`${f}.out`, outputOf(sb.files.get(`${f}.sh`) ?? "")); }
    return json(res, 200, { command_id: cid });
  }
  const cm = /^\/commands\/([^/]+)$/.exec(rest);
  if (req.method === "GET" && cm) { const p = sb.procs.get(cm[1]!); return json(res, 200, { running: !!p && Date.now() < p.end }); }
  if (req.method === "POST" && rest === "/exec") {
    const cmd = String(b.command);
    sb.cmds.push(cmd);
    if (b.stream) {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const frame = (o: object) => res.write(JSON.stringify(o) + "\n");
      frame({ type: "started" });
      const tail = /tail -n \+(\d+)( -F)?.* \/tmp\/octi\/out-(\d+)\.jsonl/.exec(cmd);
      // Network drop on the final drain (the run has exited, no -F): the stream reports the reset as an error frame.
      if (tail && !tail[2] && drainFaults-- > 0)
        return void res.end(JSON.stringify({ type: "error", message: "ECONNRESET: The socket connection was closed unexpectedly." }) + "\n");
      if (tail) {
        const p = [...sb.procs.values()].find((x) => x.n === Number(tail[3]));
        if (tail[2] && p) await sleep(Math.max(0, p.end - Date.now()));
        const lines = streamLines(Number(tail[1]));
        if (lines.length) frame({ type: "stdout", data: lines.join("\n") + "\n" });
      }
      // The mock agent "added left-pad": a dependency change, so the done check passes after one run.
      if (/diff\.sh/.test(cmd)) frame({ type: "stdout", data: 'diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-{}\n+{"dependencies":{"left-pad":"^1.3.0"}}\n' });
      return void res.end(JSON.stringify({ type: "exit", exitCode: 0 }) + "\n");
    }
    const rc = /test -e (\/tmp\/\.octi-x\/[0-9a-f]+)\.rc/.exec(cmd)?.[1];
    if (rc) return json(res, 200, { exitCode: 0, stdout: sb.files.has(`${rc}.rc`) ? "done\n" : "", stderr: "" });
    const back = /rc=\$\(cat (\/tmp\/\.octi-x\/[0-9a-f]+)\.rc/.exec(cmd)?.[1];
    if (back) return json(res, 200, { exitCode: 0, stdout: sb.files.get(`${back}.out`) ?? "", stderr: "" });
    const ex = /test -e \/tmp\/octi\/exit-(\d+)/.exec(cmd);
    if (ex) { const p = [...sb.procs.values()].find((x) => x.n === Number(ex[1])); return json(res, 200, { exitCode: 0, stdout: p && Date.now() >= p.end ? "exited\n" : "", stderr: "" }); }
    // ...and a socket that dies while reading the exit status.
    if (/cat \/tmp\/octi\/exit-/.test(cmd) && exitFaults-- > 0) return void req.socket.destroy();
    if (/cat \/tmp\/octi\/exit-/.test(cmd)) return json(res, 200, { exitCode: 0, stdout: "0\n", stderr: "" });
    return json(res, 200, { exitCode: 0, stdout: outputOf(cmd), stderr: "" });
  }
  json(res, 404, { error: "not found" });
}

const queue = [
  ...Array.from({ length: 5 }, (_, i) => ({ session_id: `opus${i}`, agent_id: "claude-code/opus", model: "claude-opus-5-5" })),
  ...Array.from({ length: 3 }, (_, i) => ({ session_id: `sonnet${i}`, agent_id: "claude-code/sonnet", model: "claude-sonnet-5-5" })),
].map((j) => ({ simulation_id: "sim", org_id: 1, product_id: 1, harness: "claude-code", attempt: 1, prompt: "Add left-pad to this project.", repo_url: null, language: null, max_user_turns: 0, profile: null, ...j }));
const claims: { agent_ids?: string[]; limit: number; got: number }[] = [];
const completed = new Map<string, any>();
let fleetLeft = false;
const octi = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.headers.authorization !== `Bearer ${WORKER_TOKEN}`) return json(res, 401, { error: "bad token" });
    const b = raw && /^application\/json/.test(String(req.headers["content-type"])) ? JSON.parse(raw) : {};
    const u = String(req.url);
    if (u.startsWith("/api/worker/sandboxes")) return void broker(req, res, u, b);
    if (u === "/api/worker/orchestrator/credentials") return json(res, 200, { llm: null, sandbox_provider: "vercel" });
    if (u === "/api/worker/fleet" && req.method === "POST")
      return json(res, 200, { orchestrator_id: b.orchestrator_id, next_checkin_seconds: 30,
        assignment: Object.entries(GROUPS).map(([agent_id, pods]) => ({ agent_id, harness: "claude-code", model: agent_id.endsWith("opus") ? "claude-opus-5-5" : "claude-sonnet-5-5", pods })) });
    if (u.startsWith("/api/worker/fleet/") && req.method === "DELETE") { fleetLeft = true; res.writeHead(204); return res.end(); }
    if (u === "/api/worker/claim") {
      const jobs = [];
      for (let i = 0; i < queue.length && jobs.length < b.limit; ) if (!b.agent_ids || b.agent_ids.includes(queue[i]!.agent_id)) jobs.push(queue.splice(i, 1)[0]); else i++;
      claims.push({ agent_ids: b.agent_ids, limit: b.limit, got: jobs.length });
      return json(res, 200, { jobs });
    }
    const m = /^\/api\/worker\/sessions\/([^/]+)\/(credentials|complete|events|heartbeat)$/.exec(u);
    if (m?.[2] === "credentials") return json(res, 200, { expires_at: new Date(Date.now() + 3600e3).toISOString(), providers: { anthropic: { mode: "gateway", base_url: "https://octi.example/gw/anthropic", api_key: "ogw_session_token_x" } } });
    if (m?.[2] === "complete") { completed.set(m[1]!, b); return json(res, 200, { verdict: null }); }
    if (u.startsWith("/api/worker/research")) return json(res, 200, { jobs: [] });
    json(res, 200, {});
  });
});

await new Promise<void>((r) => octi.listen(OCTI_PORT, "127.0.0.1", () => r()));
const worker = spawn(TSX, ["orchestrator/worker.ts"], {
  cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
  env: { PATH: process.env.PATH, HOME: process.env.HOME, OCTILLION_URL: `http://127.0.0.1:${OCTI_PORT}`, OCTILLION_WORKER_TOKEN: WORKER_TOKEN,
    RUNNER: "vercel", POD_CAPACITY: "3", ORCHESTRATOR_ID: "ftest", OCTILLION_DEV_ALLOW_LOCAL: "1", POLL_INTERVAL_SECONDS: "1", HEARTBEAT_SECONDS: "30" },
});
let wlog = "";
worker.stdout!.on("data", (d) => (wlog += d));
worker.stderr!.on("data", (d) => (wlog += d));
for (const t = Date.now(); completed.size < 8 && Date.now() - t < 120_000; ) await sleep(500);
worker.kill("SIGTERM");
await new Promise((r) => { worker.once("exit", r); setTimeout(r, 15_000); });

const statuses = [...completed.values()].map((c) => c.status);
check("all 8 sessions completed through worker sandboxes", completed.size === 8 && statuses.every((s) => s === "completed"), `${completed.size} completed: ${[...new Set(statuses)].join(",")}`);
check("per-group concurrent worker sandboxes capped by the fleet assignment (opus 2, sonnet 1) and reached",
  maxByGroup["claude-code/opus"] === 2 && maxByGroup["claude-code/sonnet"] === 1, JSON.stringify(maxByGroup));
const badClaims = claims.filter((c) => c.got > 0 && (!c.agent_ids || c.agent_ids.length !== 1 || c.limit > GROUPS[c.agent_ids[0] as keyof typeof GROUPS]));
check("claims carry {agent_ids:[group]} with limit <= the group's free slots", claims.length > 0 && !badClaims.length,
  claims.filter((c) => c.got).map((c) => `${c.agent_ids?.[0]?.split("/")[1]}:${c.limit}->${c.got}`).join(" "));
check("one fresh worker sandbox per session, all deleted", created === 8 && [...sandboxes.values()].every((s) => !s.alive), `${created} created, ${[...sandboxes.values()].filter((s) => s.alive).length} alive`);
check("network drops after a run exited (final drain, exit status) are retried, not failed sessions",
  drainFaults <= 0 && exitFaults <= 0 && completed.size === 8, `drain faults left ${drainFaults}, exit faults left ${exitFaults}, completed ${completed.size}/8`);
const leaks = [...sandboxes.values()].filter((s) => [...s.files.values(), ...s.cmds].some((x) => x.includes(WORKER_TOKEN)));
const envFiles = [...sandboxes.values()].flatMap((s) => [...s.files.entries()].filter(([p]) => /\/env-\d+$/.test(p)).map(([, c]) => c));
const envKeys = [...new Set(envFiles.flatMap((c) => c.split("\n").map((l) => l.split("=")[0]).filter(Boolean)))].sort();
check("the worker token never reaches a worker sandbox; env files hold only harness creds",
  !leaks.length && envFiles.length === 8 && envKeys.every((k) => !/OCTILLION|WORKER/.test(k)) && envFiles.every((c) => /ANTHROPIC_API_KEY='ogw_/.test(c)),
  `leaks ${leaks.length}; env keys: ${envKeys.join(",")}`);
const meta = [...completed.values()].map((c) => c.metadata ?? {});
check("sessions record the neutral sandbox_* keys (vercel), no boat_* keys", meta.every((m) => m.sandbox_provider === "vercel" && !Object.keys(m).some((k) => k.startsWith("boat_"))),
  JSON.stringify(meta[0] ?? {}).slice(0, 200));
check("SIGTERM: left the fleet", fleetLeft, "");

octi.close();
if (results.some((r) => !r.ok)) console.log("--- worker log tail\n" + wlog.split("\n").slice(-25).join("\n"));
const pass = results.every((r) => r.ok);
console.log(`\n${pass ? "FLEET + GUARD TEST PASS" : "FLEET + GUARD TEST FAIL"} (${results.filter((r) => r.ok).length}/${results.length} assertions)`);
process.exit(pass ? 0 : 1);
