import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getDb } from "./db.js";

/**
 * Key vault: provider credentials (Anthropic, OpenAI, boat.dev, ...) encrypted at rest with AES-256-GCM.
 *
 * The master key comes from OCTILLION_VAULT_KEY (32 bytes, base64 or hex; generate with
 * `openssl rand -base64 32`). Only ciphertext, IV, auth tag, the master key's id and a display hint are stored.
 * Plaintext leaves this module only to the gateway (injected upstream) or the broker (direct-mode vendors).
 * Rotate the master key by setting OCTILLION_VAULT_KEY_PREVIOUS to the old key and running `npm run keyvault -- rekey`.
 */

export interface ProviderRow {
  slug: string; mode: "gateway" | "direct"; upstream_url: string | null; auth_header: string; auth_prefix: string;
  env_vars: string[]; enabled: boolean;
  /** direct = forward to upstream_url; vertex = Anthropic Messages via Google Cloud Vertex AI (src/vertex.ts). */
  backend: "direct" | "vertex"; backend_config: { project_id?: string; region?: string; model_map?: Record<string, string>; endpoint?: string };
}

function parseKey(v: string | undefined): Buffer | null {
  if (!v) return null;
  const buf = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, "hex") : Buffer.from(v, "base64");
  if (buf.length !== 32) throw new Error("OCTILLION_VAULT_KEY must be 32 bytes (base64 or hex); generate with `openssl rand -base64 32`");
  return buf;
}
const keyId = (k: Buffer) => createHash("sha256").update(k).digest("hex").slice(0, 12);

function masterKeys() {
  const current = parseKey(process.env.OCTILLION_VAULT_KEY);
  if (!current) throw new Error("The key vault is locked: set OCTILLION_VAULT_KEY (openssl rand -base64 32)");
  const previous = parseKey(process.env.OCTILLION_VAULT_KEY_PREVIOUS);
  const byId = new Map([[keyId(current), current]]);
  if (previous) byId.set(keyId(previous), previous);
  return { current, currentId: keyId(current), byId };
}

export const vaultUnlocked = () => Boolean(process.env.OCTILLION_VAULT_KEY);

export function encrypt(plaintext: string) {
  const { current, currentId } = masterKeys();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", current, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), key_id: currentId };
}

export function decrypt(row: { ciphertext: string; iv: string; tag: string; key_id: string }): string {
  const key = masterKeys().byId.get(row.key_id);
  if (!key) throw new Error(`Credential was encrypted with master key ${row.key_id}, which is not loaded (set OCTILLION_VAULT_KEY_PREVIOUS?)`);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(row.iv, "base64"));
  decipher.setAuthTag(Buffer.from(row.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(row.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

export function hint(secret: string): string {
  // Google service-account keys: show the account and key id, never fragments of the JSON.
  if (secret.trimStart().startsWith("{")) {
    try {
      const j = JSON.parse(secret) as { client_email?: string; private_key_id?: string };
      if (j.client_email) return `${j.client_email}${j.private_key_id ? ` (key ${j.private_key_id.slice(0, 8)}…)` : ""}`;
    } catch { /* not JSON: fall through */ }
    return "JSON credential";
  }
  return secret.length <= 10 ? "…" : `${secret.slice(0, 6)}…${secret.slice(-4)}`;
}

// ---------- providers ----------

export async function listProviders(): Promise<ProviderRow[]> {
  return (await getDb()).query<ProviderRow>("SELECT slug, mode, upstream_url, auth_header, auth_prefix, env_vars, enabled, backend, backend_config FROM vault_providers ORDER BY slug");
}

export async function getProvider(slug: string): Promise<ProviderRow | null> {
  const [row] = await (await getDb()).query<ProviderRow>(
    "SELECT slug, mode, upstream_url, auth_header, auth_prefix, env_vars, enabled, backend, backend_config FROM vault_providers WHERE slug = $1",
    [slug],
  );
  return row ?? null;
}

export async function upsertProvider(p: Partial<ProviderRow> & { slug: string }) {
  if (!/^[a-z0-9_]{2,40}$/.test(p.slug)) throw new Error("provider slug must be lowercase letters, digits or _");
  if (p.mode && !["gateway", "direct"].includes(p.mode)) throw new Error("mode must be gateway or direct");
  if (p.upstream_url && !/^https?:\/\//.test(p.upstream_url)) throw new Error("upstream_url must be http(s)");
  if (p.backend && !["direct", "vertex"].includes(p.backend)) throw new Error("backend must be direct or vertex");
  if (p.backend === "vertex") {
    const c = p.backend_config ?? {};
    if (!c.project_id || !/^[a-z][a-z0-9-]{4,29}$/.test(c.project_id)) throw new Error("vertex backend needs backend_config.project_id (a GCP project id)");
    if (c.region && !/^[a-z0-9-]{2,30}$/.test(c.region)) throw new Error("backend_config.region must be global, us, eu or a region like us-east5");
    p.backend_config = { ...c, region: c.region ?? "global" };
  }
  await (await getDb()).query(
    `INSERT INTO vault_providers (slug, mode, upstream_url, auth_header, auth_prefix, env_vars, enabled, backend, backend_config)
     VALUES ($1, coalesce($2, 'gateway'), $3, coalesce($4, 'authorization'), coalesce($5, 'Bearer '), coalesce($6::text[], '{}'), coalesce($7, true),
             coalesce($8, 'direct'), coalesce($9::jsonb, '{}'))
     ON CONFLICT (slug) DO UPDATE SET mode = coalesce($2, vault_providers.mode), upstream_url = coalesce($3, vault_providers.upstream_url),
       auth_header = coalesce($4, vault_providers.auth_header), auth_prefix = coalesce($5, vault_providers.auth_prefix),
       env_vars = coalesce($6::text[], vault_providers.env_vars), enabled = coalesce($7, vault_providers.enabled),
       backend = coalesce($8, vault_providers.backend), backend_config = coalesce($9::jsonb, vault_providers.backend_config), updated_at = now()`,
    [p.slug, p.mode ?? null, p.upstream_url ?? null, p.auth_header?.toLowerCase() ?? null, p.auth_prefix ?? null, p.env_vars ?? null, p.enabled ?? null,
     p.backend ?? null, p.backend_config ? JSON.stringify(p.backend_config) : null],
  );
  return getProvider(p.slug);
}

/** Providers that satisfy a list of required env var names (registry `requires_env`). */
export async function providersForEnv(envVars: string[]): Promise<ProviderRow[]> {
  if (!envVars.length) return [];
  return (await getDb()).query<ProviderRow>(
    "SELECT slug, mode, upstream_url, auth_header, auth_prefix, env_vars, enabled, backend, backend_config FROM vault_providers WHERE enabled AND env_vars && $1 ORDER BY slug",
    [envVars],
  );
}

// ---------- credentials ----------

export async function setCredential(provider: string, secret: string, opts: { label?: string; priority?: number } = {}) {
  const p = await getProvider(provider);
  if (!p) throw new Error(`Unknown provider ${provider}; add it first (keyvault provider ...)`);
  // A direct-mode key is handed to agent sessions as is; refuse to store one unless that is explicitly allowed.
  // Orchestrator-only keys (boat; search providers with no env_vars) never reach a session, so they are always fine.
  if (p.mode === "direct" && provider !== "boat" && p.env_vars.length && process.env.OCTILLION_DIRECT_KEYS !== "allow")
    throw new Error(`${provider} is a direct-mode provider: its real key would be handed to agent sessions. ` +
                    "Set OCTILLION_DIRECT_KEYS=allow only once those sessions run without customer-written tasks (docs/security.md)");
  const s = secret.trim();
  if (s.length < 8) throw new Error("That does not look like a credential");
  const enc = encrypt(s);
  const db = await getDb();
  const [row] = await db.query<{ id: number }>(
    `INSERT INTO vault_credentials (provider, label, ciphertext, iv, tag, key_id, hint, priority)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (provider, label) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag,
       key_id = excluded.key_id, hint = excluded.hint, priority = excluded.priority, enabled = true, rotated_at = now()
     RETURNING id`,
    [provider, opts.label ?? "default", enc.ciphertext, enc.iv, enc.tag, enc.key_id, hint(s), opts.priority ?? 0],
  );
  return { id: row.id, provider, label: opts.label ?? "default", hint: hint(s) };
}

export async function listCredentials() {
  return (await getDb()).query(
    `SELECT id, provider, label, hint, priority, enabled, uses, last_used_at, created_at, rotated_at, key_id
       FROM vault_credentials ORDER BY provider, priority DESC, label`,
  );
}

export async function setCredentialEnabled(id: number, enabled: boolean) {
  const [row] = await (await getDb()).query("UPDATE vault_credentials SET enabled = $2 WHERE id = $1 RETURNING id", [id, enabled]);
  if (!row) throw new Error(`No credential ${id}`);
}

export async function deleteCredential(id: number) {
  const [row] = await (await getDb()).query("DELETE FROM vault_credentials WHERE id = $1 RETURNING id", [id]);
  if (!row) throw new Error(`No credential ${id}`);
}

/**
 * The secret to use for a provider now: highest priority first, least recently used among equals (spreads load
 * and rate limits across several keys). Throws when none is configured.
 */
/** Label of the Google service-account key a provider uses when its backend is Vertex AI. */
export const VERTEX_LABEL = "vertex";

export async function useCredential(provider: string, opts: { label?: string; excludeLabel?: string } = {}): Promise<{ id: number; secret: string }> {
  const db = await getDb();
  const [row] = await db.query<{ id: number; ciphertext: string; iv: string; tag: string; key_id: string }>(
    `UPDATE vault_credentials SET uses = uses + 1, last_used_at = now()
      WHERE id = (SELECT id FROM vault_credentials WHERE provider = $1 AND enabled
                     AND ($2::text IS NULL OR label = $2) AND ($3::text IS NULL OR label <> $3)
                   ORDER BY priority DESC, last_used_at ASC NULLS FIRST, id LIMIT 1)
      RETURNING id, ciphertext, iv, tag, key_id`,
    [provider, opts.label ?? null, opts.excludeLabel ?? null],
  );
  if (!row) throw Object.assign(new Error(opts.label === VERTEX_LABEL
    ? `No Vertex service-account key for ${provider}: store one with label "${VERTEX_LABEL}" (keyvault set ${provider} --label ${VERTEX_LABEL} < key.json)`
    : `No ${provider} credential in the vault`), { status: 503 });
  return { id: row.id, secret: decrypt(row) };
}

/** Re-encrypt every credential with the current master key (after rotating OCTILLION_VAULT_KEY). */
export async function rekey() {
  const db = await getDb();
  const { currentId } = masterKeys();
  const rows = await db.query<{ id: number; ciphertext: string; iv: string; tag: string; key_id: string }>(
    "SELECT id, ciphertext, iv, tag, key_id FROM vault_credentials WHERE key_id <> $1", [currentId]);
  for (const r of rows) {
    const enc = encrypt(decrypt(r));
    await db.query("UPDATE vault_credentials SET ciphertext = $2, iv = $3, tag = $4, key_id = $5 WHERE id = $1", [r.id, enc.ciphertext, enc.iv, enc.tag, enc.key_id]);
  }
  // Organizations' data keys (src/orgcrypto.ts) are wrapped by the master key too.
  await (await import("./orgcrypto.js")).rewrapOrgKeys();
  return rows.length;
}
