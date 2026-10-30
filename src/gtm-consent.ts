/**
 * GTM › marketing consent (src/campaigns.ts enrolment, the landing page's access-request form, unsubscribe). Keyed by
 * the sha256 of the lowercased address (src/email.ts hashAddress), never the address:
 *
 *   email_consents        the basis in force: opt_in_pending (the box was ticked, not confirmed yet), opt_in (the
 *                         person clicked the confirmation link: source, wording version, country, when),
 *                         legitimate_interest (an existing customer, recorded the first time a campaign writes to them
 *                         as one), withdrawn (unsubscribed, or complained)
 *   email_consent_ledger  every change, in order, so "what did they agree to, and when" has an answer
 *
 * Double opt-in: anyone can type anyone's address into a public form, so a ticked box only records opt_in_pending and
 * sends one transactional email with a signed link (at most one an address a calendar day, claimed atomically by an
 * idempotency key on the address's hash and the day; never to a bounced or complaining
 * address). Only clicking it (GET asks, POST confirms: link scanners confirm nothing) records opt_in. An unconfirmed
 * tick never replaces a withdrawal or touches the suppression list; a confirmed one replaces a withdrawal and lifts an
 * "unsubscribed" suppression, never a bounce or a complaint.
 *
 * Who a campaign may write to (mayEnrol):
 *   - never anyone who withdrew (or is suppressed: src/campaigns.ts checks that list separately)
 *   - a campaign that requires opt-in (the default for new campaigns whose audience includes access requesters) only
 *     writes to a confirmed opt-in
 *   - an access requester from the EU, the EEA, the UK or Switzerland, or from an unknown country, only ever with a
 *     confirmed opt-in, whatever the campaign says
 *   - otherwise an account's member under legitimate interest (an existing customer, the "soft opt-in"; recorded), and
 *     a requester elsewhere, when the campaign does not require opt-in, on an opt-out basis (CAN-SPAM's model: they
 *     gave us their address, every email carries the unsubscribe link; nothing is recorded as consent)
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { getDb } from "./db.js";
import * as mail from "./email.js";

const { hashAddress } = mail;
export type Basis = "opt_in" | "opt_in_pending" | "legitimate_interest" | "withdrawn";

/**
 * The checkbox on the landing page's access-request form (web/src/features/site/access-form.tsx shows the same words).
 * A new wording gets a new version; the ledger records which one each person saw.
 */
export const OPT_IN_WORDING: Record<string, string> = {
  "2026-10-v1": "Send me occasional emails about Octillion: product updates, tips and offers. You can unsubscribe at any time.",
};
export const OPT_IN_VERSION = "2026-10-v1";
/** How long a confirmation link works. */
const CONFIRM_DAYS = 30;

/** EU member states, the rest of the EEA (Iceland, Liechtenstein, Norway), the UK (and its Crown dependencies) and Switzerland. */
export const OPT_IN_COUNTRIES = new Set(["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL",
  "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO", "GB", "UK", "IM", "JE", "GG", "CH"]);
/** Where the law asks for an opt-in before marketing email: those countries, and anywhere we do not know. */
export const countryNeedsOptIn = (country: string | null | undefined) => !country || OPT_IN_COUNTRIES.has(country.trim().toUpperCase());

/**
 * The request's country: Vercel's x-vercel-ip-country, trusted only when running on Vercel (anywhere else the header
 * is whatever the client sent). Two letters, else null (unknown, which needs an opt-in).
 */
export const requestCountry = (header: unknown) => (process.env.VERCEL ? cleanCountry(header) : null);
export const cleanCountry = (v: unknown) => (typeof v === "string" && /^[A-Za-z]{2}$/.test(v.trim()) ? v.trim().toUpperCase() : null);

export interface ConsentRow { email_hash: string; basis: Basis; source: string; wording_version: string | null; country: string | null; at: Date }

/** The basis in force for each address (by its address; the map is keyed by the lowercased address). */
export async function consentOf(emails: string[]): Promise<Map<string, ConsentRow>> {
  if (!emails.length) return new Map();
  const byHash = new Map(emails.map((e) => [hashAddress(e), e.trim().toLowerCase()]));
  const rows = await (await getDb()).query<ConsentRow>("SELECT email_hash, basis, source, wording_version, country, at FROM email_consents WHERE email_hash = ANY($1::text[])", [[...byHash.keys()]]);
  return new Map(rows.map((r) => [byHash.get(r.email_hash)!, r]));
}

type RecordOpts = { source: string; wording_version?: string | null; country?: string | null; request_id?: number | null; campaign_id?: number | null };

/**
 * Record a basis (by the address's hash) and its ledger entry. The weak ones only fill a gap: legitimate_interest
 * replaces nothing but itself; opt_in_pending replaces only legitimate_interest or an older pending (never an opt-in,
 * never a withdrawal). opt_in (confirmed) and withdrawn replace anything; a confirmed opt-in lifts an "unsubscribed"
 * suppression, never a bounce or a complaint. The ledger keeps a pending tick even when the basis in force stays.
 */
async function recordByHash(hash: string, basis: Basis, o: RecordOpts) {
  const db = await getDb();
  const [r] = await db.query<{ email_hash: string }>(
    `INSERT INTO email_consents (email_hash, basis, source, wording_version, country, at) VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (email_hash) DO UPDATE SET basis = excluded.basis, source = excluded.source, wording_version = excluded.wording_version,
            country = coalesce(excluded.country, email_consents.country), at = now()
       WHERE excluded.basis IN ('opt_in', 'withdrawn')
          OR (excluded.basis = 'opt_in_pending' AND email_consents.basis IN ('legitimate_interest', 'opt_in_pending'))
          OR (excluded.basis = 'legitimate_interest' AND email_consents.basis = 'legitimate_interest')
     RETURNING email_hash`, [hash, basis, o.source.slice(0, 60), o.wording_version ?? null, o.country ?? null]);
  if (!r && basis !== "opt_in_pending") return false; // weaker than the basis in force: nothing changes
  await db.query(
    `INSERT INTO email_consent_ledger (email_hash, basis, source, wording_version, country, request_id, campaign_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [hash, basis, o.source.slice(0, 60), o.wording_version ?? null, o.country ?? null, o.request_id ?? null, o.campaign_id ?? null]);
  if (basis === "opt_in") await db.query("DELETE FROM email_suppressions WHERE email_hash = $1 AND reason = 'unsubscribed'", [hash]);
  return !!r;
}
export const recordConsent = (email: string, basis: Basis, o: RecordOpts) => recordByHash(hashAddress(email), basis, o);

// ---------- double opt-in: the confirmation link ----------

/** The key: the unsubscribe links' vault secret (src/campaigns.ts unsubscribeKey), under its own purpose. */
const keyOf = async () => (await import("./campaigns.js")).unsubscribeKey();
const sign = (key: Buffer, body: string) => createHmac("sha256", key).update(`optin:${body}`).digest("base64url").slice(0, 32);
/** A token naming the address's hash, the wording seen, the country and the request: nothing readable as an address. */
export async function confirmToken(email: string, o: { wording_version: string; country: string | null; request_id: number }, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ h: hashAddress(email), v: o.wording_version, c: o.country, r: o.request_id, t: Math.floor(now / 1000) })).toString("base64url");
  return `${body}.${sign(await keyOf(), body)}`;
}
async function readToken(token: unknown): Promise<{ h: string; v: string; c: string | null; r: number } | null> {
  const m = /^([A-Za-z0-9_-]{20,600})\.([A-Za-z0-9_-]{32})$/.exec(String(token ?? ""));
  if (!m) return null;
  const key = await keyOf().catch(() => null);
  if (!key) return null;
  const got = Buffer.from(m[2]), want = Buffer.from(sign(key, m[1]));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const x = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
    if (typeof x.h !== "string" || !/^[0-9a-f]{64}$/.test(x.h) || Date.now() / 1000 - Number(x.t) > CONFIRM_DAYS * 86_400) return null;
    return { h: x.h, v: OPT_IN_WORDING[x.v] ? x.v : OPT_IN_VERSION, c: cleanCountry(x.c), r: Number(x.r) || 0 };
  } catch { return null; }
}
export const confirmUrl = (token: string) => `${mail.siteUrl()}/api/email/confirm?t=${encodeURIComponent(token)}`;

/**
 * The access-request form's checkbox (after the request is stored): ticked, it records opt_in_pending and sends the
 * confirmation email, at most one an address in 24 hours, and none to an address that bounced or complained. Returns
 * what happened. Never an opt-in by itself.
 */
export async function recordFormOptIn(email: string, o: { opt_in: unknown; wording_version: unknown; country: string | null; request_id: number }):
  Promise<"none" | "pending" | "pending_no_email" | "blocked"> {
  if (o.opt_in !== true || !mail.isEmail(email)) return "none";
  const v = typeof o.wording_version === "string" && OPT_IN_WORDING[o.wording_version] ? o.wording_version : OPT_IN_VERSION;
  const hash = hashAddress(email), db = await getDb();
  const [hard] = await db.query("SELECT 1 FROM email_suppressions WHERE email_hash = $1 AND reason IN ('bounced', 'complained')", [hash]);
  if (hard) return "blocked";
  await recordByHash(hash, "opt_in_pending", { source: "access_request_form", wording_version: v, country: o.country, request_id: o.request_id });
  // One a day an address, atomically: the email's idempotency key names the address's hash and the day, and
  // email_log claims a key once (INSERT … ON CONFLICT), so two submissions racing get one email between them.
  const day = new Date().toISOString().slice(0, 10);
  const [had] = await db.query("SELECT 1 FROM email_log WHERE idempotency_key = $1 AND status IN ('sent', 'sending')", [`optin-confirm:${hash}:${day}`]);
  if (had) return "pending_no_email";
  const url = confirmUrl(await confirmToken(email, { wording_version: v, country: o.country, request_id: o.request_id }));
  mail.fire(mail.sendLater({ kind: "marketing_confirm", to: email, idempotencyKey: `optin-confirm:${hash}:${day}`, meta: { request_id: o.request_id },
    subject: "Confirm Octillion's emails",
    text: mail.lines("Hi,",
      `You ticked "${OPT_IN_WORDING[v]}" when you asked for access to Octillion.`,
      `To get those emails, confirm here: ${url}`,
      "If that wasn't you, ignore this email: nothing changes, and we won't ask again today. We'll still email you about your access request.",
      mail.SIGN) }));
  return "pending";
}

/** POST behind the confirmation link: records the confirmed opt-in. */
export async function confirmOptIn(token: unknown): Promise<boolean> {
  const t = await readToken(token);
  if (!t) return false;
  await recordByHash(t.h, "opt_in", { source: "access_request_form_confirmed", wording_version: t.v, country: t.c, request_id: t.r || null });
  return true;
}
export const verifyConfirm = async (token: unknown) => (await readToken(token)) != null;

/** The page behind the link: GET asks (mail scanners follow links), POST confirms. */
export function confirmPage(state: "ask" | "done" | "invalid", token = "") {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const body = {
    ask: `<h1>Get Octillion's emails?</h1><p>${esc(OPT_IN_WORDING[OPT_IN_VERSION])}</p>
<form method="post" action="/api/email/confirm?t=${esc(encodeURIComponent(token))}"><button type="submit">Yes, send me emails</button></form>`,
    done: "<h1>Thanks, you're subscribed</h1><p>Every email has a link to unsubscribe.</p>",
    invalid: "<h1>This link doesn't work</h1><p>It may have expired or been cut short. Tick the box again on the access form to get a new one.</p>",
  }[state];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Confirm | Octillion</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#111827;line-height:1.55}
h1{font-size:1.4rem}button{font:inherit;padding:.5rem 1rem;border-radius:.375rem;border:0;background:#111827;color:#fff;cursor:pointer}</style></head><body>${body}</body></html>`;
}

export interface ConsentInput { email: string; source: "account" | "request"; country: string | null }
export type ConsentDecision = { ok: true; basis: "opt_in" | "legitimate_interest" | "opt_out" } | { ok: false; reason: "withdrawn" | "needs_opt_in" };

/** May this campaign write to this person (see the top of the file)? A pending opt-in counts as none. */
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
