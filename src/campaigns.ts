/**
 * GTM › Campaigns (/admin/gtm/campaigns): lifecycle email to people who already gave Octillion their address. The
 * audience is a saved filter over accounts (their active members in Clerk) and access requests (the requester), never
 * an imported or cold list. Owners only (admin-roles.ts "campaigns"); every GET is any admin's, as everywhere.
 *
 *   model       gtm_campaigns (migrations 0008, 0009): name, audience, steps [{subject, body, delay_days, variants?}]
 *               with {{first_name}} and {{product}}, status draft -> scheduled -> running <-> paused -> done, rolling
 *               enrolment, the owner; a trigger (instead of a schedule), a send window, requires_opt_in,
 *               count_auto_replies
 *   recipients  enrolled when a campaign starts (and on every tick while it runs, when rolling), or, for a triggered
 *               campaign, from events (src/gtm-events.ts) once the trigger's delay is up, with its re-entry rule (once
 *               ever, or again after N days: a new round). One row per address. gtm_campaign_recipients and
 *               gtm_replies are the ONLY places a recipient's email address is stored. email_log keeps the
 *               transactional rule (a hash and the domain, src/email.ts); suppressions and consent keep a hash.
 *   consent     src/gtm-consent.ts: a campaign that requires opt-in writes only to a recorded opt-in; a requester from
 *               the EU / EEA / UK / CH or an unknown country only ever with one; an account's member under legitimate
 *               interest. Unsubscribing withdraws consent.
 *   sending     through src/email.ts (Resend), from campaignTick(): the Vercel cron (/api/cron/autoscale, every 5
 *               minutes), on a VM startCampaignTicker(), and a kick when an event a no-delay trigger waits for happens.
 *               One tick at a time everywhere (a lease row). A tick keeps going, wave after wave, until it has sent
 *               CAMPAIGN_SENDS_PER_TICK (1,000) or CAMPAIGN_TICK_SECONDS (180) are up, in Resend batch requests of
 *               CAMPAIGN_BATCH_SIZE (100) CAMPAIGN_SEND_INTERVAL_MS (600 ms) apart: about 12,000 an hour, far under
 *               Resend's 10 requests a second; a 429 waits its retry-after. Idempotent: a recipient is leased before
 *               it is sent, a (recipient, round, step) row in gtm_campaign_sends is claimed once (UNIQUE) and only
 *               while the campaign runs and the person is still waiting, and each email keeps its own email_log row
 *               and idempotency key (the batch's key is derived from them, src/email.ts sendBatch).
 *   windows     a step due outside the campaign's days and hours (in the recipient's time zone, src/gtm-schedule.ts)
 *               waits for the next opening
 *   variants    a step can carry 2 to 4 variants (subject and/or body) with weights; each person gets one,
 *               deterministically, recorded on the send; per-variant numbers with a two-proportion z-test; "pick
 *               winner" puts one at 100%
 *   replies     each email replies to a per-recipient address (src/gtm-replies.ts); a reply stops that person's
 *               remaining steps, and shows in the campaign and in the Replies inbox
 *   opt-out     every email carries an unsubscribe link (a token signed with a key in the vault, GET shows a confirm
 *               button, POST unsubscribes: RFC 8058 one-click) and List-Unsubscribe headers, and the sender's postal
 *               address when one is set (Campaigns settings). The suppression list (unsubscribed, hard bounce,
 *               complaint, by hand) is checked before every send.
 *   metrics     recipients, sent, delivered / bounced / opened / clicked (Resend webhooks, POST /api/webhooks/resend,
 *               Svix-signed with the key vault's resend_webhook secret), replied, unsubscribed, and conversions within
 *               conversion_days of the first email: requested access, activated (first simulation), paid (src/gtm.ts).
 *   outbound    an audience of prospects (src/gtm-outbound.ts, phase 2): a sender identity on the outreach subdomain
 *               (required: never EMAIL_FROM's domain), its warm-up cap per day across campaigns, the cold-email
 *               safety rules at enrolment and before each send, text-only email unless the campaign tracks opens.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import { getDb } from "./db.js";
import * as mail from "./email.js";
import { accountPeople, AdminError, log, STAGES } from "./admin.js";
import { DIRECT, journeys, requestRows, within, type Journey, type RequestRow } from "./gtm.js";
import { addCredentialIfAbsent, useCredential } from "./keyvault.js";
import { freshSettings, settingNumber, settingText } from "./settings.js";
import { capture } from "./telemetry.js";
import { consentOf, mayEnrol, recordConsent, type ConsentDecision, type ConsentInput } from "./gtm-consent.js";
import { DETECTED, detectSignals, EVENT_TYPES, forgetImmediate, REQUEST_EVENTS, type EventType } from "./gtm-events.js";
import { NO_WINDOW, nextOpening, parseWindow, recipientZone, validZone, windowOpen, type SendWindow } from "./gtm-schedule.js";
import * as replies from "./gtm-replies.js";
import * as outbound from "./gtm-outbound.js";
import { backfillOnce, freshMemberCheck, memberIndex, type MemberIndex } from "./gtm-crm.js";

export const STATUSES = ["draft", "scheduled", "running", "paused", "done"] as const;
export type CampaignStatus = (typeof STATUSES)[number];
export const VARIABLES = ["first_name", "product"] as const;
export const WEBHOOK_PROVIDER = "resend_webhook";
/** The unsubscribe links' signing key: a random secret generated once into the key vault (migration 0008). */
export const UNSUBSCRIBE_PROVIDER = "email_unsubscribe";
const REQUEST_STATUSES = ["pending", "approved", "declined"];
const MAX_STEPS = 10;
export const VARIANT_LETTERS = ["A", "B", "C", "D"] as const;

// ---------- the model ----------

export interface Audience {
  /** accounts: their active members (Clerk), else the account's approved requesters; requests: the requester;
   *  prospects: outbound, a filter over gtm_prospects (`prospects`; src/gtm-outbound.ts). */
  include: "accounts" | "requests" | "both" | "prospects";
  stages: string[]; attention: string; created_from: string | null; created_to: string | null;
  utm_source: string; utm_medium: string; utm_campaign: string; plans: string[]; request_status: string[];
  /** Account slugs: a one-off nudge to named accounts (Activation's "Email a nudge"). */
  accounts: string[];
  /** include = prospects: the saved filter over prospects. */
  prospects?: outbound.ProspectFilter;
}
export interface Variant { subject: string; body: string; weight: number }
/** subject / body are variant A's when there are variants (kept so a reader without variants still has the email). */
export interface Step { subject: string; body: string; delay_days: number; variants?: Variant[] }
/**
 * Enrol on an event instead of an audience at launch. stage: for stage_reached and stuck; days: for stuck; attention:
 * text the reason contains (empty: any). delay_hours after the event. reentry: once ever, or again every reentry_days.
 */
export interface Trigger { type: EventType; stage: string | null; days: number | null; attention: string; delay_hours: number; reentry: "once" | "every"; reentry_days: number }

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const strs = (v: unknown, max = 200) => [...new Set((Array.isArray(v) ? v : v == null || v === "" ? [] : [v]).map((x) => String(x).trim()).filter(Boolean))].slice(0, max);
const day = (v: unknown, what: string) => {
  if (v == null || v === "") return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new AdminError(`${what} must be a date, YYYY-MM-DD`);
  return v;
};
const fail = (msg: string): never => { throw new AdminError(msg); };

export function parseAudience(v: unknown): Audience {
  const a = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const include = a.include == null || a.include === "" ? "accounts" : a.include;
  if (include !== "accounts" && include !== "requests" && include !== "both" && include !== "prospects") throw new AdminError("audience.include must be accounts, requests, both or prospects");
  const stages = strs(a.stages);
  const bad = stages.find((s) => !STAGES.some((x) => x.id === s));
  if (bad) throw new AdminError(`Unknown stage ${bad}: use ${STAGES.map((s) => s.id).join(", ")}`);
  const request_status = strs(a.request_status);
  if (request_status.some((s) => !REQUEST_STATUSES.includes(s))) throw new AdminError("audience.request_status takes pending, approved and declined");
  const out: Audience = {
    include, stages, attention: str(a.attention, 200), created_from: day(a.created_from, "audience.created_from"), created_to: day(a.created_to, "audience.created_to"),
    utm_source: str(a.utm_source, 200), utm_medium: str(a.utm_medium, 200), utm_campaign: str(a.utm_campaign, 200), plans: strs(a.plans), request_status,
    accounts: strs(a.accounts, 500),
    ...(include === "prospects" ? { prospects: outbound.parseProspectFilter(a.prospects) } : {}),
  };
  if (out.created_from && out.created_to && out.created_to < out.created_from) throw new AdminError("audience.created_to is before created_from");
  return out;
}

const VAR = /\{\{\s*([a-zA-Z_]+)\s*\}\}/g;
const checkVars = (text: string, what: string) => {
  for (const m of text.matchAll(VAR))
    if (!(VARIABLES as readonly string[]).includes(m[1])) throw new AdminError(`${what}: unknown variable {{${m[1]}}}; use ${VARIABLES.map((x) => `{{${x}}}`).join(" or ")}`);
};
export function parseSteps(v: unknown): Step[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new AdminError("steps must be a list");
  if (v.length > MAX_STEPS) throw new AdminError(`At most ${MAX_STEPS} steps`);
  return v.map((x, i) => {
    const s = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const delay = s.delay_days == null || s.delay_days === "" ? (i ? 3 : 0) : Number(s.delay_days);
    if (!Number.isInteger(delay) || delay < 0 || delay > 365) throw new AdminError(`Step ${i + 1}: delay_days is a whole number of days, 0 to 365`);
    const raw = Array.isArray(s.variants) ? s.variants : [];
    if (raw.length) {
      if (raw.length < 2 || raw.length > VARIANT_LETTERS.length) throw new AdminError(`Step ${i + 1}: 2 to ${VARIANT_LETTERS.length} variants, or none`);
      // A variant's empty subject or body is variant A's: test just the subject, or just the body.
      const base = (raw[0] ?? {}) as Record<string, unknown>;
      const subjectA = str(base.subject ?? s.subject, 200).replace(/[\r\n]+/g, " "), bodyA = str(base.body ?? s.body, 20_000);
      if (!subjectA || !bodyA) throw new AdminError(`Step ${i + 1}: variant A needs a subject and a body`);
      const variants = raw.map((y, k) => {
        const o = (y && typeof y === "object" ? y : {}) as Record<string, unknown>;
        const w = o.weight == null || o.weight === "" ? 50 : Number(o.weight);
        if (!Number.isInteger(w) || w < 0 || w > 100) throw new AdminError(`Step ${i + 1}, variant ${VARIANT_LETTERS[k]}: weight is a whole number, 0 to 100`);
        const subject = str(o.subject, 200).replace(/[\r\n]+/g, " ") || subjectA, body = str(o.body, 20_000) || bodyA;
        checkVars(`${subject}\n${body}`, `Step ${i + 1}, variant ${VARIANT_LETTERS[k]}`);
        return { subject, body, weight: w };
      });
      if (!variants.some((y) => y.weight > 0)) throw new AdminError(`Step ${i + 1}: at least one variant needs a weight above 0`);
      return { subject: variants[0].subject, body: variants[0].body, delay_days: delay, variants };
    }
    const subject = str(s.subject, 200).replace(/[\r\n]+/g, " "), body = str(s.body, 20_000);
    if (!subject || !body) throw new AdminError(`Step ${i + 1} needs a subject and a body`);
    checkVars(`${subject}\n${body}`, `Step ${i + 1}`);
    return { subject, body, delay_days: delay };
  });
}

/** The variant a person gets for a step: the same every time (a hash of campaign, step and person over the weights). */
export function pickVariant(step: Step, campaignId: number, index: number, recipientId: number): { letter: string | null; subject: string; body: string } {
  const vs = step.variants ?? [];
  const total = vs.reduce((t, v) => t + v.weight, 0);
  if (vs.length < 2 || total <= 0) return { letter: null, subject: step.subject, body: step.body };
  let x = parseInt(createHash("sha256").update(`${campaignId}:${index}:${recipientId}`).digest("hex").slice(0, 12), 16) % total;
  for (const [k, v] of vs.entries()) { if (x < v.weight) return { letter: VARIANT_LETTERS[k], subject: v.subject, body: v.body }; x -= v.weight; }
  return { letter: VARIANT_LETTERS[0], subject: vs[0].subject, body: vs[0].body };
}

export function parseTrigger(v: unknown): Trigger | null {
  if (v == null || v === "" || v === false) return null;
  const t = (typeof v === "object" ? v : {}) as Record<string, unknown>;
  if (t.type == null || t.type === "") return null;
  if (!(EVENT_TYPES as readonly string[]).includes(String(t.type))) throw new AdminError(`trigger.type must be one of ${EVENT_TYPES.join(", ")}`);
  const type = t.type as EventType;
  const stage = type === "stage_reached" || type === "stuck" ? str(t.stage, 40) : "";
  if ((type === "stage_reached" || type === "stuck") && !STAGES.some((s) => s.id === stage)) throw new AdminError(`trigger.stage must be one of ${STAGES.map((s) => s.id).join(", ")}`);
  const days = type === "stuck" ? Number(t.days ?? 3) : null;
  if (days != null && (!Number.isInteger(days) || days < 1 || days > 365)) throw new AdminError("trigger.days (stuck for) is 1 to 365");
  const delay = t.delay_hours == null || t.delay_hours === "" ? 0 : Number(t.delay_hours);
  if (!Number.isFinite(delay) || delay < 0 || delay > 24 * 90) throw new AdminError("trigger.delay_hours is 0 to 2160 (90 days)");
  const reentry = t.reentry === "every" ? "every" : "once";
  const rd = t.reentry_days == null || t.reentry_days === "" ? 30 : Number(t.reentry_days);
  if (reentry === "every" && (!Number.isInteger(rd) || rd < 1 || rd > 3650)) throw new AdminError("trigger.reentry_days is 1 to 3650");
  return { type, stage: stage || null, days, attention: type === "attention" ? str(t.attention, 200) : "", delay_hours: Math.round(delay * 100) / 100, reentry, reentry_days: reentry === "every" ? rd : 0 };
}
const parseTriggerSafe = (t: unknown) => { try { return parseTrigger(t); } catch { return null; } };
const parseWindowSafe = (w: unknown) => { try { return parseWindow(w, fail); } catch { return NO_WINDOW; } };

/**
 * The variables' values, made safe: first_name is one word of letters (with ' or -), at most 40 characters, else
 * "there"; product is one line without control characters, at most 80, else "your product". Neither is ever a link.
 */
export function safeVars(vars: { first_name?: string | null; product?: string | null }): Record<(typeof VARIABLES)[number], string> {
  const first = String(vars.first_name ?? "").trim().split(/\s+/)[0] ?? "";
  const product = String(vars.product ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80).trim();
  return { first_name: /^\p{L}[\p{L}\p{M}'’-]{0,39}$/u.test(first) ? first : "there", product: product || "your product" };
}
/** {{first_name}} and {{product}} as plain text (the subject and the text part). */
export function render(t: string, vars: { first_name?: string | null; product?: string | null }) {
  const values: Record<string, string> = safeVars(vars);
  return t.replace(VAR, (_m, k: string) => values[k] ?? "");
}
/**
 * The HTML part: the admin's words through email.htmlOf (paragraphs, their own links), with each variable put in
 * afterwards as escaped text, so a value that looks like a URL is never made a link.
 */
export function renderHtml(t: string, vars: { first_name?: string | null; product?: string | null }) {
  const values: Record<string, string> = safeVars(vars), used: string[] = [];
  const marked = t.replace(VAR, (_m, k: string) => { used.push(values[k] ?? ""); return `\u0001${used.length - 1}\u0001`; });
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  // A zero-width non-joiner after each dot keeps mail clients from auto-linking a value that reads like a domain.
  return mail.htmlOf(marked).replace(/\u0001(\d+)\u0001/g, (_m, i: string) => esc(used[Number(i)] ?? "").replace(/\./g, ".&#8204;"));
}

interface CampaignRow {
  id: number; name: string; audience: Audience; steps: Step[]; status: CampaignStatus; rolling: boolean; conversion_days: number; starts_at: Date | null;
  owner: string; owner_user_id: string | null; created_at: Date; updated_at: Date; launched_at: Date | null; enrolled_at: Date | null; finished_at: Date | null;
  trigger: Trigger | null; send_window: SendWindow; requires_opt_in: boolean | null; count_auto_replies: boolean;
  /** Outbound (migration 0010): the sender identity, open tracking (null: off for outbound), EU / EEA / UK / CH prospects allowed. */
  sender_identity_id: number | null; track_opens: boolean | null; allow_restricted: boolean;
}
const COLS = "id, name, audience, steps, status, rolling, conversion_days, starts_at, owner, owner_user_id, created_at, updated_at, launched_at, enrolled_at, finished_at, trigger, send_window, requires_opt_in, count_auto_replies, sender_identity_id, track_opens, allow_restricted";
const idOf = (v: unknown) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new AdminError("Invalid campaign id");
  return n;
};
const shapeRow = (c: CampaignRow): CampaignRow => ({ ...c, id: Number(c.id), audience: parseAudienceSafe(c.audience), steps: Array.isArray(c.steps) ? c.steps : [],
  trigger: parseTriggerSafe(c.trigger), send_window: parseWindowSafe(c.send_window), sender_identity_id: c.sender_identity_id == null ? null : Number(c.sender_identity_id) });
/** An outbound campaign: its audience is prospects (src/gtm-outbound.ts). */
export const isOutbound = (c: Pick<CampaignRow, "audience">) => c.audience.include === "prospects";
/** Open tracking: as set; by default on for lifecycle email (its HTML part), off for outbound (text only, no pixel). */
const tracksOpens = (c: Pick<CampaignRow, "audience" | "track_opens">) => c.track_opens ?? !isOutbound(c);
async function campaignById(id: number): Promise<CampaignRow> {
  const [c] = await (await getDb()).query<CampaignRow>(`SELECT ${COLS} FROM gtm_campaigns WHERE id = $1`, [idOf(id)]);
  if (!c) throw new AdminError(`No campaign ${id}`, 404);
  return shapeRow(c);
}
const parseAudienceSafe = (a: unknown) => { try { return parseAudience(a); } catch { return parseAudience({}); } };

/** Whether this campaign writes only to a recorded opt-in: as set, else on when it can reach access requesters. */
export const requiresOptIn = (c: Pick<CampaignRow, "requires_opt_in" | "trigger" | "audience">) =>
  c.audience.include === "prospects" ? false : c.requires_opt_in ?? (c.trigger ? REQUEST_EVENTS.includes(c.trigger.type) : c.audience.include !== "accounts");

function fields(body: Record<string, unknown>, partial: boolean) {
  const out: Partial<Pick<CampaignRow, "name" | "audience" | "steps" | "rolling" | "conversion_days" | "trigger" | "send_window" | "requires_opt_in" | "count_auto_replies"
    | "sender_identity_id" | "track_opens" | "allow_restricted">> = {};
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
  if (!partial || body.trigger !== undefined) out.trigger = parseTrigger(body.trigger);
  if (!partial || body.send_window !== undefined) out.send_window = parseWindow(body.send_window, fail);
  if (!partial || body.requires_opt_in !== undefined) out.requires_opt_in = body.requires_opt_in == null || body.requires_opt_in === "" ? null : body.requires_opt_in === true;
  if (!partial || body.count_auto_replies !== undefined) out.count_auto_replies = body.count_auto_replies === true;
  if (!partial || body.sender_identity_id !== undefined) {
    const n = body.sender_identity_id == null || body.sender_identity_id === "" ? null : Number(body.sender_identity_id);
    if (n != null && (!Number.isSafeInteger(n) || n <= 0)) throw new AdminError("sender_identity_id must be a sender identity's id");
    out.sender_identity_id = n;
  }
  if (!partial || body.track_opens !== undefined) out.track_opens = body.track_opens == null || body.track_opens === "" ? null : body.track_opens === true;
  if (!partial || body.allow_restricted !== undefined) out.allow_restricted = body.allow_restricted === true;
  if (out.audience?.include === "prospects" && out.trigger) throw new AdminError("An outbound campaign (prospects) is not triggered by events: it starts at launch or a scheduled time");
  return out;
}

/** An identity named on a campaign must exist and be fit for cold email (never the product's sender domain). */
async function checkIdentity(id: number | null | undefined) {
  if (id == null) return;
  const why = await outbound.identityProblem(id);
  if (why) throw new AdminError(why);
}
/** A prospects campaign may not start (launch, schedule, resume) without a valid outbound identity. */
async function assertSendable(c: CampaignRow) {
  if (!isOutbound(c)) return;
  const why = await outbound.identityProblem(c.sender_identity_id);
  if (why) throw new AdminError(why, 409);
}

export async function createCampaign(actor: string, ownerUserId: string | null, body: Record<string, unknown>) {
  const f = fields(body, false);
  await checkIdentity(f.sender_identity_id);
  const [row] = await (await getDb()).query<{ id: number }>(
    `INSERT INTO gtm_campaigns (name, audience, steps, rolling, conversion_days, owner, owner_user_id, trigger, send_window, requires_opt_in, count_auto_replies,
                                sender_identity_id, track_opens, allow_restricted)
     VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14) RETURNING id`,
    [f.name, JSON.stringify(f.audience), JSON.stringify(f.steps), f.rolling, f.conversion_days, actor, ownerUserId,
     f.trigger ? JSON.stringify(f.trigger) : null, JSON.stringify(f.send_window), f.requires_opt_in, f.count_auto_replies,
     f.sender_identity_id, f.track_opens, f.allow_restricted]);
  log(actor, "campaign.create", null, { campaign_id: Number(row.id), steps: f.steps!.length, trigger: f.trigger?.type ?? null });
  return campaignDetail(Number(row.id));
}

/** Edits: a draft, a scheduled one before it starts, or a paused one (its steps change for whoever has not had them yet). */
export async function updateCampaign(actor: string, id: number, body: Record<string, unknown>) {
  const c = await campaignById(id);
  if (!["draft", "scheduled", "paused"].includes(c.status)) throw new AdminError(`A ${c.status} campaign cannot be edited: pause it first`, 409);
  const f = fields(body, true);
  // Cold and lifecycle email never trade places: once anyone is enrolled, the audience stays prospects (outbound, from
  // an identity) or stays accounts / requesters (lifecycle, from EMAIL_FROM).
  const switching = !!f.audience && (f.audience.include === "prospects") !== isOutbound(c);
  if ((f.audience ?? c.audience).include === "prospects" && (body.trigger !== undefined ? f.trigger : c.trigger))
    throw new AdminError("An outbound campaign (prospects) is not triggered by events: it starts at launch or a scheduled time");
  await checkIdentity(f.sender_identity_id);
  // The trigger column is nullable: "no trigger" is a change, so it is set explicitly when sent (the identity and
  // open tracking likewise). A switch between prospects and accounts is checked and written under the campaign's row
  // lock: an enrolment (whose recipients reference the row) cannot slip in between.
  await (await getDb()).transaction(async (tx) => {
    const [locked] = await tx.query<{ include: string }>("SELECT audience->>'include' AS include FROM gtm_campaigns WHERE id = $1 FOR UPDATE", [c.id]);
    if (switching || (f.audience && (f.audience.include === "prospects") !== (locked?.include === "prospects"))) {
      const [{ n }] = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM gtm_campaign_recipients WHERE campaign_id = $1", [c.id]);
      if (n) throw new AdminError("This campaign has recipients: its audience cannot switch between prospects (outbound) and accounts or requesters. Make a new campaign instead", 409);
    }
    await tx.query(
    `UPDATE gtm_campaigns SET name = coalesce($2, name), audience = coalesce($3::jsonb, audience), steps = coalesce($4::jsonb, steps),
            rolling = coalesce($5, rolling), conversion_days = coalesce($6, conversion_days),
            trigger = CASE WHEN $7 THEN $8::jsonb ELSE trigger END, send_window = coalesce($9::jsonb, send_window),
            requires_opt_in = CASE WHEN $10 THEN $11 ELSE requires_opt_in END, count_auto_replies = coalesce($12, count_auto_replies),
            sender_identity_id = CASE WHEN $13 THEN $14::bigint ELSE sender_identity_id END, track_opens = CASE WHEN $15 THEN $16::boolean ELSE track_opens END,
            allow_restricted = coalesce($17, allow_restricted), updated_at = now() WHERE id = $1`,
    [c.id, f.name ?? null, f.audience ? JSON.stringify(f.audience) : null, f.steps ? JSON.stringify(f.steps) : null, f.rolling ?? null, f.conversion_days ?? null,
     body.trigger !== undefined, f.trigger ? JSON.stringify(f.trigger) : null, f.send_window ? JSON.stringify(f.send_window) : null,
     body.requires_opt_in !== undefined, f.requires_opt_in ?? null, f.count_auto_replies ?? null,
     body.sender_identity_id !== undefined, f.sender_identity_id ?? null, body.track_opens !== undefined, f.track_opens ?? null, f.allow_restricted ?? null]);
  });
  forgetImmediate();
  log(actor, "campaign.update", null, { campaign_id: c.id, fields: Object.keys(f) });
  return campaignDetail(c.id);
}

/** Start now, or at `at` (ISO time) when it is in the future. Enrolment happens when it starts (a triggered one: from events after). */
export async function launchCampaign(actor: string, id: number, body: { at?: unknown } = {}) {
  const c = await campaignById(id);
  if (c.status !== "draft") throw new AdminError(c.status === "paused" ? "This campaign is paused: resume it" : `This campaign is already ${c.status}`, 409);
  if (!c.steps.length) throw new AdminError("Add at least one email before launching");
  await assertSendable(c);
  const at = body.at ? new Date(String(body.at)) : null;
  if (at && Number.isNaN(at.getTime())) throw new AdminError("at must be a date and time");
  const db = await getDb();
  if (at && at.getTime() > Date.now() + 60_000) {
    await db.query("UPDATE gtm_campaigns SET status = 'scheduled', starts_at = $2, updated_at = now() WHERE id = $1", [c.id, at]);
    log(actor, "campaign.schedule", null, { campaign_id: c.id, starts_at: at.toISOString() });
  } else {
    await db.query("UPDATE gtm_campaigns SET status = 'running', starts_at = now(), launched_at = now(), updated_at = now() WHERE id = $1", [c.id]);
    if (!c.trigger) await enrollUnderLease(c.id);
    log(actor, "campaign.launch", null, { campaign_id: c.id, trigger: c.trigger?.type ?? null });
  }
  forgetImmediate();
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
    await assertSendable(c);
    // Paused before it ever started: it starts now (and enrolls on this tick).
    await db.query("UPDATE gtm_campaigns SET status = 'running', launched_at = coalesce(launched_at, now()), updated_at = now() WHERE id = $1", [c.id]);
    if (!c.enrolled_at && !c.trigger) await enrollUnderLease(c.id);
  } else {
    if (c.status === "done") throw new AdminError("This campaign is already done", 409);
    await db.query("UPDATE gtm_campaigns SET status = 'done', finished_at = now(), updated_at = now() WHERE id = $1", [c.id]);
  }
  forgetImmediate();
  log(actor, `campaign.${action}`, null, { campaign_id: c.id });
  return campaignDetail(c.id);
}

/** Delete a draft or a finished campaign (its recipients, sends and replies go with it; suppressions and consent stay). */
export async function deleteCampaign(actor: string, id: number) {
  const c = await campaignById(id);
  if (!["draft", "done"].includes(c.status)) throw new AdminError("End the campaign before deleting it", 409);
  await (await getDb()).query("DELETE FROM gtm_campaigns WHERE id = $1", [c.id]);
  log(actor, "campaign.delete", null, { campaign_id: c.id });
}

/** "Pick winner": one variant of a step at 100%, the others at 0 (kept, with their numbers). Applies from the next send. */
export async function pickWinner(actor: string, id: number, stepIn: unknown, letterIn: unknown) {
  const c = await campaignById(id);
  if (c.status === "done") throw new AdminError("This campaign is done", 409);
  const i = Number(stepIn), letter = String(letterIn ?? "").toUpperCase();
  const step = c.steps[i];
  if (!step?.variants || step.variants.length < 2) throw new AdminError(`Email ${Number.isInteger(i) ? i + 1 : "?"} has no variants`);
  const k = VARIANT_LETTERS.indexOf(letter as (typeof VARIANT_LETTERS)[number]);
  if (k < 0 || k >= step.variants.length) throw new AdminError(`Variant ${letter || "?"} is not one of ${VARIANT_LETTERS.slice(0, step.variants.length).join(", ")}`);
  const steps = c.steps.map((s, j) => (j === i ? { ...s, variants: s.variants!.map((v, n) => ({ ...v, weight: n === k ? 100 : 0 })) } : s));
  await (await getDb()).query("UPDATE gtm_campaigns SET steps = $2::jsonb, updated_at = now() WHERE id = $1", [c.id, JSON.stringify(steps)]);
  log(actor, "campaign.pick_winner", null, { campaign_id: c.id, step: i, variant: letter });
  return campaignDetail(c.id);
}

// ---------- the audience ----------

export interface Candidate {
  email: string; first_name: string | null; product: string | null; source: "account" | "request" | "prospect";
  org_id: number | null; org_slug: string | null; org_name: string | null; request_id: number | null;
  /** ISO country of the person's access request (the account's earliest, for a member), and a stored time zone. */
  country: string | null; time_zone: string | null;
  /** An outbound candidate's prospect (src/gtm-outbound.ts). */
  prospect_id?: number | null;
}
const firstName = (n: string | null | undefined) => n?.trim().split(/\s+/)[0] || null;

/** Everyone the audience matches now, one per address (an account's member before the same person's request). */
export async function resolveAudience(a: Audience, data?: { journeys: Journey[]; requests: RequestRow[] }): Promise<Candidate[]> {
  if (a.include === "prospects") return outbound.resolveProspects(a.prospects ?? outbound.parseProspectFilter({}));
  const scoped = a.stages.length > 0 || !!a.attention || a.plans.length > 0 || a.accounts.length > 0;
  // Requesters only, with no account filter: the requests table is all it takes (no Clerk, no Stripe). Otherwise the
  // accounts, without Stripe's payment history (an audience never needs it; the plan comes with the account listing).
  const { journeys: js, requests } = data ?? (a.include === "requests" && !scoped
    ? { journeys: [] as Journey[], requests: await requestRows() } : await journeys({ stripe: false }));
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
  // An account's country: its earliest request's (the landing page records Vercel's IP country).
  const orgCountry = new Map<number, string>();
  for (const r of requests) if (r.org_id != null && r.country && !orgCountry.has(r.org_id)) orgCountry.set(r.org_id, r.country);

  if (a.include !== "requests") {
    const orgs = js.filter((j) => accountOk(j) && dated(j.created_at) && utmOk(j.utm));
    const ids = orgs.map((j) => Number(j.org.id));
    const products = new Map((ids.length ? await (await getDb()).query<{ org_id: number; name: string }>(
      "SELECT DISTINCT ON (org_id) org_id, name FROM products WHERE org_id = ANY($1::int[]) ORDER BY org_id, created_at, id", [ids]) : []).map((p) => [Number(p.org_id), p.name]));
    for (const j of orgs) {
      const base = { product: products.get(Number(j.org.id)) ?? j.org.name, source: "account" as const, org_id: Number(j.org.id), org_slug: j.org.slug, org_name: j.org.name,
        request_id: null, country: orgCountry.get(Number(j.org.id)) ?? null, time_zone: null };
      const people = await accountPeople(j.org.clerk_org_id);
      // Clerk failed for this account: skip it this pass (never guess with its requesters); the next pass tries again.
      if (people?.error) { console.error(`campaign audience: ${j.org.slug} skipped (Clerk: ${people.error})`); continue; }
      if (people) {
        for (const m of people.members.filter((x) => x.status === "active" && x.email)) add({ ...base, email: m.email!, first_name: firstName(m.name), time_zone: m.time_zone });
        continue;
      }
      // No Clerk organization (a legacy key account): whoever asked for it.
      for (const r of requests.filter((q) => q.org_id === Number(j.org.id) && q.status === "approved")) add({ ...base, email: r.email, first_name: firstName(r.name), request_id: r.id, country: r.country ?? base.country });
    }
  }
  if (a.include !== "accounts") {
    const reqOk = (r: RequestRow) => (!a.request_status.length || a.request_status.includes(r.status)) && dated(r.created_at) && utmOk(r.utm)
      && (!accountScoped || accountOk(r.org_id != null ? byId.get(r.org_id) : undefined));
    for (const r of requests.filter(reqOk)) {
      const j = r.org_id != null ? byId.get(r.org_id) : undefined;
      add({ email: r.email, first_name: firstName(r.name), product: r.company, source: "request", org_id: j ? Number(j.org.id) : null, org_slug: j?.org.slug ?? null, org_name: j?.org.name ?? null,
        request_id: r.id, country: r.country, time_zone: null });
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

type Decision = ConsentDecision | { ok: true; basis: string } | { ok: false; reason: string };
/**
 * Each candidate's consent decision under this campaign's rule (src/gtm-consent.ts). Prospects follow the outbound
 * rules instead (src/gtm-outbound.ts outboundBlocks): their recorded lawful basis, and never a customer, someone in
 * another active sequence, or (unless the campaign allows them) someone in the EU / EEA / UK / CH.
 */
async function consentFor(people: Candidate[], optIn: boolean, c?: Pick<CampaignRow, "id" | "allow_restricted">): Promise<Map<string, Decision>> {
  const prospects = people.filter((p) => p.source === "prospect"), others = people.filter((p) => p.source !== "prospect");
  const have = await consentOf(others.map((p) => p.email));
  const out = new Map<string, Decision>(others.map((p) => [p.email, mayEnrol(p as ConsentInput, optIn, have.get(p.email))]));
  if (prospects.length) {
    const [blocks, bases] = await Promise.all([outbound.outboundBlocks(prospects, { id: c?.id ?? 0, allow_restricted: c?.allow_restricted ?? false }),
      outbound.basesOf(prospects.map((p) => p.email))]);
    for (const p of prospects) {
      const why = blocks.get(p.email);
      out.set(p.email, why ? { ok: false, reason: why } : { ok: true, basis: bases.get(p.email) ?? "legitimate_interest" });
    }
  }
  return out;
}

/** The editor's preview: how many the audience matches now, how many are suppressed or lack consent, and a sample. */
export async function previewAudience(body: { audience?: unknown; requires_opt_in?: unknown; trigger?: unknown; campaign_id?: unknown; allow_restricted?: unknown }) {
  const a = parseAudience(body.audience);
  const optIn = requiresOptIn({ audience: a, trigger: parseTriggerSafe(body.trigger), requires_opt_in: typeof body.requires_opt_in === "boolean" ? body.requires_opt_in : null });
  const all = await resolveAudience(a);
  const cid = Number(body.campaign_id);
  const [suppressed, consent] = await Promise.all([suppressedSet(all.map((c) => c.email)),
    consentFor(all, optIn, { id: Number.isSafeInteger(cid) && cid > 0 ? cid : 0, allow_restricted: body.allow_restricted === true })]);
  const blocked = all.filter((c) => !suppressed.has(c.email) && !consent.get(c.email)!.ok);
  return {
    audience: a, requires_opt_in: optIn, count: all.length, suppressed: suppressed.size, no_consent: blocked.length, sendable: all.length - suppressed.size - blocked.length,
    by_source: { account: all.filter((c) => c.source === "account").length, request: all.filter((c) => c.source === "request").length, prospect: all.filter((c) => c.source === "prospect").length },
    // Outbound: why people are left out, by reason (src/gtm-outbound.ts BLOCK_TEXT).
    blocked: Object.fromEntries([...all.reduce((m, c) => { const d = consent.get(c.email)!; if (!d.ok && !suppressed.has(c.email)) m.set(d.reason, (m.get(d.reason) ?? 0) + 1); return m; }, new Map<string, number>())]),
    sample: all.slice(0, 10).map((c) => {
      const d = consent.get(c.email)!;
      return { ...c, suppressed: suppressed.has(c.email), consent: d.ok ? d.basis : d.reason };
    }),
  };
}

/**
 * Add people to a campaign (new addresses; with re-entry, people whose last round ended at least `reentryDays` ago
 * start a new round). Suppressed ones are recorded as such and never sent; people without the consent this campaign
 * needs are not added at all (counted). The only INSERT of an email address in GTM besides a reply.
 */
async function admit(c: CampaignRow, people: Candidate[], o: { delayDays: number; eventId?: number | null; reentryDays?: number | null } ): Promise<{ added: number; no_consent: number }> {
  const [suppressed, consent] = await Promise.all([suppressedSet(people.map((p) => p.email)), consentFor(people, requiresOptIn(c), c)]);
  // Customers could not be checked (Clerk did not answer): nobody joins now; the next pass tries again.
  if (people.some((p) => p.source === "prospect" && (consent.get(p.email) as { reason?: string }).reason === "member_check"))
    throw new AdminError("Customers could not be checked (Clerk did not answer): outbound enrolment waits for the next pass", 503);
  // A prospect who may not get cold email is never added (not even as suppressed): their row would count as a sequence.
  const ok = people.filter((p) => (suppressed.has(p.email) && p.source !== "prospect") || consent.get(p.email)!.ok);
  const rows = ok.map((p) => {
    const d = consent.get(p.email)!;
    return { email: p.email, first_name: p.first_name, product: p.product, source: p.source, org_id: p.org_id, request_id: p.request_id, suppressed: suppressed.has(p.email),
      country: p.country, time_zone: validZone(p.time_zone) ? p.time_zone : null, basis: d.ok ? d.basis : null, prospect_id: p.prospect_id ?? null };
  });
  const db = await getDb();
  const added = rows.length ? await db.query<{ id: number; email: string; basis: string | null; round: number }>(
    `INSERT INTO gtm_campaign_recipients AS r (campaign_id, email, first_name, product, source, org_id, request_id, status, next_at, country, time_zone, consent_basis, entered_at, event_id, prospect_id)
     SELECT $1, x.email, x.first_name, x.product, x.source, x.org_id, x.request_id,
            CASE WHEN x.suppressed THEN 'suppressed' ELSE 'pending' END, CASE WHEN x.suppressed THEN NULL ELSE now() + make_interval(secs => $3::float8 * 86400) END,
            x.country, x.time_zone, x.basis, now(), $4, x.prospect_id
       FROM jsonb_to_recordset($2::jsonb) AS x(email text, first_name text, product text, source text, org_id int, request_id int, suppressed boolean, country text, time_zone text, basis text, prospect_id bigint)
     ON CONFLICT (campaign_id, email) DO UPDATE SET round = r.round + 1, status = excluded.status, next_step = 0, next_at = excluded.next_at, entered_at = now(),
            event_id = excluded.event_id, replied_at = NULL, first_name = excluded.first_name, product = excluded.product, country = coalesce(excluded.country, r.country),
            time_zone = coalesce(excluded.time_zone, r.time_zone), consent_basis = excluded.consent_basis
       WHERE $5::int IS NOT NULL AND r.status IN ('done', 'failed') AND coalesce(r.entered_at, r.added_at) < now() - make_interval(days => coalesce($5::int, 0))
     RETURNING r.id, r.email, r.consent_basis AS basis, r.round`,
    [c.id, JSON.stringify(rows), o.delayDays, o.eventId ?? null, o.reentryDays ?? null]) : [];
  // An existing customer (an account's member, never a requester) written to under legitimate interest: recorded once
  // (never over an opt-in or a withdrawal).
  const customer = (e: string) => rows.find((x) => x.email === e)?.source === "account";
  const have = await consentOf(added.filter((r) => r.basis === "legitimate_interest" && customer(r.email)).map((r) => r.email));
  for (const r of added.filter((x) => x.basis === "legitimate_interest" && customer(x.email) && !have.has(x.email)))
    await recordConsent(r.email, "legitimate_interest", { source: "account", campaign_id: c.id, country: rows.find((x) => x.email === r.email)?.country ?? null });
  // A prospect first written to: the ledger records their lawful basis (source prospect), by hash.
  const prospect = (e: string) => rows.find((x) => x.email === e)?.source === "prospect";
  for (const r of added.filter((x) => prospect(x.email) && Number(x.round) === 0))
    await (await getDb()).query("INSERT INTO email_consent_ledger (email_hash, basis, source, country, campaign_id) VALUES ($1, $2, 'prospect', $3, $4)",
      [mail.hashAddress(r.email), r.basis ?? "legitimate_interest", rows.find((x) => x.email === r.email)?.country ?? null, c.id]);
  return { added: added.length, no_consent: people.length - ok.length };
}

/**
 * Launch and resume enrol at once, under the tick's lease (one enrolment or tick at a time everywhere, so two
 * campaigns can never both take the same prospect). The lease busy, or the enrolment failing (Clerk down for the
 * customer check): the next tick enrols instead (enrolled_at stays empty).
 */
async function enrollUnderLease(id: number) {
  await serial(async () => {
    if (!(await takeLease(120).catch(() => false))) return;
    try { await enroll(id); } catch (e) { console.error(`campaign ${id}: enrolment left to the next tick: ${(e as Error).message}`); }
    finally { await releaseLease(); }
  });
}

/** Add everyone the audience matches now (new addresses only). Not for a triggered campaign: events enrol those. */
export async function enroll(id: number): Promise<number> {
  const c = await campaignById(id);
  if (c.trigger) return 0;
  const people = await resolveAudience(c.audience);
  const r = await admit(c, people, { delayDays: c.steps[0]?.delay_days ?? 0 });
  await (await getDb()).query("UPDATE gtm_campaigns SET enrolled_at = now() WHERE id = $1", [c.id]);
  return r.added;
}

// ---------- events: triggered campaigns ----------

interface DueEvent { campaign_id: number; event_id: number; type: EventType; org_id: number | null; request_id: number | null; data: Record<string, unknown> }

/**
 * The people an event is about, under the campaign's UTM and plan filters: a request's requester; an account's active
 * members, else (nobody has joined yet: right after the account is made) whoever asked for it. Those requesters stay
 * requesters (source "request", their own country) for the consent decision: never an existing customer's
 * legitimate interest.
 */
async function eventPeople(c: CampaignRow, e: DueEvent, data: { journeys: Journey[]; requests: RequestRow[] }): Promise<Candidate[]> {
  const a = c.audience;
  const filters = { ...parseAudience({}), utm_source: a.utm_source, utm_medium: a.utm_medium, utm_campaign: a.utm_campaign, plans: a.plans };
  if (REQUEST_EVENTS.includes(e.type)) {
    const r = data.requests.find((q) => q.id === Number(e.request_id));
    return r ? resolveAudience({ ...filters, include: "requests" }, { journeys: data.journeys, requests: [r] }) : [];
  }
  const j = data.journeys.find((x) => Number(x.org.id) === Number(e.org_id));
  if (!j) return [];
  const people = await resolveAudience({ ...filters, include: "accounts", accounts: [j.org.slug] }, { journeys: [j], requests: data.requests });
  if (people.length || (filters.plans.length && !filters.plans.includes(j.plan))) return people;
  return resolveAudience({ ...filters, include: "requests", request_status: ["approved"] }, { journeys: [j], requests: data.requests.filter((q) => q.org_id === Number(j.org.id)) });
}

/**
 * One pass over triggered campaigns: the detector (when one waits for a derived event, at most every
 * CAMPAIGN_SIGNAL_INTERVAL_MIN, 10, minutes), each campaign's new matching events queued with the trigger's delay, and
 * the queued ones that are due enrolled. Idempotent: (campaign, event) is one row. An event counts for a campaign only
 * when what it reports happened after the campaign launched: its time, and for a detected change its lower bound
 * (data.after: the detector's previous look, so a change that may predate the launch never counts), and for "stuck"
 * the stage was entered at most 2 days before the launch. An event first seen more than CAMPAIGN_EVENT_MAX_AGE_HOURS
 * (24) after it happened (the campaign was paused, or no tick ran) is skipped. Stops at `stopAt`.
 */
async function processEvents(only: number | null, stopAt = Infinity): Promise<{ events: number; enrolled: number }> {
  const db = await getDb();
  const cs = (await db.query<CampaignRow>(`SELECT ${COLS} FROM gtm_campaigns WHERE status = 'running' AND trigger IS NOT NULL AND ($1::bigint IS NULL OR id = $1)`, [only]))
    .map(shapeRow).filter((c) => c.trigger);
  if (!cs.length) return { events: 0, enrolled: 0 };
  let data: { journeys: Journey[]; requests: RequestRow[] } | null = null;
  // Loaded once a pass; again for an event recorded after the load (its people may be newer than that snapshot).
  let loadedThrough = 0; // the newest event id when the journeys were loaded
  const load = async (stripe = false, eventId = 0) => {
    if (!data || eventId > loadedThrough) {
      loadedThrough = Number((await db.query<{ n: number }>("SELECT coalesce(max(id), 0) AS n FROM gtm_events"))[0].n);
      data = await journeys({ stripe });
    }
    return data;
  };
  let events = 0;
  const detected = cs.filter((c) => DETECTED.includes(c.trigger!.type));
  if (detected.length) {
    const mins = Math.max(0, Math.round(Number(process.env.CAMPAIGN_SIGNAL_INTERVAL_MIN ?? 10)));
    const [{ fresh }] = await db.query<{ fresh: boolean }>("SELECT coalesce(max(seen_at) > now() - make_interval(mins => $1::int), false) AS fresh FROM gtm_org_signals", [mins]);
    // The detector loads every account's journey (Clerk included): not with under a minute left.
    if ((!fresh || only != null) && stopAt - Date.now() > 60_000) {
      const payments = detected.some((c) => c.trigger!.type === "first_payment");
      const d = await load(payments);
      // Stuck: only accounts that entered the stage at most 2 days before the earliest campaign asking launched.
      const stuck = new Map<string, { stage: string; days: number; since: number }>();
      for (const c of detected.filter((x) => x.trigger!.type === "stuck")) {
        const k = `${c.trigger!.stage}:${c.trigger!.days}`, since = new Date(c.launched_at ?? Date.now()).getTime() - 2 * 86_400_000;
        stuck.set(k, { stage: c.trigger!.stage!, days: c.trigger!.days!, since: Math.min(since, stuck.get(k)?.since ?? Infinity) });
      }
      events += await detectSignals(d.journeys, { stuck: [...stuck.values()], payments });
    }
  }
  const maxAgeHours = clampInt(Number(process.env.CAMPAIGN_EVENT_MAX_AGE_HOURS ?? 24), 1, 24 * 90, 24);
  for (const c of cs) {
    const t = c.trigger!;
    await db.query(
      `INSERT INTO gtm_event_enrolments (campaign_id, event_id, due_at)
       SELECT $1, e.id, e.at + make_interval(secs => $3::float8 * 3600) FROM gtm_events e
        WHERE e.type = $2 AND e.at >= coalesce($4::timestamptz, now()) - interval '1 minute'
          AND coalesce((e.data->>'after')::timestamptz, e.at) >= coalesce($4::timestamptz, now()) - interval '1 minute'
          AND (e.type <> 'stuck' OR (e.data->>'reached_at')::timestamptz >= coalesce($4::timestamptz, now()) - interval '2 days')
          AND e.at >= now() - make_interval(hours => $8::int)
          AND ($5::text IS NULL OR e.data->>'stage' = $5) AND ($6::int IS NULL OR (e.data->>'days')::int = $6)
          AND ($7 = '' OR strpos(lower(e.data->>'reason'), lower($7)) > 0)
       ON CONFLICT (campaign_id, event_id) DO NOTHING`,
      [c.id, t.type, t.delay_hours, c.launched_at, t.stage, t.days, t.attention, maxAgeHours]);
  }
  // Queued ones too: one whose delay ran out more than the max age ago (the campaign was paused meanwhile, or no tick
  // ran) is skipped, not enrolled late.
  const due = await db.query<DueEvent & { stale: boolean }>(
    `SELECT ee.campaign_id, ee.event_id, e.type, e.org_id, e.request_id, e.data, ee.due_at < now() - make_interval(hours => $2::int) AS stale
       FROM gtm_event_enrolments ee JOIN gtm_events e ON e.id = ee.event_id JOIN gtm_campaigns c ON c.id = ee.campaign_id
      WHERE ee.processed_at IS NULL AND ee.due_at <= now() AND c.status = 'running' AND ($1::bigint IS NULL OR c.id = $1) ORDER BY ee.due_at LIMIT 500`, [only, maxAgeHours]);
  let enrolled = 0;
  for (const e of due) {
    if (Date.now() >= stopAt) break;
    const c = cs.find((x) => x.id === Number(e.campaign_id));
    if (!c) continue;
    if (e.stale) {
      await db.query("UPDATE gtm_event_enrolments SET processed_at = now(), note = $3 WHERE campaign_id = $1 AND event_id = $2",
        [e.campaign_id, e.event_id, `Skipped: due more than ${maxAgeHours} hours ago (paused, or no tick ran)`]);
      continue;
    }
    try {
      const people = await eventPeople(c, e, await load(false, Number(e.event_id)));
      const r = people.length ? await admit(c, people, { delayDays: c.steps[0]?.delay_days ?? 0, eventId: Number(e.event_id), reentryDays: c.trigger!.reentry === "every" ? c.trigger!.reentry_days : null })
        : { added: 0, no_consent: 0 };
      const note = r.added ? null : !people.length ? "Nobody to write to" : r.no_consent === people.length ? "No consent on record" : "Already enrolled (re-entry rule)";
      await db.query("UPDATE gtm_event_enrolments SET processed_at = now(), enrolled = $3, note = $4 WHERE campaign_id = $1 AND event_id = $2", [e.campaign_id, e.event_id, r.added, note]);
      enrolled += r.added;
    } catch (err) { console.error(`campaign ${c.id}: event ${e.event_id} not enrolled yet: ${(err as Error).message}`); }
  }
  return { events, enrolled };
}

// ---------- unsubscribe links ----------

/**
 * HMAC key for unsubscribe links (and reply addresses): its own random secret, generated once into the key vault
 * (provider email_unsubscribe, label "generated"). Rotating the vault master key re-encrypts it and leaves the value
 * alone, so a link keeps working for as long as its recipient row exists, years later included. Cached in the process.
 */
const UNSUB_LABEL = "generated";
let unsubKey: Promise<Buffer> | null = null;
export function unsubscribeKey(): Promise<Buffer> {
  return (unsubKey ??= (async () => {
    // Replicas race on the first one: addCredentialIfAbsent never overwrites, so they all end up with the winner's.
    await addCredentialIfAbsent(UNSUBSCRIBE_PROVIDER, randomBytes(32).toString("base64url"), { label: UNSUB_LABEL });
    return Buffer.from((await useCredential(UNSUBSCRIBE_PROVIDER, { label: UNSUB_LABEL })).secret);
  })().catch((e) => { unsubKey = null; throw new AdminError(`Unsubscribe links need the key vault: ${(e as Error).message}`, 503); }));
}
const sigOf = (key: Buffer, id: number) => createHmac("sha256", key).update(`unsubscribe:${id}`).digest("base64url").slice(0, 32);
export async function unsubscribeToken(recipientId: number): Promise<string> {
  return `${recipientId}.${sigOf(await unsubscribeKey(), recipientId)}`;
}
export async function verifyUnsubscribe(token: unknown): Promise<number | null> {
  const m = /^(\d{1,15})\.([A-Za-z0-9_-]{32})$/.exec(String(token ?? ""));
  if (!m) return null;
  const key = await unsubscribeKey().catch(() => null);
  if (!key) return null;
  const id = Number(m[1]), got = Buffer.from(m[2]), want = Buffer.from(sigOf(key, id));
  return want.length === got.length && timingSafeEqual(want, got) ? id : null;
}
export const unsubscribeUrl = (token: string) => `${mail.siteUrl()}/api/email/unsubscribe?t=${encodeURIComponent(token)}`;
const TEST_TOKEN = "test";

/** Unsubscribe whoever the token names: from this campaign, and from every campaign after (suppression, consent withdrawn). */
export async function unsubscribe(token: unknown): Promise<{ ok: boolean; test?: boolean }> {
  if (token === TEST_TOKEN) return { ok: true, test: true };
  const id = await verifyUnsubscribe(token);
  if (id == null) return { ok: false };
  const db = await getDb();
  const [r] = await db.query<{ email: string; campaign_id: number }>(
    `UPDATE gtm_campaign_recipients SET status = CASE WHEN status IN ('bounced') THEN status ELSE 'unsubscribed' END,
            unsubscribed_at = coalesce(unsubscribed_at, now()), next_at = NULL WHERE id = $1 RETURNING email, campaign_id`, [id]);
  if (!r) return { ok: true }; // the campaign was deleted: nothing left to stop
  await suppress(r.email, "unsubscribed", Number(r.campaign_id));
  await recordConsent(r.email, "withdrawn", { source: "unsubscribe", campaign_id: Number(r.campaign_id) });
  await outbound.onUnsubscribe(id).catch((e) => console.error(`unsubscribe: prospect not updated: ${(e as Error).message}`));
  capture({ distinctId: "octillion:email" }, "campaign_unsubscribed", { campaign_id: Number(r.campaign_id) });
  return { ok: true };
}

/**
 * Suppress an address. A stronger reason replaces a weaker one (a bounce, a complaint or a manual entry over an
 * unsubscribe; a complaint over a bounce), never the reverse: a confirmed opt-in lifts only "unsubscribed", so a later
 * bounce or complaint must not stay recorded as an unsubscribe.
 */
export const SUPPRESSION_RANK_SQL = (r: string) => `CASE ${r} WHEN 'unsubscribed' THEN 1 WHEN 'bounced' THEN 2 WHEN 'manual' THEN 2 WHEN 'complained' THEN 3 ELSE 0 END`;
async function suppress(email: string, reason: "unsubscribed" | "bounced" | "complained" | "manual", campaignId: number | null) {
  await (await getDb()).query(
    `INSERT INTO email_suppressions (email_hash, reason, campaign_id) VALUES ($1, $2, $3)
     ON CONFLICT (email_hash) DO UPDATE SET reason = excluded.reason, campaign_id = coalesce(excluded.campaign_id, email_suppressions.campaign_id)
       WHERE ${SUPPRESSION_RANK_SQL("excluded.reason")} > ${SUPPRESSION_RANK_SQL("email_suppressions.reason")}`,
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

/** The footer: why they get it, the unsubscribe link, and the sender's postal address when one is set (CAN-SPAM). */
const footer = (source: "account" | "request" | "prospect", url: string, postal: string) => source === "prospect" ? outbound.outboundFooter(url, postal) :
  `\n\n--\nYou're getting this because you ${source === "account" ? "have an Octillion account" : "asked for access to Octillion"}. Unsubscribe: ${url}${postal ? `\n${postal}` : ""}`;
const unsubHeaders = (url: string) => ({ "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clampInt = (n: number, min: number, max: number, def: number) => (Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), min), max) : def);
/** The sender's postal address (Campaigns settings), or "" when none is set. */
export const postalAddress = async () => { await freshSettings(); return settingText("EMAIL_POSTAL_ADDRESS").trim(); };
export const POSTAL_HINT = "No postal address set; US marketing law (CAN-SPAM) expects one";

/** A test of one step to an address typed in: rendered for the first person the audience matches (or placeholders). */
export async function testSend(actor: string, id: number, body: { to?: unknown; step?: unknown; subject?: unknown; body?: unknown; variant?: unknown }) {
  const to = String(body.to ?? "").trim().toLowerCase();
  if (!mail.isEmail(to)) throw new AdminError("Enter a valid email address");
  const c = await campaignById(id);
  const i = body.step == null || body.step === "" ? 0 : Number(body.step);
  // Unsaved edits from the editor can be tried before saving.
  const [step] = body.subject !== undefined || body.body !== undefined ? parseSteps([{ subject: body.subject, body: body.body }]) : [c.steps[i]];
  if (!step) throw new AdminError(`This campaign has no email ${i + 1}`);
  const k = body.variant ? VARIANT_LETTERS.indexOf(String(body.variant).toUpperCase() as (typeof VARIANT_LETTERS)[number]) : -1;
  const words = k >= 0 && step.variants?.[k] ? step.variants[k] : step;
  // Outbound: from its sender identity, text only unless it tracks opens, exactly as the real thing.
  if (isOutbound(c)) { const why = await outbound.identityProblem(c.sender_identity_id); if (why) throw new AdminError(why); }
  const ident = isOutbound(c) ? await outbound.identityById(c.sender_identity_id) : null;
  // A test from the identity counts toward its daily cap like any other email from it.
  const testKey = `campaign-test:${c.id}:${randomUUID()}`;
  if (ident && !(await outbound.reserveTest(ident, testKey, to, c.id))) throw new AdminError(`${ident.from_address} has sent its ${outbound.warmupCap(ident)} for today (warm-up cap): try tomorrow`, 409);
  const sample = (await resolveAudience(c.audience).catch(() => []))[0];
  const url = unsubscribeUrl(TEST_TOKEN), postal = await postalAddress();
  const src = sample?.source ?? (ident ? "prospect" : "account");
  const r = await mail.send({ kind: ident ? "outbound_test" : "campaign_test", to, idempotencyKey: testKey,
    meta: { campaign_id: c.id, step: i, variant: k >= 0 ? VARIANT_LETTERS[k] : null, ...(ident ? { identity_id: ident.id } : {}) },
    subject: `[Test] ${render(words.subject, sample ?? {})}`, text: render(words.body, sample ?? {}) + footer(src, url, postal),
    ...(tracksOpens(c) ? { html: renderHtml(words.body + footer(src, url, postal), sample ?? {}) } : { textOnly: true }), from: ident ? outbound.senderOf(ident) : undefined,
    headers: unsubHeaders(url), tags: [{ name: "campaign", value: String(c.id) }] });
  log(actor, "campaign.test", null, { campaign_id: c.id, step: i, status: r.status, to_domain: mail.domainOf(to) });
  return { ...r, sample: sample ? { first_name: sample.first_name, product: sample.product, source: sample.source } : null, warnings: postal ? [] : [ident ? outbound.POSTAL_WARNING : POSTAL_HINT] };
}

interface Due {
  id: number; campaign_id: number; email: string; first_name: string | null; product: string | null; source: "account" | "request" | "prospect"; next_step: number; round: number;
  time_zone: string | null; country: string | null; prospect_id: number | null;
}
export interface TickResult {
  started: number; enrolled: number; sent: number; failed: number; suppressed: number; finished: number;
  /** Left for a later tick: the campaign was paused or ended mid-batch, or Resend asked us to slow down. */
  deferred: number;
  /** Due outside the campaign's send window: moved to the next opening. */
  outside_window: number;
  /** Consent gone since enrolment (withdrawn, or the campaign now needs an opt-in): not sent. */
  no_consent: number;
  /** Resend may have them (see "uncertain sends" below): waiting for a replay, or parked for an owner. */
  uncertain: number; unknown: number;
  /** Triggered campaigns: new events the detector found, and Resend requests made. */
  events: number; requests: number;
  /** Outbound: over its sender identity's warm-up cap today (waits for tomorrow), and stopped by the cold-email rules. */
  capped: number; blocked: number;
  skipped?: string; busy?: boolean; error?: string;
}
const emptyTick = (): TickResult => ({ started: 0, enrolled: 0, sent: 0, failed: 0, suppressed: 0, finished: 0, deferred: 0, outside_window: 0, no_consent: 0,
  uncertain: 0, unknown: 0, events: 0, requests: 0, capped: 0, blocked: 0 });
export interface TickOptions {
  /** Wall-clock time (ms) the caller must be done by: the Vercel cron passes its request start plus the function's 300 s. */
  deadline?: number;
}
/** No new Resend request starts with less than this left before the deadline: one batch (30 s) plus its replay (30 s). */
const DEADLINE_RESERVE_MS = 70_000;

/** OCTILLION_CAMPAIGNS=off stops every campaign send: the VM ticker, the Vercel cron's tick and "send now". */
export const campaignsEnabled = () => (process.env.OCTILLION_CAMPAIGNS ?? "on").toLowerCase() !== "off";

// One campaign tick at a time across every process (VM replicas, Vercel functions, "send now", event kicks): a lease
// row in autoscaler_lease (name "campaigns"), so Resend is throttled globally, not per process.
const LEASE = "campaigns";
const holder = `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;
async function takeLease(secs: number): Promise<boolean> {
  const [r] = await (await getDb()).query(
    `INSERT INTO autoscaler_lease (name, holder, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3::int))
     ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
       WHERE autoscaler_lease.holder = excluded.holder OR autoscaler_lease.expires_at < now() RETURNING name`, [LEASE, holder, secs]);
  return !!r;
}
const releaseLease = async () => { await (await getDb()).query("DELETE FROM autoscaler_lease WHERE name = $1 AND holder = $2", [LEASE, holder]).catch(() => {}); };

// In this process, ticks run one after another (the lease's holder is the process, so it cannot tell two of ours
// apart): a kick or the cron during "send now" waits for it instead of racing it.
let local: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = local.then(fn, fn);
  local = p.catch(() => {});
  return p;
}
let inflight: Promise<TickResult> | null = null;
/** One pass: start scheduled campaigns, enroll, send what is due (rate-limited), finish what is done. Never throws. */
export function campaignTick(o: TickOptions = {}): Promise<TickResult> {
  if (!campaignsEnabled()) return Promise.resolve({ ...emptyTick(), skipped: "Campaigns are off (OCTILLION_CAMPAIGNS=off)" });
  return (inflight ??= serial(() => runTick(null, o)).finally(() => { inflight = null; }));
}

/**
 * "Send now" for one campaign (the Activation nudge, the peek's button): the same tick, for this campaign only, and
 * what happened to *its* people: sent, suppressed, still waiting (another tick holds the lease, or a later email).
 */
export async function sendNow(actor: string, id: number) {
  const c = await campaignById(id);
  if (c.status !== "running") throw new AdminError(`Only a running campaign sends (this one is ${c.status})`, 409);
  const tick = campaignsEnabled() ? await serial(() => runTick(c.id)) : { ...emptyTick(), skipped: "Campaigns are off (OCTILLION_CAMPAIGNS=off)" };
  const m = (await metrics([c.id])).get(c.id)!;
  log(actor, "campaign.send_now", null, { campaign_id: c.id, sent: tick.sent, waiting: m.waiting });
  return { campaign_id: c.id, sent_now: tick.sent, sent: m.sent, suppressed: m.suppressed, waiting: m.waiting, failed: m.failed, outside_window: tick.outside_window,
    uncertain: m.uncertain, unknown: m.unknown, skipped: tick.skipped ?? null, busy: Boolean(tick.busy) };
}

/** Transient: Resend rate-limited, or email is switched off for now. Retried later, never counted as an attempt. */
const transient = (res: mail.EmailResult) =>
  (res.status === "failed" && /Resend answered 429/.test(res.error ?? "")) ||
  (res.status === "skipped" && !/No valid address|No subject/.test(res.error ?? ""));
const idempotencyKeyOf = (cid: number, rid: number, step: number, round: number) => `campaign:${cid}:${rid}:${step}${round ? `:${round}` : ""}`;

interface Prepared { r: Due; c: CampaignRow; claim: { id: number; attempts: number }; variant: string | null; email: mail.Email }
/** What a send keeps from just before its request until it is sent: the email as it goes, without the address (that stays on the recipient). */
const payloadOf = (m: mail.Email) => ({ kind: m.kind, idempotencyKey: m.idempotencyKey, subject: m.subject, text: m.text, html: m.html, headers: m.headers, tags: m.tags,
  replyTo: m.replyTo, from: m.from, meta: m.meta, textOnly: m.textOnly });
/** An uncertain request is replayed this long after its first try: 5 minutes, 1, 6 and 20 hours (Resend keeps a key 24). */
const REPLAY_AFTER_MIN = [5, 60, 360, 1200];
const REPLAY_DUE_SQL = `s.uncertain_at + make_interval(mins => (ARRAY[${REPLAY_AFTER_MIN.join(", ")}])[least(s.replays, ${REPLAY_AFTER_MIN.length - 1}) + 1]) <= now()`;

/**
 * Uncertain sends. A request whose outcome is unknown (no answer, a 5xx, a 409, a function killed mid-request) may
 * have gone out. Such an email is only ever sent again as the very same request: the stored request key and the
 * stored payload sent verbatim (never re-rendered, so an edited step or a picked A/B winner can never change a body
 * under a key Resend has seen), the same emails in the same order, so Resend answers from its record of the first
 * request and nobody gets two. It is tried at once, then at REPLAY_AFTER_MIN (5 min, 1 h, 6 h, 20 h); a member who has
 * since replied, unsubscribed, been suppressed or lost consent is left out (parked) and the rest go as the same request
 * key with fewer emails (Resend refuses a known key with another body, 409, so that can never duplicate). Past 23 hours
 * or the last replay, and for a batch answer missing an email's id, the send is parked as `unknown`: never sent again
 * unless an owner chooses Resend (a new key: the one deliberate duplicate risk).
 */
async function markUncertain(p: { sendId: number; recipientId: number }, res: mail.EmailResult, requestKey: string | null, email: mail.Email) {
  const db = await getDb();
  const replayable = requestKey != null && res.pos != null && !/no id for this email|without an id/.test(res.error ?? "");
  // The payload stays either way: a replay needs it, and so does an owner's Resend of an unknown one.
  await db.query(
    `UPDATE gtm_campaign_sends SET status = $2, error = $3, batch_key = coalesce($4, batch_key), batch_pos = $5, payload = $6::jsonb, uncertain_at = coalesce(uncertain_at, now())
      WHERE id = $1`, [p.sendId, replayable ? "uncertain" : "unknown", (res.error ?? "Outcome unknown").slice(0, 500), requestKey, res.pos ?? null, JSON.stringify(payloadOf(email))]);
  // Out of the queue until it is resolved: the claim refuses an uncertain or unknown send anyway.
  await db.query("UPDATE gtm_campaign_recipients SET next_at = NULL WHERE id = $1", [p.recipientId]);
  return replayable;
}

/**
 * A tick that died mid-request left its sends `sending` with a request key: Resend may have them. Their key, place
 * and payload were stored before the request, so they are uncertain (replayed as that request); without a payload
 * (an older send), unknown.
 */
async function sweepStuck() {
  const db = await getDb();
  const stuck = await db.query<{ recipient_id: number; status: string }>(
    `UPDATE gtm_campaign_sends SET status = CASE WHEN payload IS NOT NULL AND batch_pos IS NOT NULL THEN 'uncertain' ELSE 'unknown' END,
            error = 'Outcome unknown: the tick sending it stopped mid-request', uncertain_at = coalesce(uncertain_at, now())
      WHERE status = 'sending' AND batch_key IS NOT NULL AND at < now() - interval '10 minutes' RETURNING recipient_id, status`);
  if (stuck.length) await db.query("UPDATE gtm_campaign_recipients SET next_at = NULL WHERE id = ANY($1::bigint[])", [stuck.map((s) => Number(s.recipient_id))]);
  return { uncertain: stuck.filter((s) => s.status === "uncertain").length, unknown: stuck.filter((s) => s.status === "unknown").length };
}

/**
 * May this prospect's cold email go (again) now? The outbound rules (src/gtm-outbound.ts: customer by the member
 * index and a fresh look at their own accounts, status, withdrawal, another sequence, the EU / EEA / UK / CH rule with
 * the campaign's allow_restricted; never mayEnrol's opt-in rule, which is for lifecycle email) and a valid identity.
 * The reason it may not, or null. member_check (Clerk did not answer) means "not now", never "never".
 */
async function prospectGate(r: { email: string; prospect_id: number | null; recipient_id: number }, c: CampaignRow, idx: MemberIndex): Promise<string | null> {
  const why = (await outbound.outboundBlocks([{ email: r.email, prospect_id: r.prospect_id, recipient_id: r.recipient_id }], c, idx)).get(r.email);
  if (why) return why;
  const fresh = await freshMemberCheck(r.email, idx);
  if (fresh) return fresh;
  return (await outbound.identityProblem(c.sender_identity_id)) ? "identity" : null;
}

type ReplayRow = { id: number; campaign_id: number; recipient_id: number; step: number; round: number; batch_key: string; batch_pos: number; payload: Record<string, unknown>;
  expired: boolean; due: boolean; replays: number; email: string; source: "account" | "request" | "prospect"; country: string | null; rstatus: string; cstatus: string | null; suppressed: boolean;
  prospect_id: number | null };

/** Replay uncertain requests that are due, each as the very same request (see above). Returns whether one was still uncertain. */
async function replayUncertain(only: number | null, stopAt: number, gap: number, timeoutMs: () => number, out: TickResult): Promise<{ uncertain: boolean }> {
  const db = await getDb();
  const rows = await db.query<ReplayRow>(
    `SELECT s.id, s.campaign_id, s.recipient_id, s.step, s.round, s.batch_key, s.batch_pos, s.payload, s.uncertain_at < now() - interval '23 hours' AS expired,
            ${REPLAY_DUE_SQL} AS due, s.replays, r.email, r.source, r.country, r.status AS rstatus, c.status AS cstatus, r.prospect_id,
            EXISTS (SELECT 1 FROM email_suppressions x WHERE x.email_hash = encode(sha256(convert_to(lower(trim(r.email)), 'UTF8')), 'hex')) AS suppressed
       FROM gtm_campaign_sends s JOIN gtm_campaign_recipients r ON r.id = s.recipient_id LEFT JOIN gtm_campaigns c ON c.id = s.campaign_id
      WHERE s.status = 'uncertain' AND ($1::bigint IS NULL OR s.batch_key IN (SELECT batch_key FROM gtm_campaign_sends WHERE status = 'uncertain' AND campaign_id = $1))
      ORDER BY s.batch_key, s.batch_pos`, [only]);
  const groups = new Map<string, ReplayRow[]>();
  for (const r of rows) groups.set(r.batch_key, [...(groups.get(r.batch_key) ?? []), r]);
  const park = async (g: ReplayRow[], why: string) => {
    if (!g.length) return;
    await db.query("UPDATE gtm_campaign_sends SET status = 'unknown', error = $2 WHERE id = ANY($1::bigint[]) AND status = 'uncertain'", [g.map((r) => Number(r.id)), why]);
    out.unknown += g.length;
  };
  const consent = await consentOf(rows.map((r) => r.email));
  const campaigns = new Map<number, CampaignRow | null>();
  // Prospects: the outbound rules, against every account's people (only looked up when a prospect is replayed).
  let idx: Promise<MemberIndex> | null = null;
  let first = true, stillUncertain = false;
  for (const [key, g] of groups) {
    if (Date.now() >= stopAt) break;
    if (g.some((r) => r.expired || Number(r.replays) >= REPLAY_AFTER_MIN.length)) { await park(g, "Outcome unknown: could not be confirmed within Resend's idempotency window"); continue; }
    if (!g[0].due) continue;
    // A paused campaign waits: its people may still get this email when it resumes. A finished one still replays
    // (the email was already on its way); a deleted one took its sends with it.
    if (g.some((r) => r.cstatus === "paused")) continue;
    // Each member as they are now: still waiting, not suppressed, consent as this campaign needs it.
    const ok: ReplayRow[] = [], gone: ReplayRow[] = [];
    let wait = false;
    for (const r of g) {
      const cid = Number(r.campaign_id);
      if (!campaigns.has(cid)) campaigns.set(cid, await campaignById(cid).catch(() => null));
      const c = campaigns.get(cid);
      let fine = !!c && ["running", "done"].includes(c.status) && ["pending", "active"].includes(r.rstatus) && !r.suppressed;
      if (fine && r.source === "prospect") {
        const why = await prospectGate({ email: r.email, prospect_id: r.prospect_id, recipient_id: Number(r.recipient_id) }, c!, await (idx ??= memberIndex()));
        if (why === "member_check") wait = true; // Clerk did not answer: this request waits for its next turn, unchanged
        fine = !why;
      } else if (fine) fine = mayEnrol({ email: r.email, source: r.source as "account" | "request", country: r.country }, requiresOptIn(c!), consent.get(r.email)).ok;
      (fine ? ok : gone).push(r);
    }
    if (wait) continue;
    await park(gone, "Outcome unknown: not repeated, the person replied, unsubscribed, was suppressed, no longer has the consent this campaign needs, or may not get cold email now");
    if (!ok.length) continue;
    // The rest go as the same request key; with fewer emails their places are renumbered first (what a later replay repeats).
    if (ok.length < g.length)
      for (const [n, r] of ok.entries()) await db.query("UPDATE gtm_campaign_sends SET batch_pos = $2 WHERE id = $1", [r.id, n]);
    if (!first && gap) await sleep(gap);
    first = false;
    const ms = ok.map((r) => ({ ...(r.payload as unknown as mail.Email), to: r.email }));
    const sent = await mail.sendBatch(ms, { key, exact: true, timeoutMs: timeoutMs() });
    out.requests++;
    let stop = false;
    for (const [n, r] of ok.entries()) {
      const res = sent.results[n];
      if (res?.status === "sent" || res?.status === "duplicate") {
        await db.query("UPDATE gtm_campaign_sends SET status = 'sent', provider_id = coalesce($2, provider_id), payload = NULL, error = NULL, at = now() WHERE id = $1",
          [r.id, res.provider_id ?? null]);
        const c = campaigns.get(Number(r.campaign_id));
        if (c) await advance({ id: Number(r.recipient_id), next_step: Number(r.step), round: Number(r.round) } as Due, c);
        out.sent++;
      } else if (res && (/Resend answered 429/.test(res.error ?? "") || res.status === "skipped")) {
        // Rate-limited, or emails switched off meanwhile: nothing was tried; still uncertain, for a later replay.
        stop = true;
      } else if (res?.uncertain) {
        await db.query("UPDATE gtm_campaign_sends SET replays = replays + 1, error = $2, at = now() WHERE id = $1", [r.id, (res.error ?? "").slice(0, 500)]);
        out.uncertain++;
        stillUncertain = true;
      } else await park([r], `Outcome unknown: the replay was refused (${(res?.error ?? res?.status ?? "no result").slice(0, 200)})`);
    }
    if (stop || stillUncertain) break; // Resend is not answering well: the other replays wait for their turn
  }
  return { uncertain: stillUncertain };
}

/**
 * An owner's "Resend" of a campaign's unknown sends: each goes again now, from its stored payload, under a new key (its
 * old one may already have delivered it; this is the one place an email may knowingly go twice). People who since
 * replied, unsubscribed, were suppressed or lost consent are left as they are. An older unknown send without a stored
 * payload goes back in the queue instead (rendered again, when the campaign runs).
 */
export async function resendUnknown(actor: string, id: number) {
  const c = await campaignById(id);
  const db = await getDb();
  const rows = await db.query<{ id: number; recipient_id: number; step: number; round: number; payload: Record<string, unknown> | null; email: string; rstatus: string;
    source: "account" | "request" | "prospect"; country: string | null; suppressed: boolean; prospect_id: number | null }>(
    `SELECT s.id, s.recipient_id, s.step, s.round, s.payload, r.email, r.status AS rstatus, r.source, r.country, r.prospect_id,
            EXISTS (SELECT 1 FROM email_suppressions x WHERE x.email_hash = encode(sha256(convert_to(lower(trim(r.email)), 'UTF8')), 'hex')) AS suppressed
       FROM gtm_campaign_sends s JOIN gtm_campaign_recipients r ON r.id = s.recipient_id WHERE s.campaign_id = $1 AND s.status = 'unknown' ORDER BY s.id`, [c.id]);
  const consent = await consentOf(rows.map((r) => r.email));
  let resent = 0, requeued = 0, skipped = 0, uncertain = 0;
  const reasons: Record<string, number> = {};
  const skip = (why: string) => { skipped++; reasons[why] = (reasons[why] ?? 0) + 1; };
  // Prospects: every account's people read from Clerk now (no cache), the identity, and what it may still send today.
  const prospects = rows.some((r) => r.source === "prospect");
  const idx = prospects ? await memberIndex({ maxAgeMs: 0 }) : null;
  const ident = prospects ? await outbound.identityById(c.sender_identity_id) : null;
  let left = ident ? await outbound.leftToday(ident) : 0;
  for (const r of rows) {
    if (!["pending", "active"].includes(r.rstatus)) { skip("not_waiting"); continue; }
    if (r.suppressed) { skip("suppressed"); continue; }
    if (r.source === "prospect") {
      const why = await prospectGate({ email: r.email, prospect_id: r.prospect_id, recipient_id: Number(r.recipient_id) }, c, idx!);
      if (why) { skip(why); continue; }
      if (left <= 0) { skip("daily_cap"); continue; }
      left--;
    } else if (!mayEnrol({ email: r.email, source: r.source, country: r.country }, requiresOptIn(c), consent.get(r.email)).ok) { skip("no_consent"); continue; }
    if (!r.payload) {
      await db.query("UPDATE gtm_campaign_sends SET status = 'failed', batch_key = NULL, batch_pos = NULL, error = $2 WHERE id = $1", [r.id, `Resent by ${actor.slice(0, 80)}`]);
      await db.query("UPDATE email_log SET status = 'failed', error = 'Outcome unknown; resent by an owner' WHERE idempotency_key = $1 AND status IN ('sending', 'failed')",
        [idempotencyKeyOf(c.id, Number(r.recipient_id), Number(r.step), Number(r.round))]);
      await db.query("UPDATE gtm_campaign_recipients SET next_at = now() WHERE id = $1 AND status IN ('pending', 'active')", [r.recipient_id]);
      requeued++;
      continue;
    }
    const base = String(r.payload.idempotencyKey ?? idempotencyKeyOf(c.id, Number(r.recipient_id), Number(r.step), Number(r.round))).replace(/:resend:[\w-]+$/, "");
    const email = { ...(r.payload as unknown as mail.Email), to: r.email, idempotencyKey: `${base}:resend:${randomBytes(4).toString("hex")}` };
    // Recorded before the request, like any send: a crash now leaves it uncertain under the new key, not lost.
    await db.query("UPDATE gtm_campaign_sends SET status = 'sending', batch_key = $2, batch_pos = 0, payload = $3::jsonb, uncertain_at = NULL, replays = 0, at = now(), error = $4 WHERE id = $1",
      [r.id, email.idempotencyKey, JSON.stringify(payloadOf(email)), `Resent by ${actor.slice(0, 80)}`]);
    const [res] = (await mail.sendBatch([email], { key: email.idempotencyKey })).results;
    if (res?.status === "sent" || res?.status === "duplicate") {
      await db.query("UPDATE gtm_campaign_sends SET status = 'sent', provider_id = coalesce($2, provider_id), payload = NULL, at = now() WHERE id = $1", [r.id, res.provider_id ?? null]);
      await advance({ id: Number(r.recipient_id), next_step: Number(r.step), round: Number(r.round) } as Due, c);
      resent++;
    } else if (res?.uncertain) { await markUncertain({ sendId: Number(r.id), recipientId: Number(r.recipient_id) }, res, email.idempotencyKey, email); uncertain++; }
    else await db.query("UPDATE gtm_campaign_sends SET status = 'unknown', error = $2 WHERE id = $1", [r.id, `Resend refused: ${(res?.error ?? res?.status ?? "no result").slice(0, 300)}`]);
  }
  log(actor, "campaign.resend_unknown", null, { campaign_id: c.id, resent, requeued, skipped, uncertain, reasons });
  return { campaign_id: c.id, resent, requeued, skipped, skipped_by_reason: reasons, uncertain };
}

async function runTick(only: number | null, o: TickOptions = {}): Promise<TickResult> {
  const out = emptyTick();
  const t0 = Date.now();
  await freshSettings().catch(() => {});
  const cap = clampInt(settingNumber("CAMPAIGN_SENDS_PER_TICK"), 0, 20_000, 1000), size = clampInt(settingNumber("CAMPAIGN_BATCH_SIZE"), 1, mail.BATCH_MAX, 100);
  const gap = clampInt(settingNumber("CAMPAIGN_SEND_INTERVAL_MS"), 0, 10_000, 600), budget = clampInt(settingNumber("CAMPAIGN_TICK_SECONDS"), 10, 280, 180) * 1000;
  // No new request after stopAt: the tick's own budget, and the caller's deadline less one batch and its replay.
  const stopAt = Math.min(t0 + budget, o.deadline != null ? o.deadline - DEADLINE_RESERVE_MS : Infinity);
  // A request's timeout fits what is left before the deadline, with room for its one replay.
  const timeoutMs = () => (o.deadline == null ? 30_000 : Math.max(5_000, Math.min(30_000, Math.floor((o.deadline - Date.now() - 5_000) / 2))));
  const leaseSecs = Math.max(60, Math.ceil((stopAt - t0) / 1000)) + 120;
  try {
    if (!(await takeLease(leaseSecs))) return { ...out, busy: true, skipped: "Another campaign tick is sending right now" };
  } catch (e) { return { ...out, error: (e as Error).message }; }
  const db = await getDb();
  let due: Due[] = [];
  const done = new Set<number>();
  try {
    out.started = (await db.query(
      `UPDATE gtm_campaigns SET status = 'running', launched_at = coalesce(launched_at, now()), updated_at = now()
        WHERE status = 'scheduled' AND starts_at <= now() AND ($1::bigint IS NULL OR id = $1) RETURNING id`, [only])).length;
    // New ones enroll once; rolling ones re-check their audience at most every CAMPAIGN_ENROLL_INTERVAL_MIN (60) minutes.
    const enrollEvery = clampInt(Number(process.env.CAMPAIGN_ENROLL_INTERVAL_MIN ?? 60), 0, 7 * 24 * 60, 60);
    for (const { id } of await db.query<{ id: number }>(
      `SELECT id FROM gtm_campaigns WHERE status = 'running' AND trigger IS NULL AND ($2::bigint IS NULL OR id = $2)
          AND (enrolled_at IS NULL OR (rolling AND enrolled_at < now() - make_interval(mins => $1::int)))`, [enrollEvery, only])) {
      if (Date.now() >= stopAt) break;
      try { out.enrolled += await enroll(Number(id)); } catch (e) { console.error(`campaign ${id}: enrolment failed: ${(e as Error).message}`); }
    }
    try {
      const ev = await processEvents(only, stopAt);
      out.events = ev.events; out.enrolled += ev.enrolled;
    } catch (e) { console.error(`campaigns: events not processed: ${(e as Error).message}`); }
    const status = await mail.emailStatus();
    if (!status.enabled || !status.connected) {
      out.skipped = !status.connected ? "No Resend key in Key vault (or the provider is off)" : "Emails are off (Agent configuration, Send emails)";
      return out;
    }
    // Earlier requests whose outcome is unknown come first: a killed one becomes uncertain (or unknown without its
    // payload), an uncertain one is replayed exactly when its turn comes.
    const swept = await sweepStuck();
    out.uncertain += swept.uncertain; out.unknown += swept.unknown;
    const replay = Date.now() < stopAt ? await replayUncertain(only, stopAt, gap, timeoutMs, out) : { uncertain: false };
    // Outage back-off: while Resend's last answer to us was uncertain (in the last 30 minutes), new sends go one email
    // at a time as a probe, and stop at the first uncertain one; a clean answer lifts it. A replay still uncertain
    // in this tick means no new sends at all.
    const [{ recent }] = await db.query<{ recent: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM gtm_campaign_sends WHERE status = 'uncertain' AND at > now() - interval '30 minutes') AS recent");
    let probing = Boolean(recent);
    // Prospects and companies linked to the customers that exist already: once per database (src/gtm-crm.ts).
    await backfillOnce();
    const [postal, box, key] = await Promise.all([postalAddress(), replies.inbox(), unsubscribeKey()]);
    // Every account's people, for the customer check before each cold email: looked up once per tick.
    let members: Promise<MemberIndex> | null = null;
    const memberIdx = () => (members ??= memberIndex());
    const from = settingText("EMAIL_FROM"), defaultReplyTo = settingText("EMAIL_REPLY_TO").split(",").map((x) => x.trim()).filter(mail.isEmail);
    let attempted = 0, slowDown = replay.uncertain, calls = 0;
    // Outbound sender identities: each one's warm-up cap left today, counted over every campaign (src/gtm-outbound.ts).
    const slots = new Map<number, { i: outbound.Identity; left: number } | null>();
    const slotOf = async (id: number | null) => {
      if (id == null) return null;
      if (!slots.has(id)) {
        const i = (await outbound.identityProblem(id)) ? null : await outbound.identityById(id);
        slots.set(id, i ? { i, left: outbound.warmupCap(i) - ((await outbound.sentToday([id])).get(id) ?? 0) } : null);
      }
      return slots.get(id)!;
    };
    // Waves: lease up to ten batches' worth, send them batch by batch, and go again while the cap and the time allow.
    while (!slowDown && attempted < cap && Date.now() < stopAt) {
      const wave = await db.query<Due>(
        `UPDATE gtm_campaign_recipients r SET next_at = now() + interval '10 minutes'
          WHERE r.id IN (SELECT x.id FROM gtm_campaign_recipients x JOIN gtm_campaigns c ON c.id = x.campaign_id
                          WHERE c.status = 'running' AND x.status IN ('pending', 'active') AND x.next_at <= now() AND ($2::bigint IS NULL OR c.id = $2)
                          ORDER BY x.next_at, x.id LIMIT $1 FOR UPDATE OF x SKIP LOCKED)
          RETURNING r.id, r.campaign_id, r.email, r.first_name, r.product, r.source, r.next_step, r.round, r.time_zone, r.country, r.prospect_id`, [Math.min(size * 10, cap - attempted), only]);
      if (!wave.length) break;
      wave.sort((a, b) => Number(a.id) - Number(b.id));
      due.push(...wave);
      for (let w = 0; w < wave.length && !slowDown && attempted < cap; ) {
        if (Date.now() >= stopAt) break;
        // The pause between Resend requests comes before the next batch is filled, so a pause, an end or a reply in
        // the meantime is seen.
        if (calls && gap) await sleep(gap);
        const chunk: Prepared[] = [];
        // Fill one batch: each person checked against the campaign as it is now, the suppression list, consent (as
        // it is now: withdrawn since, or the campaign needing an opt-in), and the window.
        const slice = wave.slice(w, w + size * 2);
        const [suppressedNow, consentNow] = await Promise.all([suppressedSet(slice.map((r) => r.email)), consentOf(slice.map((r) => r.email))]);
        const campaigns = new Map<number, CampaignRow | null>();
        while (w < wave.length && chunk.length < (probing ? 1 : size) && attempted + chunk.length < cap) {
          const r = wave[w++];
          done.add(Number(r.id));
          try {
            const cid = Number(r.campaign_id);
            if (!campaigns.has(cid)) campaigns.set(cid, await campaignById(cid).catch(() => null));
            const c = campaigns.get(cid);
            if (!c) continue; // deleted: its recipients went with it
            // Paused, ended or deleted mid-batch stops here: back in the queue.
            if (c.status !== "running") { await release([Number(r.id)]); out.deferred++; continue; }
            const step = c.steps[r.next_step];
            if (!step) { await db.query("UPDATE gtm_campaign_recipients SET status = 'done', next_at = NULL WHERE id = $1 AND status IN ('pending', 'active')", [r.id]); continue; }
            if (suppressedNow.has(r.email)) {
              await db.query("UPDATE gtm_campaign_recipients SET status = 'suppressed', next_at = NULL WHERE id = $1", [r.id]);
              out.suppressed++;
              continue;
            }
            // A prospect's consent is the outbound rules' (their lawful basis, withdrawal), checked below.
            if (r.source !== "prospect" && !mayEnrol({ email: r.email, source: r.source, country: r.country }, requiresOptIn(c), consentNow.get(r.email)).ok) {
              await db.query("UPDATE gtm_campaign_recipients SET status = 'no_consent', next_at = NULL WHERE id = $1", [r.id]);
              out.no_consent++;
              continue;
            }
            // Outbound, decided per person (a prospect is always cold email, whatever the campaign says now): the
            // cold-email rules again (a reply elsewhere, a new customer, another sequence first), and a sender identity
            // fit to send; none, and nothing goes. Clerk not answering for the customer check: next time.
            let slot: { i: outbound.Identity; left: number } | null = null;
            if (r.source === "prospect") {
              const gate = await prospectGate({ email: r.email, prospect_id: r.prospect_id, recipient_id: Number(r.id) }, c, await memberIdx());
              // No valid identity: nothing goes (the slot below defers them); any other reason stops this person.
              const why = gate === "identity" ? null : gate;
              if (why === "member_check") { await db.query("UPDATE gtm_campaign_recipients SET next_at = now() + interval '15 minutes' WHERE id = $1", [r.id]); out.deferred++; continue; }
              if (why) {
                await db.query("UPDATE gtm_campaign_recipients SET status = 'suppressed', next_at = NULL WHERE id = $1", [r.id]);
                out.suppressed++; out.blocked++;
                continue;
              }
              slot = await slotOf(c.sender_identity_id);
              if (!slot) { await db.query("UPDATE gtm_campaign_recipients SET next_at = now() + interval '1 hour' WHERE id = $1", [r.id]); out.deferred++; continue; }
            }
            const zone = recipientZone(r.time_zone, r.country, c.send_window.time_zone);
            if (!windowOpen(c.send_window, new Date(), zone)) {
              await db.query("UPDATE gtm_campaign_recipients SET next_at = $2 WHERE id = $1", [r.id, nextOpening(c.send_window, new Date(), zone)]);
              out.outside_window++;
              continue;
            }
            // The identity's cap for today is spent (warm-up): looked at again in an hour (a new UTC day, or a raised cap).
            if (slot && slot.left <= 0) {
              await db.query("UPDATE gtm_campaign_recipients SET next_at = now() + interval '1 hour' WHERE id = $1", [r.id]);
              out.capped++;
              continue;
            }
            // Claimed once per person, round and email, and only while the campaign runs and the person still waits
            // (a reply or an unsubscribe a moment ago stops it). Taken again only after a certain failure, or when a
            // tick died before making its request (no request key yet); never while uncertain or unknown.
            const [claim] = await db.query<{ id: number; attempts: number }>(
              `INSERT INTO gtm_campaign_sends (campaign_id, recipient_id, step, round, status, identity_id)
               SELECT $1, $2, $3, $4, 'sending', $5 WHERE EXISTS (SELECT 1 FROM gtm_campaigns WHERE id = $1 AND status = 'running')
                 AND EXISTS (SELECT 1 FROM gtm_campaign_recipients WHERE id = $2 AND status IN ('pending', 'active'))
               ON CONFLICT (recipient_id, round, step) DO UPDATE SET status = 'sending', attempts = gtm_campaign_sends.attempts + 1, at = now(), error = NULL, identity_id = excluded.identity_id,
                 batch_key = NULL, batch_pos = NULL
                 WHERE gtm_campaign_sends.status = 'failed'
                    OR (gtm_campaign_sends.status = 'sending' AND gtm_campaign_sends.batch_key IS NULL AND gtm_campaign_sends.at < now() - interval '10 minutes')
               RETURNING id, attempts`, [c.id, r.id, r.next_step, r.round, slot?.i.id ?? null]);
            if (!claim) {
              // Already sent (a tick that stopped before moving on): move on now. Paused this instant: back in the queue.
              // Being sent elsewhere, uncertain or unknown: out of the queue until that is resolved.
              const [s] = await db.query<{ status: string }>("SELECT status FROM gtm_campaign_sends WHERE recipient_id = $1 AND round = $2 AND step = $3", [r.id, r.round, r.next_step]);
              if (s?.status === "sent") await advance(r, c);
              else if (!s) { await release([Number(r.id)]); out.deferred++; }
              else if (s.status === "uncertain" || s.status === "unknown") await db.query("UPDATE gtm_campaign_recipients SET next_at = NULL WHERE id = $1", [r.id]);
              continue;
            }
            if (slot) slot.left--;
            const v = pickVariant(step, c.id, r.next_step, Number(r.id));
            const url = unsubscribeUrl(await unsubscribeToken(Number(r.id)));
            // Sender and reply-to fixed now, so a replay of this email is byte for byte the same request. Outbound: from
            // the identity, plain text only unless the campaign tracks opens (no HTML, so no pixel).
            const replyTo = box ? [await replies.replyAddress(Number(r.id), key, box)] : defaultReplyTo;
            chunk.push({ r, c, claim, variant: v.letter, email: {
              kind: slot ? "outbound" : "campaign", to: r.email, idempotencyKey: idempotencyKeyOf(c.id, Number(r.id), r.next_step, r.round), from: slot ? outbound.senderOf(slot.i) : from,
              meta: { campaign_id: c.id, step: r.next_step, ...(v.letter ? { variant: v.letter } : {}), ...(r.round ? { round: r.round } : {}) },
              subject: render(v.subject, r), text: render(v.body, r) + footer(r.source, url, postal),
              ...(tracksOpens(c) ? { html: renderHtml(v.body + footer(r.source, url, postal), r) } : { textOnly: true }),
              headers: unsubHeaders(url), tags: [{ name: "campaign", value: String(c.id) }], replyTo,
            } });
          } catch (e) {
            // One person's problem (e.g. the campaign deleted between two queries) never stops the batch.
            console.error(`campaign send to recipient ${r.id} skipped: ${(e as Error).message}`);
            await release([Number(r.id)]).catch(() => {});
          }
        }
        if (!chunk.length) continue;
        attempted += chunk.length;
        // The request key, each email's place and its payload are recorded on every claim before the request is made:
        // a tick killed after this point leaves sends that sweepStuck makes uncertain (replayed as this request,
        // payload verbatim), never sent again as a new one.
        const requestKey = chunk.length === 1 ? chunk[0].email.idempotencyKey : mail.batchKeyOf(chunk.map((p) => p.email.idempotencyKey));
        await db.query(
          `UPDATE gtm_campaign_sends s SET batch_key = $2, batch_pos = v.pos, payload = v.payload, variant = v.variant
             FROM jsonb_to_recordset($1::jsonb) AS v(id bigint, pos int, payload jsonb, variant text) WHERE s.id = v.id`,
          [JSON.stringify(chunk.map((p, n) => ({ id: Number(p.claim.id), pos: n, payload: payloadOf(p.email), variant: p.variant }))), requestKey]);
        const ms = chunk.map((p) => p.email);
        let sent = await mail.sendBatch(ms, { key: requestKey, timeoutMs: timeoutMs() });
        calls++;
        // The whole request uncertain (no answer, a 5xx, a 409): once more at once, as the very same request.
        const inRequest = chunk.map((p, n) => ({ p, n, res: sent.results[n] })).filter((x) => x.res?.pos != null).sort((a, b) => a.res!.pos! - b.res!.pos!);
        const wholeUncertain = sent.request_key != null && inRequest.length > 0 && inRequest.every((x) => x.res!.uncertain && !/no id for this email|without an id/.test(x.res!.error ?? ""));
        if (wholeUncertain && (o.deadline == null || Date.now() + DEADLINE_RESERVE_MS / 2 < o.deadline)) {
          await sleep(Math.min(2000, gap || 2000));
          const again = await mail.sendBatch(inRequest.map((x) => x.p.email), { key: sent.request_key!, exact: true, timeoutMs: timeoutMs() });
          calls++;
          const results = [...sent.results];
          // Positions are the original request's either way (the replay is that request again).
          for (const [k, x] of inRequest.entries()) results[x.n] = { ...(again.results[k] ?? { status: "failed" as const, uncertain: true }), pos: x.res!.pos };
          sent = { results, request_key: sent.request_key };
        }
        let retryMs = 0;
        for (const [n, p] of chunk.entries()) {
          const res = sent.results[n] ?? { status: "failed" as const, error: "no result", uncertain: true, pos: null };
          if (res.status === "sent" || res.status === "duplicate") {
            await db.query("UPDATE gtm_campaign_sends SET status = 'sent', provider_id = coalesce($2, provider_id), variant = $3, batch_key = coalesce($4, batch_key), payload = NULL, at = now() WHERE id = $1",
              [p.claim.id, res.provider_id ?? null, p.variant, sent.request_key]);
            await advance(p.r, p.c);
            if (p.r.prospect_id != null) await outbound.onSent(Number(p.r.prospect_id), p.c.id);
            out.sent++;
          } else if (res.uncertain) {
            await db.query("UPDATE gtm_campaign_sends SET variant = $2 WHERE id = $1", [p.claim.id, p.variant]);
            if (await markUncertain({ sendId: Number(p.claim.id), recipientId: Number(p.r.id) }, res, sent.request_key, p.email)) out.uncertain++;
            else out.unknown++;
          } else if (transient(res)) {
            // Refused before anything went out: undo the attempt. A 429 retries after Resend's retry-after; the rest in a quarter of an hour.
            const r429 = /Resend answered 429/.test(res.error ?? "");
            if (r429) retryMs = Math.max(retryMs, res.retry_after_ms ?? 1000);
            await db.query("UPDATE gtm_campaign_sends SET status = 'failed', attempts = greatest(attempts - 1, 0), error = $2 WHERE id = $1", [p.claim.id, (res.error ?? res.status).slice(0, 500)]);
            await db.query(`UPDATE gtm_campaign_recipients SET next_at = now() + make_interval(secs => $2::float8) WHERE id = $1`, [p.r.id, r429 ? (res.retry_after_ms ?? 1000) / 1000 : 900]);
            out.deferred++;
          } else {
            await db.query("UPDATE gtm_campaign_sends SET status = 'failed', error = $2 WHERE id = $1", [p.claim.id, (res.error ?? res.status).slice(0, 500)]);
            // No valid address, or a third refusal: give up on this person; else try again in half an hour.
            const giveUp = res.status === "skipped" || Number(p.claim.attempts) >= 3;
            await db.query(`UPDATE gtm_campaign_recipients SET ${giveUp ? "status = 'failed', next_at = NULL" : "next_at = now() + interval '30 minutes'"} WHERE id = $1`, [p.r.id]);
            out.failed++;
          }
        }
        // Resend did not answer this request well (after its immediate replay): no new batches this tick, and the
        // next ticks probe one email at a time until an answer is clean. A clean answer ends a probe.
        if (sent.results.some((x) => x?.uncertain)) { slowDown = true; break; }
        if (probing && sent.results.some((x) => x?.status === "sent")) probing = false;
        else if (probing) break;
        if (retryMs) {
          // Rate-limited: wait what Resend asked when the time allows (and go on), else stop this tick here.
          if (Date.now() + retryMs < stopAt) { await sleep(retryMs); await takeLease(leaseSecs).catch(() => false); break; }
          slowDown = true;
        }
      }
      // Whatever this wave leased and did not get to goes straight back in the queue before the next one.
      const left = due.map((r) => Number(r.id)).filter((id) => !done.has(id));
      if (left.length) await release(left).catch(() => {});
      due = [];
      // Keep the lease for as long as the tick runs.
      if (!(await takeLease(leaseSecs).catch(() => false))) break;
    }
    out.requests += calls;
    out.finished = (await db.query(
      `UPDATE gtm_campaigns c SET status = 'done', finished_at = now(), updated_at = now()
        WHERE c.status = 'running' AND NOT c.rolling AND c.trigger IS NULL AND c.enrolled_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM gtm_campaign_recipients r WHERE r.campaign_id = c.id AND r.status IN ('pending', 'active')
                            -- Someone whose email is uncertain or unknown is not waiting for the campaign: it can finish
                            -- (the peek still shows them; replays and an owner's Resend still work on a done campaign).
                            AND NOT EXISTS (SELECT 1 FROM gtm_campaign_sends s WHERE s.recipient_id = r.id AND s.round = r.round AND s.step = r.next_step
                                              AND s.status IN ('uncertain', 'unknown'))) RETURNING id`)).length;
    if (out.sent || out.failed || out.deferred || out.uncertain || out.unknown)
      console.error(`campaigns: sent ${out.sent} in ${out.requests} request(s), failed ${out.failed}, deferred ${out.deferred}, uncertain ${out.uncertain}, unknown ${out.unknown}, outside window ${out.outside_window}, suppressed ${out.suppressed}, no consent ${out.no_consent}`);
    return out;
  } catch (e) {
    return { ...out, error: (e as Error).message };
  } finally {
    // Whatever this tick leased and did not get to goes straight back in the queue.
    const left = due.map((r) => Number(r.id)).filter((id) => !done.has(id));
    if (left.length) await release(left).catch(() => {});
    await releaseLease();
  }
}

/** Give leased recipients back: due now (they were due when leased). */
async function release(ids: number[]) {
  await (await getDb()).query("UPDATE gtm_campaign_recipients SET next_at = now() WHERE id = ANY($1::bigint[]) AND status IN ('pending', 'active')", [ids]);
}

/** After step n went out: the next one is due its delay later, or the person is done. Only from step n (no double move). */
async function advance(r: Due, c: CampaignRow) {
  const next = r.next_step + 1, last = next >= c.steps.length;
  await (await getDb()).query(
    `UPDATE gtm_campaign_recipients SET next_step = $2, first_sent_at = coalesce(first_sent_at, now()), last_sent_at = now(),
            status = CASE WHEN status IN ('pending', 'active') THEN $3 ELSE status END,
            next_at = CASE WHEN $3 = 'done' OR status NOT IN ('pending', 'active') THEN NULL ELSE now() + make_interval(days => $4::int) END
      WHERE id = $1 AND next_step = $5 AND round = $6`, [r.id, next, last ? "done" : "active", last ? 0 : c.steps[next].delay_days, r.next_step, r.round]);
}

/** On a VM (not Vercel, whose cron calls the tick): a tick every 5 minutes. */
let ticker: NodeJS.Timeout | null = null;
export function startCampaignTicker() {
  if (ticker || process.env.VERCEL || !campaignsEnabled()) return;
  ticker = setInterval(() => void campaignTick(), 5 * 60_000);
  ticker.unref();
}

// ---------- Resend webhooks: delivered, bounced, complained, opened, clicked, received ----------

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

/**
 * POST /api/webhooks/resend: verified, then recorded on the campaign send it is about (others are acknowledged and
 * ignored). email.received (Resend's inbound email) is a reply: src/gtm-replies.ts.
 */
export async function resendWebhook(raw: string, h: { id?: string; timestamp?: string; signature?: string }): Promise<{ status: number; body: Record<string, unknown> }> {
  const secret = await useCredential(WEBHOOK_PROVIDER).then((c) => c.secret, () => null);
  if (!secret) return { status: 503, body: { error: "Resend webhooks are not set up: add the signing secret (resend_webhook) on Key vault" } };
  if (!verifySvix(secret, raw, h)) return { status: 401, body: { error: "Invalid signature" } };
  let ev: { type?: string; created_at?: string; data?: { email_id?: string; bounce?: { type?: string } } & replies.InboundEvent };
  try { ev = JSON.parse(raw); } catch { return { status: 400, body: { error: "Not JSON" } }; }
  if (ev.type === "email.received") return replies.receiveInbound(ev.data ?? {}, await unsubscribeKey());
  const col = EVENT_COLUMN[ev.type ?? ""], pid = ev.data?.email_id;
  if (!col || !pid) return { status: 200, body: { ok: true, ignored: true } };
  const at = ev.created_at && !Number.isNaN(Date.parse(ev.created_at)) ? new Date(ev.created_at) : new Date();
  const db = await getDb();
  const [s] = await db.query<{ recipient_id: number; campaign_id: number }>(
    `UPDATE gtm_campaign_sends SET ${col} = coalesce(${col}, $2) WHERE provider_id = $1 RETURNING recipient_id, campaign_id`, [pid, at]);
  if (!s) return { status: 200, body: { ok: true, matched: false } };
  // Suppress on a complaint or a Permanent bounce. An Undetermined bounce suppresses only once the address has bounced
  // twice (in any campaign); a Transient one is only recorded.
  const bounceType = String(ev.data?.bounce?.type ?? "");
  let hard = ev.type === "email.complained" || (ev.type === "email.bounced" && /^permanent$/i.test(bounceType));
  if (ev.type === "email.bounced" && !hard && !/transient/i.test(bounceType)) {
    const [{ n }] = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM gtm_campaign_sends s JOIN gtm_campaign_recipients r ON r.id = s.recipient_id
        WHERE s.bounced_at IS NOT NULL AND r.email = (SELECT email FROM gtm_campaign_recipients WHERE id = $1)`, [s.recipient_id]);
    hard = Number(n) >= 2;
  }
  if (hard) {
    const [r] = await db.query<{ email: string }>(
      `UPDATE gtm_campaign_recipients SET status = CASE WHEN status = 'unsubscribed' THEN status ELSE $2 END, next_at = NULL WHERE id = $1 RETURNING email`,
      [s.recipient_id, ev.type === "email.bounced" ? "bounced" : "unsubscribed"]);
    if (r) {
      await suppress(r.email, ev.type === "email.bounced" ? "bounced" : "complained", Number(s.campaign_id));
      // A complaint is the strongest "stop": consent withdrawn too.
      if (ev.type === "email.complained") await recordConsent(r.email, "withdrawn", { source: "complaint", campaign_id: Number(s.campaign_id) });
      // A prospect: bad_email on a hard bounce, not interested on a complaint (src/gtm-outbound.ts).
      await outbound.onBounce(Number(s.recipient_id), ev.type === "email.bounced" ? "bounced" : "complained").catch((e) => console.error(`webhook: prospect not updated: ${(e as Error).message}`));
    }
  }
  return { status: 200, body: { ok: true, matched: true } };
}

// ---------- reading: the list and one campaign ----------

type Metrics = { recipients: number; suppressed: number; unsubscribed: number; failed: number; waiting: number; reached: number; replied: number; no_consent: number; uncertain: number; unknown: number;
  sent: number; delivered: number; bounced: number; complained: number; opened: number; clicked: number; replies_open: number };
async function metrics(ids: number[]): Promise<Map<number, Metrics>> {
  const db = await getDb();
  const [rs, ss, ys] = ids.length ? await Promise.all([
    db.query<Record<string, unknown>>(
      `SELECT campaign_id, count(*) AS recipients, count(*) FILTER (WHERE status = 'suppressed') AS suppressed, count(*) FILTER (WHERE status = 'unsubscribed') AS unsubscribed,
              count(*) FILTER (WHERE status = 'failed') AS failed, count(*) FILTER (WHERE status IN ('pending', 'active')) AS waiting,
              count(*) FILTER (WHERE first_sent_at IS NOT NULL) AS reached, count(*) FILTER (WHERE replied_at IS NOT NULL) AS replied, count(*) FILTER (WHERE status = 'no_consent') AS no_consent
         FROM gtm_campaign_recipients WHERE campaign_id = ANY($1::bigint[]) GROUP BY campaign_id`, [ids]),
    db.query<Record<string, unknown>>(
      `SELECT campaign_id, count(*) FILTER (WHERE status = 'sent') AS sent, count(*) FILTER (WHERE delivered_at IS NOT NULL) AS delivered,
              count(*) FILTER (WHERE bounced_at IS NOT NULL) AS bounced, count(*) FILTER (WHERE complained_at IS NOT NULL) AS complained,
              count(DISTINCT recipient_id) FILTER (WHERE opened_at IS NOT NULL) AS opened, count(DISTINCT recipient_id) FILTER (WHERE clicked_at IS NOT NULL) AS clicked,
              count(*) FILTER (WHERE status = 'uncertain') AS uncertain, count(*) FILTER (WHERE status = 'unknown') AS unknown
         FROM gtm_campaign_sends WHERE campaign_id = ANY($1::bigint[]) GROUP BY campaign_id`, [ids]),
    db.query<Record<string, unknown>>(
      `SELECT campaign_id, count(*) FILTER (WHERE kind = 'reply' AND handled_at IS NULL) AS replies_open FROM gtm_replies WHERE campaign_id = ANY($1::bigint[]) GROUP BY campaign_id`, [ids]),
  ]) : [[], [], []];
  const zero: Metrics = { recipients: 0, suppressed: 0, unsubscribed: 0, failed: 0, waiting: 0, reached: 0, replied: 0, no_consent: 0, uncertain: 0, unknown: 0, sent: 0, delivered: 0, bounced: 0, complained: 0, opened: 0, clicked: 0, replies_open: 0 };
  const out = new Map(ids.map((id) => [id, { ...zero }]));
  for (const r of [...rs, ...ss, ...ys]) {
    const m = out.get(Number(r.campaign_id));
    if (m) for (const [k, v] of Object.entries(r)) if (k !== "campaign_id") (m as Record<string, number>)[k] = Number(v);
  }
  return out;
}

interface RecipientRow { id: number; campaign_id: number; email: string; first_name: string | null; product: string | null; source: string; org_id: number | null; request_id: number | null;
  status: string; next_step: number; next_at: Date | null; first_sent_at: Date | null; last_sent_at: Date | null; unsubscribed_at: Date | null; replied_at: Date | null;
  round: number; time_zone: string | null; country: string | null; consent_basis: string | null; prospect_id?: number | null }

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

// ---------- A/B: per-variant numbers and a two-proportion z-test ----------

/** The standard normal CDF (Abramowitz and Stegun 7.1.26; error under 1.5e-7). */
const phi = (z: number) => {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
};
/**
 * Two-proportion z-test of b against a (x successes of n): z, the two-sided p, and whether the samples are too small to
 * read (fewer than 30 sends in either, or fewer than 5 successes or failures expected in either at the pooled rate).
 */
export function zTest(a: { x: number; n: number }, b: { x: number; n: number }) {
  if (!a.n || !b.n) return { z: null, p: null, significant: false, small: true };
  const pool = (a.x + b.x) / (a.n + b.n);
  const small = a.n < 30 || b.n < 30 || [a.n, b.n].some((n) => n * pool < 5 || n * (1 - pool) < 5);
  const se = Math.sqrt(pool * (1 - pool) * (1 / a.n + 1 / b.n));
  if (!se) return { z: 0, p: 1, significant: false, small };
  const z = (b.x / b.n - a.x / a.n) / se, p = 2 * (1 - phi(Math.abs(z)));
  return { z: Math.round(z * 100) / 100, p: Math.round(p * 10_000) / 10_000, significant: !small && p < 0.05, small };
}

const shape = (c: CampaignRow, m: Metrics | undefined) => ({
  id: Number(c.id), name: c.name, status: c.status, audience: c.audience, steps: c.steps, rolling: c.rolling, conversion_days: c.conversion_days,
  starts_at: c.starts_at, owner: c.owner, owner_user_id: c.owner_user_id, created_at: c.created_at, updated_at: c.updated_at,
  launched_at: c.launched_at, enrolled_at: c.enrolled_at, finished_at: c.finished_at, metrics: m,
  trigger: c.trigger, send_window: c.send_window, requires_opt_in: c.requires_opt_in, requires_opt_in_effective: requiresOptIn(c), count_auto_replies: c.count_auto_replies,
  outbound: isOutbound(c), sender_identity_id: c.sender_identity_id, track_opens: c.track_opens, track_opens_effective: tracksOpens(c), allow_restricted: c.allow_restricted,
});

/** Settings the editor shows next to a campaign: the postal address hint, the replies inbox, the trigger choices. */
async function sendingSetup() {
  const [postal, box] = await Promise.all([postalAddress(), replies.inbox()]);
  return { postal_address_set: Boolean(postal), postal_hint: postal ? null : POSTAL_HINT, replies_inbox: box ? `${box.local}@${box.domain}` : null,
    // Outbound: never required to send (no address is the default), but said plainly on every outbound campaign.
    outbound_postal_warning: postal ? null : outbound.POSTAL_WARNING };
}

export async function listCampaigns() {
  const db = await getDb();
  const rows = (await db.query<CampaignRow>(`SELECT ${COLS} FROM gtm_campaigns ORDER BY created_at DESC, id DESC`)).map(shapeRow);
  const m = await metrics(rows.map((c) => c.id));
  const sent = rows.filter((c) => (m.get(c.id)?.reached ?? 0) > 0);
  // Conversions need the accounts' journeys: only when something went out.
  const data = sent.length ? await journeys().catch(() => null) : null;
  const recips = data && sent.length ? await db.query<RecipientRow>(
    "SELECT id, campaign_id, email, org_id, first_sent_at FROM gtm_campaign_recipients WHERE campaign_id = ANY($1::bigint[]) AND first_sent_at IS NOT NULL", [sent.map((c) => c.id)]) : [];
  const status = await mail.emailStatus();
  return {
    email: { enabled: status.enabled, connected: status.connected, from: status.from }, setup: await sendingSetup(),
    variables: VARIABLES, stages: STAGES.map((s) => ({ id: s.id, label: s.label })), trigger_types: EVENT_TYPES,
    campaigns: rows.map((c) => ({ ...shape(c, m.get(c.id)),
      conversions: data ? conversions(recips.filter((r) => Number(r.campaign_id) === c.id), c.conversion_days, data).totals : null })),
  };
}

/** One campaign. `replies`: include what people replied (personal data: the campaigns permission only). */
export async function campaignDetail(id: number, o: { replies?: boolean } = {}) {
  const c = await campaignById(id);
  const db = await getDb();
  const [m, recipients, steps, data, variantRows, replyRows, eventRows] = await Promise.all([
    metrics([c.id]),
    db.query<RecipientRow>(
      `SELECT id, campaign_id, email, first_name, product, source, org_id, request_id, status, next_step, next_at, first_sent_at, last_sent_at, unsubscribed_at, replied_at,
              round, time_zone, country, consent_basis, prospect_id
         FROM gtm_campaign_recipients WHERE campaign_id = $1 ORDER BY id LIMIT 2000`, [c.id]),
    db.query<Record<string, unknown>>(
      `SELECT step, count(*) FILTER (WHERE status = 'sent') AS sent, count(*) FILTER (WHERE status = 'failed') AS failed, count(*) FILTER (WHERE delivered_at IS NOT NULL) AS delivered,
              count(*) FILTER (WHERE bounced_at IS NOT NULL) AS bounced, count(*) FILTER (WHERE opened_at IS NOT NULL) AS opened, count(*) FILTER (WHERE clicked_at IS NOT NULL) AS clicked
         FROM gtm_campaign_sends WHERE campaign_id = $1 GROUP BY step ORDER BY step`, [c.id]),
    journeys().catch(() => null),
    // Per step and variant: each send, whether it was opened / clicked, and whether a person replied to it.
    db.query<{ step: number; variant: string; recipient_id: number; opened: boolean; clicked: boolean; replied: boolean }>(
      `SELECT s.step, s.variant, s.recipient_id, s.opened_at IS NOT NULL AS opened, s.clicked_at IS NOT NULL AS clicked,
              EXISTS (SELECT 1 FROM gtm_replies y WHERE y.send_id = s.id AND y.kind = 'reply') AS replied
         FROM gtm_campaign_sends s WHERE s.campaign_id = $1 AND s.status = 'sent' AND s.variant IS NOT NULL`, [c.id]),
    o.replies === false ? null : replies.listReplies({ campaign_id: c.id, limit: 50 }),
    db.query<Record<string, unknown>>(
      `SELECT count(*) AS matched, count(*) FILTER (WHERE processed_at IS NULL) AS queued, coalesce(sum(enrolled), 0) AS enrolled,
              count(*) FILTER (WHERE processed_at IS NOT NULL AND enrolled = 0) AS skipped FROM gtm_event_enrolments WHERE campaign_id = $1`, [c.id]),
  ]);
  const sends = await db.query<{ recipient_id: number; delivered: boolean; bounced: boolean; opened: boolean; clicked: boolean }>(
    `SELECT recipient_id, bool_or(delivered_at IS NOT NULL) AS delivered, bool_or(bounced_at IS NOT NULL) AS bounced, bool_or(opened_at IS NOT NULL) AS opened,
            bool_or(clicked_at IS NOT NULL) AS clicked FROM gtm_campaign_sends WHERE campaign_id = $1 GROUP BY recipient_id`, [c.id]);
  const sendBy = new Map(sends.map((s) => [Number(s.recipient_id), s]));
  const conv = data ? conversions(recipients, c.conversion_days, data) : null;
  const slugOf = new Map((data?.journeys ?? []).map((j) => [Number(j.org.id), { slug: j.org.slug, name: j.org.name }]));
  const converted = (rid: number) => { const x = conv?.per.get(rid); return !!x && (x.requested || x.activated || x.paid); };
  return {
    campaign: shape(c, m.get(c.id)), setup: await sendingSetup(),
    conversions: conv?.totals ?? null,
    events: eventRows[0] ? Object.fromEntries(Object.entries(eventRows[0]).map(([k, v]) => [k, Number(v)])) : null,
    steps: c.steps.map((s, i) => {
      const x = steps.find((r) => Number(r.step) === i);
      // Variant A is the control each other variant is tested against, on reply rate and on conversion rate.
      const vs = (s.variants ?? []).map((v, k) => {
        const letter = VARIANT_LETTERS[k], rows = variantRows.filter((r) => Number(r.step) === i && r.variant === letter);
        return { letter, subject: v.subject, weight: v.weight, sent: rows.length, opened: rows.filter((r) => r.opened).length, clicked: rows.filter((r) => r.clicked).length,
          replied: rows.filter((r) => r.replied).length, converted: rows.filter((r) => converted(Number(r.recipient_id))).length };
      });
      const variants = vs.map((v, k) => ({ ...v,
        reply_test: k ? zTest({ x: vs[0].replied, n: vs[0].sent }, { x: v.replied, n: v.sent }) : null,
        conversion_test: k ? zTest({ x: vs[0].converted, n: vs[0].sent }, { x: v.converted, n: v.sent }) : null }));
      return { ...s, index: i, sent: Number(x?.sent ?? 0), failed: Number(x?.failed ?? 0), delivered: Number(x?.delivered ?? 0), bounced: Number(x?.bounced ?? 0),
        opened: Number(x?.opened ?? 0), clicked: Number(x?.clicked ?? 0), variant_stats: variants };
    }),
    replies: replyRows ?? { inbox: null, counts: null, replies: [], hidden: true },
    recipients: recipients.map((r) => {
      const s = sendBy.get(Number(r.id)), cv = conv?.per.get(Number(r.id));
      return { id: Number(r.id), email: r.email, first_name: r.first_name, product: r.product, source: r.source, status: r.status, next_step: r.next_step, next_at: r.next_at,
        first_sent_at: r.first_sent_at, last_sent_at: r.last_sent_at, unsubscribed_at: r.unsubscribed_at, replied_at: r.replied_at, round: r.round,
        time_zone: recipientZone(r.time_zone, r.country, c.send_window.time_zone), country: r.country, consent_basis: r.consent_basis, prospect_id: r.prospect_id == null ? null : Number(r.prospect_id),
        account: r.org_id != null ? slugOf.get(Number(r.org_id)) ?? null : null,
        delivered: !!s?.delivered, bounced: !!s?.bounced, opened: !!s?.opened, clicked: !!s?.clicked,
        requested: !!cv?.requested, activated: !!cv?.activated, paid: !!cv?.paid };
    }),
  };
}
