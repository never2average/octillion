/**
 * GTM › events that trigger campaigns (src/campaigns.ts, a campaign's `trigger`). One row per fact in gtm_events,
 * named by a dedupe key so the same fact recorded twice (a retry, two replicas) is one event:
 *
 *   emitted where it happens (emit / emitLater, after the caller's own write, never in its way):
 *     account_created     src/admin.ts newAccount (approving a request, creating an account), src/auth.ts self-serve
 *     request_submitted   POST /api/access-requests (src/http.ts)
 *     request_approved    src/admin.ts approveRequest
 *     report_opened       a successful get_visibility_report call (src/analytics.ts recordMcpEvent), once a day per account
 *   found by the tick's detector (detectSignals), from the accounts' journeys (src/gtm.ts), because these are
 *   derived rather than written anywhere: an account's stage is its furthest fact, "needs attention" is computed, and
 *   payment is Stripe's:
 *     stage_reached       each stage passed since the detector last looked (gtm_org_signals)
 *     stuck               at a stage for N days (only the stage / days pairs a running campaign asks for)
 *     attention           an attention reason that was not there last time (numbers in it ignored: "3d ago")
 *     first_payment       Stripe's first paid moment appeared
 *     pricing_no_checkout an account first shown an experiment's pricing N days ago with no completed checkout or
 *                         subscription tagged with that experiment (detectPricingNoCheckout; src/experiments.ts)
 *   An account the detector sees for the first time is recorded silently unless it is under two days old, so turning
 *   a trigger on never mails the whole back catalogue.
 *
 * No event holds an address: an account, a request, a stage, a reason. Campaigns enrol from events on the next tick;
 * a trigger with no delay also kicks a tick at once, in the background (kick), so the first email is not 5 minutes late.
 */
import { createHash } from "node:crypto";
import { getDb } from "./db.js";
import { asPlatform } from "./tenant-scope.js";
import { keepAlive } from "./telemetry.js";
import type { Journey } from "./gtm.js";

export const EVENT_TYPES = ["account_created", "request_submitted", "request_approved", "stage_reached", "stuck", "report_opened", "first_payment", "attention", "pricing_no_checkout"] as const;
export type EventType = (typeof EVENT_TYPES)[number];
/** Events about an account (written to its people) and about an access request (written to the requester). */
export const ACCOUNT_EVENTS: readonly EventType[] = ["account_created", "stage_reached", "stuck", "report_opened", "first_payment", "attention", "pricing_no_checkout"];
export const REQUEST_EVENTS: readonly EventType[] = ["request_submitted", "request_approved"];
/** The ones only the detector finds. */
export const DETECTED: readonly EventType[] = ["stage_reached", "stuck", "first_payment", "attention", "pricing_no_checkout"];

export interface EmitInput { org_id?: number | null; request_id?: number | null; data?: Record<string, unknown>; key: string; at?: Date }

/** Record an event once (by its key). The new row's id, or null when it was already recorded. */
export async function emit(type: EventType, e: EmitInput): Promise<number | null> {
  const [r] = await (await getDb()).query<{ id: number }>(
    `INSERT INTO gtm_events (type, org_id, request_id, data, dedupe_key, at) VALUES ($1, $2, $3, $4::jsonb, $5, coalesce($6, now()))
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [type, e.org_id ?? null, e.request_id ?? null, JSON.stringify(e.data ?? {}), `${type}:${e.key}`.slice(0, 300), e.at ?? null]);
  if (r) void kick(type);
  // A prospect (or their company) who just requested access or got an account is linked to it (src/gtm-crm.ts).
  if (r && (type === "request_submitted" || type === "request_approved" || type === "account_created"))
    keepAlive(import("./gtm-crm.js").then((m) => m.linkFromEvent(type, e)).catch((err) => console.error(`gtm link: ${(err as Error).message}`)));
  return r ? Number(r.id) : null;
}

/**
 * emit() without waiting and without ever failing or slowing the caller (kept alive on Vercel). Platform work, whoever
 * starts it. `e` may be a function that works the event out (a lookup after the caller's writes): it runs in the
 * background too, and null skips the event.
 */
export function emitLater(type: EventType, e: EmitInput | (() => Promise<EmitInput | null>)): void {
  const p = asPlatform(async () => {
    const x = typeof e === "function" ? await e() : e;
    if (x) await emit(type, x);
  }).catch((err) => console.error(`gtm event ${type}: not recorded: ${(err as Error).message}`));
  keepAlive(p);
}

// ---------- the immediate kick ----------

let immediate: { at: number; types: Set<string> } | null = null;
/** Trigger types of running campaigns with no delay (cached a minute): only those are worth a tick right now. */
async function immediateTypes(): Promise<Set<string>> {
  if (immediate && Date.now() - immediate.at < 60_000) return immediate.types;
  const rows = await (await getDb()).query<{ type: string }>(
    `SELECT DISTINCT trigger->>'type' AS type FROM gtm_campaigns WHERE status = 'running' AND trigger IS NOT NULL AND coalesce((trigger->>'delay_hours')::numeric, 0) = 0`);
  immediate = { at: Date.now(), types: new Set(rows.map((r) => r.type)) };
  return immediate.types;
}
/** Forget the cache (a campaign launched, paused or edited). */
export const forgetImmediate = () => { immediate = null; };

async function kick(type: EventType) {
  try {
    if (process.env.OCTILLION_GTM_KICK === "off" || !(await immediateTypes()).has(type)) return;
    const { campaignTick } = await import("./campaigns.js");
    // The tick takes the global lease: when another holds it, this one is a no-op and the next tick enrols.
    keepAlive(asPlatform(() => campaignTick()).catch(() => {}));
  } catch (e) { console.error(`gtm kick: ${(e as Error).message}`); }
}

// ---------- the detector ----------

const norm = (reason: string) => reason.replace(/\d+(\.\d+)?/g, "#").replace(/\s+/g, " ").trim().slice(0, 300);
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const dayOf = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
const YOUNG_MS = 2 * 86_400_000;

/**
 * Compare each account's journey with the detector's last look and emit what changed (see the top of the file).
 * Each event carries when it happened (`at`: the stage's own time, the payment's, the moment it became stuck) and,
 * for a change only seen now, data.after: the detector's previous look (the change happened after it). A campaign
 * counts an event only when both are after its launch (src/campaigns.ts processEvents), so a stale snapshot never
 * mails people about something that happened before. `stuck` lists the stage / days pairs running campaigns trigger on,
 * each with `since`: only accounts that entered the stage then or later qualify. Returns how many events were new.
 */
export async function detectSignals(js: Journey[], o: { stuck: { stage: string; days: number; since?: number }[]; payments: boolean; now?: number }): Promise<number> {
  const db = await getDb(), now = o.now ?? Date.now();
  const prev = new Map((await db.query<{ org_id: number; stage: string; attention: string[]; paid: boolean; seen_at: Date }>(
    "SELECT org_id, stage, attention, paid, seen_at FROM gtm_org_signals")).map((r) => [Number(r.org_id), r]));
  let n = 0;
  const add = async (type: EventType, orgId: number, key: string, data: Record<string, unknown>, at?: Date) => { if (await emit(type, { org_id: orgId, key, data, at })) n++; };
  const time = (d: Date | string | null | undefined) => { const t = d ? new Date(d) : null; return t && !Number.isNaN(t.getTime()) && t.getTime() <= now ? t : null; };
  for (const j of js) {
    const orgId = Number(j.org.id);
    // The stage ids in order (the journey's `reached` lists them in STAGES order, src/admin.ts).
    const order = Object.keys(j.org.reached);
    const attention = [...new Set(j.org.attention.map(norm))];
    const paid = Boolean(j.paid_at);
    const p = prev.get(orgId);
    const young = now - new Date(j.created_at).getTime() < YOUNG_MS;
    // What was seen before: the last look, or, for an account under two days old seen for the first time, its creation.
    const after = p ? new Date(p.seen_at) : young ? new Date(j.created_at) : null;
    if (after) {
      // A stage the snapshot names but the list no longer has: start again from here, silently.
      const from = p ? order.indexOf(p.stage) : -1;
      if (!p || from >= 0)
        for (let i = from + 1; i <= j.org.stage_index; i++) {
          const at = time(j.org.reached[order[i] as keyof typeof j.org.reached]);
          await add("stage_reached", orgId, `${orgId}:${order[i]}`, { stage: order[i], after: (at ?? after).toISOString() }, at ?? undefined);
        }
      const had = new Set(p?.attention ?? []);
      for (const [k, reason] of j.org.attention.entries()) {
        const r = attention[k] ?? norm(reason);
        if (!had.has(r)) await add("attention", orgId, `${orgId}:${hash(r)}:${dayOf(new Date(now))}`, { reason: reason.slice(0, 300), after: after.toISOString() });
      }
      // Only a recent first payment: one from months ago, seen now because a campaign started asking, is not news.
      const paidAt = time(j.paid_at);
      if (o.payments && paid && !p?.paid && paidAt && now - paidAt.getTime() < YOUNG_MS) await add("first_payment", orgId, `${orgId}`, { paid_at: j.paid_at, after: paidAt.toISOString() }, paidAt);
      // Stuck: at the stage for N days, from when it was reached (moving on and back starts again), and reached no
      // earlier than the campaign asking allows. Never on a first sighting of an older account.
      for (const s of o.stuck) {
        const since = j.org.stage === s.stage ? time(j.org.reached[s.stage as keyof typeof j.org.reached]) : null;
        if (!since || since.getTime() < (s.since ?? -Infinity)) continue;
        const stuckAt = new Date(since.getTime() + s.days * 86_400_000);
        if (stuckAt.getTime() <= now)
          await add("stuck", orgId, `${orgId}:${s.stage}:${s.days}:${dayOf(since)}`, { stage: s.stage, days: s.days, reached_at: since.toISOString(), after: stuckAt.toISOString() }, stuckAt);
      }
    }
    // Payments not looked at this time (no campaign wants them): keep what was known.
    await db.query(
      `INSERT INTO gtm_org_signals (org_id, stage, attention, paid, seen_at) VALUES ($1, $2, $3::text[], $4, now())
       ON CONFLICT (org_id) DO UPDATE SET stage = excluded.stage, attention = excluded.attention, paid = excluded.paid OR (NOT $5 AND gtm_org_signals.paid), seen_at = now()`,
      [orgId, j.org.stage, attention, paid, o.payments]);
  }
  return n;
}

/**
 * "Saw pricing, didn't check out within N days" (pricing_no_checkout): for each experiment / days pair a running
 * campaign asks for, every account whose FIRST exposure to the experiment (plan_exposures) is N days old and that has
 * not bought (src/experiments.ts hasBought): no subscription at all that is not incomplete (tagged or not, so a
 * subscriber from before the experiment, a buyer of another plan or variant, an admin checkout link, a checkout under
 * another experiment all count as bought), no completed checkout tagged with the experiment, and no completed
 * checkout of any kind since the exposure. Paying customers open Billing too (prepaid), so their exposures exist:
 * this check is what keeps them out. Stateless: plan_exposures and Stripe are the state, gtm_events the record.
 * The same back-catalogue protections as the other detected events:
 *   - only exposures at or after `since` (the earliest asking campaign's launch, less 2 days), like stuck's reached_at;
 *   - only when the N days ran out within the last `maxAgeHours` (24): an exposure from months ago is never news;
 *   - the event's `at` is when the N days ran out and data.after the same, so processEvents also requires it after
 *     the campaign's launch; data.exposed_at is checked there against the launch less 2 days;
 *   - one event per account, experiment and N (its dedupe key), so a second look or a second replica adds nothing;
 *     re-entry is the campaign's rule (admit).
 * Stripe is read only when some exposure qualifies, the checkout sessions from the oldest such exposure on
 * (created[gte]). Stripe failing, a list cut at the cap (the rest unknown) or `deadline` (ms) reached: nothing is
 * emitted this time (a purchase we cannot see may exist); the next pass looks again. Returns how many events were new.
 */
export async function detectPricingNoCheckout(asks: { experiment: string | null; days: number; since: number }[],
  o: { now?: number; maxAgeHours?: number; deadline?: number } = {}): Promise<number> {
  if (!asks.length) return 0;
  const now = o.now ?? Date.now(), maxAge = (o.maxAgeHours ?? 24) * 3_600_000;
  const { accountExposures, experimentOutcomes, hasBought } = await import("./experiments.js");
  const exposures = await accountExposures();
  // What qualifies on time alone (no Stripe needed to say no).
  const due = asks.flatMap((a) => exposures.flatMap((e) => {
    if (a.experiment && e.experiment !== a.experiment) return [];
    const seen = e.first_seen_at.getTime(), at = seen + a.days * 86_400_000;
    return seen >= a.since && at <= now && now - at <= maxAge ? [{ e, days: a.days, at }] : [];
  }));
  if (!due.length) return 0;
  const oldest = Math.min(...due.map((d) => d.e.first_seen_at.getTime()));
  const outcomes = await experimentOutcomes(now, { sessionsSince: Math.floor(oldest / 1000) - 60, deadline: o.deadline });
  if (outcomes.error) { console.error(`gtm pricing_no_checkout: nothing emitted (${outcomes.error})`); return 0; }
  if (o.deadline != null && Date.now() >= o.deadline) return 0;
  const customer = new Map((await (await getDb()).query<{ id: number; stripe_customer_id: string | null }>(
    "SELECT id, stripe_customer_id FROM organizations WHERE id = ANY($1::int[])", [[...new Set(due.map((d) => d.e.org_id))]])).map((r) => [Number(r.id), r.stripe_customer_id]));
  let n = 0;
  for (const { e, days, at } of due) {
    if (hasBought(outcomes, customer.get(e.org_id), e.experiment, e.first_seen_at.getTime())) continue;
    const when = new Date(at);
    if (await emit("pricing_no_checkout", { org_id: e.org_id, key: `${e.org_id}:${hash(e.experiment)}:${days}`, at: when,
      data: { experiment: e.experiment, variant: e.price_id, plan_name: e.plan_name, days, exposed_at: e.first_seen_at.toISOString(), after: when.toISOString() } })) n++;
  }
  return n;
}
