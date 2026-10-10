# Credentials: key vault, broker and inference gateway

**Goal.** Provider keys exist only in the encrypted vault on the server. Sub-agents in pods and sandboxes never
hold a real key. Orchestrator hosts hold only `OCTILLION_URL` and `OCTILLION_WORKER_TOKEN`.

```
operator ──vault CLI / admin API──▶ vault (Postgres, AES-256-GCM, master key OCTILLION_VAULT_KEY)
orchestrator ──POST /api/worker/orchestrator/credentials──▶ boat key + its own LLM access (gateway token)
orchestrator ──POST /api/worker/sessions/:id/credentials──▶ per-session env for the harness
sub-agent (pod / boat VM) ──ogw_ token──▶ /gw/<provider>/… ──real key from vault──▶ provider API
```

## Providers

| provider | mode | upstream | how the gateway authenticates upstream |
|---|---|---|---|
| `anthropic` | gateway | https://api.anthropic.com | `x-api-key` |
| `openai` | gateway | https://api.openai.com | `Authorization: Bearer` |
| `google` | gateway | https://generativelanguage.googleapis.com | `x-goog-api-key` |
| `dashscope` | gateway | https://dashscope-intl.aliyuncs.com | `Authorization: Bearer` |
| `github_copilot`, `cursor`, `amp`, `factory` | direct | vendor-hosted | the real key is brokered to the session (no proxy possible) |
| `boat` | direct (orchestrator only) | https://boat.dev/api/v1 | `Authorization: Bearer` |

`mode: gateway`: the sub-agent gets `base_url = {PUBLIC_URL}/gw/<provider>` and `api_key = ogw_…`. The gateway
accepts the token in any of `x-api-key`, `Authorization: Bearer`, `x-goog-api-key` or `?key=`. It strips it,
injects the real key, streams the request and response through, and meters usage.

`mode: direct`: the real key is returned by the broker for that one session, short-lived from Octillion's
side. Use it only for vendor-hosted agents that can't take a custom base URL.

## Worker API (Bearer `OCTILLION_WORKER_TOKEN`)

`POST /api/worker/orchestrator/credentials` `{orchestrator_id}` →
```json
{ "boat": {"api_key": "boat_…"} | null,
  "llm": {"provider": "openai", "model": "gpt-6.1-sol", "base_url": "https://host/gw/openai/v1", "api_key": "ogw_…", "expires_at": "…"} }
```
The server chooses the orchestrators' brain with `ORCHESTRATOR_PROVIDER` / `ORCHESTRATOR_MODEL` (default
`openai` / `gpt-6.1-sol`). `base_url` already includes the path SDKs expect: `/v1` for OpenAI.
The token is valid for 12h; refetch on 401 or near expiry.

`POST /api/worker/sessions/:id/credentials` (the session must be `running`) →
```json
{ "expires_at": "…",
  "providers": {
    "anthropic": {"mode": "gateway", "base_url": "https://host/gw/anthropic", "api_key": "ogw_…"},
    "openai":    {"mode": "gateway", "base_url": "https://host/gw/openai/v1", "api_key": "ogw_…"},
    "github_copilot": {"mode": "direct", "api_key": "<real token>"}
  },
  "env": { "ANTHROPIC_BASE_URL": "…", "ANTHROPIC_API_KEY": "ogw_…", "OPENAI_BASE_URL": "…", "OPENAI_API_KEY": "ogw_…", "COPILOT_GITHUB_TOKEN": "…" } }
```
- `providers` lists those the session's agent needs, taken from the registry's `requires_env`.
- `env` is a suggested mapping for common CLIs. Harness adapters may map `providers` to their own variables
  instead, for example `GOOGLE_GEMINI_BASE_URL`.
- The token expires when the session finishes, or after `OCTILLION_LEASE_MINUTES`, whichever comes first.
- One token per session covers all of that session's gateway providers.

## Gateway limits

- **Per-session caps:** `OCTILLION_GATEWAY_MAX_REQUESTS` (default 1000) and `OCTILLION_GATEWAY_MAX_TOKENS`
  (default 5M input+output). Over a cap the gateway returns 429 with
  `{"error": {"type": "octillion_budget_exceeded"}}`.
- **Metering:** usage is recorded per session and provider: requests, input/output tokens parsed from JSON or SSE,
  and bytes.
