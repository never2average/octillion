/**
 * GTM › Campaigns (/admin/gtm/campaigns): lifecycle email to people who already gave Octillion their address. The
 * audience is a saved filter over accounts (their active members in Clerk) and access requests (the requester), never
 * an imported or cold list. Owners only (admin-roles.ts "campaigns"); every GET is any admin's, as everywhere.
 *
 *   model       gtm_campaigns (migration 0008): name, audience, steps [{subject, body, delay_days}] with {{first_name}}
 *               and {{product}}, status draft -> scheduled -> running <-> paused -> done, rolling enrolment, the owner
 *   recipients  enrolled when a campaign starts (and on every tick while it runs, when rolling): one row per address.
 *               gtm_campaign_recipients is the ONLY place a recipient's email address is stored. email_log keeps the
 *               transactional rule (a hash and the domain, src/email.ts), and email_suppressions keeps a hash.
 *   sending     through src/email.ts (Resend), from campaignTick(): the Vercel cron (/api/cron/autoscale, every 5
 *               minutes) and, on a VM, startCampaignTicker(). Idempotent: a recipient is leased before it is sent, a
 *               (recipient, step) row in gtm_campaign_sends is claimed once (UNIQUE), and Resend gets an
 *               Idempotency-Key naming the campaign, recipient and step. Rate-limited: at most CAMPAIGN_SENDS_PER_TICK
 *               (100) a tick, CAMPAIGN_SEND_INTERVAL_MS (600 ms, under Resend's 2 a second) apart.
 *   opt-out     every email carries an unsubscribe link (a token signed with a key derived from OCTILLION_VAULT_KEY,
 *               GET shows a confirm button, POST unsubscribes: RFC 8058 one-click) and List-Unsubscribe headers. The
 *               suppression list (unsubscribed, hard bounce, complaint, by hand) is checked before every send.
 *   metrics     recipients, sent, delivered / bounced / opened / clicked (Resend webhooks, POST /api/webhooks/resend,
 *               Svix-signed with the key vault's resend_webhook secret), unsubscribed, and conversions within
 *               conversion_days of the first email: requested access, activated (first simulation), paid (src/gtm.ts).
 */
import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "./db.js";
import * as mail from "./email.js";
import { accountPeople, AdminError, log, STAGES } from "./admin.js";
import { DIRECT, journeys, within, type Journey, type RequestRow } from "./gtm.js";
import { useCredential } from "./keyvault.js";
import { capture } from "./telemetry.js";

export const STATUSES = ["draft", "scheduled", "running", "paused", "done"] as const;
export type CampaignStatus = (typeof STATUSES)[number];
export const VARIABLES = ["first_name", "product"] as const;
export const WEBHOOK_PROVIDER = "resend_webhook";
const REQUEST_STATUSES = ["pending", "approved", "declined"];
const MAX_STEPS = 10;

// ---------- the model ----------

export interface Audience {
  /** accounts: their active members (Clerk), else the account's approved requesters; requests: the requester. */
  include: "accounts" | "requests" | "both";
  stages: string[]; attention: string; created_from: string | null; created_to: string | null;
  utm_source: string; utm_medium: string; utm_campaign: string; plans: string[]; request_status: string[];
  /** Account slugs: a one-off nudge to named accounts (Activation's "Email a nudge"). */
  accounts: string[];
}
export interface Step { subject: string; body: string; delay_days: number }

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const strs = (v: unknown, max = 200) => [...new Set((Array.isArray(v) ? v : v == null || v === "" ? [] : [v]).map((x) => String(x).trim()).filter(Boolean))].slice(0, max);
const day = (v: unknown, what: string) => {
  if (v == null || v === "") return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new AdminError(`${what} must be a date, YYYY-MM-DD`);
  return v;
};

export function parseAudience(v: unknown): Audience {
  const a = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const include = a.include == null || a.include === "" ? "accounts" : a.include;
  if (include !== "accounts" && include !== "requests" && include !== "both") throw new AdminError("audience.include must be accounts, requests or both");
  const stages = strs(a.stages);
  const bad = stages.find((s) => !STAGES.some((x) => x.id === s));
  if (bad) throw new AdminError(`Unknown stage ${bad}: use ${STAGES.map((s) => s.id).join(", ")}`);
  const request_status = strs(a.request_status);
  if (request_status.some((s) => !REQUEST_STATUSES.includes(s))) throw new AdminError("audience.request_status takes pending, approved and declined");
  const out: Audience = {
    include, stages, attention: str(a.attention, 200), created_from: day(a.created_from, "audience.created_from"), created_to: day(a.created_to, "audience.created_to"),
    utm_source: str(a.utm_source, 200), utm_medium: str(a.utm_medium, 200), utm_campaign: str(a.utm_campaign, 200), plans: strs(a.plans), request_status,
    accounts: strs(a.accounts, 500),
  };
  if (out.created_from && out.created_to && out.created_to < out.created_from) throw new AdminError("audience.created_to is before created_from");
  return out;
}

const VAR = /\{\{\s*([a-zA-Z_]+)\s*\}\}/g;
export function parseSteps(v: unknown): Step[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new AdminError("steps must be a list");
  if (v.length > MAX_STEPS) throw new AdminError(`At most ${MAX_STEPS} steps`);
  return v.map((x, i) => {
    const s = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const subject = str(s.subject, 200).replace(/[\r\n]+/g, " "), body = str(s.body, 20_000);
    if (!subject || !body) throw new AdminError(`Step ${i + 1} needs a subject and a body`);
    const delay = s.delay_days == null || s.delay_days === "" ? (i ? 3 : 0) : Number(s.delay_days);
    if (!Number.isInteger(delay) || delay < 0 || delay > 365) throw new AdminError(`Step ${i + 1}: delay_days is a whole number of days, 0 to 365`);
    for (const m of `${subject}\n${body}`.matchAll(VAR))
      if (!(VARIABLES as readonly string[]).includes(m[1])) throw new AdminError(`Step ${i + 1}: unknown variable {{${m[1]}}}; use ${VARIABLES.map((x) => `{{${x}}}`).join(" or ")}`);
    return { subject, body, delay_days: delay };
  });
}

/** {{first_name}} and {{product}}; a missing value reads naturally ("there", "your product"). */
export function render(t: string, vars: { first_name?: string | null; product?: string | null }) {
  const values: Record<string, string> = { first_name: vars.first_name?.trim() || "there", product: vars.product?.trim() || "your product" };
  return t.replace(VAR, (_m, k: string) => values[k] ?? "");
}

interface CampaignRow {
  id: number; name: string; audience: Audience; steps: Step[]; status: CampaignStatus; rolling: boolean; conversion_days: number; starts_at: Date | null;
  owner: string; owner_user_id: string | null; created_at: Date; updated_at: Date; launched_at: Date | null; enrolled_at: Date | null; finished_at: Date | null;
}
const COLS = "id, name, audience, steps, status, rolling, conversion_days, starts_at, owner, owner_user_id, created_at, updated_at, launched_at, enrolled_at, finished_at";
const idOf = (v: unknown) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new AdminError("Invalid campaign id");
  return n;
};
async function campaignById(id: number): Promise<CampaignRow> {
  const [c] = await (await getDb()).query<CampaignRow>(`SELECT ${COLS} FROM gtm_campaigns WHERE id = $1`, [idOf(id)]);
  if (!c) throw new AdminError(`No campaign ${id}`, 404);
  return { ...c, id: Number(c.id), audience: parseAudienceSafe(c.audience), steps: Array.isArray(c.steps) ? c.steps : [] };
}
const parseAudienceSafe = (a: unknown) => { try { return parseAudience(a); } catch { return parseAudience({}); } };

function fields(body: Record<string, unknown>, partial: boolean) {
  const out: Partial<Pick<CampaignRow, "name" | "audience" | "steps" | "rolling" | "conversion_days">> = {};
  if (!partial || body.name !== undefined) {
    const name = str(body.name, 120);
    if (!name) throw new AdminError("Give the campaign a name");
    out.name = name;
  }
  if (!partial || body.audience !== undefined) out.audience = parseAudience(body.audience);
  if (!partial || body.steps !== undefined) out.steps = parseSteps(body.steps);
  if (!partial || body.rolling !== undefined) out.rolling = body.rolling === true;
  if (!partial || body.conversion_days !== undefined) {
    const n = body.conversion_days == null || body.conversion_days === "" ? 14 : Number(body.conversion_days);
    if (!Number.isInteger(n) || n < 1 || n > 365) throw new AdminError("conversion_days is 1 to 365");
    out.conversion_days = n;
  }
  return out;
}

export async function createCampaign(actor: string, ownerUserId: string | null, body: Record<string, unknown>) {
  const f = fields(body, false);
  const [row] = await (await getDb()).query<{ id: number }>(
    `INSERT INTO gtm_campaigns (name, audience, steps, rolling, conversion_days, owner, owner_user_id) VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6, $7) RETURNING id`,
    [f.name, JSON.stringify(f.audience), JSON.stringify(f.steps), f.rolling, f.conversion_days, actor, ownerUserId]);
  log(actor, "campaign.create", null, { campaign_id: Number(row.id), steps: f.steps!.length });
  return campaignDetail(Number(row.id));
}

/** Edits: a draft, a scheduled one before it starts, or a paused one (its steps change for whoever has not had them yet). */
export async function updateCampaign(actor: string, id: number, body: Record<string, unknown>) {
  const c = await campaignById(id);
  if (!["draft", "scheduled", "paused"].includes(c.status)) throw new AdminError(`A ${c.status} campaign cannot be edited: pause it first`, 409);
  const f = fields(body, true);
  await (await getDb()).query(
    `UPDATE gtm_campaigns SET name = coalesce($2, name), audience = coalesce($3::jsonb, audience), steps = coalesce($4::jsonb, steps),
            rolling = coalesce($5, rolling), conversion_days = coalesce($6, conversion_days), updated_at = now() WHERE id = $1`,
    [c.id, f.name ?? null, f.audience ? JSON.stringify(f.audience) : null, f.steps ? JSON.stringify(f.steps) : null, f.rolling ?? null, f.conversion_days ?? null]);
  log(actor, "campaign.update", null, { campaign_id: c.id, fields: Object.keys(f) });
  return campaignDetail(c.id);
}

/** Start now, or at `at` (ISO time) when it is in the future. Enrolment happens when it starts. */
export async function launchCampaign(actor: string, id: number, body: { at?: unknown } = {}) {
  const c = await campaignById(id);
  if (c.status !== "draft") throw new AdminError(c.status === "paused" ? "This campaign is paused: resume it" : `This campaign is already ${c.status}`, 409);
  if (!c.steps.length) throw new AdminError("Add at least one email before launching");
  const at = body.at ? new Date(String(body.at)) : null;
  if (at && Number.isNaN(at.getTime())) throw new AdminError("at must be a date and time");
  const db = await getDb();
  if (at && at.getTime() > Date.now() + 60_000) {
    await db.query("UPDATE gtm_campaigns SET status = 'scheduled', starts_at = $2, updated_at = now() WHERE id = $1", [c.id, at]);
    log(actor, "campaign.schedule", null, { campaign_id: c.id, starts_at: at.toISOString() });
  } else {
    await db.query("UPDATE gtm_campaigns SET status = 'running', starts_at = now(), launched_at = now(), updated_at = now() WHERE id = $1", [c.id]);
    await enroll(c.id);
    log(actor, "campaign.launch", null, { campaign_id: c.id });
  }
  return campaignDetail(c.id);
}

export async function setCampaignState(actor: string, id: number, action: "pause" | "resume" | "end") {
  const c = await campaignById(id);
  const db = await getDb();
  if (action === "pause") {
    if (!["running", "scheduled"].includes(c.status)) throw new AdminError(`Only a running or scheduled campaign can be paused (this one is ${c.status})`, 409);
    await db.query("UPDATE gtm_campaigns SET status = 'paused', updated_at = now() WHERE id = $1", [c.id]);
  } else if (action === "resume") {
    if (c.status !== "paused") throw new AdminError("Only a paused campaign can be resumed", 409);
    if (!c.steps.length) throw new AdminError("Add at least one email before resuming");
    // Paused before it ever started: it starts now (and enrolls on this tick).
    await db.query("UPDATE gtm_campaigns SET status = 'running', launched_at = coalesce(launched_at, now()), updated_at = now() WHERE id = $1", [c.id]);
    if (!c.enrolled_at) await enroll(c.id);
  } else {
    if (c.status === "done") throw new AdminError("This campaign is already done", 409);
    await db.query("UPDATE gtm_campaigns SET status = 'done', finished_at = now(), updated_at = now() WHERE id = $1", [c.id]);
  }
  log(actor, `campaign.${action}`, null, { campaign_id: c.id });
  return campaignDetail(c.id);
}

/** Delete a draft or a finished campaign (its recipients and sends go with it; suppressions stay). */
export async function deleteCampaign(actor: string, id: number) {
  const c = await campaignById(id);
  if (!["draft", "done"].includes(c.status)) throw new AdminError("End the campaign before deleting it", 409);
  await (await getDb()).query("DELETE FROM gtm_campaigns WHERE id = $1", [c.id]);
  log(actor, "campaign.delete", null, { campaign_id: c.id });
}

// ---------- the audience ----------

export interface Candidate {
  email: string; first_name: string | null; product: string | null; source: "account" | "request";
  org_id: number | null; org_slug: string | null; org_name: string | null; request_id: number | null;
}
const firstName = (n: string | null | undefined) => n?.trim().split(/\s+/)[0] || null;

/** Everyone the audience matches now, one per address (an account's member before the same person's request). */
export async function resolveAudience(a: Audience, data?: Awaited<ReturnType<typeof journeys>>): Promise<Candidate[]> {
  const { journeys: js, requests } = data ?? (await journeys());
  const fromT = a.created_from ? Date.parse(`${a.created_from}T00:00:00Z`) : null, toT = a.created_to ? Date.parse(`${a.created_to}T00:00:00Z`) + 86_400_000 : null;
  const dated = (d: Date | string) => { const t = new Date(d).getTime(); return (fromT == null || t >= fromT) && (toT == null || t < toT); };
  const eq = (want: string, have: string) => !want || want.toLowerCase() === (have || DIRECT).toLowerCase();
  const utmOk = (u: Journey["utm"]) => eq(a.utm_source, u.source) && eq(a.utm_medium, u.medium) && eq(a.utm_campaign, u.campaign);
  const accountScoped = a.stages.length > 0 || !!a.attention || a.plans.length > 0 || a.accounts.length > 0;
  const accountOk = (j: Journey | undefined) => !!j && (!a.accounts.length || a.accounts.includes(j.org.slug)) && (!a.stages.length || a.stages.includes(j.org.stage))
    && (!a.attention || j.org.attention.some((x) => x.toLowerCase().includes(a.attention.toLowerCase()))) && (!a.plans.length || a.plans.includes(j.plan));
  const out = new Map<string, Candidate>();
  const add = (c: Candidate) => { const e = c.email.trim().toLowerCase(); if (mail.isEmail(e) && !out.has(e)) out.set(e, { ...c, email: e }); };
  const byId = new Map(js.map((j) => [Number(j.org.id), j]));

  if (a.include !== "requests") {
    const orgs = js.filter((j) => accountOk(j) && dated(j.created_at) && utmOk(j.utm));
    const ids = orgs.map((j) => Number(j.org.id));
    const products = new Map((ids.length ? await (await getDb()).query<{ org_id: number; name: string }>(
      "SELECT DISTINCT ON (org_id) org_id, name FROM products WHERE org_id = ANY($1::int[]) ORDER BY org_id, created_at, id", [ids]) : []).map((p) => [Number(p.org_id), p.name]));
    for (const j of orgs) {
      const base = { product: products.get(Number(j.org.id)) ?? j.org.name, source: "account" as const, org_id: Number(j.org.id), org_slug: j.org.slug, org_name: j.org.name, request_id: null };
      const people = await accountPeople(j.org.clerk_org_id);
      const members = (people?.members ?? []).filter((m) => m.status === "active" && m.email);
      for (const m of members) add({ ...base, email: m.email!, first_name: firstName(m.name) });
      // No Clerk (legacy keys) or nobody in it yet: whoever asked for this account.
      if (!members.length) for (const r of requests.filter((q) => q.org_id === Number(j.org.id) && q.status === "approved")) add({ ...base, email: r.email, first_name: firstName(r.name), request_id: r.id });
    }
  }
  if (a.include !== "accounts") {
    const reqOk = (r: RequestRow) => (!a.request_status.length || a.request_status.includes(r.status)) && dated(r.created_at) && utmOk(r.utm)
      && (!accountScoped || accountOk(r.org_id != null ? byId.get(r.org_id) : undefined));
    for (const r of requests.filter(reqOk)) {
      const j = r.org_id != null ? byId.get(r.org_id) : undefined;
      add({ email: r.email, first_name: firstName(r.name), product: r.company, source: "request", org_id: j ? Number(j.org.id) : null, org_slug: j?.org.slug ?? null, org_name: j?.org.name ?? null, request_id: r.id });
    }
  }
  return [...out.values()];
}

async function suppressedSet(emails: string[]): Promise<Set<string>> {
  if (!emails.length) return new Set();
  const hashes = new Map(emails.map((e) => [mail.hashAddress(e), e]));
  const rows = await (await getDb()).query<{ email_hash: string }>("SELECT email_hash FROM email_suppressions WHERE email_hash = ANY($1::text[])", [[...hashes.keys()]]);
  return new Set(rows.map((r) => hashes.get(r.email_hash)!));
}

/** The editor's preview: how many the audience matches now, how many of them are suppressed, and a sample. */
export async function previewAudience(body: { audience?: unknown }) {
  const a = parseAudience(body.audience);
  const all = await resolveAudience(a);
  const suppressed = await suppressedSet(all.map((c) => c.email));
  return {
    audience: a, count: all.length, suppressed: suppressed.size, sendable: all.length - suppressed.size,
    by_source: { account: all.filter((c) => c.source === "account").length, request: all.filter((c) => c.source === "request").length },
    sample: all.slice(0, 10).map((c) => ({ ...c, suppressed: suppressed.has(c.email) })),
  };
}

/** Add everyone the audience matches now (new addresses only); suppressed ones are recorded as such and never sent. */
export async function enroll(id: number): Promise<number> {
  const c = await campaignById(id);
  const people = await resolveAudience(c.audience);
  const suppressed = await suppressedSet(people.map((p) => p.email));
  const delay = c.steps[0]?.delay_days ?? 0;
  const rows = people.map((p) => ({ email: p.email, first_name: p.first_name, product: p.product, source: p.source, org_id: p.org_id, request_id: p.request_id, suppressed: suppressed.has(p.email) }));
  const db = await getDb();
  const added = rows.length ? await db.query<{ id: number }>(
    // The only INSERT of an email address anywhere in GTM: gtm_campaign_recipients.
    `INSERT INTO gtm_campaign_recipients (campaign_id, email, first_name, product, source, org_id, request_id, status, next_at)
     SELECT $1, x.email, x.first_name, x.product, x.source, x.org_id, x.request_id,
            CASE WHEN x.suppressed THEN 'suppressed' ELSE 'pending' END, CASE WHEN x.suppressed THEN NULL ELSE now() + make_interval(days => $3::int) END
       FROM jsonb_to_recordset($2::jsonb) AS x(email text, first_name text, product text, source text, org_id int, request_id int, suppressed boolean)
     ON CONFLICT (campaign_id, email) DO NOTHING RETURNING id`, [c.id, JSON.stringify(rows), delay]) : [];
  await db.query("UPDATE gtm_campaigns SET enrolled_at = now() WHERE id = $1", [c.id]);
  return added.length;
}

// ---------- unsubscribe links ----------

/** HMAC key for unsubscribe links, derived from the vault master key (current, then the previous one while rotating). */
const unsubKeys = () => [process.env.OCTILLION_VAULT_KEY, process.env.OCTILLION_VAULT_KEY_PREVIOUS].filter((k): k is string => !!k?.trim())
  .map((k) => Buffer.from(hkdfSync("sha256", Buffer.from(k.trim()), Buffer.from("octillion"), Buffer.from("campaign-unsubscribe-v1"), 32)));
const sigOf = (key: Buffer, id: number) => createHmac("sha256", key).update(`unsubscribe:${id}`).digest("base64url").slice(0, 32);
export function unsubscribeToken(recipientId: number): string {
  const [key] = unsubKeys();
  if (!key) throw new AdminError("Unsubscribe links need OCTILLION_VAULT_KEY", 503);
  return `${recipientId}.${sigOf(key, recipientId)}`;
}
export function verifyUnsubscribe(token: unknown): number | null {
  const m = /^(\d{1,15})\.([A-Za-z0-9_-]{32})$/.exec(String(token ?? ""));
  if (!m) return null;
  const id = Number(m[1]), got = Buffer.from(m[2]);
  return unsubKeys().some((k) => { const want = Buffer.from(sigOf(k, id)); return want.length === got.length && timingSafeEqual(want, got); }) ? id : null;
}
export const unsubscribeUrl = (token: string) => `${mail.siteUrl()}/api/email/unsubscribe?t=${encodeURIComponent(token)}`;
const TEST_TOKEN = "test";

/** Unsubscribe whoever the token names: from this campaign, and from every campaign after (the suppression list). */
export async function unsubscribe(token: unknown): Promise<{ ok: boolean; test?: boolean }> {
  if (token === TEST_TOKEN) return { ok: true, test: true };
  const id = verifyUnsubscribe(token);
  if (id == null) return { ok: false };
  const db = await getDb();
  const [r] = await db.query<{ email: string; campaign_id: number }>(
    `UPDATE gtm_campaign_recipients SET status = CASE WHEN status IN ('bounced') THEN status ELSE 'unsubscribed' END,
            unsubscribed_at = coalesce(unsubscribed_at, now()), next_at = NULL WHERE id = $1 RETURNING email, campaign_id`, [id]);
  if (!r) return { ok: true }; // the campaign was deleted: nothing left to stop
  await suppress(r.email, "unsubscribed", Number(r.campaign_id));
  capture({ distinctId: "octillion:email" }, "campaign_unsubscribed", { campaign_id: Number(r.campaign_id) });
  return { ok: true };
}

async function suppress(email: string, reason: "unsubscribed" | "bounced" | "complained" | "manual", campaignId: number | null) {
  await (await getDb()).query("INSERT INTO email_suppressions (email_hash, reason, campaign_id) VALUES ($1, $2, $3) ON CONFLICT (email_hash) DO NOTHING",
    [mail.hashAddress(email), reason, campaignId]);
}

/** The page behind the link: GET asks (link scanners must not unsubscribe anyone), POST does it. */
export function unsubscribePage(state: "ask" | "done" | "test" | "invalid", token = "") {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const body = {
    ask: `<h1>Unsubscribe from Octillion emails?</h1><p>You will stop getting these emails. Emails about your account (invitations, billing) still come.</p>
<form method="post" action="/api/email/unsubscribe?t=${esc(encodeURIComponent(token))}"><button type="submit">Unsubscribe</button></form>`,
    done: "<h1>You're unsubscribed</h1><p>You won't get these emails from Octillion again. Emails about your account (invitations, billing) still come.</p>",
    test: "<h1>This was a test email</h1><p>Nobody was unsubscribed.</p>",
    invalid: "<h1>This link doesn't work</h1><p>It may have been cut short. Reply to the email and we'll take you off the list by hand.</p>",
  }[state];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Unsubscribe | Octillion</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#111827;line-height:1.55}
h1{font-size:1.4rem}button{font:inherit;padding:.5rem 1rem;border-radius:.375rem;border:0;background:#111827;color:#fff;cursor:pointer}</style></head><body>${body}</body></html>`;
}

// ---------- sending ----------

const footer = (source: "account" | "request", url: string) =>
  `\n\n--\nYou're getting this because you ${source === "account" ? "have an Octillion account" : "asked for access to Octillion"}. Unsubscribe: ${url}`;
const unsubHeaders = (url: string) => ({ "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
const envInt = (name: string, def: number, max: number) => { const n = Number(process.env[name]); return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : def; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A test of one step to an address typed in: rendered for the first person the audience matches (or placeholders). */
export async function testSend(actor: string, id: number, body: { to?: unknown; step?: unknown; subject?: unknown; body?: unknown }) {
  const to = String(body.to ?? "").trim().toLowerCase();
  if (!mail.isEmail(to)) throw new AdminError("Enter a valid email address");
  const c = await campaignById(id);
  const i = body.step == null || body.step === "" ? 0 : Number(body.step);
  // Unsaved edits from the editor can be tried before saving.
  const [step] = body.subject !== undefined || body.body !== undefined ? parseSteps([{ subject: body.subject, body: body.body }]) : [c.steps[i]];
  if (!step) throw new AdminError(`This campaign has no email ${i + 1}`);
  const sample = (await resolveAudience(c.audience).catch(() => []))[0];
  const url = unsubscribeUrl(TEST_TOKEN);
  const r = await mail.send({ kind: "campaign_test", to, idempotencyKey: `campaign-test:${c.id}:${randomUUID()}`, meta: { campaign_id: c.id, step: i },
    subject: `[Test] ${render(step.subject, sample ?? {})}`, text: render(step.body, sample ?? {}) + footer(sample?.source ?? "account", url),
    headers: unsubHeaders(url), tags: [{ name: "campaign", value: String(c.id) }] });
  log(actor, "campaign.test", null, { campaign_id: c.id, step: i, status: r.status, to_domain: mail.domainOf(to) });
  return { ...r, sample: sample ? { first_name: sample.first_name, product: sample.product, source: sample.source } : null };
}

interface Due { id: number; campaign_id: number; email: string; first_name: string | null; product: string | null; source: "account" | "request"; next_step: number }
export interface TickResult { started: number; enrolled: number; sent: number; failed: number; suppressed: number; finished: number; skipped?: string; error?: string }

let inflight: Promise<TickResult> | null = null;
/** One pass: start scheduled campaigns, enroll, send what is due (rate-limited), finish what is done. Never throws. */
export function campaignTick(): Promise<TickResult> {
  return (inflight ??= runTick().catch((e) => ({ started: 0, enrolled: 0, sent: 0, failed: 0, suppressed: 0, finished: 0, error: (e as Error).message }))
    .finally(() => { inflight = null; }));
}

async function runTick(): Promise<TickResult> {
  const db = await getDb();
  const out: TickResult = { started: 0, enrolled: 0, sent: 0, failed: 0, suppressed: 0, finished: 0 };
  out.started = (await db.query("UPDATE gtm_campaigns SET status = 'running', launched_at = coalesce(launched_at, now()), updated_at = now() WHERE status = 'scheduled' AND starts_at <= now() RETURNING id")).length;
  // New ones enroll once; rolling ones re-check their audience at most every few minutes.
  for (const { id } of await db.query<{ id: number }>(
    "SELECT id FROM gtm_campaigns WHERE status = 'running' AND (enrolled_at IS NULL OR (rolling AND enrolled_at < now() - interval '4 minutes'))")) {
    try { out.enrolled += await enroll(Number(id)); } catch (e) { console.error(`campaign ${id}: enrolment failed: ${(e as Error).message}`); }
  }
  const status = await mail.emailStatus();
  if (!status.enabled || !status.connected) {
    out.skipped = !status.connected ? "No Resend key in Key vault (or the provider is off)" : "Emails are off (Agent configuration, Send emails)";
    return out;
  }
  const cap = envInt("CAMPAIGN_SENDS_PER_TICK", 100, 1000), gap = envInt("CAMPAIGN_SEND_INTERVAL_MS", 600, 10_000);
  // Lease what is due: pushed 10 minutes out, so a concurrent tick (another replica, the cron) skips it.
  const due = cap ? await db.query<Due>(
    `UPDATE gtm_campaign_recipients r SET next_at = now() + interval '10 minutes'
      WHERE r.id IN (SELECT x.id FROM gtm_campaign_recipients x JOIN gtm_campaigns c ON c.id = x.campaign_id
                      WHERE c.status = 'running' AND x.status IN ('pending', 'active') AND x.next_at <= now()
                      ORDER BY x.next_at, x.id LIMIT $1 FOR UPDATE OF x SKIP LOCKED)
      RETURNING r.id, r.campaign_id, r.email, r.first_name, r.product, r.source, r.next_step`, [cap]) : [];
  const campaigns = new Map<number, CampaignRow>();
  for (const r of due) {
    const cid = Number(r.campaign_id);
    if (!campaigns.has(cid)) campaigns.set(cid, await campaignById(cid));
  }
  let first = true;
  for (const r of due.sort((a, b) => Number(a.id) - Number(b.id))) {
    const c = campaigns.get(Number(r.campaign_id))!, step = c.steps[r.next_step];
    if (!step) { await db.query("UPDATE gtm_campaign_recipients SET status = 'done', next_at = NULL WHERE id = $1", [r.id]); continue; }
    if ((await suppressedSet([r.email])).size) {
      await db.query("UPDATE gtm_campaign_recipients SET status = 'suppressed', next_at = NULL WHERE id = $1", [r.id]);
      out.suppressed++;
      continue;
    }
    const [claim] = await db.query<{ id: number; attempts: number }>(
      `INSERT INTO gtm_campaign_sends (campaign_id, recipient_id, step, status) VALUES ($1, $2, $3, 'sending')
       ON CONFLICT (recipient_id, step) DO UPDATE SET status = 'sending', attempts = gtm_campaign_sends.attempts + 1, at = now(), error = NULL
         WHERE gtm_campaign_sends.status = 'failed' OR (gtm_campaign_sends.status = 'sending' AND gtm_campaign_sends.at < now() - interval '10 minutes')
       RETURNING id, attempts`, [c.id, r.id, r.next_step]);
    if (!claim) {
      // Already sent (a tick that stopped before moving on): move on now; being sent elsewhere: leave the lease.
      const [s] = await db.query<{ status: string }>("SELECT status FROM gtm_campaign_sends WHERE recipient_id = $1 AND step = $2", [r.id, r.next_step]);
      if (s?.status === "sent") await advance(r, c);
      continue;
    }
    if (!first && gap) await sleep(gap);
    first = false;
    const url = unsubscribeUrl(unsubscribeToken(Number(r.id)));
    const res = await mail.send({
      kind: "campaign", to: r.email, idempotencyKey: `campaign:${c.id}:${r.id}:${r.next_step}`, meta: { campaign_id: c.id, step: r.next_step },
      subject: render(step.subject, r), text: render(step.body, r) + footer(r.source, url), headers: unsubHeaders(url), tags: [{ name: "campaign", value: String(c.id) }],
    });
    if (res.status === "sent" || res.status === "duplicate") {
      await db.query("UPDATE gtm_campaign_sends SET status = 'sent', provider_id = coalesce($2, provider_id), at = now() WHERE id = $1", [claim.id, res.provider_id ?? null]);
      await advance(r, c);
      out.sent++;
    } else {
      await db.query("UPDATE gtm_campaign_sends SET status = 'failed', error = $2 WHERE id = $1", [claim.id, (res.error ?? res.status).slice(0, 500)]);
      // Skipped (no valid address) or three failures: give up on this person; else try again in half an hour.
      const giveUp = res.status === "skipped" || Number(claim.attempts) >= 3;
      await db.query(`UPDATE gtm_campaign_recipients SET ${giveUp ? "status = 'failed', next_at = NULL" : "next_at = now() + interval '30 minutes'"} WHERE id = $1`, [r.id]);
      out.failed++;
    }
  }
  out.finished = (await db.query(
    `UPDATE gtm_campaigns c SET status = 'done', finished_at = now(), updated_at = now()
      WHERE c.status = 'running' AND NOT c.rolling AND c.enrolled_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM gtm_campaign_recipients r WHERE r.campaign_id = c.id AND r.status IN ('pending', 'active')) RETURNING id`)).length;
  if (out.sent || out.failed) console.error(`campaigns: sent ${out.sent}, failed ${out.failed}, suppressed ${out.suppressed}`);
  return out;
}

/** After step n went out: the next one is due its delay later, or the person is done. Only from step n (no double move). */
async function advance(r: Due, c: CampaignRow) {
  const next = r.next_step + 1, last = next >= c.steps.length;
  await (await getDb()).query(
    `UPDATE gtm_campaign_recipients SET next_step = $2, first_sent_at = coalesce(first_sent_at, now()), last_sent_at = now(),
            status = $3, next_at = CASE WHEN $3 = 'done' THEN NULL ELSE now() + make_interval(days => $4::int) END
      WHERE id = $1 AND next_step = $5`, [r.id, next, last ? "done" : "active", last ? 0 : c.steps[next].delay_days, r.next_step]);
}

/** On a VM (not Vercel, whose cron calls the tick): a tick every 5 minutes. */
let ticker: NodeJS.Timeout | null = null;
export function startCampaignTicker() {
  if (ticker || process.env.VERCEL || (process.env.OCTILLION_CAMPAIGNS ?? "on").toLowerCase() === "off") return;
  ticker = setInterval(() => void campaignTick(), 5 * 60_000);
  ticker.unref();
}

// ---------- Resend webhooks: delivered, bounced, complained, opened, clicked ----------

const EVENT_COLUMN: Record<string, string> = {
  "email.delivered": "delivered_at", "email.bounced": "bounced_at", "email.complained": "complained_at", "email.opened": "opened_at", "email.clicked": "clicked_at",
};

/** Svix's scheme (Resend signs webhooks with it): HMAC-SHA256 of "id.timestamp.body" with the base64 secret after whsec_. */
export function verifySvix(secret: string, raw: string, h: { id?: string; timestamp?: string; signature?: string }, now = Date.now()): boolean {
  if (!h.id || !h.timestamp || !h.signature) return false;
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts * 1000) > 5 * 60_000) return false;
  const key = Buffer.from(secret.trim().replace(/^whsec_/, ""), "base64");
  const want = Buffer.from(createHmac("sha256", key).update(`${h.id}.${h.timestamp}.${raw}`).digest("base64"));
  return h.signature.split(" ").some((part) => {
    const [v, sig] = part.split(",");
    const got = Buffer.from(sig ?? "");
    return v === "v1" && got.length === want.length && timingSafeEqual(got, want);
  });
}

/** POST /api/webhooks/resend: verified, then recorded on the campaign send it is about (others are acknowledged and ignored). */
export async function resendWebhook(raw: string, h: { id?: string; timestamp?: string; signature?: string }): Promise<{ status: number; body: Record<string, unknown> }> {
  const secret = await useCredential(WEBHOOK_PROVIDER).then((c) => c.secret, () => null);
  if (!secret) return { status: 503, body: { error: "Resend webhooks are not set up: add the signing secret (resend_webhook) on Key vault" } };
  if (!verifySvix(secret, raw, h)) return { status: 401, body: { error: "Invalid signature" } };
  let ev: { type?: string; created_at?: string; data?: { email_id?: string; bounce?: { type?: string } } };
  try { ev = JSON.parse(raw); } catch { return { status: 400, body: { error: "Not JSON" } }; }
  const col = EVENT_COLUMN[ev.type ?? ""], pid = ev.data?.email_id;
  if (!col || !pid) return { status: 200, body: { ok: true, ignored: true } };
  const at = ev.created_at && !Number.isNaN(Date.parse(ev.created_at)) ? new Date(ev.created_at) : new Date();
  const db = await getDb();
  const [s] = await db.query<{ recipient_id: number; campaign_id: number }>(
    `UPDATE gtm_campaign_sends SET ${col} = coalesce(${col}, $2) WHERE provider_id = $1 RETURNING recipient_id, campaign_id`, [pid, at]);
  if (!s) return { status: 200, body: { ok: true, matched: false } };
  const hard = ev.type === "email.complained" || (ev.type === "email.bounced" && !/transient/i.test(ev.data?.bounce?.type ?? ""));
  if (hard) {
    const [r] = await db.query<{ email: string }>(
      `UPDATE gtm_campaign_recipients SET status = CASE WHEN status = 'unsubscribed' THEN status ELSE $2 END, next_at = NULL WHERE id = $1 RETURNING email`,
      [s.recipient_id, ev.type === "email.bounced" ? "bounced" : "unsubscribed"]);
    if (r) await suppress(r.email, ev.type === "email.bounced" ? "bounced" : "complained", Number(s.campaign_id));
  }
  return { status: 200, body: { ok: true, matched: true } };
}

// ---------- reading: the list and one campaign ----------

type Metrics = { recipients: number; suppressed: number; unsubscribed: number; failed: number; waiting: number; reached: number;
  sent: number; delivered: number; bounced: number; complained: number; opened: number; clicked: number };
async function metrics(ids: number[]): Promise<Map<number, Metrics>> {
  const db = await getDb();
  const [rs, ss] = ids.length ? await Promise.all([
    db.query<Record<string, unknown>>(
      `SELECT campaign_id, count(*) AS recipients, count(*) FILTER (WHERE status = 'suppressed') AS suppressed, count(*) FILTER (WHERE status = 'unsubscribed') AS unsubscribed,
              count(*) FILTER (WHERE status = 'failed') AS failed, count(*) FILTER (WHERE status IN ('pending', 'active')) AS waiting,
              count(*) FILTER (WHERE first_sent_at IS NOT NULL) AS reached
         FROM gtm_campaign_recipients WHERE campaign_id = ANY($1::bigint[]) GROUP BY campaign_id`, [ids]),
    db.query<Record<string, unknown>>(
      `SELECT campaign_id, count(*) FILTER (WHERE status = 'sent') AS sent, count(*) FILTER (WHERE delivered_at IS NOT NULL) AS delivered,
              count(*) FILTER (WHERE bounced_at IS NOT NULL) AS bounced, count(*) FILTER (WHERE complained_at IS NOT NULL) AS complained,
              count(DISTINCT recipient_id) FILTER (WHERE opened_at IS NOT NULL) AS opened, count(DISTINCT recipient_id) FILTER (WHERE clicked_at IS NOT NULL) AS clicked
         FROM gtm_campaign_sends WHERE campaign_id = ANY($1::bigint[]) GROUP BY campaign_id`, [ids]),
  ]) : [[], []];
  const zero: Metrics = { recipients: 0, suppressed: 0, unsubscribed: 0, failed: 0, waiting: 0, reached: 0, sent: 0, delivered: 0, bounced: 0, complained: 0, opened: 0, clicked: 0 };
  const out = new Map(ids.map((id) => [id, { ...zero }]));
  for (const r of [...rs, ...ss]) {
    const m = out.get(Number(r.campaign_id));
    if (m) for (const [k, v] of Object.entries(r)) if (k !== "campaign_id") (m as Record<string, number>)[k] = Number(v);
  }
  return out;
}

interface RecipientRow { id: number; campaign_id: number; email: string; first_name: string | null; product: string | null; source: string; org_id: number | null; request_id: number | null;
  status: string; next_step: number; next_at: Date | null; first_sent_at: Date | null; last_sent_at: Date | null; unsubscribed_at: Date | null }

/**
 * Conversions after the first email, within the campaign's conversion_days, from the Activation data (src/gtm.ts):
 * requested access (a request from that address), activated (its account's first simulation), paid (its first paid
 * moment in Stripe). A person's account is the one they were enrolled from, else the one their request created.
 */
function conversions(rs: RecipientRow[], days: number, data: Awaited<ReturnType<typeof journeys>>) {
  const byOrg = new Map(data.journeys.map((j) => [Number(j.org.id), j]));
  const reqsBy = new Map<string, RequestRow[]>();
  for (const r of data.requests) reqsBy.set(r.email, [...(reqsBy.get(r.email) ?? []), r]);
  const per = new Map<number, { requested: boolean; activated: boolean; paid: boolean }>();
  for (const r of rs) {
    if (!r.first_sent_at) continue;
    const reqs = reqsBy.get(r.email) ?? [];
    const orgId = r.org_id ?? reqs.find((q) => q.org_id != null)?.org_id ?? null;
    const j = orgId != null ? byOrg.get(Number(orgId)) : undefined;
    per.set(Number(r.id), {
      requested: reqs.some((q) => within(r.first_sent_at, q.created_at, days)),
      activated: !!j && within(r.first_sent_at, j.simulated_at, days),
      paid: !!j && within(r.first_sent_at, j.paid_at, days),
    });
  }
  const n = (k: "requested" | "activated" | "paid") => [...per.values()].filter((x) => x[k]).length;
  return { totals: { days, requested: n("requested"), activated: n("activated"), paid: n("paid") }, per };
}

const shape = (c: CampaignRow, m: Metrics | undefined) => ({
  id: Number(c.id), name: c.name, status: c.status, audience: c.audience, steps: c.steps, rolling: c.rolling, conversion_days: c.conversion_days,
  starts_at: c.starts_at, owner: c.owner, owner_user_id: c.owner_user_id, created_at: c.created_at, updated_at: c.updated_at,
  launched_at: c.launched_at, enrolled_at: c.enrolled_at, finished_at: c.finished_at, metrics: m,
});

export async function listCampaigns() {
  const db = await getDb();
  const rows = (await db.query<CampaignRow>(`SELECT ${COLS} FROM gtm_campaigns ORDER BY created_at DESC, id DESC`))
    .map((c) => ({ ...c, id: Number(c.id), audience: parseAudienceSafe(c.audience), steps: Array.isArray(c.steps) ? c.steps : [] }));
  const m = await metrics(rows.map((c) => c.id));
  const sent = rows.filter((c) => (m.get(c.id)?.reached ?? 0) > 0);
  // Conversions need the accounts' journeys: only when something went out.
  const data = sent.length ? await journeys().catch(() => null) : null;
  const recips = data && sent.length ? await db.query<RecipientRow>(
    "SELECT id, campaign_id, email, org_id, first_sent_at FROM gtm_campaign_recipients WHERE campaign_id = ANY($1::bigint[]) AND first_sent_at IS NOT NULL", [sent.map((c) => c.id)]) : [];
  const status = await mail.emailStatus();
  return {
    email: { enabled: status.enabled, connected: status.connected, from: status.from },
    variables: VARIABLES, stages: STAGES.map((s) => ({ id: s.id, label: s.label })),
    campaigns: rows.map((c) => ({ ...shape(c, m.get(c.id)),
      conversions: data ? conversions(recips.filter((r) => Number(r.campaign_id) === c.id), c.conversion_days, data).totals : null })),
  };
}

export async function campaignDetail(id: number) {
  const c = await campaignById(id);
  const db = await getDb();
  const [m, recipients, steps, data] = await Promise.all([
    metrics([c.id]),
    db.query<RecipientRow>(
      `SELECT id, campaign_id, email, first_name, product, source, org_id, request_id, status, next_step, next_at, first_sent_at, last_sent_at, unsubscribed_at
         FROM gtm_campaign_recipients WHERE campaign_id = $1 ORDER BY id LIMIT 2000`, [c.id]),
    db.query<Record<string, unknown>>(
      `SELECT step, count(*) FILTER (WHERE status = 'sent') AS sent, count(*) FILTER (WHERE status = 'failed') AS failed, count(*) FILTER (WHERE delivered_at IS NOT NULL) AS delivered,
              count(*) FILTER (WHERE bounced_at IS NOT NULL) AS bounced, count(*) FILTER (WHERE opened_at IS NOT NULL) AS opened, count(*) FILTER (WHERE clicked_at IS NOT NULL) AS clicked
         FROM gtm_campaign_sends WHERE campaign_id = $1 GROUP BY step ORDER BY step`, [c.id]),
    journeys().catch(() => null),
  ]);
  const sends = await db.query<{ recipient_id: number; delivered: boolean; bounced: boolean; opened: boolean; clicked: boolean }>(
    `SELECT recipient_id, bool_or(delivered_at IS NOT NULL) AS delivered, bool_or(bounced_at IS NOT NULL) AS bounced, bool_or(opened_at IS NOT NULL) AS opened,
            bool_or(clicked_at IS NOT NULL) AS clicked FROM gtm_campaign_sends WHERE campaign_id = $1 GROUP BY recipient_id`, [c.id]);
  const sendBy = new Map(sends.map((s) => [Number(s.recipient_id), s]));
  const conv = data ? conversions(recipients, c.conversion_days, data) : null;
  const slugOf = new Map((data?.journeys ?? []).map((j) => [Number(j.org.id), { slug: j.org.slug, name: j.org.name }]));
  return {
    campaign: shape(c, m.get(c.id)),
    conversions: conv?.totals ?? null,
    steps: c.steps.map((s, i) => {
      const x = steps.find((r) => Number(r.step) === i);
      return { ...s, index: i, sent: Number(x?.sent ?? 0), failed: Number(x?.failed ?? 0), delivered: Number(x?.delivered ?? 0), bounced: Number(x?.bounced ?? 0),
        opened: Number(x?.opened ?? 0), clicked: Number(x?.clicked ?? 0) };
    }),
    recipients: recipients.map((r) => {
      const s = sendBy.get(Number(r.id)), cv = conv?.per.get(Number(r.id));
      return { id: Number(r.id), email: r.email, first_name: r.first_name, product: r.product, source: r.source, status: r.status, next_step: r.next_step, next_at: r.next_at,
        first_sent_at: r.first_sent_at, last_sent_at: r.last_sent_at, unsubscribed_at: r.unsubscribed_at,
        account: r.org_id != null ? slugOf.get(Number(r.org_id)) ?? null : null,
        delivered: !!s?.delivered, bounced: !!s?.bounced, opened: !!s?.opened, clicked: !!s?.clicked,
        requested: !!cv?.requested, activated: !!cv?.activated, paid: !!cv?.paid };
    }),
  };
}
