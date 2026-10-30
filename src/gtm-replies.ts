/**
 * GTM › Replies: a person answering a campaign email stops their sequence (src/campaigns.ts) and lands in an inbox.
 *
 *   address    with "Replies inbox" set (EMAIL_INBOUND_ADDRESS, e.g. replies@reply.example.com, a domain receiving
 *              in Resend), every campaign email's Reply-To is replies+r<recipient id>.<signature>@that domain. The
 *              signature is an HMAC with the unsubscribe links' vault key, so a reply maps to its recipient by the
 *              address it was sent to, never by trusting a From or In-Reply-To header
 *   receiving  Resend's inbound email (https://resend.com/docs/dashboard/receiving/introduction): it accepts mail
 *              for any address at a receiving domain and posts email.received to the same Svix-signed webhook as the
 *              delivery events (POST /api/webhooks/resend). That event has only metadata, so the text, HTML and
 *              headers are fetched by id (GET /emails/receiving/:id, src/email.ts receivedEmail)
 *   auto       an out-of-office or other automatic answer (Auto-Submitted other than "no", X-Autoreply,
 *              X-Autorespond, X-Auto-Response-Suppress, Precedence: auto_reply / bulk / junk / list, or a subject like
 *              "Automatic reply:" / "Out of office") is recorded as auto_reply and does not stop anything, unless the
 *              campaign counts auto-replies (count_auto_replies)
 *   bounces    a delivery report (multipart/report, mailer-daemon / postmaster, "Undeliverable") is ignored here:
 *              bounces come from Resend's email.bounced event
 *   race       a reply stops what has not been claimed yet. The send claim re-checks that the person is still waiting
 *              just before it is made, so the window is the time between that claim and Resend's answer for the batch
 *              it is in (a few seconds; at most the request timeout): a reply landing then cannot recall that email,
 *              and it may still arrive. Nothing after it is sent.
 *   stored     gtm_replies: the From address, subject, a snippet (quoted history cut) and the text (at most 20,000
 *              characters). With gtm_campaign_recipients, the only place GTM keeps an address.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { getDb } from "./db.js";
import * as mail from "./email.js";
import { AdminError, log } from "./admin.js";
import { freshSettings, settingText } from "./settings.js";
import { capture } from "./telemetry.js";

const BODY_MAX = 20_000, SNIPPET_MAX = 300;

// ---------- the per-recipient address ----------

/** The replies inbox, split: local part and domain; null when it is not set. */
export async function inbox(): Promise<{ local: string; domain: string } | null> {
  await freshSettings();
  const a = settingText("EMAIL_INBOUND_ADDRESS").trim().toLowerCase();
  if (!mail.isEmail(a)) return null;
  const [local, domain] = a.split("@");
  return { local: local.split("+")[0], domain };
}

const sigOf = (key: Buffer, id: number) => createHmac("sha256", key).update(`reply:${id}`).digest("hex").slice(0, 16);
/** replies+r<id>.<sig>@domain: lowercase hex, so a mail system that lowercases the address keeps it intact. */
export async function replyAddress(recipientId: number, key: Buffer, box: { local: string; domain: string }) {
  return `${box.local}+r${recipientId}.${sigOf(key, recipientId)}@${box.domain}`;
}

const TOKEN = /\+r(\d{1,15})\.([0-9a-f]{16})@/i;
/** The recipient a reply was addressed to, from any of the addresses it went to; null when none is ours. */
export function recipientOf(addresses: string[], key: Buffer): number | null {
  for (const a of addresses) {
    const m = TOKEN.exec(a);
    if (!m) continue;
    const id = Number(m[1]), got = Buffer.from(m[2].toLowerCase()), want = Buffer.from(sigOf(key, id));
    if (got.length === want.length && timingSafeEqual(got, want)) return id;
  }
  return null;
}

// ---------- what kind of mail it is ----------

const AUTO_SUBJECT = /^\s*(auto(matic|matische)?[ -]?(reply|response|antwort|svar)|out of (the )?office|ooo\b|away from (the )?office|on (vacation|holiday|leave)|abwesenheit|absence|r[ée]ponse automatique|respuesta autom[áa]tica|risposta automatica|automatisch antwoord|frånvaro|fravær|poza biurem|autoresponder)/i;
/** Why this looks like an automatic answer, or null for a person's reply. */
export function autoReason(headers: Record<string, string>, subject: string): string | null {
  const h = (k: string) => (headers[k] ?? "").trim().toLowerCase();
  if (h("auto-submitted") && h("auto-submitted") !== "no") return `Auto-Submitted: ${h("auto-submitted")}`;
  for (const k of ["x-autoreply", "x-autorespond", "x-autoresponder"]) if (h(k)) return `${k}: ${h(k)}`;
  if (/\b(oof|all|autoreply)\b/.test(h("x-auto-response-suppress"))) return `X-Auto-Response-Suppress: ${h("x-auto-response-suppress")}`;
  if (/^(auto_reply|bulk|junk|list)$/.test(h("precedence"))) return `Precedence: ${h("precedence")}`;
  if (h("x-autogenerated") === "reply") return "X-AutoGenerated: reply";
  if (AUTO_SUBJECT.test(subject.replace(/^\s*(re|aw|sv|fw|fwd)\s*:\s*/i, ""))) return "Subject reads as an automatic reply";
  return null;
}

/** A delivery status notification (a bounce): Resend's email.bounced handles those, not this. */
export function isBounceReport(headers: Record<string, string>, from: string, subject: string) {
  const ct = (headers["content-type"] ?? "").toLowerCase();
  return /multipart\/report/.test(ct) || /report-type=delivery-status/.test(ct) || /^(mailer-daemon|postmaster)@/i.test(addressOf(from))
    || /^(undeliverable|undelivered mail|delivery status notification|mail delivery (failed|subsystem)|returned mail|failure notice)/i.test(subject.trim());
}

/** The bare address out of "Name <a@b.c>" (lowercased). */
export const addressOf = (v: string) => (/<([^<>]+)>/.exec(v)?.[1] ?? v).trim().toLowerCase();

/** The text of the reply: the text part, else the HTML's words. */
export function textOf(text: string, html: string) {
  if (text.trim()) return text.replace(/\r\n/g, "\n");
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr)>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ");
}
/** The new words only: everything from the quoted history on ("On … wrote:", "> …", an original-message block) is cut. */
export function snippetOf(text: string) {
  const lines = text.split("\n"), keep: string[] = [];
  for (const l of lines) {
    if (/^\s*>/.test(l) || /^\s*On .{3,200} wrote:\s*$/i.test(l) || /^\s*-{2,}\s*(Original Message|Forwarded message)/i.test(l) || /^\s*(From|De|Von):\s.+/i.test(l) && keep.length) break;
    keep.push(l);
  }
  return keep.join(" ").replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX);
}

// ---------- receiving ----------

export interface InboundEvent { email_id?: string; from?: string; to?: string[] | string; cc?: string[] | string; received_for?: string[] | string; subject?: string }
type WebhookResult = { status: number; body: Record<string, unknown> };
const arr = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x));

/** email.received (from src/campaigns.ts resendWebhook, already verified): record the reply and stop the sequence. */
export async function receiveInbound(d: InboundEvent, key: Buffer): Promise<WebhookResult> {
  const pid = String(d.email_id ?? "");
  if (!pid) return { status: 200, body: { ok: true, ignored: "no email id" } };
  const rid = recipientOf([...arr(d.to), ...arr(d.received_for), ...arr(d.cc)], key);
  if (rid == null) return { status: 200, body: { ok: true, ignored: "not addressed to a campaign reply address" } };
  const db = await getDb();
  const [r] = await db.query<{ id: number; campaign_id: number; email: string; status: string; round: number; count_auto: boolean }>(
    `SELECT r.id, r.campaign_id, r.email, r.status, r.round, c.count_auto_replies AS count_auto
       FROM gtm_campaign_recipients r JOIN gtm_campaigns c ON c.id = r.campaign_id WHERE r.id = $1`, [rid]);
  if (!r) return { status: 200, body: { ok: true, ignored: "the campaign is gone" } };
  if ((await db.query("SELECT 1 FROM gtm_replies WHERE provider_id = $1", [pid])).length) return { status: 200, body: { ok: true, duplicate: true } };
  // Resend down: a 502, so Resend retries the webhook later.
  let full: Awaited<ReturnType<typeof mail.receivedEmail>>;
  try { full = await mail.receivedEmail(pid); }
  catch (e) { return { status: 502, body: { error: `Could not fetch the received email: ${(e as Error).message}` } }; }
  const from = full.from || String(d.from ?? ""), subject = (full.subject || String(d.subject ?? "")).replace(/[\r\n]+/g, " ").slice(0, 300);
  if (isBounceReport(full.headers, from, subject)) return { status: 200, body: { ok: true, ignored: "a delivery report (bounces come from email.bounced)" } };
  const auto = autoReason(full.headers, subject);
  const kind = auto && !r.count_auto ? "auto_reply" : "reply";
  const text = textOf(full.text, full.html);
  const fromAddr = addressOf(from);
  const [send] = await db.query<{ id: number }>(
    "SELECT id FROM gtm_campaign_sends WHERE recipient_id = $1 AND round = $2 AND status = 'sent' ORDER BY step DESC LIMIT 1", [r.id, r.round]);
  const [row] = await db.query<{ id: number }>(
    `INSERT INTO gtm_replies (campaign_id, recipient_id, send_id, provider_id, kind, auto_reason, from_email, from_matches, subject, snippet, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (provider_id) DO NOTHING RETURNING id`,
    [r.campaign_id, r.id, send?.id ?? null, pid, kind, auto, mail.isEmail(fromAddr) ? fromAddr : null, fromAddr === r.email, subject,
     snippetOf(text), text.slice(0, BODY_MAX)]);
  if (!row) return { status: 200, body: { ok: true, duplicate: true } };
  if (kind === "reply") {
    // A person answered: nothing more from this campaign for them (an unsubscribe or a bounce stays what it is).
    await db.query(
      `UPDATE gtm_campaign_recipients SET status = CASE WHEN status IN ('pending', 'active', 'done') THEN 'replied' ELSE status END,
              replied_at = coalesce(replied_at, now()), next_at = CASE WHEN status IN ('pending', 'active') THEN NULL ELSE next_at END WHERE id = $1`, [r.id]);
    capture({ distinctId: "octillion:email" }, "campaign_replied", { campaign_id: Number(r.campaign_id) });
    // An outbound prospect moves to replied (src/gtm-outbound.ts).
    await (await import("./gtm-outbound.js")).onReply(Number(r.id)).catch((e) => console.error(`reply: prospect not updated: ${(e as Error).message}`));
  }
  return { status: 200, body: { ok: true, matched: true, kind } };
}

// ---------- the inbox ----------

export interface ReplyRow {
  id: number; campaign_id: number; campaign_name: string; recipient_id: number; email: string; first_name: string | null; kind: string; auto_reason: string | null;
  from_email: string | null; from_matches: boolean; subject: string | null; snippet: string | null; body: string | null; received_at: Date; handled_at: Date | null; handled_by: string | null;
  step: number | null; variant: string | null;
}

/** Replies, newest first: one campaign's, or every campaign's. view: open (not handled), handled, auto (automatic answers), all. */
export async function listReplies(q: { campaign_id?: unknown; view?: unknown; limit?: unknown } = {}) {
  const cid = q.campaign_id == null || q.campaign_id === "" ? null : Number(q.campaign_id);
  if (cid != null && (!Number.isSafeInteger(cid) || cid <= 0)) throw new AdminError("Invalid campaign id");
  const view = ["open", "handled", "auto", "all"].includes(String(q.view)) ? String(q.view) : "all";
  const limit = Math.min(Math.max(Math.trunc(Number(q.limit) || 2000), 1), 5000);
  const rows = await (await getDb()).query<ReplyRow>(
    `SELECT y.id, y.campaign_id, c.name AS campaign_name, y.recipient_id, r.email, r.first_name, y.kind, y.auto_reason, y.from_email, y.from_matches, y.subject,
            y.snippet, y.body, y.received_at, y.handled_at, y.handled_by, s.step, s.variant
       FROM gtm_replies y JOIN gtm_campaigns c ON c.id = y.campaign_id JOIN gtm_campaign_recipients r ON r.id = y.recipient_id
       LEFT JOIN gtm_campaign_sends s ON s.id = y.send_id
      WHERE ($1::bigint IS NULL OR y.campaign_id = $1)
        AND ($2 = 'all' OR ($2 = 'open' AND y.handled_at IS NULL AND y.kind = 'reply') OR ($2 = 'handled' AND y.handled_at IS NOT NULL) OR ($2 = 'auto' AND y.kind = 'auto_reply'))
      ORDER BY y.received_at DESC, y.id DESC LIMIT $3`, [cid, view, limit]);
  const [counts] = await (await getDb()).query<{ open: number; handled: number; auto: number; total: number }>(
    `SELECT count(*) FILTER (WHERE handled_at IS NULL AND kind = 'reply')::int AS open, count(*) FILTER (WHERE handled_at IS NOT NULL)::int AS handled,
            count(*) FILTER (WHERE kind = 'auto_reply')::int AS auto, count(*)::int AS total FROM gtm_replies WHERE ($1::bigint IS NULL OR campaign_id = $1)`, [cid]);
  const box = await inbox();
  return {
    inbox: box ? `${box.local}@${box.domain}` : null, counts,
    replies: rows.map((r) => ({ ...r, id: Number(r.id), campaign_id: Number(r.campaign_id), recipient_id: Number(r.recipient_id), step: r.step == null ? null : Number(r.step) })),
  };
}

/** Mark a reply handled (someone answered it), or open again. */
export async function setHandled(actor: string, id: number, handled: boolean) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new AdminError("Invalid reply id");
  const [r] = await (await getDb()).query<{ id: number; campaign_id: number }>(
    `UPDATE gtm_replies SET handled_at = CASE WHEN $2 THEN coalesce(handled_at, now()) ELSE NULL END, handled_by = CASE WHEN $2 THEN $3 ELSE NULL END
      WHERE id = $1 RETURNING id, campaign_id`, [id, handled, actor]);
  if (!r) throw new AdminError(`No reply ${id}`, 404);
  log(actor, handled ? "campaign.reply_handled" : "campaign.reply_reopened", null, { campaign_id: Number(r.campaign_id), reply_id: id });
  return { id, handled };
}
