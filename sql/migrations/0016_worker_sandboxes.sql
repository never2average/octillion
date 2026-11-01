-- Worker sandboxes on Vercel Sandbox (src/worker-sandboxes.ts, orchestrator/core/sandbox-provider.ts): the ownership map
-- of the API's sandbox broker. Orchestrators still run on boat; with OCTILLION_SANDBOX_PROVIDER=vercel they ask the API to
-- create, use and delete their per-session worker sandboxes (the Vercel credentials, the function's OIDC token, never
-- leave our functions). Every broker call loads the row by sandbox name and refuses a caller that is not its owner:
-- the same job token (owner 'job:<sim_...>') or, for Octillion's shared orchestrators, the fleet token (owner 'fleet').
--
-- Platform (staff) table: nothing in it is shown to an account. Row-level security is on with no tenant policy, the tenant
-- role is granted nothing, and src/rls.ts lists it as NO_ACCESS. Rows are pruned 14 days after the sandbox is deleted.
--
-- Rollout-safe: a new table only. The previous release never reads or writes it, and nothing writes it until
-- OCTILLION_SANDBOX_PROVIDER=vercel is set.

CREATE TABLE IF NOT EXISTS worker_sandboxes (
  id              BIGSERIAL PRIMARY KEY,
  provider        TEXT NOT NULL DEFAULT 'vercel' CHECK (provider IN ('vercel')),
  sandbox_id      TEXT NOT NULL UNIQUE,              -- the Vercel sandbox name (its API addresses it by name)
  vm_session      TEXT,                              -- Vercel's session id: commands and files go to /sessions/{id}
  owner           TEXT NOT NULL,                     -- 'fleet' | 'job:<simulation id>': who may use it
  session_id      TEXT NOT NULL,                     -- the agent session it was created for (checked against the token)
  job_id          TEXT,                              -- the session's simulation
  orchestrator_id TEXT,                              -- as reported by the caller (attribution only)
  vcpus           INT NOT NULL,
  memory_mb       INT NOT NULL,
  timeout_sec     INT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ready_at        TIMESTAMPTZ,
  last_used_at    TIMESTAMPTZ,
  network_policy  JSONB,                             -- the allow-list applied for an egress lockdown, if any
  deleted_at      TIMESTAMPTZ,
  delete_reason   TEXT,                              -- 'orchestrator' | 'reaped: ...' | 'create failed: ...'
  delete_error    TEXT
);
CREATE INDEX IF NOT EXISTS worker_sandboxes_live ON worker_sandboxes (owner) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS worker_sandboxes_session ON worker_sandboxes (session_id);
CREATE INDEX IF NOT EXISTS worker_sandboxes_deleted ON worker_sandboxes (deleted_at);

DO $mig$
DECLARE r TEXT := octillion_tenant_role();
BEGIN
  ALTER TABLE worker_sandboxes ENABLE ROW LEVEL SECURITY;
  EXECUTE format('REVOKE ALL ON worker_sandboxes FROM %I', r);
END $mig$;
