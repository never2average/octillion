// Agent auth (P0): personal API keys from the portal, OCTILLION_API_KEY snippets, /mcp errors an agent can act on,
// X-Octillion-Org and whoami (src/api-keys.ts, src/auth.ts authenticateMcp). Run from scripts/smoke.ts inside the Clerk
// section, against the mock providers. First, proof that what worked before still works the same way.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Db } from "../src/db.js";

interface Ctx {
  base: string; db: Db; mockUrl: string; stamp: string;
  mockPost: (path: string, body?: unknown) => Promise<any>;
  clerkSession: (userId: string, orgId?: string | null, role?: string) => Promise<string>;
  token: (claims: { user_id: string; jwt?: boolean; revoked?: boolean; expired?: boolean }) => Promise<string>;
  appCall: (session: string, method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;
  adm: (method: string, path: string, body?: unknown) => Promise<Response>;
  json: (r: Response | Promise<Response>) => Promise<any>;
}

const INIT = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent-auth", version: "1" } } });

export async function agentAuthChecks(c: Ctx) {
  const { base, db, mockPost, clerkSession, token, appCall, adm, json, stamp } = c;
  const clerkApi = (path: string, body: unknown) => fetch(`${c.mockUrl}/v1${path}`, { method: "POST", headers: { authorization: "Bearer sk_test_mock", "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  /** A raw POST /mcp (initialize) with these headers. */
  const raw = (headers: Record<string, string>, path = "/mcp") => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: INIT });
  /** An MCP client over HTTP with these headers. */
  const client = async (headers: Record<string, string>) => {
    const cl = new Client({ name: "agent-auth", version: "1.0.0" });
    await cl.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
    return cl;
  };
  const tool = async (headers: Record<string, string>, name: string, args: Record<string, unknown> = {}) => {
    const cl = await client(headers);
    try { return await cl.callTool({ name, arguments: args }); } finally { await cl.close(); }
  };
  const who = async (headers: Record<string, string>) => {
    const r = await tool(headers, "whoami");
    assert.ok(!r.isError, `whoami: ${JSON.stringify(r.content)}`);
    return { data: r.structuredContent as any, text: (r.content as any)[0].text as string };
  };
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  // An account of our own: Pat owns it, Mo is a member. Self-serve links the Clerk organization on first use.
  const orgP = await clerkApi("/organizations", { name: `Agent Auth ${stamp}` });
  const pat = await mockPost("/_mock/clerk/users", { email: `pat+${stamp}@agent-auth.dev` });
  const mo = await mockPost("/_mock/clerk/users", { email: `mo+${stamp}@agent-auth.dev` });
  await mockPost("/_mock/clerk/memberships", { org_id: orgP.id, user_id: pat.id, role: "org:admin" });
  await mockPost("/_mock/clerk/memberships", { org_id: orgP.id, user_id: mo.id, role: "org:member" });
  // Pat is also a member of a second account, joined later (so the first stays their default): X-Octillion-Org.
  await new Promise((r) => setTimeout(r, 5));
  const orgQ = await clerkApi("/organizations", { name: `Agent Auth Q ${stamp}` });
  await mockPost("/_mock/clerk/memberships", { org_id: orgQ.id, user_id: pat.id, role: "org:member" });
  const patC = await clerkSession(pat.id, orgP.id, "admin"), moC = await clerkSession(mo.id, orgP.id, "member");
  assert.equal((await appCall(await clerkSession(pat.id, orgQ.id, "member"), "GET", "/me")).status, 200);
  // ---------- existing behaviour, unchanged ----------
  assert.equal((await appCall(patC, "GET", "/me")).status, 200, "portal sessions work as before");
  assert.equal((await appCall(moC, "GET", "/me")).status, 200);
  const [rowP] = await db.query<{ id: number; slug: string }>("SELECT id, slug FROM organizations WHERE clerk_org_id = $1", [orgP.id]);
  assert.ok(rowP, "the account is linked");
  const slugP = rowP.slug;
  // OAuth through the mock Clerk: whoami says so.
  const patTok = await token({ user_id: pat.id });
  const wOauth = await who(bearer(patTok));
  assert.equal(wOauth.data.credential.type, "oauth", "an OAuth token signs in as before");
  assert.equal(wOauth.data.org.slug, slugP);
  assert.equal(wOauth.data.person.user_id, pat.id);
  assert.equal(wOauth.data.role, "owner");
  // An org-wide key from before 0013 (no scope, no expiry, no person): full access, never expires.
  const { createApiKey } = await import("../src/auth.js");
  const oldKey = await createApiKey(rowP.id, "connector");
  const [oldRow] = await db.query<{ scope: string | null; expires_at: Date | null; user_id: string | null }>("SELECT scope, expires_at, user_id FROM api_keys WHERE org_id = $1 AND label = 'connector'", [rowP.id]);
  assert.deepEqual(oldRow, { scope: null, expires_at: null, user_id: null }, "an old-style key has NULL scope and expiry");
  const wOld = await who(bearer(oldKey));
  assert.ok(wOld.data.person === null && wOld.data.credential.scope === "full" && wOld.data.credential.expires_at === null, "an org-wide key: no person, full access");
  assert.ok(!(await tool(bearer(oldKey), "save_to_memory", { body: `Agent auth smoke ${stamp}: old keys still write.` })).isError, "an old key still calls write tools");
  assert.ok(!(await tool({ "x-api-key": oldKey }, "list_products")).isError, "and still works in X-API-Key");
  // An email-labelled key a platform admin issues still binds to that person (the label hack, kept for old keys).
  const issued = await json(adm("POST", `/orgs/${slugP}/keys`, { label: `mo+${stamp}@agent-auth.dev` }));
  const wMail = await who(bearer(issued.key));
  assert.equal(wMail.data.person?.user_id, mo.id, "an email-labelled key acts as that person");
  assert.equal(wMail.data.credential.scope, "full");
  assert.equal(wMail.data.role, null, "and, as before, carries no role");
  // The legacy URL path: still served, still marked deprecated.
  const legacy = await raw({}, `/mcp/${oldKey}`);
  await legacy.text();
  assert.equal(legacy.status, 200, "/mcp/:key still works");
  assert.equal(legacy.headers.get("deprecation"), "@1792454400", "with the Deprecation header");
  console.log("✓ agent auth, nothing broken: OAuth via Clerk, org-wide keys (NULL scope/expiry) full access, email-labelled keys bind to the person, /mcp/:key deprecated, portal sessions");

  // ---------- personal keys on the portal ----------
  const lines: string[] = [];
  const err = console.error, out = console.log;
  console.error = (...xs: unknown[]) => { lines.push(xs.map(String).join(" ")); err(...xs); };
  console.log = (...xs: unknown[]) => { lines.push(xs.map(String).join(" ")); out(...xs); };
  let moKey = "", moRead = "", patKey = "", moSecond = "";
  try {
    const bad = async (body: unknown, re: RegExp) => { const r = await appCall(moC, "POST", "/api-keys", body); assert.equal(r.status, 400); assert.match((await r.json()).error, re); };
    await bad({ name: "" }, /name/);
    await bad({ name: "x", scope: "admin" }, /read or write/);
    await bad({ name: "x", expires_days: 7 }, /30, 90 or 365/);
    const made = await appCall(moC, "POST", "/api-keys", { name: "CI" });
    assert.equal(made.status, 201);
    const m1 = await made.json();
    moKey = m1.key;
    assert.ok(moKey.startsWith("oct_") && m1.row.prefix === moKey.slice(0, 10), "the key is shown once, with its prefix");
    assert.equal(m1.row.scope, "write", "write by default, so existing tools work");
    const days = (Date.parse(m1.row.expires_at) - Date.now()) / 86_400_000;
    assert.ok(days > 89.9 && days <= 90, "expires in 90 days by default");
    assert.ok(m1.row.mine && m1.row.status === "active" && m1.row.created_via === "portal");
    assert.equal(m1.env.variable, "OCTILLION_API_KEY");
    moRead = (await json(appCall(moC, "POST", "/api-keys", { name: "read only", scope: "read", expires_days: 30 }))).key;
    moSecond = (await json(appCall(moC, "POST", "/api-keys", { name: "never", expires_days: null }))).key;
    patKey = (await json(appCall(patC, "POST", "/api-keys", { name: "Pat laptop", expires_days: 365 }))).key;
    const [dbRow] = await db.query<{ user_id: string; scope: string; created_via: string; label: string }>("SELECT user_id, scope, created_via, label FROM api_keys WHERE key_prefix = $1", [moKey.slice(0, 10)]);
    assert.deepEqual(dbRow, { user_id: mo.id, scope: "write", created_via: "portal", label: "CI" }, "bound to the person who made it, never by label");

    const moList = await json(appCall(moC, "GET", "/api-keys"));
    assert.equal(moList.can_manage, false);
    assert.deepEqual(moList.keys.map((k: any) => k.name).sort(), ["CI", `mo+${stamp}@agent-auth.dev`, "never", "read only"].sort(), "a member sees only their own keys (the admin-issued one labelled with their email is theirs too)");
    assert.ok(moList.keys.every((k: any) => k.mine && !("key" in k) && !("key_hash" in k)));
    assert.equal(moList.keys.find((k: any) => k.name === "never").expires_at, null, "never expires");
    const patRowId = (await db.query<{ id: number }>("SELECT id FROM api_keys WHERE key_prefix = $1", [patKey.slice(0, 10)]))[0].id;
    assert.equal((await appCall(moC, "POST", `/api-keys/${patRowId}/revoke`)).status, 404, "a member can't revoke someone else's key (it reads as not found)");
    const patList = await json(appCall(patC, "GET", "/api-keys"));
    assert.equal(patList.can_manage, true, "an owner manages every key");
    assert.ok(["CI", "never", "read only", "Pat laptop", "connector", `mo+${stamp}@agent-auth.dev`].every((n) => patList.keys.some((k: any) => k.name === n)), "an owner sees every key in the account, old ones too");
    assert.equal(patList.keys.find((k: any) => k.name === "CI").owner.email, `mo+${stamp}@agent-auth.dev`, "with whose it is");
    assert.equal(patList.keys.find((k: any) => k.name === "connector").scope, "full");
    const never = moList.keys.find((k: any) => k.name === "never");
    assert.equal((await appCall(patC, "POST", `/api-keys/${never.id}/revoke`)).status, 204, "an owner revokes a member's key");
    assert.equal((await appCall(patC, "POST", `/api-keys/${never.id}/revoke`)).status, 409, "once");
    // The snippets: OCTILLION_API_KEY by each client's own interpolation, never a key.
    const h = moList.headless as any[];
    const by = (id: string) => h.find((x) => x.id === id);
    assert.equal(by("claude-code").command, `claude mcp add --transport http octillion ${base}/mcp --header "Authorization: Bearer \${OCTILLION_API_KEY}"`);
    assert.deepEqual(JSON.parse(by("claude-code-json").snippet).mcpServers.octillion.headers, { Authorization: "Bearer ${OCTILLION_API_KEY}" });
    assert.match(by("codex").snippet, /^\[mcp_servers\.octillion\]\nurl = ".+\/mcp"\nbearer_token_env_var = "OCTILLION_API_KEY"$/);
    assert.deepEqual(JSON.parse(by("cursor").snippet).mcpServers.octillion.headers, { Authorization: "Bearer ${env:OCTILLION_API_KEY}" });
    assert.match(by("curl").command, /-H "Authorization: Bearer \$OCTILLION_API_KEY"/);
    assert.ok(!JSON.stringify(h).includes("oct_"), "no snippet holds a key");
    const setup = await json(appCall(moC, "GET", "/setup"));
    assert.ok(setup.connect.headless.length >= 4 && setup.connect.api_keys_url.endsWith("/app/settings/api-keys"), "the setup page gets the headless path too");
    console.log("✓ personal API keys: create (write/90 days by default, read, never), list own only, owner sees and revokes all, member can't revoke others', bound to the person; env-var snippets render");

    // ---------- the keys on /mcp ----------
    const wMo = await who(bearer(moKey));
    assert.ok(wMo.data.person.user_id === mo.id && wMo.data.role === "member" && wMo.data.credential.type === "api_key" && wMo.data.credential.personal && wMo.data.credential.scope === "write");
    assert.match(wMo.text, new RegExp(`using API key "CI" \\(${moKey.slice(0, 10)}…, read and write, expires `), "whoami says which key");
    await new Promise((r) => setTimeout(r, 200));
    const [used] = await db.query<{ last_used_at: Date | null }>("SELECT last_used_at FROM api_keys WHERE key_prefix = $1", [moKey.slice(0, 10)]);
    assert.ok(used.last_used_at, "last_used_at recorded");
    // A read key: reads work; a write tool is a tool error with the next step.
    assert.ok(!(await tool(bearer(moRead), "list_products")).isError, "a read key reads");
    const w = await tool(bearer(moRead), "save_to_memory", { body: "should not save" });
    assert.ok(w.isError, "a read key can't call a write tool");
    assert.match((w.content as any)[0].text, /read-only.*create a write key at .*\/app\/settings\/api-keys/i, "and is told how to get a write key");
    // Expired: 401 invalid_token with the date.
    await db.query("UPDATE api_keys SET expires_at = '2026-01-02T00:00:00Z' WHERE key_prefix = $1", [moKey.slice(0, 10)]);
    const exp = await raw(bearer(moKey));
    assert.equal(exp.status, 401);
    assert.match(exp.headers.get("www-authenticate") ?? "", /error="invalid_token", error_description="API key expired on 2026-01-02"/);
    assert.match((await exp.json()).error.message, /expired on 2026-01-02.*\/app\/settings\/api-keys/);
    // Revoked: 401.
    const rev = await raw(bearer(moSecond));
    assert.equal(rev.status, 401);
    assert.match(rev.headers.get("www-authenticate") ?? "", /error="invalid_token", error_description="API key revoked"/);
    // Unknown: the same words for any key that does not exist.
    const unk = await raw(bearer(`oct_${"x".repeat(32)}`));
    assert.equal(unk.status, 401);
    assert.match(unk.headers.get("www-authenticate") ?? "", /error_description="API key not recognised"/);
    // Missing: no error code (RFC 6750 §3.1), the resource metadata, and the next step.
    const none = await raw({});
    assert.equal(none.status, 401);
    const ch = none.headers.get("www-authenticate") ?? "";
    assert.ok(/resource_metadata="/.test(ch) && !/error="/.test(ch), `a missing credential has no error code: ${ch}`);
    assert.match((await none.json()).error.message, /Sign in through your MCP client, or set OCTILLION_API_KEY \(create one at .*\/app\/settings\/api-keys\)/);
    // An OAuth token in X-API-Key: told to use Authorization: Bearer.
    const xo = await raw({ "x-api-key": patTok });
    assert.equal(xo.status, 401);
    assert.match(xo.headers.get("www-authenticate") ?? "", /error="invalid_request"/);
    assert.match((await xo.json()).error.message, /Authorization: Bearer/);
    // An invalid OAuth token: 401 invalid_token.
    const badTok = await raw(bearer(await token({ user_id: pat.id, revoked: true })));
    assert.equal(badTok.status, 401);
    assert.match(badTok.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
    // No account: 403 (not 401), no challenge, a next step.
    const loner = await mockPost("/_mock/clerk/users", { email: `loner2+${stamp}@nowhere.dev` });
    const na = await raw(bearer(await token({ user_id: loner.id })));
    assert.equal(na.status, 403, "no account is a 403, so the client does not loop through sign-in");
    assert.equal(na.headers.get("www-authenticate"), null);
    const naBody = await na.json();
    assert.equal(naBody.error.data.reason, "no_account");
    assert.match(naBody.error.message, /no Octillion workspace; request access at/);
    // A personal key stops when its person is suspended, and works again when restored.
    const moId = (await json(appCall(patC, "GET", "/team"))).members.find((m: any) => m.user_id === mo.id).id;
    assert.equal((await appCall(patC, "POST", `/team/members/${moId}/deactivate`)).status, 204);
    const sus = await raw(bearer(moRead));
    assert.equal(sus.status, 403);
    assert.match((await sus.json()).error.message, /suspended; ask an owner/);
    assert.equal(await raw(bearer(await token({ user_id: mo.id }))).then((r) => r.status), 403, "an OAuth token too");
    assert.equal((await appCall(patC, "POST", `/team/members/${moId}/reactivate`)).status, 204);
    assert.ok(!(await tool(bearer(moRead), "list_products")).isError, "restored");
    // An unset variable the client sent as its placeholder text.
    const unset = await raw(bearer("${OCTILLION_API_KEY}"));
    assert.equal(unset.status, 401);
    assert.match((await unset.json()).error.message, /OCTILLION_API_KEY is not set in its environment/, "an unexpanded placeholder says the variable is unset");

    // ---------- Clerk outage: stale-if-error for a personal key's membership ----------
    const { forgetMembershipCache } = await import("../src/clerk.js");
    const { forgetKeyMemberships } = await import("../src/auth.js");
    const clerkUrl = process.env.CLERK_API_URL;
    const outage = async <T>(fn: () => Promise<T>) => {
      forgetMembershipCache(); // the next membership read goes to Clerk, which is down
      process.env.CLERK_API_URL = "http://127.0.0.1:9";
      try { return await fn(); } finally { process.env.CLERK_API_URL = clerkUrl; }
    };
    assert.ok(!(await tool(bearer(moRead), "list_products")).isError, "Clerk up: membership read and remembered");
    assert.equal(await outage(() => raw(bearer(moRead)).then(async (r) => { await r.text(); return r.status; })), 200, "Clerk down: the last known membership is served");
    forgetKeyMemberships();
    const down = await outage(() => raw(bearer(moRead)));
    assert.equal(down.status, 503, "Clerk down with nothing remembered: 503");
    assert.equal(down.headers.get("retry-after"), "30");
    assert.equal((await down.json()).error.data.reason, "unverifiable");
    // A suspension through Octillion clears the remembered membership at once: during an outage that follows, the
    // key is not served on the old (active) membership.
    assert.ok(!(await tool(bearer(moRead), "list_products")).isError, "remembered again");
    assert.equal((await appCall(patC, "POST", `/team/members/${moId}/deactivate`)).status, 204);
    assert.equal(await outage(() => raw(bearer(moRead)).then(async (r) => { await r.text(); return r.status; })), 503, "a suspended member's key is never served from before the suspension");
    assert.equal((await appCall(patC, "POST", `/team/members/${moId}/reactivate`)).status, 204);
    assert.ok(!(await tool(bearer(moRead), "list_products")).isError, "Clerk back: works");
    // A deleted Clerk user (Clerk answers 404): 403 not_member, not a 503.
    const { insertApiKey } = await import("../src/auth.js");
    const ghost = (await insertApiKey(rowP.id, "ghost", `user_deleted_${stamp}`, { scope: "write", via: "portal" })).key;
    const gone = await raw(bearer(ghost));
    assert.equal(gone.status, 403, "a deleted owner's key is a 403");
    const goneBody = await gone.json();
    assert.ok(goneBody.error.data.reason === "not_member" && /owner is no longer a member/.test(goneBody.error.message), "not_member");
    // The 25-key limit holds under concurrent creates.
    const active = async () => (await json(appCall(moC, "GET", "/api-keys"))).keys.filter((k: any) => k.status === "active").length;
    const before = await active();
    const burst = await Promise.all(Array.from({ length: 30 - before }, (_, i) => appCall(moC, "POST", "/api-keys", { name: `burst ${i}` }).then((r) => r.status)));
    assert.equal(await active(), 25, "never more than 25 active keys");
    assert.ok(burst.filter((s) => s === 201).length === 25 - before && burst.every((s) => s === 201 || s === 409), `the rest are 409: ${burst.join(",")}`);
    console.log("✓ Clerk outage: last known membership served (10 min), 503 without one, cleared by a suspension; deleted owner 403 not_member; 25-key limit race-safe; unset env var named");
    console.log("✓ /mcp errors: missing 401 (no error code) with the next step, expired 401 invalid_token with the date, revoked 401, unknown 401, OAuth in X-API-Key 401 invalid_request, no account 403, suspended 403; read key on a write tool = isError with the next step; last_used_at");

    // ---------- X-Octillion-Org ----------
    const [rowQ] = await db.query<{ slug: string }>("SELECT slug FROM organizations WHERE clerk_org_id = $1", [orgQ.id]);
    const patTok2 = await token({ user_id: pat.id });
    assert.equal((await who(bearer(patTok2))).data.org.slug, slugP, "the default stays the oldest membership");
    const wQ = await who({ ...bearer(patTok2), "x-octillion-org": rowQ.slug });
    assert.ok(wQ.data.org.slug === rowQ.slug && wQ.data.role === "member" && wQ.text.includes(`(${rowQ.slug})`), "X-Octillion-Org picks another of your accounts");
    const notMine = await raw({ ...bearer(patTok2), "x-octillion-org": `nobody-${stamp}` });
    assert.equal(notMine.status, 403, "an account you're not in is refused");
    assert.match((await notMine.json()).error.message, new RegExp(`not a member of the Octillion workspace "nobody-${stamp}"`));
    const malformed = await raw({ ...bearer(patTok2), "x-octillion-org": "Not A Slug!" });
    assert.equal(malformed.status, 400, "a malformed slug is a 400");
    assert.equal(malformed.headers.get("www-authenticate"), null, "with no sign-in challenge");
    const malBody = await malformed.json();
    assert.ok(malBody.error.data.reason === "bad_org_header" && /workspace slug/.test(malBody.error.message), "invalid_request: says what a slug is");
    const mism = await raw({ ...bearer(patKey), "x-octillion-org": rowQ.slug });
    assert.equal(mism.status, 403, "a key acts only in its own account");
    assert.match((await mism.json()).error.message, new RegExp(`belongs to .*\\(${slugP}\\), not ${rowQ.slug}`));
    assert.equal((await who({ ...bearer(patKey), "x-octillion-org": slugP })).data.org.slug, slugP, "naming its own account is fine");
    console.log("✓ X-Octillion-Org: default unchanged, picks a membership, refuses others and malformed slugs; keys stay in their account; whoami names the account");

    // The platform admin's view shows the new columns.
    const detail = await json(adm("GET", `/orgs/${slugP}`));
    const ci = detail.keys.find((k: any) => k.label === "CI");
    assert.ok(ci && ci.scope === "write" && ci.created_via === "portal" && ci.user_id === mo.id && "expires_at" in ci && !("key_hash" in ci), "admin account detail lists scope, expiry, origin and person");
    await db.query("DELETE FROM organizations WHERE id = $1 OR slug = $2", [rowP.id, rowQ.slug]);
  } finally {
    console.error = err; console.log = out;
  }
  for (const k of [moKey, moRead, moSecond, patKey, oldKey, issued.key].filter(Boolean)) assert.ok(!lines.some((l) => l.includes(k)), "a key never appears in the logs");
  console.log("✓ admin account detail shows the new key columns; no key secret in lists or logs");
}
