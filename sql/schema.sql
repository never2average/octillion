-- Octillion schema. Idempotent: every statement is IF NOT EXISTS, so it runs on every boot.
--
--   organizations / api_keys     dev-tool companies (tenants) and the keys their MCP connectors use
--   products                     product context a company configures: names, packages, competitors
--   scenarios                    real-world coding tasks where the product should (or should not) come up
--   simulations                  one launch: scenarios x models x repeats
--   agent_sessions               one sandboxed sub-agent working one scenario; doubles as the worker job queue
--                                and carries the scored verdict
--   transcript_events            raw JSONL events, only when ClickHouse is not configured (local dev fallback)
--   access_requests              landing-page sign-ups

CREATE TABLE IF NOT EXISTS organizations (
  id          SERIAL PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           SERIAL PRIMARY KEY,
  org_id       INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  label        TEXT NOT NULL DEFAULT 'default',
  key_prefix   TEXT NOT NULL,                 -- first characters, safe to show
  key_hash     TEXT UNIQUE NOT NULL,          -- sha256 of the full key; the key itself is never stored
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS products (
  id            SERIAL PRIMARY KEY,
  org_id        INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug          TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT '',
  website_url   TEXT,
  docs_url      TEXT,
  -- How the product shows up in agent output; all matched case-insensitively.
  aliases       TEXT[] NOT NULL DEFAULT '{}',  -- other names, e.g. "Neon Postgres"
  packages      TEXT[] NOT NULL DEFAULT '{}',  -- npm/PyPI/crate/module names, e.g. "@neondatabase/serverless"
  domains       TEXT[] NOT NULL DEFAULT '{}',  -- e.g. "neon.tech"
  competitors   JSONB NOT NULL DEFAULT '[]',   -- [{name, aliases[], packages[], domains[]}]
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

CREATE TABLE IF NOT EXISTS scenarios (
  id           SERIAL PRIMARY KEY,
  product_id   INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  prompt       TEXT NOT NULL,                 -- the task given to the sub-agent, verbatim; never names the customer
  repo_url     TEXT,                          -- optional starter repo cloned into the sandbox
  language     TEXT,
  tags         TEXT[] NOT NULL DEFAULT '{}',
  expectation  TEXT NOT NULL DEFAULT 'recommend' CHECK (expectation IN ('recommend', 'avoid')),
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scenarios_product_idx ON scenarios (product_id);

CREATE TABLE IF NOT EXISTS simulations (
  id           TEXT PRIMARY KEY,              -- sim_<random>
  org_id       INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id   INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  models       TEXT[] NOT NULL,
  harness      TEXT NOT NULL,
  repeats      INT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'running', 'completed', 'cancelled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS simulations_product_idx ON simulations (product_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id              TEXT PRIMARY KEY,           -- ses_<random>
  simulation_id   TEXT NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
  org_id          INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id      INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  scenario_id     INT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  model           TEXT NOT NULL,
  harness         TEXT NOT NULL,
  attempt         INT NOT NULL DEFAULT 1,     -- repeat number within the simulation
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'completed', 'failed', 'timeout', 'cancelled')),
  worker_id       TEXT,
  sandbox_id      TEXT,
  queued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  heartbeat_at    TIMESTAMPTZ,
  ended_at        TIMESTAMPTZ,
  tokens_in       BIGINT NOT NULL DEFAULT 0,
  tokens_out      BIGINT NOT NULL DEFAULT 0,
  cost_usd        NUMERIC(12, 4) NOT NULL DEFAULT 0,
  error_message   TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}',
  events          INT NOT NULL DEFAULT 0,     -- transcript events received
  -- Scoring, filled when the session finishes (see src/scoring.ts).
  verdict         TEXT CHECK (verdict IN ('adopted', 'recommended', 'mentioned', 'competitor', 'none')),
  winner          TEXT,                       -- tool the agent went with (target or competitor name), if any
  mentions        JSONB,                      -- [{tool, target, level, first_seq, evidence: [{seq, kind, snippet}]}]
  scored_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS agent_sessions_queue_idx ON agent_sessions (queued_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS agent_sessions_sim_idx ON agent_sessions (simulation_id);
CREATE INDEX IF NOT EXISTS agent_sessions_product_idx ON agent_sessions (product_id, ended_at DESC);

CREATE TABLE IF NOT EXISTS transcript_events (
  session_id  TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq         INT NOT NULL,
  ts          TIMESTAMPTZ NOT NULL,
  type        TEXT NOT NULL,
  text        TEXT NOT NULL,
  raw         JSONB NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS access_requests (
  id           SERIAL PRIMARY KEY,
  email        TEXT NOT NULL,
  company      TEXT NOT NULL,
  product_url  TEXT,
  message      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Developer profiles and the task library, synced from the vault (`npm run vault:sync`, src/vault.ts).
-- A profile is who the orchestrator role-plays when a sub-agent asks a question; it never names a customer product.
CREATE TABLE IF NOT EXISTS developer_profiles (
  id            SERIAL PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,
  external_id   TEXT,                         -- id in the vault
  name          TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  attributes    JSONB NOT NULL DEFAULT '{}',  -- role, experience, company_size, stack, constraints, tone, ...
  instructions  TEXT NOT NULL DEFAULT '',     -- how this developer answers the agent's questions
  active        BOOLEAN NOT NULL DEFAULT true,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS library_tasks (
  id            SERIAL PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,
  external_id   TEXT,
  title         TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  repo_url      TEXT,
  language      TEXT,
  category      TEXT,
  tags          TEXT[] NOT NULL DEFAULT '{}',
  attributes    JSONB NOT NULL DEFAULT '{}',
  active        BOOLEAN NOT NULL DEFAULT true,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE scenarios      ADD COLUMN IF NOT EXISTS library_task_id INT REFERENCES library_tasks(id) ON DELETE SET NULL;
ALTER TABLE simulations    ADD COLUMN IF NOT EXISTS profile_ids INT[] NOT NULL DEFAULT '{}';
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS profile_id INT REFERENCES developer_profiles(id) ON DELETE SET NULL;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS user_turns INT NOT NULL DEFAULT 0;  -- questions answered by the simulated developer

-- Worker agents (harnesses/registry.json): which agent ran each session, and how a simulation picked them.
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS agent_id TEXT;              -- registry id, e.g. claude-code/sonnet
ALTER TABLE simulations    ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'explicit';  -- representative | explicit
ALTER TABLE simulations    ADD COLUMN IF NOT EXISTS agent_ids TEXT[] NOT NULL DEFAULT '{}';

-- Orchestrators (each runs up to OCTILLION_PODS_PER_ORCHESTRATOR warm pods); the server plans the global pod mix (src/fleet.ts).
CREATE TABLE IF NOT EXISTS orchestrators (
  id             TEXT PRIMARY KEY,
  capacity       INT NOT NULL,
  meta           JSONB NOT NULL DEFAULT '{}',
  registered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- On-demand orchestrators (src/autoscaler.ts): every boat orchestrator sandbox the server launched, reconciled
-- against boat's own listing (name prefix octi-orch-) so nothing leaks across server restarts.
CREATE TABLE IF NOT EXISTS orchestrator_sandboxes (
  id               SERIAL PRIMARY KEY,
  sandbox_id       TEXT UNIQUE,
  orchestrator_id  TEXT,
  state            TEXT NOT NULL DEFAULT 'booting' CHECK (state IN ('booting', 'running', 'draining', 'deleted')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ready_at         TIMESTAMPTZ,
  last_seen        TIMESTAMPTZ,
  deleted_at       TIMESTAMPTZ,
  error            TEXT,
  from_image       TEXT,
  timings          JSONB
);
CREATE INDEX IF NOT EXISTS orchestrator_sandboxes_live_idx ON orchestrator_sandboxes (state) WHERE state <> 'deleted';

-- Single-leader lease for the autoscaler across server replicas; `state` holds the leader's last tick for status.
CREATE TABLE IF NOT EXISTS autoscaler_lease (
  name        TEXT PRIMARY KEY,
  holder      TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  state       JSONB NOT NULL DEFAULT '{}'
);

-- Key vault + inference gateway (src/keyvault.ts, src/gateway.ts; docs/credentials.md).
-- Provider credentials are AES-256-GCM encrypted with OCTILLION_VAULT_KEY; only ciphertext is stored.
CREATE TABLE IF NOT EXISTS vault_providers (
  slug          TEXT PRIMARY KEY,
  mode          TEXT NOT NULL CHECK (mode IN ('gateway', 'direct')),
  upstream_url  TEXT,                         -- gateway mode: where /gw/<slug>/... is forwarded
  auth_header   TEXT NOT NULL DEFAULT 'authorization',
  auth_prefix   TEXT NOT NULL DEFAULT 'Bearer ',
  env_vars      TEXT[] NOT NULL DEFAULT '{}', -- registry requires_env names this provider satisfies
  enabled       BOOLEAN NOT NULL DEFAULT true,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO vault_providers (slug, mode, upstream_url, auth_header, auth_prefix, env_vars) VALUES
  ('anthropic',      'gateway', 'https://api.anthropic.com',                 'x-api-key',      '',        '{ANTHROPIC_API_KEY}'),
  ('openai',         'gateway', 'https://api.openai.com',                    'authorization',  'Bearer ', '{OPENAI_API_KEY,CODEX_API_KEY}'),
  ('google',         'gateway', 'https://generativelanguage.googleapis.com', 'x-goog-api-key', '',        '{GEMINI_API_KEY,GOOGLE_API_KEY}'),
  ('dashscope',      'gateway', 'https://dashscope-intl.aliyuncs.com',       'authorization',  'Bearer ', '{DASHSCOPE_API_KEY}'),
  ('github_copilot', 'direct',  NULL, 'authorization', 'Bearer ', '{COPILOT_GITHUB_TOKEN}'),
  ('cursor',         'direct',  NULL, 'authorization', 'Bearer ', '{CURSOR_API_KEY}'),
  ('amp',            'direct',  NULL, 'authorization', 'Bearer ', '{AMP_API_KEY}'),
  ('factory',        'direct',  NULL, 'authorization', 'Bearer ', '{FACTORY_API_KEY}'),
  ('boat',           'direct',  'https://boat.dev/api/v1', 'authorization', 'Bearer ', '{BOAT_API_KEY}')
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS vault_credentials (
  id            SERIAL PRIMARY KEY,
  provider      TEXT NOT NULL REFERENCES vault_providers(slug) ON DELETE CASCADE,
  label         TEXT NOT NULL DEFAULT 'default',
  ciphertext    TEXT NOT NULL,                -- base64
  iv            TEXT NOT NULL,
  tag           TEXT NOT NULL,
  key_id        TEXT NOT NULL,                -- which master key encrypted it (rotation)
  hint          TEXT NOT NULL,                -- e.g. "sk-ant…9xQ2", safe to display
  priority      INT NOT NULL DEFAULT 0,       -- higher first; equal priorities rotate
  enabled       BOOLEAN NOT NULL DEFAULT true,
  uses          BIGINT NOT NULL DEFAULT 0,
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at    TIMESTAMPTZ,
  UNIQUE (provider, label)
);

CREATE TABLE IF NOT EXISTS gateway_tokens (
  token_hash       TEXT PRIMARY KEY,          -- sha256 of ogw_...; the token itself is never stored
  kind             TEXT NOT NULL CHECK (kind IN ('session', 'orchestrator')),
  session_id       TEXT REFERENCES agent_sessions(id) ON DELETE CASCADE,
  orchestrator_id  TEXT,
  providers        TEXT[] NOT NULL,
  expires_at       TIMESTAMPTZ NOT NULL,
  revoked_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gateway_tokens_session_idx ON gateway_tokens (session_id);

CREATE TABLE IF NOT EXISTS gateway_usage (
  token_hash     TEXT NOT NULL,
  provider       TEXT NOT NULL,
  session_id     TEXT,
  orchestrator_id TEXT,
  requests       INT NOT NULL DEFAULT 0,
  errors         INT NOT NULL DEFAULT 0,
  input_tokens   BIGINT NOT NULL DEFAULT 0,
  output_tokens  BIGINT NOT NULL DEFAULT 0,
  bytes          BIGINT NOT NULL DEFAULT 0,
  last_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (token_hash, provider)
);
-- Priced per request at record time (long-context tiers apply per request, not to a session's summed input).
ALTER TABLE gateway_usage ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0;

-- Developer populations: the coding-agent (harness x model) mix a simulation should represent, e.g. the global
-- developer population or an enterprise subset. Agent definitions (images, adapters) stay in harnesses/registry.json;
-- the mix lives here. The default population is seeded from the registry's cited weights on first boot.
CREATE TABLE IF NOT EXISTS developer_populations (
  id                   SERIAL PRIMARY KEY,
  slug                 TEXT UNIQUE NOT NULL,
  name                 TEXT NOT NULL,
  description          TEXT NOT NULL DEFAULT '',
  as_of                DATE,
  methodology          TEXT NOT NULL DEFAULT '',
  sources              JSONB NOT NULL DEFAULT '[]',
  unrepresented_share  REAL,                    -- usage in tools that cannot run headless
  sandbox_unit         INT NOT NULL DEFAULT 20 CHECK (sandbox_unit > 0),
  min_one_sandbox      BOOLEAN NOT NULL DEFAULT false,
  is_default           BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS developer_populations_one_default ON developer_populations (is_default) WHERE is_default;

CREATE TABLE IF NOT EXISTS developer_population_agents (
  population_id  INT NOT NULL REFERENCES developer_populations(id) ON DELETE CASCADE,
  agent_id       TEXT NOT NULL,               -- registry agent id, e.g. claude-code/opus
  market_share   REAL NOT NULL CHECK (market_share >= 0),  -- share of this population's agentic coding usage
  paused         BOOLEAN NOT NULL DEFAULT false,
  paused_reason  TEXT,
  notes          TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (population_id, agent_id)
);

ALTER TABLE simulations ADD COLUMN IF NOT EXISTS population_id INT REFERENCES developer_populations(id) ON DELETE SET NULL;

-- Product onboarding (docs/onboarding.md): prompt + link + docs -> orchestrator research -> profile, personas, problems.
ALTER TABLE products  ADD COLUMN IF NOT EXISTS prompt   TEXT;              -- what the customer said the product is
ALTER TABLE products  ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '[]';
ALTER TABLE products  ADD COLUMN IF NOT EXISTS research JSONB;            -- sources and notes from the last research
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS source    TEXT NOT NULL DEFAULT 'manual';  -- manual | library | generated
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS rationale TEXT;            -- why the product fits (or should not)
-- Starter workspace for scenarios without repo_url (orchestrator/workspaces/<template>); NULL = picked from language/tags/prompt.
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS template TEXT;
-- Why a session ended: done (real workspace changes) | turn_cap (MAX_AGENT_TURNS) | time_cap | agent_gave_up | error.
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS completed_reason TEXT
  CHECK (completed_reason IS NULL OR completed_reason IN ('done', 'turn_cap', 'time_cap', 'agent_gave_up', 'error'));
-- Personas generated for one product live next to the shared vault profiles, scoped to that org + product.
ALTER TABLE developer_profiles ADD COLUMN IF NOT EXISTS org_id     INT REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE developer_profiles ADD COLUMN IF NOT EXISTS product_id INT REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE developer_profiles ADD COLUMN IF NOT EXISTS source     TEXT NOT NULL DEFAULT 'vault';  -- vault | generated

CREATE TABLE IF NOT EXISTS product_research (
  id             TEXT PRIMARY KEY,           -- rsh_<random>
  org_id         INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id     INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  stage          TEXT,
  note           TEXT,
  input          JSONB NOT NULL,             -- {name?, prompt, website_url?, docs_url?}
  run            JSONB,                      -- null = don't auto-run; else {samples?, population?}
  result         JSONB,
  error          TEXT,
  attempts       INT NOT NULL DEFAULT 0,     -- complete() calls rejected by validation
  worker_id      TEXT,
  simulation_id  TEXT REFERENCES simulations(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at     TIMESTAMPTZ,
  heartbeat_at   TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS product_research_queue_idx ON product_research (created_at) WHERE status = 'queued';

-- Gateway backends: 'direct' forwards to upstream_url; 'vertex' rewrites Anthropic Messages calls to Google Cloud Vertex AI
-- (backend_config: {project_id, region ('global' | 'us' | 'eu' | a region), model_map?}); the credential is a service-account JSON key.
ALTER TABLE vault_providers ADD COLUMN IF NOT EXISTS backend TEXT NOT NULL DEFAULT 'direct' CHECK (backend IN ('direct', 'vertex'));
ALTER TABLE vault_providers ADD COLUMN IF NOT EXISTS backend_config JSONB NOT NULL DEFAULT '{}';

-- Per-model inference usage and cost (src/usage.ts): every gateway request is attributed to the model the provider
-- reports, per day and consumer (orchestrator brain vs agent sessions), priced from model_prices at request time.
CREATE TABLE IF NOT EXISTS model_prices (
  model                        TEXT PRIMARY KEY,
  input_per_mtok               NUMERIC(10, 4) NOT NULL,
  cached_input_per_mtok        NUMERIC(10, 4) NOT NULL,
  output_per_mtok              NUMERIC(10, 4) NOT NULL,
  long_context_threshold       INT,                  -- input tokens above which the long-context prices apply
  long_input_per_mtok          NUMERIC(10, 4),
  long_cached_input_per_mtok   NUMERIC(10, 4),
  long_output_per_mtok         NUMERIC(10, 4),
  source                       TEXT NOT NULL DEFAULT '',
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO model_prices (model, input_per_mtok, cached_input_per_mtok, output_per_mtok, long_context_threshold,
                          long_input_per_mtok, long_cached_input_per_mtok, long_output_per_mtok, source) VALUES
  ('gpt-6.1-sol',       2.00, 0.10, 10.00, 272000, 4.00, 0.20, 15.00, 'OpenAI API pricing, standard tier, 2026-10-10'),
  ('gpt-4.1-nano',      0.10, 0.025, 0.40, NULL, NULL, NULL, NULL,   'OpenAI API pricing, standard tier, 2026-10-10'),
  ('claude-opus-5-5',   4.00, 0.20, 20.00, NULL, NULL, NULL, NULL,   'Anthropic list price; Vertex global billed by Google, verify on the GCP invoice'),
  ('claude-sonnet-5-5', 2.00, 0.20, 10.00, NULL, NULL, NULL, NULL,   'Anthropic list price; Vertex global billed by Google, verify on the GCP invoice')
ON CONFLICT (model) DO NOTHING;

CREATE TABLE IF NOT EXISTS gateway_model_usage (
  day                  DATE NOT NULL,
  provider             TEXT NOT NULL,
  model                TEXT NOT NULL,
  consumer             TEXT NOT NULL CHECK (consumer IN ('session', 'orchestrator')),
  requests             INT NOT NULL DEFAULT 0,
  errors               INT NOT NULL DEFAULT 0,
  input_tokens         BIGINT NOT NULL DEFAULT 0,   -- all input, cached included
  cached_input_tokens  BIGINT NOT NULL DEFAULT 0,
  output_tokens        BIGINT NOT NULL DEFAULT 0,
  cost_usd             NUMERIC(14, 6) NOT NULL DEFAULT 0,
  priced               BOOLEAN NOT NULL DEFAULT true,  -- false when a request's model had no price
  PRIMARY KEY (day, provider, model, consumer)
);

CREATE TABLE IF NOT EXISTS usage_alerts (
  day    DATE NOT NULL,
  model  TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (day, model)
);

-- Cloudflare Workers AI (open models for OpenCode). Disabled until configured with the account's upstream:
--   npm run keyvault -- provider cloudflare --upstream https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai --enable
INSERT INTO vault_providers (slug, mode, upstream_url, auth_header, auth_prefix, env_vars, enabled)
VALUES ('cloudflare', 'gateway', NULL, 'authorization', 'Bearer ', '{CLOUDFLARE_API_TOKEN}', false)
ON CONFLICT (slug) DO NOTHING;

-- Cloudflare Workers AI open models (per-model pages, 2026-10-10).
INSERT INTO model_prices (model, input_per_mtok, cached_input_per_mtok, output_per_mtok, source) VALUES
  ('@cf/moonshotai/kimi-k2.7-code',        0.95, 0.19,  4.00, 'Cloudflare Workers AI pricing, 2026-10-10'),
  ('@cf/zai-org/glm-5.3',                  1.40, 0.26,  4.40, 'Cloudflare Workers AI pricing, 2026-10-10'),
  ('@cf/deepseek-ai/deepseek-v4-pro-0813', 1.32, 0.044, 3.96, 'Cloudflare Workers AI pricing, 2026-10-10'),
  ('@cf/openai/gpt-oss-120b',              0.35, 0.35,  0.75, 'Cloudflare Workers AI pricing, 2026-10-10 (no cached rate listed)')
ON CONFLICT (model) DO NOTHING;

-- Per-organization MCP activity (src/analytics.ts): connector methods and tool calls with outcome and latency.
-- Tool arguments and results are never stored.
CREATE TABLE IF NOT EXISTS mcp_events (
  id      BIGSERIAL PRIMARY KEY,
  org_id  INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  method  TEXT NOT NULL,                     -- initialize, tools/list, tools/call, prompts/get, resources/read, ...
  name    TEXT,                              -- tool or prompt name, or resource URI
  client  TEXT,                              -- clientInfo on initialize, else the User-Agent
  ok      BOOLEAN NOT NULL DEFAULT true,
  error   TEXT,
  ms      INT
);
CREATE INDEX IF NOT EXISTS mcp_events_org_idx ON mcp_events (org_id, at DESC);
