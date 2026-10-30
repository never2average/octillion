/**
 * GTM › marketing consent (src/campaigns.ts enrolment, the landing page's access-request form, unsubscribe). Keyed by
 * the sha256 of the lowercased address (src/email.ts hashAddress), never the address:
 *
 *   email_consents        the basis in force: opt_in (the person ticked the box: source, wording version, country,
 *                         when), legitimate_interest (an existing customer, recorded the first time a campaign writes
 *                         to them as one), withdrawn (unsubscribed)
 *   email_consent_ledger  every change, in order, so "what did they agree to, and when" has an answer
 *
 * Who a campaign may write to (mayEnrol):
 *   - never anyone who withdrew (or is suppressed: src/campaigns.ts checks that list separately)
 *   - a campaign that requires opt-in (the default when its audience includes access requesters) only writes to a
 *     recorded opt-in
 *   - an access requester from the EU, the EEA, the UK or Switzerland, or from an unknown country, only ever with a
 *     recorded opt-in, whatever the campaign says
 *   - otherwise an account's member under legitimate interest (an existing customer, the "soft opt-in"; recorded), and
 *     a requester elsewhere, when the campaign does not require opt-in, on an opt-out basis (CAN-SPAM's model: they
 *     gave us their address, every email carries the unsubscribe link; nothing is recorded as consent)
 */
import { getDb } from "./db.js";
import { hashAddress } from "./email.js";

export type Basis = "opt_in" | "legitimate_interest" | "withdrawn";

/**
 * The checkbox on the landing page's access-request form (web/src/features/site/access-form.tsx shows the same words).
 * A new wording gets a new version; the ledger records which one each person saw.
 */
export const OPT_IN_WORDING: Record<string, string> = {
  "2026-10-v1": "Send me occasional emails about Octillion: product updates, tips and offers. You can unsubscribe at any time.",
};
export const OPT_IN_VERSION = "2026-10-v1";

/** EU member states, the rest of the EEA (Iceland, Liechtenstein, Norway), the UK (and its Crown dependencies) and Switzerland. */
export const OPT_IN_COUNTRIES = new Set(["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL",
  "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO", "GB", "UK", "IM", "JE", "GG", "CH"]);
/** Where the law asks for an opt-in before marketing email: those countries, and anywhere we do not know. */
export const countryNeedsOptIn = (country: string | null | undefined) => !country || OPT_IN_COUNTRIES.has(country.trim().toUpperCase());

/** A country code we trust: two letters (Vercel's x-vercel-ip-country), else null. */
export const cleanCountry = (v: unknown) => (typeof v === "string" && /^[A-Za-z]{2}$/.test(v.trim()) ? v.trim().toUpperCase() : null);

export interface ConsentRow { email_hash: string; basis: Basis; source: string; wording_version: string | null; country: string | null; at: Date }

/** The basis in force for each address (by its address; the map is keyed by the lowercased address). */
export async function consentOf(emails: string[]): Promise<Map<string, ConsentRow>> {
  if (!emails.length) return new Map();
  const byHash = new Map(emails.map((e) => [hashAddress(e), e.trim().toLowerCase()]));
  const rows = await (await getDb()).query<ConsentRow>("SELECT email_hash, basis, source, wording_version, country, at FROM email_consents WHERE email_hash = ANY($1::text[])", [[...byHash.keys()]]);
  return new Map(rows.map((r) => [byHash.get(r.email_hash)!, r]));
}

/**
 * Record a basis and its ledger entry. legitimate_interest never replaces an opt-in or a withdrawal (it is the weakest
 * basis); an opt-in replaces a withdrawal (the person asked again) and lifts an "unsubscribed" suppression, never a
 * bounce or a complaint.
 */
export async function recordConsent(email: string, basis: Basis, o: { source: string; wording_version?: string | null; country?: string | null; request_id?: number | null; campaign_id?: number | null }) {
  const hash = hashAddress(email), db = await getDb();
  const [r] = await db.query<{ email_hash: string }>(
    `INSERT INTO email_consents (email_hash, basis, source, wording_version, country, at) VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (email_hash) DO UPDATE SET basis = excluded.basis, source = excluded.source, wording_version = excluded.wording_version,
            country = coalesce(excluded.country, email_consents.country), at = now()
       WHERE excluded.basis <> 'legitimate_interest' OR email_consents.basis = 'legitimate_interest'
     RETURNING email_hash`, [hash, basis, o.source.slice(0, 60), o.wording_version ?? null, o.country ?? null]);
  if (!r) return false; // a weaker basis than the one in force: nothing changes
  await db.query(
    `INSERT INTO email_consent_ledger (email_hash, basis, source, wording_version, country, request_id, campaign_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [hash, basis, o.source.slice(0, 60), o.wording_version ?? null, o.country ?? null, o.request_id ?? null, o.campaign_id ?? null]);
  if (basis === "opt_in") await db.query("DELETE FROM email_suppressions WHERE email_hash = $1 AND reason = 'unsubscribed'", [hash]);
  return true;
}

/** The access-request form's checkbox: an opt-in only when ticked and the wording version is one we showed. */
export async function recordFormOptIn(email: string, o: { opt_in: unknown; wording_version: unknown; country: string | null; request_id: number }) {
  if (o.opt_in !== true) return false;
  const v = typeof o.wording_version === "string" && OPT_IN_WORDING[o.wording_version] ? o.wording_version : OPT_IN_VERSION;
  return recordConsent(email, "opt_in", { source: "access_request_form", wording_version: v, country: o.country, request_id: o.request_id });
}

export interface ConsentInput { email: string; source: "account" | "request"; country: string | null }
export type ConsentDecision = { ok: true; basis: "opt_in" | "legitimate_interest" | "opt_out" } | { ok: false; reason: "withdrawn" | "needs_opt_in" };

/** May this campaign write to this person (see the top of the file)? */
export function mayEnrol(p: ConsentInput, requiresOptIn: boolean, have: ConsentRow | undefined): ConsentDecision {
  if (have?.basis === "withdrawn") return { ok: false, reason: "withdrawn" };
  if (have?.basis === "opt_in") return { ok: true, basis: "opt_in" };
  if (requiresOptIn) return { ok: false, reason: "needs_opt_in" };
  if (p.source === "account") return { ok: true, basis: "legitimate_interest" };
  if (countryNeedsOptIn(p.country)) return { ok: false, reason: "needs_opt_in" };
  return { ok: true, basis: "opt_out" };
}

/** The ledger for one address (the admin's "why were they emailed?"). */
export async function consentLedger(email: string) {
  return (await getDb()).query("SELECT basis, source, wording_version, country, request_id, campaign_id, at FROM email_consent_ledger WHERE email_hash = $1 ORDER BY at, id", [hashAddress(email)]);
}
