// Fake Clerk Backend API + Stripe for the smoke test only: scripts/smoke.ts starts it in memory on 127.0.0.1 and points
// CLERK_API_URL / STRIPE_API_URL at it. Never mounted by the server; production always talks to the real services.
// Not a simulator of either product: only the fields Octillion reads, with the same shapes.
// Test hooks: POST /_mock/clerk/users {email, first_name?, verified?, platform_admin?, platform_role?}, POST /_mock/invitations/:id/accept
// {first_name?}, POST /_mock/clerk/memberships {org_id, user_id, role?, public_metadata?}, POST /_mock/session {user_id, org_id?, org_role?,
// azp?, expired?, v1?} -> a Clerk session token, POST /_mock/oauth {user_id, jwt?, revoked?, expired?} -> an OAuth
// access token, GET /_mock/public-key -> {pem} for CLERK_JWT_KEY, POST /_mock/subscriptions {customer, price, status?}.
import express from "express";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { exportJWK, exportSPKI, generateKeyPair, importJWK, SignJWT } from "jose";

export interface MockPersistence { load(): Promise<string | null>; save(state: string): Promise<void> }

const id = (p: string) => `${p}_${randomBytes(10).toString("hex").toUpperCase()}`;
const now = () => new Date().toISOString();

export async function createMockApp(getBase: () => string, persist?: MockPersistence) {
  const saved = persist ? JSON.parse((await persist.load()) ?? "null") : null;
  // The signing key survives restarts in persisted mode (tokens issued earlier keep verifying).
  const { publicKey, privateKey } = saved?.keys
    ? { publicKey: await importJWK(saved.keys.pub, "RS256", { extractable: true }), privateKey: await importJWK(saved.keys.priv, "RS256") }
    : await generateKeyPair("RS256", { extractable: true });
  const keyJson = saved?.keys ?? { pub: await exportJWK(publicKey), priv: await exportJWK(privateKey) };
  const jwk = { ...keyJson.pub, kid: "mock-1", alg: "RS256", use: "sig" };
  const s = {
    orgs: new Map<string, any>(), invitations: new Map<string, any>(), memberships: new Map<string, any>(), users: new Map<string, any>(),
    customers: new Map<string, any>(), subscriptions: new Map<string, any>(), meterEvents: [] as any[], invoices: [] as any[],
    oauth: new Map<string, any>(), keyed: new Map<string, any>(),
    prices: [
      { id: "price_mock_starter", object: "price", active: true, lookup_key: "octillion_starter", unit_amount: 49900, currency: "usd", recurring: { interval: "month" },
        nickname: "Starter", metadata: { monthly_budget_usd: "300" }, product: { id: "prod_mock_1", name: "Octillion", metadata: {} } },
      { id: "price_mock_growth", object: "price", active: true, lookup_key: "octillion_growth", unit_amount: 149900, currency: "usd", recurring: { interval: "month" },
        nickname: "Growth", metadata: { monthly_budget_usd: "1500" }, product: { id: "prod_mock_1", name: "Octillion", metadata: {} } },
      { id: "price_unrelated", object: "price", active: true, lookup_key: "other_thing", unit_amount: 100, currency: "usd", recurring: null, nickname: null, metadata: {}, product: { name: "x", metadata: {} } },
    ],
  };
  const app = express();
  const MAPS = ["orgs", "invitations", "memberships", "users", "customers", "subscriptions", "oauth", "keyed"] as const;
  const dump = () => JSON.stringify({ keys: keyJson, meterEvents: s.meterEvents, invoices: s.invoices,
    ...Object.fromEntries(MAPS.map((k) => [k, [...(s[k] as Map<string, unknown>).entries()]])) });
  const restore = (j: any) => {
    for (const k of MAPS) { const m = s[k] as Map<string, unknown>; m.clear(); for (const [a, b] of j[k] ?? []) m.set(a, b); }
    s.meterEvents.splice(0, s.meterEvents.length, ...(j.meterEvents ?? []));
    s.invoices.splice(0, s.invoices.length, ...(j.invoices ?? []));
  };
  if (saved) restore(saved);
  if (persist) app.use(async (_req, res, next) => {
    const j = await persist.load();
    if (j) restore(JSON.parse(j));
    const before = dump();
    // Save before the response ends: a serverless function may be frozen right after it.
    const end = res.end.bind(res) as (...a: unknown[]) => typeof res;
    res.end = ((...a: unknown[]) => {
      const after = dump();
      if (after === before) return end(...a);
      persist.save(after).catch((e) => console.error("mock state save failed:", e.message)).finally(() => end(...a));
      return res;
    }) as typeof res.end;
    next();
  });
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  const page = (data: any[]) => ({ object: "list", data, list_metadata: { before: null, after: null } });
  const auth = (req: express.Request, res: express.Response, next: express.NextFunction) =>
    /^Bearer \S+/.test(req.get("authorization") ?? "") ? next() : void res.status(401).json({ message: "Unauthorized" });

  const pem = await exportSPKI(publicKey as Parameters<typeof exportSPKI>[0]);
  const ms = () => Date.now();
  const clerkErr = (res: express.Response, status: number, message: string, code = "form_param_invalid") =>
    void res.status(status).json({ errors: [{ message, long_message: message, code }] });
  const list = (data: any[]) => ({ data, total_count: data.length });
  const userJson = (u: any) => u;
  const membershipJson = (m: any) => {
    const u = s.users.get(m.user_id);
    const e = u?.email_addresses.find((x: any) => x.id === u.primary_email_address_id);
    return { object: "organization_membership", id: m.id, role: m.role, public_metadata: m.public_metadata ?? {}, created_at: m.created_at,
      organization: s.orgs.get(m.organization_id), public_user_data: { user_id: m.user_id, identifier: e?.email_address ?? null, first_name: u?.first_name ?? null, last_name: u?.last_name ?? null } };
  };
  const newUser = (email: string, opts: { first_name?: string | null; verified?: boolean; platform_admin?: boolean; platform_role?: string } = {}) => {
    const eid = id("idn");
    const u = { object: "user", id: id("user"), first_name: opts.first_name ?? null, last_name: null, primary_email_address_id: eid,
      email_addresses: [{ id: eid, email_address: email.toLowerCase(), verification: { status: opts.verified === false ? "unverified" : "verified" } }],
      public_metadata: { ...(opts.platform_admin ? { platform_admin: true } : {}), ...(opts.platform_role ? { platform_role: opts.platform_role } : {}) },
      last_sign_in_at: null, created_at: ms() };
    s.users.set(u.id, u);
    return u;
  };
  const userByEmail = (email: string) => [...s.users.values()].find((u) => u.email_addresses.some((e: any) => e.email_address === email.toLowerCase()));
  const addMembership = (orgId: string, userId: string, role: string) => {
    const m = { id: id("orgmem"), organization_id: orgId, user_id: userId, role, public_metadata: {}, created_at: ms() };
    s.memberships.set(`${orgId}:${userId}`, m);
    return m;
  };

  // ---------- Clerk Frontend API (the OAuth authorization server for /mcp) ----------
  app.get("/.well-known/oauth-authorization-server", (_req, res) => void res.json({
    issuer: getBase(), authorization_endpoint: `${getBase()}/oauth/authorize`, token_endpoint: `${getBase()}/oauth/token`, registration_endpoint: `${getBase()}/oauth/register`,
    jwks_uri: `${getBase()}/.well-known/jwks.json`, code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: true }));

  // ---------- Clerk Backend API (/v1, Bearer secret key) ----------
  const c = express.Router();
  c.use(auth);
  c.get("/v1/jwks", (_req, res) => void res.json({ keys: [jwk] }));
  c.post("/v1/organizations", (req, res) => {
    const { name, slug, public_metadata } = req.body ?? {};
    if (!name) return clerkErr(res, 422, "name is required");
    if (slug && [...s.orgs.values()].some((o) => o.slug === slug)) return clerkErr(res, 422, "That slug is taken. Please try another.", "form_identifier_exists");
    const o = { object: "organization", id: id("org"), name, slug: slug ?? null, public_metadata: public_metadata ?? {}, private_metadata: {}, created_at: ms(), updated_at: ms() };
    s.orgs.set(o.id, o); res.json(o);
  });
  c.get("/v1/organizations", (_req, res) => void res.json(list([...s.orgs.values()])));
  c.get("/v1/organizations/:id", (req, res) => { const o = s.orgs.get(req.params.id); o ? res.json(o) : clerkErr(res, 404, "Organization not found", "resource_not_found"); });
  c.patch("/v1/organizations/:id", (req, res) => {
    const o = s.orgs.get(req.params.id); if (!o) return clerkErr(res, 404, "Organization not found", "resource_not_found");
    if (req.body?.name !== undefined) o.name = req.body.name;
    o.updated_at = ms(); res.json(o);
  });
  c.patch("/v1/organizations/:id/metadata", (req, res) => {
    const o = s.orgs.get(req.params.id); if (!o) return clerkErr(res, 404, "Organization not found", "resource_not_found");
    o.public_metadata = { ...o.public_metadata, ...(req.body?.public_metadata ?? {}) }; res.json(o);
  });
  c.post("/v1/organizations/:id/invitations", (req, res) => {
    const orgId = req.params.id; if (!s.orgs.has(orgId)) return clerkErr(res, 404, "Organization not found", "resource_not_found");
    const email = String(req.body?.email_address ?? "").toLowerCase();
    if (!email) return clerkErr(res, 422, "email_address is required");
    // Like Clerk: inviting an address that already has a pending invitation revokes the old one and sends a new one.
    for (const x of s.invitations.values())
      if (x.email_address === email && x.organization_id === orgId && x.status === "pending") Object.assign(x, { status: "revoked", updated_at: ms() });
    const inv = { object: "organization_invitation", id: id("orginv"), email_address: email, role: req.body?.role ?? "org:member", status: "pending",
      public_metadata: req.body?.public_metadata ?? {}, organization_id: orgId, created_at: ms(), updated_at: ms(), expires_at: ms() + 30 * 86_400_000 };
    s.invitations.set(inv.id, inv); res.json(inv);
  });
  c.get("/v1/organizations/:id/invitations", (req, res) =>
    void res.json(list([...s.invitations.values()].filter((x) => x.organization_id === req.params.id).reverse())));
  c.post("/v1/organizations/:id/invitations/:inv/revoke", (req, res) => {
    const inv = s.invitations.get(req.params.inv);
    if (!inv || inv.organization_id !== req.params.id) return clerkErr(res, 404, "Invitation not found", "resource_not_found");
    if (inv.status !== "pending") return clerkErr(res, 404, "The organization invitation is not in the 'pending' status.", "resource_not_found");
    Object.assign(inv, { status: "revoked", updated_at: ms() }); res.json(inv);
  });
  c.get("/v1/organizations/:id/memberships", (req, res) =>
    void res.json(list([...s.memberships.values()].filter((m) => m.organization_id === req.params.id).map(membershipJson))));
  const mem = (req: express.Request) => s.memberships.get(`${req.params.id}:${req.params.user}`);
  c.patch("/v1/organizations/:id/memberships/:user", (req, res) => {
    const m = mem(req); if (!m) return clerkErr(res, 404, "Membership not found", "resource_not_found");
    if (req.body?.role) m.role = req.body.role;
    res.json(membershipJson(m));
  });
  c.patch("/v1/organizations/:id/memberships/:user/metadata", (req, res) => {
    const m = mem(req); if (!m) return clerkErr(res, 404, "Membership not found", "resource_not_found");
    m.public_metadata = { ...m.public_metadata, ...(req.body?.public_metadata ?? {}) }; res.json(membershipJson(m));
  });
  c.delete("/v1/organizations/:id/memberships/:user", (req, res) => {
    const m = mem(req); if (!m) return clerkErr(res, 404, "Membership not found", "resource_not_found");
    s.memberships.delete(`${req.params.id}:${req.params.user}`); res.json(membershipJson(m));
  });
  c.get("/v1/users", (req, res) => {
    const emails = ([] as unknown[]).concat(req.query.email_address ?? []).map((e) => String(e).toLowerCase());
    const all = [...s.users.values()].filter((u) => !emails.length || u.email_addresses.some((e: any) => emails.includes(e.email_address)));
    const offset = Number(req.query.offset ?? 0), limit = Number(req.query.limit ?? 10);
    res.json(all.slice(offset, offset + limit).map(userJson));
  });
  c.post("/v1/users", (req, res) => {
    const email = String(req.body?.email_address?.[0] ?? "");
    if (!email) return clerkErr(res, 422, "email_address is required");
    if (userByEmail(email)) return clerkErr(res, 422, "That email address is taken. Please try another.", "form_identifier_exists");
    const u = newUser(email, { verified: true });
    u.public_metadata = req.body?.public_metadata ?? {};
    res.json(userJson(u));
  });
  c.patch("/v1/users/:id/metadata", (req, res) => {
    const u = s.users.get(req.params.id); if (!u) return clerkErr(res, 404, "User not found", "resource_not_found");
    // Like Clerk: a deep merge where null removes the key.
    const md = { ...u.public_metadata, ...(req.body?.public_metadata ?? {}) };
    for (const [k, v] of Object.entries(md)) if (v === null) delete md[k];
    u.public_metadata = md; res.json(userJson(u));
  });
  c.get("/v1/users/:id", (req, res) => { const u = s.users.get(req.params.id); u ? res.json(userJson(u)) : clerkErr(res, 404, "User not found", "resource_not_found"); });
  c.get("/v1/users/:id/organization_memberships", (req, res) =>
    void res.json(list([...s.memberships.values()].filter((m) => m.user_id === req.params.id).map(membershipJson))));
  c.post("/v1/oauth_applications/access_tokens/verify", (req, res) => {
    const t = s.oauth.get(String(req.body?.access_token ?? ""));
    if (!t) return clerkErr(res, 404, "OAuth access token not found", "resource_not_found");
    res.json({ object: "clerk_idp_oauth_access_token", id: t.id, client_id: "mock_client", type: "oauth_token", subject: t.user_id, scopes: ["profile", "email"],
      revoked: Boolean(t.revoked), expired: Boolean(t.expired), expiration: ms() + 3_600_000, created_at: t.created_at, updated_at: t.created_at });
  });

  // ---------- Stripe (form-encoded) ----------
  const st = express.Router();
  st.use(auth);
  const keyed = s.keyed;
  st.post("/v1/customers", (req, res) => {
    const k = req.get("idempotency-key");
    if (k && keyed.has(k)) return void res.json(keyed.get(k));
    const c = { id: id("cus"), object: "customer", name: req.body.name, email: req.body.email ?? null, metadata: req.body.metadata ?? {} };
    s.customers.set(c.id, c); if (k) keyed.set(k, c); res.json(c);
  });
  st.get("/v1/prices", (_req, res) => void res.json({ object: "list", data: s.prices, has_more: false }));
  st.get("/v1/subscriptions", (req, res) =>
    void res.json({ object: "list", data: [...s.subscriptions.values()].filter((x) => !req.query.customer || x.customer === req.query.customer), has_more: false }));
  st.post("/v1/checkout/sessions", (req, res) => {
    if (!s.customers.has(req.body.customer)) return void res.status(400).json({ error: { message: "No such customer" } });
    res.json({ id: id("cs"), url: `${getBase()}/checkout/${req.body.customer}/${req.body.line_items?.[0]?.price}` });
  });
  st.post("/v1/billing_portal/sessions", (req, res) => void res.json({ id: id("bps"), url: `${getBase()}/billing/${req.body.customer}` }));
  st.get("/v1/invoices", (req, res) => void res.json({ object: "list", data: s.invoices.filter((i) => i.customer === req.query.customer), has_more: false }));
  st.post("/v1/billing/meter_events", (req, res) => {
    if (!s.meterEvents.some((e) => e.identifier === req.body.identifier)) s.meterEvents.push(req.body);
    res.json({ object: "billing.meter_event", ...req.body });
  });

  // ---------- test hooks ----------
  app.get("/_mock/public-key", (_req, res) => void res.json({ pem }));
  app.post("/_mock/clerk/users", (req, res) => {
    const email = String(req.body?.email ?? "");
    if (!email) return void res.status(400).end();
    res.json(userByEmail(email) ?? newUser(email, req.body));
  });
  app.post("/_mock/invitations/:id/accept", (req, res) => {
    const inv = s.invitations.get(req.params.id); if (!inv) return void res.status(404).end();
    const user = userByEmail(inv.email_address) ?? newUser(inv.email_address, { first_name: req.body?.first_name ?? null });
    const m = addMembership(inv.organization_id, user.id, inv.role);
    m.public_metadata = { ...(inv.public_metadata ?? {}) }; // like Clerk: the invitation's metadata moves to the membership
    Object.assign(inv, { status: "accepted", updated_at: ms() });
    res.json({ user, membership: membershipJson(m) });
  });
  app.post("/_mock/clerk/memberships", (req, res) => {
    const { org_id, user_id, role, public_metadata } = req.body ?? {};
    if (!s.orgs.has(org_id) || !s.users.has(user_id)) return void res.status(404).end();
    const m = addMembership(org_id, user_id, role ?? "org:member");
    if (public_metadata) m.public_metadata = public_metadata;
    res.json(membershipJson(m));
  });
  /** A Clerk session token (v2 claims by default: `o: {id, rol, slg}`; v1: org_id/org_role). */
  app.post("/_mock/session", async (req, res) => {
    const b = req.body ?? {};
    const org = b.org_id ? s.orgs.get(b.org_id) : null;
    const claims: Record<string, unknown> = { sid: id("sess"), azp: b.azp ?? undefined, v: b.v1 ? undefined : 2 };
    if (org) {
      if (b.v1) Object.assign(claims, { org_id: org.id, org_role: b.org_role ?? "org:member", org_slug: org.slug });
      else claims.o = { id: org.id, rol: String(b.org_role ?? "member").replace(/^org:/, ""), slg: org.slug };
    }
    const t = new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "mock-1", typ: "JWT" }).setIssuer(getBase()).setSubject(b.user_id)
      .setIssuedAt().setNotBefore(Math.floor(Date.now() / 1000) - 5).setExpirationTime(b.expired ? Math.floor(Date.now() / 1000) - 60 : "5m");
    res.json({ token: await t.sign(privateKey) });
  });
  /** A Clerk OAuth access token for an MCP client: opaque oat_… (verified through the Backend API) or a JWT (typ at+jwt). */
  app.post("/_mock/oauth", async (req, res) => {
    const b = req.body ?? {};
    if (b.jwt) {
      const t = new SignJWT({ scp: "profile email", client_id: "mock_client" }).setProtectedHeader({ alg: "RS256", kid: "mock-1", typ: "at+jwt" })
        .setIssuer(getBase()).setSubject(b.user_id).setIssuedAt().setExpirationTime(b.expired ? Math.floor(Date.now() / 1000) - 60 : "5m");
      return void res.json({ access_token: await t.sign(privateKey) });
    }
    const token = `oat_${randomBytes(18).toString("hex")}`;
    s.oauth.set(token, { id: id("oat"), user_id: b.user_id, revoked: Boolean(b.revoked), expired: Boolean(b.expired), created_at: ms() });
    res.json({ access_token: token });
  });
  app.post("/_mock/subscriptions", (req, res) => {
    const price = s.prices.find((p) => p.id === req.body.price);
    const sub = { id: id("sub"), object: "subscription", customer: req.body.customer, status: req.body.status ?? "active", cancel_at_period_end: false, trial_end: null,
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, items: { data: [{ price }] } };
    s.subscriptions.set(sub.id, sub);
    s.invoices.push({ id: id("in"), customer: req.body.customer, number: `MOCK-${s.invoices.length + 1}`, status: "paid", total: price?.unit_amount ?? 0, currency: "usd",
      created: Math.floor(Date.now() / 1000), hosted_invoice_url: `${getBase()}/invoice` });
    res.json(sub);
  });
  app.use(c);
  app.use(st);

  return { app, state: s };
}

/** The mock on its own port, in memory (smoke test, local preview). */
export async function startMockProviders(port = 0) {
  let url = "";
  const { app, state } = await createMockApp(() => url);
  const server = app.listen(port, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, state, close: () => new Promise<void>((r) => server.close(() => r())) };
}
