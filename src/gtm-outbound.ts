/**
 * GTM › outbound sequences: campaigns whose audience is prospects (src/gtm-crm.ts) rather than accounts or access
 * requesters. The engine is src/campaigns.ts's (the tick, the global lease, batch sends, claims, unsubscribe, replies);
 * this file is what is different about cold email:
 *
 *   identity    every outbound email (each recipient whose source is prospect) goes from a sender identity
 *               (gtm_sender_identities: from name, address, daily cap, warm-up start). Its domain must be a proper
 *               subdomain of its organisational root (public-suffix aware: outreach.example.co.uk, never example.co.uk)
 *               and never EMAIL_FROM's domain or a parent of it, both compared in their ASCII form; when EMAIL_FROM's
 *               domain cannot be read, every identity is refused (fail closed). A prospects campaign cannot launch,
 *               resume or send without a valid one. Lifecycle campaigns keep EMAIL_FROM.
 *   warm-up     an identity's cap for a day (UTC): warmup_from (20) on warmup_start, rising in a straight line to
 *               daily_cap after warmup_days (28), then daily_cap; before warmup_start, nothing. Counted over every
 *               campaign using it (gtm_campaign_sends.identity_id: sent, being sent, or with an outcome not known
 *               yet, today) and its test sends (email_log, outbound_test); whoever is over waits
 *               and is looked at again hourly (the next UTC day, or a raised cap, lets them through).
 *   audience    a saved filter over prospects: status, tags, title words, company size and industry, country, owner,
 *               email status (verified only by default). Someone a customer, replied, interested, not interested or
 *               with a bad address is never enrolled, whatever the filter says.
 *   safety      checked at enrolment and again before each send: never an existing customer (a linked prospect or
 *               company, any account's people by address hash and by company domain: their access requests and their
 *               Clerk members, src/gtm-crm.ts memberIndex; when Clerk cannot be asked, nobody is written to that pass),
 *               never someone in another active sequence (any campaign; the earlier enrolment wins) or emailed by
 *               another outbound campaign in the last OUTBOUND_COOLOFF_DAYS (30), never a withdrawn address; the
 *               suppression list and the unsubscribe link apply as for every campaign. EU / EEA / UK / CH prospects
 *               (and anyone with no country) only when the campaign allows them (allow_restricted) and they have
 *               a lawful basis (always required at import).
 *   events      a send moves new -> contacted; a reply -> replied (and the sequence stops, src/gtm-replies.ts); a
 *               hard bounce -> bad_email; an unsubscribe or complaint -> not_interested. The Replies inbox has quick
 *               actions: interested, not interested, unsubscribe.
 *   rendering   plain text only (no HTML part, so no tracking pixel) unless the campaign turns on open tracking
 */
import { domainToASCII } from "node:url";
import { getDomain } from "tldts";
import { getDb, type Queryable } from "./db.js";
import { AdminError, log } from "./admin.js";
import * as mail from "./email.js";
import { freshSettings, settingText } from "./settings.js";
import { consentOf, recordConsent } from "./gtm-consent.js";
import { activity, domainOf, restrictedCountry, setStatus, SIZES, PROSPECT_STATUSES, EMAIL_STATUSES, companyDomainOf, memberIndex, memberOrg, type MemberIndex } from "./gtm-crm.js";
import type { Candidate } from "./campaigns.js";

const fail = (msg: string, status = 400): never => { throw new AdminError(msg, status); };
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const strs = (v: unknown, max = 200) => [...new Set((Array.isArray(v) ? v : v == null || v === "" ? [] : String(v).split(",")).map((x) => String(x).trim()).filter(Boolean))].slice(0, max);
const DAY = 86_400_000;

// ---------- sender identities and warm-up ----------

export interface Identity {
  id: number; from_name: string; from_address: string; domain: string; daily_cap: number; warmup_start: string | null; warmup_from: number; warmup_days: number;
  enabled: boolean; created_by: string | null; created_at: Date; updated_at: Date;
}
const ICOLS = "id, from_name, from_address, domain, daily_cap, to_char(warmup_start, 'YYYY-MM-DD') AS warmup_start, warmup_from, warmup_days, enabled, created_by, created_at, updated_at";

/** A domain in its ASCII (punycode) form, lowercased; null when it is not one. */
export const asciiDomain = (d: string | null | undefined) => {
  const a = d ? domainToASCII(d.trim().toLowerCase().replace(/\.$/, "")) : "";
  return a && domainOf(a) === a ? a : null;
};
/** The product sender's domain (EMAIL_FROM's address, ASCII): outbound never sends from it. Null when unreadable. */
export async function productDomain(): Promise<string | null> {
  await freshSettings();
  const from = settingText("EMAIL_FROM");
  const addr = (/<([^<>]+)>/.exec(from)?.[1] ?? from).trim();
  return asciiDomain(addr.includes("@") ? addr.split("@").pop() : null);
}
/** The organisational root (registrable domain, public-suffix aware): example.co.uk for a.b.example.co.uk. */
export const rootOf = (d: string) => getDomain(d, { allowPrivateDomains: false }) ?? null;
/** Why an identity's domain cannot send cold email, or null (see the top of the file). */
export function domainProblem(d: string, product: string | null): string | null {
  if (!product) return "The product's sender domain (EMAIL_FROM) cannot be read, so no outbound identity can be checked against it: fix EMAIL_FROM first";
  const root = rootOf(d);
  if (!root || d === root) return `${d} is not a subdomain: send cold email from one such as outreach.${root ?? d}`;
  if (d === product) return `Outbound cannot send from ${d}, the product's sender domain (EMAIL_FROM): use a subdomain such as outreach.${root}`;
  if (product.endsWith(`.${d}`)) return `${d} is a parent of the product's sender domain (${product}): use a subdomain of its own such as outreach.${root}`;
  return null;
}
/** A proper subdomain of the same organisation as the product's sender (outreach.example.co.uk next to example.co.uk). */
const isSubdomainOf = (d: string, product: string | null) => !!product && !domainProblem(d, product) && rootOf(d) === rootOf(product);

/**
 * Today's cap (UTC) for an identity: before warmup_start nothing; from it, warmup_from rising in a straight line to
 * daily_cap over warmup_days; no warmup_start, daily_cap.
 */
export function warmupCap(i: Pick<Identity, "daily_cap" | "warmup_start" | "warmup_from" | "warmup_days">, now = new Date()): number {
  if (!i.warmup_start) return i.daily_cap;
  const start = Date.parse(`${i.warmup_start}T00:00:00Z`), today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const day = Math.floor((today - start) / DAY);
  if (day < 0) return 0;
  if (day >= i.warmup_days) return i.daily_cap;
  const from = Math.min(i.warmup_from, i.daily_cap);
  return Math.min(i.daily_cap, Math.round(from + ((i.daily_cap - from) * day) / i.warmup_days));
}
/** The next days' caps, for the page's ramp. */
export const warmupPlan = (i: Pick<Identity, "daily_cap" | "warmup_start" | "warmup_from" | "warmup_days">, days = 35, now = new Date()) =>
  Array.from({ length: days }, (_, k) => { const d = new Date(now.getTime() + k * DAY); return { day: d.toISOString().slice(0, 10), cap: warmupCap(i, d) }; });

/** Emails sent (or being sent) today, UTC, per identity: across every campaign. */
export async function sentToday(ids: number[], q?: Queryable): Promise<Map<number, number>> {
  if (!ids.length) return new Map();
  // Sends that went, are going, or may have gone (uncertain / unknown), and test sends from the identity (sent, being
  // sent, or reserved: reserveTest).
  const rows = await (q ?? await getDb()).query<{ identity_id: number; n: number }>(
    `SELECT identity_id, sum(n)::int AS n FROM (
       SELECT identity_id, count(*) AS n FROM gtm_campaign_sends
        WHERE identity_id = ANY($1::bigint[]) AND status IN ('sent', 'sending', 'uncertain', 'unknown') AND at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') GROUP BY identity_id
       UNION ALL
       SELECT (meta->>'identity_id')::bigint, count(*) FROM email_log
        WHERE kind = 'outbound_test' AND (status IN ('sent', 'sending') OR (status = 'failed' AND error = $2)) AND (meta->>'identity_id')::bigint = ANY($1::bigint[])
          AND at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') GROUP BY 1) x GROUP BY identity_id`, [ids, RESERVED]);
  return new Map(rows.map((r) => [Number(r.identity_id), Number(r.n)]));
}
const RESERVED = "Reserved for a test send";
/**
 * A test send from an identity takes one of today's emails atomically: under the identity's row lock (one reservation
 * at a time), the day's count is read and, when there is room, the test's email_log row is claimed first (status
 * failed, "reserved", counted as sent); src/email.ts then takes that row over for the real send. False: the cap is spent.
 */
export async function reserveTest(i: Identity, key: string, to: string, campaignId: number): Promise<boolean> {
  return (await getDb()).transaction(async (tx) => {
    await tx.query("SELECT id FROM gtm_sender_identities WHERE id = $1 FOR UPDATE", [i.id]);
    if (warmupCap(i) - ((await sentToday([i.id], tx)).get(i.id) ?? 0) <= 0) return false;
    await tx.query(
      `INSERT INTO email_log (kind, to_hash, to_domain, subject, status, idempotency_key, meta, error) VALUES ('outbound_test', $1, $2, '', 'failed', $3, $4::jsonb, $5)`,
      [mail.hashAddress(to), mail.domainOf(to) || "-", key, JSON.stringify({ campaign_id: campaignId, identity_id: i.id }), RESERVED]);
    return true;
  });
}
/** What an identity may still send today (its warm-up cap less what it sent). */
export async function leftToday(i: Identity) { return warmupCap(i) - ((await sentToday([i.id])).get(i.id) ?? 0); }

export async function listIdentities() {
  const db = await getDb();
  const rows = (await db.query<Identity>(`SELECT ${ICOLS} FROM gtm_sender_identities ORDER BY id`)).map((r) => ({ ...r, id: Number(r.id) }));
  const [today, product] = await Promise.all([sentToday(rows.map((r) => r.id)), productDomain()]);
  const campaigns = await db.query<{ sender_identity_id: number; n: number }>(
    "SELECT sender_identity_id, count(*)::int AS n FROM gtm_campaigns WHERE sender_identity_id IS NOT NULL AND status IN ('running', 'scheduled', 'paused') GROUP BY sender_identity_id");
  return {
    product_domain: product,
    identities: rows.map((i) => ({ ...i, cap_today: warmupCap(i), sent_today: today.get(i.id) ?? 0, plan: warmupPlan(i),
      on_product_domain: i.domain === product, problem: domainProblem(i.domain, product), subdomain: isSubdomainOf(i.domain, product),
      active_campaigns: Number(campaigns.find((c) => Number(c.sender_identity_id) === i.id)?.n ?? 0) })),
  };
}

function identityFields(b: Record<string, unknown>, product: string | null, partial: boolean) {
  const out: Record<string, unknown> = {};
  if (!partial || b.from_name !== undefined) out.from_name = displayName(b.from_name);
  if (!partial || b.from_address !== undefined) {
    const a = str(b.from_address, 254).toLowerCase();
    if (!mail.isEmail(a)) fail("The from address must be an email address, e.g. priya@outreach.example.com");
    const raw = a.split("@").pop()!;
    if (/[^\x00-\x7f]/.test(a)) fail(`Use the address in its ASCII form (the domain as punycode: ${asciiDomain(raw) ?? "xn--…"}), so every mail system reads it the same`);
    const d = asciiDomain(raw) ?? fail(`${raw} is not a domain`);
    const why = domainProblem(d, product);
    if (why) fail(why);
    Object.assign(out, { from_address: a, domain: d });
  }
  const int = (k: string, min: number, max: number, def: number) => {
    if (partial && b[k] === undefined) return;
    const n = b[k] == null || b[k] === "" ? def : Number(b[k]);
    if (!Number.isInteger(n) || n < min || n > max) fail(`${k} is a whole number, ${min} to ${max}`);
    out[k] = n;
  };
  int("daily_cap", 1, 10_000, 200); int("warmup_from", 1, 10_000, 20); int("warmup_days", 1, 365, 28);
  if (!partial || b.warmup_start !== undefined) {
    const v = b.warmup_start;
    if (v != null && v !== "" && (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)))) fail("warmup_start is a date, YYYY-MM-DD (empty: no ramp)");
    out.warmup_start = v || null;
  }
  if (b.enabled !== undefined) out.enabled = b.enabled !== false;
  return out;
}

export async function createIdentity(actor: string, body: Record<string, unknown>) {
  const f = identityFields(body, await productDomain(), false);
  const [r] = await (await getDb()).query<{ id: number }>(
    `INSERT INTO gtm_sender_identities (from_name, from_address, domain, daily_cap, warmup_start, warmup_from, warmup_days, enabled, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8, true), $9) RETURNING id`,
    [f.from_name, f.from_address, f.domain, f.daily_cap, f.warmup_start, f.warmup_from, f.warmup_days, f.enabled ?? null, actor]).catch((e: { code?: string }) => {
    if (e.code === "23505") fail("There is already an identity with that address", 409);
    throw e;
  });
  log(actor, "gtm.identity_create", null, { identity_id: Number(r.id), domain: f.domain });
  return listIdentities();
}

export async function updateIdentity(actor: string, id: number, body: Record<string, unknown>) {
  const f = identityFields(body, await productDomain(), true);
  const keys = Object.keys(f);
  if (keys.length) {
    const r = await (await getDb()).query(`UPDATE gtm_sender_identities SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1 RETURNING id`,
      [id, ...keys.map((k) => f[k])]);
    if (!r.length) fail(`No sender identity ${id}`, 404);
  }
  log(actor, "gtm.identity_update", null, { identity_id: id, fields: keys });
  return listIdentities();
}

export async function deleteIdentity(actor: string, id: number) {
  const db = await getDb();
  const [busy] = await db.query("SELECT 1 FROM gtm_campaigns WHERE sender_identity_id = $1 AND status IN ('running', 'scheduled')", [id]);
  if (busy) fail("A running or scheduled campaign sends from this identity: pause or end it first", 409);
  const r = await db.query("DELETE FROM gtm_sender_identities WHERE id = $1 RETURNING id", [id]);
  if (!r.length) fail(`No sender identity ${id}`, 404);
  log(actor, "gtm.identity_delete", null, { identity_id: id });
}

export async function identityById(id: number | null | undefined): Promise<Identity | null> {
  if (id == null) return null;
  const [r] = await (await getDb()).query<Identity>(`SELECT ${ICOLS} FROM gtm_sender_identities WHERE id = $1`, [id]);
  return r ? { ...r, id: Number(r.id) } : null;
}

/** Why this campaign cannot send to prospects now (no identity, disabled, on the product's domain), or null. */
export async function identityProblem(identityId: number | null | undefined): Promise<string | null> {
  const i = await identityById(identityId);
  if (!i) return "Choose an outbound sender identity (Sender identities): cold email never goes from the product's sender";
  if (!i.enabled) return `The sender identity ${i.from_address} is turned off`;
  return domainProblem(i.domain, await productDomain());
}
/**
 * A display name fit for a From header: control characters and < > , ; " \ removed, spaces squeezed; one with an @
 * is refused (it would read as an address).
 */
export function displayName(v: unknown): string {
  const raw = typeof v === "string" ? v : "";
  if (raw.includes("@")) fail("The sender's name cannot contain @ (it would read as an address): e.g. Priya at Octillion");
  const name = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/[<>,;"\\]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
  return name || fail("Give the sender a name, e.g. Priya at Octillion");
}
/** The From header: the name as an RFC 5322 quoted string, then the address. */
export const senderOf = (i: Identity) => `"${i.from_name.replace(/[\u0000-\u001f\u007f@<>,;"\\]/g, "").trim()}" <${i.from_address}>`;

// ---------- the audience ----------

/** The saved filter over prospects (src/campaigns.ts Audience.prospects). */
export interface ProspectFilter {
  statuses: string[]; tags: string[]; titles: string[]; sizes: string[]; industries: string[]; countries: string[]; owners: string[]; email_statuses: string[];
  /** One-off: these prospects only (the Prospects page's "Add to a campaign"). */
  prospect_ids: number[];
}
/** Never enrolled, whatever the filter: they are customers, talking to us already, said no, or cannot be reached. */
export const NEVER = ["customer", "replied", "interested", "not_interested", "bad_email"];

export function parseProspectFilter(v: unknown): ProspectFilter {
  const a = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const statuses = strs(a.statuses);
  const bad = statuses.find((s) => !(PROSPECT_STATUSES as readonly string[]).includes(s));
  if (bad) fail(`Unknown prospect status ${bad}`);
  const es = a.email_statuses === undefined ? ["verified"] : strs(a.email_statuses);
  if (es.some((s) => !(EMAIL_STATUSES as readonly string[]).includes(s))) fail(`email_statuses takes ${EMAIL_STATUSES.join(", ")}`);
  const sizes = strs(a.sizes);
  if (sizes.some((s) => !(SIZES as readonly string[]).includes(s))) fail(`sizes takes ${SIZES.join(", ")}`);
  return {
    statuses: statuses.length ? statuses : ["new", "contacted"], tags: strs(a.tags).map((t) => t.toLowerCase()), titles: strs(a.titles), sizes, industries: strs(a.industries),
    countries: strs(a.countries).map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)), owners: strs(a.owners), email_statuses: es,
    prospect_ids: strs(a.prospect_ids, 5000).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0),
  };
}

/** Prospects the filter matches now, one per address, as campaign candidates ({{product}} is their company's name). */
export async function resolveProspects(f: ProspectFilter): Promise<Candidate[]> {
  const rows = await (await getDb()).query<{ id: number; email: string; first_name: string | null; company: string | null; country: string | null; time_zone: string | null }>(
    `SELECT p.id, p.email, p.first_name, c.name AS company, p.country, p.time_zone
       FROM gtm_prospects p LEFT JOIN gtm_companies c ON c.id = p.company_id
      WHERE p.email IS NOT NULL AND p.status = ANY($1::text[]) AND NOT (p.status = ANY($2::text[]))
        AND (cardinality($3::text[]) = 0 OR p.tags && $3::text[])
        AND (cardinality($4::text[]) = 0 OR EXISTS (SELECT 1 FROM unnest($4::text[]) t WHERE strpos(lower(coalesce(p.title, '')), lower(t)) > 0))
        AND (cardinality($5::text[]) = 0 OR c.size = ANY($5::text[]))
        AND (cardinality($6::text[]) = 0 OR EXISTS (SELECT 1 FROM unnest($6::text[]) t WHERE strpos(lower(coalesce(c.industry, '')), lower(t)) > 0))
        AND (cardinality($7::text[]) = 0 OR p.country = ANY($7::text[]))
        AND (cardinality($8::text[]) = 0 OR p.owner = ANY($8::text[]))
        AND (cardinality($9::text[]) = 0 OR p.email_status = ANY($9::text[]))
        AND (cardinality($10::bigint[]) = 0 OR p.id = ANY($10::bigint[]))
      ORDER BY p.id LIMIT 50000`,
    [f.statuses, NEVER, f.tags, f.titles, f.sizes, f.industries, f.countries, f.owners, f.email_statuses, f.prospect_ids]);
  return rows.map((r) => ({ email: r.email, first_name: r.first_name, product: r.company, source: "prospect" as const, org_id: null, org_slug: null, org_name: r.company,
    request_id: null, country: r.country, time_zone: r.time_zone, prospect_id: Number(r.id) }));
}

// ---------- who may get cold email ----------

export type Block = "customer" | "in_sequence" | "cooling_off" | "restricted" | "withdrawn" | "status" | "no_prospect" | "member_check";
export const BLOCK_TEXT: Record<Block, string> = {
  customer: "an existing customer", in_sequence: "in another active sequence", cooling_off: "emailed by another outbound campaign recently",
  restricted: "EU / EEA / UK / CH (or no country): the campaign does not allow them", withdrawn: "withdrew consent",
  status: "replied, interested, not interested, customer or bad address", no_prospect: "no longer a prospect",
  member_check: "customers could not be checked (Clerk did not answer): not this time",
};
/** Days after another outbound campaign's last email before a prospect may join a new one (OUTBOUND_COOLOFF_DAYS). */
export const cooloffDays = () => Math.max(0, Math.trunc(Number(process.env.OUTBOUND_COOLOFF_DAYS ?? 30)) || 0);
/** The B4 hint: a postal address is never required to send (the user's decision), but US law expects one. */
export const POSTAL_WARNING = "US law (CAN-SPAM) requires a postal address in cold email; none is set";

/**
 * For each address (a prospect's), the reason a campaign may not write to them now, or null. `recipientIds`: their
 * row in this campaign, when enrolled (an earlier enrolment elsewhere wins over this one; a later one does not block).
 */
export async function outboundBlocks(people: { email: string; prospect_id?: number | null; recipient_id?: number | null }[], c: { id: number; allow_restricted: boolean },
  members?: MemberIndex): Promise<Map<string, Block | null>> {
  const out = new Map<string, Block | null>();
  if (!people.length) return out;
  const db = await getDb();
  const emails = people.map((p) => p.email.toLowerCase());
  // Every account's people now (cached a minute): Clerk down means nobody is written to this pass (fail closed).
  const idx = members ?? await memberIndex();
  if (idx.error) { for (const e of emails) out.set(e, "member_check"); return out; }
  const days = cooloffDays();
  const [prospects, customers, active, recent, consent] = await Promise.all([
    db.query<{ id: number; email: string; status: string; country: string | null; org_id: number | null; company_org: number | null }>(
      `SELECT p.id, p.email, p.status, p.country, p.org_id, c.org_id AS company_org FROM gtm_prospects p LEFT JOIN gtm_companies c ON c.id = p.company_id WHERE p.email = ANY($1::text[])`, [emails]),
    // Customers: an access request that has an account, or an account member a lifecycle campaign wrote to.
    db.query<{ email: string }>(
      `SELECT lower(email) AS email FROM access_requests WHERE lower(email) = ANY($1::text[]) AND org_id IS NOT NULL
       UNION SELECT email FROM gtm_campaign_recipients WHERE email = ANY($1::text[]) AND source = 'account'`, [emails]),
    // In another sequence: waiting for an email in any other campaign that is not over.
    db.query<{ email: string; id: number }>(
      `SELECT r.email, min(r.id)::bigint AS id FROM gtm_campaign_recipients r JOIN gtm_campaigns k ON k.id = r.campaign_id
        WHERE r.email = ANY($1::text[]) AND r.campaign_id <> $2 AND r.status IN ('pending', 'active') AND k.status <> 'done' GROUP BY r.email`, [emails, c.id]),
    // Cooling off: another outbound campaign emailed them in the last N days.
    db.query<{ email: string }>(
      `SELECT DISTINCT r.email FROM gtm_campaign_recipients r WHERE r.email = ANY($1::text[]) AND r.campaign_id <> $2 AND r.source = 'prospect'
          AND r.last_sent_at > now() - make_interval(days => $3::int)`, [emails, c.id, days]),
    consentOf(emails),
  ]);
  const byEmail = new Map(prospects.map((p) => [p.email, p]));
  const customer = new Set(customers.map((r) => r.email));
  // A company linked to an account: its people are customers' colleagues, never cold-emailed.
  const linkedDomains = new Set((await db.query<{ domain: string }>("SELECT domain FROM gtm_companies WHERE org_id IS NOT NULL AND domain = ANY($1::text[])",
    [[...new Set(emails.map(companyDomainOf).filter((d): d is string => !!d))]])).map((r) => r.domain));
  const activeBy = new Map(active.map((a) => [a.email, Number(a.id)]));
  const cooling = new Set(recent.map((r) => r.email));
  for (const person of people) {
    const e = person.email.toLowerCase(), p = byEmail.get(e);
    const d = companyDomainOf(e);
    let why: Block | null = null;
    if (!p) why = "no_prospect";
    else if (p.org_id != null || p.company_org != null || customer.has(e) || (d && linkedDomains.has(d)) || memberOrg(idx, e) != null) why = "customer";
    else if (NEVER.includes(p.status)) why = "status";
    else if (consent.get(e)?.basis === "withdrawn") why = "withdrawn";
    else if (restrictedCountry(p.country) && !c.allow_restricted) why = "restricted";
    else if (activeBy.has(e) && (person.recipient_id == null || activeBy.get(e)! < person.recipient_id)) why = "in_sequence";
    // Only at enrolment: once in this campaign, its own later emails go on.
    else if (person.recipient_id == null && cooling.has(e)) why = "cooling_off";
    out.set(e, why);
  }
  return out;
}

/** The lawful basis recorded for each prospect address (the recipient's consent_basis). */
export async function basesOf(emails: string[]): Promise<Map<string, string>> {
  if (!emails.length) return new Map();
  const rows = await (await getDb()).query<{ email: string; lawful_basis: string }>("SELECT email, lawful_basis FROM gtm_prospects WHERE email = ANY($1::text[])", [emails.map((e) => e.toLowerCase())]);
  return new Map(rows.map((r) => [r.email, r.lawful_basis]));
}

// ---------- what happens to a prospect when their email does something ----------

/** The first outbound email went out: new -> contacted. */
export async function onSent(prospectId: number | null | undefined, campaignId: number) {
  if (prospectId == null) return;
  await setStatus(Number(prospectId), "contacted", { only_from: ["new"], why: `First email from campaign ${campaignId}` }).catch(() => {});
}

const prospectOfRecipient = async (recipientId: number) =>
  (await (await getDb()).query<{ prospect_id: number | null; campaign_id: number; email: string }>("SELECT prospect_id, campaign_id, email FROM gtm_campaign_recipients WHERE id = $1", [recipientId]))[0];

/** A person replied (src/gtm-replies.ts): their prospect moves to replied (unless further along already). */
export async function onReply(recipientId: number) {
  const r = await prospectOfRecipient(recipientId);
  if (r?.prospect_id != null) await setStatus(Number(r.prospect_id), "replied", { only_from: ["new", "contacted"], why: "Replied to an outbound email" });
}

/** A hard bounce (bad_email) or a complaint (not interested), from Resend's webhook (src/campaigns.ts). */
export async function onBounce(recipientId: number, kind: "bounced" | "complained") {
  const r = await prospectOfRecipient(recipientId);
  if (r?.prospect_id == null) return;
  const id = Number(r.prospect_id);
  if (kind === "bounced") {
    await (await getDb()).query("UPDATE gtm_prospects SET email_status = 'invalid', updated_at = now() WHERE id = $1", [id]);
    await activity(id, "bounced", "A hard bounce: the address does not work", { campaign_id: Number(r.campaign_id) });
    await setStatus(id, "bad_email", { why: "Hard bounce" });
  } else await setStatus(id, "not_interested", { why: "Marked an outbound email as spam" });
}

/** Unsubscribed through the link (src/campaigns.ts unsubscribe): not interested. */
export async function onUnsubscribe(recipientId: number) {
  const r = await prospectOfRecipient(recipientId);
  if (r?.prospect_id == null) return;
  await activity(Number(r.prospect_id), "unsubscribed", "Unsubscribed", { campaign_id: Number(r.campaign_id) });
  await setStatus(Number(r.prospect_id), "not_interested", { why: "Unsubscribed" });
}

/**
 * The reply inbox's quick actions: interested / not interested set the prospect's status (when the reply is from a
 * prospect); unsubscribe suppresses the address (by hash), withdraws consent and stops every sequence for it. Each
 * marks the reply handled.
 */
export async function replyAction(actor: string, replyId: number, action: unknown) {
  if (!["interested", "not_interested", "unsubscribe"].includes(String(action))) fail("action is interested, not_interested or unsubscribe");
  const db = await getDb();
  const [y] = await db.query<{ recipient_id: number; campaign_id: number; prospect_id: number | null; email: string }>(
    `SELECT y.recipient_id, y.campaign_id, r.prospect_id, r.email FROM gtm_replies y JOIN gtm_campaign_recipients r ON r.id = y.recipient_id WHERE y.id = $1`, [replyId]);
  if (!y) fail(`No reply ${replyId}`, 404);
  const pid = y.prospect_id == null ? null : Number(y.prospect_id);
  if (action === "unsubscribe") {
    await db.query("INSERT INTO email_suppressions (email_hash, reason, campaign_id) VALUES ($1, 'unsubscribed', $2) ON CONFLICT (email_hash) DO NOTHING", [mail.hashAddress(y.email), y.campaign_id]);
    await recordConsent(y.email, "withdrawn", { source: "admin", campaign_id: Number(y.campaign_id) });
    await db.query(`UPDATE gtm_campaign_recipients SET status = CASE WHEN status IN ('pending', 'active', 'done', 'replied') THEN 'unsubscribed' ELSE status END,
                           unsubscribed_at = coalesce(unsubscribed_at, now()), next_at = NULL WHERE email = $1`, [y.email]);
    if (pid != null) { await activity(pid, "unsubscribed", "Unsubscribed from the reply inbox", { campaign_id: Number(y.campaign_id) }, actor); await setStatus(pid, "not_interested", { actor, why: "Asked to be removed" }); }
  } else if (pid != null) await setStatus(pid, action as "interested" | "not_interested", { actor, why: "From their reply" });
  await db.query("UPDATE gtm_replies SET handled_at = coalesce(handled_at, now()), handled_by = coalesce(handled_by, $2) WHERE id = $1", [replyId, actor]);
  log(actor, `gtm.reply_${action}`, null, { reply_id: replyId, campaign_id: Number(y.campaign_id), prospect_id: pid });
  return { id: replyId, action, prospect_id: pid };
}

/** The outbound footer: why they get it, the unsubscribe link, the postal address when set (optional, never blocks). */
export const outboundFooter = (url: string, postal: string) =>
  `\n\n--\nYou're getting this one-to-one business email because of your role. Not interested? Unsubscribe: ${url}${postal ? `\n${postal}` : ""}`;
