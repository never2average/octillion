import { randomId } from "./auth.js";
import { audienceFormIssues, hardMisses, mergeAudience, type Audience } from "./audience.js";

/**
 * Re-pick one product's personas (scripts/repick-personas.ts), the operator's alternative to queueing a full research
 * again, which would replace the customer's approved tasks, aliases and competitors. Optionally it first stores an
 * audience as the customer's (confirmed: final for research) and records tools removed by hand as not competing (so a
 * later research never adds them back). Then it unlinks linked personas the audience rules out and queues a
 * personas-only research job (src/research.ts completePersonasOnly) with no run. Plan first, so a dry run shows it all.
 */

type Q = { query: <T = any>(sql: string, params?: unknown[]) => Promise<T[]> };
type Db = Q & { transaction: <T>(fn: (tx: Q) => Promise<T>) => Promise<T> };
const RELATIONS = ["substitute", "complement", "different_layer", "unrelated"];

export interface RepickPlan {
  product: { id: number; org_id: number; slug: string; name: string };
  /** The audience research will pick for, and whether it is newly set here. */
  audience: Audience | null; audience_changed: boolean;
  not_competitors_added: { name: string; relation: string; reason: string }[];
  /** Hand-removed tools still listed as competitors (the operator removes them in the app). */
  still_competitors: string[];
  unlink: { slug: string; why: string[] }[];
  keep: string[];
  research_input: Record<string, unknown>;
  research: Record<string, any>;
}

/**
 * The database serves a version that knows personas-only research (migration 0007, which also adds
 * product_research.pages): an older server would claim the job as a full research and replace the product's tasks.
 */
export async function personasOnlySupported(db: Q): Promise<boolean> {
  const [x] = await db.query<{ pages: boolean; v7: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'product_research' AND column_name = 'pages') AS pages,
            (to_regclass('schema_migrations') IS NOT NULL AND EXISTS (SELECT 1 FROM schema_migrations WHERE version >= 7)) AS v7`);
  return Boolean(x?.pages && x?.v7);
}

export async function planRepick(db: Q, opts: { product: number; audience?: unknown; notCompetitors?: string[] }): Promise<RepickPlan> {
  if (!(await personasOnlySupported(db)))
    throw new Error("this database is not at migration 0007 (product_research.pages): deploy the version with personas-only research first; nothing queued");
  const [p] = await db.query<any>("/* tenant: operator script on one product by id (scripts/repick-personas.ts) */ SELECT id, org_id, slug, name, competitors, research FROM products WHERE id = $1", [opts.product]);
  if (!p) throw new Error(`No product ${opts.product}`);
  const research = { ...(p.research ?? {}) };
  let audience: Audience | null = research.audience ?? null, changed = false;
  if (opts.audience !== undefined) {
    const value = opts.audience as Partial<Audience>;
    const bad = audienceFormIssues({ checked: "x".repeat(30), ...value }, { sources: null });
    if (bad.length) throw new Error(`--audience-json is not a usable audience: ${bad.join("; ")}`);
    audience = mergeAudience(null, value, "set by the operator from the customer's confirmation");
    if (!value.checked) audience.checked = "confirmed by the customer (recorded by the operator)";
    changed = true;
    research.audience = audience;
  }
  const added: RepickPlan["not_competitors_added"] = [];
  for (const raw of opts.notCompetitors ?? []) {
    const [name, relation = "complement"] = raw.split("=").map((x) => x.trim());
    if (!name || !RELATIONS.includes(relation)) throw new Error(`--not-competitor ${raw}: give a name, optionally =${RELATIONS.join("|")}`);
    if ((research.not_competitors ?? []).some((x: any) => String(x?.name).toLowerCase() === name.toLowerCase())) continue;
    added.push({ name, relation, reason: "removed from the competitors by hand (operator)" });
  }
  if (added.length) research.not_competitors = [...(research.not_competitors ?? []), ...added];
  const names = (research.not_competitors ?? []).map((x: any) => String(x?.name).toLowerCase());
  const still = (p.competitors ?? []).filter((c: any) => names.includes(String(c?.name).toLowerCase())).map((c: any) => c.name);
  const linked = await db.query<{ slug: string; facets: any }>(
    `/* tenant: operator script on one product by id (scripts/repick-personas.ts) */ SELECT dp.slug, dp.attributes->'facets' AS facets FROM product_personas pp JOIN developer_profiles dp ON dp.id = pp.profile_id
      WHERE pp.product_id = $1 AND pp.active ORDER BY dp.slug`, [p.id]);
  const unlink = linked.map((x) => ({ slug: x.slug, why: hardMisses(audience, x.facets) })).filter((x) => x.why.length);
  const [last] = await db.query<{ input: any }>(
    "/* tenant: operator script on one product by id (scripts/repick-personas.ts) */ SELECT input FROM product_research WHERE product_id = $1 AND kind = 'product' ORDER BY created_at DESC LIMIT 1", [p.id]);
  const { confirmed_audience: _c, product_profile: _pp, ...base } = last?.input ?? {};
  // The audience is not in the input: the job reads the stored one at claim, and only a stored confirmed one is final.
  const { audience: _a, not_competitors: _n, ...rest } = base;
  const research_input = { ...rest, personas_only: true,
    prompt: String(rest.prompt ?? "").replace(/\n\nThe customer confirmed who can use the product[\s\S]*$/, "") };
  return { product: { id: p.id, org_id: p.org_id, slug: p.slug, name: p.name }, audience, audience_changed: changed, not_competitors_added: added,
           still_competitors: still, unlink, keep: linked.filter((x) => !unlink.some((u) => u.slug === x.slug)).map((x) => x.slug), research_input, research };
}

/**
 * Apply a plan in one transaction; returns the queued research id. products.research is re-read under a row lock and
 * only the audience and not_competitors written onto it, so a research or an answer landing since the plan is kept.
 */
export async function applyRepick(db: Db, plan: RepickPlan): Promise<string> {
  const id = randomId("rsh_");
  await db.transaction(async (tx) => {
    if (plan.audience_changed || plan.not_competitors_added.length) {
      const [cur] = await tx.query<{ research: any }>("/* tenant: operator script on one product by id (scripts/repick-personas.ts) */ SELECT research FROM products WHERE id = $1 FOR UPDATE", [plan.product.id]);
      const research = { ...(cur?.research ?? {}) };
      if (plan.audience_changed) research.audience = plan.audience;
      const names = new Set((research.not_competitors ?? []).map((x: any) => String(x?.name).toLowerCase()));
      research.not_competitors = [...(research.not_competitors ?? []), ...plan.not_competitors_added.filter((x) => !names.has(x.name.toLowerCase()))];
      await tx.query("/* tenant: operator script on one product by id (scripts/repick-personas.ts) */ UPDATE products SET research = $2, updated_at = now() WHERE id = $1", [plan.product.id, JSON.stringify(research)]);
    }
    if (plan.unlink.length)
      await tx.query(`/* tenant: operator script on one product by id (scripts/repick-personas.ts) */ UPDATE product_personas SET active = false WHERE product_id = $1
                        AND profile_id IN (SELECT id FROM developer_profiles WHERE slug = ANY($2))`, [plan.product.id, plan.unlink.map((x) => x.slug)]);
    // No run: the customer starts one when the new personas are in.
    await tx.query("/* tenant: operator script on one product by id (scripts/repick-personas.ts) */ INSERT INTO product_research (id, org_id, product_id, input, run) VALUES ($1, $2, $3, $4, NULL)",
      [id, plan.product.org_id, plan.product.id, JSON.stringify(plan.research_input)]);
  });
  return id;
}
