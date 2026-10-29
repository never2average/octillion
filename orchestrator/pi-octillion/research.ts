/**
 * Research mode (docs/onboarding.md): a dedicated Pi session per research job, on the same broker brain, with
 * research-only tools (fetch_url, web/package search, search_library, report_progress, validate, submit). No coding-agent tools,
 * no shell, no file access.
 *
 * Deterministic fallback: there is none for the research itself. Without a working LLM the job is completed as
 * `failed` with a clear error; research is never invented.
 */
import { Type } from "@earendil-works/pi-ai";
import {
  createAgentSession, defineTool, DefaultResourceLoader, SessionManager, SettingsManager,
  type ExtensionAPI, type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { CFG, env, num } from "../core/config.js";
import { redact } from "../core/credentials.js";
import { fetchReadable, FetchPolicy } from "../core/safe-fetch.js";
import { quotedOn, readablePage } from "../core/quote.js";
import { isShuttingDown } from "../core/session.js";
import { api, HttpError, log, sleep, withRetry } from "../core/util.js";
import { PERSONAS_ONLY_SYSTEM_PROMPT, RESEARCH_SYSTEM_PROMPT, personasOnlyPrompt, researchPrompt, type ResearchInput, type ResearchLimits } from "./research-prompt.js";
import { PROSPECT_SYSTEM_PROMPT, PROSPECT_TOOLS, prospectPrompt, type ProspectInput } from "./prospect-prompt.js";
import { holdBusy } from "../core/activity.js";
import { criticIssues, critiqueTasks } from "./critic.js";
import { architectBrain, architectOutcome, ARCHITECT_TOOLS, audienceCrossCheck, reviewArchitecture, type ArchitectBrain, type ArchitectOutcome } from "./architect.js";

/** kind 'prospect': the company behind an access request (prospect-prompt.ts), same tools minus the task library. */
export type ResearchJob = { research_id: string; kind?: "product"; input: ResearchInput; limits?: ResearchLimits }
  | { research_id: string; kind: "prospect"; input: ProspectInput; limits?: undefined };

export interface BrainLike {
  modelRuntime: ModelRuntime;
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
  dir: string;
  apiKey: string;
}

export const RESEARCH = {
  concurrency: Math.max(1, num(env.RESEARCH_CONCURRENCY, 1)),
  maxMinutes: num(env.RESEARCH_MAX_MINUTES, 20),
  // Two reviews (architecture, then tasks) can each send a submission back before the server's own checks.
  maxSubmits: num(env.RESEARCH_MAX_SUBMITS, 6),
  maxFetches: num(env.RESEARCH_MAX_FETCHES, 25),
  /** Hard LLM spend cap per research job (Pi's price table); the session is aborted and the job failed above it. */
  maxCostUsd: num(env.RESEARCH_MAX_COST_USD, 2),
  /** Prospect research is smaller: a brief, not a product profile with personas and problems. */
  prospectMaxCostUsd: num(env.PROSPECT_MAX_COST_USD, 0.75),
  prospectMaxMinutes: num(env.PROSPECT_MAX_MINUTES, 10),
  /** The architecture review's own budget (architect.ts): it runs on the strongest model and investigates with tools. */
  architectMaxCostUsd: num(env.RESEARCH_ARCHITECT_MAX_COST_USD, 6),
  architectMaxMinutes: num(env.RESEARCH_ARCHITECT_MAX_MINUTES, 15),
  architectFetches: num(env.RESEARCH_ARCHITECT_MAX_FETCHES, 25),
  enabled: env.RESEARCH_DISABLED !== "1",
};
export const RESEARCH_TOOLS = ["fetch_url", "web_search", "find_similar", "package_search", "search_library", "search_profiles", "report_progress", "validate", "submit"] as const;
/** A personas-only job (src/research.ts personasOnly): reads pages and picks profiles; no task library, no searches. */
export const PERSONAS_ONLY_TOOLS = ["fetch_url", "search_profiles", "report_progress", "validate", "submit"] as const;
const STAGES = ["reading", "profiling", "personas", "problems", "validating"] as const;

const enc = encodeURIComponent;
const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }], details: undefined });

/** POST /api/worker/research/:id/complete; returns {status, body} without throwing on 422. */
async function completeResearch(id: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  try {
    const r = await withRetry(() => api(`/api/worker/research/${enc(id)}/complete`, { json: body }), 3);
    return { status: 200, body: r };
  } catch (e) {
    if (e instanceof HttpError && e.status === 422) {
      const m = /-> 422: ([\s\S]*)$/.exec(e.message)?.[1] ?? "";
      let parsed: any = null;
      try { parsed = JSON.parse(m); } catch { parsed = { issues: [m] }; }
      return { status: 422, body: parsed };
    }
    throw e;
  }
}

export class ResearchContext {
  readonly policy: FetchPolicy;
  stage: (typeof STAGES)[number] = "reading";
  submits = 0;
  outcome: { status: "completed" | "failed"; detail: unknown } | null = null;
  lastIssues: unknown[] = [];
  cancelled = false;
  /** Task critic (set by runResearchJob): issues for problems that do not create a purchase decision, or null to skip. */
  critic: ((result: any) => Promise<string[] | null>) | null = null;
  criticRounds = 0;
  /** Architecture review (set by runResearchJob): competitors that do not compete, names, and questions for the customer. */
  architect: ((result: any) => Promise<ArchitectOutcome | null>) | null = null;
  architectRounds = 0;
  /** What the last review saw (name, aliases, competitors): an unchanged resubmission reuses its outcome. */
  architectKey: string | null = null;
  /** The latest review's outcome: its questions, unconfirmed tools and placement go on the accepted result. */
  architecture: ArchitectOutcome | null = null;
  /** Rounds the audience cross-check sent back (at most AUDIENCE_ROUNDS). */
  audienceRounds = 0;
  /** Every page fetched in this job (research and the review), by URL as requested and as finally read. */
  readonly pages = new Map<string, string>();

  constructor(readonly job: ResearchJob) {
    this.policy = job.kind === "prospect"
      ? new FetchPolicy([job.input.website_url ?? (job.input.email_domain ? `https://${job.input.email_domain}` : undefined), job.input.docs_url ?? undefined], RESEARCH.maxFetches, [])
      : new FetchPolicy([job.input.website_url, job.input.docs_url], RESEARCH.maxFetches, job.input.related_urls ?? []);
  }

  async progress(stage: string, note?: string) {
    try { await api(`/api/worker/research/${enc(this.job.research_id)}/progress`, { json: { stage, note } }); }
    catch (e) { if (e instanceof HttpError && (e.status === 404 || e.status === 409)) this.cancelled = true; }
  }
}

function parseResult(json: string): { result?: unknown; error?: string } {
  try { const r = JSON.parse(json); return r && typeof r === "object" ? { result: r } : { error: "result_json must be a JSON object" }; }
  catch (e) { return { error: `result_json is not valid JSON: ${(e as Error).message}` }; }
}

/** The research tools; `only` limits them (the architecture review gets the read-only ones, on its own search budget). */
export function createResearchExtension(ctx: ResearchContext, opts: { only?: readonly string[]; purpose?: "research" | "architect" } = {}) {
  return (api0: ExtensionAPI) => {
    const only = opts.only;
    const pi = only ? new Proxy(api0, { get: (t, k) => k === "registerTool" ? (tool: any) => (only.includes(tool.name) ? t.registerTool(tool) : undefined)
      : typeof (t as any)[k] === "function" ? (t as any)[k].bind(t) : (t as any)[k] }) : api0;
    pi.registerTool(defineTool({
      name: "fetch_url", label: "Fetch URL",
      description: "HTTP GET a page from the product's website/docs (or its package registry / GitHub) and return readable text plus same-site links. About 25 fetches per job.",
      parameters: Type.Object({ url: Type.String() }),
      executionMode: "sequential",
      async execute(_id, p) {
        let out: string;
        try { out = await fetchReadable(p.url, ctx.policy); }
        catch (e) { throw new Error(`fetch_url failed: ${(e as Error).message}`); }
        // The page as read goes to the server (and stays here), so a quote cited from it can be checked word for word.
        const page = readablePage(out);
        if (page) {
          ctx.pages.set(page.url, page.text);
          if (page.url !== p.url) ctx.pages.set(p.url, page.text);
          await api(`/api/worker/research/${enc(ctx.job.research_id)}/page`, { json: page }).catch(() => {});
          if (page.url !== p.url) await api(`/api/worker/research/${enc(ctx.job.research_id)}/page`, { json: { ...page, url: p.url } }).catch(() => {});
        }
        return text(out);
      },
    }));
    // Searches run on the server (src/websearch.ts; the keys never reach this sandbox). Result URLs become fetchable
    // and citable: a competitor's evidence_url must be one of them.
    const search = async (body: Record<string, unknown>) => {
      try {
        const r: any = await api(`/api/worker/research/${enc(ctx.job.research_id)}/search`, { json: { ...body, purpose: opts.purpose ?? "research" } });
        for (const x of r.results ?? []) for (const u of [x.url, x.homepage, x.repository]) if (typeof u === "string") ctx.policy.allowFound(u);
        return text(r);
      } catch (e) { throw new Error(`search failed: ${(e as Error).message}`); }
    };
    pi.registerTool(defineTool({
      name: "web_search", label: "Search the web",
      description: "Web search (results with URL, title and page text). Use it to find the product's real competitors: \"alternatives to <product>\", \"<product> vs\", \"best <category> for <platform>\". Result pages can then be read with fetch_url and cited as a competitor's evidence_url. About 20 searches per job across web_search, find_similar and package_search.",
      parameters: Type.Object({ query: Type.String({ minLength: 2, maxLength: 300 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }),
      executionMode: "sequential",
      async execute(_id, p) { return search({ kind: "web", query: p.query, limit: p.limit }); },
    }));
    pi.registerTool(defineTool({
      name: "find_similar", label: "Find similar sites",
      description: "Sites similar to a URL (pass the product's website): its direct competitors as the web sees them. Results are citable as evidence_url.",
      parameters: Type.Object({ url: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }),
      executionMode: "sequential",
      async execute(_id, p) { return search({ kind: "similar", url: p.url, limit: p.limit }); },
    }));
    pi.registerTool(defineTool({
      name: "package_search", label: "Search package registry",
      description: "Search a package registry for packages that do the same job, with usage numbers (weekly downloads, dependents, stars): finds the open-source competitors and their real package names, and shows which are widely used. ecosystem: npm, pypi, crates, go, maven, nuget, rubygems, packagist.",
      parameters: Type.Object({ query: Type.String({ minLength: 2, maxLength: 200 }), ecosystem: Type.Union(["npm", "pypi", "crates", "go", "maven", "nuget", "rubygems", "packagist"].map((x) => Type.Literal(x))),
                                limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }),
      executionMode: "sequential",
      async execute(_id, p) { return search({ kind: "packages", query: p.query, ecosystem: p.ecosystem, limit: p.limit }); },
    }));
    pi.registerTool(defineTool({
      name: "search_library", label: "Search task library",
      description: "Search the curated library of realistic coding tasks (about 7,000, each with a platform: web, mobile, backend, desktop, cli, data, other). Returns tasks with ids you can reuse via library_task_id.",
      parameters: Type.Object({ query: Type.String(), category: Type.Optional(Type.String()), language: Type.Optional(Type.String()),
                                platform: Type.Optional(Type.Union(["web", "mobile", "backend", "desktop", "cli", "data", "other"].map((x) => Type.Literal(x)))),
                                limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })) }),
      executionMode: "sequential",
      async execute(_id, p) {
        const q = new URLSearchParams({ query: p.query, ...(p.category ? { category: p.category } : {}), ...(p.language ? { language: p.language } : {}), ...(p.platform ? { platform: String(p.platform) } : {}), limit: String(p.limit ?? 10) });
        return text(await api(`/api/worker/library/tasks?${q}`, { method: "GET" }));
      },
    }));
    pi.registerTool(defineTool({
      name: "search_profiles", label: "Search developer profiles",
      description: "Search the developer-profile data (real developers from survey responses: role, experience, company size, stack, constraints, how they answer; " +
        "attributes.facets holds their survey answers: country (ISO2), region, sector, research_role, academic_staff, industry). Personas must be picked from here by profile_slug. " +
        "Sector academia includes every student, even one who works at a company; research_role is who is research-affiliated. " +
        "Filter by product.audience first (country, sector, research_role or role_any, industry; several values in one filter mean any of them), then search the query words " +
        "within that. matched is how many profiles fit, not just the ones shown; matched=0 means nobody in the data fits.",
      parameters: Type.Object({
        query: Type.Optional(Type.String()),
        country: Type.Optional(Type.Array(Type.String({ minLength: 2, maxLength: 2 }), { description: "ISO2 codes, e.g. [\"CA\"]" })),
        region: Type.Optional(Type.Array(Type.Union(["north_america", "latam", "eu", "europe_other", "uk", "south_asia", "east_asia", "sea", "oceania", "mena", "africa"].map((x) => Type.Literal(x))))),
        sector: Type.Optional(Type.Array(Type.Union(["academia", "government", "finance", "healthcare", "industry"].map((x) => Type.Literal(x))))),
        research_role: Type.Optional(Type.Boolean({ description: "true: research-affiliated: an academic researcher, a data or applied scientist at a university, or a student with no job in another industry (a student working at a software company is false)" })),
        academic_staff: Type.Optional(Type.Boolean({ description: "true: a university's technical staff (research software engineers, research-computing staff); not researchers" })),
        role_any: Type.Optional(Type.Array(Type.Union([Type.Literal("research_role"), Type.Literal("academic_staff")]), { description: "any of these is true, e.g. researchers or academic staff" })),
        industry: Type.Optional(Type.Array(Type.String(), { description: "the survey's industry names, e.g. \"Fintech\", \"Higher Education\"" })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 40 })),
      }),
      executionMode: "sequential",
      async execute(_id, p) {
        const q = new URLSearchParams({ ...(p.query ? { query: p.query } : {}), limit: String(p.limit ?? 15), seed: ctx.job.research_id,
                                        ...(typeof p.research_role === "boolean" ? { research_role: String(p.research_role) } : {}),
                                        ...(typeof p.academic_staff === "boolean" ? { academic_staff: String(p.academic_staff) } : {}) });
        for (const k of ["country", "region", "sector", "industry", "role_any"] as const) for (const v of (p[k] as string[] | undefined) ?? []) q.append(k, v);
        try { return text(await api(`/api/worker/library/profiles?${q}`, { method: "GET" })); }
        catch (e) { throw new Error(`search_profiles failed: ${(e as Error).message}`); }
      },
    }));
    pi.registerTool(defineTool({
      name: "report_progress", label: "Report progress",
      description: "Tell the server which stage you are in: reading, profiling, personas, problems, validating.",
      parameters: Type.Object({ stage: Type.Union(STAGES.map((s) => Type.Literal(s))), note: Type.Optional(Type.String({ maxLength: 500 })) }),
      executionMode: "sequential",
      async execute(_id, p) {
        ctx.stage = p.stage;
        await ctx.progress(p.stage, p.note);
        return text({ ok: true, stage: p.stage });
      },
    }));
    pi.registerTool(defineTool({
      name: "validate", label: "Validate result",
      description: "Dry-run validation of the full result (JSON string). Returns {ok, issues}. Nothing is saved.",
      parameters: Type.Object({ result_json: Type.String() }),
      executionMode: "sequential",
      async execute(_id, p) {
        const r = parseResult(p.result_json);
        if (r.error) return text({ ok: false, issues: [r.error] });
        return text(await api(`/api/worker/research/${enc(ctx.job.research_id)}/validate`, { json: { result: r.result } }));
      },
    }));
    pi.registerTool(defineTool({
      name: "submit", label: "Submit result",
      description: `Submit the final result (JSON string). Accepted -> done. Otherwise it returns issues: fix all and submit again (at most ${RESEARCH.maxSubmits} attempts).`,
      parameters: Type.Object({ result_json: Type.String() }),
      executionMode: "sequential",
      async execute(_id, p) {
        if (ctx.outcome) return text({ done: true, note: "already finished", outcome: ctx.outcome.status });
        const r = parseResult(p.result_json);
        ctx.submits++;
        const left = RESEARCH.maxSubmits - ctx.submits;
        if (r.error) {
          ctx.lastIssues = [r.error];
        } else {
          // Architecture review first (at most 2 rounds per job): only substitutes may stay competitors.
          const arch = ctx.architect && ctx.architectRounds < 2 ? (ctx.architectRounds++, await ctx.architect(r.result).catch(() => null)) : null;
          if (arch) ctx.architecture = arch;
          if (arch?.issues.length) {
            ctx.lastIssues = arch.issues;
            return text({ accepted: false, issues: arch.issues, attempts_left: left, note: "The architecture review found tools that do not compete with the product, or names to add. Fix them, then submit again." });
          }
          if (ctx.architecture) applyArchitecture(r.result, ctx.architecture);
          const audienceIssues = audienceStep(ctx, r.result);
          if (audienceIssues.length) {
            ctx.lastIssues = audienceIssues;
            return text({ accepted: false, issues: audienceIssues, attempts_left: left, note: "The architecture review read who may sign up differently. Fix product.audience (and the personas it rules out), then submit again." });
          }
          // Task review next (at most 2 rounds per job): problems must create a purchase decision on their own.
          const review = ctx.critic && ctx.criticRounds < 2 ? (ctx.criticRounds++, await ctx.critic(r.result).catch(() => null)) : null;
          if (review?.length) {
            ctx.lastIssues = review;
            return text({ accepted: false, issues: review, attempts_left: left, note: "Task review rejected these problems: rewrite them so the requirements create the decision, then submit again." });
          }
          const res = await completeResearch(ctx.job.research_id, { status: "completed", result: r.result });
          if (res.status === 200) {
            ctx.outcome = { status: "completed", detail: res.body };
            return { ...text({ accepted: true, saved: summarize(res.body) }), terminate: true };
          }
          ctx.lastIssues = res.body?.issues ?? [res.body];
        }
        if (left <= 0) {
          const error = `result rejected after ${ctx.submits} submissions: ${JSON.stringify(ctx.lastIssues).slice(0, 1500)}`;
          await completeResearch(ctx.job.research_id, { status: "failed", error }).catch(() => {});
          ctx.outcome = { status: "failed", detail: error };
          return { ...text({ accepted: false, final: true, issues: ctx.lastIssues, note: "Out of submit attempts; the job was marked failed. Stop." }), terminate: true };
        }
        return text({ accepted: false, issues: ctx.lastIssues, attempts_left: left, note: "Fix every issue and call submit again." });
      },
    }));
  };
}

/** Rounds the audience cross-check may send research back for, before the reviewer's quoted reading applies. */
export const AUDIENCE_ROUNDS = 2;

const pageKey = (u: string) => u.replace(/^https?:\/\/(www\.)?/i, "").replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();

/**
 * Who may sign up: research's product.audience against the review's reading (architect.ts audienceCrossCheck).
 * - The customer confirmed an audience (job input confirmed_audience): it is final. Research is never sent back or
 *   asked about it again; it is the result's audience.
 * - A confident, quoted reading that differs (either way: a restriction research lacks or one the page does not state)
 *   goes back to research (the issues returned) for AUDIENCE_ROUNDS rounds. After that the reviewer's reading applies
 *   until the customer answers the question put on the result, so personas are picked for it.
 * - An unsure reviewer only asks; research's reading stays.
 * The reviewer's quote counts only when it is on the page it cites, as this job fetched it (ctx.pages).
 * result.audience_check says which way it went (the server dismisses an open audience question on agreement).
 */
export function audienceStep(ctx: { architecture: ArchitectOutcome | null; audienceRounds: number; pages?: Map<string, string>; job?: { input?: any } }, result: any): string[] {
  const confirmed = ctx.job?.input?.confirmed_audience;
  if (confirmed && typeof confirmed === "object") {
    result.product = { ...(result.product ?? {}), audience: { ...confirmed, source: "customer", confirmed: true } };
    if (Array.isArray(result.questions)) result.questions = result.questions.filter((q: any) => q?.kind !== "audience");
    result.audience_check = "confirmed";
    return [];
  }
  const arch = ctx.architecture?.audience;
  if (!arch) return [];
  const verified = !arch.quote || !ctx.pages ? undefined
    : [...ctx.pages].some(([u, text]) => (!arch.url || pageKey(u) === pageKey(arch.url)) && quotedOn(text, arch.quote));
  const cross = audienceCrossCheck(result?.product?.audience, arch, { final: ctx.audienceRounds >= AUDIENCE_ROUNDS, quoteVerified: verified });
  result.audience_check = cross.status;
  if (cross.issues.length) { ctx.audienceRounds++; return cross.issues; }
  if (cross.apply) result.product = { ...(result.product ?? {}), audience: cross.apply };
  if (cross.question) result.questions = [...(result.questions ?? []).filter((q: any) => !(q?.kind === "audience" && q?.subject === cross.question.subject)), cross.question];
  return [];
}

/**
 * Put the architecture review's findings on the result the server saves: unsure competitors marked unconfirmed (kept
 * off scoring), the questions for the customer, the tools judged not to compete, and the product's placement.
 */
export function applyArchitecture(result: any, a: ArchitectOutcome) {
  const p = result?.product;
  if (!p) return;
  const unsure = new Set(a.unconfirmed.map((n) => n.toLowerCase()));
  p.competitors = (p.competitors ?? []).map((c: any) => (unsure.has(String(c?.name ?? "").toLowerCase()) ? { ...c, unconfirmed: true } : c));
  p.placement = a.placement;
  if (a.not_competitors.length) p.not_competitors = a.not_competitors;
  // Buy vs build: the self-host or build route is always a competitor, matched by its signals and never by name (its
  // natural names are often the product's own engine). It converts the listed entry that already is that route.
  const b = a.build_alternative;
  if (b) {
    const route = { name: b.name, kind: b.kind, signals: b.signals, source: "research" };
    const at = (p.competitors as any[]).findIndex((c, i) => i === b.replaces_index || String(c?.name ?? "").toLowerCase() === b.name.toLowerCase());
    if (at >= 0) p.competitors[at] = { ...route, ...(p.competitors[at]?.unconfirmed ? { unconfirmed: true } : {}) };
    else p.competitors.push(route);
  }
  const listed = new Set((p.competitors ?? []).map((c: any) => String(c?.name ?? "").toLowerCase()));
  const qs = a.questions.filter((q) => listed.has(q.subject.toLowerCase()));
  if (qs.length) result.questions = qs;
}

function summarize(b: any) {
  return {
    product: b?.product?.name ?? b?.product, personas: Array.isArray(b?.personas) ? b.personas.length : b?.personas,
    scenarios: Array.isArray(b?.scenarios) ? b.scenarios.length : b?.scenarios, simulation_id: b?.simulation_id ?? null,
  };
}

/** Run one research job end to end. Never throws; always completes the job (completed or failed). */
export async function runResearchJob(job: ResearchJob, brain: BrainLike): Promise<{ status: string; usage?: Record<string, number> }> {
  const id = job.research_id;
  const ctx = new ResearchContext(job);
  if (!brain.apiKey) {
    const error = "orchestrator LLM unavailable (no credentials from the broker); product research needs an LLM and is never invented";
    await completeResearch(id, { status: "failed", error }).catch((e) => log(`[${id}] complete failed:`, String(e)));
    return { status: "failed" };
  }
  await ctx.progress("reading", "research started");
  const prospect = job.kind === "prospect";
  const maxCost = prospect ? RESEARCH.prospectMaxCostUsd : RESEARCH.maxCostUsd, maxMinutes = prospect ? RESEARCH.prospectMaxMinutes : RESEARCH.maxMinutes;
  // Personas only (job input personas_only): the product, its tasks and competitors stay as they are, so neither the
  // task review nor the architecture review runs; the audience step still applies a customer-confirmed audience.
  const personasOnly = !prospect && (job.input as any)?.personas_only === true;
  if (!prospect && !personasOnly) ctx.critic = async (result: any) => {
    const tasks = (Array.isArray(result?.scenarios) ? result.scenarios : []).map((x: any, index: number) =>
      ({ index, title: x?.title, prompt: String(x?.prompt ?? ""), expectation: x?.expectation, variants: x?.variants, decision: x?.decision }));
    if (!tasks.length) return null;
    const r = await critiqueTasks(brain, String(result?.product?.name ?? ""), (result?.product?.competitors ?? []).map((c: any) => String(c?.name ?? "")), tasks);
    if (!r) { log(`[${id}] task review gave no usable answer; continuing on the rules alone`); return null; }
    const issues = criticIssues(r.verdicts);
    log(`[${id}] task review: ${issues.length} of ${tasks.length} problem(s) rejected ($${r.cost.toFixed(3)})`);
    return issues;
  };
  if (!prospect && !personasOnly) ctx.architect = async (result: any) => {
    const p = result?.product;
    if (!p?.name || !Array.isArray(p.competitors) || !p.competitors.length) return null;
    // A resubmission that only fixed other things (tasks, personas) has nothing new for the review: reuse its outcome.
    const key = JSON.stringify([p.name, p.aliases ?? [], p.competitors.map((c: any) => [c?.name, c?.aliases ?? []])]);
    if (key === ctx.architectKey && ctx.architecture) return ctx.architecture;
    ctx.architectKey = key;
    // The strongest model when the broker names one (ARCHITECT_*); else the research model, still with tools.
    const strong = await architectBrain().catch((e) => { log(`[${id}] architecture review model unavailable: ${redact(String(e))}`); return null; });
    const reviewer: ArchitectBrain = strong ?? { modelRuntime: brain.modelRuntime, model: brain.model, dir: brain.dir, effort: "high", label: "research model" };
    ctx.policy.maxFetches += RESEARCH.architectFetches; // its own fetch budget on top of the research's
    const subject = { name: String(p.name), description: p.description, category: p.category, features: p.features, aliases: p.aliases,
      website_url: p.website_url, docs_url: p.docs_url, competitors: p.competitors.map((c: any) => ({ name: String(c?.name ?? ""), aliases: c?.aliases, domains: c?.domains, evidence_url: c?.evidence_url })) };
    const run = (b: ArchitectBrain) => reviewArchitecture(b, subject,
      { extension: createResearchExtension(ctx, { only: ARCHITECT_TOOLS, purpose: "architect" }), maxCostUsd: RESEARCH.architectMaxCostUsd, maxMinutes: RESEARCH.architectMaxMinutes });
    let used = reviewer.label;
    let r = await run(reviewer);
    // The strongest model failed (an outage, a model the gateway cannot serve): review with the research model instead.
    if (!r && strong) {
      log(`[${id}] architecture review on ${strong.label} failed; retrying on the research model`);
      r = await run({ modelRuntime: brain.modelRuntime, model: brain.model, dir: brain.dir, effort: "high", label: "research model" });
      used = "research model (fallback)";
    }
    if (!r) { log(`[${id}] architecture review gave no usable answer; continuing on the rules alone`); return null; }
    const out = architectOutcome(r.verdict, { name: String(p.name), aliases: p.aliases, competitors: p.competitors }, r.rounds);
    log(`[${id}] architecture review (${used}, ${r.rounds} round(s), $${r.cost.toFixed(3)}): ${r.verdict.placement.layer || "?"}; ` +
        `${out.not_competitors.length} not competing, ${out.questions.length} for the customer, ${out.issues.length} issue(s)`);
    return out;
  };
  const hb = setInterval(() => void ctx.progress(ctx.stage), 60_000);
  let piError: string | null = null;
  let usage: Record<string, number> | undefined;
  try {
    const cwd = join(brain.dir, "cwd");
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: brain.dir,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: prospect ? PROSPECT_SYSTEM_PROMPT : personasOnly ? PERSONAS_ONLY_SYSTEM_PROMPT : RESEARCH_SYSTEM_PROMPT,
      extensionFactories: [{ name: "octillion-research", factory: createResearchExtension(ctx) }],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd, agentDir: brain.dir, modelRuntime: brain.modelRuntime, model: brain.model, thinkingLevel: "low",
      resourceLoader, tools: prospect ? [...PROSPECT_TOOLS] : personasOnly ? [...PERSONAS_ONLY_TOOLS] : [...RESEARCH_TOOLS],
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 3 } }),
    });
    session.subscribe((ev: any) => {
      if (ev.type === "tool_execution_start") log(`[${id}] research -> ${ev.toolName}`);
      if (ev.type === "message_end" && !ctx.outcome) {
        const cost = session.getSessionStats().cost;
        if (cost > maxCost && !piError) { piError = `research LLM cost $${cost.toFixed(3)} exceeded the $${maxCost} cap`; void session.abort(); }
      }
    });
    const budget = setTimeout(() => { piError = `research exceeded ${maxMinutes} minutes`; void session.abort(); }, maxMinutes * 60_000);
    const cancelWatch = setInterval(() => { if (ctx.cancelled || isShuttingDown()) { piError ??= ctx.cancelled ? "job cancelled by the server" : "worker shutting down"; void session.abort(); } }, 2000);
    try {
      const llmError = () => {
        const last: any = [...session.messages].reverse().find((m: any) => m.role === "assistant");
        return last?.stopReason === "error" || last?.stopReason === "aborted" ? `LLM unavailable: ${last.errorMessage ?? last.stopReason}` : null;
      };
      await session.prompt(job.kind === "prospect" ? prospectPrompt(job.input) : personasOnly ? personasOnlyPrompt(job.input as any, job.limits ?? {}) : researchPrompt(job.input, job.limits ?? {}));
      if (!ctx.outcome) piError ??= llmError();
      // The model may end its turn without submitting; nudge it once (only if the LLM itself is working).
      if (!ctx.outcome && !piError) {
        await session.prompt("You have not submitted an accepted result yet. Call validate, fix the issues, then submit.");
        if (!ctx.outcome) piError ??= llmError();
      }
    } catch (e) {
      piError ??= `LLM: ${String(e instanceof Error ? e.message : e)}`;
    } finally {
      clearTimeout(budget);
      clearInterval(cancelWatch);
      const st = session.getSessionStats();
      usage = { requests: st.assistantMessages, input_tokens: st.tokens.input, cache_read_tokens: st.tokens.cacheRead, output_tokens: st.tokens.output, cost_usd: Number(st.cost.toFixed(4)), fetches: ctx.policy.fetches };
      session.dispose();
    }
  } catch (e) {
    piError ??= `research setup: ${String(e instanceof Error ? e.message : e)}`;
  } finally {
    clearInterval(hb);
  }
  if (!ctx.outcome && !ctx.cancelled) {
    const error = redact(piError ?? `no accepted submission${ctx.lastIssues.length ? `; last issues: ${JSON.stringify(ctx.lastIssues).slice(0, 1200)}` : ""}`);
    await completeResearch(id, { status: "failed", error }).catch((e) => log(`[${id}] complete failed:`, String(e)));
    ctx.outcome = { status: "failed", detail: error };
  }
  log(`[${id}] research ${ctx.outcome?.status ?? "cancelled"} usage=${JSON.stringify(usage ?? {})}`);
  return { status: ctx.outcome?.status ?? "cancelled", usage };
}

/** Poll POST /api/worker/research/claim and run jobs (RESEARCH_CONCURRENCY at a time). */
export async function researchLoop(getBrain: () => Promise<BrainLike>): Promise<void> {
  if (!RESEARCH.enabled) return;
  const running = new Set<Promise<unknown>>();
  let missingLogged = false;
  while (!isShuttingDown()) {
    if (running.size >= RESEARCH.concurrency) { await Promise.race(running); continue; }
    let jobs: ResearchJob[] = [];
    try {
      // A per-job orchestrator (ORCHESTRATOR_JOB=rsh_...) claims only its own research.
      const r = (await api("/api/worker/research/claim", { json: { worker_id: CFG.workerId, limit: RESEARCH.concurrency - running.size,
                                                                   research_id: CFG.job?.startsWith("rsh_") ? CFG.job : undefined } })) as { jobs?: ResearchJob[] };
      jobs = r?.jobs ?? [];
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) { if (!missingLogged) log("research: server has no /api/worker/research (older server); polling slowly"); missingLogged = true; await sleep(60_000); continue; }
      log("research claim failed:", String(e));
    }
    for (const job of jobs) {
      log(`[${job.research_id}] research claimed`); // customer inputs (URLs, prompt) stay out of logs
      const release = holdBusy(); // keeps an on-demand orchestrator from idling out mid-research
      const t: Promise<unknown> = getBrain().then((b) => runResearchJob(job, b))
        .catch((e) => log(`[${job.research_id}] research crashed:`, e))
        .finally(() => { running.delete(t); release(); });
      running.add(t);
    }
    if (!jobs.length) await Promise.race([sleep(CFG.pollMs), ...running]);
  }
  await Promise.allSettled(running);
}
