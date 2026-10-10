import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { Request, Response } from "express";
import { getDb } from "./db.js";
import { findAgent } from "./agents.js";
import { getProvider, providersForEnv, useCredential, type ProviderRow } from "./keyvault.js";

/**
 * Inference gateway + credential broker (docs/credentials.md).
 *
 * Sub-agents get `ogw_` tokens scoped to a session, its providers and its lease; they call
 * {PUBLIC_URL}/gw/<provider>/... and the gateway swaps the token for a real key from the vault, streams the
 * request and response through, and meters requests/tokens/bytes per session. Vendor-hosted agents that cannot
 * take a custom base URL (mode `direct`) get the real key from the broker for that session only.
 */

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const PUBLIC_URL = () => (process.env.PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3333}`).replace(/\/$/, "");
const LEASE_MINUTES = () => Number(process.env.OCTILLION_LEASE_MINUTES ?? 30);
const MAX_REQUESTS = () => Number(process.env.OCTILLION_GATEWAY_MAX_REQUESTS ?? 1000);
const MAX_TOKENS = () => Number(process.env.OCTILLION_GATEWAY_MAX_TOKENS ?? 5_000_000);

/** Requires-env fallback for sessions whose agent is not in the registry. */
const HARNESS_ENV: Record<string, string[]> = { "claude-code": ["ANTHROPIC_API_KEY"], codex: ["CODEX_API_KEY", "OPENAI_API_KEY"] };

/** Conventional env names for gateway providers (adapters may map providers to their own variables instead). */
const GATEWAY_ENV: Record<string, (base: string, token: string) => Record<string, string>> = {
  anthropic: (b, t) => ({ ANTHROPIC_BASE_URL: b, ANTHROPIC_API_KEY: t }),
  openai: (b, t) => ({ OPENAI_BASE_URL: `${b}/v1`, OPENAI_API_KEY: t, CODEX_API_KEY: t }),
  google: (b, t) => ({ GOOGLE_GEMINI_BASE_URL: b, GEMINI_API_KEY: t }),
  dashscope: (b, t) => ({ DASHSCOPE_BASE_URL: `${b}/compatible-mode/v1`, DASHSCOPE_API_KEY: t }),
};

async function mintToken(kind: "session" | "orchestrator", providers: string[], expiresAt: Date, ref: { sessionId?: string; orchestratorId?: string }) {
  const token = `ogw_${randomBytes(24).toString("base64url")}`;
  await (await getDb()).query(
    `INSERT INTO gateway_tokens (token_hash, kind, session_id, orchestrator_id, providers, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [sha256(token), kind, ref.sessionId ?? null, ref.orchestratorId ?? null, providers, expiresAt],
  );
  return token;
}

/** Credentials for one running agent session: gateway providers get a scoped token, direct ones the real key. */
export async function brokerSessionCredentials(sessionId: string) {
  const db = await getDb();
  const [s] = await db.query<{ status: string; agent_id: string | null; harness: string }>(
    "SELECT status, agent_id, harness FROM agent_sessions WHERE id = $1", [sessionId]);
  if (!s) throw Object.assign(new Error(`No session ${sessionId}`), { status: 404 });
  if (s.status !== "running") throw Object.assign(new Error(`Session ${sessionId} is ${s.status}, not running`), { status: 409 });

  const needs = (s.agent_id && findAgent(s.agent_id)?.requires_env) || HARNESS_ENV[s.harness] || [];
  const providers = await providersForEnv(needs);
  const missing = needs.filter((v) => !providers.some((p) => p.env_vars.includes(v)));
  if (missing.length) throw Object.assign(new Error(`No vault provider supplies ${missing.join(", ")}`), { status: 503 });

  const expiresAt = new Date(Date.now() + LEASE_MINUTES() * 60_000);
  const gatewaySlugs = providers.filter((p) => p.mode === "gateway").map((p) => p.slug);
  const token = gatewaySlugs.length ? await mintToken("session", gatewaySlugs, expiresAt, { sessionId }) : null;
  const out: Record<string, { mode: string; base_url?: string; api_key: string }> = {};
  const env: Record<string, string> = {};
  for (const p of providers) {
    if (p.mode === "gateway") {
      const base = `${PUBLIC_URL()}/gw/${p.slug}`;
      out[p.slug] = { mode: "gateway", base_url: base, api_key: token! };
      Object.assign(env, GATEWAY_ENV[p.slug]?.(base, token!) ?? Object.fromEntries(p.env_vars.map((v) => [v, token!])));
    } else {
      const { secret } = await useCredential(p.slug);
      out[p.slug] = { mode: "direct", api_key: secret };
      for (const v of p.env_vars.filter((v) => needs.includes(v))) env[v] = secret;
    }
  }
  return { expires_at: expiresAt.toISOString(), providers: out, env };
}

/** The orchestrator's own access: boat.dev key (if in the vault) and gateway access for its LLM. */
export async function brokerOrchestratorCredentials(orchestratorId: string) {
  const llmProvider = process.env.ORCHESTRATOR_PROVIDER ?? "anthropic";
  const p = await getProvider(llmProvider);
  const expiresAt = new Date(Date.now() + 12 * 3600_000);
  const boat = await useCredential("boat").then((c) => ({ api_key: c.secret })).catch(() => null);
  const llm = p?.mode === "gateway" && p.enabled
    ? { provider: llmProvider, base_url: `${PUBLIC_URL()}/gw/${llmProvider}`, api_key: await mintToken("orchestrator", [llmProvider], expiresAt, { orchestratorId }), expires_at: expiresAt.toISOString() }
    : null;
  return { boat, llm };
}

export async function revokeSessionTokens(sessionId: string) {
  await (await getDb()).query("UPDATE gateway_tokens SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL", [sessionId]);
}

/** Gateway-metered usage for a session (summed over providers). */
export async function sessionGatewayUsage(sessionId: string) {
  const [u] = await (await getDb()).query<{ requests: number; input_tokens: number; output_tokens: number }>(
    `SELECT coalesce(sum(requests), 0) AS requests, coalesce(sum(input_tokens), 0) AS input_tokens,
            coalesce(sum(output_tokens), 0) AS output_tokens FROM gateway_usage WHERE session_id = $1`,
    [sessionId],
  );
  return { requests: Number(u.requests), input_tokens: Number(u.input_tokens), output_tokens: Number(u.output_tokens) };
}

// ---------- the proxy ----------

const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]);
const CLIENT_AUTH = ["authorization", "x-api-key", "x-goog-api-key", "api-key", "cookie"];

function tokenFrom(req: Request): string | null {
  const h = req.headers;
  const candidates = [
    String(h["x-api-key"] ?? ""), String(h["x-goog-api-key"] ?? ""), String(h["api-key"] ?? ""),
    String(h.authorization ?? "").replace(/^Bearer\s+/i, ""), String((req.query as Record<string, unknown>).key ?? ""),
  ];
  return candidates.find((c) => c.startsWith("ogw_")) ?? null;
}

const gwError = (res: Response, status: number, type: string, message: string) =>
  void res.status(status).json({ type: "error", error: { type, message } });

/** Pulls token usage out of JSON or SSE bodies from Anthropic, OpenAI (chat + responses) and Gemini. */
class UsageMeter {
  input = 0; output = 0; bytes = 0;
  private buf = "";
  private sse: boolean;
  constructor(contentType: string) { this.sse = /event-stream/.test(contentType); }
  feed(chunk: Buffer) {
    this.bytes += chunk.length;
    this.buf += chunk.toString("utf8");
    if (this.sse) {
      const lines = this.buf.split("\n");
      this.buf = lines.pop() ?? "";
      for (const l of lines) if (l.startsWith("data:")) this.json(l.slice(5).trim());
    } else if (this.buf.length > 4_000_000) this.buf = ""; // give up metering absurdly large bodies
  }
  end() { if (this.sse) { if (this.buf.startsWith("data:")) this.json(this.buf.slice(5).trim()); } else this.json(this.buf); }
  private json(text: string) {
    if (!text || text === "[DONE]") return;
    let e: any;
    try { e = JSON.parse(text); } catch { return; }
    const u = e?.usage ?? e?.message?.usage ?? e?.response?.usage ?? null;
    if (u) {
      // Anthropic: message_start carries input, message_delta the cumulative output; OpenAI: prompt/completion or input/output.
      const inp = u.input_tokens ?? u.prompt_tokens ?? 0;
      const out = u.output_tokens ?? u.completion_tokens ?? 0;
      if (inp) this.input = Math.max(this.input, inp + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0));
      if (out) this.output = Math.max(this.output, out);
    }
    const g = e?.usageMetadata ?? (Array.isArray(e) ? e.at(-1)?.usageMetadata : null);
    if (g) { this.input = Math.max(this.input, g.promptTokenCount ?? 0); this.output = Math.max(this.output, g.candidatesTokenCount ?? 0); }
  }
}

export async function gatewayHandler(req: Request, res: Response) {
  const slug = String(req.params.provider);
  const token = tokenFrom(req);
  if (!token) return gwError(res, 401, "authentication_error", "Missing Octillion gateway token");
  const db = await getDb();
  const hash = sha256(token);
  const [t] = await db.query<{ kind: string; session_id: string | null; orchestrator_id: string | null; providers: string[]; expires_at: Date; revoked_at: Date | null }>(
    "SELECT kind, session_id, orchestrator_id, providers, expires_at, revoked_at FROM gateway_tokens WHERE token_hash = $1", [hash]);
  if (!t || t.revoked_at || new Date(t.expires_at) < new Date()) return gwError(res, 401, "authentication_error", "Gateway token is invalid, expired or revoked");
  if (!t.providers.includes(slug)) return gwError(res, 403, "permission_error", `Token is not allowed to use ${slug}`);
  // Some CLIs (Codex) probe a WebSocket transport first; refuse fast so they fall back to HTTP immediately.
  if (req.headers.upgrade) return gwError(res, 426, "invalid_request_error", "WebSocket is not supported by the Octillion gateway; use HTTP");
  const p: ProviderRow | null = await getProvider(slug);
  if (!p?.enabled || p.mode !== "gateway" || !p.upstream_url) return gwError(res, 404, "not_found_error", `No gateway provider ${slug}`);

  const [used] = await db.query<{ requests: number; tokens: number }>(
    "SELECT coalesce(sum(requests), 0) AS requests, coalesce(sum(input_tokens + output_tokens), 0) AS tokens FROM gateway_usage WHERE token_hash = $1", [hash]);
  if (Number(used.requests) >= MAX_REQUESTS() || Number(used.tokens) >= MAX_TOKENS())
    return gwError(res, 429, "octillion_budget_exceeded", "This session's gateway budget is used up");

  let cred: { id: number; secret: string };
  try { cred = await useCredential(slug); }
  catch (e) { return gwError(res, 503, "api_error", (e as Error).message); }

  // Path after /gw/<provider>, query without our `key` parameter.
  const url = new URL(req.originalUrl, "http://x");
  url.searchParams.delete("key");
  const rest = url.pathname.replace(new RegExp(`^/gw/${slug}`), "") || "/";
  const upstream = `${p.upstream_url.replace(/\/$/, "")}${rest}${url.search}`;

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || HOP.has(k) || CLIENT_AUTH.includes(k) || k === "accept-encoding") continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  headers.set("accept-encoding", "identity"); // keep the body readable for metering
  headers.set(p.auth_header, `${p.auth_prefix}${cred.secret}`);
  // Anthropic's OpenAI-compatible endpoint (used by Cline) is called with OpenAI-style auth; give it both forms.
  if (slug === "anthropic" && /\/chat\/completions$/.test(rest)) headers.set("authorization", `Bearer ${cred.secret}`);

  const hasBody = !["GET", "HEAD"].includes(req.method);
  let up: globalThis.Response;
  try {
    up = await fetch(upstream, {
      method: req.method, headers, redirect: "manual",
      body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
      // @ts-expect-error Node's fetch needs duplex for streamed request bodies
      duplex: hasBody ? "half" : undefined,
      signal: AbortSignal.timeout(Number(process.env.OCTILLION_GATEWAY_TIMEOUT_MS ?? 600_000)),
    });
  } catch (e) {
    await record(hash, slug, t, { requests: 1, errors: 1, input: 0, output: 0, bytes: 0 });
    return gwError(res, 502, "api_error", `Upstream ${slug} unreachable: ${(e as Error).message}`);
  }

  res.status(up.status);
  up.headers.forEach((v, k) => { if (!HOP.has(k) && k !== "content-encoding" && k !== "content-length") res.setHeader(k, v); });
  const meter = new UsageMeter(up.headers.get("content-type") ?? "");
  try {
    if (up.body) for await (const chunk of up.body as unknown as AsyncIterable<Uint8Array>) {
      const b = Buffer.from(chunk);
      meter.feed(b);
      res.write(b);
    }
  } finally {
    meter.end();
    res.end();
    await record(hash, slug, t, { requests: 1, errors: up.status >= 400 ? 1 : 0, input: meter.input, output: meter.output, bytes: meter.bytes });
  }
}

async function record(hash: string, provider: string, t: { session_id: string | null; orchestrator_id: string | null },
                      u: { requests: number; errors: number; input: number; output: number; bytes: number }) {
  await (await getDb()).query(
    `INSERT INTO gateway_usage (token_hash, provider, session_id, orchestrator_id, requests, errors, input_tokens, output_tokens, bytes, last_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (token_hash, provider) DO UPDATE SET requests = gateway_usage.requests + excluded.requests,
       errors = gateway_usage.errors + excluded.errors, input_tokens = gateway_usage.input_tokens + excluded.input_tokens,
       output_tokens = gateway_usage.output_tokens + excluded.output_tokens, bytes = gateway_usage.bytes + excluded.bytes, last_at = now()`,
    [hash, provider, t.session_id, t.orchestrator_id, u.requests, u.errors, u.input, u.output, u.bytes],
  ).catch((e) => console.error("gateway usage record failed:", e.message));
}
