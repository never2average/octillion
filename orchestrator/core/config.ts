/** Orchestrator configuration (env vars). Read once at import time. */
import { hostname } from "node:os";

export const env = process.env;
export const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export type RunnerName = "vercel" | "docker" | "local" | "pool";
export type SinkMode = "api" | "clickhouse" | "both";

export const CFG = {
  url: (env.OCTILLION_URL ?? "http://localhost:3000").replace(/\/+$/, ""),
  token: env.OCTILLION_WORKER_TOKEN ?? "",
  workerId: env.WORKER_ID ?? `${hostname()}-${process.pid}`,
  /** Stable orchestrator identity (fleet check-in, orchestrator credentials, pod owner label). */
  orchestratorId: env.ORCHESTRATOR_ID || hostname(),
  /** Per-job orchestrator (set by the autoscaler): the one simulation (sim_...) or research (rsh_...) it serves. */
  job: /^(sim|rsh)_[A-Za-z0-9_-]{1,40}$/.test(env.ORCHESTRATOR_JOB ?? "") ? env.ORCHESTRATOR_JOB! : null,
  concurrency: Math.max(1, num(env.WORKER_CONCURRENCY, 2)),
  runner: (env.RUNNER ?? "vercel") as RunnerName,
  maxSessionMs: num(env.MAX_SESSION_MINUTES, 45) * 60_000,
  pollMs: num(env.POLL_INTERVAL_SECONDS, 5) * 1000,
  flushMs: num(env.FLUSH_INTERVAL_MS, 2000),
  heartbeatMs: num(env.HEARTBEAT_SECONDS, 60) * 1000,
  models: env.WORKER_MODELS ? env.WORKER_MODELS.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
  harness: env.WORKER_HARNESS || undefined,
  defaultMaxUserTurns: num(env.MAX_USER_TURNS, 5),
  /** Hard cap on agent turns (model responses / steps) per session, summed across launch + resumes. */
  maxAgentTurns: Math.max(1, num(env.MAX_AGENT_TURNS, 100)),
  /** Consecutive nudged runs with no workspace change (and not done) before the session ends as agent_gave_up. */
  giveUpRuns: Math.max(1, num(env.GIVE_UP_RUNS, 3)),
  dockerImage: env.SANDBOX_IMAGE ?? "octillion-sandbox:latest",
  dockerNetwork: env.DOCKER_NETWORK || undefined,
  dockerCpus: env.DOCKER_CPUS ?? "2",
  dockerMemory: env.DOCKER_MEMORY ?? "4g",
  anthropicKey: env.ANTHROPIC_API_KEY ?? "",
  openaiKey: env.OPENAI_API_KEY ?? env.CODEX_API_KEY ?? "",
  maxBudgetUsd: env.MAX_BUDGET_USD || undefined, // Claude Code --max-budget-usd per harness run
  claudeBin: env.CLAUDE_BIN ?? "claude",
  codexBin: env.CODEX_BIN ?? "codex",
};

/** Where transcript events go. The server's /complete recounts events from the store, so either works for scoring. */
export const SINK = {
  mode: (["clickhouse", "both"].includes(env.TRANSCRIPT_SINK ?? "") ? env.TRANSCRIPT_SINK : "api") as SinkMode,
  chUrl: (env.CLICKHOUSE_URL ?? "").replace(/\/+$/, ""),
  chUser: env.CLICKHOUSE_USER ?? "default",
  chPassword: env.CLICKHOUSE_PASSWORD ?? "",
  chDatabase: env.CLICKHOUSE_DATABASE ?? "octillion",
};

/**
 * Sandbox providers that are gone, with what to do instead. boat.dev was retired on 2026-11-01: Vercel Sandbox is the only
 * sandbox provider. A setting that still names boat is a clear error (startup, Compute), never a silent fallback.
 */
export const RETIRED_PROVIDERS: Record<string, string> = { boat: "boat.dev was retired on 2026-11-01" };
/** Why this env's sandbox settings cannot work (a retired or unknown provider, a retired runner), else null. */
export function sandboxConfigError(e: Record<string, string | undefined> = env): string | null {
  for (const k of ["OCTILLION_SANDBOX_PROVIDER", "OCTILLION_ORCHESTRATOR_PROVIDER"]) {
    const v = (e[k] ?? "").trim().toLowerCase();
    if (!v || v === "vercel") continue;
    return `${k}=${v}: ${RETIRED_PROVIDERS[v] ?? "unknown sandbox provider"}. Vercel Sandbox is the only provider: unset ${k} (or set it to "vercel").`;
  }
  const r = (e.RUNNER ?? "").trim().toLowerCase();
  if (RETIRED_PROVIDERS[r]) return `RUNNER=${r}: ${RETIRED_PROVIDERS[r]}. Use RUNNER=vercel (the default).`;
  return null;
}

/**
 * Worker sandboxes (core/runners.ts vmRunner, core/sandbox-provider.ts): Vercel Sandbox, reached only through the API's
 * broker (/api/worker/sandboxes, src/worker-sandboxes.ts). The Vercel credentials (the function's OIDC token) never leave
 * our functions; this process uses its worker token.
 */
export const SANDBOX = {
  /** Vercel size: small 1 vCPU / 2 GB, default 2 / 4, large 4 / 8, xlarge 8 / 16 (2 GB per vCPU, as Vercel allocates). */
  vercelSize: env.OCTILLION_VERCEL_WORKER_SIZE ?? "default",
  /** Longest single broker call (s): the API function stops at 300 s, so execs and log follows stay well under it. */
  vercelExecMaxSeconds: Math.max(30, Math.min(250, num(env.OCTILLION_VERCEL_EXEC_MAX_SECONDS, 240))),
  /** Share of the provisioned vCPUs assumed busy, for the cost estimate (agents mostly wait on the model). */
  vercelCpuActiveShare: Math.max(0, Math.min(1, num(env.OCTILLION_VERCEL_CPU_ACTIVE_SHARE, 0.3))),
  /** A worker sandbox's timeout: setup + all turns + LLM time, so the session plus a margin (the broker caps it). */
  ttlSeconds: Math.round(CFG.maxSessionMs / 1000) + num(env.OCTILLION_SANDBOX_TTL_MARGIN_MINUTES, 15) * 60,
  readyTimeoutMs: num(env.OCTILLION_SANDBOX_READY_TIMEOUT_SECONDS, 300) * 1000,
  /** The session diff kept (bytes); a longer one is cut with a marker. */
  diffMaxBytes: num(env.OCTILLION_DIFF_MAX_BYTES, 2_000_000),
};
export const VERCEL_SIZES: Record<string, { vcpus: number; memoryMb: number }> = {
  small: { vcpus: 1, memoryMb: 2048 }, default: { vcpus: 2, memoryMb: 4096 }, large: { vcpus: 4, memoryMb: 8192 }, xlarge: { vcpus: 8, memoryMb: 16384 },
};
/**
 * Vercel Sandbox prices (Pro, iad1; https://vercel.com/docs/sandbox/pricing, 2026-11): active CPU per vCPU-hour, provisioned
 * memory per GB-hour (1-minute minimum), creations. Estimate for /complete metadata only (src/sandbox-probe.ts: same rates).
 */
export const VERCEL_SANDBOX_PRICE = { cpuHour: 0.128, memGbHour: 0.0212, creation: 0.6 / 1e6 };
export function vercelEstCostUsd(size: string, seconds: number, cpuShare = SANDBOX.vercelCpuActiveShare): number {
  const s = VERCEL_SIZES[size] ?? VERCEL_SIZES.default!;
  const h = seconds / 3600, memH = Math.max(seconds, 60) / 3600;
  return Number((s.vcpus * cpuShare * h * VERCEL_SANDBOX_PRICE.cpuHour + (s.memoryMb / 1024) * memH * VERCEL_SANDBOX_PRICE.memGbHour + VERCEL_SANDBOX_PRICE.creation).toFixed(5));
}

/** The orchestrator brain (Pi). Its key is used only in this process and never reaches a sandbox. */
export const ORCH = {
  // Fallbacks only: with CREDENTIALS_MODE=broker (default) the server's broker decides provider + model.
  provider: env.ORCHESTRATOR_PROVIDER ?? "openai",
  model: env.ORCHESTRATOR_MODEL ?? "gpt-6.1-sol",
  apiKey: env.ORCHESTRATOR_API_KEY ?? ((env.ORCHESTRATOR_PROVIDER ?? "openai") === "openai" ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY) ?? "",
  apiUrl: env.ORCHESTRATOR_API_URL || undefined, // override the provider base URL (proxy, gateway, test mock)
  thinking: (env.ORCHESTRATOR_THINKING ?? "low") as "off" | "minimal" | "low" | "medium" | "high",
  maxRetries: num(env.ORCHESTRATOR_MAX_RETRIES, 3),
};
