// Fictional access requests and accounts at every onboarding stage, for a local look at the admin console (/admin).
// Run `npm run demo:seed` first for one account with real scored runs. Local previews and demos only.
//   npm run admin:demo
import { createOrg } from "../src/auth.js";
import { getDb } from "../src/db.js";

if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed demo data in production");
const db = await getDb();
const stamp = Date.now().toString(36).slice(-4);
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

const requests = [
  ["maya@relaybase.dev", "Relaybase", "https://relaybase.dev", "Webhooks infra for SaaS. Curious whether Claude Code picks us over Svix.", 0.2],
  ["dev@kitepay.io", "Kitepay", "kitepay.io", "Payments SDK for marketplaces.", 1.5],
  ["sam@quillsearch.com", "Quill Search", "https://quillsearch.com", null, 3],
  ["founders@inkwell.ai", "Inkwell", "https://inkwell.ai", "We make a document parsing API. Saw the Resend case study.", 6],
] as const;
for (const [email, company, url, msg, d] of requests)
  await db.query("INSERT INTO access_requests (email, company, product_url, message, created_at) VALUES ($1, $2, $3, $4, $5)", [email, company, url, msg, daysAgo(d)]);
await db.query("INSERT INTO access_requests (email, company, product_url, message, created_at, status, decided_at, admin_note) VALUES ($1, $2, $3, $4, $5, 'declined', $5, $6)",
  ["hello@cheapseo.biz", "Cheap SEO", "cheapseo.biz", "Can you rank us on ChatGPT?", daysAgo(4), "Not a developer tool"]);

const event = (orgId: number, at: Date, method: string, name: string | null, client: string, ok = true, error: string | null = null) =>
  db.query("INSERT INTO mcp_events (org_id, at, method, name, client, ok, error, ms) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [orgId, at, method, name, client, ok, error, Math.round(40 + Math.random() * 400)]);

async function account(name: string, email: string, createdDays: number, invitedDays: number | null) {
  const { org } = await createOrg(name, `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${stamp}`);
  await db.query("UPDATE organizations SET contact_email = $2, created_at = $3, invited_at = $4 WHERE id = $1",
    [org.orgId, email, daysAgo(createdDays), invitedDays == null ? null : daysAgo(invitedDays)]);
  await db.query("UPDATE api_keys SET label = $2, created_at = $3 WHERE org_id = $1", [org.orgId, email, daysAgo(createdDays)]);
  const [req] = await db.query<{ id: number }>(
    "INSERT INTO access_requests (email, company, created_at, status, decided_at, org_id) VALUES ($1, $2, $3, 'approved', $3, $4) RETURNING id",
    [email, name, daysAgo(createdDays + 0.5), org.orgId]);
  await db.query("INSERT INTO admin_audit (at, actor, action, org_id, detail) VALUES ($1, 'demo', 'request.approve', $2, $3)",
    [daysAgo(createdDays), org.orgId, JSON.stringify({ request_id: req.id, email, new_org: true })]);
  return org;
}

await account("Lumen Queue", "ops@lumenqueue.dev", 3, null);                         // key issued, invite never marked sent
await account("Ferrous", "team@ferrous.rs", 6, 5);                                   // invited, never connected
const parcel = await account("Parcel Labs", "eng@parcellabs.com", 4, 4);            // connected, tools never called
await event(parcel.orgId, daysAgo(3.2), "initialize", null, "claude-ai 0.1.0");
await event(parcel.orgId, daysAgo(3.2), "tools/list", null, "claude-ai 0.1.0");
const northwind = await account("Northwind Auth", "pat@northwindauth.com", 7, 7);  // using tools, no product yet
await event(northwind.orgId, daysAgo(6), "initialize", null, "cursor-vscode 1.0.0");
for (const [d, tool] of [[6, "get_started"], [5.9, "list_agents"], [4, "get_started"], [3.5, "browse_task_library"]] as const)
  await event(northwind.orgId, daysAgo(d), "tools/call", tool, "cursor-vscode 1.0.0");
const tess = await account("Tessellate DB", "cto@tessellate.io", 2, 2);           // onboarding research failed
await event(tess.orgId, daysAgo(1.8), "initialize", null, "openai-mcp 1.0.0");
await event(tess.orgId, daysAgo(1.8), "tools/call", "get_started", "openai-mcp 1.0.0");
await event(tess.orgId, daysAgo(1.7), "tools/call", "onboard_product", "openai-mcp 1.0.0");
for (const d of [1.2, 1.1, 0.9]) await event(tess.orgId, daysAgo(d), "tools/call", "get_onboarding", "openai-mcp 1.0.0", false, "Research failed: docs site returned 403 to the fetcher");
const [p] = await db.query<{ id: number }>("INSERT INTO products (org_id, slug, name, website_url) VALUES ($1, 'tessellate', 'Tessellate', 'https://tessellate.io') RETURNING id", [tess.orgId]);
await db.query(`INSERT INTO product_research (id, org_id, product_id, status, stage, input, error, created_at, finished_at)
                VALUES ($1, $2, $3, 'failed', 'reading', $4, 'docs.tessellate.io returned 403 to every fetch', $5, $6)`,
  [`rsh_demo${stamp}`, tess.orgId, p.id, JSON.stringify({ prompt: "Serverless Postgres", website_url: "https://tessellate.io" }), daysAgo(1.7), daysAgo(1.6)]);

// The `npm run demo:seed` account (if any) read its report: the end of the funnel.
const demo = await db.query<{ id: number }>("SELECT id FROM organizations WHERE slug LIKE 'demo-%' ORDER BY id DESC LIMIT 1");
if (demo.length) {
  await db.query("UPDATE organizations SET contact_email = 'demo@demo.co', invited_at = now() - interval '15 days' WHERE id = $1", [demo[0].id]);
  for (const [d, tool] of [[14.5, "get_started"], [14.4, "onboard_product"], [13.9, "run_simulation"], [12, "get_visibility_report"], [1, "get_visibility_report"], [0.5, "search_transcripts"]] as const)
    await event(demo[0].id, daysAgo(d), "tools/call", tool, "claude-ai 0.1.0");
  await event(demo[0].id, daysAgo(14.6), "initialize", null, "claude-ai 0.1.0");
}
console.log(`Seeded ${requests.length} pending requests and 5 accounts across the funnel${demo.length ? " (plus the demo:seed account)" : ""}.`);
await db.close();
