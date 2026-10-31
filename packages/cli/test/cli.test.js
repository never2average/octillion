// Unit tests for the octillion CLI with a fake Octillion server and a fake authorization server (device grant):
//   npm test   (node --test test/cli.test.js; no dependencies; Node 20+)
// The end-to-end run against the real server and the mock Clerk is scripts/smoke-agent-auth-p1.ts.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { main, parseArgs, pickSnippet, builtinConnect, rpcMessage, isAgent } from "../src/cli.js";

/** A fake Octillion + AS on one port. `opts.clientId` null = device login not configured. */
async function fakeServer(opts = {}) {
  const state = { approved: false, denied: false, polls: 0, refreshes: 0, lastAuth: null, lastOrg: null };
  const srv = createServer(async (req, res) => {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const body = Buffer.concat(chunks).toString();
    const base = `http://127.0.0.1:${srv.address().port}`;
    const json = (status, o) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    const f = new URLSearchParams(body);
    if (req.url === "/api/cli/config") return json(200, { client_id: opts.clientId ?? null, issuer: base, resource: `${base}/mcp`, scope: "profile email", device_login: Boolean(opts.clientId) });
    if (req.url === "/.well-known/oauth-authorization-server") return json(200, { issuer: base, token_endpoint: `${base}/token`, ...(opts.noDevice ? {} : { device_authorization_endpoint: `${base}/device` }) });
    if (req.url === "/device") return json(200, { device_code: "dc1", user_code: "ABCD-EFGH", verification_uri: `${base}/activate`, verification_uri_complete: `${base}/activate?code=ABCD-EFGH`, expires_in: 600, interval: 1 });
    if (req.url === "/token") {
      if (f.get("grant_type") === "refresh_token") { state.refreshes++; return json(200, { access_token: `at_refreshed_${state.refreshes}`, expires_in: 3600, refresh_token: "rt1" }); }
      state.polls++;
      if (state.denied) return json(400, { error: "access_denied" });
      if (!state.approved) return json(400, { error: "authorization_pending" });
      return json(200, { access_token: "at_device", expires_in: 3600, refresh_token: "rt1", token_type: "Bearer" });
    }
    if (req.url === "/mcp") {
      state.lastAuth = req.headers.authorization; state.lastOrg = req.headers["x-octillion-org"] ?? null;
      if (req.headers.authorization === "Bearer bad") return json(401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "This API key is not valid.", data: { reason: "key_unknown" } } });
      const id = JSON.parse(body).id;
      res.writeHead(200, { "content-type": "text/event-stream" });
      return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "ok" }], structuredContent: {
        person: { email: "kim@example.com" }, org: { slug: "acme", name: "Acme" }, org_source: "default", role: "owner", credential: { type: "oauth", access: "full" } } } })}\n\n`);
    }
    json(404, { error: "not found" });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}`, state, close: () => new Promise((r) => srv.close(r)) };
}

/** Run main() with captured output; returns { code, out, err, json }. */
async function run(argv, env) {
  let out = "", err = "";
  const code = await main(argv, { env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
  let json = null;
  try { json = JSON.parse(out); } catch { /* text */ }
  return { code, out, err, json };
}

test("parseArgs: flags, values, unknowns", () => {
  assert.deepEqual(parseArgs(["whoami", "--json", "--org=acme"]), { _: ["whoami"], flags: { json: true, org: "acme" } });
  assert.deepEqual(parseArgs(["login", "--complete", "abc123"]).flags, { complete: "abc123" });
  assert.throws(() => parseArgs(["--nope"]), /Unknown option --nope/);
  assert.throws(() => parseArgs(["--token"]), /needs a value/);
});

test("rpcMessage reads JSON and SSE", () => {
  assert.deepEqual(rpcMessage("application/json", '{"result":1}'), { result: 1 });
  assert.deepEqual(rpcMessage("text/event-stream", 'event: message\ndata: {"jsonrpc":"2.0","result":{"a":1}}\n\n'), { jsonrpc: "2.0", result: { a: 1 } });
});

test("agent detection", () => {
  assert.equal(isAgent({ CLAUDECODE: "1" }), true);
  assert.equal(isAgent({ CODEX_SANDBOX: "seatbelt" }), true);
  assert.equal(isAgent({ AI_AGENT: "0" }), false);
  assert.equal(isAgent({}), false);
});

test("mcp-config snippets: sign-in has no secret, key mode reads OCTILLION_API_KEY", () => {
  const cat = builtinConnect("https://o.example/mcp");
  assert.equal(pickSnippet(cat, "claude-code", "signin").then, "claude mcp login octillion");
  assert.match(pickSnippet(cat, "codex", "key").snippet, /bearer_token_env_var = "OCTILLION_API_KEY"/);
  assert.match(pickSnippet(cat, "vscode", "key").snippet, /\$\{input:octillion-api-key\}/);
  assert.match(pickSnippet(cat, "cursor", "signin").install_url, /^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=octillion&config=/);
  assert.deepEqual(JSON.parse(pickSnippet(cat, "json", "signin").snippet), { mcpServers: { octillion: { type: "http", url: "https://o.example/mcp" } } });
});

test("no server set, https required", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "oct-cli-"));
  assert.equal((await run(["whoami"], { OCTILLION_CONFIG_DIR: dir })).code, 1);
  const r = await run(["whoami", "--json"], { OCTILLION_CONFIG_DIR: dir, OCTILLION_URL: "http://example.com" });
  assert.equal(r.json.error, "bad_url");
});

test("device login not configured: exit 1 and points to API keys", async () => {
  const s = await fakeServer({ clientId: null });
  try {
    const dir = await mkdtemp(path.join(tmpdir(), "oct-cli-"));
    const r = await run(["login", "--json"], { OCTILLION_CONFIG_DIR: dir, OCTILLION_URL: s.url });
    assert.equal(r.code, 1);
    assert.equal(r.json.error, "device_login_disabled");
    assert.match(r.json.message, /app\/settings\/api-keys/);
    const noDev = await fakeServer({ clientId: "c1", noDevice: true });
    try { assert.equal((await run(["login", "--json"], { OCTILLION_CONFIG_DIR: dir, OCTILLION_URL: noDev.url })).json.error, "device_login_disabled"); } finally { await noDev.close(); }
  } finally { await s.close(); }
});

test("non-interactive login, --complete, stored credentials, refresh, precedence, logout", async () => {
  const s = await fakeServer({ clientId: "cli_public" });
  try {
    const dir = await mkdtemp(path.join(tmpdir(), "oct-cli-"));
    const env = { OCTILLION_CONFIG_DIR: dir, OCTILLION_URL: s.url, AI_AGENT: "test" };
    const start = await run(["login"], env);
    assert.equal(start.code, 0);
    assert.equal(start.json.user_code, "ABCD-EFGH");
    assert.equal(start.json.expires_in, 600);
    assert.match(start.json.verification_uri_complete, /activate\?code=ABCD-EFGH$/);
    assert.match(start.json.next_step, /^octillion login --complete [a-f0-9]{12}$/);
    const handle = start.json.next_step.split(" ").pop();
    const pending = await run(["login", "--complete", handle, "--timeout", "1", "--json"], env);
    assert.equal(pending.code, 2);
    assert.equal(pending.json.error, "authorization_pending");
    s.state.approved = true;
    const done = await run(["login", "--complete", handle, "--json"], env);
    assert.equal(done.code, 0, done.out + done.err);
    const file = path.join(dir, "credentials.json");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const saved = JSON.parse(await readFile(file, "utf8")).profiles[s.url];
    assert.equal(saved.access_token, "at_device");
    assert.equal(saved.refresh_token, "rt1");
    // Precedence.
    assert.equal((await run(["token"], env)).out, "at_device\n");
    assert.equal((await run(["token"], { ...env, OCTILLION_API_KEY: "oct_env" })).out, "oct_env\n");
    assert.equal((await run(["token", "--token", "flagtok"], { ...env, OCTILLION_API_KEY: "oct_env" })).out, "flagtok\n");
    const w = await run(["whoami", "--json", "--org", "acme"], env);
    assert.equal(w.json.source, "login");
    assert.equal(w.json.org.slug, "acme");
    assert.equal(s.state.lastAuth, "Bearer at_device");
    assert.equal(s.state.lastOrg, "acme");
    const bad = await run(["whoami", "--json", "--token", "bad"], env);
    assert.equal(bad.code, 2);
    assert.equal(bad.json.source, "flag");
    assert.match(bad.json.message, /credential: --token/);
    // Refresh when expired.
    const all = JSON.parse(await readFile(file, "utf8"));
    all.profiles[s.url].expires_at = new Date(Date.now() - 1000).toISOString();
    await (await import("node:fs/promises")).writeFile(file, JSON.stringify(all));
    assert.equal((await run(["token"], env)).out, "at_refreshed_1\n");
    // Logout.
    assert.equal((await run(["logout", "--json"], env)).json.status, "signed_out");
    assert.equal((await run(["token", "--json"], env)).code, 2);
  } finally { await s.close(); }
});

test("declined login is an error", async () => {
  const s = await fakeServer({ clientId: "cli_public" });
  try {
    const dir = await mkdtemp(path.join(tmpdir(), "oct-cli-"));
    const env = { OCTILLION_CONFIG_DIR: dir, OCTILLION_URL: s.url };
    const start = await run(["login", "--non-interactive"], env);
    s.state.denied = true;
    const r = await run(["login", "--complete", start.json.next_step.split(" ").pop(), "--json"], env);
    assert.equal(r.code, 1);
    assert.equal(r.json.error, "access_denied");
  } finally { await s.close(); }
});
