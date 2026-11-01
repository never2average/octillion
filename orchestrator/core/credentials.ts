/**
 * Credential broker client (docs/credentials.md). The orchestrator host holds only OCTILLION_URL and
 * OCTILLION_WORKER_TOKEN; everything else comes from the server:
 *   POST /api/worker/orchestrator/credentials {orchestrator_id} -> the orchestrator LLM's gateway access
 *   POST /api/worker/sessions/:id/credentials                    -> per-session providers (gateway ogw_ tokens / direct keys)
 *
 * CREDENTIALS_MODE=env is a dev fallback that reads provider keys from this process's env instead.
 */
import { CFG, ORCH, env } from "./config.js";
import { api, HttpError, log, withRetry } from "./util.js";
import { providersFromEnv, type Providers } from "../harnesses/credentials.js";

export const CREDENTIALS_MODE = (env.CREDENTIALS_MODE === "env" ? "env" : "broker") as "broker" | "env";

export interface OrchestratorCreds {
  llm: { provider: string; model?: string; base_url: string; api_key: string; expires_at?: string } | null;
  /** Research's architecture review: the strongest model, possibly another provider (pi-octillion/architect.ts). */
  architect?: { provider: string; model: string; effort?: string; base_url: string; api_key: string; expires_at?: string } | null;
  /** The server's worker sandbox provider: always "vercel" (still sent for orchestrators launched by older code). */
  sandbox_provider?: "vercel";
}

export interface SessionCreds { providers: Providers; expires_at: string | null }

const REFRESH_BEFORE_MS = 30 * 60_000;
let orch: OrchestratorCreds | null = null;
let orchFetching: Promise<OrchestratorCreds> | null = null;

const expiresSoon = (iso: string | null | undefined, ms = REFRESH_BEFORE_MS) => !!iso && Date.parse(iso) - Date.now() < ms;

/** Redact secrets for logs. */
export const redact = (s: string) => s.replace(/\b(ogw_|sk-ant-|sk-|gho_|ghp_)[A-Za-z0-9_\-]{4,}/g, "$1***");

/** Orchestrator credentials (cached; refetched near expiry or when `force`). */
export async function orchestratorCredentials(force = false): Promise<OrchestratorCreds> {
  if (CREDENTIALS_MODE === "env") {
    return {
      llm: ORCH.apiKey ? { provider: ORCH.provider, model: ORCH.model, base_url: ORCH.apiUrl ?? "", api_key: ORCH.apiKey } : null,
    };
  }
  if (orch && !force && !expiresSoon(orch.llm?.expires_at)) return orch;
  orchFetching ??= (async () => {
    try {
      const r = (await withRetry(() => api("/api/worker/orchestrator/credentials", { json: { orchestrator_id: CFG.orchestratorId } }), 4)) as OrchestratorCreds;
      orch = { llm: r?.llm ?? null, architect: r?.architect ?? null, sandbox_provider: "vercel" };
      log(`credentials: orchestrator ${CFG.orchestratorId}: llm=${orch.llm ? `${orch.llm.provider}/${orch.llm.model ?? "?"} via gateway (expires ${orch.llm.expires_at ?? "?"})` : "none"}`);
      return orch;
    } finally { orchFetching = null; }
  })();
  return orchFetching;
}

/** Per-session provider credentials, fetched after claim and before each harness run when near expiry. */
export async function sessionCredentials(sessionId: string): Promise<SessionCreds> {
  if (CREDENTIALS_MODE === "env") return { providers: providersFromEnv(), expires_at: null };
  const r = (await withRetry(() => api(`/api/worker/sessions/${encodeURIComponent(sessionId)}/credentials`, { json: {} }), 4)) as
    { providers?: Providers; expires_at?: string };
  if (!r?.providers) throw new HttpError(502, "credential broker returned no providers");
  return { providers: r.providers, expires_at: r.expires_at ?? null };
}

export const sessionCredsExpiring = (c: SessionCreds) => expiresSoon(c.expires_at, 5 * 60_000);
