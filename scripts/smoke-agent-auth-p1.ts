// Agent auth (P1 + P2): the OAuth org claim (user:org:read) and Octillion's own scopes on /mcp, the scope challenge,
// the octillion CLI (packages/cli) against this server and the mock Clerk's device grant, the agent docs (/llms.txt,
// /get-started.md, /docs/<slug>.md) and the one-command connect catalog. Run from scripts/smoke.ts inside the Clerk
// section, right after the P0 checks. First, proof that a token with no org claim and no Octillion scope is unchanged.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Db } from "../src/db.js";

interface Ctx {
  base: string; db: Db; mockUrl: string; stamp: string;
  mockPost: (path: string, body?: unknown) => Promise<any>;
  clerkSession: (userId: string, orgId?: string | null, role?: string) => Promise<string>;
  token: (claims: { user_id: string; jwt?: boolean; org_id?: string; scopes?: string[] }) => Promise<string>;
  appCall: (session: string, method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;
}

const INIT = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent-auth-p1", version: "1" } } });
const CLI = path.resolve(import.meta.dirname, "../packages/cli/bin/octillion.js");

export async function agentAuthP1Checks(c: Ctx) {
  const { base, db, mockPost, clerkSession, token, appCall, stamp } = c;
  const clerkApi = (p: string, body: unknown) => fetch(`${c.mockUrl}/v1${p}`, { method: "POST", headers: { authorization: "Bearer sk_test_mock", "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const raw = (headers: Record<string, string>) => fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: INIT });
  const tool = async (headers: Record<string, string>, name: string, args: Record<string, unknown> = {}) => {
    const cl = new Client({ name: "agent-auth-p1", version: "1.0.0" });
    await cl.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
    try { return await cl.callTool({ name, arguments: args }); } finally { await cl.close(); }
  };
  const who = async (headers: Record<string, string>) => {
    const r = await tool(headers, "whoami");
    assert.ok(!r.isError, `whoami: ${JSON.stringify(r.content)}`);
    return { data: r.structuredContent as any, text: (r.content as any)[0].text as string };
  };
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const memo = (i: string) => ({ body: `Agent auth P1 smoke ${stamp}: ${i}.` });

  // Kim: a member of P (oldest) and Q; R is an account Kim is not in.
  const orgP = await clerkApi("/organizations", { name: `P1 Auth P ${stamp}` });
  const kim = await mockPost("/_mock/clerk/users", { email: `kim+${stamp}@p1-auth.dev` });
  const ray = await mockPost("/_mock/clerk/users", { email: `ray+${stamp}@p1-auth.dev` });
  await mockPost("/_mock/clerk/memberships", { org_id: orgP.id, user_id: kim.id, role: "org:admin" });
  await new Promise((r) => setTimeout(r, 5));
  const orgQ = await clerkApi("/organizations", { name: `P1 Auth Q ${stamp}` });
  await mockPost("/_mock/clerk/memberships", { org_id: orgQ.id, user_id: kim.id, role: "org:member" });
  const orgR = await clerkApi("/organizations", { name: `P1 Auth R ${stamp}` });
  await mockPost("/_mock/clerk/memberships", { org_id: orgR.id, user_id: ray.id, role: "org:admin" });
  // Linked on first use (self-serve), through the portal.
  for (const [u, o] of [[kim.id, orgP.id], [kim.id, orgQ.id], [ray.id, orgR.id]]) assert.equal((await appCall(await clerkSession(u, o, "admin"), "GET", "/me")).status, 200);
  const slugOf = async (clerkOrg: string) => (await db.query<{ slug: string; id: number }>("SELECT slug, id FROM organizations WHERE clerk_org_id = $1", [clerkOrg]))[0];
  const P = await slugOf(orgP.id), Q = await slugOf(orgQ.id), R = await slugOf(orgR.id);

  // ---------- nothing broken: no org claim, no Octillion scope ----------
  for (const jwt of [false, true]) {
    const t = await token({ user_id: kim.id, jwt });
    const w = await who(bearer(t));
    assert.equal(w.data.org.slug, P.slug, `${jwt ? "JWT" : "opaque"}: the default is still the oldest membership`);
    assert.equal(w.data.org_source, "default");
    assert.deepEqual(w.data.credential.scopes, ["profile", "email"]);
    assert.equal(w.data.credential.access, "full", "no octillion scope = full access");
    assert.match(w.text, /\(your default: oldest membership\)/);
    assert.ok(!(await tool(bearer(t), "save_to_memory", memo(`full ${jwt}`))).isError, "and still calls write tools");
  }
  console.log("✓ agent auth P1, nothing broken: an OAuth token with no org claim and no octillion scope keeps the oldest membership and full access (opaque and JWT)");

  // ---------- the org claim ----------
  for (const jwt of [false, true]) {
    const w = await who(bearer(await token({ user_id: kim.id, jwt, org_id: orgQ.id })));
    assert.ok(w.data.org.slug === Q.slug && w.data.org_source === "token" && w.data.role === "member", `${jwt ? "JWT" : "opaque"}: the token's org claim picks the account`);
    assert.match(w.text, /\(picked at sign-in\)/);
    const notMine = await raw(bearer(await token({ user_id: kim.id, jwt, org_id: orgR.id })));
    assert.equal(notMine.status, 403, "an org claim for an account the person is not in is a 403");
    assert.equal(notMine.headers.get("www-authenticate"), null, "with no sign-in challenge");
    const nb = await notMine.json();
    assert.ok(nb.error.data.reason === "not_member" && /picked an organization you are not a member of/.test(nb.error.message), nb.error.message);
  }
  const claimQ = await token({ user_id: kim.id, org_id: orgQ.id });
  const hdr = await who({ ...bearer(claimQ), "x-octillion-org": P.slug });
  assert.ok(hdr.data.org.slug === P.slug && hdr.data.org_source === "header", "X-Octillion-Org still wins over the token's claim");
  assert.match(hdr.text, /picked by the X-Octillion-Org header/);
  // A claim naming the account by id is cached per claim: the default stays the default on the next token.
  assert.equal((await who(bearer(await token({ user_id: kim.id })))).data.org.slug, P.slug, "a claimless token after a claimed one still gets the default");
  console.log("✓ OAuth org claim (org_id): picks that account (opaque and JWT), 403 not_member for an account the person is not in, X-Octillion-Org still wins, whoami says what picked it");

  // ---------- Octillion's scopes ----------
  const readOnly = await token({ user_id: kim.id, scopes: ["profile", "email", "octillion:read"] });
  const wr = await who(bearer(readOnly));
  assert.equal(wr.data.credential.access, "read");
  assert.match(wr.text, /signed in with OAuth.*read-only/);
  assert.ok(!(await tool(bearer(readOnly), "list_products")).isError, "a read-only sign-in reads");
  const refused = await tool(bearer(readOnly), "save_to_memory", memo("read-only"));
  assert.ok(refused.isError, "a read-only sign-in is refused write tools");
  assert.match((refused.content as any)[0].text, /read-only \(scope octillion:read\).*Re-authorize with write access \(scope octillion:write\).*claude mcp login octillion/s);
  const hint = (refused._meta as any)?.["octillion/insufficient_scope"];
  assert.ok(hint && hint.error === "insufficient_scope" && hint.scope === "octillion:read octillion:write" && hint.resource_metadata === `${base}/.well-known/oauth-protected-resource`, `step-up hint: ${JSON.stringify(refused._meta)}`);
  const jwtRead = await token({ user_id: kim.id, jwt: true, scopes: ["octillion:read"] });
  assert.ok((await tool(bearer(jwtRead), "save_to_memory", memo("jwt read"))).isError, "the same for a JWT");
  for (const scopes of [["profile", "email", "octillion:read", "octillion:write"], ["octillion:write"]]) {
    const t = await token({ user_id: kim.id, scopes });
    assert.equal((await who(bearer(t))).data.credential.access, "full");
    assert.ok(!(await tool(bearer(t), "save_to_memory", memo(scopes.join("+")))).isError, `${scopes.join(" ")}: full access`);
  }
  console.log("✓ OAuth scopes: octillion:read alone = read tools only (isError with how to re-authorize, and an insufficient_scope hint in _meta), octillion:write or both = full");

  // ---------- the advertised scopes (OCTILLION_OAUTH_SCOPES) ----------
  const prm = async () => (await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()).scopes_supported;
  const challenge = async () => { const r = await raw({}); await r.text(); return r.headers.get("www-authenticate") ?? ""; };
  const was = process.env.OCTILLION_OAUTH_SCOPES;
  try {
    delete process.env.OCTILLION_OAUTH_SCOPES;
    assert.deepEqual(await prm(), ["profile", "email"], "off by default: the metadata advertises what it did before");
    assert.ok(!/scope="/.test(await challenge()), "and the 401 names no scope");
    process.env.OCTILLION_OAUTH_SCOPES = "on";
    assert.deepEqual(await prm(), ["profile", "email", "octillion:read", "octillion:write"], "on: Octillion's scopes are advertised");
    assert.ok(!(await prm()).includes("offline_access"), "never offline_access");
    const ch = await challenge();
    assert.match(ch, /resource_metadata="[^"]+", scope="profile email octillion:read octillion:write"/, `the 401 names the scopes: ${ch}`);
    const bad = await raw(bearer(`oat_${"0".repeat(36)}`));
    assert.match(bad.headers.get("www-authenticate") ?? "", /scope="[^"]+", error="invalid_token"/);
    assert.equal((await (await fetch(`${base}/api/cli/config`)).json()).scope, "profile email octillion:read octillion:write", "the CLI asks for them too");
  } finally {
    if (was === undefined) delete process.env.OCTILLION_OAUTH_SCOPES; else process.env.OCTILLION_OAUTH_SCOPES = was;
  }
  console.log("✓ scope advertising: protected resource metadata and the 401's scope= list octillion:read/write only with OCTILLION_OAUTH_SCOPES=on (never offline_access)");

  // ---------- agent docs ----------
  const get = async (p: string) => { const r = await fetch(`${base}${p}`); return { status: r.status, type: r.headers.get("content-type") ?? "", body: await r.text() }; };
  const llms = await get("/llms.txt");
  assert.ok(llms.status === 200 && llms.type.startsWith("text/plain"), "/llms.txt is served as text");
  assert.ok(llms.body.startsWith("# Octillion\n\n> ") && llms.body.includes("## How agents should use Octillion") && llms.body.includes(`${base}/mcp`) && llms.body.includes("OCTILLION_API_KEY"), "llms.txt: title, summary, how to connect");
  assert.ok(llms.body.includes(`${base}/get-started.md`) && llms.body.includes(`${base}/docs/mcp-tools.md`), "and links the .md docs with PUBLIC_URL");
  const links = [...llms.body.matchAll(/\]\(([^)]+\.md)\)/g)].map((m) => m[1]);
  assert.ok(links.length >= 8 && links.every((l) => l.startsWith(`${base}/`)), "every link is absolute on PUBLIC_URL");
  for (const l of links) {
    const page = await get(l.slice(base.length));
    assert.ok(page.status === 200 && page.type.startsWith("text/markdown") && page.body.startsWith("# "), `${l} renders as markdown`);
    assert.ok(!/\]\(\//.test(page.body), `${l}: no site-relative links left`);
  }
  const tools = await get("/docs/mcp-tools.md");
  assert.ok(tools.body.includes("`run_simulation`") && tools.body.includes(`${base}/app/docs/mcp-tools`), "the tools page lists the tools and links its web version");
  assert.equal((await get("/docs/no-such-page.md")).status, 404, "an unknown page is a 404");
  assert.ok(!(await get("/docs/accounts.md")).body.includes("Clerk dashboard"), "internal docs are never served");
  const gs = await get("/get-started.md");
  assert.ok(gs.status === 200 && gs.type.startsWith("text/markdown") && gs.body.includes("**PAUSE**") && gs.body.includes(`${base}/app/settings/api-keys`) && gs.body.includes("claude mcp login octillion"), "the agent playbook");
  console.log("✓ agent docs: /llms.txt, /get-started.md and every /docs/<slug>.md render with PUBLIC_URL (absolute links), unknown 404, no internal docs");

  // ---------- one-command connect ----------
  const connect = await (await fetch(`${base}/api/connect`)).json();
  const one = (id: string) => connect.one_command.find((x: any) => x.id === id);
  assert.equal(one("add-mcp").command, `npx add-mcp ${base}/mcp --name octillion`);
  assert.ok(one("claude-code").then === "claude mcp login octillion" && one("codex").command === `codex mcp add octillion --url ${base}/mcp` && one("codex").then === "codex mcp login octillion");
  const cfg = JSON.parse(Buffer.from(decodeURIComponent(one("cursor").install_url.split("config=")[1]), "base64").toString());
  assert.deepEqual(cfg, { url: `${base}/mcp` }, "the Cursor link carries {url}");
  assert.deepEqual(JSON.parse(decodeURIComponent(one("vscode").install_url.replace(/^vscode:mcp\/install\?/, ""))), { name: "octillion", type: "http", url: `${base}/mcp` }, "the VS Code link carries name, type, url");
  assert.ok(connect.one_command.every((x: any) => x.verified && x.source?.startsWith("https://")), "each says where it was checked");
  assert.ok(!JSON.stringify(connect).includes("oct_"), "no key anywhere");
  const vs = connect.clients.find((x: any) => x.id === "vscode");
  assert.ok(vs.install_url.startsWith("vscode:mcp/install?") && connect.clients.find((x: any) => x.id === "claude-code").then === "claude mcp login octillion", "the setup page's catalog has them too");
  console.log("✓ one-command connect: npx add-mcp, claude mcp add + login, codex mcp add + login, Cursor and VS Code install links (each with its doc)");

  await cliChecks(c, { kim, orgQ, P, Q });
  await db.query("DELETE FROM organizations WHERE id = ANY($1)", [[P.id, Q.id, R.id]]);
}

/** The octillion CLI, as a child process (async: it calls this process's server), with a clean environment. */
async function cliChecks(c: Ctx, f: { kim: any; orgQ: any; P: { id: number; slug: string }; Q: { id: number; slug: string } }) {
  const { base, mockPost, token } = c;
  const home = await mkdtemp(path.join(tmpdir(), "octillion-cli-"));
  const cfgDir = path.join(home, "config");
  const env0 = { PATH: process.env.PATH ?? "", HOME: home, OCTILLION_URL: base, OCTILLION_CONFIG_DIR: cfgDir };
  const run = (args: string[], env: Record<string, string> = {}) => new Promise<{ code: number; out: string; err: string; json: any }>((resolve) => {
    execFile(process.execPath, ["--no-experimental-require-module", CLI, ...args], { env: { ...env0, ...env }, timeout: 30_000 }, (error, out, err) => {
      let json: any = null;
      try { json = JSON.parse(out); } catch { /* text output */ }
      resolve({ code: error ? Number((error as any).code ?? 1) : 0, out, err, json });
    });
  });

  const help = await run(["--help"]);
  assert.ok(help.code === 0 && help.out.includes("octillion login") && help.err === "", "loads with --no-experimental-require-module and prints help");

  // mcp-config: from the server's catalog; sign-in by default, the OCTILLION_API_KEY variant with a key in play.
  const cc = await run(["mcp-config", "claude-code", "--json"]);
  assert.ok(cc.code === 0 && cc.json.from === "server" && cc.json.mode === "signin", `mcp-config: ${cc.out}${cc.err}`);
  assert.equal(cc.json.command, `claude mcp add --transport http octillion ${base}/mcp`);
  assert.equal(cc.json.then, "claude mcp login octillion");
  const cur = await run(["mcp-config", "cursor", "--api-key"]);
  assert.ok(cur.code === 0 && cur.out.includes("Bearer ${env:OCTILLION_API_KEY}") && !cur.out.includes("oct_"), "a key variant reads the variable");
  for (const client of ["codex", "vscode", "json"]) assert.equal((await run(["mcp-config", client, "--json"])).json.client, client);
  assert.equal((await run(["mcp-config", "emacs"])).code, 1, "an unknown client is an error");
  const off = await run(["mcp-config", "claude-code", "--json", "--url", "http://127.0.0.1:9"]);
  assert.ok(off.code === 0 && off.json.from === "built-in" && off.json.command === "claude mcp add --transport http octillion http://127.0.0.1:9/mcp", "built in when the server has no catalog");

  // Nothing to sign in with: exit 2 and the next step.
  const none = await run(["whoami", "--json"]);
  assert.ok(none.code === 2 && none.json.error === "not_signed_in" && none.json.next_step === "octillion login" && /app\/settings\/api-keys/.test(none.json.message), `no credential: ${none.out}`);
  assert.equal((await run(["whoami"], { OCTILLION_URL: "" })).code, 1, "no server set: an error");

  // Device login not configured on the server: says so and points to API keys.
  delete process.env.OCTILLION_CLI_CLIENT_ID;
  const cfg0 = await (await fetch(`${base}/api/cli/config`)).json();
  assert.ok(cfg0.device_login === false && cfg0.client_id === null && cfg0.resource === `${base}/mcp`, "the CLI config says device login is off");
  const dis = await run(["login", "--json"]);
  assert.ok(dis.code === 1 && dis.json.error === "device_login_disabled" && dis.json.message.includes(`${base}/app/settings/api-keys`) && dis.json.message.includes("OCTILLION_API_KEY"), `not configured: ${dis.out}`);

  // API key precedence: --token, then OCTILLION_API_KEY, then the stored login.
  const { insertApiKey } = await import("../src/auth.js");
  const key = (await insertApiKey(f.P.id, "cli smoke", f.kim.id, { scope: "read", via: "portal" })).key;
  const viaEnv = await run(["whoami", "--json"], { OCTILLION_API_KEY: key });
  assert.ok(viaEnv.code === 0 && viaEnv.json.source === "env" && viaEnv.json.credential.type === "api_key" && viaEnv.json.org.slug === f.P.slug && viaEnv.json.org_source === "key", `env key: ${viaEnv.out}${viaEnv.err}`);
  const oauthTok = await token({ user_id: f.kim.id, org_id: f.orgQ.id });
  const viaFlag = await run(["whoami", "--json", "--token", oauthTok], { OCTILLION_API_KEY: key });
  assert.ok(viaFlag.json.source === "flag" && viaFlag.json.credential.type === "oauth" && viaFlag.json.org.slug === f.Q.slug && viaFlag.json.org_source === "token", "--token beats OCTILLION_API_KEY");
  const text = await run(["whoami"], { OCTILLION_API_KEY: key });
  assert.ok(text.out.includes("Credential: OCTILLION_API_KEY") && text.out.includes(f.P.slug), `whoami text names the source: ${text.out}`);
  const bad = await run(["whoami", "--json"], { OCTILLION_API_KEY: `oct_${"x".repeat(32)}` });
  assert.ok(bad.code === 2 && bad.json.source === "env" && /credential: OCTILLION_API_KEY/.test(bad.json.message) && /OCTILLION_API_KEY/.test(bad.json.next_step), `a bad key names its source: ${bad.out}`);
  assert.equal((await run(["token"], { OCTILLION_API_KEY: key })).out, `${key}\n`, "token prints the credential in use and nothing else");
  const org = await run(["whoami", "--json", "--token", oauthTok, "--org", f.P.slug]);
  assert.ok(org.json.org.slug === f.P.slug && org.json.org_source === "header", "--org sends X-Octillion-Org");

  // Device login: the server names the CLI's public client.
  process.env.OCTILLION_CLI_CLIENT_ID = "cli_mock_public";
  await mockPost("/_mock/oauth/clients", { client_id: "cli_mock_public" });
  try {
    const cfg1 = await (await fetch(`${base}/api/cli/config`)).json();
    assert.ok(cfg1.device_login === true && cfg1.client_id === "cli_mock_public" && cfg1.issuer === c.mockUrl, "the CLI config names the client and issuer");
    // Non-interactive: JSON with the link and the next step, exit 0 (explicit, and automatic for an agent).
    const start = await run(["login", "--non-interactive"]);
    assert.equal(start.code, 0, start.err);
    assert.deepEqual(Object.keys(start.json).filter((k) => ["verification_uri_complete", "user_code", "expires_in", "next_step"].includes(k)).sort(), ["expires_in", "next_step", "user_code", "verification_uri_complete"]);
    assert.ok(/^octillion login --complete [a-f0-9]{12}$/.test(start.json.next_step) && start.json.verification_uri_complete.includes(start.json.user_code) && start.json.expires_in === 600, `non-interactive login JSON: ${start.out}`);
    const agent = await run(["login"], { CLAUDECODE: "1" });
    assert.ok(agent.code === 0 && agent.json?.next_step?.startsWith("octillion login --complete "), "an agent environment gets the JSON without asking");
    const handle = start.json.next_step.split(" ").pop();
    const pendingStat = await stat(path.join(cfgDir, "pending", `${handle}.json`));
    assert.equal(pendingStat.mode & 0o777, 0o600, "the pending login is 0600");
    const waiting = await run(["login", "--complete", handle, "--timeout", "1", "--json"]);
    assert.ok(waiting.code === 2 && waiting.json.error === "authorization_pending" && waiting.json.next_step === `octillion login --complete ${handle}`, `not approved yet: exit 2 (${waiting.out})`);
    await mockPost("/_mock/device/approve", { user_code: start.json.user_code, user_id: f.kim.id, org_id: f.orgQ.id });
    const done = await run(["login", "--complete", handle, "--json"]);
    assert.ok(done.code === 0 && done.json.status === "signed_in" && done.json.source === "login", `completed: ${done.out}${done.err}`);
    const credFile = path.join(cfgDir, "credentials.json");
    assert.equal((await stat(credFile)).mode & 0o777, 0o600, "credentials.json is 0600");
    assert.equal((await run(["login", "--complete", handle, "--json"])).json.error, "no_pending", "a handle finishes once");
    const me = await run(["whoami", "--json"]);
    assert.ok(me.code === 0 && me.json.source === "login" && me.json.credential.type === "oauth" && me.json.org.slug === f.Q.slug && me.json.org_source === "token", `stored login: ${me.out}${me.err}`);
    assert.equal((await run(["whoami", "--json"], { OCTILLION_API_KEY: key })).json.source, "env", "OCTILLION_API_KEY still comes before the stored login");
    // Refresh: an expired stored token is refreshed with its refresh token.
    const t1 = (await run(["token"])).out.trim();
    assert.ok(t1.startsWith("oat_"));
    const creds = JSON.parse(await readFile(credFile, "utf8"));
    creds.profiles[base].expires_at = new Date(Date.now() - 1000).toISOString();
    await writeFile(credFile, JSON.stringify(creds));
    const t2 = (await run(["token", "--json"])).json;
    assert.ok(t2.token.startsWith("oat_") && t2.token !== t1 && t2.source === "login", "refreshed when expired");
    assert.equal((await run(["whoami", "--json"])).json.org.slug, f.Q.slug, "and the new token works");
    // Interactive: prints the link and code, polls until approved.
    const child = spawn(process.execPath, [CLI, "login", "--interactive", "--json"], { env: { ...env0 } });
    let err = "", out = "";
    child.stderr.on("data", (d) => { err += d; });
    child.stdout.on("data", (d) => { out += d; });
    for (let i = 0; i < 100 && !/confirm the code ([A-F0-9-]+)/.test(err); i++) await new Promise((r) => setTimeout(r, 50));
    const code = /confirm the code ([A-F0-9-]+)/.exec(err)?.[1];
    assert.ok(code && err.includes("/oauth/device?user_code="), `interactive login shows the link and code: ${err}`);
    await mockPost("/_mock/device/approve", { user_code: code, user_id: f.kim.id });
    const exit = await new Promise<number>((r) => child.on("close", (n) => r(n ?? 1)));
    assert.ok(exit === 0 && JSON.parse(out).status === "signed_in", `interactive login completes: ${out}${err}`);
    // Declined.
    const deny = await run(["login", "--non-interactive"]);
    await mockPost("/_mock/device/approve", { user_code: deny.json.user_code, deny: true });
    const denied = await run(["login", "--complete", deny.json.next_step.split(" ").pop(), "--json"]);
    assert.ok(denied.code === 1 && denied.json.error === "access_denied", "a declined sign-in is an error");
    // Logout.
    const bye = await run(["logout", "--json"]);
    assert.ok(bye.code === 0 && bye.json.status === "signed_out");
    assert.equal((await run(["whoami", "--json"])).code, 2, "signed out: whoami needs a login");
    assert.equal((await run(["keys", "create", "--name", "x", "--json"])).json.error, "not_supported", "keys: not available, says where to make one");
  } finally {
    delete process.env.OCTILLION_CLI_CLIENT_ID;
  }
  console.log("✓ octillion CLI (no deps, --no-experimental-require-module): precedence --token > OCTILLION_API_KEY > stored login, whoami names the source, mcp-config from the server (built in offline), device login off -> API keys, non-interactive JSON + --complete (exit 2 while pending), interactive, refresh, 0600 files, logout");
}
