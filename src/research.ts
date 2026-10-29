import { urlKey, webSearchEnabled } from "./websearch.js";
import { registryLinks } from "./registry-meta.js";
import { asPlatform } from "./tenant-scope.js";
import { isIP } from "node:net";
import { getDb } from "./db.js";
import { checkLaunchRole } from "./limits.js";
import { companyHintForResearch } from "./context.js";
import { completeProspect, prospectIssues } from "./prospect.js";
import { capture, orgEvent } from "./telemetry.js";
import { randomId, type Org } from "./auth.js";
import { NO_PLAN, WORKSPACE_TEMPLATES, config, getProduct, resolveProduct, runSimulation, saveProduct, browseTaskLibrary } from "./queries.js";
import { sessionsLimit } from "./limits.js";
import { orgBudget } from "./billing.js";
import { PLATFORMS, isPlatform, platformOf } from "./platform.js";
import type { Tool } from "./scoring.js";
import { capacityStatus } from "./autoscaler.js";
import { environmentIssues, resolveEnvironment, type PersonaEnvironment } from "../orchestrator/core/environment.js";
import { NO_ELIGIBLE_PERSONAS, audienceFormIssues, effectiveAudience, eligibleSearch, hardSql, personaSupplyQuestion, pickIssues, urlNorm, type Audience, type AudienceGap } from "./audience.js";
import { REGIONS, SECTORS, countryOfWord, countryTexts, isIndustry, isIso2, isRegion, isSector, mentionsCountry, INDUSTRIES } from "./facets.js";

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
             aliases?: string[]; packages?: string[]; domains?: string[]; competitors?: Tool[];
             /** Where the product sits in a developer's stack (orchestrator/pi-octillion/architect.ts). */
             placement?: { layer?: string; runs_on_it?: string[]; used_with?: string[]; adoption_signals?: string[] };
             /** Tools the architecture review judged not to compete (complements, other layers): never merged back in. */
             not_competitors?: { name: string; relation: string; reason?: string }[];
             /** Who may use the product (src/audience.ts): global unless a fetched page restricts it. Personas must fit it. */
             audience?: Audience };
  /** Nobody in the developer-profile data fits the audience's hard parts: what was searched (personas is then []). */
  audience_gap?: AudienceGap;
  /** What the architecture review could not settle: asked of the customer (product_questions, src/questions.ts). */
  questions?: { kind: "competitor_relation" | "audience"; subject: string; question: string;
                options: { id: string; label: string; relation?: string; value?: Record<string, unknown> }[]; context?: Record<string, unknown> }[];
  /** Picked from the shared developer-profile data (search_profiles): the profile's slug; its name, summary,
   *  attributes and instructions are copied from the data, never written by research. */
  personas: { profile_slug?: string; name: string; summary?: string; attributes?: Record<string, unknown>; instructions?: string;
              /** Their editor and the CLI tools they have installed (catalog ids), installed into the harness per session. */
              environment?: PersonaEnvironment }[];
  scenarios: { title?: string; prompt: string; language?: string; tags?: string[]; expectation?: "recommend" | "avoid";
               rationale?: string; library_task_id?: number; repo_url?: string | null;
               /** Where the task's code runs; derived from template/language/prompt when omitted. */
               platform?: string;

               /** A problem written for a need the library does not cover: saved inactive until the customer approves it. */
               draft?: boolean;
               /** For a draft: the library searches that were run and why no task fit. */
               library_check?: string;
               /** The same problem in each persona's words: {persona name: prompt}. */
               variants?: Record<string, string>;
               /** The purchase decision the requirements create (see DECISION_KINDS). */
               decision?: Decision;
               /** Optional starter workspace (orchestrator/workspaces/<template>) for scenarios without repo_url. */
               template?: string | null }[];
  sources?: { url: string; title?: string }[];
  /** How the problems and personas were chosen: a shortlist, then critique rounds until a round changes nothing. */
  selection?: { tasks?: SelectionRound[]; personas?: SelectionRound[] };
}

/** Safety cap on selection rounds; research normally converges well before it. */
export const MAX_SELECTION_ROUNDS = 12;

export interface SelectionRound {
  round: number;
  /** Set on the last round only: a full critique found nothing to change. */
  converged?: boolean;
  /** On the converged round: what was checked to be sure the set is right. */
  why?: string;
  /** Every candidate weighed this round: kept or dropped, with the reason. Tasks by library_task_id, personas by profile_slug. */
  candidates: { library_task_id?: number; profile_slug?: string; keep: boolean; reason: string }[];
}

/**
 * Checks on the recorded selection rounds for one kind (tasks or personas). Research iterates until it is convinced:
 * a shortlist, then critique rounds that each change something, then a round that changes nothing (converged).
 */
function selectionIssues(kind: "tasks" | "personas", rounds: unknown, finalIds: (string | number)[]): string[] {
  const key = kind === "tasks" ? "library_task_id" : "profile_slug";
  const where = `selection.${kind}`;
  if (!Array.isArray(rounds) || rounds.length < 3 || rounds.length > MAX_SELECTION_ROUNDS)
    return [`${where}: record every round of choosing (at least 3, at most ${MAX_SELECTION_ROUNDS}): a shortlist, critique rounds that revise it, ` +
            `and a last round that changes nothing (converged: true, why), each with every candidate's ${key}, keep and reason`];
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
  // Every round between the first and the last revises the set: a new candidate, or a decision reversed. The last
  // round is the one where a full critique changed nothing: same kept set as before, marked converged with a reason.
  const decisions = (r: any) => new Map<string, boolean>((Array.isArray(r?.candidates) ? r.candidates : []).map((c: any) => [String(c?.[key]), c?.keep === true]));
  const kept = (r: any) => [...decisions(r)].filter(([, k]) => k).map(([id]) => id).sort().join(",");
  const last = rounds.length - 1;
  for (let i = 1; i < last; i++) {
    const prev = decisions(rounds[i - 1]), cur = decisions(rounds[i]);
    if (![...cur].some(([id, keep]) => !prev.has(id) || prev.get(id) !== keep))
      issues.push(`${where}[${i}]: a critique round must revise the set (drop a weak candidate or bring in a better one); stop only when a round changes nothing`);
    if ((rounds[i] as any)?.converged) issues.push(`${where}[${i}]: only the last round is converged`);
  }
  const end: any = rounds[last];
  if (end?.converged !== true || typeof end?.why !== "string" || end.why.trim().length < 30)
    issues.push(`${where}[${last}]: the last round must be converged: true with why (30+ characters): what you checked to be sure the set is right`);
  else if (kept(end) !== kept(rounds[last - 1]))
    issues.push(`${where}[${last}]: the converged round changed the set; keep iterating until a full critique changes nothing`);
  const lastKept = new Set(idsOf(rounds[rounds.length - 1]).filter((_: unknown, j: number) => (rounds[rounds.length - 1] as any).candidates[j]?.keep).map(String));
  const finals = new Set(finalIds.map(String));
  if (lastKept.size !== finals.size || [...finals].some((x) => !lastKept.has(x)))
    issues.push(`${where}: the candidates kept in the last round must be exactly the ${kind === "tasks" ? "problems' library_task_ids" : "personas' profile_slugs"}`);
  return issues;
}

const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A public http(s) URL with a host name: no IP literals, localhost or internal names (research fetches it). */
const httpUrl = (u: unknown) => {
  if (typeof u !== "string" || !/^https?:\/\/[^\s/]+\.[^\s]+/.test(u)) return false;
  try {
    const h = new URL(u).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return !isIP(h) && !/(^|\.)(localhost|local|internal|localdomain)$/.test(h) && /\.[a-z]{2,}$/.test(h);
  } catch { return false; }
};
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

export interface OnboardInput { prompt: string; website_url?: string; docs_url?: string; name?: string; run?: boolean; samples?: number; population?: string;
                              /** Who can use the product, in the customer's words: research sets product.audience to it, saved as confirmed by them. */
                              audience?: string }

export async function onboardProduct(org: Org, input: OnboardInput) {
  const prompt = input.prompt?.trim() ?? "";
  if (prompt.length < 20) throw new Error("Describe the product in a sentence or two (prompt): what it does and who it is for.");
  for (const k of ["website_url", "docs_url"] as const)
    if (input[k] !== undefined && !httpUrl(input[k])) throw new Error(`${k} must be a public http(s) URL with a host name (not an IP address)`);
  if (!input.website_url && !input.docs_url) throw new Error("Give at least a website_url or a docs_url so the orchestrator can research the product.");
  await checkLaunchRole(org); // viewers read; they don't onboard
  // Research runs on Octillion's models: only accounts with a prepaid plan or an allowance may start it.
  if ((await orgBudget(org.orgId).catch(() => ({ budget: 0 }))).budget <= 0) throw new Error(NO_PLAN(org.name));
  // A registry page (PyPI, npm, crates.io) rarely holds the docs: add the package's own links from its metadata.
  const relatedUrls = await registryLinks([input.website_url, input.docs_url]);

  const host = (u?: string) => (u ? new URL(u).hostname.replace(/^(www|docs)\./, "") : "");
  const name = input.name?.trim() || host(input.website_url) || host(input.docs_url);
  const existing = await resolveProduct(org, slugify(name)).catch(() => null);
  const product = existing
    ? await saveProduct(org, { product: existing.slug, website_url: input.website_url, docs_url: input.docs_url })
    : await saveProduct(org, { name, description: prompt, website_url: input.website_url, docs_url: input.docs_url });
  const db = await getDb();
  await db.query("/* tenant: product from saveProduct(org) / resolveProduct(org) */ UPDATE products SET prompt = $2 WHERE id = $1", [product.product.id, prompt]);

  const audience = typeof input.audience === "string" && input.audience.trim() ? input.audience.trim().slice(0, 1000) : null;
  const id = await queueResearch(org.orgId, product.product.id,
    // The company's own context (src/context.ts) rides along with the prompt, so research starts from what they know.
    { name: input.name ?? null, prompt: prompt + (await companyHintForResearch(org.orgId, { audience: audience ?? undefined }).catch(() => "")),
      website_url: input.website_url ?? null, docs_url: input.docs_url ?? null, related_urls: relatedUrls, ...(audience ? { audience } : {}) },
    // Research only by default: one orchestrator sandbox, then done. The run (one sandbox per agent session) is the
    // explicit next step, run_simulation; `run: true` chains it here.
    input.run === true ? { samples: input.samples ?? null, population: input.population ?? null } : null);
  return getOnboarding(org, { research_id: id });
}

/** Queue a product research job (onboarding, or again after the customer confirmed the audience: src/questions.ts). */
export async function queueResearch(orgId: number, productId: number, input: Record<string, unknown>, run: Record<string, unknown> | null = null): Promise<string> {
  const id = randomId("rsh_");
  await (await getDb()).query(`INSERT INTO product_research (id, org_id, product_id, input, run) VALUES ($1, $2, $3, $4, $5)`,
    [id, orgId, productId, JSON.stringify(input), run ? JSON.stringify(run) : null]);
  return id;
}

export async function getOnboarding(org: Org, input: { research_id?: string; product?: string }) {
  const db = await getDb();
  const [job] = input.research_id
    ? await db.query<any>("SELECT * FROM product_research WHERE id = $1 AND org_id = $2", [input.research_id, org.orgId])
    : await db.query<any>("SELECT * FROM product_research WHERE org_id = $1 AND product_id = $2 ORDER BY created_at DESC LIMIT 1",
                          [org.orgId, (await resolveProduct(org, input.product)).id]);
  if (!job) throw new Error(input.research_id ? `No onboarding ${input.research_id}` : "This product has not been onboarded yet; use onboard_product.");
  const product = await getProduct(org, String(job.product_id));
  // The product's own personas, then the library personas linked to it (product_personas).
  const personas = await db.query(
    `SELECT slug, name, summary, attributes FROM developer_profiles WHERE org_id = $1 AND product_id = $2 AND active
     UNION ALL
     SELECT dp.slug, dp.name, dp.summary, dp.attributes FROM product_personas pp JOIN developer_profiles dp ON dp.id = pp.profile_id AND dp.org_id IS NULL
      JOIN products p ON p.id = pp.product_id AND p.org_id = $1 WHERE pp.product_id = $2 AND pp.active`,
    [org.orgId, job.product_id]);
  const [sim] = job.simulation_id
    ? await db.query<any>(
        `/* tenant: simulation of a research row already read with org_id = the caller's org */ SELECT sim.id, sim.status, count(s.id) AS sessions, count(*) FILTER (WHERE s.status IN ('completed','failed','timeout','cancelled')) AS finished
           FROM simulations sim LEFT JOIN agent_sessions s ON s.simulation_id = sim.id WHERE sim.id = $1 GROUP BY sim.id`, [job.simulation_id])
    : [];
  const drafts = product.scenarios.filter((s: any) => s.source === "draft" && !s.active);
  const active = product.scenarios.filter((s: any) => s.active);
  return {
    view: "onboarding" as const,
    capacity: job.status === "queued" ? await capacityStatus() : null, // "starting orchestrator…" while waiting
    // The raw validator output stays internal; customers get what went wrong and what to do, in plain words.
    research: { id: job.id, status: job.status, stage: job.stage, note: job.note, input: job.input,
                created_at: job.created_at, finished_at: job.finished_at, sources: job.result?.sources ?? [] },
    failure: job.status === "failed" ? onboardingFailure(job, product.product.slug) : null,
    next_step: job.status === "completed" && !sim && active.length
      ? await firstRunOffer(product.product.slug, active.length, personas.map((x: any) => x.slug)) : null,
    drafts,
    product: product.product,
    personas,
    scenarios: active,
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
    `/* tenant: internal: requeue stalled research across all orgs */ UPDATE product_research SET status = 'queued', worker_id = NULL WHERE status = 'running' AND heartbeat_at < now() - make_interval(mins => $1)`,
    [STALE_MINUTES()]);
  const rows = await db.query<{ id: string; input: any; kind: string }>(
    `/* tenant: claim: a job token is pinned to its own research in http.ts, fleet claims across orgs */ UPDATE product_research SET status = 'running', worker_id = $1, started_at = coalesce(started_at, now()), heartbeat_at = now(), stage = 'reading'
      WHERE id IN (SELECT id FROM product_research WHERE status = 'queued' AND ($3::text IS NULL OR id = $3)
                    ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING id, input, kind`,
    [workerId, Math.min(Math.max(limit, 1), 5), researchId ?? null]);
  return rows.map((r) => (r.kind === "prospect" ? { research_id: r.id, kind: r.kind, input: r.input } : { research_id: r.id, kind: "product", input: r.input, limits: LIMITS }));
}

async function runningJob(id: string) {
  const [job] = await (await getDb()).query<any>("/* tenant: research id checked against the job token in http.ts (/research/:id) */ SELECT * FROM product_research WHERE id = $1", [id]);
  if (!job) throw Object.assign(new Error(`No research job ${id}`), { status: 404 });
  if (job.status !== "running") throw Object.assign(new Error(`Research ${id} is ${job.status}, not running`), { status: 409 });
  return job;
}

export async function researchProgress(id: string, stage: string, note?: string) {
  await runningJob(id);
  await (await getDb()).query("/* tenant: research id checked against the job token in http.ts (/research/:id) */ UPDATE product_research SET stage = $2, note = $3, heartbeat_at = now() WHERE id = $1", [id, String(stage).slice(0, 40), note?.slice(0, 500) ?? null]);
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
  const all = (p?.competitors ?? []).filter((c) => c?.name);
  // The buy-vs-build route (self_hosted / build) is always added on top of the vendors: it is not counted against them.
  const competitors = all.filter((c) => c.kind !== "self_hosted" && c.kind !== "build");
  const competitorWords = all.flatMap((c) => [c.name, ...(c.aliases ?? []), ...(c.packages ?? [])]);
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
  const sourceUrls = new Set((r.sources ?? []).map((x) => urlNorm(x?.url)));
  // Who may use the product: global by default; any restriction quotes a page this job fetched.
  // (An audience the customer stated at onboarding needs no page: audienceIssues checks they did state one.)
  issues.push(...audienceFormIssues(p?.audience, { sources: p?.audience?.source === "customer" ? null : sourceUrls }));
  const personas = Array.isArray(r.personas) ? r.personas : [];
  // A verified gap (gapIssues checks nobody eligible exists) instead of padding with people who cannot use it.
  const gap = r.audience_gap;
  if (gap != null) {
    if (typeof gap !== "object" || !Array.isArray(gap.searched) || !gap.searched.some((s) => typeof s === "string" && s.trim()) ||
        typeof gap.note !== "string" || gap.note.trim().length < 20)
      issues.push("audience_gap must be {searched: [the search_profiles calls you ran], note: why nobody fits (20+ characters)}");
    if (personas.length) issues.push("audience_gap is only for when no profile may use the product: submit personas: [] with it, or drop it");
  } else if (personas.length < 1 || personas.length > LIMITS.max_personas)
    issues.push(`give 1-${LIMITS.max_personas} personas (got ${personas.length})${personas.length ? "" : "; if no profile fits the audience, submit personas: [] with audience_gap"}`);
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
  // Library first: every problem is a curated library task, cited by its id, or (only for a need the library does not
  // cover) a draft the customer must approve before it runs, saying what was searched and why nothing fit.
  scenarios.forEach((s: any, i: number) => {
    if (s?.platform != null && !isPlatform(s.platform)) issues.push(`scenarios[${i}].platform must be one of ${PLATFORMS.join(", ")}`);
    if (s?.draft === true) {
      if (s.library_task_id != null) issues.push(`scenarios[${i}] is a draft: drafts have no library_task_id`);
      if (typeof s.library_check !== "string" || s.library_check.trim().length < 30)
        issues.push(`scenarios[${i}] is a draft: set library_check to the library searches you ran and why no task fit (30+ characters)`);
    } else if (!Number.isInteger(s?.library_task_id) || s.library_task_id <= 0)
      issues.push(`scenarios[${i}] has no library_task_id: use a library task (search_library), or, only if none fits this need, propose it as a draft (draft: true, library_check)`);
  });
  if (scenarios.length && scenarios.every((s: any) => s?.draft === true) && !(Array.isArray(r.selection?.tasks) && r.selection!.tasks!.length))
    issues.push("selection.tasks: record the library rounds you ran before falling back to drafts");
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
  // Selection rounds cover the library tasks; when every problem is a draft, the rounds record the searches instead.
  const libraryIds = scenarios.map((s: any) => s?.library_task_id).filter((x: unknown): x is number => Number.isInteger(x));
  if (libraryIds.length) issues.push(...selectionIssues("tasks", r.selection?.tasks, libraryIds));
  // With a gap there is nothing to have chosen: the gap's searches are the record.
  if (!(gap != null && !personas.length))
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

/** The audience a job's picks are checked against: the customer's confirmed one wins over research's reading. */
async function jobAudience(job: { product_id: number } | null, r: ResearchResult | undefined): Promise<Audience | null> {
  const own = r?.product?.audience;
  if (!job) return own && !audienceFormIssues(own, { sources: null }).length ? own : null;
  const [p] = await (await getDb()).query<{ research: any }>("/* tenant: product of the research job (job checked against the job token in http.ts) */ SELECT research FROM products WHERE id = $1", [job.product_id]);
  const a = effectiveAudience(p?.research?.audience, own);
  // A malformed audience is reported by validateResearch; it is not used to judge picks.
  return a && !audienceFormIssues(a, { sources: null }).length ? a : null;
}

/**
 * Picked personas against who may use the product (src/audience.ts): an exclusive market and required gates reject
 * every pick that fails them, primary markets and typical gates need half the picks. Every candidate's reason in the
 * persona rounds names the profile's country, so the choice is made with it in view.
 */
async function audienceIssues(job: { product_id: number; input?: any } | null, r: ResearchResult | undefined): Promise<string[]> {
  const own = r?.product?.audience;
  const early = own?.source === "customer" && job && !job.input?.audience
    ? ["product.audience.source \"customer\" is only for an audience the customer stated at onboarding; set it to \"research\" and cite the page"] : [];
  const picks = (r?.personas ?? []).filter((x) => typeof x?.profile_slug === "string");
  const rounds = Array.isArray(r?.selection?.personas) ? r!.selection!.personas! : [];
  const candidates = rounds.flatMap((x: any) => (Array.isArray(x?.candidates) ? x.candidates : []));
  const slugs = [...new Set([...picks.map((x) => x.profile_slug!), ...candidates.map((c: any) => c?.profile_slug).filter((s: unknown) => typeof s === "string")])];
  if (!slugs.length) return early;
  const rows = await (await getDb()).query<{ slug: string; name: string; facets: any }>(
    "SELECT slug, name, attributes->'facets' AS facets FROM developer_profiles WHERE active AND org_id IS NULL AND slug = ANY($1)", [slugs]);
  const bySlug = new Map(rows.map((x) => [x.slug, x]));
  const issues = [...early, ...pickIssues(await jobAudience(job, r), picks.flatMap((x) => {
    const row = bySlug.get(x.profile_slug!);
    return row ? [{ slug: row.slug, name: x.name ?? row.name, facets: row.facets ?? null }] : [];
  }))];
  rounds.forEach((round: any, i: number) => (Array.isArray(round?.candidates) ? round.candidates : []).forEach((c: any, j: number) => {
    const country = bySlug.get(c?.profile_slug)?.facets?.country;
    if (country && typeof c?.reason === "string" && !mentionsCountry(c.reason, country))
      issues.push(`selection.personas[${i}].candidates[${j}].reason: say where ${c.profile_slug} is (${country}) and their sector, and whether that fits who may use the product`);
  }));
  return issues;
}

/** How many shared profiles pass the audience's hard parts, with a few of them. */
export async function eligibleCount(a: Audience): Promise<{ n: number; examples: string[] }> {
  const params: unknown[] = [];
  const where = hardSql(a, params);
  const rows = await (await getDb()).query<{ slug: string; n: number }>(
    `SELECT slug, count(*) OVER () AS n FROM developer_profiles WHERE active AND org_id IS NULL AND ${where} ORDER BY slug LIMIT 5`, params);
  return { n: Number(rows[0]?.n ?? 0), examples: rows.map((x) => x.slug) };
}

/** A gap is accepted only when it is true: no shared profile passes the audience's hard parts. */
async function gapIssues(job: { product_id: number } | null, r: ResearchResult | undefined): Promise<string[]> {
  if (r?.audience_gap == null || (r.personas ?? []).length) return [];
  const a = await jobAudience(job, r);
  if (!a) return [];
  // Profiles synced before their survey facets (vault/build/so_backfill.py) match nothing: that is no evidence of a gap.
  const [{ faceted }] = await (await getDb()).query<{ faceted: number }>(
    "SELECT count(*) AS faceted FROM developer_profiles WHERE active AND org_id IS NULL AND attributes->'facets'->>'country' IS NOT NULL");
  if (!Number(faceted)) return ["audience_gap: the developer-profile data has no survey facets yet, so a gap cannot be verified; this research cannot finish until the data is synced"];
  const { n, examples } = await eligibleCount(a);
  return n > 0 ? [`audience_gap: ${n} eligible profiles exist (e.g. ${examples.join(", ")}); pick from them (search_profiles ${JSON.stringify(eligibleSearch(a))})`] : [];
}

/** Words that never narrow a profile search. */
const STOP = new Set(["a", "an", "and", "at", "for", "in", "of", "on", "or", "the", "to", "who", "with", "by", "is", "as", "from", "uses", "use", "using"]);

export interface ProfileQuery { query?: string; country?: string[]; region?: string[]; sector?: string[]; research_role?: boolean; industry?: string[];
                                slugs?: string[]; exclude?: string[]; limit?: number; seed?: string }

/**
 * Shared developer profiles from the data (survey-based), for research to pick personas from. Structured filters on
 * the survey facets first (country, region, sector, research_role, industry; values within one filter are OR), then
 * the query's words, each a point when it appears in the name, summary or attributes ("Canadian" also matches
 * "Canada" and is returned as a country hint). Equal scores are ordered by a hash of slug and seed (the research id),
 * so no slug is favoured by its spelling. `matched` counts every match, not just the ones returned.
 */
export async function libraryProfiles(q: ProfileQuery) {
  const bad = (msg: string) => Object.assign(new Error(msg), { status: 400 });
  const list = (v: unknown) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]).flatMap((x) => String(x).split(",")).map((x) => x.trim()).filter(Boolean);
  const country = list(q.country).map((c) => countryOfWord(c) ?? c.toUpperCase());
  const region = list(q.region), sector = list(q.sector), industry = list(q.industry);
  if (country.some((c) => !isIso2(c))) throw bad(`unknown country ${country.filter((c) => !isIso2(c)).join(", ")}: use ISO2 codes (CA, US, IN, SE, ...)`);
  if (region.some((x) => !isRegion(x))) throw bad(`unknown region ${region.filter((x) => !isRegion(x)).join(", ")}; valid: ${REGIONS.join(", ")}`);
  if (sector.some((x) => !isSector(x))) throw bad(`unknown sector ${sector.filter((x) => !isSector(x)).join(", ")}; valid: ${SECTORS.join(", ")}`);
  if (industry.some((x) => !isIndustry(x))) throw bad(`unknown industry ${industry.filter((x) => !isIndustry(x)).join(", ")}; valid: ${INDUSTRIES.join("; ")}`);
  const db = await getDb();
  const params: unknown[] = [];
  const p = (v: unknown) => (params.push(v), `$${params.length}`);
  const facet = (k: string) => `(attributes->'facets'->>'${k}')`;
  const where = ["active", "org_id IS NULL"];
  if (country.length) where.push(`${facet("country")} = ANY(${p(country)})`);
  if (region.length) where.push(`${facet("region")} = ANY(${p(region)})`);
  if (sector.length) where.push(`${facet("sector")} = ANY(${p(sector)})`);
  if (typeof q.research_role === "boolean") where.push(`${facet("research_role")} = ${p(String(q.research_role))}`);
  if (industry.length) where.push(`coalesce(${facet("industry_survey")}, attributes->>'industry') = ANY(${p(industry)})`);
  const slugs = list(q.slugs), exclude = list(q.exclude);
  if (slugs.length) where.push(`slug = ANY(${p(slugs)})`);
  if (exclude.length) where.push(`NOT (slug = ANY(${p(exclude)}))`);
  // The query's words: each is one point; a country word also matches its country's names.
  const hints: { country: string; from: string }[] = [];
  const words = [...new Set((q.query ?? "").split(/[^\p{L}\p{N}+#.-]+/u).map((w) => w.replace(/^[.-]+|[.-]+$/g, "")).filter((w) => w.length >= 2 && !STOP.has(w.toLowerCase())))].slice(0, 12);
  const groups = words.map((w) => {
    const iso = countryOfWord(w);
    if (iso && !hints.some((h) => h.country === iso)) hints.push({ country: iso, from: w });
    return [...new Set([w, ...(iso ? countryTexts(iso) : [])])].map((x) => `%${x.replace(/[\\%_]/g, "\\$&")}%`);
  });
  const score = groups.length
    ? groups.map((g) => { const k = p(g); return `(CASE WHEN name ILIKE ANY(${k}) OR summary ILIKE ANY(${k}) OR attributes::text ILIKE ANY(${k}) THEN 1 ELSE 0 END)`; }).join(" + ")
    : "0";
  const seed = p(String(q.seed ?? ""));
  const limit = Math.min(Math.max(Math.trunc(Number(q.limit) || 15), 1), 40);
  const rows = await db.query<any>(
    `SELECT * FROM (SELECT slug, name, summary, attributes, left(instructions, 600) AS instructions, ${score} AS score
                      FROM developer_profiles WHERE ${where.join(" AND ")}) m
      ${groups.length ? "WHERE score > 0" : ""}
      ORDER BY score DESC, md5(slug || ${seed}) LIMIT ${limit}`, params);
  const [{ n }] = await db.query<{ n: number }>(
    `SELECT count(*) AS n FROM (SELECT ${score} AS score FROM developer_profiles WHERE ${where.join(" AND ")}) m ${groups.length ? "WHERE score > 0" : ""}`,
    params.slice(0, -1)); // without the seed, which only orders
  const [{ total }] = await db.query<{ total: number }>("SELECT count(*) AS total FROM developer_profiles WHERE active AND org_id IS NULL");
  return {
    total: Number(total), matched: Number(n),
    filters: { ...(country.length ? { country } : {}), ...(region.length ? { region } : {}), ...(sector.length ? { sector } : {}),
               ...(typeof q.research_role === "boolean" ? { research_role: q.research_role } : {}), ...(industry.length ? { industry } : {}) },
    hints: hints.map((h) => ({ ...h, note: `"${h.from}" names a country: filter with country: ["${h.country}"] to see only profiles there` })),
    ...(Number(n) > rows.length ? { note: `${n} profiles match; showing ${rows.length}. Narrow with filters or raise limit (max 40).` } : {}),
    profiles: rows.map(({ score, ...x }) => ({ ...x, score: Number(score) })),
  };
}

/**
 * Competitors are evidence, not memory: when web search is configured (or the job searched), every competitor cites
 * an evidence_url that one of this job's searches returned, or a page on the product's own site (e.g. its "vs" page).
 */
export async function competitorIssues(job: { sources?: { url: string }[]; input?: any }, r: ResearchResult | undefined): Promise<string[]> {
  const sources = job.sources ?? [];
  if (!sources.length && !(await webSearchEnabled())) return [];
  const seen = new Set(sources.map((s) => urlKey(s.url)));
  const own = [r?.product?.website_url, r?.product?.docs_url, job.input?.website_url, job.input?.docs_url]
    .flatMap((u) => { try { return u ? [new URL(u).hostname.toLowerCase().replace(/^www\./, "")] : []; } catch { return []; } });
  const issues: string[] = [];
  (r?.product?.competitors ?? []).forEach((c, i) => {
    if (c?.kind === "self_hosted" || c?.kind === "build") {
      // Buy vs build is always an option, not a vendor to find: it needs signals to be seen, not a cited page.
      if (!(c.signals ?? []).some((x) => x.trim().length >= 3)) issues.push(`product.competitors[${i}] (${c.name}) is a ${c.kind} alternative: give its signals (what an agent does when it takes that route)`);
      return;
    }
    const e = c?.evidence_url;
    if (!e) return void issues.push(`product.competitors[${i}] (${c?.name}) needs evidence_url: a page from web_search, find_similar or package_search showing it competes; drop competitors you cannot find evidence for`);
    let host = "";
    try { host = new URL(e).hostname.toLowerCase().replace(/^www\./, ""); } catch { return void issues.push(`product.competitors[${i}].evidence_url is not a URL`); }
    if (!seen.has(urlKey(e)) && !own.some((h) => host === h || host.endsWith("." + h)))
      issues.push(`product.competitors[${i}].evidence_url ${e} was not returned by this job's searches; cite a result URL exactly as returned`);
  });
  return issues;
}

export async function validateResearchJob(id: string, result: ResearchResult) {
  const job = await runningJob(id);
  if (job.kind === "prospect") { const issues = prospectIssues(result); return { ok: issues.length === 0, issues }; }
  const issues = [...validateResearch(result), ...(await libraryIssues(result)), ...(await profileIssues(result)), ...(await audienceIssues(job, result)), ...(await gapIssues(job, result)), ...(await competitorIssues(job, result))];
  return { ok: issues.length === 0, issues };
}

/** Why onboarding failed, in plain words, and what the customer can do next (never the raw validator output). */
export function onboardingFailure(job: { note?: string | null; error?: string | null; input?: any }, product: string) {
  const text = `${job.note ?? ""} ${job.error ?? ""}`;
  const reasons: string[] = [], next: string[] = [];
  if (/blocked by fetch policy|could not read|not readable|fetch_url failed|documentation hosts/i.test(text)) {
    reasons.push("Research could not read the product's documentation from the links given.");
    next.push("Onboard again with docs_url set to the documentation site itself (for example its Read the Docs or docs page).");
  }
  if (/no (interatomic|matching|fitting|relevant)? ?.*tasks|library searches found no|scenarios \(got 0\)|give \d+-\d+ scenarios/i.test(text)) {
    reasons.push("Octillion's task library has no tasks that fit this product yet.");
    next.push(`Bring your own tasks with import_tasks {product: "${product}"} (for example from your docs' tutorials or support questions), then run_simulation {task_set}.`);
    next.push("Or onboard again: research can now propose draft tasks for gaps in the library, which you approve with review_draft_tasks before they run.");
  }
  if (/competitors \(got 0\)/i.test(text) && !reasons.length) reasons.push("Research could not identify the product's alternatives.");
  if (/LLM unavailable|provider|rate limit|timed out|stale/i.test(text)) {
    reasons.push("The research service was interrupted.");
    next.push("Try onboarding again in a few minutes.");
  }
  const explanation = (job.note ?? "").replace(/\s+/g, " ").trim();
  if (!reasons.length) reasons.push(explanation ? `Research did not finish: ${explanation.slice(0, 300)}` : "Research did not finish.");
  if (!next.length) next.push("Try onboarding again, or set up the product by hand with save_product and save_scenarios.");
  return { summary: reasons.join(" "), research_note: explanation || null, next };
}

/** The first run, offered concretely: the exact call, how many sessions, roughly what it costs. */
export async function firstRunOffer(product: string, tasks: number, profiles: string[]) {
  // Averages across every organization's runs (src/tenant-scope.ts).
  return asPlatform(async () => {
  const db = await getDb();
  const [{ avg }] = await db.query<{ avg: number | null }>(
    "/* tenant: aggregate average across all completed sessions, no rows of any org returned */ SELECT avg(cost_usd)::float AS avg FROM agent_sessions WHERE status = 'completed' AND ended_at > now() - interval '30 days' AND cost_usd > 0");
  const perSession = Number(avg) > 0 ? Number(avg) : 1.5;
  const slots = tasks * Math.max(1, profiles.length);
  const first = Math.min(slots * config.defaultSamples(), config.maxSessionsPerRun());
  const most = Math.min(slots * config.maxSamples(), config.maxSessionsPerRun());
  const usd = (n: number) => Math.max(1, Math.round(n));
  return {
    tool: "run_simulation", args: { product, ...(profiles.length ? { profiles } : {}) },
    sessions_first_batch: first, sessions_at_most: most,
    cost_estimate_usd: [usd(first * perSession), usd(most * perSession)] as [number, number],
    message: `Run it now: about ${first} agent sessions to start (up to ${most} as results settle), roughly $${usd(first * perSession)}-${usd(most * perSession)}.`,
  };
});
}

/** Approve or reject the draft tasks research proposed for gaps in the library (only approved drafts ever run). */
export async function reviewDraftTasks(org: Org, input: { product?: string; approve?: number[]; reject?: number[] }) {
  const p = await resolveProduct(org, input.product);
  const db = await getDb();
  const ids = [...(input.approve ?? []), ...(input.reject ?? [])];
  if (!ids.length) throw new Error("Pass approve and/or reject: draft task ids from get_onboarding");
  const found = (await db.query<{ id: number }>(
    "/* tenant: product from resolveProduct(org) */ SELECT id FROM scenarios WHERE product_id = $1 AND id = ANY($2) AND source = 'draft'", [p.id, ids])).map((r) => Number(r.id));
  const missing = ids.filter((x) => !found.includes(x));
  if (missing.length) throw new Error(`Not draft tasks of ${p.name}: ${missing.join(", ")}. See get_onboarding.`);
  if (input.approve?.length) await db.query("/* tenant: product from resolveProduct(org) */ UPDATE scenarios SET active = true, updated_at = now() WHERE product_id = $1 AND id = ANY($2) AND source = 'draft'", [p.id, input.approve]);
  if (input.reject?.length) await db.query("/* tenant: product from resolveProduct(org) */ UPDATE scenarios SET source = 'draft_rejected', active = false, updated_at = now() WHERE product_id = $1 AND id = ANY($2) AND source = 'draft'", [p.id, input.reject]);
  return getOnboarding(org, { product: p.slug });
}

/** Apply a completed research result (or record a failure). Returns 422-style issues when invalid. */
export async function completeResearch(id: string, body: { status?: string; error?: string; result?: ResearchResult }) {
  const job = await runningJob(id);
  if (job.kind === "prospect") return completeProspect(job, body);
  const db = await getDb();
  if (body.status === "failed") {
    await db.query("/* tenant: research id checked against the job token in http.ts (/research/:id) */ UPDATE product_research SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [id, String(body.error ?? "failed").slice(0, 2000)]);
    void orgEvent(job.org_id, "onboarding_failed", { research_id: id, reason: "worker" });
    return { status: "failed" };
  }
  const issues = [...validateResearch(body.result), ...(await libraryIssues(body.result)), ...(await profileIssues(body.result)), ...(await audienceIssues(job, body.result)), ...(await gapIssues(job, body.result)), ...(await competitorIssues(job, body.result))];
  if (issues.length) {
    const [{ attempts }] = await db.query<{ attempts: number }>(
      "/* tenant: research id checked against the job token in http.ts (/research/:id) */ UPDATE product_research SET attempts = attempts + 1, heartbeat_at = now(), stage = 'validating' WHERE id = $1 RETURNING attempts", [id]);
    if (attempts >= MAX_ATTEMPTS) {
      await db.query("/* tenant: research id checked against the job token in http.ts (/research/:id) */ UPDATE product_research SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [id, `invalid after ${attempts} attempts: ${issues.join("; ")}`]);
      void orgEvent(job.org_id, "onboarding_failed", { research_id: id, reason: "validation", attempts });
    }
    throw Object.assign(new Error("invalid research result"), { status: 422, issues });
  }

  const r = body.result!;
  const [o] = await db.query<{ id: number; slug: string; name: string }>("SELECT id, slug, name FROM organizations WHERE id = $1", [job.org_id]);
  const org: Org = { orgId: o.id, slug: o.slug, name: o.name };
  const [prod] = await db.query<{ slug: string; competitors: Tool[] | null; research: any }>("/* tenant: product of the research job (job checked against the job token in http.ts) */ SELECT slug, competitors, research FROM products WHERE id = $1", [job.product_id]);
  const p = r.product;
  // The audience: what the customer confirmed stays; else research's, marked as the customer's when they stated it
  // at onboarding (input.audience), so a later research cannot quietly widen it.
  const audience: Audience | null = effectiveAudience(prod.research?.audience, p.audience
    ? { ...p.audience, ...(job.input?.audience ? { source: "customer" as const, confirmed: true } : { source: p.audience.source ?? "research" as const }) } : null);
  // The competitor list only grows: research adds what it found; competitors already on the product (added by hand or
  // by an earlier research) stay, so a loss to them is never scored "no vendor".
  const found = (p.competitors ?? []).map((c) => ({ ...c, source: "research" as const }));
  const known = new Set(found.map((c) => c.name.trim().toLowerCase()));
  // ...except tools the architecture review judged not to compete (a complement such as the product's own scheduler):
  // an earlier research's mistake must not come back through the merge.
  const notCompeting = new Set((p.not_competitors ?? []).map((c) => c.name.trim().toLowerCase()));
  const competitors = [...found, ...(prod.competitors ?? []).filter((c) => !known.has(c.name.trim().toLowerCase()) && !notCompeting.has(c.name.trim().toLowerCase()))];
  await saveProduct(org, {
    product: prod.slug, name: p.name, description: p.description, category: p.category,
    website_url: p.website_url ?? job.input.website_url ?? undefined, docs_url: p.docs_url ?? job.input.docs_url ?? undefined,
    aliases: p.aliases ?? [], packages: p.packages ?? [], domains: p.domains ?? [], competitors,
  });
  await db.query("/* tenant: product of the research job (job checked against the job token in http.ts) */ UPDATE products SET features = $2, research = $3 WHERE id = $1",
    [job.product_id, JSON.stringify(p.features ?? []), JSON.stringify({ research_id: id, sources: r.sources ?? [], category_terms: p.category_terms ?? [],
      ...(p.placement ? { placement: p.placement } : {}), ...(p.not_competitors?.length ? { not_competitors: p.not_competitors } : {}),
      ...(audience ? { audience } : {}), ...(r.audience_gap ? { audience_gap: r.audience_gap } : {}), at: new Date().toISOString() })]);
  // Questions for the customer: one open question per tool; a newer research asking again keeps the open one.
  const questions = [...(r.questions ?? [])];
  // Nobody in the data may use the product: ask whether the audience is right (it may be wider than the pages say)
  // rather than running with people who could never use it.
  if (r.audience_gap && audience) questions.push(personaSupplyQuestion(audience, r.audience_gap));
  if (questions.length) await (await import("./questions.js")).askQuestions(job.org_id, job.product_id, id, questions);

  const personaSlugs: string[] = [];
  const slugOf = new Map<string, string>();
  await db.transaction(async (tx) => {
    // A new research replaces the previous generated personas and problems (kept for history, inactive).
    await tx.query("UPDATE developer_profiles SET active = false WHERE product_id = $1 AND source IN ('generated', 'picked')", [job.product_id]);
    await tx.query("/* tenant: product of the research job (job checked against the job token in http.ts) */ UPDATE product_personas SET active = false WHERE product_id = $1", [job.product_id]);
    await tx.query("/* tenant: product of the research job (job checked against the job token in http.ts) */ UPDATE scenarios SET active = false, updated_at = now() WHERE product_id = $1 AND source IN ('generated', 'library', 'draft')", [job.product_id]);
    for (const x of r.personas) {
      // The persona is a shared library profile, linked to the product (product_personas), never copied into the
      // account: sessions run on the shared profile; the link holds the environment research chose for this product.
      const [d] = await tx.query<{ id: number; slug: string }>("SELECT id, slug FROM developer_profiles WHERE slug = $1 AND org_id IS NULL", [x.profile_slug]);
      if (!d) continue;
      personaSlugs.push(d.slug);
      slugOf.set(x.name, d.slug);
      await tx.query(
        `/* tenant: product of the research job (job checked against the job token in http.ts) */ INSERT INTO product_personas (product_id, profile_id, environment, active)
         VALUES ($1, $2, $3, true) ON CONFLICT (product_id, profile_id) DO UPDATE SET environment = EXCLUDED.environment, active = true`,
        [job.product_id, d.id, x.environment ? JSON.stringify({ editor: x.environment.editor, tools: x.environment.tools ?? [], skills: x.environment.skills ?? [],
                                                                agent_rules: x.environment.agent_rules ?? null }) : null]);
    }
    for (const s of r.scenarios) {
      const prompt = s.prompt.trim();
      // A library task without an explicit template keeps the starter workspace it was written for.
      let template = researchTemplate(s.template);
      let repoUrl = s.repo_url ?? null;
      // A library task is linked, never copied: the row keeps only what research changed for the product (its adapted
      // title and prompt); what is the same as the library's stays NULL and is read from library_tasks (SCENARIO_ROWS).
      let lib: { title: string; prompt: string; template: string | null; repo_url: string | null; language: string | null; tags: string[] } | undefined;
      if (s.library_task_id) {
        [lib] = await tx.query<NonNullable<typeof lib>>(
          "SELECT title, prompt, attributes->>'template' AS template, repo_url, language, tags FROM library_tasks WHERE id = $1", [s.library_task_id]);
        // Curated tasks are written for a specific pinned repo (or starter): keep the task and its codebase together.
        if (!template) template = researchTemplate(lib?.template);
        if (repoUrl === (lib?.repo_url ?? null)) repoUrl = null;
      }
      const same = (v: unknown, l: unknown) => lib != null && v === l;
      const title = s.title?.trim() || prompt.slice(0, 80);
      const tags = s.tags ?? [];
      await tx.query(
        `/* tenant: product of the research job (job checked against the job token in http.ts) */ INSERT INTO scenarios (product_id, title, prompt, repo_url, language, tags, expectation, active, library_task_id, source, rationale, template, prompt_variants, decision, platform)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $15, $8, $9, $10, $11, $12, $13, $14)`,
        // A library task keeps only its link: runs adapt it when they start (src/adapt.ts), so research's own wording
        // for it (title, prompt, persona variants) is checked above but not stored on the product.
        [job.product_id, lib ? null : title, lib ? null : prompt, repoUrl,
         same(s.language ?? null, lib?.language ?? null) ? null : s.language ?? null, lib && JSON.stringify(tags) === JSON.stringify(lib.tags ?? []) ? [] : tags,
         s.expectation ?? "recommend", s.library_task_id ?? null, s.draft ? "draft" : s.library_task_id ? "library" : "generated",
         s.draft ? `Draft: ${s.library_check ?? ""}${s.rationale ? ` ${s.rationale}` : ""}` : s.rationale ?? null,
         template, JSON.stringify(lib ? {} : Object.fromEntries(Object.entries(s.variants ?? {}).filter(([who]) => slugOf.has(who)).map(([who, t]) => [slugOf.get(who)!, t.trim()]))), s.decision ? JSON.stringify(s.decision) : null,
         isPlatform(s.platform) ? s.platform : platformOf({ template, language: s.language, tags: s.tags, prompt }), !s.draft]);
    }
    await tx.query(
      "/* tenant: research id checked against the job token in http.ts (/research/:id) */ UPDATE product_research SET status = 'completed', stage = 'done', result = $2, finished_at = now(), heartbeat_at = now() WHERE id = $1",
      [id, JSON.stringify(r)]);
  });

  // Launch the representative run unless the customer opted out; fit it under the per-run session cap (the server's,
  // or the account's own Budget rules limit if lower), so a low limit makes the run smaller instead of failing it.
  let simulation_id: string | null = null;
  let run_error: string | null = null;
  if (job.run) {
    const cap = await sessionsLimit(org.orgId);
    // More tasks than the cap allows sessions: run the first `cap` of them (the rest stay ready for a later run).
    const scenario_ids = r.scenarios.length > cap
      ? (await db.query<{ id: number }>("/* tenant: product of the research job (job checked against the job token in http.ts) */ SELECT id FROM scenarios WHERE product_id = $1 AND active ORDER BY id LIMIT $2",
          [job.product_id, cap])).map((x) => Number(x.id))
      : undefined;
    const n = Math.max(1, scenario_ids?.length ?? r.scenarios.length);
    let profiles = personaSlugs;
    if (n * profiles.length > cap) profiles = profiles.slice(0, Math.max(1, Math.floor(cap / n)));
    const fit = Math.max(1, Math.floor(cap / (n * Math.max(1, profiles.length))));
    const samples = Math.min(job.run.samples ?? config.defaultSamples(), fit);
    try {
      // No eligible persona (an audience gap): no run, rather than one with a generic developer the product never serves.
      if (!profiles.length) throw new Error(NO_ELIGIBLE_PERSONAS);
      // `samples` is the first batch; unless the customer fixed the size, each task then samples adaptively up to the cap.
      const sim = await runSimulation(org, { product: prod.slug, profiles, samples, population: job.run.population ?? undefined, ...(scenario_ids ? { scenario_ids } : {}),
                                             ...(job.run.samples == null ? { max_samples: config.maxSamples() } : {}),
                                             name: `Onboarding: ${p.name}` });
      simulation_id = sim.simulation.id;
      await db.query("/* tenant: research id checked against the job token in http.ts (/research/:id) */ UPDATE product_research SET simulation_id = $2 WHERE id = $1", [id, simulation_id]);
    } catch (e) {
      run_error = (e as Error).message;
      await db.query("/* tenant: research id checked against the job token in http.ts (/research/:id) */ UPDATE product_research SET note = $2 WHERE id = $1", [id, `run not started: ${run_error}`.slice(0, 500)]);
    }
  }
  capture({ distinctId: `org:${org.slug}`, orgSlug: org.slug }, "onboarding_completed",
    { research_id: id, personas: personaSlugs.length, scenarios: r.scenarios.length, competitors: (p.competitors ?? []).length, auto_run: Boolean(simulation_id) });
  return { status: "completed", product: prod.slug, personas: personaSlugs, scenarios: r.scenarios.length, simulation_id, run_error };
}
