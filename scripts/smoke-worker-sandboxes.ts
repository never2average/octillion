// Worker sandbox broker checks for scripts/smoke.ts (src/worker-sandboxes.ts), against the mock Vercel Sandbox in
// scripts/lib/mock-providers.ts, through the real server: not configured without a Vercel token; a gateway (ogw_) token
// is refused; a job token creates only for its own running session; nobody else (another job's token, the fleet token as
// any orchestrator) can see, run in, write to, lock down or delete that sandbox (403), unknown ids are 404 and deleted ones
// 410; exec (sync, streamed, cut, output capped), detached commands, files (tar.gz), network policy, list; caps that hold
// under concurrent creates; fleet orchestrators each capped by their own capacity; a re-claimed session's old sandbox
// replaced; delete; the reaper (session over, orchestrator gone, deadline) and the stray sweep (own environment only).
import assert from "node:assert/strict";

type Db = { query: <T = any>(sql: string, params?: unknown[]) => Promise<T[]> };

export async function workerSandboxChecks({ db, base, mockUrl, mockState, workerToken, adm }: { db: Db; base: string; mockUrl: string; mockState: any; workerToken: string;
  adm: (method: string, path: string, body?: unknown) => Promise<Response> }) {
  const wa = await import("../src/workerauth.js");
  const ws = await import("../src/worker-sandboxes.js");
  const vs = await import("../src/vercel-sandbox.js");
  const saved = Object.fromEntries(["VERCEL_OIDC_TOKEN", "OCTILLION_VERCEL_SANDBOX_TOKEN", "OCTILLION_VERCEL_SANDBOX_API_URL", "OCTILLION_WORKER_SANDBOX_CAP_MARGIN",
    "OCTILLION_WORKER_SANDBOX_NAMESPACE"].map((k) => [k, process.env[k]]));
  for (const k of Object.keys(saved)) delete process.env[k];
  const call = (method: string, path: string, token: string, body?: unknown, orch?: string) => fetch(`${base}/api/worker/sandboxes${path}`, {
    method, body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: { authorization: `Bearer ${token}`, ...(orch ? { "x-octillion-orchestrator": orch } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) } });
  const json = async (r: Response | Promise<Response>) => (await r).json();
  const ORCH1 = "smoke-ws-orch-1", ORCH2 = "smoke-ws-orch-2";

  // Two simulations with a session each; their sessions running for the test, restored afterwards.
  const sims = await db.query<any>("SELECT simulation_id, min(id) AS id FROM agent_sessions GROUP BY simulation_id ORDER BY simulation_id LIMIT 2");
  assert.equal(sims.length, 2, "two simulations with sessions for the broker test");
  const [A, B] = sims as { simulation_id: string; id: string }[];
  const before = await db.query<any>("SELECT id, status FROM agent_sessions WHERE id = ANY($1)", [[A!.id, B!.id]]);
  const tokA = await wa.mintJobWorkerToken(A!.simulation_id, null), tokB = await wa.mintJobWorkerToken(B!.simulation_id, null);
  try {
    // ---- not configured: no OIDC token, no access token ----
    const nc = await json(call("GET", "/config", tokA));
    assert.ok(nc.configured === false && /OIDC/.test(nc.reason), `not configured without a Vercel token: ${JSON.stringify(nc)}`);
    await db.query("UPDATE agent_sessions SET status = 'running' WHERE id = ANY($1)", [[A!.id, B!.id]]);
    const ncCreate = await call("POST", "", tokA, { session_id: A!.id });
    assert.equal(ncCreate.status, 503, "creating without Vercel configured is a clear 503");
    assert.equal((await db.query("SELECT 1 FROM worker_sandboxes")).length, 0, "and records nothing");

    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    process.env.VERCEL_OIDC_TOKEN = `${b64({ alg: "RS256" })}.${b64({ owner_id: "team_smoke", project_id: "prj_smoke" })}.c2ln`;
    process.env.OCTILLION_VERCEL_SANDBOX_API_URL = `${mockUrl}/vercel-sandbox`;
    assert.deepEqual(await json(call("GET", "/config", tokA)), { configured: true, via: "oidc", region: "iad1" });
    assert.equal((await call("GET", "/config", "owk_forged")).status, 401, "the broker needs a worker token");
    // A session's gateway token (what a worker sandbox holds) is not a worker token.
    const orchCreds = await json(fetch(`${base}/api/worker/orchestrator/credentials`, { method: "POST", headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ orchestrator_id: "smoke-ws-gw" }) }));
    const ogw = String(orchCreds?.llm?.api_key ?? "ogw_not_a_worker_token");
    assert.ok(ogw.startsWith("ogw_"));
    for (const [m, p] of [["GET", "/config"], ["POST", ""], ["GET", "/"]] as const) assert.equal((await call(m, p, ogw, m === "POST" ? { session_id: A!.id } : undefined)).status, 401, `an ogw_ token: ${m} ${p || "/"} is 401`);
    await db.query("DELETE FROM gateway_tokens WHERE orchestrator_id = 'smoke-ws-gw'");
    assert.equal((await call("GET", "/", workerToken)).status, 400, "the fleet token must name its orchestrator");

    // ---- create: own running session only ----
    assert.equal((await call("POST", "", tokA, { session_id: B!.id })).status, 403, "a job token cannot create for another job's session");
    assert.equal((await call("POST", "", tokA, {})).status, 400);
    await db.query("UPDATE agent_sessions SET status = 'completed' WHERE id = $1", [A!.id]);
    assert.equal((await call("POST", "", tokA, { session_id: A!.id })).status, 409, "not for a session that is not running");
    await db.query("UPDATE agent_sessions SET status = 'running' WHERE id = $1", [A!.id]);
    const made = await call("POST", "", tokA, { session_id: A!.id, size: "small", timeout_sec: 3600, name: "octi-w-orch-1-claude-code-sonnet" });
    assert.equal(made.status, 201);
    const sb = await made.json();
    assert.ok(sb.id.startsWith(ws.workerPrefix()) && ws.workerPrefix().endsWith("-vw-local-") && sb.vcpus === 1 && sb.memory_mb === 2048 && sb.timeout_sec === 3600, `created: ${JSON.stringify(sb)}`);
    const vx = mockState.vsbSandboxes.get(sb.id);
    assert.ok(vx && vx.vcpus === 1 && vx.memory === 2048 && vx.timeout === 3600_000 && vx.persistent === false && vx.region === "iad1", "made at Vercel as asked: 1 vCPU / 2 GB, 1 h, not persistent, iad1");
    const [row] = await db.query<any>("SELECT * FROM worker_sandboxes WHERE sandbox_id = $1", [sb.id]);
    assert.ok(row.owner === `job:${A!.simulation_id}` && row.session_id === A!.id && row.job_id === A!.simulation_id && row.vm_session, "the ownership row");

    // ---- ownership: another job's token and the fleet token (as any orchestrator) get 403 on every route; unknown ids 404 ----
    const one = `/${encodeURIComponent(sb.id)}`;
    const routes: [string, string, unknown?][] = [["GET", one], ["POST", `${one}/exec`, { command: "id" }], ["POST", `${one}/commands`, { command: "id" }],
      ["GET", `${one}/commands/cmd_x`], ["PUT", `${one}/files`, { path: "/tmp/x", content: "x" }], ["POST", `${one}/network-policy`, { allow: ["example.com"] }], ["DELETE", one]];
    for (const [tok, orch] of [[tokB, undefined], [workerToken, ORCH1]] as const) for (const [m, p, body] of routes)
      assert.equal((await call(m, p, tok, body, orch)).status, 403, `${tok === tokB ? "another job's token" : "the fleet token"}: ${m} ${p.replace(sb.id, ":id")} is refused`);
    assert.equal((await call("GET", "/octv-vw-nosuch", tokA)).status, 404, "unknown sandbox: 404");
    assert.deepEqual((await json(call("GET", `?prefix=${ws.workerPrefix()}`, tokB))).sandboxes, [], "another job lists none of it");
    assert.deepEqual((await json(call("GET", `?prefix=${ws.workerPrefix()}`, tokA))).sandboxes.map((x: any) => x.id), [sb.id], "its owner lists it");
    assert.equal(mockState.vsbSandboxes.has(sb.id), true, "nothing the others tried reached it");

    // ---- use it ----
    assert.equal((await json(call("GET", one, tokA))).state, "ready");
    mockState.vsbExec = ({ script }: { script: string }) => (script === "echo hi" ? { stdout: "hi\n", stderr: "warn\n", exitCode: 3 } : {});
    assert.deepEqual(await json(call("POST", `${one}/exec`, tokA, { command: "echo hi", timeout_sec: 30 })), { exitCode: 3, stdout: "hi\n", stderr: "warn\n" }, "sync exec: output and exit code");
    const streamed = (await (await call("POST", `${one}/exec`, tokA, { command: "echo hi", timeout_sec: 30, stream: true })).text()).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(streamed, [{ type: "started" }, { type: "stdout", data: "hi\n" }, { type: "stderr", data: "warn\n" }, { type: "exit", exitCode: 3 }], "streamed exec: the runner's frame shape");
    mockState.vsbExec = () => ({ stdout: "x".repeat(ws.MAX_OUTPUT + 1024) });
    const big = await json(call("POST", `${one}/exec`, tokA, { command: "big", timeout_sec: 30 }));
    assert.ok(big.truncated === true && big.stdout.length < ws.MAX_OUTPUT + 200 && /truncated by the sandbox broker/.test(big.stdout.slice(-80)), "buffered output is capped at 16 MiB, with a marker");
    mockState.vsbExec = () => ({ durationMs: 5000 });
    const cut = (await (await call("POST", `${one}/exec`, tokA, { command: "sleep", timeout_sec: 1, stream: true })).text()).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(cut.at(-1), { type: "exit", exitCode: null, cut: true }, "an exec past its time limit is cut (and killed), so one call stays under the function's 300 s");
    assert.ok([...mockState.vsbCmds.values()].some((c: any) => c.killed), "the cut command was killed at Vercel");
    // Longer than the broker's 2.5 s ?wait=true probe: running at first; then finished, though the plain GET (stale, as live) still says null.
    mockState.vsbExec = () => ({ durationMs: 4000, exitCode: 5 });
    const det = await json(call("POST", `${one}/commands`, tokA, { command: "sleep" }));
    assert.ok(det.command_id, "detached start: a command id");
    assert.deepEqual(await json(call("GET", `${one}/commands/${det.command_id}`, tokA)), { running: true, exit_code: null });
    await new Promise((r) => setTimeout(r, 400));
    await new Promise((r) => setTimeout(r, 2000));
    assert.deepEqual(await json(call("GET", `${one}/commands/${det.command_id}`, tokA)), { running: false, exit_code: 5 }, "a finished detached command reads as finished, with its exit code");
    assert.equal((await call("GET", `${one}/commands/${encodeURIComponent("../../x")}`, tokA)).status, 400, "a command id must be a plain id");
    mockState.vsbExec = null;
    assert.equal((await call("PUT", `${one}/files`, tokA, { path: "/tmp/octi/in-1.txt", content: "héllo\n" })).status, 200);
    assert.equal((await call("PUT", `${one}/files`, tokA, { path: "/tmp/octi/b.bin", content_base64: Buffer.from([0, 1, 2]).toString("base64") })).status, 200);
    const files = mockState.vsbFiles.get(sb.id);
    assert.equal(files.get("/tmp/octi/in-1.txt").toString(), "héllo\n", "files arrive byte for byte (fs/write tar.gz)");
    assert.deepEqual([...files.get("/tmp/octi/b.bin")], [0, 1, 2]);
    for (const p of ["relative", "/tmp/../etc/passwd"]) assert.equal((await call("PUT", `${one}/files`, tokA, { path: p, content: "x" })).status, 400, `bad path ${p}`);
    assert.equal((await call("POST", `${one}/network-policy`, tokA, { allow: ["octi.example", "registry.npmjs.org"] })).status, 200);
    assert.deepEqual(mockState.vsbPolicies.get(sb.id), { allow: ["octi.example", "registry.npmjs.org"], subnets: { deny: vs.DENY_SUBNETS } }, "the allow-list, private subnets denied");
    for (const bad of [[], ["1.2.3.4"], ["evil.com/path"], "x"]) assert.equal((await call("POST", `${one}/network-policy`, tokA, { allow: bad })).status, 400, `bad allow ${JSON.stringify(bad)}`);

    // ---- caps hold under concurrent creates: one sandbox exists, the session may have 2, three race for the last slot ----
    const race = await Promise.all([1, 2, 3].map(() => call("POST", "", tokA, { session_id: A!.id })));
    assert.deepEqual(race.map((r) => r.status).sort(), [201, 409, 409], "exactly one of three concurrent creates gets the session's last slot");

    // ---- fleet orchestrators: each capped by its own capacity, none starving another; a re-claimed session's old sandbox replaced ----
    process.env.OCTILLION_WORKER_SANDBOX_CAP_MARGIN = "0";
    assert.equal((await call("POST", "", workerToken, { session_id: B!.id }, ORCH1)).status, 409, "a fleet orchestrator that has not checked in cannot create");
    for (const id of [ORCH1, ORCH2]) await db.query("INSERT INTO orchestrators (id, capacity, meta) VALUES ($1, 1, '{}') ON CONFLICT (id) DO UPDATE SET capacity = 1, last_seen = now()", [id]);
    const f1 = await json(call("POST", "", workerToken, { session_id: B!.id }, ORCH1));
    assert.ok(f1.id, "orchestrator 1 creates for B");
    assert.equal((await call("POST", "", workerToken, { session_id: A!.id }, ORCH1)).status, 429, "and is then at its cap (capacity 1 + margin 0)");
    assert.equal((await call("GET", `/${f1.id}`, workerToken, undefined, ORCH2)).status, 403, "orchestrator 2 cannot use orchestrator 1's sandbox");
    assert.equal((await call("GET", `/${f1.id}`, tokB)).status, 403, "nor can B's job token");
    const f2 = await json(call("POST", "", workerToken, { session_id: B!.id }, ORCH2));
    assert.ok(f2.id, "orchestrator 2 has its own cap: B was re-claimed by it");
    const [r1] = await db.query<any>("SELECT deleted_at, delete_reason FROM worker_sandboxes WHERE sandbox_id = $1", [f1.id]);
    assert.ok(r1.deleted_at && /re-claimed/.test(r1.delete_reason) && !mockState.vsbSandboxes.has(f1.id), "orchestrator 1's sandbox for B was deleted when B was re-claimed");
    delete process.env.OCTILLION_WORKER_SANDBOX_CAP_MARGIN;

    // ---- admin diagnostics (src/sandbox-diagnostics.ts): fixed read-only scripts, admins only, secrets redacted ----
    const diag = await import("../src/sandbox-diagnostics.js");
    assert.equal(diag.redactSecrets("ANTHROPIC_API_KEY='sk-ant-api03-abcdefgh' Authorization: Bearer abcdefghijkl ogw_0123456789abc https://u:pw@h.example/x"),
      "ANTHROPIC_API_KEY=*** Authorization: Bearer *** ogw_*** https://u:***@h.example/x", "token-shaped values are redacted");
    let diagScript = "";
    mockState.vsbExec = ({ script }: { script: string }) => {
      diagScript = script;
      return { stdout: "== /tmp/.octi-x/setup.log\n== exit 1: bash /tmp/octi/prepare.sh\nsudo: a password is required\nOPENAI_API_KEY=sk-proj-secretsecret123 and ogw_leakedtoken123\n" };
    };
    const logs = await adm("GET", `/compute/sandbox-logs?session=${encodeURIComponent(A!.id)}&kb=9999`);
    const lj = await logs.json();
    assert.equal(logs.status, 200, JSON.stringify(lj));
    assert.ok(lj.kind === "session" && /sudo: a password is required/.test(lj.output) && !/secretsecret|leakedtoken/.test(lj.output) && lj.kb === 256,
      `the worker's setup log, redacted, kb clamped: ${JSON.stringify(lj).slice(0, 300)}`);
    assert.ok(/tail -c 262144 "\$f"/.test(diagScript) && /setup\.log/.test(diagScript), "the fixed worker script ran, with only the clamped byte count in it");
    assert.equal((await fetch(`${base}/api/admin/onboarding/compute/sandbox-logs?session=${A!.id}`)).status, 401, "admins only");
    assert.ok([401, 403].includes((await fetch(`${base}/api/admin/onboarding/compute/sandbox-logs?session=${A!.id}`, { headers: { authorization: `Bearer ${workerToken}` } })).status), "not with a worker token");
    assert.equal((await adm("GET", "/compute/sandbox-logs")).status, 400);
    assert.equal((await adm("GET", "/compute/sandbox-logs?session=nosuch")).status, 404);
    // An orchestrator on Vercel: its log; a row from before boat.dev's retirement is refused (nothing to read).
    const orchName = `${ws.workerPrefix().replace("-vw-", "-vo-")}diag`;
    await fetch(`${mockUrl}/vercel-sandbox/v2/sandboxes?teamId=team_smoke`, { method: "POST", headers: { authorization: "Bearer x", "content-type": "application/json" }, body: JSON.stringify({ name: orchName }) });
    const [vo] = await db.query<any>("INSERT INTO orchestrator_sandboxes (sandbox_id, orchestrator_id, state, provider) VALUES ($1, 'orch-diag-v', 'running', 'vercel') RETURNING id", [orchName]);
    const [bo] = await db.query<any>("INSERT INTO orchestrator_sandboxes (sandbox_id, orchestrator_id, state, provider) VALUES ('bx_diag', 'orch-diag-b', 'running', 'boat') RETURNING id");
    mockState.vsbExec = ({ script }: { script: string }) => { diagScript = script; return { stdout: "orchestrator started\nclaim failed: 401 Bearer owk_abcdefghijklmnop\n" }; };
    const ol = await adm("GET", `/compute/sandbox-logs?orchestrator=${vo.id}`);
    const olj = await ol.json();
    assert.ok(ol.status === 200 && olj.kind === "orchestrator" && /claim failed/.test(olj.output) && !/abcdefghijklmnop/.test(olj.output) && /\/var\/lib\/octi\/orchestrator\.log/.test(diagScript),
      `the orchestrator log, redacted: ${JSON.stringify(olj).slice(0, 300)}`);
    assert.equal((await adm("GET", `/compute/sandbox-logs?orchestrator=${bo.id}`)).status, 400, "old boat.dev orchestrators are not read here");
    await db.query("DELETE FROM orchestrator_sandboxes WHERE id = ANY($1)", [[vo.id, bo.id]]);
    mockState.vsbSandboxes.delete(orchName);
    mockState.vsbExec = null;

    // ---- delete ----
    assert.equal((await call("DELETE", one, tokA)).status, 204);
    assert.equal((await adm("GET", `/compute/sandbox-logs?session=${encodeURIComponent(A!.id)}`)).status, 200, "the session's other live sandbox (the race winner) is read");
    assert.ok(!mockState.vsbSandboxes.has(sb.id), "deleted at Vercel");
    assert.equal((await call("POST", `${one}/exec`, tokA, { command: "id" })).status, 410, "a deleted sandbox: 410");
    assert.equal((await call("DELETE", one, tokA)).status, 204, "delete is idempotent");
    assert.equal((await json(call("GET", one, tokA))).state, "gone");

    // ---- the reaper: deadline, session over, orchestrator gone; the stray sweep keeps to this environment's names ----
    await db.query("UPDATE worker_sandboxes SET created_at = created_at - interval '5 minutes' WHERE deleted_at IS NULL");
    await db.query("UPDATE agent_sessions SET status = 'completed' WHERE id = $1", [A!.id]);
    const outOfTime = await ws.reapWorkerSandboxes({ oidcToken: process.env.VERCEL_OIDC_TOKEN, deadline: Date.now() });
    assert.ok(outOfTime.stopped === "deadline" && outOfTime.reaped === 0, `out of time: stops cleanly, removes nothing: ${JSON.stringify(outOfTime)}`);
    await db.query("DELETE FROM orchestrators WHERE id = $1", [ORCH2]);
    const strayOwn = `${ws.workerPrefix()}straymine`, strayOther = ws.workerPrefix().replace("-vw-local-", "-vw-prod-") + "straytheirs";
    for (const n of [strayOwn, strayOther]) {
      await fetch(`${mockUrl}/vercel-sandbox/v2/sandboxes?teamId=team_smoke`, { method: "POST", headers: { authorization: "Bearer x", "content-type": "application/json" }, body: JSON.stringify({ name: n }) });
      mockState.vsbSandboxes.get(n).createdAt = Date.now() - 3600_000;
    }
    const reaped = await ws.reapWorkerSandboxes({ oidcToken: process.env.VERCEL_OIDC_TOKEN });
    const reasons = Object.fromEntries((await db.query<any>("SELECT sandbox_id, delete_reason FROM worker_sandboxes WHERE delete_reason LIKE 'reaped%'")).map((x) => [x.sandbox_id, x.delete_reason]));
    assert.ok(reaped.reaped === 2 && !reaped.errors.length && !reaped.stopped, `the reaper deleted A's leftover and orchestrator 2's: ${JSON.stringify(reaped)} ${JSON.stringify(reasons)}`);
    assert.equal(reasons[f2.id], "reaped: orchestrator gone", "a fleet orchestrator that stopped checking in leaves its sandboxes to the reaper");
    assert.ok(Object.values(reasons).includes("reaped: session completed"));
    assert.ok(reaped.strays === 1 && !mockState.vsbSandboxes.has(strayOwn) && mockState.vsbSandboxes.has(strayOther), "the stray sweep deletes this environment's strays, never another's");
    mockState.vsbSandboxes.delete(strayOther);
    console.log("✓ worker sandbox broker: own job / own orchestrator only (403 on every route, ogw_ 401), exec/stream/cut/capped/detached/files/policy, race-safe caps, per-orchestrator fleet caps, re-claim, delete, reaper and stray sweep");
  } finally {
    for (const r of before) await db.query("UPDATE agent_sessions SET status = $2 WHERE id = $1", [r.id, r.status]);
    await db.query("UPDATE worker_tokens SET revoked_at = now() WHERE job_id = ANY($1)", [[A!.simulation_id, B!.simulation_id]]);
    await db.query("DELETE FROM orchestrators WHERE id = ANY($1)", [[ORCH1, ORCH2]]);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    mockState.vsbExec = null;
  }
}
