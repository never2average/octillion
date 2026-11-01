-- Sandbox reliability probe (src/sandbox-probe.ts, docs/sandbox-probe.md): boat.dev and Vercel Sandbox side by side,
-- run from the deployment's own cron (/api/cron/sandbox-probe, every 5 minutes). Every 15 minutes each provider gets one
-- small probe sandbox; every tick checks that it still exists and runs `echo ok && uptime` in it a few times; after 15
-- minutes it is deleted. A probe that disappears before we delete it gets gone_at: the number this is for.
--
--   sandbox_probes       one row per probe sandbox (or per attempt that never made one: failed, not_configured)
--   sandbox_probe_execs  one row per exec, existence check or delete attempt against a probe
--   sandbox_probe_meta   when each provider's listing was last swept for strays (at most every 15 minutes)
--
-- Platform (staff) tables: nothing in them belongs to an account. Row-level security is on with no tenant policy, the
-- tenant role is granted nothing, and src/rls.ts lists them as NO_ACCESS. Kept 14 days (pruned by the probe's cron).
--
-- Rollout-safe: new tables only. The previous release never reads or writes them.

CREATE TABLE IF NOT EXISTS sandbox_probes (
  id            BIGSERIAL PRIMARY KEY,
  provider      TEXT NOT NULL CHECK (provider IN ('boat', 'vercel')),
  sandbox_id    TEXT,                                -- boat: bx_...; Vercel: the sandbox name (its API addresses it by name)
  name          TEXT,                                -- <namespace>-probe-<random>: never an orchestrator or worker prefix
  -- live -> deleted (lived its time) | delete_failed (retried on later ticks) | gone (lost before we deleted it) |
  -- expired (stopped at its TTL: not an early drop); starting -> failed; not_configured: no credentials, nothing made.
  state         TEXT NOT NULL CHECK (state IN ('starting', 'live', 'gone', 'deleted', 'delete_failed', 'expired', 'failed', 'not_configured')),
  credential_id INT,                                 -- boat: the vault key that made it; every later call uses the same key
  region        TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  create_ms     INT,                                 -- the create call
  ready_ms      INT,                                 -- from the create call to ready (boat) or running (Vercel)
  create_error  TEXT,
  gone_at       TIMESTAMPTZ,                         -- it disappeared (or stopped) before we deleted it
  gone_reason   TEXT,
  deleted_at    TIMESTAMPTZ,
  delete_ms     INT,
  delete_error  TEXT,
  execs_ok      INT NOT NULL DEFAULT 0,
  execs_failed  INT NOT NULL DEFAULT 0,
  exec_p50_ms   INT,
  exec_p95_ms   INT,
  last_error    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sandbox_probes_provider_started ON sandbox_probes (provider, started_at DESC);
CREATE INDEX IF NOT EXISTS sandbox_probes_open ON sandbox_probes (provider) WHERE state IN ('starting', 'live');
CREATE INDEX IF NOT EXISTS sandbox_probes_started ON sandbox_probes (started_at);

CREATE TABLE IF NOT EXISTS sandbox_probe_execs (
  id         BIGSERIAL PRIMARY KEY,
  probe_id   BIGINT NOT NULL REFERENCES sandbox_probes(id) ON DELETE CASCADE,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind       TEXT NOT NULL CHECK (kind IN ('exec', 'check', 'delete')),   -- exec: echo + uptime; check: the get API; delete
  ok         BOOLEAN NOT NULL,
  ms         INT,
  exit_code  INT,
  error      TEXT
);
CREATE INDEX IF NOT EXISTS sandbox_probe_execs_probe ON sandbox_probe_execs (probe_id, at);
CREATE INDEX IF NOT EXISTS sandbox_probe_execs_at ON sandbox_probe_execs (at);

CREATE TABLE IF NOT EXISTS sandbox_probe_meta (
  key  TEXT PRIMARY KEY,                             -- 'strays:<provider>'
  at   TIMESTAMPTZ NOT NULL
);

DO $mig$
DECLARE r TEXT := octillion_tenant_role();
BEGIN
  ALTER TABLE sandbox_probes ENABLE ROW LEVEL SECURITY;
  ALTER TABLE sandbox_probe_execs ENABLE ROW LEVEL SECURITY;
  ALTER TABLE sandbox_probe_meta ENABLE ROW LEVEL SECURITY;
  EXECUTE format('REVOKE ALL ON sandbox_probes, sandbox_probe_execs, sandbox_probe_meta FROM %I', r);
END $mig$;
