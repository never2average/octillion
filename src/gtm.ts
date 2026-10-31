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
import { accountExposures, experimentCatalog, experimentOutcomes, NOT_SHOWN, type AccountExposure } from "./experiments.js";

export const DIRECT = "direct/unknown";
const DAY = 86_400_000;

export interface Utm { source: string; medium: string; campaign: string }
export interface RequestRow { id: number; email: string; name: string | null; company: string; status: string; created_at: Date; decided_at: Date | null; org_id: number | null; utm: Utm; country: string | null }
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
    utm_source: string | null; utm_medium: string | null; utm_campaign: string | null; country: string | null }>(
    `SELECT id, lower(email) AS email, name, company, status, created_at, decided_at, org_id,
            source->>'utm_source' AS utm_source, source->>'utm_medium' AS utm_medium, source->>'utm_campaign' AS utm_campaign, source->>'country' AS country
       FROM access_requests ORDER BY created_at, id`);
  return rows.map((r) => ({ id: Number(r.id), email: r.email, name: r.name, company: r.company, status: r.status, created_at: new Date(r.created_at),
    decided_at: r.decided_at ? new Date(r.decided_at) : null, org_id: r.org_id == null ? null : Number(r.org_id),
    utm: { source: clean(r.utm_source) ?? DIRECT, medium: clean(r.utm_medium) ?? "", campaign: clean(r.utm_campaign) ?? "" },
    country: typeof r.country === "string" && /^[A-Za-z]{2}$/.test(r.country) ? r.country.toUpperCase() : null }));
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
export async function journeys(opts: { fresh?: boolean; stripe?: boolean } = {}) {
  // stripe: false skips the payment history (paid_at, paying, MRR): campaign audiences never need it.
  const [{ orgs, stripe_error }, requests, stripe] = await Promise.all([listOrgs(opts.fresh ?? false), requestRows(),
    opts.stripe === false ? { by: new Map<string, { paid_at: number | null; paying: boolean; mrr: number }>(), error: null } : stripeFacts()]);
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
/** The pricing experiment a view is split by (`experiment`, one key) and the variants it keeps (`variant`: price ids, "none" for not shown). */
export function experimentFilter(q: Record<string, unknown>) {
  const experiment = typeof q.experiment === "string" && q.experiment.trim() ? q.experiment.trim().slice(0, 100) : null;
  return experiment ? { experiment, variant: list(q.variant) } : null;
}
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
  { id: "paid", label: "Paid (after opening a report)" },
] as const;

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
/** The funnel's steps for some requests and a cohort; `paid` is given (the accounts counted at the Paid step). */
function funnelSteps(reqs: RequestRow[], cohort: Journey[], paid: Journey[]) {
  const reachedStage = (id: string) => cohort.filter((j) => j.org.stage_index >= stageAt(id));
  const counts: Record<string, Journey[] | null> = {
    requested: null, created: cohort, onboarded: reachedStage("onboarded"), simulated: reachedStage("simulated"), reported: reachedStage("reported"), paid,
  };
  const timing: Record<string, ReturnType<typeof medianHours>> = {
    requested: { median_hours: null, measured: 0 },
    created: medianHours(cohort.map((j) => [j.requested_at, j.created_at])),
    onboarded: medianHours(cohort.map((j) => [j.created_at, j.onboarded_at])),
    simulated: medianHours(cohort.map((j) => [j.onboarded_at, j.simulated_at])),
    reported: medianHours(cohort.map((j) => [j.simulated_at, j.reported_at])),
    paid: medianHours(paid.map((j) => [j.reported_at, j.paid_at])),
  };
  const reached = ACTIVATION_STEPS.map((s) => (s.id === "requested" ? reqs.length : counts[s.id]!.length));
  return ACTIVATION_STEPS.map((s, i) => ({
    ...s, reached: reached[i], pct_of_previous: i ? pct(reached[i], reached[i - 1]) : null, pct_of_first: i ? pct(reached[i], reached[0]) : null,
    ...timing[s.id], accounts: s.id === "requested" ? undefined : counts[s.id]!.map((j) => j.org.slug),
  }));
}

/**
 * An account's variants of one experiment, for GTM's splits (read-side only: src/experiments.ts):
 *   shown   plan_exposures: the variant its Billing page first showed it (offeredPlans), else NOT_SHOWN ("none")
 *   bought  Stripe: the octillion_variant of its tagged subscription (what it actually bought), else null
 *   paid    the Paid step's variant: bought where present, else shown
 */
async function variantsOf(experiment: string, all: Journey[]) {
  const [exposures, outcomes, catalog] = await Promise.all([accountExposures(experiment), experimentOutcomes(), experimentCatalog()]);
  const shownBy = new Map<number, AccountExposure>(exposures.map((e) => [e.org_id, e]));
  const boughtOf = (j: Journey) => (j.org.stripe_customer_id ? outcomes.bought.get(j.org.stripe_customer_id)?.get(experiment) ?? null : null);
  const shown = (j: Journey) => shownBy.get(Number(j.org.id))?.price_id ?? NOT_SHOWN;
  const paid = (j: Journey) => boughtOf(j)?.variant ?? shown(j);
  // The variants in order: the catalog's (live first, control first), then any only seen in exposures or Stripe tags.
  const names = new Map<string, { name: string; live: boolean }>();
  for (const v of catalog.find((c) => c.experiment === experiment)?.variants ?? []) names.set(v.price_id, { name: v.name, live: v.live });
  for (const e of exposures) if (!names.has(e.price_id)) names.set(e.price_id, { name: e.plan_name ?? e.price_id, live: false });
  for (const j of all) { const b = boughtOf(j); if (b && !names.has(b.variant)) names.set(b.variant, { name: b.variant, live: false }); }
  const variants = [...[...names].map(([key, v]) => ({ key, ...v })), { key: NOT_SHOWN, name: "Not shown pricing", live: false }];
  return { variants, shown, paid, boughtOf, outcomes, exposures, shownBy, known: catalog.some((c) => c.experiment === experiment) || exposures.length > 0 };
}

/** Said in the UI and the API: how Activation splits by variant (see activation below). */
export const SPLIT_RULE = "Each account sits under the variant its Billing page first showed it. Accounts never shown this experiment's pricing (requests and accounts that never reached Billing) are their own column, Not shown pricing, so the columns add up to the whole funnel. Paid counts under the variant actually bought (the subscription's octillion_variant), else the one shown.";

/**
 * The Activation tab (GET /gtm/activation). For the period (from/to, default the last 30 days):
 *   requested   access requests made in it
 *   created     accounts created in it (the cohort); the later steps are that cohort, cumulative by the furthest
 *               stage reached exactly as the Overview funnel counts it (admin.funnelOf); paid = opened a report and
 *               ever paid in Stripe (nested: each step is a subset of the one before; paid_any counts every payer)
 * Each step: count, % of the step before and of the first, and the median time from the step before (pairs where
 * both happened). Filters: plan (current plan name, or "none"), utm_source, utm_campaign ("direct/unknown" for none);
 * a request's plan is its account's. `attention`: every account that needs a person now (admin's own reasons), under
 * the same plan and UTM filters but not the period: someone stuck since last quarter still needs a person.
 *
 * Pricing experiment (`experiment`, optional; `variant`: keep only these variants, a comma list of price ids and/or
 * "none"): the same funnel split by variant, one column each (`experiment.split`). Read-side only.
 *   DECISION, accounts never shown the experiment: requested and created come before any Billing exposure, so an
 *   account that never opened Billing has no variant. Such accounts (and requests with no account yet) are NOT dropped:
 *   they are their own column, "Not shown pricing" (variant key "none"), so the columns always add up to the unsplit
 *   funnel and a variant's column holds only accounts that were actually shown it. A request is its account's.
 *   The variant is the account's FIRST exposure to the experiment (plan_exposures is one row per account and experiment).
 *   DECISION, the Paid step: an account counts under its tagged subscription's octillion_variant (what it actually
 *   bought, src/experiments.ts experimentOutcomes), and only where there is none under the variant it was shown.
 * Without `experiment` the response is what it always was (no `experiment` key; facets list the experiments).
 */
export async function activation(q: Record<string, unknown> = {}) {
  const range = reportRange(q);
  const f = gtmFilters(q);
  const ex = experimentFilter(q);
  const { journeys: all, requests, stripe_error } = await journeys();
  const orgPlan = new Map(all.map((j) => [Number(j.org.id), j.plan]));
  const byId = new Map(all.map((j) => [Number(j.org.id), j]));
  const inRange = (d: Date | string) => { const t = new Date(d).getTime(); return t >= range.start.getTime() && t < range.end.getTime(); };
  const planOk = (p: string) => !f.plan.length || f.plan.includes(p);
  const matches = (j: Journey) => planOk(j.plan) && utmOk(j.utm, f);
  let reqs = requests.filter((r) => inRange(r.created_at) && utmOk(r.utm, f) && planOk(r.org_id != null ? orgPlan.get(r.org_id) ?? "none" : "none"));
  let cohort = all.filter((j) => inRange(j.created_at) && matches(j));
  // Nested: paid counts only accounts that also opened a report, so every step is a subset of the one before.
  let paid = cohort.filter((j) => j.org.stage_index >= stageAt("reported") && j.paid_at);
  const v = ex ? await variantsOf(ex.experiment, all) : null;
  const reqVariant = (r: RequestRow) => { const j = r.org_id != null ? byId.get(r.org_id) : undefined; return j ? v!.shown(j) : NOT_SHOWN; };
  let attentionOk = matches;
  if (v && ex!.variant.length) {
    const keep = new Set(ex!.variant);
    paid = paid.filter((j) => keep.has(v.paid(j)));
    reqs = reqs.filter((r) => keep.has(reqVariant(r)));
    cohort = cohort.filter((j) => keep.has(v.shown(j)));
    attentionOk = (j) => matches(j) && keep.has(v.shown(j));
  }
  const steps = funnelSteps(reqs, cohort, paid);
  const tally = (xs: string[]) => Object.fromEntries([...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]));
  const catalog = await experimentCatalog().catch(() => []);
  const experiment = v && ex ? {
    id: ex.experiment, known: v.known, variant: ex.variant, rule: SPLIT_RULE, stripe_error: v.outcomes.error,
    variants: v.variants.map((x) => ({ ...x, accounts: x.key === NOT_SHOWN ? all.filter((j) => !v.shownBy.has(Number(j.org.id))).length : v.exposures.filter((e) => e.price_id === x.key).length })),
    split: v.variants.filter((x) => !ex.variant.length || ex.variant.includes(x.key)).map((c) => ({ key: c.key, name: c.name, live: c.live,
      steps: funnelSteps(reqs.filter((r) => reqVariant(r) === c.key), cohort.filter((j) => v.shown(j) === c.key), paid.filter((j) => v.paid(j) === c.key)) })),
  } : null;
  return {
    range: { from: range.from, to: range.to, days: range.days }, filters: f, stripe_error,
    steps, paid_any: cohort.filter((j) => j.paid_at).length,
    attention: all.filter((j) => j.org.attention.length && attentionOk(j)).map((j) => ({ ...j.org, utm: j.utm, plan: j.plan })),
    cohort: cohort.map((j) => ({ slug: j.org.slug, name: j.org.name, stage: j.org.stage, stage_label: j.org.stage_label, plan: j.plan, utm: j.utm,
      requested_at: j.requested_at, created_at: j.created_at, onboarded_at: j.onboarded_at, simulated_at: j.simulated_at, reported_at: j.reported_at, paid_at: j.paid_at,
      ...(v ? { variant: v.shown(j), paid_variant: j.paid_at ? v.paid(j) : null } : {}) })),
    // What the filters offer (the whole history, so a shared link's values always show), with how many accounts and requests have each.
    facets: {
      plans: tally(all.map((j) => j.plan)),
      utm_sources: tally([...requests.map((r) => r.utm.source), ...all.filter((j) => !j.requested_at).map(() => DIRECT)]),
      utm_campaigns: tally(requests.map((r) => r.utm.campaign || DIRECT)),
      // The pricing experiments (accounts shown each); with one chosen, accounts per variant shown ("none": not shown).
      experiments: Object.fromEntries(catalog.map((c) => [c.experiment, c.accounts])) as Record<string, number>,
      ...(v ? { variants: tally(all.map((j) => v.shown(j))) } : {}),
    },
    ...(experiment ? { experiment } : {}),
  };
}

/**
 * The Attribution tab (GET /gtm/attribution): for the period, one row per utm_source / utm_medium / utm_campaign of the
 * access requests made in it, plus "direct/unknown" (no tags, and accounts without any request):
 *   requests, approved      the period's access requests, under their own tags
 *   accounts                accounts created in the period, each once, under its earliest request's tags (as Activation)
 *   activated, paying, MRR  of those accounts: reached a first simulation; Stripe now (USD a month, no discounts or usage)
 * Each row carries its accounts, so a click opens them.
 *
 * Pricing experiment (`experiment`, optional): each row also gets `variants`, one per variant of that experiment over
 * the row's accounts: exposed (first shown it on Billing, plan_exposures), converted (holds a subscription tagged with
 * it that ever paid or trialed: what it bought), paying and MRR (those tagged subscriptions paying now, revenue.ts);
 * and `not_shown`, the row's accounts never shown the experiment. Without `experiment` the rows are what they were.
 */
export async function attribution(q: Record<string, unknown> = {}) {
  const range = reportRange(q);
  const ex = experimentFilter(q);
  const { journeys: all, requests, stripe_error } = await journeys();
  const byOrg = new Map(all.map((j) => [Number(j.org.id), j]));
  const inRange = (d: Date | string) => { const t = new Date(d).getTime(); return t >= range.start.getTime() && t < range.end.getTime(); };
  // Requests are counted under their own tags. Accounts are counted once each, under the tags of their earliest request
  // (the Activation rule; none: direct/unknown), when the account was created in the period: a colleague's later
  // request never moves or repeats an account.
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
  }
  for (const j of all) if (inRange(j.created_at)) rowOf(j.utm).orgs.add(Number(j.org.id));
  const simulated = stageAt("simulated");
  const v = ex ? await variantsOf(ex.experiment, all) : null;
  const variantCols = v ? v.variants.filter((x) => x.key !== NOT_SHOWN) : [];
  const breakdown = (js: Journey[]) => variantCols.map((c) => {
    const bought = js.flatMap((j) => { const b = v!.boughtOf(j); return b && b.variant === c.key ? [b] : []; });
    const paying = bought.filter((b) => b.paying);
    return { key: c.key, name: c.name, live: c.live, exposed: js.filter((j) => v!.shown(j) === c.key).length, converted: bought.length, paying: paying.length,
      mrr_usd: r2(paying.reduce((t, b) => t + b.mrr_usd, 0)) };
  });
  const shaped = [...rows.values()].map((r) => {
    const js = [...r.orgs].map((id) => byOrg.get(id)!);
    const paying = js.filter((j) => j.paying);
    return {
      key: r.key, utm_source: r.utm_source, utm_medium: r.utm_medium, utm_campaign: r.utm_campaign,
      requests: r.requests, approved: r.approved, accounts: js.length,
      activated: js.filter((j) => j.org.stage_index >= simulated).length, paying: paying.length, mrr_usd: r2(paying.reduce((t, j) => t + j.mrr_usd, 0)),
      account_list: js.map((j) => ({ slug: j.org.slug, name: j.org.name, stage_label: j.org.stage_label, created_at: j.created_at,
        activated: j.org.stage_index >= simulated, paying: j.paying, plan: j.plan, mrr_usd: j.mrr_usd,
        ...(v ? { variant: v.shown(j), bought: v.boughtOf(j)?.variant ?? null } : {}) })),
      ...(v ? { variants: breakdown(js), not_shown: js.filter((j) => v.shown(j) === NOT_SHOWN).length } : {}),
    };
  }).sort((a, b) => b.mrr_usd - a.mrr_usd || b.accounts - a.accounts || b.requests - a.requests || a.key.localeCompare(b.key));
  const sum = (k: "requests" | "approved" | "accounts" | "activated" | "paying" | "mrr_usd") => r2(shaped.reduce((t, r) => t + r[k], 0));
  const catalog = await experimentCatalog().catch(() => []);
  const inPeriod = all.filter((j) => inRange(j.created_at));
  return {
    range: { from: range.from, to: range.to, days: range.days }, stripe: { configured: billing.stripeEnabled(), error: stripe_error ?? null },
    rows: shaped,
    totals: { requests: sum("requests"), approved: sum("approved"), accounts: sum("accounts"), activated: sum("activated"), paying: sum("paying"), mrr_usd: sum("mrr_usd") },
    /** The selector's choices: every pricing experiment, with how many accounts were shown it. */
    experiments: Object.fromEntries(catalog.map((c) => [c.experiment, c.accounts])) as Record<string, number>,
    ...(v && ex ? { experiment: { id: ex.experiment, known: v.known, stripe_error: v.outcomes.error, variants: variantCols.map(({ key, name, live }) => ({ key, name, live })),
      totals: breakdown(inPeriod), not_shown: inPeriod.filter((j) => v.shown(j) === NOT_SHOWN).length } } : {}),
  };
}

/** Days between two moments, for the conversion window. */
export const within = (from: string | Date | null, at: string | Date | null, days: number) => {
  const a = ms(from), b = ms(at);
  return a != null && b != null && b >= a && b - a <= days * DAY;
};
