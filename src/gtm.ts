/**
 * GTM › Activation and Attribution (/admin/gtm/activation, /admin/gtm/attribution): one canonical activation funnel
 * and the same journey split by where people came from. Octillion is not the system of record for any of it: people
 * are Clerk's, money is Stripe's, the landing page's UTM tags are on access_requests.source. This joins them.
 *
 * Every account's journey (journeys()):
 *   requested_at   its earliest access request (access_requests.org_id), else null (created by hand)
 *   approved_at    when that request was approved (decided_at), else when the account was created
 *   created_at     the account row
 *   onboarded_at   first product research completed, or a product saved by hand (src/admin.ts ORG_FACTS)
 *   simulated_at   first simulation
 *   reported_at    first visibility report opened (get_visibility_report)
 *   paid_at        Stripe: the start of its first paid span (after any trial; billing.paidSpans), else null
 *   paying, mrr    Stripe now: an active or past-due subscription out of trial (revenue.ts payingAt), its monthly value
 *   utm            source / medium / campaign of that earliest request; none: "direct/unknown"
 * Stages and "needs attention" are src/admin.ts's (listOrgs, funnelOf): nothing here re-decides them.
 */
import { getDb } from "./db.js";
import { reportRange } from "./insights.js";
import * as billing from "./billing.js";
import { listOrgs, STAGES, type AdminOrg } from "./admin.js";

export const DIRECT = "direct/unknown";
const DAY = 86_400_000;

export interface Utm { source: string; medium: string; campaign: string }
export interface RequestRow { id: number; email: string; name: string | null; company: string; status: string; created_at: Date; decided_at: Date | null; org_id: number | null; utm: Utm }
export interface Journey {
  org: AdminOrg; plan: string; utm: Utm;
  requested_at: string | null; approved_at: string | null; created_at: string; onboarded_at: string | null; simulated_at: string | null;
  reported_at: string | null; paid_at: string | null; paying: boolean; mrr_usd: number;
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const ms = (d: string | Date | null | undefined) => (d ? new Date(d).getTime() : null);
const clean = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null);
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Every access request with its UTM tags (the landing page records them in source). */
export async function requestRows(): Promise<RequestRow[]> {
  const rows = await (await getDb()).query<{ id: number; email: string; name: string | null; company: string; status: string; created_at: Date; decided_at: Date | null; org_id: number | null;
    utm_source: string | null; utm_medium: string | null; utm_campaign: string | null }>(
    `SELECT id, lower(email) AS email, name, company, status, created_at, decided_at, org_id,
            source->>'utm_source' AS utm_source, source->>'utm_medium' AS utm_medium, source->>'utm_campaign' AS utm_campaign
       FROM access_requests ORDER BY created_at, id`);
  return rows.map((r) => ({ id: Number(r.id), email: r.email, name: r.name, company: r.company, status: r.status, created_at: new Date(r.created_at),
    decided_at: r.decided_at ? new Date(r.decided_at) : null, org_id: r.org_id == null ? null : Number(r.org_id),
    utm: { source: clean(r.utm_source) ?? DIRECT, medium: clean(r.utm_medium) ?? "", campaign: clean(r.utm_campaign) ?? "" } }));
}

/** Stripe, once per call: each customer's first paid moment, whether it pays now and its MRR. Stripe off or down: empty, with the error. */
async function stripeFacts(now = Date.now()) {
  const out = new Map<string, { paid_at: number | null; paying: boolean; mrr: number }>();
  if (!billing.stripeEnabled()) return { by: out, error: null as string | null };
  try {
    const [{ raw }, spans, rev] = await Promise.all([billing.allSubscriptions(), billing.paidSpans(), import("./revenue.js")]);
    for (const s of spans) {
      const x = out.get(s.customer) ?? { paid_at: null, paying: false, mrr: 0 };
      x.paid_at = x.paid_at == null ? s.from : Math.min(x.paid_at, s.from);
      out.set(s.customer, x);
    }
    for (const s of raw) {
      if (!rev.payingAt(s, now)) continue;
      const x = out.get(s.customer) ?? { paid_at: null, paying: false, mrr: 0 };
      x.paying = true;
      x.mrr += rev.subMonthly(s);
      out.set(s.customer, x);
    }
    return { by: out, error: null };
  } catch (e) { return { by: out, error: (e as Error).message }; }
}

/** Every account's journey (see the top of the file), plus the requests and the Stripe error if any. */
export async function journeys(opts: { fresh?: boolean } = {}) {
  const [{ orgs, stripe_error }, requests, stripe] = await Promise.all([listOrgs(opts.fresh ?? false), requestRows(), stripeFacts()]);
  const firstReq = new Map<number, RequestRow>();
  for (const r of requests) if (r.org_id != null && !firstReq.has(r.org_id)) firstReq.set(r.org_id, r);
  const list: Journey[] = orgs.map((o) => {
    const q = firstReq.get(Number(o.id));
    const s = o.stripe_customer_id ? stripe.by.get(o.stripe_customer_id) : undefined;
    return {
      org: o, plan: o.subscription?.plan ?? "none", utm: q?.utm ?? { source: DIRECT, medium: "", campaign: "" },
      requested_at: iso(q?.created_at), approved_at: iso(q?.status === "approved" ? q.decided_at ?? o.created_at : o.created_at), created_at: iso(o.created_at)!,
      onboarded_at: iso(o.reached.onboarded), simulated_at: iso(o.reached.simulated), reported_at: iso(o.reached.reported),
      paid_at: s?.paid_at != null ? new Date(s.paid_at).toISOString() : null, paying: Boolean(s?.paying), mrr_usd: r2(s?.mrr ?? 0),
    };
  });
  return { journeys: list, requests, stripe_error: stripe_error ?? stripe.error ?? undefined };
}

// ---------- filters (period, plan, UTM source and campaign), as on Analytics: comma lists in the query ----------

const list = (v: unknown): string[] =>
  [...new Set((Array.isArray(v) ? v : v == null ? [] : [v]).flatMap((x) => String(x).split(",")).map((x) => x.trim()).filter(Boolean))].slice(0, 100);
export function gtmFilters(q: Record<string, unknown>) {
  return { plan: list(q.plan), utm_source: list(q.utm_source), utm_campaign: list(q.utm_campaign) };
}
type Filters = ReturnType<typeof gtmFilters>;
const utmOk = (u: Utm, f: Filters) => (!f.utm_source.length || f.utm_source.includes(u.source)) && (!f.utm_campaign.length || f.utm_campaign.includes(u.campaign || DIRECT));

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** Median hours from a to b over the pairs where both happened (b not before a). */
const medianHours = (pairs: [string | null, string | null][]) => {
  const d = pairs.flatMap(([a, b]) => { const x = ms(a), y = ms(b); return x != null && y != null && y >= x ? [(y - x) / 3_600_000] : []; });
  const m = median(d);
  return { median_hours: m == null ? null : Math.round(m * 10) / 10, measured: d.length };
};
const stageAt = (id: string) => STAGES.findIndex((s) => s.id === id);

export const ACTIVATION_STEPS = [
  { id: "requested", label: "Access requested" },
  { id: "created", label: "Approved, account created" },
  { id: "onboarded", label: "First product onboarded" },
  { id: "simulated", label: "First simulation run" },
  { id: "reported", label: "Report opened" },
  { id: "paid", label: "Paid" },
] as const;

/**
 * The Activation tab (GET /gtm/activation). For the period (from/to, default the last 30 days):
 *   requested   access requests made in it
 *   created     accounts created in it (the cohort); the later steps are that cohort, cumulative by the furthest
 *               stage reached exactly as the Overview funnel counts it (admin.funnelOf), and paid = ever paid in Stripe
 * Each step: count, % of the step before and of the first, and the median time from the step before (pairs where
 * both happened). Filters: plan (current plan name, or "none"), utm_source, utm_campaign ("direct/unknown" for none);
 * a request's plan is its account's. `attention`: every account that needs a person now (admin's own reasons), under
 * the same plan and UTM filters but not the period: someone stuck since last quarter still needs a person.
 */
export async function activation(q: Record<string, unknown> = {}) {
  const range = reportRange(q);
  const f = gtmFilters(q);
  const { journeys: all, requests, stripe_error } = await journeys();
  const orgPlan = new Map(all.map((j) => [Number(j.org.id), j.plan]));
  const inRange = (d: Date | string) => { const t = new Date(d).getTime(); return t >= range.start.getTime() && t < range.end.getTime(); };
  const planOk = (p: string) => !f.plan.length || f.plan.includes(p);
  const matches = (j: Journey) => planOk(j.plan) && utmOk(j.utm, f);
  const reqs = requests.filter((r) => inRange(r.created_at) && utmOk(r.utm, f) && planOk(r.org_id != null ? orgPlan.get(r.org_id) ?? "none" : "none"));
  const cohort = all.filter((j) => inRange(j.created_at) && matches(j));
  const reachedStage = (id: string) => cohort.filter((j) => j.org.stage_index >= stageAt(id));
  const counts: Record<string, Journey[] | null> = {
    requested: null, created: cohort, onboarded: reachedStage("onboarded"), simulated: reachedStage("simulated"), reported: reachedStage("reported"),
    paid: cohort.filter((j) => j.paid_at),
  };
  const timing: Record<string, ReturnType<typeof medianHours>> = {
    requested: { median_hours: null, measured: 0 },
    created: medianHours(cohort.map((j) => [j.requested_at, j.created_at])),
    onboarded: medianHours(cohort.map((j) => [j.created_at, j.onboarded_at])),
    simulated: medianHours(cohort.map((j) => [j.onboarded_at, j.simulated_at])),
    reported: medianHours(cohort.map((j) => [j.simulated_at, j.reported_at])),
    paid: medianHours(cohort.map((j) => [j.reported_at ?? j.simulated_at ?? j.created_at, j.paid_at])),
  };
  const reached = ACTIVATION_STEPS.map((s) => (s.id === "requested" ? reqs.length : counts[s.id]!.length));
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const steps = ACTIVATION_STEPS.map((s, i) => ({
    ...s, reached: reached[i], pct_of_previous: i ? pct(reached[i], reached[i - 1]) : null, pct_of_first: i ? pct(reached[i], reached[0]) : null,
    ...timing[s.id], accounts: s.id === "requested" ? undefined : counts[s.id]!.map((j) => j.org.slug),
  }));
  const tally = (xs: string[]) => Object.fromEntries([...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]));
  return {
    range: { from: range.from, to: range.to, days: range.days }, filters: f, stripe_error,
    steps,
    attention: all.filter((j) => j.org.attention.length && matches(j)).map((j) => ({ ...j.org, utm: j.utm, plan: j.plan })),
    cohort: cohort.map((j) => ({ slug: j.org.slug, name: j.org.name, stage: j.org.stage, stage_label: j.org.stage_label, plan: j.plan, utm: j.utm,
      requested_at: j.requested_at, created_at: j.created_at, onboarded_at: j.onboarded_at, simulated_at: j.simulated_at, reported_at: j.reported_at, paid_at: j.paid_at })),
    // What the filters offer (the whole history, so a shared link's values always show), with how many accounts and requests have each.
    facets: {
      plans: tally(all.map((j) => j.plan)),
      utm_sources: tally([...requests.map((r) => r.utm.source), ...all.filter((j) => !j.requested_at).map(() => DIRECT)]),
      utm_campaigns: tally(requests.map((r) => r.utm.campaign || DIRECT)),
    },
  };
}

/**
 * The Attribution tab (GET /gtm/attribution): for the period, one row per utm_source / utm_medium / utm_campaign of the
 * access requests made in it, plus "direct/unknown" (no tags, and accounts created in it without any request):
 *   requests -> approved (those requests, approved) -> accounts (their accounts) -> activated (reached a first
 *   simulation) -> paying (Stripe, now) -> MRR (Stripe, now; USD a month, discounts and usage not in it)
 * Each row carries its accounts, so a click opens them.
 */
export async function attribution(q: Record<string, unknown> = {}) {
  const range = reportRange(q);
  const { journeys: all, requests, stripe_error } = await journeys();
  const byOrg = new Map(all.map((j) => [Number(j.org.id), j]));
  const inRange = (d: Date | string) => { const t = new Date(d).getTime(); return t >= range.start.getTime() && t < range.end.getTime(); };
  const withRequest = new Set(requests.filter((r) => r.org_id != null).map((r) => r.org_id!));
  type Row = { key: string; utm_source: string; utm_medium: string; utm_campaign: string; requests: number; approved: number; orgs: Set<number> };
  const rows = new Map<string, Row>();
  const rowOf = (u: Utm) => {
    const key = [u.source, u.medium, u.campaign].join("\u0001");
    let r = rows.get(key);
    if (!r) rows.set(key, r = { key, utm_source: u.source, utm_medium: u.medium, utm_campaign: u.campaign, requests: 0, approved: 0, orgs: new Set() });
    return r;
  };
  for (const q2 of requests.filter((r) => inRange(r.created_at))) {
    const r = rowOf(q2.utm);
    r.requests++;
    if (q2.status === "approved") r.approved++;
    if (q2.org_id != null && byOrg.has(q2.org_id)) r.orgs.add(q2.org_id);
  }
  for (const j of all) if (inRange(j.created_at) && !withRequest.has(Number(j.org.id))) rowOf(j.utm).orgs.add(Number(j.org.id));
  const simulated = stageAt("simulated");
  const shaped = [...rows.values()].map((r) => {
    const js = [...r.orgs].map((id) => byOrg.get(id)!);
    const paying = js.filter((j) => j.paying);
    return {
      key: r.key, utm_source: r.utm_source, utm_medium: r.utm_medium, utm_campaign: r.utm_campaign,
      requests: r.requests, approved: r.approved, accounts: js.length,
      activated: js.filter((j) => j.org.stage_index >= simulated).length, paying: paying.length, mrr_usd: r2(paying.reduce((t, j) => t + j.mrr_usd, 0)),
      account_list: js.map((j) => ({ slug: j.org.slug, name: j.org.name, stage_label: j.org.stage_label, created_at: j.created_at,
        activated: j.org.stage_index >= simulated, paying: j.paying, plan: j.plan, mrr_usd: j.mrr_usd })),
    };
  }).sort((a, b) => b.mrr_usd - a.mrr_usd || b.accounts - a.accounts || b.requests - a.requests || a.key.localeCompare(b.key));
  const sum = (k: "requests" | "approved" | "accounts" | "activated" | "paying" | "mrr_usd") => r2(shaped.reduce((t, r) => t + r[k], 0));
  return {
    range: { from: range.from, to: range.to, days: range.days }, stripe: { configured: billing.stripeEnabled(), error: stripe_error ?? null },
    rows: shaped,
    totals: { requests: sum("requests"), approved: sum("approved"), accounts: sum("accounts"), activated: sum("activated"), paying: sum("paying"), mrr_usd: sum("mrr_usd") },
  };
}

/** Days between two moments, for the conversion window. */
export const within = (from: string | Date | null, at: string | Date | null, days: number) => {
  const a = ms(from), b = ms(at);
  return a != null && b != null && b >= a && b - a <= days * DAY;
};
