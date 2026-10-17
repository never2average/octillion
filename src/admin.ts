/**
 * Onboarding admin console (/admin): the work between "someone asked for access" and "they read their first report".
 * Triage access requests, create organizations and per-user API keys, hand out the connector link with per-client
 * setup, see where each account is in the funnel and who is stuck, and rotate or revoke keys. Every change is
 * written to admin_audit. Keys are returned once, at creation, and never stored or logged (only their prefix).
 */
import { createApiKey, createOrg, slugify } from "./auth.js";
import { getDb } from "./db.js";
import { config } from "./queries.js";

export class AdminError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const publicUrl = () => (process.env.PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3333}`).replace(/\/$/, "");

async function audit(actor: string, action: string, orgId: number | null, detail: Record<string, unknown> = {}) {
  await (await getDb()).query("INSERT INTO admin_audit (actor, action, org_id, detail) VALUES ($1, $2, $3, $4)",
    [actor.slice(0, 80) || "admin", action, orgId, JSON.stringify(detail)]);
}

// ---------- onboarding funnel ----------

/** In order. An org's stage is the furthest step it has reached; `next` is what it has to do after that. */
export const STAGES = [
  { id: "created", label: "Key issued", next: "Send the invite with the connector link" },
  { id: "invited", label: "Invited", next: "Add the connector in Claude, ChatGPT or an IDE" },
  { id: "connected", label: "Connected", next: "Ask: \"Get me started with Octillion\"" },
  { id: "first_call", label: "First tool call", next: "Onboard a product (name, website, docs)" },
  { id: "onboarded", label: "Product onboarded", next: "Run a simulation" },
  { id: "simulated", label: "Simulation run", next: "Open the visibility report" },
  { id: "reported", label: "Report read", next: "Act on the report and re-run" },
] as const;
export type StageId = (typeof STAGES)[number]["id"];

interface OrgFacts {
  id: number; slug: string; name: string; contact_email: string | null; notes: string | null;
  created_at: Date; invited_at: Date | null; active_keys: number; revoked_keys: number; key_last_used: Date | null;
  first_seen: Date | null; last_seen: Date | null; first_call_at: Date | null; onboarded_at: Date | null;
  onboarding_running: number; onboarding_failed: number; first_sim_at: Date | null; sims_running: number;
  first_report_at: Date | null; calls_7d: number; errors_7d: number; month_spend_usd: number; requests: number;
}

const ORG_FACTS = `
  SELECT o.id, o.slug, o.name, o.contact_email, o.notes, o.created_at, o.invited_at,
    (SELECT count(*) FROM api_keys k WHERE k.org_id = o.id AND k.revoked_at IS NULL) AS active_keys,
    (SELECT count(*) FROM api_keys k WHERE k.org_id = o.id AND k.revoked_at IS NOT NULL) AS revoked_keys,
    (SELECT max(k.last_used_at) FROM api_keys k WHERE k.org_id = o.id) AS key_last_used,
    (SELECT min(e.at) FROM mcp_events e WHERE e.org_id = o.id) AS first_seen,
    (SELECT max(e.at) FROM mcp_events e WHERE e.org_id = o.id) AS last_seen,
    (SELECT min(e.at) FROM mcp_events e WHERE e.org_id = o.id AND e.method = 'tools/call' AND e.ok) AS first_call_at,
    (SELECT min(r.finished_at) FROM product_research r WHERE r.org_id = o.id AND r.status = 'completed') AS onboarded_at,
    (SELECT count(*) FROM product_research r WHERE r.org_id = o.id AND r.status IN ('queued', 'running')) AS onboarding_running,
    (SELECT count(*) FROM product_research r WHERE r.org_id = o.id AND r.status = 'failed') AS onboarding_failed,
    (SELECT min(s.created_at) FROM simulations s WHERE s.org_id = o.id) AS first_sim_at,
    (SELECT count(*) FROM simulations s WHERE s.org_id = o.id AND s.status IN ('queued', 'running')) AS sims_running,
    (SELECT min(e.at) FROM mcp_events e WHERE e.org_id = o.id AND e.name = 'get_visibility_report' AND e.ok) AS first_report_at,
    (SELECT count(*) FROM mcp_events e WHERE e.org_id = o.id AND e.method = 'tools/call' AND e.at > now() - interval '7 days') AS calls_7d,
    (SELECT count(*) FROM mcp_events e WHERE e.org_id = o.id AND NOT e.ok AND e.at > now() - interval '7 days') AS errors_7d,
    (SELECT coalesce(sum(u.cost_usd), 0) FROM gateway_usage u JOIN agent_sessions a ON a.id = u.session_id
      WHERE a.org_id = o.id AND a.queued_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS month_spend_usd,
    (SELECT count(*) FROM access_requests q WHERE q.org_id = o.id) AS requests
  FROM organizations o`;

const DAY = 86_400_000;
const ago = (d: Date | null) => (d ? (Date.now() - new Date(d).getTime()) / DAY : null);

function stageOf(f: OrgFacts): StageId {
  if (f.first_report_at) return "reported";
  if (f.first_sim_at) return "simulated";
  if (f.onboarded_at) return "onboarded";
  if (f.first_call_at) return "first_call";
  if (f.first_seen) return "connected";
  if (f.invited_at) return "invited";
  return "created";
}

/** Why an account needs a person to look at it, most urgent first. Empty when it is moving on its own. */
function attentionOf(f: OrgFacts, stage: StageId, budget: number): string[] {
  const out: string[] = [];
  if (Number(f.active_keys) === 0) out.push("No active API key: the account cannot connect");
  if (Number(f.onboarding_failed) && !f.onboarded_at) out.push("Product onboarding failed");
  if (Number(f.errors_7d) >= 3) out.push(`${f.errors_7d} tool errors in the last 7 days`);
  if (budget > 0 && Number(f.month_spend_usd) >= budget * 0.8)
    out.push(`At ${Math.round((Number(f.month_spend_usd) / budget) * 100)}% of the monthly model budget`);
  const since = (d: Date | null) => Math.floor(ago(d) ?? 0);
  if (stage === "created" && since(f.created_at) >= 1) out.push(`Key issued ${since(f.created_at)}d ago, invite not marked as sent`);
  if (stage === "invited" && since(f.invited_at) >= 2) out.push(`Invited ${since(f.invited_at)}d ago, never connected`);
  if (stage === "connected" && since(f.first_seen) >= 1) out.push("Connected but never called a tool (tools may be switched off in the client)");
  if (stage === "first_call" && !Number(f.onboarding_running) && since(f.first_call_at) >= 2) out.push("Using tools but has not onboarded a product");
  if (stage === "onboarded" && since(f.onboarded_at) >= 2) out.push("Product onboarded, no simulation yet");
  if (stage === "simulated" && !Number(f.sims_running) && since(f.first_sim_at) >= 2) out.push("Simulation ran, report never opened");
  return out;
}

function shapeOrg(f: OrgFacts, budget: number) {
  const stage = stageOf(f);
  const i = STAGES.findIndex((s) => s.id === stage);
  return {
    id: f.id, slug: f.slug, name: f.name, contact_email: f.contact_email, notes: f.notes, created_at: f.created_at,
    invited_at: f.invited_at, stage, stage_index: i, stage_label: STAGES[i].label, next_step: STAGES[i].next,
    reached: { created: f.created_at, invited: f.invited_at, connected: f.first_seen, first_call: f.first_call_at,
               onboarded: f.onboarded_at, simulated: f.first_sim_at, reported: f.first_report_at },
    active_keys: Number(f.active_keys), revoked_keys: Number(f.revoked_keys), key_last_used: f.key_last_used,
    last_seen: f.last_seen, calls_7d: Number(f.calls_7d), errors_7d: Number(f.errors_7d),
    onboarding_running: Number(f.onboarding_running), sims_running: Number(f.sims_running),
    month_spend_usd: Number(f.month_spend_usd), budget_usd: budget, attention: attentionOf(f, stage, budget),
  };
}
export type AdminOrg = ReturnType<typeof shapeOrg>;

export async function listOrgs(): Promise<AdminOrg[]> {
  const rows = await (await getDb()).query<OrgFacts>(`${ORG_FACTS} ORDER BY o.created_at DESC`);
  const budget = config.orgMonthlyBudgetUsd();
  return rows.map((r) => shapeOrg(r, budget));
}

async function orgBySlug(slug: string) {
  const [f] = await (await getDb()).query<OrgFacts>(`${ORG_FACTS} WHERE o.slug = $1`, [slug]);
  if (!f) throw new AdminError(`No organization ${slug}`, 404);
  return shapeOrg(f, config.orgMonthlyBudgetUsd());
}

export async function overview() {
  const db = await getDb();
  const orgs = await listOrgs();
  const [req] = await db.query<{ pending: number; approved: number; declined: number; oldest_pending: Date | null }>(
    `SELECT count(*) FILTER (WHERE status = 'pending') AS pending, count(*) FILTER (WHERE status = 'approved') AS approved,
            count(*) FILTER (WHERE status = 'declined') AS declined, min(created_at) FILTER (WHERE status = 'pending') AS oldest_pending
       FROM access_requests`);
  return {
    public_url: publicUrl(),
    requests: { pending: Number(req.pending), approved: Number(req.approved), declined: Number(req.declined), oldest_pending: req.oldest_pending },
    // Funnel: how many accounts reached each step (cumulative), so drop-off between steps is visible.
    funnel: STAGES.map((s, i) => ({ id: s.id, label: s.label, reached: orgs.filter((o) => o.stage_index >= i).length })),
    attention: orgs.filter((o) => o.attention.length).map((o) => ({ slug: o.slug, name: o.name, stage_label: o.stage_label, attention: o.attention })),
    active_7d: orgs.filter((o) => o.calls_7d > 0).length,
    orgs: orgs.length,
  };
}

export async function orgDetail(slug: string) {
  const org = await orgBySlug(slug);
  const db = await getDb();
  const [keys, tools, clients, errors, recent, products, research, sims, requests, log] = await Promise.all([
    db.query(`SELECT id, label, key_prefix, created_at, last_used_at, revoked_at FROM api_keys WHERE org_id = $1
               ORDER BY revoked_at IS NOT NULL, created_at DESC`, [org.id]),
    db.query(`SELECT name, count(*) AS calls, count(*) FILTER (WHERE NOT ok) AS errors, round(avg(ms)) AS avg_ms, max(at) AS last
                FROM mcp_events WHERE org_id = $1 AND method = 'tools/call' GROUP BY name ORDER BY max(at) DESC`, [org.id]),
    db.query(`SELECT client, count(*) AS n, max(at) AS last FROM mcp_events WHERE org_id = $1 AND client IS NOT NULL
               GROUP BY client ORDER BY max(at) DESC LIMIT 8`, [org.id]),
    db.query(`SELECT at, method, name, error FROM mcp_events WHERE org_id = $1 AND NOT ok ORDER BY at DESC LIMIT 10`, [org.id]),
    db.query(`SELECT at, method, name, client, ok, ms FROM mcp_events WHERE org_id = $1 ORDER BY at DESC LIMIT 25`, [org.id]),
    db.query(`SELECT slug, name, website_url, created_at FROM products WHERE org_id = $1 ORDER BY created_at`, [org.id]),
    db.query(`SELECT r.id, p.name AS product, r.status, r.stage, r.error, r.created_at, r.finished_at
                FROM product_research r JOIN products p ON p.id = r.product_id WHERE r.org_id = $1 ORDER BY r.created_at DESC LIMIT 10`, [org.id]),
    db.query(`SELECT s.id, s.name, s.status, s.created_at, s.finished_at,
                     (SELECT count(*) FROM agent_sessions a WHERE a.simulation_id = s.id) AS sessions,
                     (SELECT count(*) FROM agent_sessions a WHERE a.simulation_id = s.id AND a.status = 'completed') AS completed
                FROM simulations s WHERE s.org_id = $1 ORDER BY s.created_at DESC LIMIT 10`, [org.id]),
    db.query(`SELECT id, email, company, created_at, status FROM access_requests WHERE org_id = $1 ORDER BY created_at`, [org.id]),
    db.query(`SELECT at, actor, action, detail FROM admin_audit WHERE org_id = $1 ORDER BY at DESC LIMIT 30`, [org.id]),
  ]);
  return { org, keys, tools, clients, errors, recent, products, research, simulations: sims, requests, audit: log };
}

// ---------- access requests ----------

export async function listRequests(status?: string) {
  if (status && !["pending", "approved", "declined"].includes(status)) throw new AdminError("status must be pending, approved or declined");
  return (await getDb()).query(
    `SELECT q.id, q.email, q.company, q.product_url, q.message, q.created_at, q.status, q.decided_at, q.admin_note,
            o.slug AS org_slug, o.name AS org_name
       FROM access_requests q LEFT JOIN organizations o ON o.id = q.org_id
      WHERE $1::text IS NULL OR q.status = $1
      ORDER BY q.status = 'pending' DESC, q.created_at DESC LIMIT 500`, [status ?? null]);
}

const intId = (v: number) => {
  if (!Number.isSafeInteger(v) || v <= 0) throw new AdminError("Invalid id");
  return v;
};

async function requestById(id: number) {
  intId(id);
  const [r] = await (await getDb()).query<{ id: number; email: string; company: string; product_url: string | null; status: string }>(
    "SELECT id, email, company, product_url, status FROM access_requests WHERE id = $1", [id]);
  if (!r) throw new AdminError(`No access request ${id}`, 404);
  return r;
}

const cleanEmail = (v: unknown) => {
  if (v == null || v === "") return null;
  const s = String(v).trim().slice(0, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new AdminError("contact_email is not a valid email");
  return s;
};

/** A ready-to-send invite: the connector URL, per-client setup, and a message to paste into an email. */
export function invite(org: { name: string }, key: string, email?: string | null) {
  const base = publicUrl();
  const url = `${base}/mcp/${key}`;
  const clients = [
    { client: "Claude (web or desktop)", steps: "Settings → Connectors → Add custom connector, paste the link. On Team/Enterprise an owner adds it under Organization settings → Connectors." },
    { client: "ChatGPT", steps: "Add a custom MCP server (developer mode), paste the link, choose No authentication. Business/Enterprise/Edu admins may need to allow custom MCP." },
    { client: "Claude Code", steps: "Add to .mcp.json:", snippet: JSON.stringify({ mcpServers: { octillion: { type: "http", url } } }, null, 2) },
    { client: "Cursor and other IDEs", steps: "Paste the link into the MCP settings and switch the Octillion tools on." },
    { client: "Header-capable clients", steps: `POST ${base}/mcp with the header:`, snippet: `Authorization: Bearer ${key}` },
  ];
  const subject = `Your Octillion access`;
  const body = `Hi${email ? "" : " there"},

${org.name} now has access to Octillion. Your personal connector link is:

${url}

It is your login: anyone with it can use your account, so keep it private.

Connect it:
- Claude: Settings → Connectors → Add custom connector, paste the link.
- ChatGPT: add a custom MCP server with the link and choose No authentication.
- Claude Code: {"mcpServers": {"octillion": {"type": "http", "url": "${url}"}}} in .mcp.json
- Cursor and other IDEs: paste the link into the MCP settings and switch the Octillion tools on.

Then type: "Get me started with Octillion." The beta guide: ${base}/connect

Reply to this email with anything that gets in your way.`;
  return { connector_url: url, clients, email: { to: email ?? null, subject, body,
    mailto: email ? `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` : null } };
}

const prefixOf = (key: string) => key.slice(0, 10);

/**
 * Approve a request: a new organization (name and slug default to the company), or, with `org_slug`, another
 * user of an existing one, who gets their own key labelled with their email so it can be revoked on its own.
 */
export async function approveRequest(actor: string, id: number, opts: { name?: string; slug?: string; org_slug?: string; note?: string } = {}) {
  const r = await requestById(id);
  if (r.status === "approved") throw new AdminError("This request is already approved", 409);
  const db = await getDb();
  let org: { id: number; slug: string; name: string }, key: string, created = false;
  if (opts.org_slug) {
    const [o] = await db.query<{ id: number; slug: string; name: string }>("SELECT id, slug, name FROM organizations WHERE slug = $1", [opts.org_slug]);
    if (!o) throw new AdminError(`No organization ${opts.org_slug}`, 404);
    org = o;
    key = await createApiKey(o.id, r.email);
  } else {
    const name = (opts.name ?? r.company).trim().slice(0, 200);
    if (!name) throw new AdminError("name is required");
    const slug = slugify(opts.slug || name);
    if ((await db.query("SELECT 1 FROM organizations WHERE slug = $1", [slug])).length)
      throw new AdminError(`The slug ${slug} is taken: pick another, or add this person to that organization`, 409);
    const made = await createOrg(name, slug);
    org = { id: made.org.orgId, slug: made.org.slug, name: made.org.name };
    key = made.key;
    created = true;
    await db.query("UPDATE organizations SET contact_email = $2 WHERE id = $1", [org.id, r.email]);
    await db.query("UPDATE api_keys SET label = $2 WHERE org_id = $1", [org.id, r.email]);
  }
  await db.query("UPDATE access_requests SET status = 'approved', org_id = $2, decided_at = now(), admin_note = coalesce($3, admin_note) WHERE id = $1",
    [id, org.id, opts.note ?? null]);
  await audit(actor, "request.approve", org.id, { request_id: id, email: r.email, new_org: created, key_prefix: prefixOf(key) });
  return { org: { slug: org.slug, name: org.name }, created, key, ...invite(org, key, r.email) };
}

export async function declineRequest(actor: string, id: number, note?: string) {
  const r = await requestById(id);
  if (r.status === "approved") throw new AdminError("Approved requests cannot be declined: revoke the key instead", 409);
  await (await getDb()).query("UPDATE access_requests SET status = 'declined', decided_at = now(), admin_note = $2 WHERE id = $1", [id, note ?? null]);
  await audit(actor, "request.decline", null, { request_id: id, email: r.email, note: note ?? null });
}

export async function reopenRequest(actor: string, id: number) {
  const r = await requestById(id);
  if (r.status !== "declined") throw new AdminError("Only declined requests can be reopened", 409);
  await (await getDb()).query("UPDATE access_requests SET status = 'pending', decided_at = NULL WHERE id = $1", [id]);
  await audit(actor, "request.reopen", null, { request_id: id, email: r.email });
}

// ---------- organizations and keys ----------

export async function createOrgManually(actor: string, input: { name?: string; slug?: string; contact_email?: string; notes?: string }) {
  const name = String(input.name ?? "").trim().slice(0, 200);
  if (!name) throw new AdminError("name is required");
  const email = cleanEmail(input.contact_email);
  const slug = slugify(input.slug || name);
  const db = await getDb();
  if ((await db.query("SELECT 1 FROM organizations WHERE slug = $1", [slug])).length) throw new AdminError(`The slug ${slug} is taken`, 409);
  const { org, key } = await createOrg(name, slug);
  await db.query("UPDATE organizations SET contact_email = $2, notes = $3 WHERE id = $1", [org.orgId, email, input.notes?.slice(0, 4000) || null]);
  if (email) await db.query("UPDATE api_keys SET label = $2 WHERE org_id = $1", [org.orgId, email]);
  await audit(actor, "org.create", org.orgId, { key_prefix: prefixOf(key) });
  return { org: { slug: org.slug, name: org.name }, created: true, key, ...invite(org, key, email) };
}

export async function updateOrg(actor: string, slug: string, input: { name?: string; contact_email?: string | null; notes?: string | null }) {
  const org = await orgBySlug(slug);
  const sets: string[] = [], vals: unknown[] = [org.id];
  const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (input.name !== undefined) {
    const n = String(input.name).trim().slice(0, 200);
    if (!n) throw new AdminError("name cannot be empty");
    set("name", n);
  }
  if (input.contact_email !== undefined) set("contact_email", cleanEmail(input.contact_email));
  if (input.notes !== undefined) set("notes", input.notes ? String(input.notes).slice(0, 4000) : null);
  if (!sets.length) throw new AdminError("Nothing to update");
  await (await getDb()).query(`UPDATE organizations SET ${sets.join(", ")} WHERE id = $1`, vals);
  await audit(actor, "org.update", org.id, { fields: Object.keys(input) });
  return orgBySlug(slug);
}

export async function markInvited(actor: string, slug: string, invited = true) {
  const org = await orgBySlug(slug);
  await (await getDb()).query("UPDATE organizations SET invited_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1", [org.id, invited]);
  await audit(actor, invited ? "org.invited" : "org.invite_cleared", org.id);
  return orgBySlug(slug);
}

export async function issueKey(actor: string, slug: string, label?: string) {
  const org = await orgBySlug(slug);
  const l = String(label ?? "").trim().slice(0, 200) || org.contact_email || "extra";
  const key = await createApiKey(org.id, l);
  await audit(actor, "key.create", org.id, { label: l, key_prefix: prefixOf(key) });
  return { org: { slug: org.slug, name: org.name }, created: false, key, ...invite(org, key, l.includes("@") ? l : org.contact_email) };
}

async function keyOf(slug: string, keyId: number) {
  intId(keyId);
  const org = await orgBySlug(slug);
  const [k] = await (await getDb()).query<{ id: number; label: string; key_prefix: string; revoked_at: Date | null }>(
    "SELECT id, label, key_prefix, revoked_at FROM api_keys WHERE id = $1 AND org_id = $2", [keyId, org.id]);
  if (!k) throw new AdminError(`No key ${keyId} in ${slug}`, 404);
  return { org, k };
}

export async function revokeKey(actor: string, slug: string, keyId: number) {
  const { org, k } = await keyOf(slug, keyId);
  if (k.revoked_at) throw new AdminError("This key is already revoked", 409);
  await (await getDb()).query("UPDATE api_keys SET revoked_at = now() WHERE id = $1", [k.id]);
  await audit(actor, "key.revoke", org.id, { label: k.label, key_prefix: k.key_prefix });
}

/** Revoke a key and issue its replacement under the same label (a leaked link, a person leaving and rejoining). */
export async function rotateKey(actor: string, slug: string, keyId: number) {
  const { org, k } = await keyOf(slug, keyId);
  const db = await getDb();
  if (!k.revoked_at) await db.query("UPDATE api_keys SET revoked_at = now() WHERE id = $1", [k.id]);
  const key = await createApiKey(org.id, k.label);
  await audit(actor, "key.rotate", org.id, { label: k.label, old_prefix: k.key_prefix, key_prefix: prefixOf(key) });
  return { org: { slug: org.slug, name: org.name }, created: false, key, ...invite(org, key, k.label.includes("@") ? k.label : org.contact_email) };
}

export async function auditLog(limit = 200) {
  return (await getDb()).query(
    `SELECT a.at, a.actor, a.action, a.detail, o.slug AS org_slug, o.name AS org_name
       FROM admin_audit a LEFT JOIN organizations o ON o.id = a.org_id ORDER BY a.at DESC LIMIT $1`, [Math.min(1000, Math.max(1, limit))]);
}
