/**
 * Stripe is the system of record for money: customers, plans, recurring subscriptions, invoices and card details.
 * Octillion keeps only organizations.stripe_customer_id (also recorded in the Clerk organization's public_metadata, so
 * Clerk and Stripe can be joined either way). Customers self-serve through Stripe Checkout and the Stripe customer
 * portal; nothing about a plan is stored here.
 * Plain REST over fetch. Unset STRIPE_SECRET_KEY = billing is off.
 *
 * Plans are prepaid and invite-only: inference is expensive, so an account may subscribe only when an admin allows it
 * (organizations.prepaid_allowed), a plan is a fixed monthly price with a hard spend cap (no overage), and an account
 * with neither a live plan nor an admin-set allowance (organizations.budget_override_usd) gets $0: it cannot start runs.
 *
 *   STRIPE_SECRET_KEY            sk_test_... / rk_... (customers, checkout, billing portal, subscriptions, prices, meter events)
 *   Plans                        active Stripe prices whose lookup_key starts with "octillion_". A price's (or its
 *                                product's) metadata.monthly_budget_usd sets that plan's monthly model-spend cap.
 *   STRIPE_SPEND_METER           optional meter event name: each finished agent session reports its model cost in cents,
 *                                for usage-based prices (deduplicated by session id).
 *   OCTILLION_REQUIRE_SUBSCRIPTION=1  refuse new simulations for orgs without an active or trialing subscription.
 */
import { createHash } from "node:crypto";
import { getDb } from "./db.js";
import { getProvider, useCredential } from "./keyvault.js";

// The secret: the key vault's "stripe" key (Key vault › Stripe, like every other key), or STRIPE_SECRET_KEY where
// one is set (tests, local runs). The vault key is re-read at most once a minute (loadStripeKey, from the request
// middleware and before each call), so stripeEnabled() stays synchronous.
const vault = { key: null as string | null, at: 0 };
export async function loadStripeKey(force = false): Promise<void> {
  if (process.env.STRIPE_SECRET_KEY || (!force && Date.now() - vault.at < 60_000)) return;
  vault.at = Date.now();
  const p = await getProvider("stripe").catch(() => null);
  vault.key = p?.enabled ? (await useCredential("stripe").catch(() => null))?.secret ?? null : null;
}
export const stripeSecret = () => process.env.STRIPE_SECRET_KEY || vault.key || "";
export const stripeEnabled = () => Boolean(stripeSecret());
const apiBase = () => (process.env.STRIPE_API_URL ?? "https://api.stripe.com").replace(/\/$/, "");

export class StripeError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

/** Stripe's form encoding: nested objects and arrays as a[b][0]=c. */
function form(body: Record<string, unknown>, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function call<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
  await loadStripeKey();
  if (!stripeEnabled()) throw new StripeError("Stripe is not configured: add its secret key on Key vault › Stripe", 503);
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: { authorization: `Bearer ${stripeSecret()}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
               ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
    body: body ? form(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new StripeError(`Stripe ${method} ${path.split("?")[0]}: ${json.error?.message ?? res.status}`, res.status >= 500 ? 502 : res.status);
  return json as T;
}

async function all<T extends { id: string }>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let after: string | undefined; ;) {
    const page = await call<{ data: T[]; has_more: boolean }>("GET", `${path}${path.includes("?") ? "&" : "?"}limit=100${after ? `&starting_after=${after}` : ""}`);
    out.push(...page.data);
    if (!page.has_more || !page.data.length || out.length >= 5000) return out;
    after = page.data[page.data.length - 1].id;
  }
}

export interface Plan { price_id: string; lookup_key: string; name: string; amount: number | null; currency: string; interval: string | null; monthly_budget_usd: number | null }
export interface Subscription { id: string; customer: string; status: string; current_period_end: number | null; cancel_at_period_end: boolean; trial_end: number | null;
  start_date?: number | null; created?: number | null; ended_at?: number | null; canceled_at?: number | null; cancel_at?: number | null;
  items: { data: { quantity?: number | null; current_period_end?: number;
    price: { id: string; lookup_key: string | null; nickname?: string | null; unit_amount?: number | null; currency?: string;
             recurring?: { interval: string; interval_count?: number | null } | null; metadata?: Record<string, string>;
             product?: string | { name?: string; metadata?: Record<string, string> } } }[] } }

const budgetOf = (meta?: Record<string, string>) => (meta?.monthly_budget_usd != null && meta.monthly_budget_usd !== "" ? Number(meta.monthly_budget_usd) : null);

let plansCache: { at: number; plans: Plan[] } | null = null;
export async function listPlans(): Promise<Plan[]> {
  if (plansCache && Date.now() - plansCache.at < 5 * 60_000) return plansCache.plans;
  const prices = await all<{ id: string; lookup_key: string | null; unit_amount: number | null; currency: string; recurring: { interval: string } | null;
    nickname: string | null; metadata: Record<string, string>; product: { name: string; metadata: Record<string, string> } }>("/v1/prices?active=true&expand[]=data.product");
  const plans = prices.filter((p) => p.lookup_key?.startsWith("octillion_")).map((p) => ({
    price_id: p.id, lookup_key: p.lookup_key!, name: p.nickname || p.product?.name || p.lookup_key!, amount: p.unit_amount, currency: p.currency,
    interval: p.recurring?.interval ?? null, monthly_budget_usd: budgetOf(p.metadata) ?? budgetOf(p.product?.metadata),
  }));
  plansCache = { at: Date.now(), plans };
  return plans;
}

export const invalidatePlans = () => { plansCache = null; };

/** A plan's lookup key from its name: octillion_ plus the name in lower case, words joined by underscores. */
export const planLookupKey = (name: string) =>
  `octillion_${name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "plan"}`;

export interface NewPlan { name: string; amount_usd: number; interval: "month" | "year"; monthly_budget_usd: number; lookup_key?: string }

/**
 * A new prepaid plan in Stripe: a product (metadata octillion=plan, monthly_budget_usd) and a recurring USD price on it
 * with lookup_key octillion_<name>. Lookup keys are unique: an existing price with the key (active or archived) refuses,
 * never transfer_lookup_key. Idempotency keys come from the lookup key and the request, so a retried or double-clicked
 * save makes one product and one price. The caller validates the numbers (src/admin.ts createPlan).
 */
export async function createPlan(p: NewPlan): Promise<Plan> {
  const lookup_key = p.lookup_key ? (p.lookup_key.startsWith("octillion_") ? p.lookup_key : `octillion_${p.lookup_key}`) : planLookupKey(p.name);
  if (!/^octillion_[a-z0-9_]{1,190}$/.test(lookup_key)) throw new StripeError("The lookup key may use only lower-case letters, digits and underscores", 400);
  const cents = Math.round(p.amount_usd * 100), budget = String(p.monthly_budget_usd);
  const existing = await call<{ data: { id: string; active: boolean }[] }>("GET", `/v1/prices?lookup_keys[]=${encodeURIComponent(lookup_key)}&limit=10`);
  const live = existing.data.find((x) => x.active);
  if (live) throw new StripeError(`A plan with the lookup key ${lookup_key} already exists. Pick another name.`, 409);
  if (existing.data.length) throw new StripeError(`An archived plan still holds the lookup key ${lookup_key}. Pick another name.`, 409);
  const idem = `plan-${lookup_key}-${createHash("sha256").update(JSON.stringify([p.name, cents, p.interval, budget])).digest("hex").slice(0, 16)}`;
  const product = await call<{ id: string }>("POST", "/v1/products", { name: p.name, metadata: { monthly_budget_usd: budget, octillion: "plan" } }, `${idem}-product`);
  const price = await call<{ id: string; currency: string }>("POST", "/v1/prices", {
    product: product.id, currency: "usd", unit_amount: cents, recurring: { interval: p.interval }, nickname: p.name, lookup_key,
    metadata: { monthly_budget_usd: budget },
  }, `${idem}-price`);
  invalidatePlans();
  return { price_id: price.id, lookup_key, name: p.name, amount: cents, currency: price.currency ?? "usd", interval: p.interval, monthly_budget_usd: p.monthly_budget_usd };
}

/** Archive a plan (price active=false): it leaves listPlans and checkout; Stripe keeps it and any subscription on it. Never deleted. */
export async function archivePlan(priceId: string): Promise<{ price_id: string; lookup_key: string | null }> {
  if (!/^price_[A-Za-z0-9_]+$/.test(priceId)) throw new StripeError("Unknown plan", 404);
  const price = await call<{ id: string; lookup_key: string | null; active: boolean }>("GET", `/v1/prices/${priceId}`);
  if (!price.lookup_key?.startsWith("octillion_")) throw new StripeError("That price is not an Octillion plan", 400);
  if (price.active) await call("POST", `/v1/prices/${priceId}`, { active: false }, `plan-archive-${priceId}`);
  invalidatePlans();
  return { price_id: price.id, lookup_key: price.lookup_key };
}

export const createCustomer = (o: { name: string; email?: string | null; slug: string; clerkOrgId?: string | null }) =>
  call<{ id: string }>("POST", "/v1/customers", { name: o.name, email: o.email ?? undefined,
    metadata: { octillion_slug: o.slug, clerk_organization_id: o.clerkOrgId ?? undefined } }, `customer-${o.slug}`);

/** The subscription that decides the org's plan: active/trialing/past_due first, then the most recent. */
function current(subs: Subscription[]) {
  const rank = (s: Subscription) => (["active", "trialing"].includes(s.status) ? 0 : s.status === "past_due" ? 1 : 2);
  return [...subs].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}
const shapeSub = (s: Subscription | null, plans: Plan[]) => {
  if (!s) return null;
  const price = s.items.data[0]?.price;
  const plan = plans.find((p) => p.price_id === price?.id);
  const productMeta = typeof price?.product === "object" ? price.product.metadata : undefined;
  const end = s.current_period_end ?? s.items.data[0]?.current_period_end ?? null;
  return { id: s.id, status: s.status, plan: plan?.name ?? price?.lookup_key ?? price?.id ?? null, price_id: price?.id ?? null,
           monthly_budget_usd: plan?.monthly_budget_usd ?? budgetOf(price?.metadata) ?? budgetOf(productMeta),
           renews_at: end ? new Date(end * 1000).toISOString() : null, cancel_at_period_end: s.cancel_at_period_end,
           trial_end: s.trial_end ? new Date(s.trial_end * 1000).toISOString() : null };
};
export type SubscriptionSummary = NonNullable<ReturnType<typeof shapeSub>>;

/** When a subscription was paid for (ms): from its start, or the end of its trial, to when it ended (null: still on). */
export interface PaidSpan { customer: string; from: number; to: number | null }
let subsCache: { at: number; byCustomer: Map<string, SubscriptionSummary>; spans: PaidSpan[]; raw: Subscription[] } | null = null;
/** Every customer's current subscription in one paged list call, cached for a minute. */
export async function subscriptionsByCustomer(fresh = false): Promise<Map<string, SubscriptionSummary>> {
  if (!fresh && subsCache && Date.now() - subsCache.at < 60_000) return subsCache.byCustomer;
  const [subs, plans] = await Promise.all([all<Subscription>("/v1/subscriptions?status=all&expand[]=data.items.data.price.product"), listPlans()]);
  const grouped = new Map<string, Subscription[]>();
  for (const s of subs) grouped.set(s.customer, [...(grouped.get(s.customer) ?? []), s]);
  const byCustomer = new Map([...grouped].map(([c, list]) => [c, shapeSub(current(list), plans)!]));
  const spans = subs.filter((s) => !["incomplete", "incomplete_expired"].includes(s.status) && (s.start_date ?? s.created) != null).map((s) => ({
    customer: s.customer, from: Math.max(s.start_date ?? s.created ?? 0, s.trial_end ?? 0) * 1000, to: s.ended_at ? s.ended_at * 1000 : null }));
  subsCache = { at: Date.now(), byCustomer, spans, raw: subs };
  return byCustomer;
}
/** Every subscription as Stripe lists it (every status), with each customer's current one: the same cached list call (FinOps Revenue). */
export async function allSubscriptions(fresh = false): Promise<{ raw: Subscription[]; byCustomer: Map<string, SubscriptionSummary> }> {
  const byCustomer = await subscriptionsByCustomer(fresh);
  return { raw: subsCache?.raw ?? [], byCustomer };
}
/** Every subscription's paid span, from the same cached list call (the Onboarding page's Paying sparkline). */
export async function paidSpans(): Promise<PaidSpan[]> {
  if (!stripeEnabled()) return [];
  await subscriptionsByCustomer();
  return subsCache?.spans ?? [];
}
export const invalidateSubscriptions = () => { subsCache = null; invoicesCache = null; };

export interface Invoice { id: string; number: string | null; customer: string; customer_name?: string | null; customer_email?: string | null; status: string;
  amount_paid: number; amount_due: number; total: number; currency: string; created: number; hosted_invoice_url: string | null;
  status_transitions?: { paid_at?: number | null } | null; subscription?: string | { id: string } | null;
  parent?: { subscription_details?: { subscription?: string | { id: string } | null } | null } | null }
let invoicesCache: { at: number; invoices: Invoice[] } | null = null;
/** Every invoice on the Stripe account (paged list call, at most 5,000), cached for a minute (FinOps Revenue). */
export async function allInvoices(fresh = false): Promise<Invoice[]> {
  if (!fresh && invoicesCache && Date.now() - invoicesCache.at < 60_000) return invoicesCache.invoices;
  const invoices = await all<Invoice>("/v1/invoices");
  invoicesCache = { at: Date.now(), invoices };
  return invoices;
}

export async function checkoutUrl(customer: string, priceId: string, returnUrl: string) {
  const s = await call<{ url: string }>("POST", "/v1/checkout/sessions", {
    mode: "subscription", customer, line_items: [{ price: priceId, quantity: 1 }],
    success_url: returnUrl, cancel_url: returnUrl, allow_promotion_codes: true,
  });
  return s.url;
}

/** Stripe's hosted portal: change plan, card, billing email; download invoices; cancel. */
export async function portalUrl(customer: string, returnUrl: string) {
  return (await call<{ url: string }>("POST", "/v1/billing_portal/sessions", { customer, return_url: returnUrl })).url;
}

export async function recentInvoices(customer: string) {
  const r = await call<{ data: { id: string; number: string | null; status: string; total: number; currency: string; created: number; hosted_invoice_url: string | null }[] }>(
    "GET", `/v1/invoices?customer=${encodeURIComponent(customer)}&limit=6`);
  return r.data.map((i) => ({ id: i.id, number: i.number, status: i.status, total: i.total, currency: i.currency,
                              created: new Date(i.created * 1000).toISOString(), url: i.hosted_invoice_url }));
}

// ---------- what the org may spend ----------

export type BudgetSource = "override" | "plan" | "default";

/**
 * The org's monthly model-spend allowance (a hard cap): an admin-set allowance first (your own account, trials, comps),
 * else its live Stripe plan's monthly_budget_usd, else OCTILLION_ORG_MONTHLY_BUDGET_USD (default 0). 0 = no runs.
 */
export async function orgBudget(orgId: number): Promise<{ budget: number; subscription: SubscriptionSummary | null; source: BudgetSource }> {
  const fallback = Number(process.env.OCTILLION_ORG_MONTHLY_BUDGET_USD ?? 0);
  const [o] = await (await getDb()).query<{ stripe_customer_id: string | null; budget_override_usd: string | number | null }>(
    "SELECT stripe_customer_id, budget_override_usd FROM organizations WHERE id = $1", [orgId]);
  if (o?.budget_override_usd != null) return { budget: Number(o.budget_override_usd), subscription: null, source: "override" };
  if (!stripeEnabled()) return { budget: fallback, subscription: null, source: "default" };
  let sub: SubscriptionSummary | null = null;
  if (o?.stripe_customer_id) {
    try { sub = (await subscriptionsByCustomer()).get(o.stripe_customer_id) ?? null; }
    catch (err) { console.error("stripe subscription lookup failed:", (err as Error).message); return { budget: fallback, subscription: null, source: "default" }; }
  }
  const live = sub && ["active", "trialing"].includes(sub.status);
  if (process.env.OCTILLION_REQUIRE_SUBSCRIPTION === "1" && !live)
    throw new Error("This organization has no active Octillion plan. Ask your admin to subscribe, then try again; existing results stay available.");
  return live && sub!.monthly_budget_usd != null ? { budget: sub!.monthly_budget_usd, subscription: sub, source: "plan" } : { budget: fallback, subscription: sub, source: "default" };
}

/**
 * orgBudget for many orgs at once (the admin Spend page): one query and one subscription listing, the same order of
 * rules. For display only: it never throws (a Stripe outage or OCTILLION_REQUIRE_SUBSCRIPTION gives the fallback).
 */
export async function orgBudgets(orgIds: number[]): Promise<Map<number, { budget: number; plan: string | null; source: BudgetSource }>> {
  const fallback = Number(process.env.OCTILLION_ORG_MONTHLY_BUDGET_USD ?? 0);
  const out = new Map<number, { budget: number; plan: string | null; source: BudgetSource }>();
  if (!orgIds.length) return out;
  const rows = await (await getDb()).query<{ id: number; stripe_customer_id: string | null; budget_override_usd: string | number | null }>(
    "SELECT id, stripe_customer_id, budget_override_usd FROM organizations WHERE id = ANY($1)", [orgIds]);
  let subs = new Map<string, SubscriptionSummary>();
  if (stripeEnabled() && rows.some((o) => o.budget_override_usd == null && o.stripe_customer_id)) {
    try { subs = await subscriptionsByCustomer(); }
    catch (err) { console.error("stripe subscription lookup failed:", (err as Error).message); }
  }
  for (const o of rows) {
    const sub = o.stripe_customer_id ? subs.get(o.stripe_customer_id) ?? null : null;
    const live = sub && ["active", "trialing"].includes(sub.status);
    out.set(Number(o.id), o.budget_override_usd != null ? { budget: Number(o.budget_override_usd), plan: sub?.plan ?? null, source: "override" }
      : live && sub!.monthly_budget_usd != null ? { budget: sub!.monthly_budget_usd, plan: sub!.plan, source: "plan" }
      : { budget: fallback, plan: sub?.plan ?? null, source: "default" });
  }
  return out;
}

/** Report a finished session's model cost to the usage meter (STRIPE_SPEND_METER). Best effort, never throws. */
export function reportSessionSpend(sessionId: string): void {
  const meter = process.env.STRIPE_SPEND_METER;
  if (!meter || !stripeEnabled()) return;
  void (async () => {
    const [r] = await (await getDb()).query<{ stripe_customer_id: string | null; cost_usd: number | null }>(
      "SELECT o.stripe_customer_id, s.cost_usd FROM agent_sessions s JOIN organizations o ON o.id = s.org_id WHERE s.id = $1", [sessionId]);
    const cents = Math.round(Number(r?.cost_usd ?? 0) * 100);
    if (!r?.stripe_customer_id || cents <= 0) return;
    await call("POST", "/v1/billing/meter_events", { event_name: meter, identifier: sessionId,
      payload: { stripe_customer_id: r.stripe_customer_id, value: cents } });
  })().catch((err) => console.error(`stripe meter event for ${sessionId} failed:`, (err as Error).message));
}

// ---------- credits for library contributions (src/contributions.ts) ----------

export interface BalanceTransaction { id: string; amount: number; currency: string; created: number; description: string | null; metadata?: Record<string, string> }
/** The metadata key a library-contribution credit carries: the submission (request) id. */
export const CONTRIBUTION_META = "library_submission_id";

/**
 * Credit a customer's Stripe balance (a negative balance transaction), which Stripe applies to their next invoice.
 * The idempotency key is the submission id, so a retry never credits twice.
 */
export const creditCustomerBalance = (customer: string, o: { cents: number; description: string; submissionId: string; kind: string }) =>
  call<BalanceTransaction>("POST", `/v1/customers/${encodeURIComponent(customer)}/balance_transactions`, {
    amount: -Math.abs(Math.round(o.cents)), currency: "usd", description: o.description,
    metadata: { [CONTRIBUTION_META]: o.submissionId, octillion_kind: o.kind },
  }, `library-credit-${o.submissionId}`);

/** A customer's balance transactions that are library-contribution credits (newest first, at most 500). */
export async function contributionCredits(customer: string): Promise<BalanceTransaction[]> {
  const out: BalanceTransaction[] = [];
  for (let after: string | undefined; out.length < 500;) {
    const page = await call<{ data: BalanceTransaction[]; has_more: boolean }>("GET",
      `/v1/customers/${encodeURIComponent(customer)}/balance_transactions?limit=100${after ? `&starting_after=${after}` : ""}`);
    out.push(...page.data);
    if (!page.has_more || !page.data.length) break;
    after = page.data[page.data.length - 1]!.id;
  }
  return out.filter((t) => t.metadata?.[CONTRIBUTION_META]);
}
