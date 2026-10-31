-- Personal API keys (src/api-keys.ts, docs/accounts.md): any signed-in member creates keys for themselves on
-- /app/settings/api-keys, for headless agents (claude -p, the Agent SDK, CI) that cannot finish a browser sign-in.
-- They live in api_keys beside the older keys; these columns are added only, nothing existing changes:
--
--   * scope        'read' (read-only tools) or 'write' (every tool the person's role allows). NULL = a key from before
--                  this migration (or a platform admin's legacy key): full access, as today.
--   * expires_at   when the key stops working. NULL = never (every existing key).
--   * created_via  'portal' (a person made it for themselves), 'admin' (a platform admin issued it) or 'cli'.
--                  NULL = before this migration.
--   * user_id and last_used_at already exist (0001): a personal key always has user_id set.
--
-- Rollout-safe: the previous release ignores the new columns, and its resolveKey still refuses revoked keys; it does
-- not know about expiry, so a personal key that has expired would keep working on an old instance until it is gone.
-- Row-level security is unchanged: tenant work still reads its own organization's keys and may not insert or revoke
-- any (0003); the portal issues and revokes personal keys as the platform, filtered by organization and person.

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scope TEXT;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS created_via TEXT;

DO $mig$
BEGIN
  ALTER TABLE api_keys ADD CONSTRAINT api_keys_scope_check CHECK (scope IS NULL OR scope IN ('read', 'write'));
EXCEPTION WHEN duplicate_object THEN NULL;
END
$mig$;
DO $mig$
BEGIN
  ALTER TABLE api_keys ADD CONSTRAINT api_keys_created_via_check CHECK (created_via IS NULL OR created_via IN ('portal', 'admin', 'cli'));
EXCEPTION WHEN duplicate_object THEN NULL;
END
$mig$;

-- A person's own keys in an account (the API keys page lists them).
CREATE INDEX IF NOT EXISTS api_keys_org_user ON api_keys (org_id, user_id);
