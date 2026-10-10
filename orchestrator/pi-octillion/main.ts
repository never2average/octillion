/**
 * Octillion orchestrator agent: Pi (pi.dev, embedded via its SDK) role-plays the developer for each job.
 *
 * One Pi AgentSession per claimed job, all in this Node process (WORKER_CONCURRENCY in parallel). Each Pi
 * session gets only that job's developer profile and task prompt, plus the pi-octillion tools (no built-in
 * read/bash/edit/write, no discovered extensions, skills, context files or ~/.pi config).
 *
 * Deterministic fallback: if Pi or its LLM fails (error, abort, never started the worker, or left the session
 * open), the host finishes the session itself exactly like worker.ts would. A job is never lost to an LLM error.
 *
 * Run: `npx tsx orchestrator/pi-octillion/main.ts`
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { CFG, ORCH } from "../core/config.js";
import type { Runner } from "../core/runners.js";
import type { Job } from "../core/session.js";
import { log } from "../core/util.js";
import { claimLoop, runDeterministic } from "../worker.js";
import { createOctillionExtension, OCTILLION_TOOLS, OctillionRegistry } from "./index.js";
import { jobPrompt, ORCHESTRATOR_SYSTEM_PROMPT } from "./prompt.js";

interface Brain {
  modelRuntime: ModelRuntime;
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
  dir: string;
}

/** Model runtime isolated from the operator's ~/.pi (own auth.json/models.json in a temp dir). */
export async function createBrain(): Promise<Brain> {
  const dir = await mkdtemp(join(tmpdir(), "octillion-pi-"));
  await mkdir(join(dir, "cwd"), { recursive: true });
  const modelsPath = join(dir, "models.json");
  // ORCHESTRATOR_API_URL: point the provider at a gateway/proxy/test mock; built-in models are kept.
  await writeFile(modelsPath, JSON.stringify({ providers: ORCH.apiUrl ? { [ORCH.provider]: { baseUrl: ORCH.apiUrl } } : {} }));
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath, allowModelNetwork: false });
  if (ORCH.apiKey) await modelRuntime.setRuntimeApiKey(ORCH.provider, ORCH.apiKey);
  const model = modelRuntime.getModel(ORCH.provider, ORCH.model);
  if (!model) throw new Error(`Pi has no model ${ORCH.provider}/${ORCH.model} (ORCHESTRATOR_PROVIDER / ORCHESTRATOR_MODEL)`);
  return { modelRuntime, model, dir };
}

/** Run one job with a fresh Pi session; fall back to the deterministic path on any Pi/LLM failure. */
export async function runJobWithPi(job: Job, runner: Runner, brain: Brain): Promise<void> {
  const reg = new OctillionRegistry(runner);
  const jobId = reg.addJob(job);
  const maxTurns = Number.isFinite(job.max_user_turns) ? Number(job.max_user_turns) : CFG.defaultMaxUserTurns;
  let piError: string | null = null;
  let stats: { cost: number; tokens_in: number; tokens_out: number; calls: number } | null = null;

  try {
    const cwd = join(brain.dir, "cwd");
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: brain.dir,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
      extensionFactories: [{ name: "octillion", factory: createOctillionExtension(reg) }],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd, agentDir: brain.dir,
      modelRuntime: brain.modelRuntime, model: brain.model, thinkingLevel: ORCH.thinking,
      resourceLoader,
      tools: [...OCTILLION_TOOLS], // allowlist: no read/bash/edit/write on the orchestrator host
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: ORCH.maxRetries } }),
    });
    reg.metaFn = () => {
      const st = session.getSessionStats();
      return {
        orchestrator_model: `${ORCH.provider}/${ORCH.model}`,
        orchestrator_cost_usd: Number(st.cost.toFixed(6)),
        orchestrator_tokens_in: st.tokens.input + st.tokens.cacheRead + st.tokens.cacheWrite,
        orchestrator_tokens_out: st.tokens.output,
        orchestrator_llm_calls: st.assistantMessages,
      };
    };
    session.subscribe((ev: any) => {
      if (ev.type === "tool_execution_start") log(`[${job.session_id}] pi -> ${ev.toolName}`);
    });
    // Pi gets the whole session budget plus slack; the session deadline itself is enforced by WorkerSession.
    const budget = setTimeout(() => { piError = "orchestrator exceeded the session budget"; void session.abort(); }, CFG.maxSessionMs + 10 * 60_000);
    try {
      await session.prompt(jobPrompt(jobId, job.profile, job.prompt, maxTurns));
      const last: any = [...session.messages].reverse().find((m: any) => m.role === "assistant");
      if (last?.stopReason === "error" || last?.stopReason === "aborted") piError ??= `pi: ${last.errorMessage ?? last.stopReason}`;
    } catch (e) {
      piError ??= `pi: ${String(e instanceof Error ? e.message : e)}`;
    } finally {
      clearTimeout(budget);
      const st = session.getSessionStats();
      stats = { cost: st.cost, tokens_in: st.tokens.input + st.tokens.cacheRead + st.tokens.cacheWrite, tokens_out: st.tokens.output, calls: st.assistantMessages };
      session.dispose();
    }
  } catch (e) {
    piError ??= `pi setup: ${String(e instanceof Error ? e.message : e)}`;
  }

  const orchestrator = {
    orchestrator: "pi",
    orchestrator_model: `${ORCH.provider}/${ORCH.model}`,
    ...(stats ? { orchestrator_cost_usd: Number(stats.cost.toFixed(6)), orchestrator_tokens_in: stats.tokens_in, orchestrator_tokens_out: stats.tokens_out, orchestrator_llm_calls: stats.calls } : {}),
    ...(piError ? { orchestrator_error: piError.slice(0, 500) } : {}),
  };
  if (piError) log(`[${job.session_id}] ${piError}; deterministic fallback`);

  // Deterministic fallback / safety net.
  const s = reg.sessionByJob.get(jobId);
  if (!s) {
    log(`[${job.session_id}] Pi never started the worker; running it without the simulated developer`);
    await runDeterministic(job, runner, { ...orchestrator, orchestrator: "fallback" });
  } else if (!s.finished) {
    if (!piError) log(`[${job.session_id}] Pi left the session open; finishing it`);
    await s.waitForTurn();
    await s.finish({ orchestrator: { ...orchestrator, orchestrator: "pi+fallback" } });
  }
}

if (process.argv[1] && /pi-octillion[\\/]main\.(ts|js)$/.test(process.argv[1])) {
  (async () => {
    if (!ORCH.apiKey) log("warning: no ORCHESTRATOR_API_KEY/ANTHROPIC_API_KEY; every job will use the deterministic fallback");
    const brain = await createBrain();
    log(`orchestrator brain ${ORCH.provider}/${ORCH.model}${ORCH.apiUrl ? ` via ${ORCH.apiUrl}` : ""} thinking=${ORCH.thinking}`);
    await claimLoop((job, runner) => runJobWithPi(job, runner, brain), "orchestrator");
  })().catch((e) => { console.error(e); process.exit(1); });
}
