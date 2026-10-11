import { getDb, type Queryable } from "./db.js";
import { randomId, type Org } from "./auth.js";
import { transcripts, type SearchParams } from "./transcripts.js";
import type { Tool } from "./scoring.js";
import { enabledAgents, findAgent, isRunnable, representativePlan, runnableCoverage, sandboxMix, scheduledAgents, type AgentSpec } from "./agents.js";
import { getPopulation, listPopulations } from "./populations.js";
import { capacityStatus } from "./autoscaler.js";

const agentLabel = (id: string) => findAgent(id)?.label ?? id;

/** A developer population's coding-agent mix as customers see it: who we simulate and how much each counts. */
export async function listAgents(input: { population?: string } = {}) {
  const pop = await getPopulation(input.population);
  const unit = pop.sandbox_unit;
  const mix = new Map(sandboxMix(pop).map((r) => [r.agent.id, r])); // whole sandboxes out of the unit
  return {
    view: "agents" as const,
    population: { slug: pop.slug, name: pop.name, description: pop.description, is_default: pop.is_default },
    populations: await listPopulations(),
    as_of: pop.as_of,
    unrepresented_share: pop.unrepresented_share,
    runnable_coverage: runnableCoverage(pop),
    sources: pop.sources,
    agents: pop.agents.filter((a) => a.weight > 0 || a.enabled === false).map((a) => ({ id: a.id, label: a.label, vendor: a.vendor ?? null, harness: a.harness, model: a.model,
                                    harness_version: a.harness_version ?? null, weight: (mix.get(a.id)?.sandboxes ?? 0) / unit,
                                    sandboxes: mix.get(a.id)?.sandboxes ?? 0, exact_sandboxes: mix.get(a.id)?.exact ?? 0,
                                    market_share: a.enabled === false ? 0 : a.weight,
                                    enabled: isRunnable(a), status: isRunnable(a) ? "running" : a.enabled === false ? "not runnable headless" : a.paused ? `paused${a.paused_reason ? `: ${a.paused_reason}` : ""}` : "adapter pending",
                                    notes: a.notes ?? null })),
    default_samples: config.defaultSamples(),
    sandbox_unit: unit,
  };
}

/**
 * Everything the MCP tools read or write. Every function takes the calling Org first and every query is
 * filtered by org_id, so one company can never see another's products, runs or transcripts.
 */

export const config = {
  models: async () => [...new Set(enabledAgents(await getPopulation()).map((a) => a.model))],
  agents: async () => scheduledAgents(await getPopulation()).map((a) => ({ id: a.id, label: a.label, model: a.model, harness: a.harness, weight: a.weight })),
  defaultSamples: () => Number(process.env.OCTILLION_DEFAULT_SAMPLES ?? 10),
  maxSessionsPerRun: () => Number(process.env.OCTILLION_MAX_SESSIONS_PER_RUN ?? 100),
};

// A session is a hit when the agent picked the product in a "recommend" scenario, or left it out in an "avoid" one.
const HIT = `CASE WHEN sc.expectation = 'recommend' THEN s.verdict IN ('adopted', 'recommended')
                  ELSE s.verdict NOT IN ('adopted', 'recommended') END`;
const rate = (hits: number, n: number) => (Number(n) ? Number(hits) / Number(n) : null);
/** Wilson 95% interval for a hit rate; agents are nondeterministic, so every rate is shown with its n and interval. */
export function wilson(hits: number, n: number): [number, number] | null {
  hits = Number(hits); n = Number(n);
  if (!n) return null;
  const z = 1.96, p = hits / n, d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n), w = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - w) / d), Math.min(1, (c + w) / d)];
}

export interface ProductRow {
  id: number; org_id: number; slug: string; name: string; description: string; category: string;
  website_url: string | null; docs_url: string | null; aliases: string[]; packages: string[]; domains: string[];
  competitors: Tool[]; created_at: Date; updated_at: Date;
}

const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

/** Resolve a product by slug, name or id within the org; with no ref, the org's only product. */
export async function resolveProduct(org: Org, ref?: string | number): Promise<ProductRow> {
  const db = await getDb();
  const rows = await db.query<ProductRow>("SELECT * FROM products WHERE org_id = $1 ORDER BY id", [org.orgId]);
  if (!rows.length) throw new Error("No products yet. Start with onboard_product: a short description of the product plus its website and docs links (or save_product to enter the details by hand).");
  if (ref === undefined || ref === "") {
    if (rows.length === 1) return rows[0];
    throw new Error(`Several products exist (${rows.map((r) => r.slug).join(", ")}); pass product.`);
  }
  const r = String(ref).toLowerCase();
  const p = rows.find((x) => String(x.id) === r || x.slug === r || x.name.toLowerCase() === r);
  if (!p) throw new Error(`No product "${ref}". Products: ${rows.map((x) => x.slug).join(", ")}`);
  return p;
}

const toolOf = (p: ProductRow): Tool => ({ name: p.name, aliases: p.aliases, packages: p.packages, domains: p.domains });

// ---------- products ----------

export async function listProducts(org: Org) {
  const db = await getDb();
  const products = await db.query(
    `SELECT p.id, p.slug, p.name, p.category, p.description, jsonb_array_length(p.competitors) AS competitors,
            (SELECT count(*) FROM scenarios sc WHERE sc.product_id = p.id AND sc.active) AS scenarios,
            count(s.id) AS sessions_30d,
            count(*) FILTER (WHERE ${HIT}) AS hits_30d,
            max(s.ended_at) AS last_run_at
       FROM products p
       LEFT JOIN agent_sessions s ON s.product_id = p.id AND s.verdict IS NOT NULL AND s.ended_at > now() - interval '30 days'
       LEFT JOIN scenarios sc ON sc.id = s.scenario_id
      WHERE p.org_id = $1
      GROUP BY p.id ORDER BY p.name`,
    [org.orgId],
  );
  return {
    view: "products" as const,
    org: { name: org.name, slug: org.slug },
    products: products.map((p: any) => ({ ...p, hit_rate_30d: rate(p.hits_30d, p.sessions_30d) })),
  };
}

export interface ProductInput {
  product?: string; name?: string; description?: string; category?: string; website_url?: string; docs_url?: string;
  aliases?: string[]; packages?: string[]; domains?: string[]; competitors?: Tool[];
}

export async function saveProduct(org: Org, input: ProductInput) {
  const db = await getDb();
  const existing = input.product ? await resolveProduct(org, input.product).catch(() => null) : null;
  const clean = (xs?: string[]) => (xs ? [...new Set(xs.map((x) => x.trim()).filter(Boolean))] : undefined);
  const competitors = input.competitors?.map((c) => ({
    name: c.name.trim(), aliases: clean(c.aliases) ?? [], packages: clean(c.packages) ?? [], domains: clean(c.domains) ?? [],
  }));
  if (existing) {
    await db.query(
      `UPDATE products SET
         name = coalesce($3, name), description = coalesce($4, description), category = coalesce($5, category),
         website_url = coalesce($6, website_url), docs_url = coalesce($7, docs_url),
         aliases = coalesce($8, aliases), packages = coalesce($9, packages), domains = coalesce($10, domains),
         competitors = coalesce($11, competitors), updated_at = now()
       WHERE id = $1 AND org_id = $2`,
      [existing.id, org.orgId, input.name ?? null, input.description ?? null, input.category ?? null, input.website_url ?? null,
       input.docs_url ?? null, clean(input.aliases) ?? null, clean(input.packages) ?? null, clean(input.domains) ?? null,
       competitors ? JSON.stringify(competitors) : null],
    );
    return getProduct(org, existing.slug);
  }
  if (!input.name) throw new Error(input.product ? `No product "${input.product}"; pass name to create it.` : "name is required to create a product");
  const slug = slugify(input.product ?? input.name) || "product";
  await db.query(
    `INSERT INTO products (org_id, slug, name, description, category, website_url, docs_url, aliases, packages, domains, competitors)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [org.orgId, slug, input.name, input.description ?? "", input.category ?? "", input.website_url ?? null, input.docs_url ?? null,
     clean(input.aliases) ?? [], clean(input.packages) ?? [], clean(input.domains) ?? [], JSON.stringify(competitors ?? [])],
  );
  return getProduct(org, slug);
}

export async function getProduct(org: Org, ref?: string) {
  const p = await resolveProduct(org, ref);
  const db = await getDb();
  const scenarios = await db.query(
    `SELECT sc.id, sc.title, sc.prompt, sc.repo_url, sc.language, sc.tags, sc.template, sc.expectation, sc.active, sc.source, sc.rationale,
            count(s.id) AS sessions, count(*) FILTER (WHERE ${HIT}) AS hits,
            mode() WITHIN GROUP (ORDER BY s.winner) FILTER (WHERE s.winner IS NOT NULL) AS usual_winner
       FROM scenarios sc
       LEFT JOIN agent_sessions s ON s.scenario_id = sc.id AND s.verdict IS NOT NULL
      WHERE sc.product_id = $1
      GROUP BY sc.id ORDER BY sc.active DESC, sc.id`,
    [p.id],
  );
  const simulations = await db.query(
    `SELECT id, name, status, models, repeats, created_at FROM simulations WHERE product_id = $1 ORDER BY created_at DESC LIMIT 5`,
    [p.id],
  );
  const warnings = scenarios.filter((sc: any) => sc.active && namesProduct(sc.prompt, p))
    .map((sc: any) => `Scenario ${sc.id} ("${sc.title}") names ${p.name} in its prompt, which biases the agent. Rephrase it as a neutral task.`);
  return {
    view: "product" as const,
    product: p,
    scenarios: scenarios.map((s: any) => ({ ...s, hit_rate: rate(s.hits, s.sessions) })),
    simulations,
    warnings,
    models: await config.models(),
    agents: await config.agents(),
  };
}

function namesProduct(prompt: string, p: ProductRow) {
  const words = [p.name, ...p.aliases, ...p.packages, ...p.domains].filter((w) => w.length > 2);
  return words.some((w) => new RegExp(`(?<![\\w-])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i").test(prompt));
}

// ---------- scenarios ----------

/** Starter workspaces the orchestrator can seed (orchestrator/workspaces/<template>) for scenarios without repo_url. */
export const WORKSPACE_TEMPLATES = ["express-ts", "nextjs-ts", "node-ts", "fastapi", "django", "go-http"] as const;

/** Normalize an optional template: "" / "auto" -> null (picked from language/tags/prompt); unknown -> error. */
export function checkTemplate(t: string | null | undefined): string | null | undefined {
  if (t === undefined) return undefined;
  const v = (t ?? "").trim().toLowerCase();
  if (!v || v === "auto") return null;
  if (!(WORKSPACE_TEMPLATES as readonly string[]).includes(v)) throw new Error(`Unknown template "${t}"; one of ${WORKSPACE_TEMPLATES.join(", ")} (or omit it)`);
  return v;
}

export interface ScenarioInput {
  id?: number; library_task_id?: number; title?: string; prompt?: string; repo_url?: string; language?: string; tags?: string[];
  expectation?: "recommend" | "avoid"; active?: boolean;
  /** Starter workspace when there is no repo_url; omit to let the orchestrator pick from language/tags/prompt. */
  template?: string | null;
}

export async function saveScenarios(org: Org, productRef: string | undefined, items: ScenarioInput[]) {
  const p = await resolveProduct(org, productRef);
  const db = await getDb();
  await db.transaction(async (tx) => {
    for (let s of items) {
      let template = checkTemplate(s.template);
      if (s.id !== undefined) {
        const [row] = await tx.query(
          `UPDATE scenarios SET title = coalesce($3, title), prompt = coalesce($4, prompt), repo_url = coalesce($5, repo_url),
                  language = coalesce($6, language), tags = coalesce($7, tags), expectation = coalesce($8, expectation),
                  active = coalesce($9, active), template = CASE WHEN $10 THEN $11 ELSE template END, updated_at = now()
            WHERE id = $1 AND product_id = $2 RETURNING id`,
          [s.id, p.id, s.title ?? null, s.prompt ?? null, s.repo_url ?? null, s.language ?? null, s.tags ?? null,
           s.expectation ?? null, s.active ?? null, template !== undefined, template ?? null],
        );
        if (!row) throw new Error(`Scenario ${s.id} does not belong to ${p.name}`);
      } else {
        if (s.library_task_id !== undefined) {
          const [t] = await tx.query<any>("SELECT * FROM library_tasks WHERE id = $1 AND active", [s.library_task_id]);
          if (!t) throw new Error(`No library task ${s.library_task_id}; see browse_task_library`);
          s = { ...s, title: s.title ?? t.title, prompt: s.prompt ?? t.prompt, repo_url: s.repo_url ?? t.repo_url ?? undefined,
                language: s.language ?? t.language ?? undefined, tags: s.tags ?? t.tags };
          // Curated tasks carry the starter workspace they were written for.
          if (template == null && (WORKSPACE_TEMPLATES as readonly string[]).includes(t.attributes?.template)) template = t.attributes.template;
        }
        if (!s.prompt?.trim()) throw new Error("New scenarios need a prompt (the task given to the agent) or a library_task_id");
        await tx.query(
          `INSERT INTO scenarios (product_id, title, prompt, repo_url, language, tags, expectation, active, library_task_id, template)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [p.id, s.title?.trim() || s.prompt.trim().slice(0, 80), s.prompt.trim(), s.repo_url ?? null, s.language ?? null,
           s.tags ?? [], s.expectation ?? "recommend", s.active ?? true, s.library_task_id ?? null, template ?? null],
        );
      }
    }
  });
  return getProduct(org, p.slug);
}

// ---------- simulations ----------

export interface RunInput {
  product?: string; scenario_ids?: number[]; profiles?: string[]; name?: string;
  population?: string;                                      // developer population (default: the default one)
  agents?: string[]; models?: string[]; repeats?: number;  // explicit: these agents x repeats on every scenario
  samples?: number;                                         // representative (default): sessions per scenario, mixed by adoption
}

export async function runSimulation(org: Org, input: RunInput) {
  const p = await resolveProduct(org, input.product);
  const db = await getDb();
  const pop = await getPopulation(input.population);
  const enabled = enabledAgents(pop);
  if (!enabled.length) throw new Error(`No coding agents are running in developer population ${pop.slug}`);

  const scenarios = await db.query<{ id: number }>(
    input.scenario_ids?.length
      ? "SELECT id FROM scenarios WHERE product_id = $1 AND id = ANY($2) ORDER BY id"
      : "SELECT id FROM scenarios WHERE product_id = $1 AND active ORDER BY id",
    input.scenario_ids?.length ? [p.id, input.scenario_ids] : [p.id],
  );
  if (input.scenario_ids?.length && scenarios.length !== new Set(input.scenario_ids).size)
    throw new Error(`Some scenario_ids don't belong to ${p.name}`);
  if (!scenarios.length) throw new Error(`${p.name} has no active scenarios. Add some with save_scenarios.`);
  let profiles: { id: number }[] = [];
  if (input.profiles?.length) {
    const wanted = [...new Set(input.profiles.map((x) => x.toLowerCase()))];
    profiles = await db.query<{ id: number; slug: string }>(
      "SELECT id, slug FROM developer_profiles WHERE active AND slug = ANY($1) AND (org_id IS NULL OR org_id = $2) ORDER BY id", [wanted, org.orgId]);
    const missing = wanted.filter((w) => !profiles.some((p: any) => p.slug === w));
    if (missing.length) throw new Error(`Unknown developer profile(s): ${missing.join(", ")}. See list_developer_profiles.`);
  }
  const profileIds: (number | null)[] = profiles.length ? profiles.map((p) => p.id) : [null];
  const slots = scenarios.flatMap((sc) => profileIds.map((profileId) => ({ scenarioId: sc.id, profileId })));

  // Explicit: chosen agents (by id or by model) x repeats on every slot. Representative: `samples` sessions per slot,
  // with agents apportioned by real-world adoption over the whole run.
  const explicit = Boolean(input.agents?.length || input.models?.length);
  const samples = input.samples ?? config.defaultSamples();
  const repeats = input.repeats ?? 3;
  let plan: { scenarioId: number; profileId: number | null; agent: AgentSpec; attempt: number }[];
  if (explicit) {
    let chosen = enabled;
    if (input.agents?.length) {
      const unknown = input.agents.filter((a) => !enabled.some((e) => e.id === a));
      if (unknown.length) throw new Error(`Unknown or disabled agent(s): ${unknown.join(", ")}. Available: ${enabled.map((e) => e.id).join(", ")}`);
      chosen = enabled.filter((e) => input.agents!.includes(e.id));
    }
    if (input.models?.length) {
      const unknown = input.models.filter((m) => !chosen.some((e) => e.model === m));
      if (unknown.length) throw new Error(`Unsupported model(s): ${unknown.join(", ")}. Available: ${[...new Set(chosen.map((e) => e.model))].join(", ")}`);
      chosen = chosen.filter((e) => input.models!.includes(e.model));
    }
    plan = slots.flatMap((slot) => chosen.flatMap((agent) => Array.from({ length: repeats }, (_, i) => ({ ...slot, agent, attempt: i + 1 }))));
  } else {
    const agents = representativePlan(slots.length * samples, scheduledAgents(pop));
    plan = slots.flatMap((slot, si) => Array.from({ length: samples }, (_, i) => ({ ...slot, agent: agents[si * samples + i], attempt: i + 1 })));
  }
  if (plan.length > config.maxSessionsPerRun())
    throw new Error(`That is ${plan.length} agent sessions (${scenarios.length} scenarios x ${profileIds.length} profiles x ${explicit ? "agents x repeats" : `${samples} samples`}); the limit per run is ${config.maxSessionsPerRun()}. Use fewer scenarios, profiles, agents, repeats or samples.`);

  const used = [...new Map(plan.map((x) => [x.agent.id, x.agent])).values()];
  const id = randomId("sim_");
  const name = input.name?.trim() || `${p.name} · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`;
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO simulations (id, org_id, product_id, name, models, harness, repeats, profile_ids, mode, agent_ids, population_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, org.orgId, p.id, name, [...new Set(used.map((a) => a.model))], [...new Set(used.map((a) => a.harness))].join(", "),
       explicit ? repeats : samples, profiles.map((x) => x.id), explicit ? "explicit" : "representative", used.map((a) => a.id), pop.id],
    );
    for (const x of plan)
      await tx.query(
        `INSERT INTO agent_sessions (id, simulation_id, org_id, product_id, scenario_id, model, harness, agent_id, attempt, profile_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [randomId("ses_"), id, org.orgId, p.id, x.scenarioId, x.agent.model, x.agent.harness, x.agent.id, x.attempt, x.profileId],
      );
  });
  return getSimulation(org, id);
}

export async function listSimulations(org: Org, productRef?: string) {
  const db = await getDb();
  const p = productRef ? await resolveProduct(org, productRef) : null;
  const simulations = await db.query(
    `SELECT sim.id, sim.name, sim.status, sim.models, sim.repeats, sim.created_at, sim.finished_at, p.name AS product, p.slug AS product_slug,
            count(s.id) AS sessions,
            count(*) FILTER (WHERE s.status IN ('completed', 'failed', 'timeout', 'cancelled')) AS finished,
            count(*) FILTER (WHERE s.verdict IS NOT NULL) AS scored,
            count(*) FILTER (WHERE s.verdict IS NOT NULL AND ${HIT}) AS hits
       FROM simulations sim JOIN products p ON p.id = sim.product_id
       LEFT JOIN agent_sessions s ON s.simulation_id = sim.id
       LEFT JOIN scenarios sc ON sc.id = s.scenario_id
      WHERE sim.org_id = $1 ${p ? "AND sim.product_id = $2" : ""}
      GROUP BY sim.id, p.id ORDER BY sim.created_at DESC LIMIT 50`,
    p ? [org.orgId, p.id] : [org.orgId],
  );
  return { view: "simulations" as const, product: p?.slug ?? null, simulations: simulations.map((s: any) => ({ ...s, hit_rate: rate(s.hits, s.scored) })) };
}

export async function getSimulation(org: Org, simulationId: string) {
  const db = await getDb();
  const [sim] = await db.query<any>(
    `SELECT sim.*, p.name AS product, p.slug AS product_slug FROM simulations sim JOIN products p ON p.id = sim.product_id
      WHERE sim.id = $1 AND sim.org_id = $2`,
    [simulationId, org.orgId],
  );
  if (!sim) throw new Error(`No simulation ${simulationId}`);
  const sessions = await db.query<any>(
    `SELECT s.id, s.scenario_id, sc.title AS scenario, sc.expectation, s.model, s.attempt, s.status, s.verdict, s.winner,
            s.agent_id, s.started_at, s.ended_at, s.events, s.user_turns, s.cost_usd, s.error_message, dp.name AS profile,
            s.completed_reason, (s.metadata->>'agent_turns')::int AS agent_turns,
            CASE WHEN s.verdict IS NULL THEN NULL ELSE ${HIT} END AS hit
       FROM agent_sessions s JOIN scenarios sc ON sc.id = s.scenario_id LEFT JOIN developer_profiles dp ON dp.id = s.profile_id
      WHERE s.simulation_id = $1 AND s.org_id = $2 ORDER BY sc.id, s.model, s.attempt`,
    [simulationId, org.orgId],
  );
  const by = <K extends string>(key: (s: any) => K) => {
    const m = new Map<K, any[]>();
    for (const s of sessions) m.set(key(s), [...(m.get(key(s)) ?? []), s]);
    return m;
  };
  const summarize = (xs: any[]) => {
    const scored = xs.filter((x) => x.verdict);
    const hits = scored.filter((x) => x.hit).length;
    return { sessions: xs.length, scored: scored.length, hits, hit_rate: rate(hits, scored.length), hit_ci: wilson(hits, scored.length) };
  };
  const statusCounts: Record<string, number> = {};
  const verdictCounts: Record<string, number> = {};
  const reasonCounts: Record<string, number> = {};
  for (const s of sessions) {
    statusCounts[s.status] = (statusCounts[s.status] ?? 0) + 1;
    if (s.verdict) verdictCounts[s.verdict] = (verdictCounts[s.verdict] ?? 0) + 1;
    if (s.completed_reason) reasonCounts[s.completed_reason] = (reasonCounts[s.completed_reason] ?? 0) + 1;
  }
  const agentIds = [...new Set(sessions.map((s) => s.agent_id ?? s.model))]
    .sort((a, b) => (findAgent(b)?.weight ?? 0) - (findAgent(a)?.weight ?? 0));
  const matrix = [...by((s) => String(s.scenario_id))].map(([scenarioId, xs]) => ({
    scenario_id: Number(scenarioId), scenario: xs[0].scenario, expectation: xs[0].expectation,
    cells: agentIds.map((id) => ({ agent_id: id, label: agentLabel(id), ...summarize(xs.filter((x) => (x.agent_id ?? x.model) === id)) })),
  }));
  // On-demand orchestrators: while sessions wait in the queue, say what capacity is doing ("starting orchestrator…").
  const capacity = sessions.some((s) => s.status === "queued") ? await capacityStatus() : null;
  return {
    view: "simulation" as const,
    capacity,
    simulation: sim,
    totals: { ...summarize(sessions), cost_usd: sessions.reduce((a, s) => a + Number(s.cost_usd), 0) },
    status: statusCounts,
    verdicts: verdictCounts,
    completed_reasons: reasonCounts,
    by_model: sim.models.map((model: string) => ({ model, ...summarize(sessions.filter((s) => s.model === model)) })),
    by_agent: agentIds.map((id) => ({ agent_id: id, label: agentLabel(id), ...summarize(sessions.filter((s) => (s.agent_id ?? s.model) === id)) })),
    by_profile: [...by((s) => s.profile ?? "")].filter(([k]) => k).map(([profile, xs]) => ({ profile, ...summarize(xs) })),
    matrix,
    sessions,
  };
}

export async function cancelSimulation(org: Org, simulationId: string) {
  const db = await getDb();
  const [sim] = await db.query("SELECT id FROM simulations WHERE id = $1 AND org_id = $2", [simulationId, org.orgId]);
  if (!sim) throw new Error(`No simulation ${simulationId}`);
  await db.transaction(async (tx) => {
    await tx.query("UPDATE agent_sessions SET status = 'cancelled', ended_at = now() WHERE simulation_id = $1 AND status = 'queued'", [simulationId]);
    await tx.query(
      `UPDATE simulations SET status = 'cancelled', finished_at = now()
        WHERE id = $1 AND status IN ('queued', 'running')
          AND NOT EXISTS (SELECT 1 FROM agent_sessions WHERE simulation_id = $1 AND status = 'running')`,
      [simulationId],
    );
  });
  return getSimulation(org, simulationId);
}

// ---------- visibility report ----------

export async function getReport(org: Org, input: { product?: string; days?: number; model?: string; population?: string }) {
  const p = await resolveProduct(org, input.product);
  const db = await getDb();
  const days = input.days ?? 30;
  const params: unknown[] = [p.id, days];
  let filter = "s.product_id = $1 AND s.verdict IS NOT NULL AND s.ended_at > now() - make_interval(days => $2)";
  if (input.model) params.push(input.model), (filter += ` AND s.model = $${params.length}`);
  const from = `agent_sessions s JOIN scenarios sc ON sc.id = s.scenario_id WHERE ${filter}`;

  const [t] = await db.query<any>(
    `SELECT count(*) AS sessions, count(*) FILTER (WHERE ${HIT}) AS hits,
            count(*) FILTER (WHERE s.verdict = 'adopted') AS adopted,
            count(*) FILTER (WHERE s.verdict = 'recommended') AS recommended,
            count(*) FILTER (WHERE s.verdict = 'mentioned') AS mentioned,
            count(*) FILTER (WHERE s.verdict = 'competitor') AS competitor,
            count(*) FILTER (WHERE s.verdict = 'none') AS none,
            coalesce(sum(s.cost_usd), 0) AS cost_usd
       FROM ${from}`,
    params,
  );
  // Share of voice: in how many sessions each tool was at least recommended.
  const voice = await db.query<any>(
    `SELECT m->>'tool' AS tool, bool_or((m->>'target')::boolean) AS target,
            count(*) FILTER (WHERE m->>'level' IN ('recommended', 'adopted')) AS recommended,
            count(*) FILTER (WHERE m->>'level' = 'adopted') AS adopted,
            count(*) AS mentioned
       FROM ${from.replace(" WHERE ", ", jsonb_array_elements(coalesce(s.mentions, '[]'::jsonb)) m WHERE ")}
      GROUP BY 1 ORDER BY recommended DESC, mentioned DESC`,
    params,
  );
  const byModel = await db.query<any>(
    `SELECT s.model, count(*) AS sessions, count(*) FILTER (WHERE ${HIT}) AS hits,
            count(*) FILTER (WHERE s.verdict = 'competitor') AS competitor
       FROM ${from} GROUP BY s.model ORDER BY s.model`,
    params,
  );
  const byProfile = await db.query<any>(
    `SELECT dp.slug, dp.name, count(*) AS sessions, count(*) FILTER (WHERE ${HIT}) AS hits, avg(s.user_turns)::float AS avg_user_turns
       FROM ${from.replace(" WHERE ", " JOIN developer_profiles dp ON dp.id = s.profile_id WHERE ")}
      GROUP BY dp.id ORDER BY dp.name`,
    params,
  );
  const byAgent = await db.query<any>(
    `SELECT coalesce(s.agent_id, s.model) AS agent_id, count(*) AS sessions, count(*) FILTER (WHERE ${HIT}) AS hits,
            count(*) FILTER (WHERE s.verdict = 'competitor') AS competitor
       FROM ${from} GROUP BY 1`,
    params,
  );
  const pop = await getPopulation(input.population);
  const running = new Map(scheduledAgents(pop).map((x) => [x.id, x.weight])); // whole-sandbox shares, sum to 1
  const market = new Map(pop.agents.map((x) => [x.id, x.weight]));
  const agentRows = byAgent.map((a) => {
    const spec = findAgent(a.agent_id);
    return { ...a, label: agentLabel(a.agent_id), weight: running.get(a.agent_id) ?? 0, market_share: spec?.enabled === false ? 0 : market.get(a.agent_id) ?? 0,
             hit_rate: rate(a.hits, a.sessions), hit_ci: wilson(a.hits, a.sessions) };
  }).sort((a, b) => b.weight - a.weight);
  // What a randomly chosen developer's agent would do: per-agent hit rates weighted by real-world adoption.
  const weightSum = agentRows.reduce((s, a) => s + (a.hit_rate == null ? 0 : a.weight), 0);
  const weighted = weightSum ? agentRows.reduce((s, a) => s + (a.hit_rate ?? 0) * a.weight, 0) / weightSum : null;
  const byScenario = await db.query<any>(
    `SELECT sc.id, sc.title, sc.expectation, count(*) AS sessions, count(*) FILTER (WHERE ${HIT}) AS hits,
            mode() WITHIN GROUP (ORDER BY s.winner) FILTER (WHERE s.winner IS NOT NULL) AS usual_winner
       FROM ${from} GROUP BY sc.id ORDER BY count(*) FILTER (WHERE ${HIT})::float / count(*), sc.id`,
    params,
  );
  const daily = await db.query<any>(
    `SELECT d::date AS day, count(s.id) AS sessions, count(s.id) FILTER (WHERE ${HIT}) AS hits
       FROM generate_series(current_date - ($2::int - 1), current_date, interval '1 day') d
       LEFT JOIN (agent_sessions s JOIN scenarios sc ON sc.id = s.scenario_id)
              ON s.ended_at::date = d::date AND ${filter}
      GROUP BY d ORDER BY d`,
    params,
  );
  const losses = await db.query<any>(
    `SELECT s.id, s.model, s.winner, s.ended_at, sc.id AS scenario_id, sc.title AS scenario
       FROM ${from} AND s.verdict = 'competitor' ORDER BY s.ended_at DESC LIMIT 10`,
    params,
  );
  const n = Number(t.sessions);
  return {
    view: "report" as const,
    product: { id: p.id, slug: p.slug, name: p.name },
    filters: { days, model: input.model ?? null },
    models: await config.models(),
    totals: { ...t, hit_rate: rate(t.hits, n), hit_ci: wilson(t.hits, n), weighted_hit_rate: weighted,
              adoption_coverage: weightSum, adoption_rate: rate(t.adopted, n), competitor_rate: rate(t.competitor, n) },
    share_of_voice: voice.map((v) => ({ ...v, share: rate(v.recommended, n) })),
    by_model: byModel.map((m) => ({ ...m, hit_rate: rate(m.hits, m.sessions), hit_ci: wilson(m.hits, m.sessions) })),
    by_agent: agentRows,
    by_profile: byProfile.map((p) => ({ ...p, hit_rate: rate(p.hits, p.sessions), hit_ci: wilson(p.hits, p.sessions) })),
    by_scenario: byScenario.map((s) => ({ ...s, hit_rate: rate(s.hits, s.sessions), hit_ci: wilson(s.hits, s.sessions) })),
    daily: daily.map((d) => ({ day: new Date(d.day).toISOString().slice(0, 10), sessions: Number(d.sessions), hits: Number(d.hits), hit_rate: rate(d.hits, d.sessions) })),
    recent_losses: losses,
  };
}

// ---------- vault: developer profiles + task library (shared across orgs) ----------

/** Shared vault profiles plus this org's own generated personas (never another org's). */
export async function listProfiles(org: Org, input: { query?: string; product?: string } = {}) {
  const db = await getDb();
  const q = input.query?.trim();
  const params: unknown[] = [org.orgId];
  let where = "active AND (org_id IS NULL OR org_id = $1)";
  if (q) params.push(`%${q}%`), (where += ` AND (name ILIKE $${params.length} OR summary ILIKE $${params.length} OR attributes::text ILIKE $${params.length})`);
  if (input.product) params.push((await resolveProduct(org, input.product)).id), (where += ` AND product_id = $${params.length}`);
  const profiles = await db.query(
    `SELECT id, slug, name, summary, attributes, source, product_id FROM developer_profiles WHERE ${where}
      ORDER BY (org_id IS NULL), name LIMIT 200`,
    params,
  );
  return { view: "profiles" as const, query: q ?? null, profiles };
}

export async function browseTaskLibrary(input: { query?: string; category?: string; language?: string; limit?: number } = {}) {
  const db = await getDb();
  const params: unknown[] = [];
  const where = ["active"];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replaceAll("?", `$${params.length}`)); };
  if (input.query?.trim()) add("(title ILIKE ? OR prompt ILIKE ? OR array_to_string(tags, ' ') ILIKE ?)", `%${input.query.trim()}%`);
  if (input.category) add("category = ?", input.category);
  if (input.language) add("lower(language) = lower(?)", input.language);
  const tasks = await db.query(
    `SELECT id, slug, title, prompt, repo_url, language, category, tags FROM library_tasks WHERE ${where.join(" AND ")}
      ORDER BY category NULLS LAST, title LIMIT ${Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 200)}`,
    params,
  );
  const categories = await db.query("SELECT category, count(*) AS tasks FROM library_tasks WHERE active GROUP BY 1 ORDER BY 2 DESC");
  return { view: "library" as const, filters: input, tasks, categories };
}

// ---------- sessions & transcripts ----------

export async function getSession(org: Org, sessionId: string) {
  const db = await getDb();
  const [s] = await db.query<any>(
    `SELECT s.*, (s.metadata->>'agent_turns')::int AS agent_turns, s.metadata->>'workspace_template' AS workspace_template,
            sc.title AS scenario, sc.prompt, sc.repo_url, sc.expectation, p.name AS product, p.slug AS product_slug,
            sim.name AS simulation, dp.name AS profile, dp.slug AS profile_slug, dp.summary AS profile_summary,
            CASE WHEN s.verdict IS NULL THEN NULL ELSE ${HIT} END AS hit
       FROM agent_sessions s JOIN scenarios sc ON sc.id = s.scenario_id JOIN products p ON p.id = s.product_id
       JOIN simulations sim ON sim.id = s.simulation_id LEFT JOIN developer_profiles dp ON dp.id = s.profile_id
      WHERE s.id = $1 AND s.org_id = $2`,
    [sessionId, org.orgId],
  );
  if (!s) throw new Error(`No agent session ${sessionId}`);
  return { view: "session" as const, session: s };
}

export async function getTranscript(org: Org, sessionId: string, offset = 0, limit = 50) {
  const { session } = await getSession(org, sessionId); // ownership check
  const page = await transcripts().read(org.orgId, sessionId, offset, limit);
  return {
    view: "transcript" as const,
    session_id: sessionId,
    status: session.status,
    verdict: session.verdict,
    scenario: session.scenario,
    model: session.model,
    evidence_seqs: (session.mentions ?? []).flatMap((m: any) => m.evidence.map((e: any) => e.seq)),
    offset, limit, total: page.total,
    events: page.events.map((e) => e.raw),
  };
}

export async function searchTranscripts(org: Org, input: Omit<SearchParams, "orgId" | "productId" | "query"> & { query?: string; product?: string }) {
  const productId = input.product ? (await resolveProduct(org, input.product)).id : undefined;
  const query = input.query?.trim() ?? "";
  if (!query) throw new Error("Pass a query to search transcripts");
  const results = await transcripts().search({ ...input, orgId: org.orgId, productId, query });
  return { view: "search" as const, query, filters: { ...input, mode: input.mode ?? "all" }, results };
}

export type { Queryable };
