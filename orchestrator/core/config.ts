/** Orchestrator configuration (env vars). Read once at import time. */
import { hostname } from "node:os";

export const env = process.env;
export const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export type RunnerName = "boat" | "vercel" | "docker" | "local" | "pool";
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
  runner: (env.RUNNER ?? "boat") as RunnerName,
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

/** boat.dev (https://docs.boat.dev/api/v1). Only used by RUNNER=boat. */
export const BOAT = {
  apiUrl: (env.BOAT_API_URL ?? "https://boat.dev/api/v1").replace(/\/+$/, ""),
  apiKey: env.BOAT_API_KEY ?? "",
  size: env.BOAT_SANDBOX_SIZE ?? "default", // small | default | large | xlarge
  org: env.BOAT_ORG || undefined,
  // Auto-stop TTL counts from creation and is NOT extended by exec'd work: cover setup + all turns + LLM time.
  ttlSeconds: Math.round(CFG.maxSessionMs / 1000) + num(env.BOAT_TTL_MARGIN_MINUTES, 15) * 60,
  readyTimeoutMs: num(env.BOAT_READY_TIMEOUT_SECONDS, 300) * 1000,
  agentUser: (env.BOAT_AGENT_USER === "user" ? "user" : "agent") as "agent" | "user",
  onFinish: (env.BOAT_ON_FINISH === "stop" ? "stop" : "delete") as "delete" | "stop",
  diffMaxBytes: num(env.BOAT_DIFF_MAX_BYTES, 2_000_000),
};
/** $/hour per size, from https://docs.boat.dev/pricing (2026-10). Estimate for /complete metadata only. */
export const BOAT_PRICE_PER_HOUR: Record<string, number> = { small: 0.018, default: 0.036, large: 0.072, xlarge: 0.2 };

/**
 * Worker sandbox provider (core/sandbox-provider.ts). The orchestrator itself still runs on boat; only the per-session
 * worker sandboxes move. Selected by, in order: RUNNER=vercel, OCTILLION_SANDBOX_PROVIDER here, else the server's choice in
 * the orchestrator credentials answer (`sandbox_provider`, from OCTILLION_SANDBOX_PROVIDER on the API). Default boat.
 *
 * vercel: Vercel Sandbox, reached only through the API's broker (/api/worker/sandboxes, src/worker-sandboxes.ts): the
 * Vercel credentials (the function's OIDC token) never leave our functions; this process uses its worker token.
 */
export const SANDBOX = {
  /** Explicit choice in this process's env; null = take the server's. */
  provider: (env.RUNNER === "vercel" ? "vercel" : env.OCTILLION_SANDBOX_PROVIDER === "vercel" ? "vercel" : env.OCTILLION_SANDBOX_PROVIDER === "boat" ? "boat" : null) as "boat" | "vercel" | null,
  /** Vercel size: small 1 vCPU / 2 GB, default 2 / 4, large 4 / 8, xlarge 8 / 16 (2 GB per vCPU, as Vercel allocates). */
  vercelSize: env.OCTILLION_VERCEL_WORKER_SIZE ?? "default",
  /** Longest single broker call (s): the API function stops at 300 s, so execs and log follows stay well under it. */
  vercelExecMaxSeconds: Math.max(30, Math.min(270, num(env.OCTILLION_VERCEL_EXEC_MAX_SECONDS, 240))),
  /** Share of the provisioned vCPUs assumed busy, for the cost estimate (agents mostly wait on the model). */
  vercelCpuActiveShare: Math.max(0, Math.min(1, num(env.OCTILLION_VERCEL_CPU_ACTIVE_SHARE, 0.3))),
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
