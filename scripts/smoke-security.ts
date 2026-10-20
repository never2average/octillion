// Security checks run by scripts/smoke.ts, kept here so smoke.ts stays within what the TypeScript compiler can analyse
// in one body. Each takes what it needs from the smoke run (its server, database and credentials).
import assert from "node:assert/strict";
import type { Db } from "../src/db.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** No static admin token (src/admin-tokens.ts): scoped, expiring, revocable, hashed; only signed-in owners mint. */
export async function adminTokenChecks({ base, db, ADMIN_TOKEN, staff }: { base: string; db: Db; ADMIN_TOKEN: string; staff: { id: number; token: string } }) {
  const at = await import("../src/admin-tokens.js");
  const get = (t: string, path = "/keyvault/providers") => fetch(`${base}/api/admin${path}`, { headers: { authorization: `Bearer ${t}` } });
  // The retired variable opens nothing, whatever its value.
  process.env.OCTILLION_ADMIN_TOKEN = "smoke-static-admin-token";
  try {
    assert.equal((await get("smoke-static-admin-token")).status, 401, "OCTILLION_ADMIN_TOKEN is not accepted on /api/admin");
    const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } });
    assert.equal((await fetch(`${base}/admin/mcp`, { method: "POST", body: init, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer smoke-static-admin-token" } })).status, 401, "nor on the admin MCP");
    assert.equal((await fetch(`${base}/api/cron/autoscale`, { headers: { authorization: "Bearer smoke-static-admin-token" } })).status, 401, "nor on the cron");
    const v = await fetch(`${base}/admin/mcp`, { method: "POST", body: init, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${staff.token}` } });
    assert.equal(v.status, 200, "an admin token works on the admin MCP"); await v.text();
  } finally { delete process.env.OCTILLION_ADMIN_TOKEN; }
  // Hashed at rest: the token appears nowhere in the table.
  const rows = await db.query<any>("SELECT * FROM admin_tokens WHERE id = $1", [staff.id]);
  assert.ok(rows.length === 1 && !JSON.stringify(rows).includes(staff.token) && rows[0].token_prefix === staff.token.slice(0, 10), "only a hash and a prefix are stored");
  assert.ok(rows[0].last_used_at, "use is recorded");
  // Its role, no more: a viewer token reads but cannot change anything.
  const put = await fetch(`${base}/api/admin/keyvault/providers/smoke_viewer_probe`, { method: "PUT", headers: { authorization: `Bearer ${staff.token}`, "content-type": "application/json" }, body: JSON.stringify({ upstream: "https://example.com" }) });
  assert.equal(put.status, 403, "a viewer token cannot change the key vault");
  assert.match((await put.json()).error, /Owner role/);
  // Minting: owners only, signed in (a token cannot mint another), always expiring, at most 90 days.
  assert.equal((await fetch(`${base}/api/admin/tokens`, { method: "POST", headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ label: "renewal", role: "owner" }) })).status, 403, "a token cannot mint a token");
  assert.equal((await get(staff.token, "/tokens")).status, 403, "only owners list tokens");
  const list = await (await get(ADMIN_TOKEN, "/tokens")).json();
  assert.ok(list.tokens.some((t: any) => t.id === staff.id && t.label === "smoke staff" && t.role === "viewer") && !JSON.stringify(list).includes(staff.token), "listed without the token");
  // Admins are people: a token cannot add, promote or remove one (else a leaked owner token makes its holder an owner).
  for (const [method, path, body] of [["POST", "/onboarding/admins", { email: "attacker@evil.example", role: "owner" }], ["POST", "/onboarding/admins/user_x/role", { role: "owner" }], ["DELETE", "/onboarding/admins/user_x", undefined]] as const) {
    const r = await fetch(`${base}/api/admin${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    assert.equal(r.status, 403, `${method} ${path} refuses an owner token`);
    assert.equal((await r.json()).code, "signed_in_only");
  }
  for (const bad of [{ label: "x\nadmin someone@corp.example key.delete", role: "owner" }, { label: "a\u0000b", role: "viewer" }, { label: "y".repeat(81), role: "viewer" }, { label: "", role: "owner" }, { label: "x", role: "god" }, { label: "x", role: "owner", days: 91 }, { label: "x", role: "owner", days: 0 }])
    await assert.rejects(at.createAdminToken({ ...bad, createdBy: "smoke" }), at.AdminTokenError, JSON.stringify(bad));
  // Expiry and revocation take effect at once.
  const short = await at.createAdminToken({ label: "smoke short", role: "viewer", days: 1, createdBy: "smoke" });
  assert.equal((await get(short.token)).status, 200);
  await db.query("UPDATE admin_tokens SET expires_at = now() - interval '1 second' WHERE id = $1", [short.id]);
  assert.equal((await get(short.token)).status, 401, "an expired token is refused");
  assert.equal((await fetch(`${base}/api/admin/tokens/${staff.id}`, { method: "DELETE", headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).status, 204, "an owner revokes a token");
  assert.equal((await get(staff.token)).status, 401, "a revoked token is refused at once");
  assert.equal((await fetch(`${base}/api/admin/tokens/${staff.id}`, { method: "DELETE", headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).status, 404, "revoking twice is a 404");
  assert.equal((await get("adm_not-a-real-token")).status, 401);
  console.log("✓ admin tokens: the static OCTILLION_ADMIN_TOKEN opens nothing; tokens are hashed, scoped to a role, expiring, revocable, minted only by signed-in owners");
}

/** API keys in headers, never in URLs (src/auth.ts): Bearer or X-API-Key; legacy URL keys deprecated, logged, switchable off. */
export async function apiKeyHeaderChecks({ base, a }: { base: string; a: { key: string; org: { slug: string } } }) {
  assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "oct_nope" }, body: "{}" })).status, 401, "an unknown key in X-API-Key is refused");
  assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "oat_not_a_key" }, body: "{}" })).status, 401, "X-API-Key carries API keys only, never an OAuth token");
  const variants: Record<string, string>[] = [{ authorization: `Bearer ${a.key}` }, { "x-api-key": a.key }, { authorization: `Bearer ${a.key}`, "x-api-key": "oct_nope" }];
  for (const headers of variants) {
    const remote = new Client({ name: "smoke-http", version: "1.0.0" });
    await remote.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
    const r = await remote.callTool({ name: "list_products", arguments: {} });
    assert.ok((r.structuredContent as any).products.some((p: any) => p.slug === "relayq"));
    await remote.close();
  }
  // Keys in the URL: still served for existing clients, marked deprecated, logged by key prefix and never in full.
  {
    const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy", version: "1" } } });
    const legacy = () => fetch(`${base}/mcp/${a.key}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: init });
    const lines: string[] = [];
    const err = console.error;
    console.error = (...xs: unknown[]) => { lines.push(xs.map(String).join(" ")); };
    let old!: Response;
    try { old = await legacy(); await old.text(); } finally { console.error = err; }
    assert.equal(old.status, 200, "a legacy connector URL keeps working while OCTILLION_URL_KEYS allows it");
    assert.equal(old.headers.get("deprecation"), "@1792454400", "and is marked deprecated (RFC 9745, since 2026-10-20)");
    assert.match(old.headers.get("link") ?? "", /\/mcp>; rel="successor-version"/);
    assert.ok(lines.some((l) => l.includes(`mcp url-key deprecated org=${a.org.slug} key=${a.key.slice(0, 10)}`)), "who still uses one is logged");
    assert.ok(!lines.some((l) => l.includes(a.key)), "the key itself is never logged");
    process.env.OCTILLION_URL_KEYS = "off";
    try {
      const off = await legacy();
      assert.equal(off.status, 401, "OCTILLION_URL_KEYS=off refuses keys in the URL");
      assert.match((await off.json()).error.message, /Authorization: Bearer/, "and says how to send it instead");
      const viaHeader = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${a.key}` }, body: init });
      assert.equal(viaHeader.status, 200, "the same key in a header still works");
      await viaHeader.text();
    } finally { delete process.env.OCTILLION_URL_KEYS; }
  }
  console.log("✓ /mcp requires a key in a header (Bearer or X-API-Key) and serves that org; keys in the URL are deprecated, logged by prefix, and refused with OCTILLION_URL_KEYS=off");
}

/** Origin and Host validation on every MCP endpoint (src/origin.ts), the MCP spec's DNS-rebinding guidance. */
export async function originChecks({ base, a }: { base: string; a: { key: string } }) {
  // Origin (DNS-rebinding protection, MCP transport spec): a browser request from a foreign page is a 403 on every MCP
  // endpoint before any credential is looked at; no Origin (non-browser clients) or our own origin is served.
  {
    const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "origin", version: "1" } } });
    const hit = (path: string, origin?: string, key: string | null = a.key) => fetch(`${base}${path}`, { method: "POST", body: init,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(key ? { authorization: `Bearer ${key}` } : {}), ...(origin !== undefined ? { origin } : {}) } });
    const lines: string[] = [], err = console.error;
    console.error = (...xs: unknown[]) => { lines.push(xs.map(String).join(" ")); };
    try {
      for (const path of ["/mcp", `/mcp/${a.key}`, "/admin/mcp", "/api/admin/mcp"])
        for (const origin of ["https://evil.example", `http://127.0.0.1.evil.example:${new URL(base).port}`, "null", "not a url",
          `http://localhost:${new URL(base).port}`, `https://127.0.0.1:${new URL(base).port}`, `http://evil.example@127.0.0.1.evil.example:${new URL(base).port}`]) {
          const r = await hit(path, origin);
          assert.equal(r.status, 403, `${path} refuses Origin ${origin}`);
          assert.equal((await r.json()).error.code, -32000);
        }
      assert.equal((await hit("/mcp", "https://evil.example", null)).status, 403, "refused before auth: no 401 hint for a foreign page");
      for (const origin of [undefined, base, `${base}/`]) {
        const r = await hit("/mcp", origin);
        assert.equal(r.status, 200, `/mcp serves Origin ${origin ?? "(none)"}`);
        await r.text();
      }
      for (const path of [`/mcp/${a.key}`, "/admin/mcp", "/api/admin/mcp"]) {
        const r = await hit(path, undefined);
        assert.notEqual(r.status, 403, `${path} without an Origin reaches auth (${r.status})`);
        await r.text();
      }
      process.env.CLERK_MCP_AUDIENCE = "https://aud.example/mcp";
      try { const r = await hit("/mcp", "https://aud.example"); assert.equal(r.status, 200, "a CLERK_MCP_AUDIENCE origin is served"); await r.text(); }
      finally { delete process.env.CLERK_MCP_AUDIENCE; }
      process.env.OCTILLION_MCP_ALLOWED_ORIGINS = "http://localhost:6274, https://inspector.example";
      try {
        const r = await hit("/mcp", "http://localhost:6274");
        assert.equal(r.status, 200, "an origin listed in OCTILLION_MCP_ALLOWED_ORIGINS is served");
        await r.text();
        assert.equal((await hit("/mcp", "http://localhost:6275")).status, 403, "a different port is a different origin");
      } finally { delete process.env.OCTILLION_MCP_ALLOWED_ORIGINS; }
      // Every method is checked, not only POST: GET (an SSE stream), DELETE, OPTIONS, HEAD.
      for (const path of ["/mcp", "/admin/mcp"])
        for (const method of ["GET", "DELETE", "OPTIONS", "HEAD"])
          assert.equal((await fetch(`${base}${path}`, { method, headers: { origin: "https://evil.example" } })).status, 403, `${method} ${path} checks Origin`);
      // A loopback server with no PUBLIC_URL also checks Host (DNS rebinding on a developer's machine, no Origin needed).
      const pub = process.env.PUBLIC_URL;
      delete process.env.PUBLIC_URL;
      try {
        const { request } = await import("node:http");
        const viaHost = (host: string) => new Promise<number>((done, fail) => {
          const rq = request({ host: "127.0.0.1", port: Number(new URL(base).port), path: "/mcp", method: "POST", headers: { host, "content-type": "application/json", authorization: `Bearer ${a.key}` } }, (rs) => { rs.resume(); done(rs.statusCode ?? 0); });
          rq.on("error", fail); rq.end("{}");
        });
        assert.equal(await viaHost("rebound.evil.example"), 403, "a rebound Host is refused on a loopback server");
        assert.notEqual(await viaHost(`localhost:${new URL(base).port}`), 403, "localhost is fine");
      } finally { process.env.PUBLIC_URL = pub; }
    } finally { console.error = err; }
    assert.ok(lines.some((l) => l.startsWith("mcp origin refused POST /mcp origin=\"https://evil.example\"")), "refusals are logged with the origin");
    assert.ok(lines.filter((l) => l.includes('origin="https://evil.example"') && l.includes("POST /mcp ")).length === 1, "once a minute per origin, not per request");
    assert.ok(!lines.some((l) => l.includes("origin refused") && l.includes(a.key)), "never with the key from a URL");
  }
  console.log("✓ /mcp and the admin MCP refuse foreign Origins (403, before auth); no Origin, our own, or a listed one is served");
}
