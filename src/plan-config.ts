/**
 * A plan as one JSON document (FinOps › Plans › New plan › JSON; POST /api/admin/onboarding/plans {config}): what a
 * customer pays, written once and turned into Stripe objects by billing.createPlanFromConfig. Checked here, with every
 * problem listed by its path, before anything is sent to Stripe.
 *
 *   {
 *     "name": "Team",                       required, 2 to 60 characters; checkout shows it
 *     "description": "For weekly simulations", optional, shown at checkout
 *     "interval": "month",                  "month" (default) or "year"; the base fee and usage bill on it
 *     "lookup_key": "octillion_team_v2",    optional; default octillion_<name>
 *     "base_fee_usd": 250,                  flat recurring fee (0 or omitted: usage only)
 *     "trial_days": 14,                     optional free trial
 *     "monthly_budget_usd": 2000,           the account's monthly cap on model spend (Budget rules); default the base fee
 *                                           without usage, required with usage
 *     "usage": {                            optional: bill model spend through the Stripe meter
 *       "meter": "octillion_model_spend",   the meter's event name (default STRIPE_SPEND_METER, else octillion_model_spend);
 *                                           made in Stripe if missing. Each finished session reports its model cost in cents.
 *       "included_usd": 100,                model spend each period that the base fee covers (billed at 0)
 *       "markup": 1.3,                      price per $1 of model spend above that; or tiers:
 *       "tiers": [{ "up_to_usd": 1000, "markup": 1.3 }, { "up_to_usd": null, "markup": 1.15 }]
 *                                           graduated, by the period's model spend; the last up_to_usd is null
 *     },
 *     "experiment": "team-price-oct", "weight": 1,   optional A/B test (src/experiments.ts)
 *     "metadata": { "owner": "growth" }     optional extra Stripe metadata (string values; octillion_ keys are reserved)
 *   }
 */
import { experimentKey, planLookupKey } from "./billing.js";

export interface UsageTier { up_to_usd: number | null; markup: number }
export interface PlanConfig {
  name: string; description: string | null; interval: "month" | "year"; lookup_key: string; base_fee_usd: number; trial_days: number | null;
  monthly_budget_usd: number; usage: { meter: string; included_usd: number; tiers: UsageTier[] } | null;
  experiment: string | null; weight: number; metadata: Record<string, string>;
}

export class PlanConfigError extends Error {
  status = 400;
  constructor(public problems: string[]) { super(`The plan config has ${problems.length === 1 ? "a problem" : `${problems.length} problems`}: ${problems.join("; ")}`); }
}

const KEYS = new Set(["name", "description", "interval", "lookup_key", "base_fee_usd", "trial_days", "monthly_budget_usd", "usage", "experiment", "weight", "metadata"]);
const USAGE_KEYS = new Set(["meter", "included_usd", "markup", "tiers"]);
const cents = (x: number) => Math.abs(x * 100 - Math.round(x * 100)) < 1e-6;
export const defaultMeter = () => process.env.STRIPE_SPEND_METER || "octillion_model_spend";

/** Check and normalise a plan config: every problem at once, by path. */
export function parsePlanConfig(input: unknown): PlanConfig {
  let raw = input;
  if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch (e) { throw new PlanConfigError([`not valid JSON (${(e as Error).message})`]); } }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PlanConfigError(["the config must be a JSON object"]);
  const c = raw as Record<string, unknown>, bad: string[] = [];
  for (const k of Object.keys(c)) if (!KEYS.has(k)) bad.push(`${k}: unknown field`);
  const num = (path: string, v: unknown, o: { min?: number; max?: number; gt?: number; int?: boolean; money?: boolean } = {}) => {
    const n = Number(v);
    if (typeof v !== "number" || !Number.isFinite(n)) { bad.push(`${path}: must be a number`); return null; }
    if (o.gt != null && !(n > o.gt)) bad.push(`${path}: must be more than ${o.gt}`);
    if (o.min != null && n < o.min) bad.push(`${path}: must be at least ${o.min}`);
    if (o.max != null && n > o.max) bad.push(`${path}: must be at most ${o.max}`);
    if (o.int && !Number.isInteger(n)) bad.push(`${path}: must be a whole number`);
    if (o.money && !cents(n)) bad.push(`${path}: can't have fractions of a cent`);
    return n;
  };

  const name = typeof c.name === "string" ? c.name.trim().replace(/\s+/g, " ") : "";
  if (name.length < 2 || name.length > 60) bad.push("name: 2 to 60 characters");
  const description = c.description == null ? null : typeof c.description === "string" ? c.description.trim().slice(0, 300) || null : (bad.push("description: must be text"), null);
  const interval = c.interval ?? "month";
  if (interval !== "month" && interval !== "year") bad.push(`interval: "month" or "year"`);
  let lookup_key = planLookupKey(name || "plan");
  if (c.lookup_key != null) {
    const lk = String(c.lookup_key).trim();
    lookup_key = lk.startsWith("octillion_") ? lk : `octillion_${lk}`;
    if (!/^octillion_[a-z0-9_]{1,180}$/.test(lookup_key) || lookup_key.includes("__")) bad.push("lookup_key: lower-case letters, digits and single underscores");
  }
  const base = c.base_fee_usd == null ? 0 : num("base_fee_usd", c.base_fee_usd, { min: 0, max: 100_000, money: true }) ?? 0;
  const trial = c.trial_days == null ? null : num("trial_days", c.trial_days, { min: 1, max: 730, int: true });

  let usage: PlanConfig["usage"] = null;
  if (c.usage != null) {
    if (typeof c.usage !== "object" || Array.isArray(c.usage)) bad.push("usage: must be an object");
    else {
      const u = c.usage as Record<string, unknown>;
      for (const k of Object.keys(u)) if (!USAGE_KEYS.has(k)) bad.push(`usage.${k}: unknown field`);
      const meter = u.meter == null ? defaultMeter() : String(u.meter).trim();
      if (!/^[a-z0-9_]{3,100}$/.test(meter)) bad.push("usage.meter: an event name of lower-case letters, digits and underscores");
      const included = u.included_usd == null ? 0 : num("usage.included_usd", u.included_usd, { min: 0, max: 1_000_000, money: true }) ?? 0;
      let tiers: UsageTier[] = [];
      if (u.tiers != null && u.markup != null) bad.push("usage: give markup or tiers, not both");
      if (u.tiers != null) {
        if (!Array.isArray(u.tiers) || !u.tiers.length || u.tiers.length > 10) bad.push("usage.tiers: 1 to 10 tiers");
        else u.tiers.forEach((t, i) => {
          const p = `usage.tiers[${i}]`;
          if (!t || typeof t !== "object") return void bad.push(`${p}: must be an object`);
          const x = t as Record<string, unknown>;
          for (const k of Object.keys(x)) if (k !== "up_to_usd" && k !== "markup") bad.push(`${p}.${k}: unknown field`);
          const last = i === (u.tiers as unknown[]).length - 1;
          const up = x.up_to_usd == null ? null : num(`${p}.up_to_usd`, x.up_to_usd, { gt: 0, money: true });
          if (last && up != null) bad.push(`${p}.up_to_usd: the last tier must be null (no upper bound)`);
          if (!last && up == null) bad.push(`${p}.up_to_usd: only the last tier may be unbounded`);
          const markup = num(`${p}.markup`, x.markup, { gt: 0, max: 10 }) ?? 1;
          tiers.push({ up_to_usd: up, markup });
        });
        for (let i = 1; i < tiers.length - 1; i++) if ((tiers[i].up_to_usd ?? 0) <= (tiers[i - 1].up_to_usd ?? 0)) bad.push(`usage.tiers[${i}].up_to_usd: must be above the tier before`);
        if (tiers.length > 1 && included > 0 && (tiers[0].up_to_usd ?? Infinity) <= included) bad.push("usage.tiers[0].up_to_usd: must be above included_usd");
      } else tiers = [{ up_to_usd: null, markup: u.markup == null ? (bad.push("usage: give a markup or tiers"), 1) : num("usage.markup", u.markup, { gt: 0, max: 10 }) ?? 1 }];
      usage = { meter, included_usd: included, tiers };
    }
  }
  if (!(base > 0) && !usage) bad.push("base_fee_usd or usage: a plan needs a base fee, usage pricing or both");
  let budget = base;
  if (c.monthly_budget_usd != null) budget = num("monthly_budget_usd", c.monthly_budget_usd, { min: 0, max: 1_000_000, money: true }) ?? 0;
  else if (usage) bad.push("monthly_budget_usd: required with usage (the account's monthly cap on model spend)");
  const experimentRaw = c.experiment == null ? "" : String(c.experiment).trim();
  const experiment = experimentRaw ? experimentKey(experimentRaw) || null : null;
  if (experimentRaw && !experiment) bad.push("experiment: needs letters or digits");
  const weight = c.weight == null ? 1 : num("weight", c.weight, { gt: 0, max: 100 }) ?? 1;
  if (c.weight != null && !experiment) bad.push("weight: only with an experiment");
  const metadata: Record<string, string> = {};
  if (c.metadata != null) {
    if (typeof c.metadata !== "object" || Array.isArray(c.metadata)) bad.push("metadata: must be an object of strings");
    else for (const [k, v] of Object.entries(c.metadata as Record<string, unknown>)) {
      if (k.startsWith("octillion") || k === "monthly_budget_usd") bad.push(`metadata.${k}: reserved`);
      else if (!/^[A-Za-z0-9_.-]{1,40}$/.test(k)) bad.push(`metadata.${k}: keys are letters, digits, _ . - (at most 40)`);
      else if (typeof v !== "string" || v.length > 500) bad.push(`metadata.${k}: a string of at most 500 characters`);
      else metadata[k] = v;
    }
    if (Object.keys(metadata).length > 20) bad.push("metadata: at most 20 keys");
  }
  if (bad.length) throw new PlanConfigError(bad);
  return { name, description, interval: interval as "month" | "year", lookup_key, base_fee_usd: base, trial_days: trial, monthly_budget_usd: budget, usage, experiment, weight, metadata };
}

/**
 * The Stripe price tiers for usage: the meter counts cents of model spend, so a tier's price per unit is its markup
 * in cents (unit_amount_decimal) and its bound is in cents. Included spend is a first tier at 0.
 */
export function stripeTiers(u: NonNullable<PlanConfig["usage"]>): { up_to: number | "inf"; unit_amount_decimal: string }[] {
  const out: { up_to: number | "inf"; unit_amount_decimal: string }[] = [];
  const inc = Math.round(u.included_usd * 100);
  if (inc > 0) out.push({ up_to: inc, unit_amount_decimal: "0" });
  for (const t of u.tiers) out.push({ up_to: t.up_to_usd == null ? "inf" : Math.round(t.up_to_usd * 100), unit_amount_decimal: String(Math.round(t.markup * 1e6) / 1e6) });
  return out;
}

/** The config back from Stripe's tiers (inverse of stripeTiers): for "Copy as JSON" and the Plans table. */
export function usageFromTiers(meter: string, tiers: { up_to: number | null; unit_amount_decimal?: string | null; unit_amount?: number | null }[]): NonNullable<PlanConfig["usage"]> {
  const rate = (t: (typeof tiers)[number]) => Number(t.unit_amount_decimal ?? t.unit_amount ?? 0);
  const ts = [...tiers];
  const included_usd = ts.length > 1 && rate(ts[0]) === 0 && ts[0].up_to != null ? ts.shift()!.up_to! / 100 : 0;
  return { meter, included_usd, tiers: ts.map((t) => ({ up_to_usd: t.up_to == null ? null : t.up_to / 100, markup: rate(t) })) };
}

/** A plan config as a person writes it (defaults left out where they are the default). */
export function configJson(c: PlanConfig): Record<string, unknown> {
  return {
    name: c.name, ...(c.description ? { description: c.description } : {}), interval: c.interval, lookup_key: c.lookup_key, base_fee_usd: c.base_fee_usd,
    ...(c.trial_days ? { trial_days: c.trial_days } : {}), monthly_budget_usd: c.monthly_budget_usd,
    ...(c.usage ? { usage: { meter: c.usage.meter, included_usd: c.usage.included_usd, ...(c.usage.tiers.length === 1 && c.usage.tiers[0].up_to_usd == null ? { markup: c.usage.tiers[0].markup } : { tiers: c.usage.tiers }) } } : {}),
    ...(c.experiment ? { experiment: c.experiment, weight: c.weight } : {}), ...(Object.keys(c.metadata).length ? { metadata: c.metadata } : {}),
  };
}
