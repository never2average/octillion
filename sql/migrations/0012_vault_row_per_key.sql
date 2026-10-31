-- Key vault: one row per key, one type per key (src/keyvault.ts). A key type (provider) may hold several keys, each its
-- own row; requests pick among a type's keys least recently used first. Adding a key always creates a row; a key is
-- replaced on its own row (rotated_at set) or deleted, never disabled.
--
--   * UNIQUE (provider) from 0011 goes: several keys may share a type.
--   * secret_digest: an HMAC-SHA256 of the plaintext under a subkey of the master key that encrypted the row (key_id),
--     so the same key cannot be added twice to a type (partial UNIQUE (provider, secret_digest)). Computing it needs
--     the plaintext, so rows from before this migration have none: it is filled at their next use, when a key is added
--     to their type, by `keyvault rekey`, or by `keyvault backfill-digests`.
--   * label becomes the optional free-text name shown to tell rows apart (NULL: an automatic "<Type> key N"). It is
--     not a uniqueness key. 0011 set every label to 'default', which means "no name" here.
--   * The email unsubscribe signing key stays a singleton: at most one row (partial unique index).
--
-- Not rollout-safe for instances still on the old release (0011's code): every key write there uses ON CONFLICT
-- (provider), which needs the UNIQUE (provider) constraint dropped here, so on those instances, until cut-over:
--   * adding or replacing a key (Key vault page, CLI) fails with an error;
--   * unsubscribeKey() (src/campaigns.ts) calls addCredentialIfAbsent with ON CONFLICT (provider) the first time a
--     process needs the key (and again after any failure), so on an old instance that has not loaded it yet
--     building unsubscribe links fails, and with it campaign sends and unsubscribe/reply handling;
--   * the one-time import of keys from environment variables (src/keyvault-env.ts) fails (it is retried on a later
--     boot, on the new release).
-- Plain key reads (gateway, broker) keep working. Cut over in one step (stop old instances, then start new ones), or
-- pause campaigns and leave the vault alone until the last old instance is gone.

ALTER TABLE vault_credentials DROP CONSTRAINT IF EXISTS vault_credentials_provider_key;

ALTER TABLE vault_credentials ADD COLUMN IF NOT EXISTS secret_digest TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS vault_credentials_provider_digest_key
  ON vault_credentials (provider, secret_digest) WHERE secret_digest IS NOT NULL;

ALTER TABLE vault_credentials ALTER COLUMN label DROP NOT NULL;
ALTER TABLE vault_credentials ALTER COLUMN label DROP DEFAULT;
UPDATE vault_credentials SET label = NULL WHERE label = 'default';

CREATE UNIQUE INDEX IF NOT EXISTS vault_credentials_one_unsubscribe_key
  ON vault_credentials (provider) WHERE provider = 'email_unsubscribe';

-- Picking the least recently used key of a type.
CREATE INDEX IF NOT EXISTS vault_credentials_provider_lru ON vault_credentials (provider, last_used_at NULLS FIRST, id);
