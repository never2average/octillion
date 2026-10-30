/**
 * GTM › Apollo (https://docs.apollo.io): find people and fill in prospects and companies. The API key is the key
 * vault's `apollo` provider (server-only); without one every action answers with what to set up, and nothing else in
 * GTM needs it. APOLLO_API_URL points it elsewhere (the smoke tests' mock); tests never call the real API.
 *
 *   find people   POST /api/v1/mixed_people/api_search (https://docs.apollo.io/reference/people-api-search): titles,
 *                 company domains, seniorities, person locations and industries; no credits, and no addresses (only
 *                 has_email), so imported people get an address when enriched. Answers are cached a day (by query).
 *   enrich people POST /api/v1/people/bulk_match (https://docs.apollo.io/reference/bulk-people-enrichment), ten at a
 *                 time, by Apollo id, else address, else name and domain: title, seniority, LinkedIn URL, country,
 *                 the address and its email_status (verified, unverified, likely to engage, extrapolated, unavailable;
 *                 Apollo's own verification). credits_consumed is recorded.
 *   enrich orgs   POST /api/v1/organizations/bulk_enrich (https://docs.apollo.io/reference/bulk-organization-enrichment),
 *                 ten domains at a time: name, industry, employees, country. One credit per company found (the answer
 *                 has no credits field, so found companies are counted).
 *   freshness     a prospect or company enriched in the last APOLLO_REENRICH_DAYS (30) days is skipped unless forced
 *   rate limits   one request at a time per process, at least APOLLO_MIN_GAP_MS (350 ms) apart (under the 200 a minute
 *                 of Apollo's paid plans, https://docs.apollo.io/reference/rate-limits); a 429 waits its retry-after
 *                 (at most 10 s, once), else the action stops and says so. The x-*-requests-left headers are kept and
 *                 shown with the credits used (gtm_apollo_usage, per day and endpoint).
 */
import { createHash } from "node:crypto";
import { getDb } from "./db.js";
import { AdminError, log } from "./admin.js";
import { getProvider, useCredential } from "./keyvault.js";
import * as mail from "./email.js";
import { activity, companyDomainOf, domainOf, importProspects, upsertCompany, type ProspectInput } from "./gtm-crm.js";
import { cleanCountry } from "./gtm-consent.js";

export const APOLLO_PROVIDER = "apollo";
export const SENIORITIES = ["owner", "founder", "c_suite", "partner", "vp", "head", "director", "manager", "senior", "entry", "intern"] as const;
const apiUrl = () => (process.env.APOLLO_API_URL ?? "https://api.apollo.io").replace(/\/$/, "");
const reenrichDays = () => Math.max(0, Math.trunc(Number(process.env.APOLLO_REENRICH_DAYS ?? 30)) || 0);
const minGap = () => Math.max(0, Math.trunc(Number(process.env.APOLLO_MIN_GAP_MS ?? 350)) || 0);
const SETUP = "Apollo is not connected: add an Apollo API key on Key vault (provider apollo) to find and enrich people";
const fail = (msg: string, status = 400): never => { throw new AdminError(msg, status); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const list = (v: unknown, max = 50) => [...new Set((Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map((x) => String(x).trim()).filter(Boolean))].slice(0, max);

/** Whether Apollo can be used now, and the latest rate-limit headers seen in this process. */
let lastLimits: Record<string, number> = {};
export async function apolloStatus() {
  const [p, cred] = await Promise.all([getProvider(APOLLO_PROVIDER), useCredential(APOLLO_PROVIDER).then(() => true, () => false)]);
  const connected = Boolean(p?.enabled && cred);
  const usage = await (await getDb()).query<{ endpoint: string; requests: number; credits: number; limited: number }>(
    `SELECT endpoint, sum(requests)::int AS requests, sum(credits)::float8 AS credits, sum(limited)::int AS limited FROM gtm_apollo_usage
      WHERE day > current_date - 30 GROUP BY endpoint ORDER BY endpoint`);
  const [today] = await (await getDb()).query<{ credits: number }>("SELECT coalesce(sum(credits), 0)::float8 AS credits FROM gtm_apollo_usage WHERE day = current_date");
  return {
    connected, message: connected ? null : SETUP, reenrich_days: reenrichDays(),
    credits_30d: usage.reduce((t, u) => t + Number(u.credits), 0), credits_today: Number(today?.credits ?? 0), requests_30d: usage.reduce((t, u) => t + Number(u.requests), 0),
    by_endpoint: usage, rate_limits: lastLimits, seniorities: SENIORITIES,
  };
}

// ---------- the client ----------

let queue: Promise<unknown> = Promise.resolve();
let lastAt = 0;
/** One Apollo request at a time in this process, spaced out (see the top of the file). */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(async () => { const wait = lastAt + minGap() - Date.now(); if (wait > 0) await sleep(wait); try { return await fn(); } finally { lastAt = Date.now(); } });
  queue = p.catch(() => {});
  return p;
}

async function record(endpoint: string, o: { credits?: number; limited?: boolean }) {
  await (await getDb()).query(
    `INSERT INTO gtm_apollo_usage (day, endpoint, requests, credits, limited) VALUES (current_date, $1, 1, $2, $3)
     ON CONFLICT (day, endpoint) DO UPDATE SET requests = gtm_apollo_usage.requests + 1, credits = gtm_apollo_usage.credits + excluded.credits, limited = gtm_apollo_usage.limited + excluded.limited`,
    [endpoint, o.credits ?? 0, o.limited ? 1 : 0]).catch(() => {});
}

/** A call to Apollo with the vault's key. Throws an AdminError the page can show (never the key). */
async function call<T>(method: "GET" | "POST", path: string, o: { query?: Record<string, string | number | string[] | undefined>; body?: unknown; endpoint: string }): Promise<{ json: T; credits: number }> {
  const cred = await useCredential(APOLLO_PROVIDER).catch(() => null);
  if (!cred || !(await getProvider(APOLLO_PROVIDER))?.enabled) fail(SETUP, 409);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(o.query ?? {})) {
    if (v == null || v === "") continue;
    if (Array.isArray(v)) for (const x of v) qs.append(`${k}[]`, x); else qs.append(k, String(v));
  }
  const url = `${apiUrl()}${path}${qs.size ? `?${qs}` : ""}`;
  for (let attempt = 0; ; attempt++) {
    const r = await serial(() => fetch(url, {
      method, signal: AbortSignal.timeout(30_000), body: o.body === undefined ? undefined : JSON.stringify(o.body),
      headers: { "x-api-key": cred!.secret, "content-type": "application/json", "cache-control": "no-cache", accept: "application/json", "user-agent": "Octillion/1.0" },
    })).catch((e: Error) => fail(`Apollo did not answer: ${e.message}`, 502));
    const limits: Record<string, number> = {};
    for (const h of ["x-minute-requests-left", "x-hourly-requests-left", "x-24-hour-requests-left", "x-rate-limit-minute", "x-rate-limit-hourly", "x-rate-limit-24-hour"]) {
      const v = Number(r.headers.get(h));
      if (r.headers.get(h) != null && Number.isFinite(v)) limits[h.replace(/^x-/, "")] = v;
    }
    if (Object.keys(limits).length) lastLimits = { ...lastLimits, ...limits, at: Date.now() };
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown> & { error?: string; message?: string; credits_consumed?: number };
    if (r.status === 429) {
      await record(o.endpoint, { limited: true });
      const after = Number(r.headers.get("retry-after") ?? (j as { suggestions?: { retry_after_seconds?: number } }).suggestions?.retry_after_seconds ?? 60);
      if (attempt === 0 && after <= 10) { await sleep(Math.max(1, after) * 1000); continue; }
      fail(`Apollo's rate limit: try again in ${Math.ceil(after)} seconds`, 429);
    }
    if (!r.ok) {
      await record(o.endpoint, {});
      const msg = String(j.error ?? j.message ?? "").replaceAll(cred!.secret, "…").slice(0, 300);
      fail(r.status === 401 || r.status === 403 ? `Apollo refused the key (${r.status}): check the apollo key on Key vault${msg ? `: ${msg}` : ""}` : `Apollo answered ${r.status}${msg ? `: ${msg}` : ""}`, r.status >= 500 ? 502 : 400);
    }
    const credits = Number(j.credits_consumed ?? 0) || 0;
    await record(o.endpoint, { credits });
    return { json: j as T, credits };
  }
}

/** Anything that looks like an address, removed (the cache and the enrichment records never hold one). */
function scrub<T>(v: T): T {
  return JSON.parse(JSON.stringify(v ?? null, (k, x) => (/(^|_)emails?$/i.test(k) || (typeof x === "string" && /[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}/i.test(x)) ? undefined : x))) as T;
}

// ---------- find people ----------

export interface SearchInput { titles?: unknown; domains?: unknown; seniorities?: unknown; locations?: unknown; industries?: unknown; page?: unknown; per_page?: unknown }
interface ApolloPerson { id?: string; first_name?: string; last_name?: string; last_name_obfuscated?: string; name?: string; title?: string; seniority?: string;
  linkedin_url?: string; country?: string; city?: string; email?: string; email_status?: string; time_zone?: string;
  organization?: { id?: string; name?: string; primary_domain?: string; website_url?: string; industry?: string; estimated_num_employees?: number; country?: string };
  has_email?: boolean; match_confidence?: string }

const searchQuery = (q: SearchInput) => {
  const seniorities = list(q.seniorities).filter((s) => (SENIORITIES as readonly string[]).includes(s));
  const domains = list(q.domains, 1000).map((d) => domainOf(d)).filter((d): d is string => !!d);
  const out = {
    person_titles: list(q.titles), q_organization_domains_list: domains, person_seniorities: seniorities, person_locations: list(q.locations), organization_industries: list(q.industries),
    page: Math.min(500, Math.max(1, Math.trunc(Number(q.page) || 1))), per_page: Math.min(100, Math.max(1, Math.trunc(Number(q.per_page) || 25))),
  };
  if (!out.person_titles.length && !domains.length && !seniorities.length && !out.person_locations.length && !out.organization_industries.length) fail("Give at least one filter: a title, a company domain, a seniority, a location or an industry");
  return out;
};

/**
 * "Find people": Apollo's people search (no credits). Cached for a day by query; each person says whether they are
 * a prospect already. Nothing is saved until they are imported (importFound).
 */
export async function searchPeople(q: SearchInput, o: { force?: boolean } = {}) {
  const query = searchQuery(q);
  const key = `search:${createHash("sha256").update(JSON.stringify(query)).digest("hex").slice(0, 32)}`;
  const db = await getDb();
  const [hit] = o.force ? [] : await db.query<{ response: { total: number; people: unknown[] }; at: Date }>("SELECT response, at FROM gtm_apollo_cache WHERE key = $1 AND at > now() - interval '1 day'", [key]);
  let res = hit?.response, cached = Boolean(hit);
  if (!res) {
    const { json } = await call<{ people?: ApolloPerson[]; total_entries?: number; pagination?: { total_entries?: number } }>("POST", "/api/v1/mixed_people/api_search", { query, endpoint: "people_search" });
    res = scrub({ total: Number(json.total_entries ?? json.pagination?.total_entries ?? 0), people: (json.people ?? []).map((p) => ({
      apollo_id: p.id ?? null, first_name: p.first_name ?? null, last_name: p.last_name ?? p.last_name_obfuscated ?? null, title: p.title ?? null, seniority: p.seniority ?? null,
      has_email: p.has_email ?? null, country: countryCode(p.country), linkedin_url: p.linkedin_url ?? null,
      company: p.organization?.name ?? null, domain: domainOf(p.organization?.primary_domain ?? p.organization?.website_url) ?? null, industry: p.organization?.industry ?? null,
      employees: p.organization?.estimated_num_employees ?? null })) });
    await db.query("INSERT INTO gtm_apollo_cache (key, kind, response, at) VALUES ($1, 'people_search', $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET response = excluded.response, at = now()",
      [key, JSON.stringify(res)]);
    cached = false;
  }
  const people = res.people as { apollo_id: string | null }[];
  const ids = people.map((p) => p.apollo_id).filter((x): x is string => !!x);
  const known = new Set((ids.length ? await db.query<{ apollo_id: string }>("SELECT apollo_id FROM gtm_prospects WHERE apollo_id = ANY($1::text[])", [ids]) : []).map((r) => r.apollo_id));
  return { query, total: res.total, cached, people: people.map((p) => ({ ...p, already: !!p.apollo_id && known.has(p.apollo_id) })) };
}

/**
 * Import people from a search (by Apollo id, from the cached answer: nothing the page sends is trusted as a record)
 * as prospects, with the lawful basis chosen. Optionally enrich them at once (credits).
 */
export async function importFound(actor: string, body: { query?: SearchInput; apollo_ids?: unknown; lawful_basis?: unknown; basis_note?: unknown; explicit_restricted?: unknown; tags?: unknown; enrich?: unknown }) {
  const found = await searchPeople(body.query ?? {});
  const want = new Set(list(body.apollo_ids, 500));
  const rows: ProspectInput[] = found.people.filter((p) => p.apollo_id && (!want.size || want.has(p.apollo_id))).map((p) => {
    const x = p as unknown as Record<string, unknown>;
    return { apollo_id: x.apollo_id, first_name: x.first_name, last_name: x.last_name, title: x.title, seniority: x.seniority, country: x.country, linkedin_url: x.linkedin_url,
      company: x.company, domain: x.domain, industry: x.industry, size: x.employees as number | undefined } as ProspectInput;
  });
  if (!rows.length) fail("Nobody to import: run the search again");
  const r = await importProspects(actor, { rows, dry_run: false, source: "apollo", lawful_basis: body.lawful_basis, basis_note: body.basis_note, explicit_restricted: body.explicit_restricted, tags: body.tags });
  const ids = r.rows.filter((x) => x.prospect_id && (x.action === "create" || x.action === "update")).map((x) => x.prospect_id!);
  const enriched = body.enrich === true && ids.length ? await enrichProspects(actor, { ids, force: false }) : null;
  return { ...r, enriched };
}

// ---------- enrichment ----------

const EMAIL_STATUS: Record<string, string> = { verified: "verified", unverified: "unverified", "likely to engage": "likely_to_engage", likely_to_engage: "likely_to_engage",
  extrapolated: "extrapolated", guessed: "extrapolated", unavailable: "unavailable", invalid: "invalid", bounced: "invalid" };

/**
 * Enrich prospects (one or many; ten per Apollo request): title, seniority, LinkedIn URL, country, time zone, the
 * address and its status, and the company. Skips anyone enriched in the last APOLLO_REENRICH_DAYS unless forced.
 */
export async function enrichProspects(actor: string, body: { ids?: unknown; force?: unknown }) {
  const ids = list(body.ids, 1000).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
  if (!ids.length) fail("Choose prospects to enrich");
  const db = await getDb();
  const rows = await db.query<{ id: number; apollo_id: string | null; email: string | null; first_name: string | null; last_name: string | null; domain: string | null; company: string | null;
    linkedin_url: string | null; enriched_at: Date | null; email_status: string; status: string }>(
    `SELECT p.id, p.apollo_id, p.email, p.first_name, p.last_name, c.domain, c.name AS company, p.linkedin_url, p.enriched_at, p.email_status, p.status
       FROM gtm_prospects p LEFT JOIN gtm_companies c ON c.id = p.company_id WHERE p.id = ANY($1::bigint[])`, [ids]);
  const fresh = (d: Date | null) => !!d && Date.now() - new Date(d).getTime() < reenrichDays() * 86_400_000;
  const todo = rows.filter((r) => body.force === true || !fresh(r.enriched_at));
  let credits = 0, matched = 0;
  const domains = new Set<string>();
  for (let i = 0; i < todo.length; i += 10) {
    const chunk = todo.slice(i, i + 10);
    const details = chunk.map((r) => (r.apollo_id ? { id: r.apollo_id } : r.email ? { email: r.email, first_name: r.first_name ?? undefined, last_name: r.last_name ?? undefined }
      : { first_name: r.first_name ?? undefined, last_name: r.last_name ?? undefined, domain: r.domain ?? undefined, organization_name: r.company ?? undefined, linkedin_url: r.linkedin_url ?? undefined }));
    const { json, credits: c } = await call<{ matches?: (ApolloPerson | null)[] }>("POST", "/api/v1/people/bulk_match", { body: { details }, endpoint: "people_bulk_match" });
    credits += c;
    for (const [k, r] of chunk.entries()) {
      const m = json.matches?.[k];
      if (!m || m.match_confidence === "none") {
        await db.query("UPDATE gtm_prospects SET enriched_at = now(), enrichment_source = 'apollo', updated_at = now() WHERE id = $1", [r.id]);
        continue;
      }
      matched++;
      const email = typeof m.email === "string" && mail.isEmail(m.email) ? m.email.toLowerCase() : null;
      const status = EMAIL_STATUS[String(m.email_status ?? "").toLowerCase()] ?? (email ? "unknown" : r.email_status);
      const orgDomain = domainOf(m.organization?.primary_domain ?? m.organization?.website_url) ?? (email ? companyDomainOf(email) : null);
      const companyId = orgDomain ? (await upsertCompany(orgDomain, { name: m.organization?.name, industry: m.organization?.industry, employees: m.organization?.estimated_num_employees,
        country: m.organization?.country }, "apollo")).id : null;
      if (orgDomain) domains.add(orgDomain);
      // The address goes in the prospect's email column only (and only if no other prospect has it); the stored
      // record is scrubbed of it.
      const taken = email && email !== r.email ? (await db.query("SELECT 1 FROM gtm_prospects WHERE email = $1 AND id <> $2", [email, r.id])).length > 0 : false;
      const suppressed = email ? (await db.query("SELECT 1 FROM email_suppressions WHERE email_hash = $1", [mail.hashAddress(email)])).length > 0 : false;
      await db.query(
        `UPDATE gtm_prospects SET apollo_id = coalesce(apollo_id, $2), email = CASE WHEN $3::text IS NOT NULL THEN $3 ELSE email END,
                email_status = $4, first_name = coalesce($5, first_name), last_name = coalesce($6, last_name), title = coalesce($7, title), seniority = coalesce($8, seniority),
                linkedin_url = coalesce(linkedin_url, $9), country = coalesce($10, country), company_id = coalesce(company_id, $11),
                enrichment = $12::jsonb, enriched_at = now(), enrichment_source = 'apollo', updated_at = now(),
                status = CASE WHEN $4 = 'invalid' AND status IN ('new', 'contacted') THEN 'bad_email' ELSE status END
          WHERE id = $1`,
        [r.id, m.id ?? null, email && !taken && !suppressed && !r.email ? email : null, status, m.first_name ?? null, m.last_name ?? null, m.title ?? null, m.seniority ?? null,
         typeof m.linkedin_url === "string" && /linkedin\.com\//i.test(m.linkedin_url) ? m.linkedin_url : null, cleanCountry(countryCode(m.country)), companyId,
         JSON.stringify(scrub({ ...m, email: undefined }))]);
      await activity(r.id, "enriched", null, { source: "apollo", email_status: status, credits: c / chunk.length || 0 }, actor);
    }
  }
  if (domains.size) await db.query("UPDATE gtm_companies SET enriched_at = coalesce(enriched_at, now()), enrichment_source = coalesce(enrichment_source, 'apollo') WHERE domain = ANY($1::text[])", [[...domains]]);
  log(actor, "gtm.apollo_enrich_people", null, { asked: ids.length, enriched: todo.length, matched, credits });
  return { asked: ids.length, enriched: todo.length, skipped_fresh: rows.length - todo.length, matched, credits };
}

/** Enrich companies by domain (ten per request), skipping fresh ones unless forced. */
export async function enrichCompanies(actor: string, body: { ids?: unknown; force?: unknown }) {
  const ids = list(body.ids, 1000).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
  if (!ids.length) fail("Choose companies to enrich");
  const db = await getDb();
  const rows = await db.query<{ id: number; domain: string; enriched_at: Date | null }>("SELECT id, domain, enriched_at FROM gtm_companies WHERE id = ANY($1::bigint[])", [ids]);
  const todo = rows.filter((r) => body.force === true || !r.enriched_at || Date.now() - new Date(r.enriched_at).getTime() >= reenrichDays() * 86_400_000);
  let found = 0;
  for (let i = 0; i < todo.length; i += 10) {
    const chunk = todo.slice(i, i + 10);
    const { json } = await call<{ organizations?: (Record<string, unknown> & { primary_domain?: string; website_url?: string })[] }>("POST", "/api/v1/organizations/bulk_enrich",
      { query: { domains: chunk.map((c) => c.domain) }, endpoint: "organizations_bulk_enrich" });
    const orgs = (json.organizations ?? []).filter(Boolean);
    // One credit per company found (the answer does not say).
    await record("organizations_bulk_enrich_credits", { credits: orgs.length });
    for (const c of chunk) {
      const o = orgs.find((x) => domainOf(x.primary_domain ?? x.website_url) === c.domain);
      if (o) found++;
      await db.query(
        `UPDATE gtm_companies SET name = coalesce($2, name), industry = coalesce($3, industry), employees = coalesce($4, employees), size = coalesce($5, size), country = coalesce($6, country),
                apollo_id = coalesce($7, apollo_id), enrichment = coalesce($8::jsonb, enrichment), enriched_at = now(), enrichment_source = 'apollo', updated_at = now() WHERE id = $1`,
        [c.id, o?.name ?? null, o?.industry ?? null, o?.estimated_num_employees ?? null, o ? bandOf(Number(o.estimated_num_employees)) : null, o ? cleanCountry(countryCode(o.country)) : null,
         o?.id ?? null, o ? JSON.stringify(scrub(o)) : null]);
    }
  }
  log(actor, "gtm.apollo_enrich_companies", null, { asked: ids.length, enriched: todo.length, found });
  return { asked: ids.length, enriched: todo.length, skipped_fresh: rows.length - todo.length, found, credits: found };
}

const bandOf = (n: number) => (!Number.isFinite(n) || n <= 0 ? null : n <= 10 ? "1-10" : n <= 50 ? "11-50" : n <= 200 ? "51-200" : n <= 500 ? "201-500" : n <= 1000 ? "501-1000" : n <= 5000 ? "1001-5000" : "5001+");
/** Apollo gives country names ("Germany"); prospects keep ISO codes. Known names only, else a two-letter code as is. */
const NAMES: Record<string, string> = { "united states": "US", usa: "US", "united kingdom": "GB", uk: "GB", germany: "DE", france: "FR", spain: "ES", italy: "IT", netherlands: "NL",
  ireland: "IE", sweden: "SE", norway: "NO", denmark: "DK", finland: "FI", switzerland: "CH", austria: "AT", belgium: "BE", poland: "PL", portugal: "PT", canada: "CA", india: "IN",
  australia: "AU", singapore: "SG", israel: "IL", brazil: "BR", mexico: "MX", japan: "JP", china: "CN", "south korea": "KR", "united arab emirates": "AE", "new zealand": "NZ",
  "czech republic": "CZ", czechia: "CZ", greece: "GR", hungary: "HU", romania: "RO", estonia: "EE", latvia: "LV", lithuania: "LT", luxembourg: "LU", iceland: "IS", croatia: "HR",
  slovenia: "SI", slovakia: "SK", bulgaria: "BG", cyprus: "CY", malta: "MT", liechtenstein: "LI", "south africa": "ZA", nigeria: "NG", kenya: "KE", argentina: "AR", chile: "CL", colombia: "CO" };
export const countryCode = (v: unknown) => { const s = str(v, 60); return /^[A-Za-z]{2}$/.test(s) ? s.toUpperCase() : NAMES[s.toLowerCase()] ?? null; };
