// Fictional access requests and accounts at every onboarding stage, for a local look at /admin and /app.
// With the mock providers (npm run mock:providers, then its env), accounts go through Clerk and Stripe exactly as in
// production (src/admin.ts), and the mock's test hooks play the people accepting invitations and paying. Without
// Clerk/Stripe configured it seeds legacy-key accounts instead. Run `npm run demo:seed` first for one account with
// real scored runs. Local previews and demos only: refuses production and real Clerk/Stripe endpoints (people seeded
// into the mock Clerk cannot sign in to a browser: the UI needs a real Clerk development instance).
//   npm run admin:demo
import * as admin from "../src/admin.js";
import { getDb } from "../src/db.js";

// The local mock, or the one a preview server mounts at /mock (OCTILLION_MOCK_PROVIDERS=1).
const local = (u?: string) => Boolean(u && (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(u) || /^https:\/\/[^/]+\/mock\/?$/.test(u)));
if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed demo data in production");
if (process.env.CLERK_SECRET_KEY && !local(process.env.CLERK_API_URL))
  throw new Error("Refusing to seed into a real Clerk instance: point CLERK_API_URL at the mock (npm run mock:providers) or unset CLERK_SECRET_KEY");
if (process.env.STRIPE_SECRET_KEY && !local(process.env.STRIPE_API_URL))
  throw new Error("Refusing to seed into a real Stripe account: point STRIPE_API_URL at the mock (npm run mock:providers) or unset STRIPE_SECRET_KEY");
const clerkOn = Boolean(process.env.CLERK_SECRET_KEY), stripe = Boolean(process.env.STRIPE_SECRET_KEY);

const db = await getDb();
const stamp = Date.now().toString(36).slice(-4);
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
const ACTOR = "demo";

const hook = async (base: string | undefined, path: string, body: unknown = {}) => {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`mock ${path}: ${r.status} ${await r.text()}`);
  return r.json() as Promise<any>;
};
/** The invitee accepts (mock Clerk): returns their user id. */
const accept = async (invitationId: string, firstName?: string) =>
  (await hook(process.env.CLERK_API_URL, `/_mock/invitations/${invitationId}/accept`, { first_name: firstName })).user.id as string;
/** The account subscribes (mock Stripe). */
const subscribe = async (slug: string, price: string, status: string) => {
  const [o] = await db.query<{ stripe_customer_id: string | null }>("SELECT stripe_customer_id FROM organizations WHERE slug = $1", [slug]);
  if (o?.stripe_customer_id) await hook(process.env.STRIPE_API_URL, "/_mock/subscriptions", { customer: o.stripe_customer_id, price, status });
};
const orgId = async (slug: string) => (await db.query<{ id: number }>("SELECT id FROM organizations WHERE slug = $1", [slug]))[0].id;
const backdate = (slug: string, days: number) => db.query("UPDATE organizations SET created_at = $2 WHERE slug = $1", [slug, daysAgo(days)]);
const event = (org: number, user: string | null, at: Date, method: string, name: string | null, client: string, ok = true, error: string | null = null) =>
  db.query("INSERT INTO mcp_events (org_id, user_id, at, method, name, client, ok, error, ms) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [org, user, at, method, name, client, ok, error, Math.round(40 + Math.random() * 400)]);
const connect = async (org: number, user: string | null, at: Date, client: string, dashboard = false) => {
  await event(org, user, at, "initialize", null, client);
  await event(org, user, at, "tools/list", null, client);
  if (dashboard) await event(org, user, at, "resources/read", "ui://octillion/dashboard-v2.html", client);
};

// ---------- landing-page requests ----------
const requests = [
  ["maya@relaybase.dev", "Relaybase", "https://relaybase.dev", "Webhooks infra for SaaS. Curious whether Claude Code picks us over Svix.", 0.2],
  ["dev@kitepay.io", "Kitepay", "kitepay.io", "Payments SDK for marketplaces.", 1.5],
  ["sam@quillsearch.com", "Quill Search", "https://quillsearch.com", null, 3],
  ["founders@inkwell.ai", "Inkwell", "https://inkwell.ai", "We make a document parsing API. Saw the Resend case study.", 6],
] as const;
for (const [email, company, url, msg, d] of requests)
  await db.query("INSERT INTO access_requests (email, company, product_url, message, created_at) VALUES ($1, $2, $3, $4, $5)", [email, company, url, msg, daysAgo(d)]);
await db.query("INSERT INTO access_requests (email, company, product_url, message, created_at, status, decided_at) VALUES ($1, $2, $3, $4, $5, 'declined', $5)",
  ["hello@cheapseo.biz", "Cheap SEO", "cheapseo.biz", "Can you rank us on ChatGPT?", daysAgo(4)]);

const people: string[] = [];
const slug = (name: string) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${stamp}`;
/** Create an account; with an email that person is invited (Clerk) or gets a key (legacy). */
async function account(name: string, email: string | null, createdDays: number) {
  const r = await admin.createAccount(ACTOR, { name, slug: slug(name), email: email ?? undefined });
  await backdate(r.org.slug, createdDays);
  return r;
}

// Key issued / account created, nobody invited.
await account("Lumen Queue", null, 3);
// Invited, not accepted.
await account("Ferrous", "team@ferrous.rs", 6);
// Came through the request inbox; accepted the invitation, never connected a client.
const [{ id: parcelReq }] = await db.query<{ id: number }>(
  "INSERT INTO access_requests (email, company, product_url, created_at) VALUES ('eng@parcellabs.com', 'Parcel Labs', 'https://parcellabs.com', $1) RETURNING id", [daysAgo(4.5)]);
const parcel = await admin.approveRequest(ACTOR, parcelReq, { name: "Parcel Labs", slug: slug("Parcel Labs") });
await backdate(parcel.org.slug, 4);
if (clerkOn && parcel.invitation) { await accept((parcel.invitation as any).id, "Eli"); people.push("eng@parcellabs.com"); }
else await connect(await orgId(parcel.org.slug), null, daysAgo(3.2), "claude-ai 0.1.0"); // legacy: connected, no tool calls

// Joined, connected and using tools, but no product yet; trialing; a second person still invited.
const nw = await account("Northwind Auth", "pat@northwindauth.com", 7);
const nwOrg = await orgId(nw.org.slug);
const pat = clerkOn && nw.invitation ? await accept((nw.invitation as any).id, "Pat") : null;
if (pat) people.push("pat@northwindauth.com");
await connect(nwOrg, pat, daysAgo(6), "cursor-vscode 1.0.0");
for (const [d, tool] of [[6, "get_started"], [5.9, "list_agents"], [4, "get_started"], [3.5, "browse_task_library"]] as const)
  await event(nwOrg, pat, daysAgo(d), "tools/call", tool, "cursor-vscode 1.0.0");
if (clerkOn) await admin.invite(ACTOR, nw.org.slug, "sam@northwindauth.com");
if (stripe) await subscribe(nw.org.slug, "price_mock_starter", "trialing");

// Onboarding research failed with repeated errors; payment is past due.
const tess = await account("Tessellate DB", "cto@tessellate.io", 2);
const tessOrg = await orgId(tess.org.slug);
const cto = clerkOn && tess.invitation ? await accept((tess.invitation as any).id, "Rin") : null;
if (cto) people.push("cto@tessellate.io");
await connect(tessOrg, cto, daysAgo(1.8), "openai-mcp 1.0.0", true);
await event(tessOrg, cto, daysAgo(1.8), "tools/call", "get_started", "openai-mcp 1.0.0");
await event(tessOrg, cto, daysAgo(1.7), "tools/call", "onboard_product", "openai-mcp 1.0.0");
for (const d of [1.2, 1.1, 0.9]) await event(tessOrg, cto, daysAgo(d), "tools/call", "get_onboarding", "openai-mcp 1.0.0", false, "Research failed: docs site returned 403 to the fetcher");
const [p] = await db.query<{ id: number }>("INSERT INTO products (org_id, slug, name, website_url) VALUES ($1, 'tessellate', 'Tessellate', 'https://tessellate.io') RETURNING id", [tessOrg]);
await db.query(`INSERT INTO product_research (id, org_id, product_id, status, stage, input, error, created_at, finished_at)
                VALUES ($1, $2, $3, 'failed', 'reading', $4, 'docs.tessellate.io returned 403 to every fetch', $5, $6)`,
  [`rsh_demo${stamp}`, tessOrg, p.id, JSON.stringify({ prompt: "Serverless Postgres", website_url: "https://tessellate.io" }), daysAgo(1.7), daysAgo(1.6)]);
if (stripe) await subscribe(tess.org.slug, "price_mock_starter", "past_due");

// The `npm run demo:seed` account (if any): the whole funnel, reading reports, on the Growth plan.
const [demo] = await db.query<{ id: number; slug: string }>("SELECT id, slug FROM organizations WHERE slug LIKE 'demo-%' ORDER BY id DESC LIMIT 1");
let demoNote = "";
if (demo) {
  let user: string | null = null;
  if (clerkOn) {
    await admin.linkClerk(ACTOR, demo.slug);
    const inv = await admin.invite(ACTOR, demo.slug, "demo@demo.co", "admin");
    if (inv.invitation) { user = await accept((inv.invitation as any).id, "Dee"); people.push("demo@demo.co"); }
  }
  if (stripe) { await admin.ensureCustomer(ACTOR, demo.slug, "demo@demo.co"); await subscribe(demo.slug, "price_mock_growth", "active"); }
  await connect(demo.id, user, daysAgo(14.6), "claude-ai 0.1.0", true);
  for (const [d, tool] of [[14.5, "get_started"], [14.4, "onboard_product"], [13.9, "run_simulation"], [12, "get_visibility_report"], [1, "get_visibility_report"], [0.5, "search_transcripts"]] as const)
    await event(demo.id, user, daysAgo(d), "tools/call", tool, "claude-ai 0.1.0");
  demoNote = ` plus ${demo.slug} (from demo:seed) on the full funnel`;
}

console.log(`Seeded ${requests.length} pending requests, 1 declined, and 5 accounts across the funnel${demoNote}.`);
console.log(clerkOn
  ? `Mode: Clerk${stripe ? " + Stripe" : ""} (mock). People in the mock Clerk (API data only):\n  ${people.join("\n  ")}`
  : "Mode: legacy keys (Clerk and Stripe not configured).");
await db.close();
