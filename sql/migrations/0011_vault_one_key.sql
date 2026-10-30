-- Key vault: one key per provider (src/keyvault.ts). A provider (key type) holds at most one key; a key is kept or
-- deleted, never disabled, and a provider is usable when it has a key (no provider on/off). Adding a key to a type that
-- has one replaces it (ON CONFLICT (provider)).
--
-- vault_credentials.label, priority and enabled stay so older code can still read keys during a rolling deploy, but
-- nothing new reads them: label is 'default', priority 0 and enabled true on every row. vault_providers.enabled
-- likewise stays and is true everywhere.
--
-- Not fully rollout-safe for writes: older code stores keys with ON CONFLICT (provider, label), and that constraint is
-- dropped here, so a key write (add, replace, env import, the unsubscribe key's first generation) from an instance
-- still on the old release fails with an error until it is replaced. Reads (using a key) keep working. Avoid adding
-- or replacing keys while the deploy rolls out; the window lasts until the last old instance is gone.

-- Disabled keys are gone: a key is kept or deleted.
DELETE FROM vault_credentials WHERE NOT enabled;

-- The Vertex backend signs in with the Vertex AI provider's key only. A service-account key kept on another provider
-- under the old "vertex" label moves to the vertex provider when that has none (the newest such key), and is dropped
-- otherwise, so no provider is left holding a JSON key as its API key.
UPDATE vault_credentials SET provider = 'vertex'
 WHERE id = (SELECT id FROM vault_credentials WHERE label = 'vertex' AND provider <> 'vertex'
              ORDER BY coalesce(rotated_at, created_at) DESC, id DESC LIMIT 1)
   AND EXISTS (SELECT 1 FROM vault_providers WHERE slug = 'vertex')
   AND NOT EXISTS (SELECT 1 FROM vault_credentials WHERE provider = 'vertex');
DELETE FROM vault_credentials WHERE label = 'vertex' AND provider <> 'vertex';

-- One key per provider: the most recently created or rotated one stays (ties: the higher id).
DELETE FROM vault_credentials c USING vault_credentials k
 WHERE c.provider = k.provider AND c.id <> k.id
   AND (coalesce(k.rotated_at, k.created_at), k.id) > (coalesce(c.rotated_at, c.created_at), c.id);

UPDATE vault_credentials SET label = 'default', priority = 0, enabled = true
 WHERE label <> 'default' OR priority <> 0 OR NOT enabled;

ALTER TABLE vault_credentials DROP CONSTRAINT IF EXISTS vault_credentials_provider_label_key;
ALTER TABLE vault_credentials ADD CONSTRAINT vault_credentials_provider_key UNIQUE (provider);

-- No provider toggle: every provider is on. The Vertex backend no longer names another provider's key.
UPDATE vault_providers SET enabled = true WHERE NOT enabled;
UPDATE vault_providers SET backend_config = backend_config - 'credential_provider' WHERE backend_config ? 'credential_provider';
