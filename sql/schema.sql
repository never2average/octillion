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
