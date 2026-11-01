// Worker sandbox broker checks for scripts/smoke.ts (src/worker-sandboxes.ts), against the mock Vercel Sandbox in
// scripts/lib/mock-providers.ts, through the real server: not configured without a Vercel token; a job token creates only
// for its own running session; nobody else (another job's token, the fleet token) can see, run in, write to, lock down or
// delete that sandbox (403), unknown ids are 404 and deleted ones 410; exec (sync and streamed), detached commands, files
// (tar.gz), network policy, list, the per-session cap, delete, and the reaper.
import assert from "node:assert/strict";

type Db = { query: <T = any>(sql: string, params?: unknown[]) => Promise<T[]> };

export async function workerSandboxChecks({ db, base, mockUrl, mockState, workerToken }: { db: Db; base: string; mockUrl: string; mockState: any; workerToken: string }) {
  const wa = await import("../src/workerauth.js");
  const ws = await import("../src/worker-sandboxes.js");
  const vs = await import("../src/vercel-sandbox.js");
  const saved = Object.fromEntries(["VERCEL_OIDC_TOKEN", "OCTILLION_VERCEL_SANDBOX_TOKEN", "OCTILLION_VERCEL_SANDBOX_API_URL"].map((k) => [k, process.env[k]]));
  for (const k of Object.keys(saved)) delete process.env[k];
  const call = (method: string, path: string, token: string, body?: unknown) => fetch(`${base}/api/worker/sandboxes${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const json = async (r: Response | Promise<Response>) => (await r).json();

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

    // ---- create: own running session only ----
    assert.equal((await call("POST", "", tokA, { session_id: B!.id })).status, 403, "a job token cannot create for another job's session");
    assert.equal((await call("POST", "", tokA, {})).status, 400);
    await db.query("UPDATE agent_sessions SET status = 'completed' WHERE id = $1", [A!.id]);
    assert.equal((await call("POST", "", tokA, { session_id: A!.id })).status, 409, "not for a session that is not running");
    await db.query("UPDATE agent_sessions SET status = 'running' WHERE id = $1", [A!.id]);
    const made = await call("POST", "", tokA, { session_id: A!.id, size: "small", timeout_sec: 3600, name: "octi-w-orch-1-claude-code-sonnet" });
    assert.equal(made.status, 201);
    const sb = await made.json();
    assert.ok(sb.id.startsWith(ws.VERCEL_WORKER_PREFIX) && sb.vcpus === 1 && sb.memory_mb === 2048 && sb.timeout_sec === 3600, `created: ${JSON.stringify(sb)}`);
    const vx = mockState.vsbSandboxes.get(sb.id);
    assert.ok(vx && vx.vcpus === 1 && vx.memory === 2048 && vx.timeout === 3600_000 && vx.persistent === false && vx.region === "iad1", "made at Vercel as asked: 1 vCPU / 2 GB, 1 h, not persistent, iad1");
    const [row] = await db.query<any>("SELECT * FROM worker_sandboxes WHERE sandbox_id = $1", [sb.id]);
    assert.ok(row.owner === `job:${A!.simulation_id}` && row.session_id === A!.id && row.job_id === A!.simulation_id && row.vm_session, "the ownership row");

    // ---- ownership: another job's token and the fleet token get 403 on every route; unknown ids 404 ----
    const one = `/${encodeURIComponent(sb.id)}`;
    const routes: [string, string, unknown?][] = [["GET", one], ["POST", `${one}/exec`, { command: "id" }], ["POST", `${one}/commands`, { command: "id" }],
      ["GET", `${one}/commands/cmd_x`], ["PUT", `${one}/files`, { path: "/tmp/x", content: "x" }], ["POST", `${one}/network-policy`, { allow: ["example.com"] }], ["DELETE", one]];
    for (const tok of [tokB, workerToken]) for (const [m, p, body] of routes)
      assert.equal((await call(m, p, tok, body)).status, 403, `${tok === tokB ? "another job's token" : "the fleet token"}: ${m} ${p.replace(sb.id, ":id")} is refused`);
    assert.equal((await call("GET", "/octv-vw-nosuch", tokA)).status, 404, "unknown sandbox: 404");
    assert.deepEqual((await json(call("GET", `?prefix=${ws.VERCEL_WORKER_PREFIX}`, tokB))).sandboxes, [], "another job lists none of it");
    assert.deepEqual((await json(call("GET", `?prefix=${ws.VERCEL_WORKER_PREFIX}`, tokA))).sandboxes.map((x: any) => x.id), [sb.id], "its owner lists it");
    assert.equal(mockState.vsbSandboxes.has(sb.id), true, "nothing the others tried reached it");

    // ---- use it ----
    assert.equal((await json(call("GET", one, tokA))).state, "ready");
    mockState.vsbExec = ({ script }: { script: string }) => (script === "echo hi" ? { stdout: "hi\n", stderr: "warn\n", exitCode: 3 } : script === "sleep" ? { durationMs: 400 } : {});
    assert.deepEqual(await json(call("POST", `${one}/exec`, tokA, { command: "echo hi", timeout_sec: 30 })), { exitCode: 3, stdout: "hi\n", stderr: "warn\n" }, "sync exec: output and exit code");
    const streamed = (await (await call("POST", `${one}/exec`, tokA, { command: "echo hi", timeout_sec: 30, stream: true })).text()).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(streamed, [{ type: "started" }, { type: "stdout", data: "hi\n" }, { type: "stderr", data: "warn\n" }, { type: "exit", exitCode: 3 }], "streamed exec: boat's frame shape");
    mockState.vsbExec = () => ({ durationMs: 5000 });
    const cut = (await (await call("POST", `${one}/exec`, tokA, { command: "sleep", timeout_sec: 1, stream: true })).text()).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(cut.at(-1), { type: "exit", exitCode: null, cut: true }, "an exec past its time limit is cut (and killed), so one call stays under the function's 300 s");
    assert.ok([...mockState.vsbCmds.values()].some((c: any) => c.killed), "the cut command was killed at Vercel");
    mockState.vsbExec = () => ({ durationMs: 300 });
    const det = await json(call("POST", `${one}/commands`, tokA, { command: "sleep" }));
    assert.ok(det.command_id, "detached start: a command id");
    assert.deepEqual(await json(call("GET", `${one}/commands/${det.command_id}`, tokA)), { running: true, exit_code: null });
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(await json(call("GET", `${one}/commands/${det.command_id}`, tokA)), { running: false, exit_code: 0 });
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

    // ---- caps, delete ----
    assert.equal((await call("POST", "", tokA, { session_id: A!.id })).status, 201, "a second sandbox for the session (a retried open)");
    assert.equal((await call("POST", "", tokA, { session_id: A!.id })).status, 409, "but not a third");
    assert.equal((await call("DELETE", one, tokA)).status, 204);
    assert.ok(!mockState.vsbSandboxes.has(sb.id), "deleted at Vercel");
    assert.equal((await call("POST", `${one}/exec`, tokA, { command: "id" })).status, 410, "a deleted sandbox: 410");
    assert.equal((await call("DELETE", one, tokA)).status, 204, "delete is idempotent");
    assert.equal((await json(call("GET", one, tokA))).state, "gone");

    // ---- the reaper: a sandbox whose session ended is deleted; others are left alone ----
    const fleetMade = await json(call("POST", "", workerToken, { session_id: B!.id }));
    assert.ok(fleetMade.id, "the fleet token creates for any running session");
    assert.equal((await call("GET", `/${fleetMade.id}`, tokB)).status, 403, "and B's job token cannot use the fleet's sandbox");
    await db.query("UPDATE worker_sandboxes SET created_at = created_at - interval '5 minutes' WHERE deleted_at IS NULL");
    await db.query("UPDATE agent_sessions SET status = 'completed' WHERE id = $1", [A!.id]);
    const reaped = await ws.reapWorkerSandboxes({ oidcToken: process.env.VERCEL_OIDC_TOKEN });
    assert.ok(reaped.reaped === 1 && !reaped.errors.length, `the reaper deleted A's leftover sandbox: ${JSON.stringify(reaped)}`);
    assert.ok(mockState.vsbSandboxes.has(fleetMade.id), "and left B's running session's sandbox alone");
    const [left] = await db.query<any>("SELECT delete_reason FROM worker_sandboxes WHERE session_id = $1 AND delete_reason LIKE 'reaped%'", [A!.id]);
    assert.equal(left?.delete_reason, "reaped: session completed");
    assert.equal((await call("DELETE", `/${fleetMade.id}`, workerToken)).status, 204);
    console.log("✓ worker sandbox broker: own job's running sessions only, 403 for any other token on every route, exec/stream/cut/detached/files/policy, caps, delete, reaper");
  } finally {
    for (const r of before) await db.query("UPDATE agent_sessions SET status = $2 WHERE id = $1", [r.id, r.status]);
    await db.query("UPDATE worker_tokens SET revoked_at = now() WHERE job_id = ANY($1)", [[A!.simulation_id, B!.simulation_id]]);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    mockState.vsbExec = null;
  }
}
