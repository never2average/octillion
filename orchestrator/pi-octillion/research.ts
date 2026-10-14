/**
 * Research mode (docs/onboarding.md): a dedicated Pi session per research job, on the same broker brain, with
 * research-only tools (fetch_url, search_library, report_progress, validate, submit). No coding-agent tools,
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
import { isShuttingDown } from "../core/session.js";
import { api, HttpError, log, sleep, withRetry } from "../core/util.js";
import { RESEARCH_SYSTEM_PROMPT, researchPrompt, type ResearchInput, type ResearchLimits } from "./research-prompt.js";
import { holdBusy } from "../core/activity.js";

export interface ResearchJob { research_id: string; input: ResearchInput; limits?: ResearchLimits }

export interface BrainLike {
  modelRuntime: ModelRuntime;
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
  dir: string;
  apiKey: string;
}

export const RESEARCH = {
  concurrency: Math.max(1, num(env.RESEARCH_CONCURRENCY, 1)),
  maxMinutes: num(env.RESEARCH_MAX_MINUTES, 20),
  maxSubmits: num(env.RESEARCH_MAX_SUBMITS, 4),
  maxFetches: num(env.RESEARCH_MAX_FETCHES, 25),
  /** Hard LLM spend cap per research job (Pi's price table); the session is aborted and the job failed above it. */
  maxCostUsd: num(env.RESEARCH_MAX_COST_USD, 2),
  enabled: env.RESEARCH_DISABLED !== "1",
};
export const RESEARCH_TOOLS = ["fetch_url", "search_library", "report_progress", "validate", "submit"] as const;
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

  constructor(readonly job: ResearchJob) {
    this.policy = new FetchPolicy([job.input.website_url, job.input.docs_url], RESEARCH.maxFetches);
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

export function createResearchExtension(ctx: ResearchContext) {
  return (pi: ExtensionAPI) => {
    pi.registerTool(defineTool({
      name: "fetch_url", label: "Fetch URL",
      description: "HTTP GET a page from the product's website/docs (or its package registry / GitHub) and return readable text plus same-site links. About 25 fetches per job.",
      parameters: Type.Object({ url: Type.String() }),
      executionMode: "sequential",
      async execute(_id, p) {
        try { return text(await fetchReadable(p.url, ctx.policy)); }
        catch (e) { throw new Error(`fetch_url failed: ${(e as Error).message}`); }
      },
    }));
    pi.registerTool(defineTool({
      name: "search_library", label: "Search task library",
      description: "Search the curated library of realistic coding tasks. Returns tasks with ids you can reuse via library_task_id.",
      parameters: Type.Object({ query: Type.String(), category: Type.Optional(Type.String()), language: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })) }),
      executionMode: "sequential",
      async execute(_id, p) {
        const q = new URLSearchParams({ query: p.query, ...(p.category ? { category: p.category } : {}), ...(p.language ? { language: p.language } : {}), limit: String(p.limit ?? 10) });
        return text(await api(`/api/worker/library/tasks?${q}`, { method: "GET" }));
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
  const hb = setInterval(() => void ctx.progress(ctx.stage), 60_000);
  let piError: string | null = null;
  let usage: Record<string, number> | undefined;
  try {
    const cwd = join(brain.dir, "cwd");
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: brain.dir,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: RESEARCH_SYSTEM_PROMPT,
      extensionFactories: [{ name: "octillion-research", factory: createResearchExtension(ctx) }],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd, agentDir: brain.dir, modelRuntime: brain.modelRuntime, model: brain.model, thinkingLevel: "low",
      resourceLoader, tools: [...RESEARCH_TOOLS],
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 3 } }),
    });
    session.subscribe((ev: any) => {
      if (ev.type === "tool_execution_start") log(`[${id}] research -> ${ev.toolName}`);
      if (ev.type === "message_end" && !ctx.outcome) {
        const cost = session.getSessionStats().cost;
        if (cost > RESEARCH.maxCostUsd && !piError) { piError = `research LLM cost $${cost.toFixed(3)} exceeded RESEARCH_MAX_COST_USD=${RESEARCH.maxCostUsd}`; void session.abort(); }
      }
    });
    const budget = setTimeout(() => { piError = `research exceeded ${RESEARCH.maxMinutes} minutes`; void session.abort(); }, RESEARCH.maxMinutes * 60_000);
    const cancelWatch = setInterval(() => { if (ctx.cancelled || isShuttingDown()) { piError ??= ctx.cancelled ? "job cancelled by the server" : "worker shutting down"; void session.abort(); } }, 2000);
    try {
      const llmError = () => {
        const last: any = [...session.messages].reverse().find((m: any) => m.role === "assistant");
        return last?.stopReason === "error" || last?.stopReason === "aborted" ? `LLM unavailable: ${last.errorMessage ?? last.stopReason}` : null;
      };
      await session.prompt(researchPrompt(job.input, job.limits ?? {}));
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
      log(`[${job.research_id}] research claimed: ${job.input?.website_url ?? ""} ${job.input?.docs_url ?? ""}`);
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
