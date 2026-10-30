/**
 * GTM › Prospects and Companies (/admin/gtm/prospects, /admin/gtm/companies): a light CRM for outbound. People and
 * companies Octillion may write to cold, where they came from (a CSV, Apollo, by hand), the lawful basis for writing
 * to each, and what happened (the timeline). Owners only to change (admin-roles.ts "campaigns"); any admin reads.
 *
 *   companies   gtm_companies, one per domain (example.com: no www., no path; the dedupe key). Linked to an Octillion
 *               account when someone from that domain signs up (never a free-mail domain).
 *   prospects   gtm_prospects, one per address (the dedupe key; Apollo's person id dedupes people found without one
 *               yet). Status new -> contacted -> replied -> interested | not_interested, customer, bad_email. A
 *               lawful basis is required: legitimate_interest (B2B, relevant to their role), consent, contract.
 *   privacy     a prospect's address lives in gtm_prospects only, and in gtm_campaign_recipients / gtm_replies once a
 *               campaign writes to them. Activities, companies, deals, events and the Apollo cache never hold one.
 *   import      CSV rows already mapped to fields by the page (POST /gtm/prospects/import): a dry run shows what would
 *               happen to each row (create, update, skip as a duplicate in the file, refuse: no lawful basis, a bad
 *               address, on the suppression list by hash, or someone in the EU / EEA / UK / CH without a basis given
 *               for them); the real run writes it. Existing people are filled in, never overwritten.
 *   linking     an access request, an approval or a new account (src/gtm-events.ts emits; linkFromEvent here) links
 *               the prospect with that address (status customer once there is an account) and the company with that
 *               domain, writes a timeline entry and a prospect_converted event (Attribution credits it).
 *   timeline    the prospect's own entries (notes, status changes, import, enrichment, links, deals) and, from the
 *               campaign tables, each email sent, opened, clicked, bounced and each reply.
 */
import { getDomain } from "tldts";
import { getDb, type Queryable } from "./db.js";
import { AdminError, log, accountPeople } from "./admin.js";
import * as mail from "./email.js";
import { cleanCountry, OPT_IN_COUNTRIES } from "./gtm-consent.js";
import { validZone } from "./gtm-schedule.js";

export const PROSPECT_STATUSES = ["new", "contacted", "replied", "interested", "not_interested", "customer", "bad_email"] as const;
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];
export const BASES = ["legitimate_interest", "consent", "contract"] as const;
export type Basis = (typeof BASES)[number];
export const EMAIL_STATUSES = ["verified", "unverified", "likely_to_engage", "extrapolated", "unavailable", "invalid", "unknown"] as const;
export const SIZES = ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001+"] as const;
const IMPORT_MAX = 5000, IMPORT_CHUNK = 200;

/** Mail providers anyone can sign up to: their domain says nothing about a company, so it never links or dedupes one. */
export const FREEMAIL = new Set(["gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com",
  "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.de", "gmx.net", "web.de", "mail.com", "yandex.com", "yandex.ru", "qq.com", "163.com",
  "126.com", "zoho.com", "fastmail.com", "hey.com", "tutanota.com", "mail.ru", "rediffmail.com"]);

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : typeof v === "number" ? String(v) : "");
const opt = (v: unknown, max: number) => str(v, max) || null;
const fail = (msg: string, status = 400): never => { throw new AdminError(msg, status); };
const idOf = (v: unknown, what: string) => { const n = Number(v); if (!Number.isSafeInteger(n) || n <= 0) fail(`Invalid ${what} id`); return n; };
export const tagsOf = (v: unknown) => [...new Set((Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;|]/) : []).map((x) => str(x, 40).toLowerCase()).filter(Boolean))].slice(0, 20);

/** example.com from "https://www.Example.com/about", "example.com" or "a@example.com"; null when it is not a domain. */
export function domainOf(v: unknown): string | null {
  let s = str(v, 300).toLowerCase();
  if (!s) return null;
  if (s.includes("@")) s = s.split("@").pop()!;
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#:]/)[0]!.replace(/\.$/, "");
  return /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s) ? s : null;
}
/** A company domain from an address: none for a free-mail provider. */
export const companyDomainOf = (email: string) => { const d = domainOf(email); return d && !FREEMAIL.has(d) ? d : null; };
/** Countries where outreach needs a recorded basis and a campaign that allows them (and anywhere unknown). */
export const restrictedCountry = (c: string | null | undefined) => !c || OPT_IN_COUNTRIES.has(c.toUpperCase());
const sizeOf = (v: unknown, employees?: number | null): string | null => {
  const s = str(v, 20);
  if ((SIZES as readonly string[]).includes(s)) return s;
  const n = employees ?? (s ? Number(s.replace(/[^\d]/g, "")) : NaN);
  if (!Number.isFinite(n) || n <= 0) return s ? s.slice(0, 20) : null;
  return n <= 10 ? "1-10" : n <= 50 ? "11-50" : n <= 200 ? "51-200" : n <= 500 ? "201-500" : n <= 1000 ? "501-1000" : n <= 5000 ? "1001-5000" : "5001+";
};
/** LinkedIn profile URL as typed, kept as text (https only, linkedin.com only); nothing ever fetches it. */
const linkedinOf = (v: unknown) => { const s = str(v, 300); return /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\//i.test(s) ? s.replace(/^http:/i, "https:") : null; };

// ---------- companies ----------

export interface CompanyInput { domain?: unknown; name?: unknown; industry?: unknown; size?: unknown; employees?: unknown; country?: unknown; source?: unknown; owner?: unknown }

/**
 * The company for a domain: created when new, else its empty fields filled (never overwritten). Returns its id and
 * whether it was new. The one place a company is written from an import or Apollo.
 */
export async function upsertCompany(domain: string, f: CompanyInput, source: string, q?: Queryable): Promise<{ id: number; created: boolean }> {
  const employees = f.employees == null || f.employees === "" ? null : Math.max(0, Math.trunc(Number(f.employees))) || null;
  const [r] = await (q ?? await getDb()).query<{ id: number; created: boolean }>(
    `INSERT INTO gtm_companies (domain, name, industry, size, employees, country, source, owner) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (domain) DO UPDATE SET name = CASE WHEN gtm_companies.name = gtm_companies.domain AND excluded.name <> excluded.domain THEN excluded.name ELSE gtm_companies.name END,
            industry = coalesce(gtm_companies.industry, excluded.industry), size = coalesce(gtm_companies.size, excluded.size),
            employees = coalesce(gtm_companies.employees, excluded.employees), country = coalesce(gtm_companies.country, excluded.country),
            owner = coalesce(gtm_companies.owner, excluded.owner), updated_at = now()
     RETURNING id, (xmax = 0) AS created`,
    [domain, str(f.name, 200) || domain, opt(f.industry, 120), sizeOf(f.size, employees), employees, cleanCountry(f.country), source, opt(f.owner, 120)]);
  return { id: Number(r.id), created: Boolean(r.created) };
}

export async function listCompanies() {
  const rows = await (await getDb()).query<Record<string, unknown>>(
    `SELECT c.id, c.domain, c.name, c.industry, c.size, c.employees, c.country, c.source, c.owner, c.org_id, o.slug AS org_slug, o.name AS org_name, c.linked_at,
            c.enriched_at, c.enrichment_source, c.created_at, c.updated_at,
            (SELECT count(*)::int FROM gtm_prospects p WHERE p.company_id = c.id) AS prospects,
            (SELECT count(*)::int FROM gtm_deals d WHERE d.company_id = c.id) AS deals,
            (SELECT coalesce(sum(d.value), 0)::float8 FROM gtm_deals d JOIN gtm_deal_stages s ON s.id = d.stage WHERE d.company_id = c.id AND s.kind = 'open') AS pipeline
       FROM gtm_companies c LEFT JOIN organizations o ON o.id = c.org_id ORDER BY c.updated_at DESC, c.id DESC LIMIT 20000`);
  return { companies: rows.map((r) => ({ ...r, id: Number(r.id) })), sizes: SIZES };
}

export async function companyDetail(id: number) {
  const db = await getDb();
  const [c] = await db.query<Record<string, unknown>>(
    `SELECT c.*, o.slug AS org_slug, o.name AS org_name FROM gtm_companies c LEFT JOIN organizations o ON o.id = c.org_id WHERE c.id = $1`, [idOf(id, "company")]);
  if (!c) fail(`No company ${id}`, 404);
  const prospects = await db.query(`SELECT id, first_name, last_name, title, email, email_status, status FROM gtm_prospects WHERE company_id = $1 ORDER BY id`, [id]);
  const deals = await db.query(`SELECT d.id, d.name, d.stage, s.label AS stage_label, s.kind, d.value::float8 AS value, d.currency FROM gtm_deals d JOIN gtm_deal_stages s ON s.id = d.stage WHERE d.company_id = $1 ORDER BY d.id`, [id]);
  return { company: { ...c, id: Number(c.id) }, prospects, deals };
}

export async function createCompany(actor: string, body: CompanyInput) {
  const domain = domainOf(body.domain) ?? fail("Give the company's domain, e.g. example.com");
  const db = await getDb();
  if ((await db.query("SELECT 1 FROM gtm_companies WHERE domain = $1", [domain])).length) fail(`${domain} is already a company`, 409);
  const { id } = await upsertCompany(domain, { ...body, owner: body.owner ?? actor }, str(body.source, 40) || "manual");
  log(actor, "gtm.company_create", null, { company_id: id, domain });
  return companyDetail(id);
}

export async function updateCompany(actor: string, id: number, body: CompanyInput) {
  const db = await getDb();
  const set: string[] = [], vals: unknown[] = [idOf(id, "company")];
  const put = (col: string, v: unknown) => { vals.push(v); set.push(`${col} = $${vals.length}`); };
  if (body.name !== undefined) put("name", str(body.name, 200) || fail("A company needs a name"));
  if (body.domain !== undefined) {
    const d = domainOf(body.domain) ?? fail("Not a domain");
    // A company linked to an account keeps its domain: its people stay recognised as the customer's.
    const [cur] = await db.query<{ domain: string; org_id: number | null }>("SELECT domain, org_id FROM gtm_companies WHERE id = $1", [id]);
    if (cur && cur.org_id != null && cur.domain !== d) fail("This company is linked to an Octillion account: its domain cannot change", 409);
    put("domain", d);
  }
  if (body.industry !== undefined) put("industry", opt(body.industry, 120));
  if (body.size !== undefined) put("size", sizeOf(body.size));
  if (body.country !== undefined) put("country", cleanCountry(body.country));
  if (body.owner !== undefined) put("owner", opt(body.owner, 120));
  if (!set.length) return companyDetail(id);
  const r = await db.query(`UPDATE gtm_companies SET ${set.join(", ")}, updated_at = now() WHERE id = $1 RETURNING id`, vals).catch((e: { code?: string }) => {
    if (e.code === "23505") fail("Another company has that domain", 409);
    throw e;
  });
  if (!r.length) fail(`No company ${id}`, 404);
  log(actor, "gtm.company_update", null, { company_id: id, fields: Object.keys(body) });
  return companyDetail(id);
}

/**
 * CSV rows (mapped to domain, name, industry, size, country, owner) into companies, deduped by domain (in the file
 * and against existing ones, which are filled in, never overwritten). dry_run: what would happen, nothing written.
 */
export async function importCompanies(actor: string, body: { rows?: unknown; dry_run?: unknown; source?: unknown }) {
  const rows = Array.isArray(body.rows) ? (body.rows as (CompanyInput & { website?: unknown })[]) : fail("rows must be a list");
  if (rows.length > IMPORT_MAX) fail(`At most ${IMPORT_MAX} rows at a time`);
  const dry = body.dry_run !== false, source = str(body.source, 40) || "csv";
  const domains = rows.map((r) => domainOf(r?.domain) ?? domainOf(r?.website));
  const known = new Set((await (await getDb()).query<{ domain: string }>("SELECT domain FROM gtm_companies WHERE domain = ANY($1::text[])", [domains.filter(Boolean)])).map((r) => r.domain));
  const seen = new Set<string>();
  const out = rows.map((r, i) => {
    const d = domains[i];
    const res = { row: i + 1, action: "create" as "create" | "update" | "skip" | "refuse", reason: null as string | null, domain: d, name: str(r?.name, 200) || d };
    if (!d) Object.assign(res, { action: "refuse", reason: "No company domain (or website)" });
    else if (seen.has(d)) Object.assign(res, { action: "skip", reason: "Duplicate of an earlier row in this file" });
    else if (known.has(d)) Object.assign(res, { action: "update", reason: "Already a company: empty fields are filled in" });
    if (d) seen.add(d);
    return res;
  });
  const count = (a: string) => out.filter((r) => r.action === a).length;
  const summary = { rows: rows.length, create: count("create"), update: count("update"), skip: count("skip"), refuse: count("refuse") };
  if (!dry) {
    for (const [i, r] of out.entries()) if (r.action === "create" || r.action === "update") await upsertCompany(r.domain!, { ...rows[i], owner: rows[i].owner ?? actor }, source);
    log(actor, "gtm.company_import", null, summary);
  }
  return { dry_run: dry, summary, rows: out };
}

export async function deleteCompany(actor: string, id: number) {
  // Linked to an account: kept, so its people are never taken for cold prospects again.
  const [c] = await (await getDb()).query<{ org_id: number | null }>("SELECT org_id FROM gtm_companies WHERE id = $1", [idOf(id, "company")]);
  if (!c) fail(`No company ${id}`, 404);
  if (c.org_id != null) fail("This company is linked to an Octillion account and cannot be deleted", 409);
  await (await getDb()).query("DELETE FROM gtm_companies WHERE id = $1", [id]);
  log(actor, "gtm.company_delete", null, { company_id: id });
}

// ---------- prospects ----------

export async function activity(prospectId: number, type: string, body: string | null, data: Record<string, unknown> = {}, actor: string | null = null, q?: Queryable) {
  await (q ?? await getDb()).query("INSERT INTO gtm_prospect_activities (prospect_id, type, body, data, actor) VALUES ($1, $2, $3, $4::jsonb, $5)",
    [prospectId, type, body?.slice(0, 4000) ?? null, JSON.stringify(data), actor]);
}

/** Every prospect, with its company, whether its address is suppressed, and its outbound numbers (the page filters and pages). */
export async function listProspects() {
  const db = await getDb();
  const rows = await db.query<Record<string, unknown> & { id: number; email: string | null }>(
    `SELECT p.id, p.first_name, p.last_name, p.title, p.seniority, p.email, p.email_status, p.linkedin_url, p.country, p.time_zone, p.status, p.owner, p.tags,
            p.source, p.lawful_basis, p.basis_note, p.org_id, o.slug AS org_slug, p.request_id, p.linked_at, p.enriched_at, p.enrichment_source, p.created_at, p.updated_at,
            p.company_id, c.name AS company, c.domain AS company_domain, c.industry, c.size AS company_size, c.org_id AS company_org_id,
            (SELECT count(*)::int FROM gtm_campaign_recipients r WHERE r.prospect_id = p.id AND r.first_sent_at IS NOT NULL) AS campaigns,
            (SELECT max(r.last_sent_at) FROM gtm_campaign_recipients r WHERE r.prospect_id = p.id) AS last_emailed_at,
            EXISTS (SELECT 1 FROM gtm_campaign_recipients r JOIN gtm_campaigns k ON k.id = r.campaign_id
                     WHERE r.prospect_id = p.id AND r.status IN ('pending', 'active') AND k.status IN ('running', 'paused', 'scheduled')) AS in_sequence
       FROM gtm_prospects p LEFT JOIN gtm_companies c ON c.id = p.company_id LEFT JOIN organizations o ON o.id = p.org_id
      ORDER BY p.updated_at DESC, p.id DESC LIMIT 20000`);
  const suppressed = await suppressedOf(rows.flatMap((r) => (r.email ? [r.email] : [])));
  return {
    statuses: PROSPECT_STATUSES, bases: BASES, email_statuses: EMAIL_STATUSES, sizes: SIZES,
    prospects: rows.map((r) => ({ ...r, id: Number(r.id), company_id: r.company_id == null ? null : Number(r.company_id), suppressed: !!r.email && suppressed.has(r.email),
      restricted: restrictedCountry(r.country as string | null) })),
  };
}

/** The addresses (lowercased) on the suppression list, checked by hash. */
export async function suppressedOf(emails: string[]): Promise<Set<string>> {
  if (!emails.length) return new Set();
  const byHash = new Map(emails.map((e) => [mail.hashAddress(e), e.toLowerCase()]));
  const rows = await (await getDb()).query<{ email_hash: string }>("SELECT email_hash FROM email_suppressions WHERE email_hash = ANY($1::text[])", [[...byHash.keys()]]);
  return new Set(rows.map((r) => byHash.get(r.email_hash)!));
}

export interface ProspectInput {
  email?: unknown; first_name?: unknown; last_name?: unknown; name?: unknown; title?: unknown; seniority?: unknown; linkedin_url?: unknown; country?: unknown; time_zone?: unknown;
  owner?: unknown; tags?: unknown; source?: unknown; lawful_basis?: unknown; basis_note?: unknown; status?: unknown; email_status?: unknown;
  company?: unknown; domain?: unknown; website?: unknown; industry?: unknown; size?: unknown; company_country?: unknown; company_id?: unknown; apollo_id?: unknown;
}
const basisOf = (v: unknown): Basis | null => {
  const s = str(v, 60).toLowerCase().replace(/[\s-]+/g, "_");
  if ((BASES as readonly string[]).includes(s)) return s as Basis;
  // What people type: "legitimate interest (B2B)", "LI", "consented".
  if (/^(li|legitimate_?interest.*|b2b.*)$/.test(s)) return "legitimate_interest";
  if (/^(consent.*|opt_?in)$/.test(s)) return "consent";
  if (/^contract.*$/.test(s)) return "contract";
  return null;
};
const nameParts = (f: ProspectInput) => {
  let first = str(f.first_name, 80), last = str(f.last_name, 80);
  if (!first && !last && str(f.name, 160)) { const [a, ...b] = str(f.name, 160).split(/\s+/); first = a ?? ""; last = b.join(" "); }
  return { first: first || null, last: last || null };
};

export async function prospectDetail(id: number) {
  const db = await getDb();
  const [p] = await db.query<Record<string, unknown> & { email: string | null; country: string | null }>(
    `SELECT p.*, c.name AS company, c.domain AS company_domain, c.industry, c.size AS company_size, c.org_id AS company_org_id, o.slug AS org_slug, o.name AS org_name
       FROM gtm_prospects p LEFT JOIN gtm_companies c ON c.id = p.company_id LEFT JOIN organizations o ON o.id = p.org_id WHERE p.id = $1`, [idOf(id, "prospect")]);
  if (!p) fail(`No prospect ${id}`, 404);
  const suppressed = p.email ? (await suppressedOf([p.email])).size > 0 : false;
  const deals = await db.query(`SELECT d.id, d.name, d.stage, s.label AS stage_label, s.kind, d.value::float8 AS value, d.currency FROM gtm_deals d JOIN gtm_deal_stages s ON s.id = d.stage WHERE d.prospect_id = $1 ORDER BY d.id`, [id]);
  return { prospect: { ...p, id: Number(p.id), suppressed, restricted: restrictedCountry(p.country) }, timeline: await timeline(Number(p.id)), deals };
}

export async function createProspect(actor: string, body: ProspectInput) {
  const r = await importProspects(actor, { rows: [body], dry_run: false, source: str(body.source, 40) || "manual", lawful_basis: body.lawful_basis, owner: body.owner ?? actor, explicit_restricted: true });
  const row = r.rows[0];
  if (row.action === "refuse") fail(row.reason ?? "Refused");
  if (row.action === "update") fail(`${row.email} is already a prospect`, 409);
  return prospectDetail(row.prospect_id!);
}

/** Edit a prospect (a status change is a timeline entry). Owners only. */
export async function updateProspect(actor: string, id: number, body: ProspectInput & { note?: unknown }) {
  const db = await getDb();
  const [before] = await db.query<{ status: string; email: string | null }>("SELECT status, email FROM gtm_prospects WHERE id = $1", [idOf(id, "prospect")]);
  if (!before) fail(`No prospect ${id}`, 404);
  const set: string[] = [], vals: unknown[] = [id];
  const put = (col: string, v: unknown) => { vals.push(v); set.push(`${col} = $${vals.length}`); };
  if (body.email !== undefined) {
    const e = str(body.email, 254).toLowerCase();
    if (e && !mail.isEmail(e)) fail("Not a valid email address");
    if (e && (await suppressedOf([e])).size) fail("That address is on the suppression list (unsubscribed, bounced or complained): it cannot be a prospect's address");
    put("email", e || null);
    if (e !== before.email) put("email_status", "unknown");
  }
  if (body.first_name !== undefined) put("first_name", opt(body.first_name, 80));
  if (body.last_name !== undefined) put("last_name", opt(body.last_name, 80));
  if (body.title !== undefined) put("title", opt(body.title, 160));
  if (body.linkedin_url !== undefined) put("linkedin_url", body.linkedin_url === "" || body.linkedin_url == null ? null : linkedinOf(body.linkedin_url) ?? fail("LinkedIn URL: a https://linkedin.com/… address"));
  if (body.country !== undefined) put("country", cleanCountry(body.country));
  if (body.time_zone !== undefined) put("time_zone", body.time_zone === "" || body.time_zone == null ? null : validZone(body.time_zone) ? body.time_zone : fail("Time zone: an IANA name, e.g. Europe/Berlin"));
  if (body.owner !== undefined) put("owner", opt(body.owner, 120));
  if (body.tags !== undefined) put("tags", tagsOf(body.tags));
  if (body.lawful_basis !== undefined) { put("lawful_basis", basisOf(body.lawful_basis) ?? fail(`lawful_basis is one of ${BASES.join(", ")}`)); set.push("basis_at = now()"); }
  if (body.basis_note !== undefined) put("basis_note", opt(body.basis_note, 300));
  if (body.company_id !== undefined) put("company_id", body.company_id == null || body.company_id === "" ? null : idOf(body.company_id, "company"));
  const status = body.status !== undefined ? statusOf(body.status) : null;
  if (status) put("status", status);
  if (set.length) await db.query(`UPDATE gtm_prospects SET ${set.join(", ")}, updated_at = now() WHERE id = $1`, vals).catch((e: { code?: string }) => {
    if (e.code === "23505") fail("Another prospect has that address", 409);
    throw e;
  });
  if (status && status !== before.status) await activity(id, "status", null, { from: before.status, to: status }, actor);
  if (status && status !== before.status && STOPPING.includes(status)) await stopOutbound(id);
  if (str(body.note, 4000)) await activity(id, "note", str(body.note, 4000), {}, actor);
  log(actor, "gtm.prospect_update", null, { prospect_id: id, fields: Object.keys(body).filter((k) => k !== "email") });
  return prospectDetail(id);
}
const statusOf = (v: unknown): ProspectStatus => ((PROSPECT_STATUSES as readonly string[]).includes(String(v)) ? (v as ProspectStatus) : fail(`status is one of ${PROSPECT_STATUSES.join(", ")}`));

/** Set a prospect's status from the system (a reply, a bounce, a link) or a quick action, with a timeline entry. */
export async function setStatus(prospectId: number, to: ProspectStatus, o: { actor?: string | null; why?: string; only_from?: ProspectStatus[] } = {}) {
  const [r] = await (await getDb()).query<{ from: string }>(
    `UPDATE gtm_prospects p SET status = $2, updated_at = now() FROM (SELECT status FROM gtm_prospects WHERE id = $1) old
      WHERE p.id = $1 AND p.status <> $2 AND ($3::text[] IS NULL OR p.status = ANY($3::text[])) RETURNING old.status AS from`,
    [prospectId, to, o.only_from ?? null]);
  if (r) await activity(prospectId, "status", o.why ?? null, { from: r.from, to }, o.actor ?? null);
  if (r && STOPPING.includes(to)) await stopOutbound(prospectId);
  return !!r;
}

/** Statuses that end every cold sequence for the person: a customer now, said no, or the address does not work. */
export const STOPPING: string[] = ["customer", "not_interested", "bad_email"];
/**
 * Stop a prospect's open outbound sequences: their waiting recipient rows are suppressed (nothing more is sent), and
 * an email whose outcome is still uncertain is parked as unknown (never replayed; and an owner's Resend skips anyone
 * no longer waiting). Returns how many sequences it stopped.
 */
export async function stopOutbound(prospectId: number) {
  const db = await getDb();
  const rs = await db.query<{ id: number }>(
    `UPDATE gtm_campaign_recipients SET status = 'suppressed', next_at = NULL WHERE prospect_id = $1 AND source = 'prospect' AND status IN ('pending', 'active') RETURNING id`, [prospectId]);
  if (rs.length) await db.query(
    `UPDATE gtm_campaign_sends SET status = 'unknown', error = 'Stopped: the prospect is a customer, said no, or their address does not work' WHERE recipient_id = ANY($1::bigint[]) AND status = 'uncertain'`,
    [rs.map((r) => Number(r.id))]);
  return rs.length;
}

export async function addNote(actor: string, id: number, text: unknown) {
  const body = str(text, 4000);
  if (!body) fail("Write a note");
  const [p] = await (await getDb()).query("SELECT 1 FROM gtm_prospects WHERE id = $1", [idOf(id, "prospect")]);
  if (!p) fail(`No prospect ${id}`, 404);
  await activity(id, "note", body, {}, actor);
  log(actor, "gtm.prospect_note", null, { prospect_id: id });
  return prospectDetail(id);
}

export async function deleteProspects(actor: string, ids: unknown) {
  const list = (Array.isArray(ids) ? ids : [ids]).map((x) => idOf(x, "prospect"));
  const r = await (await getDb()).query("DELETE FROM gtm_prospects WHERE id = ANY($1::bigint[]) RETURNING id", [list]);
  log(actor, "gtm.prospect_delete", null, { count: r.length });
  return { deleted: r.length };
}

/** Bulk: status, tags added, owner, on many prospects at once. */
export async function bulkUpdate(actor: string, body: { ids?: unknown; status?: unknown; add_tags?: unknown; owner?: unknown }) {
  const ids = (Array.isArray(body.ids) ? body.ids : []).map((x) => idOf(x, "prospect")).slice(0, 5000);
  if (!ids.length) fail("Choose some prospects");
  let n = 0;
  if (body.status !== undefined) { const s = statusOf(body.status); for (const id of ids) if (await setStatus(id, s, { actor })) n++; }
  const db = await getDb();
  if (body.add_tags !== undefined) await db.query(`UPDATE gtm_prospects SET tags = coalesce((SELECT array_agg(DISTINCT t) FROM unnest(tags || $2::text[]) t), '{}'), updated_at = now() WHERE id = ANY($1::bigint[])`, [ids, tagsOf(body.add_tags)]);
  if (body.owner !== undefined) await db.query("UPDATE gtm_prospects SET owner = $2, updated_at = now() WHERE id = ANY($1::bigint[])", [ids, opt(body.owner, 120)]);
  log(actor, "gtm.prospect_bulk", null, { count: ids.length, status_changed: n });
  return { updated: ids.length };
}

// ---------- import ----------

export interface ImportRowResult {
  row: number; action: "create" | "update" | "skip" | "refuse"; reason: string | null; email: string | null; name: string | null; company: string | null;
  domain: string | null; country: string | null; basis: Basis | null; suppressed: boolean; prospect_id?: number;
  /** The real run: written (its chunk committed). */
  applied?: boolean;
}

/**
 * CSV rows (already mapped to fields) into prospects and companies. dry_run: what would happen to each row, nothing
 * written. Every row needs a lawful basis: its own (a lawful_basis column) or the import's (lawful_basis). People in
 * the EU / EEA / UK / CH need it explicitly: their own column, or the import's basis with explicit_restricted ticked.
 * Refused: no basis, an invalid address, an address on the suppression list (checked by hash), nobody to identify
 * (no address, and no name with a company domain). Duplicates within the file are skipped; an existing prospect (by
 * address, else Apollo id) is filled in where empty, never overwritten.
 */
export async function importProspects(actor: string, body: { rows?: unknown; dry_run?: unknown; lawful_basis?: unknown; basis_note?: unknown; explicit_restricted?: unknown;
  tags?: unknown; owner?: unknown; source?: unknown }) {
  const rows = Array.isArray(body.rows) ? (body.rows as ProspectInput[]) : fail("rows must be a list");
  if (rows.length > IMPORT_MAX) fail(`At most ${IMPORT_MAX} rows at a time`);
  const dry = body.dry_run !== false;
  const defaultBasis = body.lawful_basis == null || body.lawful_basis === "" ? null : basisOf(body.lawful_basis) ?? fail(`lawful_basis is one of ${BASES.join(", ")}`);
  const explicitRestricted = body.explicit_restricted === true;
  const extraTags = tagsOf(body.tags), owner = opt(body.owner, 120) ?? actor, source = str(body.source, 40) || "csv", note = opt(body.basis_note, 300);
  const db = await getDb();
  const emails = rows.map((r) => str(r?.email, 254).toLowerCase()).filter((e) => mail.isEmail(e));
  const [suppressed, existing] = await Promise.all([suppressedOf(emails),
    emails.length ? db.query<{ id: number; email: string }>("SELECT id, email FROM gtm_prospects WHERE email = ANY($1::text[])", [emails]) : []]);
  const have = new Map(existing.map((x) => [x.email, Number(x.id)]));
  const apolloIds = rows.map((r) => str(r?.apollo_id, 80)).filter(Boolean);
  const haveApollo = new Map((apolloIds.length ? await db.query<{ id: number; apollo_id: string }>("SELECT id, apollo_id FROM gtm_prospects WHERE apollo_id = ANY($1::text[])", [apolloIds]) : [])
    .map((x) => [x.apollo_id, Number(x.id)]));
  const seen = new Set<string>();
  const out: ImportRowResult[] = [];
  let companiesNew = 0;
  const newDomains = new Set<string>();
  const companyIds = [...new Set(rows.flatMap((r) => (r?.company_id != null && r.company_id !== "" ? [Number(r.company_id)] : [])).filter((n) => Number.isSafeInteger(n) && n > 0))];
  const knownCompanies = new Set((companyIds.length ? await db.query<{ id: number }>("SELECT id FROM gtm_companies WHERE id = ANY($1::bigint[])", [companyIds]) : []).map((r) => Number(r.id)));
  for (const [i, raw] of rows.entries()) {
    const f = (raw && typeof raw === "object" ? raw : {}) as ProspectInput;
    const email = str(f.email, 254).toLowerCase() || null;
    const { first, last } = nameParts(f);
    const domain = domainOf(f.domain) ?? domainOf(f.website) ?? (email ? companyDomainOf(email) : null);
    const country = cleanCountry(f.country);
    const own = f.lawful_basis == null || f.lawful_basis === "" ? null : basisOf(f.lawful_basis);
    const basis = own ?? defaultBasis;
    const apolloId = str(f.apollo_id, 80) || null;
    const res: ImportRowResult = { row: i + 1, action: "create", reason: null, email, name: [first, last].filter(Boolean).join(" ") || null, company: str(f.company, 200) || domain,
      domain, country, basis, suppressed: !!email && suppressed.has(email) };
    const key = email ?? (apolloId ? `apollo:${apolloId}` : `${(first ?? "").toLowerCase()} ${(last ?? "").toLowerCase()}@${domain ?? ""}`);
    const existingId = (email && have.get(email)) || (apolloId ? haveApollo.get(apolloId) : undefined);
    const companyId = f.company_id == null || f.company_id === "" ? null : Number(f.company_id);
    if (email && !mail.isEmail(email)) Object.assign(res, { action: "refuse", reason: "Not a valid email address" });
    else if (!email && !apolloId && !(first && domain)) Object.assign(res, { action: "refuse", reason: "No email address, and no name with a company domain" });
    else if (f.lawful_basis != null && f.lawful_basis !== "" && !own) Object.assign(res, { action: "refuse", reason: `Unknown lawful basis "${str(f.lawful_basis, 40)}": use ${BASES.join(", ")}` });
    else if (!basis) Object.assign(res, { action: "refuse", reason: "No lawful basis: add a lawful_basis column or choose one for the import" });
    // Someone new in the EU / EEA / UK / CH, or with no country at all, needs their basis given explicitly (an existing
    // prospect keeps the basis they have).
    else if (!existingId && restrictedCountry(country) && !own && !explicitRestricted)
      Object.assign(res, { action: "refuse", reason: country ? `${country} is in the EU / EEA / UK / CH: give this person's lawful basis explicitly` : "No country: give this person's lawful basis explicitly (or a country)" });
    else if (res.suppressed) Object.assign(res, { action: "refuse", reason: "On the suppression list (unsubscribed, bounced or complained)" });
    else if (!domain && companyId != null && !knownCompanies.has(companyId)) Object.assign(res, { action: "refuse", reason: `No company ${String(f.company_id).slice(0, 20)}` });
    else if (seen.has(key)) Object.assign(res, { action: "skip", reason: "Duplicate of an earlier row in this file" });
    else if (existingId) Object.assign(res, { action: "update", reason: "Already a prospect: empty fields are filled in", prospect_id: existingId });
    seen.add(key);
    if (domain && (res.action === "create" || res.action === "update") && !newDomains.has(domain)) newDomains.add(domain);
    out.push(res);
  }
  if (newDomains.size) {
    const known = new Set((await db.query<{ domain: string }>("SELECT domain FROM gtm_companies WHERE domain = ANY($1::text[])", [[...newDomains]])).map((r) => r.domain));
    companiesNew = [...newDomains].filter((d) => !known.has(d)).length;
  }
  const count = (a: ImportRowResult["action"]) => out.filter((r) => r.action === a).length;
  const summary = { rows: rows.length, create: count("create"), update: count("update"), skip: count("skip"), refuse: count("refuse"), suppressed: out.filter((r) => r.suppressed).length, companies_new: companiesNew };
  if (dry) return { dry_run: true, summary, rows: out };

  // Written in transactions of IMPORT_CHUNK rows: a chunk is applied whole or not at all, and the answer says which
  // rows were (a timeout or an error part-way leaves earlier chunks in, never half of one).
  const written: number[] = [];
  const todo = out.map((res, i) => ({ res, i })).filter((x) => x.res.action === "create" || x.res.action === "update");
  let failed: string | null = null;
  for (let k = 0; k < todo.length && !failed; k += IMPORT_CHUNK) {
    const chunk = todo.slice(k, k + IMPORT_CHUNK);
    try {
      const done = await db.transaction(async (tx) => {
        const ids: number[] = [];
        for (const { res, i } of chunk) {
          const f = rows[i] as ProspectInput;
          const { first, last } = nameParts(f);
          const companyId = res.domain ? (await upsertCompany(res.domain, { name: f.company, industry: f.industry, size: f.size, country: f.company_country ?? f.country, owner }, source, tx)).id
            : f.company_id != null && f.company_id !== "" ? Number(f.company_id) : null;
          const tags = [...new Set([...tagsOf(f.tags), ...extraTags])];
          const tz = validZone(f.time_zone) ? (f.time_zone as string) : null;
          const emailStatus = (EMAIL_STATUSES as readonly string[]).includes(String(f.email_status)) ? String(f.email_status) : "unknown";
          if (res.action === "update") {
            await tx.query(
              `UPDATE gtm_prospects SET email = coalesce(email, $2), first_name = coalesce(first_name, $3), last_name = coalesce(last_name, $4), title = coalesce(title, $5),
                      seniority = coalesce(seniority, $6), linkedin_url = coalesce(linkedin_url, $7), country = coalesce(country, $8), time_zone = coalesce(time_zone, $9),
                      tags = coalesce((SELECT array_agg(DISTINCT t) FROM unnest(tags || $10::text[]) t), '{}'), company_id = coalesce(company_id, $11), apollo_id = coalesce(apollo_id, $12),
                      email_status = CASE WHEN email_status = 'unknown' THEN $13 ELSE email_status END, updated_at = now() WHERE id = $1`,
              [res.prospect_id, res.email, first, last, opt(f.title, 160), opt(f.seniority, 40), linkedinOf(f.linkedin_url), res.country, tz, tags, companyId, opt(f.apollo_id, 80), emailStatus]);
            ids.push(res.prospect_id!);
            continue;
          }
          const [p] = await tx.query<{ id: number }>(
            `INSERT INTO gtm_prospects (email, first_name, last_name, title, seniority, linkedin_url, country, time_zone, owner, tags, source, lawful_basis, basis_note, company_id, apollo_id, email_status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
             ON CONFLICT DO NOTHING RETURNING id`,
            [res.email, first, last, opt(f.title, 160), opt(f.seniority, 40), linkedinOf(f.linkedin_url), res.country, tz, owner, tags, source, res.basis,
             opt(f.basis_note, 300) ?? note, companyId, opt(f.apollo_id, 80), emailStatus]);
          if (!p) { res.action = "skip"; res.reason = "Added by someone else meanwhile"; continue; }
          res.prospect_id = Number(p.id);
          ids.push(res.prospect_id);
          await activity(res.prospect_id, "imported", null, { source, basis: res.basis, country: res.country }, actor, tx);
        }
        return ids;
      });
      written.push(...done);
      for (const { res } of chunk) if (res.action === "create" || res.action === "update") res.applied = true;
    } catch (e) {
      // This chunk was rolled back: its new prospects never existed.
      failed = `Rows ${chunk[0].res.row} to ${chunk[chunk.length - 1].res.row} were not imported: ${(e as Error).message}`;
      for (const { res } of chunk) if (res.action === "create") res.prospect_id = undefined;
    }
  }
  // Someone already a customer or a requester is linked at once (and never written to cold); Clerk down: the next
  // tick's checks catch them before any email.
  await linkProspects(written);
  await linkByMembers(written).catch((e) => console.error(`gtm import: customers not checked now: ${(e as Error).message}`));
  log(actor, "gtm.prospect_import", null, { ...summary, source, applied: written.length, failed: Boolean(failed) });
  return { dry_run: false, error: failed, applied: out.filter((r) => r.applied).map((r) => r.row),
    summary: { ...summary, create: out.filter((r) => r.action === "create" && r.applied).length, update: out.filter((r) => r.action === "update" && r.applied).length,
      skip: out.filter((r) => r.action === "skip").length, applied: written.length }, rows: out };
}

// ---------- linking a prospect to the account they became ----------

const EVENT_LINKS = ["request_submitted", "request_approved", "account_created"];

/**
 * Who is a customer now: every account's people (their access requests that have the account, their members in Clerk,
 * suspended ones too, and pending invitations), by a canonical address hash (lowercased, any +tag dropped, and for
 * Gmail the dots dropped and googlemail read as gmail: memberKey), and the company domains those addresses are at,
 * both exactly and by organisational root (eu.acme.com counts as acme.com), never a free-mail one.
 *
 * Built at most every MEMBER_INDEX_MAX_AGE (5 minutes; sooner when the accounts change), reading each account's members
 * from Clerk itself (not the admin pages' one-minute cache), five accounts at a time; a tick, an enrolment and an
 * import share it, and the tick checks each due prospect's own accounts afresh as well (freshMemberCheck). When Clerk
 * cannot be asked for an account, `error` says so and nothing is cached: callers fail closed (no cold email this pass).
 *
 * Limit: Clerk's membership list gives each member's sign-in identifier, not every address on their user; a member
 * whose other verified address is the prospect's is matched by domain only, or when they first sign in to the portal
 * (src/app.ts links by their primary address).
 */
export interface MemberIndex { byHash: Map<string, number>; domains: Map<string, number>; error: string | null; at: number; sig: string }
const MEMBER_INDEX_MAX_AGE = 5 * 60_000;
let members: MemberIndex | null = null;
export const forgetMembers = () => { members = null; };

/** The address as the customer match compares it: lowercased, +tag dropped, Gmail's dots ignored. Hashed. */
export function memberKey(email: string) {
  let [local, domain] = email.trim().toLowerCase().split("@");
  if (!local || !domain) return mail.hashAddress(email);
  local = local.split("+")[0];
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return mail.hashAddress(`${local}@${domain}`);
}
/** The organisational root of a domain (public-suffix aware), or the domain itself. */
export const orgRootOf = (d: string) => getDomain(d, { allowPrivateDomains: false }) ?? d;
/** The account an address belongs to by the index: its own address, else its company domain or that domain's root. */
export function memberOrg(idx: MemberIndex, email: string): number | null {
  const org = idx.byHash.get(memberKey(email));
  if (org != null) return org;
  const d = companyDomainOf(email);
  return d ? idx.domains.get(d) ?? idx.domains.get(orgRootOf(d)) ?? null : null;
}

/** What changes the index: accounts with Clerk organizations, and requests that have an account. */
async function memberSignature() {
  const [r] = await (await getDb()).query<{ sig: string }>(
    `SELECT (SELECT count(*) || ':' || coalesce(max(id), 0) FROM organizations WHERE clerk_org_id IS NOT NULL) || '/' ||
            (SELECT count(*) || ':' || coalesce(max(id), 0) FROM access_requests WHERE org_id IS NOT NULL) AS sig`);
  return r.sig;
}

/** Run fn over items, at most n at a time. */
async function pooled<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

function addTo(out: MemberIndex, email: string, orgId: number) {
  const e = email.trim().toLowerCase();
  if (!mail.isEmail(e)) return;
  out.byHash.set(memberKey(e), orgId);
  const d = companyDomainOf(e);
  if (!d) return;
  if (!out.domains.has(d)) out.domains.set(d, orgId);
  const root = orgRootOf(d);
  if (!FREEMAIL.has(root) && !out.domains.has(root)) out.domains.set(root, orgId);
}

/** One account's people from Clerk itself (members and pending invitations), or the error. */
async function clerkPeople(clerkOrgId: string): Promise<{ emails: string[]; error: string | null }> {
  const people = await accountPeople(clerkOrgId, true).catch((e: Error) => ({ members: [], invitations: [], error: e.message }));
  if (people?.error) return { emails: [], error: people.error };
  return { emails: [...(people?.members ?? []).flatMap((m) => (m.email ? [m.email] : [])), ...(people?.invitations ?? []).filter((x) => x.state === "pending").map((x) => x.email)], error: null };
}

export async function memberIndex(o: { maxAgeMs?: number } = {}): Promise<MemberIndex> {
  const sig = await memberSignature();
  if (members && members.sig === sig && Date.now() - members.at < (o.maxAgeMs ?? MEMBER_INDEX_MAX_AGE)) return members;
  const db = await getDb();
  const out: MemberIndex = { byHash: new Map(), domains: new Map(), error: null, at: Date.now(), sig };
  for (const r of await db.query<{ email: string; org_id: number }>("SELECT lower(email) AS email, org_id FROM access_requests WHERE org_id IS NOT NULL")) addTo(out, r.email, Number(r.org_id));
  const orgs = await db.query<{ id: number; clerk_org_id: string }>("SELECT id, clerk_org_id FROM organizations WHERE clerk_org_id IS NOT NULL ORDER BY id");
  await pooled(orgs, 5, async (o2) => {
    const p = await clerkPeople(o2.clerk_org_id);
    if (p.error) { out.error = `Clerk did not list the members of account ${o2.id}: ${p.error}`; return; }
    for (const e of p.emails) addTo(out, e, Number(o2.id));
  });
  if (!out.error) members = out;
  return out;
}

/**
 * Before a cold email: the accounts this address could belong to (its prospect's or company's account, and any
 * account with people at its domain or that domain's root) read again from Clerk now. "customer", "member_check"
 * (Clerk did not answer: not this time) or null.
 */
export async function freshMemberCheck(email: string, idx: MemberIndex): Promise<"customer" | "member_check" | null> {
  const db = await getDb();
  const e = email.trim().toLowerCase(), d = companyDomainOf(e);
  const ids = new Set<number>();
  for (const k of d ? [d, orgRootOf(d)] : []) { const o = idx.domains.get(k); if (o != null) ids.add(o); }
  for (const r of await db.query<{ org_id: number | null; company_org: number | null }>(
    "SELECT p.org_id, c.org_id AS company_org FROM gtm_prospects p LEFT JOIN gtm_companies c ON c.id = p.company_id WHERE p.email = $1", [e])) {
    if (r.org_id != null) ids.add(Number(r.org_id));
    if (r.company_org != null) ids.add(Number(r.company_org));
  }
  if (!ids.size) return null;
  const key = memberKey(e);
  for (const o of await db.query<{ id: number; clerk_org_id: string | null }>("SELECT id, clerk_org_id FROM organizations WHERE id = ANY($1::int[])", [[...ids]])) {
    if (!o.clerk_org_id) continue;
    const p = await clerkPeople(o.clerk_org_id);
    if (p.error) return "member_check";
    if (p.emails.some((x) => memberKey(x) === key)) return "customer";
  }
  return null;
}

/** Link one prospect to its request and / or account: status customer with an account, a timeline entry, one event. */
async function markLinked(id: number, to: { request_id?: number | null; org_id?: number | null }, why: string) {
  const db = await getDb();
  const [cur] = await db.query<{ request_id: number | null; org_id: number | null }>("SELECT request_id, org_id FROM gtm_prospects WHERE id = $1", [id]);
  if (!cur) return false;
  const reqChanged = to.request_id != null && Number(cur.request_id) !== Number(to.request_id);
  const orgChanged = to.org_id != null && Number(cur.org_id) !== Number(to.org_id);
  if (!reqChanged && !orgChanged) return false;
  await db.query(`UPDATE gtm_prospects SET request_id = coalesce($2, request_id), org_id = coalesce($3, org_id), linked_at = now(), updated_at = now() WHERE id = $1`,
    [id, to.request_id ?? null, to.org_id ?? null]);
  if (to.org_id != null) await setStatus(id, "customer", { why: "Has an Octillion account" });
  const [touch] = await db.query<{ campaign_id: number }>(
    "SELECT campaign_id FROM gtm_campaign_recipients WHERE prospect_id = $1 AND source = 'prospect' AND first_sent_at IS NOT NULL ORDER BY first_sent_at, id LIMIT 1", [id]);
  const via = orgChanged ? "account" : "request";
  await activity(id, "linked", why, { via, org_id: to.org_id ?? null, request_id: to.request_id ?? null, campaign_id: touch ? Number(touch.campaign_id) : null });
  // The event (no address: the prospect, the request, the account, the campaign credited).
  await db.query(
    `INSERT INTO gtm_events (type, org_id, request_id, data, dedupe_key) VALUES ('prospect_converted', $1, $2, $3::jsonb, $4) ON CONFLICT (dedupe_key) DO NOTHING`,
    [to.org_id ?? null, to.request_id ?? null, JSON.stringify({ prospect_id: id, via, campaign_id: touch ? Number(touch.campaign_id) : null }),
     `prospect_converted:${id}:${via}:${via === "account" ? to.org_id : to.request_id}`]);
  return true;
}

/**
 * Link prospects (by address) and companies (by domain) to the access request and account made with them. From
 * src/gtm-events.ts when one of those events is recorded. Never throws.
 */
export async function linkFromEvent(type: string, e: { org_id?: number | null; request_id?: number | null }) {
  if (!EVENT_LINKS.includes(type)) return;
  try {
    const db = await getDb();
    const emails = new Set<string>();
    if (e.request_id != null) for (const r of await db.query<{ email: string }>("SELECT lower(email) AS email FROM access_requests WHERE id = $1", [e.request_id])) emails.add(r.email);
    if (e.org_id != null) {
      for (const r of await db.query<{ email: string }>("SELECT lower(email) AS email FROM access_requests WHERE org_id = $1", [e.org_id])) emails.add(r.email);
      // A self-serve account has no request: its members in Clerk (none when Clerk is off or fails: requests only).
      const [o] = await db.query<{ clerk_org_id: string | null }>("SELECT clerk_org_id FROM organizations WHERE id = $1", [e.org_id]);
      const people = o?.clerk_org_id ? await accountPeople(o.clerk_org_id).catch(() => null) : null;
      for (const m of people && !people.error ? people.members : []) if (m.email) emails.add(m.email.toLowerCase());
      forgetMembers();
    }
    if (!emails.size) return;
    const ids = (await db.query<{ id: number }>("SELECT id FROM gtm_prospects WHERE email = ANY($1::text[])", [[...emails]])).map((r) => Number(r.id));
    await linkProspects(ids);
    if (e.org_id != null) for (const em of emails) await linkMember(em, e.org_id);
  } catch (err) { console.error(`gtm link (${type}): ${(err as Error).message}`); }
}

/**
 * A person seen as a member of an account (their first portal sign-in in this process, src/app.ts; an account's
 * members when it is created): their prospect is a customer, their company (by domain) is the account. Never throws.
 */
export async function linkMember(email: string | null | undefined, orgId: number) {
  try {
    const e = String(email ?? "").trim().toLowerCase();
    if (!mail.isEmail(e)) return;
    const db = await getDb();
    for (const p of await db.query<{ id: number }>("SELECT id FROM gtm_prospects WHERE email = $1", [e])) await markLinked(Number(p.id), { org_id: orgId }, "A member of an Octillion account");
    const d = companyDomainOf(e);
    if (d) await db.query("UPDATE gtm_companies SET org_id = $1, linked_at = now(), updated_at = now() WHERE domain = $2 AND org_id IS NULL", [orgId, d]);
    forgetMembers();
  } catch (err) { console.error(`gtm link member: ${(err as Error).message}`); }
}

/**
 * For each prospect: their access request by address (the one with an account first) and its account. A colleague's
 * account does not make someone a customer (their company is linked instead, and outbound skips them).
 */
export async function linkProspects(ids: number[]) {
  if (!ids.length) return 0;
  const rows = await (await getDb()).query<{ id: number; new_request: number | null; new_org: number | null }>(
    `SELECT p.id, q.id AS new_request, q.org_id AS new_org
       FROM gtm_prospects p JOIN LATERAL (SELECT id, org_id FROM access_requests a WHERE lower(a.email) = p.email ORDER BY (a.org_id IS NOT NULL) DESC, a.created_at DESC LIMIT 1) q ON true
      WHERE p.id = ANY($1::bigint[]) AND p.email IS NOT NULL`, [ids]);
  let n = 0;
  for (const r of rows) if (await markLinked(Number(r.id), { request_id: r.new_request, org_id: r.new_org }, r.new_org != null ? "Has an Octillion account" : "Requested access")) n++;
  return n;
}

/**
 * Prospects (by address hash) and companies (by domain) matched against every account's people now (memberIndex).
 * `ids`: only these prospects (an import); else all. Throws when Clerk cannot be asked (nothing is half-linked).
 */
export async function linkByMembers(ids?: number[]) {
  const idx = await memberIndex({ maxAgeMs: 0 });
  if (idx.error) throw new AdminError(`Customers could not be checked: ${idx.error}`, 503);
  const db = await getDb();
  const ps = await db.query<{ id: number; email: string }>(
    "SELECT id, email FROM gtm_prospects WHERE email IS NOT NULL AND org_id IS NULL AND ($1::bigint[] IS NULL OR id = ANY($1::bigint[]))", [ids ?? null]);
  let prospects = 0, companies = 0;
  for (const p of ps) { const org = idx.byHash.get(memberKey(p.email)); if (org != null && await markLinked(Number(p.id), { org_id: org }, "A member of an Octillion account")) prospects++; }
  for (const [d, org] of idx.domains) companies += (await db.query("UPDATE gtm_companies SET org_id = $1, linked_at = now(), updated_at = now() WHERE domain = $2 AND org_id IS NULL RETURNING id", [org, d])).length;
  return { prospects, companies, requests: await linkProspects(ps.map((p) => Number(p.id))) };
}

/**
 * The idempotent "link existing customers" action (POST /gtm/prospects/relink), also run once by the first tick
 * (gtm_jobs customer_links): every prospect and company against every account and its members.
 */
export async function backfillCustomerLinks(actor: string | null = null) {
  const r = await linkByMembers();
  await (await getDb()).query("INSERT INTO gtm_jobs (name, result) VALUES ('customer_links', $1::jsonb) ON CONFLICT (name) DO UPDATE SET done_at = now(), result = excluded.result",
    [JSON.stringify(r)]);
  if (actor) log(actor, "gtm.relink_customers", null, r);
  return r;
}
/** The first tick's once-per-database run of backfillCustomerLinks. Never throws (tried again next tick). */
export async function backfillOnce() {
  try {
    const [done] = await (await getDb()).query("SELECT 1 FROM gtm_jobs WHERE name = 'customer_links'");
    if (!done) await backfillCustomerLinks();
  } catch (e) { console.error(`gtm customer links backfill: ${(e as Error).message}`); }
}

// ---------- the timeline ----------

export interface TimelineItem { at: string; type: string; text: string; detail?: string | null; actor?: string | null; campaign_id?: number | null }

/** Everything that happened with a prospect, newest first: their own entries and the campaign tables' (no addresses). */
export async function timeline(prospectId: number): Promise<TimelineItem[]> {
  const db = await getDb();
  const [acts, sends, replies] = await Promise.all([
    db.query<{ type: string; body: string | null; data: Record<string, unknown>; actor: string | null; at: Date }>(
      "SELECT type, body, data, actor, at FROM gtm_prospect_activities WHERE prospect_id = $1 ORDER BY at DESC, id DESC LIMIT 500", [prospectId]),
    db.query<{ campaign_id: number; name: string; step: number; at: Date; opened_at: Date | null; clicked_at: Date | null; bounced_at: Date | null; status: string }>(
      `SELECT s.campaign_id, c.name, s.step, s.at, s.opened_at, s.clicked_at, s.bounced_at, s.status FROM gtm_campaign_sends s
         JOIN gtm_campaign_recipients r ON r.id = s.recipient_id JOIN gtm_campaigns c ON c.id = s.campaign_id
        WHERE r.prospect_id = $1 AND s.status = 'sent' ORDER BY s.at DESC LIMIT 500`, [prospectId]),
    db.query<{ campaign_id: number; name: string; kind: string; snippet: string | null; received_at: Date }>(
      `SELECT y.campaign_id, c.name, y.kind, y.snippet, y.received_at FROM gtm_replies y JOIN gtm_campaign_recipients r ON r.id = y.recipient_id
         JOIN gtm_campaigns c ON c.id = y.campaign_id WHERE r.prospect_id = $1 ORDER BY y.received_at DESC LIMIT 200`, [prospectId]),
  ]);
  const iso = (d: Date) => new Date(d).toISOString();
  const label: Record<string, string> = { new: "New", contacted: "Contacted", replied: "Replied", interested: "Interested", not_interested: "Not interested", customer: "Customer", bad_email: "Bad email" };
  const items: TimelineItem[] = [
    ...acts.map((a) => ({ at: iso(a.at), type: a.type, actor: a.actor, campaign_id: (a.data?.campaign_id as number | undefined) ?? null,
      text: a.type === "status" ? `Status: ${label[String(a.data.from)] ?? a.data.from} → ${label[String(a.data.to)] ?? a.data.to}`
        : a.type === "imported" ? `Added (${a.data.source}, ${String(a.data.basis).replace(/_/g, " ")})`
        : a.type === "enriched" ? `Enriched from ${a.data.source ?? "Apollo"}` : a.type === "linked" ? a.body ?? "Linked to an account"
        : a.type === "note" ? "Note" : a.type === "deal" ? `Deal: ${a.body ?? ""}` : a.body ?? a.type,
      detail: a.type === "note" ? a.body : a.type === "status" ? a.body : null })),
    ...sends.flatMap((s) => [
      { at: iso(s.at), type: "email_sent", text: `Email ${s.step + 1} sent: ${s.name}`, campaign_id: Number(s.campaign_id) },
      ...(s.opened_at ? [{ at: iso(s.opened_at), type: "email_opened", text: `Opened email ${s.step + 1}: ${s.name}`, campaign_id: Number(s.campaign_id) }] : []),
      ...(s.clicked_at ? [{ at: iso(s.clicked_at), type: "email_clicked", text: `Clicked a link in email ${s.step + 1}: ${s.name}`, campaign_id: Number(s.campaign_id) }] : []),
      ...(s.bounced_at ? [{ at: iso(s.bounced_at), type: "email_bounced", text: `Email ${s.step + 1} bounced: ${s.name}`, campaign_id: Number(s.campaign_id) }] : []),
    ]),
    ...replies.map((y) => ({ at: iso(y.received_at), type: y.kind === "reply" ? "replied" : "auto_reply", text: `${y.kind === "reply" ? "Replied" : "Automatic reply"}: ${y.name}`,
      detail: y.snippet, campaign_id: Number(y.campaign_id) })),
  ];
  return items.sort((a, b) => b.at.localeCompare(a.at));
}
