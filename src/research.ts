import { getDb } from "./db.js";
import { randomId, type Org } from "./auth.js";
import { WORKSPACE_TEMPLATES, config, getProduct, resolveProduct, runSimulation, saveProduct, browseTaskLibrary } from "./queries.js";
import { PLATFORMS, isPlatform, platformOf } from "./platform.js";
import type { Tool } from "./scoring.js";
import { capacityStatus } from "./autoscaler.js";
import { environmentIssues, resolveEnvironment, type PersonaEnvironment } from "../orchestrator/core/environment.js";

/**
 * Product onboarding (docs/onboarding.md). A customer gives a prompt, a website and docs; the orchestrator's Pi
 * researches the product and submits a profile, target developer personas and programming problems; the server
 * validates (blindness + counts), applies them and launches a representative run.
 */

export const LIMITS = { max_personas: 4, max_scenarios: 10, min_scenarios: 3, min_competitors: 3, max_competitors: 8 };
const STALE_MINUTES = () => Number(process.env.OCTILLION_RESEARCH_STALE_MINUTES ?? 20);
const MAX_ATTEMPTS = 6;

export interface ResearchResult {
  product: { name: string; description?: string; category?: string; website_url?: string; docs_url?: string; features?: string[];
             /** Words that name this kind of tool ("transactional email service", "email API"): a prompt may not use them. */
             category_terms?: string[];
             /** Where the product's users build, most important first (e.g. ["mobile", "web"]); problems are spread across them. */
             platforms?: string[];
             aliases?: string[]; packages?: string[]; domains?: string[]; competitors?: Tool[] };
  /** Picked from the shared developer-profile data (search_profiles): the profile's slug; its name, summary,
   *  attributes and instructions are copied from the data, never written by research. */
  personas: { profile_slug?: string; name: string; summary?: string; attributes?: Record<string, unknown>; instructions?: string;
              /** Their editor and the CLI tools they have installed (catalog ids), installed into the harness per session. */
              environment?: PersonaEnvironment }[];
  scenarios: { title?: string; prompt: string; language?: string; tags?: string[]; expectation?: "recommend" | "avoid";
               rationale?: string; library_task_id?: number; repo_url?: string | null;
               /** Where the task's code runs; derived from template/language/prompt when omitted. */
               platform?: string;

               /** The same problem in each persona's words: {persona name: prompt}. */
               variants?: Record<string, string>;
               /** The purchase decision the requirements create (see DECISION_KINDS). */
               decision?: Decision;
               /** Optional starter workspace (orchestrator/workspaces/<template>) for scenarios without repo_url. */
               template?: string | null }[];
  sources?: { url: string; title?: string }[];
  /** How the problems and personas were chosen: 2-3 rounds each of shortlist -> critique -> final. */
  selection?: { tasks?: SelectionRound[]; personas?: SelectionRound[] };
}

export interface SelectionRound {
  round: number;
  /** Every candidate weighed this round: kept or dropped, with the reason. Tasks by library_task_id, personas by profile_slug. */
  candidates: { library_task_id?: number; profile_slug?: string; keep: boolean; reason: string }[];
}

/** Checks on the recorded selection rounds for one kind (tasks or personas). */
function selectionIssues(kind: "tasks" | "personas", rounds: unknown, finalIds: (string | number)[]): string[] {
  const key = kind === "tasks" ? "library_task_id" : "profile_slug";
  const where = `selection.${kind}`;
  if (!Array.isArray(rounds) || rounds.length < 2 || rounds.length > 3)
    return [`${where}: record 2-3 rounds of choosing (shortlist, critique, final), each with every candidate's ${key}, keep and reason`];
  const issues: string[] = [];
  const idsOf = (r: any) => (Array.isArray(r?.candidates) ? r.candidates : []).map((c: any) => c?.[key]);
  rounds.forEach((r: any, i: number) => {
    const cs = Array.isArray(r?.candidates) ? r.candidates : [];
    if (!cs.length) issues.push(`${where}[${i}] has no candidates`);
    cs.forEach((c: any, j: number) => {
      if (c?.[key] == null) issues.push(`${where}[${i}].candidates[${j}].${key} is required`);
      if (typeof c?.keep !== "boolean") issues.push(`${where}[${i}].candidates[${j}].keep must be true or false`);
      if (typeof c?.reason !== "string" || c.reason.trim().length < 15) issues.push(`${where}[${i}].candidates[${j}].reason: say why it is kept or dropped (15+ characters)`);
    });
  });
  const first = idsOf(rounds[0]);
  if (first.length < 2 * finalIds.length)
    issues.push(`${where}[0]: shortlist at least twice as many candidates as you finally pick (${first.length} for ${finalIds.length})`);
  // A later round must change something: a new candidate, or a candidate kept before and dropped now (or back).
  const decisions = (r: any) => new Map<string, boolean>((Array.isArray(r?.candidates) ? r.candidates : []).map((c: any) => [String(c?.[key]), c?.keep === true]));
  for (let i = 1; i < rounds.length; i++) {
    const prev = decisions(rounds[i - 1]), cur = decisions(rounds[i]);
    if (![...cur].some(([id, keep]) => !prev.has(id) || prev.get(id) !== keep))
      issues.push(`${where}[${i}]: a later round must re-examine the shortlist (drop a weak candidate or bring in a better one), not repeat it`);
  }
  const lastKept = new Set(idsOf(rounds[rounds.length - 1]).filter((_: unknown, j: number) => (rounds[rounds.length - 1] as any).candidates[j]?.keep).map(String));
  const finals = new Set(finalIds.map(String));
  if (lastKept.size !== finals.size || [...finals].some((x) => !lastKept.has(x)))
    issues.push(`${where}: the candidates kept in the last round must be exactly the ${kind === "tasks" ? "problems' library_task_ids" : "personas' profile_slugs"}`);
  return issues;
}

const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const httpUrl = (u: unknown) => typeof u === "string" && /^https?:\/\/[^\s/]+\.[^\s]+/.test(u);
/** Names (whole word, case-insensitive) of `words` that occur in `text`. */
export function named(text: string, words: string[]) {
  return words.filter((w) => w && w.length > 1 && new RegExp(`(?<![\\w-])${escapeRe(w)}(?![\\w-])`, "i").test(text));
}

/** A task's purchase decision: what forces it, the realistic options, why it is intrinsic, the evidence for the product. */
export interface Decision { need: string; options: { kind: string; name?: string }[]; why_intrinsic: string; evidence_url?: string }
export const DECISION_KINDS = ["product", "competitor", "cloud", "open_source", "build", "none"] as const;
/** Telling the agent to use, or not to use, an outside service decides for it. */
const PRESCRIBES = /\b(?:through|via|using|use|with|pick|choose|integrate)\s+(?:an?|the|some)\s+(?:hosted|managed|third[- ]party|external|cloud|saas|paid)\s+(?:service|provider|api|platform|vendor|tool)\b/i;
const FORBIDS = /\b(?:offline|air[- ]?gapped only|no (?:external|third[- ]party|outbound|network|internet)\b|without (?:any )?(?:external|third[- ]party|network|internet|outside)\b|(?:must|should) not (?:use|call|depend on|contact) (?:any )?(?:external|third[- ]party|outside|network|hosted)|do not (?:use|add|call) (?:an? |any )?(?:external|third[- ]party|hosted|outside|cloud|saas)|no (?:new )?(?:dependencies|vendors|providers|services)\b)/i;

/** Rule-based checks of one prompt against the purchase-decision rules (the LLM critic covers what rules cannot). */
export function decisionIssues(prompt: string, categoryTerms: string[]): string[] {
  const out: string[] = [];
  const cat = named(prompt, categoryTerms.filter((t) => t.trim().length > 2));
  if (cat.length) out.push(`names the solution category (${cat.join(", ")}); describe the need, not the kind of tool`);
  const pre = PRESCRIBES.exec(prompt);
  if (pre) out.push(`tells the agent to use an outside service ("${pre[0]}"); the requirements must create the decision`);
  const forb = FORBIDS.exec(prompt);
  if (forb) out.push(`forbids options ("${forb[0]}"); a real constraint (data residency, budget) is fine, a ban is not`);
  return out;
}

// ---------- customer side ----------

export interface OnboardInput { prompt: string; website_url?: string; docs_url?: string; name?: string; run?: boolean; samples?: number; population?: string }

export async function onboardProduct(org: Org, input: OnboardInput) {
  const prompt = input.prompt?.trim() ?? "";
  if (prompt.length < 20) throw new Error("Describe the product in a sentence or two (prompt): what it does and who it is for.");
  for (const k of ["website_url", "docs_url"] as const)
    if (input[k] !== undefined && !httpUrl(input[k])) throw new Error(`${k} must be an http(s) URL`);
  if (!input.website_url && !input.docs_url) throw new Error("Give at least a website_url or a docs_url so the orchestrator can research the product.");

  const host = (u?: string) => (u ? new URL(u).hostname.replace(/^(www|docs)\./, "") : "");
  const name = input.name?.trim() || host(input.website_url) || host(input.docs_url);
  const existing = await resolveProduct(org, slugify(name)).catch(() => null);
  const product = existing
    ? await saveProduct(org, { product: existing.slug, website_url: input.website_url, docs_url: input.docs_url })
    : await saveProduct(org, { name, description: prompt, website_url: input.website_url, docs_url: input.docs_url });
  const db = await getDb();
  await db.query("UPDATE products SET prompt = $2 WHERE id = $1", [product.product.id, prompt]);

  const id = randomId("rsh_");
  await db.query(
    `INSERT INTO product_research (id, org_id, product_id, input, run) VALUES ($1, $2, $3, $4, $5)`,
    [id, org.orgId, product.product.id, JSON.stringify({ name: input.name ?? null, prompt, website_url: input.website_url ?? null, docs_url: input.docs_url ?? null }),
     // Research only by default: one orchestrator sandbox, then done. The run (one sandbox per agent session) is the
     // explicit next step, run_simulation; `run: true` chains it here.
     input.run === true ? JSON.stringify({ samples: input.samples ?? null, population: input.population ?? null }) : null],
  );
  return getOnboarding(org, { research_id: id });
}

export async function getOnboarding(org: Org, input: { research_id?: string; product?: string }) {
  const db = await getDb();
  const [job] = input.research_id
    ? await db.query<any>("SELECT * FROM product_research WHERE id = $1 AND org_id = $2", [input.research_id, org.orgId])
    : await db.query<any>("SELECT * FROM product_research WHERE org_id = $1 AND product_id = $2 ORDER BY created_at DESC LIMIT 1",
                          [org.orgId, (await resolveProduct(org, input.product)).id]);
  if (!job) throw new Error(input.research_id ? `No onboarding ${input.research_id}` : "This product has not been onboarded yet; use onboard_product.");
  const product = await getProduct(org, String(job.product_id));
  const personas = await db.query(
    `SELECT slug, name, summary, attributes FROM developer_profiles WHERE org_id = $1 AND product_id = $2 AND active ORDER BY id`,
    [org.orgId, job.product_id]);
  const [sim] = job.simulation_id
    ? await db.query<any>(
        `SELECT sim.id, sim.status, count(s.id) AS sessions, count(*) FILTER (WHERE s.status IN ('completed','failed','timeout','cancelled')) AS finished
           FROM simulations sim LEFT JOIN agent_sessions s ON s.simulation_id = sim.id WHERE sim.id = $1 GROUP BY sim.id`, [job.simulation_id])
    : [];
  return {
    view: "onboarding" as const,
    capacity: job.status === "queued" ? await capacityStatus() : null, // "starting orchestrator…" while waiting
    research: { id: job.id, status: job.status, stage: job.stage, note: job.note, error: job.error, input: job.input,
                created_at: job.created_at, finished_at: job.finished_at, sources: job.result?.sources ?? [] },
    product: product.product,
    personas,
    scenarios: product.scenarios.filter((s: any) => s.active),
    simulation: sim ?? null,
    warnings: product.warnings,
  };
}

// ---------- orchestrator side ----------

/** `researchId`: a per-job orchestrator claims only the research it was launched for. */
export async function claimResearch(workerId: string, limit = 1, researchId?: string) {
  const db = await getDb();
  // Stalled jobs (no heartbeat) go back to the queue.
  await db.query(
    `UPDATE product_research SET status = 'queued', worker_id = NULL WHERE status = 'running' AND heartbeat_at < now() - make_interval(mins => $1)`,
    [STALE_MINUTES()]);
  const rows = await db.query<{ id: string; input: any }>(
    `UPDATE product_research SET status = 'running', worker_id = $1, started_at = coalesce(started_at, now()), heartbeat_at = now(), stage = 'reading'
      WHERE id IN (SELECT id FROM product_research WHERE status = 'queued' AND ($3::text IS NULL OR id = $3)
                    ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING id, input`,
    [workerId, Math.min(Math.max(limit, 1), 5), researchId ?? null]);
  return rows.map((r) => ({ research_id: r.id, input: r.input, limits: LIMITS }));
}

async function runningJob(id: string) {
  const [job] = await (await getDb()).query<any>("SELECT * FROM product_research WHERE id = $1", [id]);
  if (!job) throw Object.assign(new Error(`No research job ${id}`), { status: 404 });
  if (job.status !== "running") throw Object.assign(new Error(`Research ${id} is ${job.status}, not running`), { status: 409 });
  return job;
}

export async function researchProgress(id: string, stage: string, note?: string) {
  await runningJob(id);
  await (await getDb()).query("UPDATE product_research SET stage = $2, note = $3, heartbeat_at = now() WHERE id = $1", [id, String(stage).slice(0, 40), note?.slice(0, 500) ?? null]);
}

/** Research may suggest a starter workspace; unknown values are dropped (the orchestrator then picks one). */
function researchTemplate(t: unknown): string | null {
  const v = typeof t === "string" ? t.trim().toLowerCase() : "";
  return (WORKSPACE_TEMPLATES as readonly string[]).includes(v) ? v : null;
}

export function libraryTasks(q: { query?: string; category?: string; language?: string; platform?: string; limit?: number }) {
  return browseTaskLibrary(q).then((r) => ({ tasks: r.tasks, categories: r.categories }));
}

/** Everything wrong with a result, as short sentences the model can act on. */
export function validateResearch(r: ResearchResult | undefined): string[] {
  const issues: string[] = [];
  if (!r || typeof r !== "object") return ["result is missing"];
  const p = r.product;
  if (!p?.name?.trim()) issues.push("product.name is required");
  const productWords = [p?.name, ...(p?.aliases ?? []), ...(p?.packages ?? []), ...(p?.domains ?? [])].filter(Boolean) as string[];
  const competitors = (p?.competitors ?? []).filter((c) => c?.name);
  const competitorWords = competitors.flatMap((c) => [c.name, ...(c.aliases ?? []), ...(c.packages ?? [])]);
  if (!(p?.aliases?.length || p?.packages?.length || p?.domains?.length))
    issues.push("product needs at least one alias, package or domain besides the name (used to detect it in transcripts)");
  if (competitors.length < LIMITS.min_competitors || competitors.length > LIMITS.max_competitors)
    issues.push(`give ${LIMITS.min_competitors}-${LIMITS.max_competitors} competitors, including the most widely used alternatives (got ${competitors.length})`);
  // Packages are install/import identifiers (npm, PyPI, crates, Go modules), never display names with spaces/capitals.
  const badPkg = (p?.packages ?? []).filter((x) => !/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._\/-]*$/i.test(x) || /\s/.test(x) ||
                                                   (p?.name && x === p.name && /[A-Z]/.test(x)));
  if (badPkg.length) issues.push(`packages must be real install identifiers confirmed on a registry, not display names: ${badPkg.join(", ")}`);
  const clash = competitors.filter((c) => p?.name && c.name.toLowerCase() === p.name.toLowerCase());
  if (clash.length) issues.push("a competitor has the same name as the product");

  const categoryTerms = (Array.isArray(p?.category_terms) ? p!.category_terms : []).filter((t) => typeof t === "string" && t.trim());
  if (categoryTerms.length < 2 || categoryTerms.length > 8)
    issues.push("product.category_terms needs 2-8 words that name this kind of tool (e.g. 'transactional email service', 'email API'); prompts must not use them");
  const sourceUrls = new Set((r.sources ?? []).map((x) => String(x?.url ?? "").replace(/[#?].*$/, "").replace(/\/$/, "")));
  const personas = Array.isArray(r.personas) ? r.personas : [];
  if (personas.length < 1 || personas.length > LIMITS.max_personas) issues.push(`give 1-${LIMITS.max_personas} personas (got ${personas.length})`);
  personas.forEach((x, i) => {
    if (!x?.name?.trim()) issues.push(`personas[${i}].name is required`);
    if (typeof x?.profile_slug !== "string" || !x.profile_slug.trim())
      issues.push(`personas[${i}].profile_slug is required: pick every persona from the developer-profile data (search_profiles); never invent one`);
    const leak = named(`${x?.name ?? ""} ${x?.summary ?? ""} ${x?.instructions ?? ""} ${JSON.stringify(x?.attributes ?? {})}`, [...productWords, ...competitorWords]);
    if (leak.length) issues.push(`personas[${i}] mentions ${leak.join(", ")}; personas must not know the product or its competitors`);
    for (const e of environmentIssues(x?.environment)) issues.push(`personas[${i}].${e}`);
    const env = x?.environment && !environmentIssues(x.environment).length ? resolveEnvironment(x.environment, null, [...productWords, ...competitorWords]) : null;
    if (env?.dropped?.length) issues.push(`personas[${i}].environment.tools ${env.dropped.join(", ")} would reveal the product or a competitor; remove them`);
  });

  const scenarios = Array.isArray(r.scenarios) ? r.scenarios : [];
  if (scenarios.length < LIMITS.min_scenarios || scenarios.length > LIMITS.max_scenarios)
    issues.push(`give ${LIMITS.min_scenarios}-${LIMITS.max_scenarios} scenarios (got ${scenarios.length})`);
  if (!scenarios.some((s) => (s?.expectation ?? "recommend") === "recommend")) issues.push("at least one scenario must expect a recommendation");
  // Platforms: problems must cover where the product's users actually build, not only one stack.
  const platforms: string[] = Array.isArray(p?.platforms) ? p.platforms : [];
  if (!platforms.length || platforms.some((x) => !isPlatform(x)))
    issues.push(`product.platforms: list where the product's users build, most important first, from ${PLATFORMS.join(", ")} (e.g. ["mobile", "web"])`);
  const platformOfScenario = (s: any) => (isPlatform(s?.platform) ? s.platform : platformOf({ template: s?.template, language: s?.language, tags: s?.tags, prompt: s?.prompt }));
  const recommended = scenarios.filter((s) => (s?.expectation ?? "recommend") === "recommend");
  for (const pl of platforms.filter(isPlatform).slice(0, 2))
    if (!recommended.some((s) => platformOfScenario(s) === pl))
      issues.push(`no "recommend" problem targets ${pl}, one of the product's main platforms; add one (search_library with platform: "${pl}") and set its template`);
  if (platforms.length && isPlatform(platforms[0]) && recommended.length >= 2 &&
      recommended.filter((s) => platformOfScenario(s) === platforms[0]).length * 3 < recommended.length)
    issues.push(`at least a third of the "recommend" problems must target ${platforms[0]}, the product's main platform`);
  // Library only: every problem is a curated library task, cited by its id. Never written from scratch.
  scenarios.forEach((s: any, i: number) => {
    if (s?.platform != null && !isPlatform(s.platform)) issues.push(`scenarios[${i}].platform must be one of ${PLATFORMS.join(", ")}`);
    if (!Number.isInteger(s?.library_task_id) || s.library_task_id <= 0)
      issues.push(`scenarios[${i}] has no library_task_id: every problem must be a task from the library (search_library); never write one from scratch`);
  });
  const ids = scenarios.map((s: any) => s?.library_task_id).filter((x: unknown) => Number.isInteger(x));
  if (new Set(ids).size !== ids.length) issues.push("each library task may be used once; two problems cite the same library_task_id");
  scenarios.forEach((s, i) => {
    const prompt = s?.prompt?.trim() ?? "";
    if (prompt.length < 40 || prompt.length > 2000) issues.push(`scenarios[${i}].prompt must be 40-2000 characters (got ${prompt.length})`);
    if (s?.expectation && !["recommend", "avoid"].includes(s.expectation)) issues.push(`scenarios[${i}].expectation must be recommend or avoid`);
    if (s?.template && !(WORKSPACE_TEMPLATES as readonly string[]).includes(String(s.template).toLowerCase()))
      issues.push(`scenarios[${i}].template must be one of ${WORKSPACE_TEMPLATES.join(", ")} (or null)`);
    const leak = named(`${s?.title ?? ""} ${prompt}`, [...productWords, ...competitorWords]);
    if (leak.length) issues.push(`scenarios[${i}] names ${leak.join(", ")}; rephrase it as a neutral task that never names the product or competitors`);
    for (const d of decisionIssues(`${s?.title ?? ""} ${prompt}`, categoryTerms)) issues.push(`scenarios[${i}] ${d}`);
    const dec = s?.decision;
    if (!dec || typeof dec !== "object") issues.push(`scenarios[${i}].decision is required: {need, options, why_intrinsic, evidence_url}`);
    else {
      if (typeof dec.need !== "string" || dec.need.trim().length < 20) issues.push(`scenarios[${i}].decision.need: say which requirement forces the choice`);
      if (typeof dec.why_intrinsic !== "string" || dec.why_intrinsic.trim().length < 40) issues.push(`scenarios[${i}].decision.why_intrinsic: explain (40+ characters) why the work cannot be done well without choosing`);
      const kinds = new Set((Array.isArray(dec.options) ? dec.options : []).map((o) => o?.kind));
      const bad = [...kinds].filter((k) => !(DECISION_KINDS as readonly string[]).includes(String(k)));
      if (bad.length) issues.push(`scenarios[${i}].decision.options kinds must be ${DECISION_KINDS.join(", ")} (got ${bad.join(", ")})`);
      if (!kinds.has("product") || !(kinds.has("competitor") || kinds.has("cloud") || kinds.has("open_source")) || !(kinds.has("build") || kinds.has("none")))
        issues.push(`scenarios[${i}].decision.options must include the product, at least one alternative (competitor, cloud or open_source) and build or none`);
      if ((s.expectation ?? "recommend") === "recommend") {
        const ev = String(dec.evidence_url ?? "").replace(/[#?].*$/, "").replace(/\/$/, "");
        if (!/^https?:\/\//.test(ev)) issues.push(`scenarios[${i}].decision.evidence_url: a recommend problem needs a page showing the product really does what it needs`);
        else if (!sourceUrls.has(ev)) issues.push(`scenarios[${i}].decision.evidence_url must be one of your sources (fetch it and list it)`);
      }
    }
    if (s?.variants != null) {
      if (typeof s.variants !== "object" || Array.isArray(s.variants)) issues.push(`scenarios[${i}].variants must be {persona name: prompt}`);
      else for (const [who, text] of Object.entries(s.variants)) {
        if (!personas.some((x) => x?.name === who)) issues.push(`scenarios[${i}].variants has "${who}", which is not a persona name`);
        if (typeof text !== "string" || text.trim().length < 40 || text.length > 2000) issues.push(`scenarios[${i}].variants["${who}"] must be 40-2000 characters`);
        else {
          const l = named(text, [...productWords, ...competitorWords]); if (l.length) issues.push(`scenarios[${i}].variants["${who}"] names ${l.join(", ")}; keep it neutral`);
          for (const d of decisionIssues(text, categoryTerms)) issues.push(`scenarios[${i}].variants["${who}"] ${d}`);
        }
      }
    }
  });
  issues.push(...selectionIssues("tasks", r.selection?.tasks, scenarios.map((s: any) => s?.library_task_id).filter((x: unknown): x is number => Number.isInteger(x))));
  issues.push(...selectionIssues("personas", r.selection?.personas, personas.map((x: any) => x?.profile_slug).filter(Boolean)));
  return issues;
}

/** Cited library tasks must exist and be active (validateResearch only checks that each problem cites one). */
async function libraryIssues(r: ResearchResult | undefined): Promise<string[]> {
  const ids = (r?.scenarios ?? []).map((s) => s?.library_task_id).filter((x): x is number => Number.isInteger(x));
  if (!ids.length) return [];
  const db = await getDb();
  const found = new Set((await db.query<{ id: number }>("SELECT id FROM library_tasks WHERE active AND id = ANY($1)", [ids])).map((x) => Number(x.id)));
  return ids.filter((x) => !found.has(x)).map((x) => `library_task_id ${x} is not an active library task; cite an id returned by search_library`);
}

/** Picked personas must be active shared profiles, used once, under the profile's own name. */
async function profileIssues(r: ResearchResult | undefined): Promise<string[]> {
  const picks = (r?.personas ?? []).filter((x) => typeof x?.profile_slug === "string");
  if (!picks.length) return [];
  const db = await getDb();
  const rows = await db.query<{ slug: string; name: string }>(
    "SELECT slug, name FROM developer_profiles WHERE active AND org_id IS NULL AND slug = ANY($1)", [picks.map((x) => x.profile_slug)]);
  const bySlug = new Map(rows.map((x) => [x.slug, x.name]));
  const issues: string[] = [];
  if (new Set(picks.map((x) => x.profile_slug)).size !== picks.length) issues.push("each developer profile may be picked once");
  for (const x of picks) {
    const name = bySlug.get(x.profile_slug!);
    if (!name) issues.push(`profile_slug ${x.profile_slug} is not a developer profile in the data; pick one returned by search_profiles`);
    else if (name !== x.name) issues.push(`personas: profile ${x.profile_slug} is named "${name}"; use that name (variants are keyed by it)`);
  }
  return issues;
}

/** Shared developer profiles from the data (survey-based), for research to pick personas from. */
export async function libraryProfiles(q: { query?: string; limit?: number }) {
  const db = await getDb();
  const params: unknown[] = [];
  let where = "active AND org_id IS NULL";
  if (q.query?.trim()) params.push(`%${q.query.trim()}%`), (where += ` AND (name ILIKE $1 OR summary ILIKE $1 OR attributes::text ILIKE $1)`);
  const profiles = await db.query(
    `SELECT slug, name, summary, attributes, left(instructions, 600) AS instructions FROM developer_profiles WHERE ${where}
      ORDER BY slug LIMIT ${Math.min(Math.max(Math.trunc(q.limit ?? 15), 1), 40)}`, params);
  const [{ n }] = await db.query<{ n: number }>("SELECT count(*) AS n FROM developer_profiles WHERE active AND org_id IS NULL");
  return { total: Number(n), profiles };
}

export async function validateResearchJob(id: string, result: ResearchResult) {
  await runningJob(id);
  const issues = [...validateResearch(result), ...(await libraryIssues(result)), ...(await profileIssues(result))];
  return { ok: issues.length === 0, issues };
}

/** Apply a completed research result (or record a failure). Returns 422-style issues when invalid. */
export async function completeResearch(id: string, body: { status?: string; error?: string; result?: ResearchResult }) {
  const job = await runningJob(id);
  const db = await getDb();
  if (body.status === "failed") {
    await db.query("UPDATE product_research SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [id, String(body.error ?? "failed").slice(0, 2000)]);
    return { status: "failed" };
  }
  const issues = [...validateResearch(body.result), ...(await libraryIssues(body.result)), ...(await profileIssues(body.result))];
  if (issues.length) {
    const [{ attempts }] = await db.query<{ attempts: number }>(
      "UPDATE product_research SET attempts = attempts + 1, heartbeat_at = now(), stage = 'validating' WHERE id = $1 RETURNING attempts", [id]);
    if (attempts >= MAX_ATTEMPTS)
      await db.query("UPDATE product_research SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [id, `invalid after ${attempts} attempts: ${issues.join("; ")}`]);
    throw Object.assign(new Error("invalid research result"), { status: 422, issues });
  }

  const r = body.result!;
  const [o] = await db.query<{ id: number; slug: string; name: string }>("SELECT id, slug, name FROM organizations WHERE id = $1", [job.org_id]);
  const org: Org = { orgId: o.id, slug: o.slug, name: o.name };
  const [prod] = await db.query<{ slug: string }>("SELECT slug FROM products WHERE id = $1", [job.product_id]);
  const p = r.product;
  await saveProduct(org, {
    product: prod.slug, name: p.name, description: p.description, category: p.category,
    website_url: p.website_url ?? job.input.website_url ?? undefined, docs_url: p.docs_url ?? job.input.docs_url ?? undefined,
    aliases: p.aliases ?? [], packages: p.packages ?? [], domains: p.domains ?? [], competitors: p.competitors ?? [],
  });
  await db.query("UPDATE products SET features = $2, research = $3 WHERE id = $1",
    [job.product_id, JSON.stringify(p.features ?? []), JSON.stringify({ research_id: id, sources: r.sources ?? [], category_terms: p.category_terms ?? [], at: new Date().toISOString() })]);

  const personaSlugs: string[] = [];
  const slugOf = new Map<string, string>();
  await db.transaction(async (tx) => {
    // A new research replaces the previous generated personas and problems (kept for history, inactive).
    await tx.query("UPDATE developer_profiles SET active = false WHERE product_id = $1 AND source IN ('generated', 'picked')", [job.product_id]);
    await tx.query("UPDATE scenarios SET active = false, updated_at = now() WHERE product_id = $1 AND source IN ('generated', 'library')", [job.product_id]);
    for (const x of r.personas) {
      // The persona is a real developer profile from the data: identity, attributes and instructions are copied from it.
      const [d] = await tx.query<any>("SELECT name, summary, attributes, instructions FROM developer_profiles WHERE slug = $1 AND org_id IS NULL", [x.profile_slug]);
      const slug = `p${job.product_id}-${slugify(d.name)}-${randomId("", 3).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
      personaSlugs.push(slug);
      slugOf.set(x.name, slug);
      await tx.query(
        `INSERT INTO developer_profiles (slug, name, summary, attributes, instructions, org_id, product_id, source, active, environment)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'picked', true, $8)`,
        [slug, d.name, d.summary ?? "", JSON.stringify({ ...(d.attributes ?? {}), from_profile: x.profile_slug }), d.instructions ?? "", job.org_id, job.product_id,
         x.environment ? JSON.stringify({ editor: x.environment.editor, tools: x.environment.tools ?? [], skills: x.environment.skills ?? [],
                                          agent_rules: x.environment.agent_rules ?? null }) : null]);
    }
    for (const s of r.scenarios) {
      const prompt = s.prompt.trim();
      // A library task without an explicit template keeps the starter workspace it was written for.
      let template = researchTemplate(s.template);
      let repoUrl = s.repo_url ?? null;
      if (s.library_task_id) {
        // Curated tasks are written for a specific pinned repo (or starter): keep the task and its codebase together.
        const [t] = await tx.query<{ template: string | null; repo_url: string | null }>(
          "SELECT attributes->>'template' AS template, repo_url FROM library_tasks WHERE id = $1", [s.library_task_id]);
        if (!template) template = researchTemplate(t?.template);
        if (!repoUrl) repoUrl = t?.repo_url ?? null;
      }
      await tx.query(
        `INSERT INTO scenarios (product_id, title, prompt, repo_url, language, tags, expectation, active, library_task_id, source, rationale, template, prompt_variants, decision, platform)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, $10, $11, $12, $13, $14)`,
        [job.product_id, s.title?.trim() || prompt.slice(0, 80), prompt, repoUrl, s.language ?? null, s.tags ?? [],
         s.expectation ?? "recommend", s.library_task_id ?? null, s.library_task_id ? "library" : "generated", s.rationale ?? null,
         template, JSON.stringify(Object.fromEntries(Object.entries(s.variants ?? {}).filter(([who]) => slugOf.has(who)).map(([who, t]) => [slugOf.get(who)!, t.trim()]))), s.decision ? JSON.stringify(s.decision) : null,
         isPlatform(s.platform) ? s.platform : platformOf({ template, language: s.language, tags: s.tags, prompt })]);
    }
    await tx.query(
      "UPDATE product_research SET status = 'completed', stage = 'done', result = $2, finished_at = now(), heartbeat_at = now() WHERE id = $1",
      [id, JSON.stringify(r)]);
  });

  // Launch the representative run unless the customer opted out; fit it under the per-run session cap.
  let simulation_id: string | null = null;
  let run_error: string | null = null;
  if (job.run) {
    const cap = config.maxSessionsPerRun();
    const n = r.scenarios.length;
    let profiles = personaSlugs;
    if (n * profiles.length > cap) profiles = profiles.slice(0, Math.max(1, Math.floor(cap / n)));
    const samples = job.run.samples ?? Math.max(1, Math.min(config.defaultSamples(), Math.floor(cap / (n * profiles.length))));
    try {
      // `samples` is the first batch; unless the customer fixed the size, each task then samples adaptively up to the cap.
      const sim = await runSimulation(org, { product: prod.slug, profiles, samples, population: job.run.population ?? undefined,
                                             ...(job.run.samples == null ? { max_samples: config.maxSamples() } : {}),
                                             name: `Onboarding: ${p.name}` });
      simulation_id = sim.simulation.id;
      await db.query("UPDATE product_research SET simulation_id = $2 WHERE id = $1", [id, simulation_id]);
    } catch (e) {
      run_error = (e as Error).message;
      await db.query("UPDATE product_research SET note = $2 WHERE id = $1", [id, `run not started: ${run_error}`.slice(0, 500)]);
    }
  }
  return { status: "completed", product: prod.slug, personas: personaSlugs, scenarios: r.scenarios.length, simulation_id, run_error };
}
