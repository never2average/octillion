import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getDb } from "./db.js";
import { asPlatform } from "./tenant-scope.js";

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
  env_vars: string[];
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
  // Google service-account keys: show the account only, never fragments of the JSON.
  if (secret.trimStart().startsWith("{")) {
    try {
      const j = JSON.parse(secret) as { client_email?: string };
      if (j.client_email) return j.client_email;
    } catch { /* not JSON: fall through */ }
    return "JSON credential";
  }
  return secret.length <= 10 ? "…" : `${secret.slice(0, 6)}…${secret.slice(-4)}`;
}

/** The vault provider that holds Google Cloud service-account keys for Claude (and Gemini) on Vertex AI. */
export const VERTEX_PROVIDER = "vertex";
/** The generated HMAC key for unsubscribe links (src/campaigns.ts): only ever added once, never replaced. */
export const UNSUBSCRIBE_SIGNING_PROVIDER = "email_unsubscribe";

export interface ServiceAccountInfo { project_id: string; client_email: string }
/**
 * A Google service-account JSON key, checked: valid JSON, type service_account, and project_id, client_email and
 * private_key present. Errors never quote the key.
 */
export function checkServiceAccount(secret: string): ServiceAccountInfo {
  let j: Record<string, unknown>;
  try { j = JSON.parse(secret); } catch { throw new Error("That is not valid JSON: paste the whole service-account key file from Google Cloud"); }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("That is not a service-account key file");
  if (j.type !== "service_account") throw new Error('That is not a service-account key: "type" must be "service_account"');
  for (const f of ["project_id", "client_email", "private_key"] as const)
    if (typeof j[f] !== "string" || !(j[f] as string).trim()) throw new Error(`The service-account key has no ${f}`);
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(j.private_key as string)) throw new Error("The service-account key's private_key is not a PEM key");
  return { project_id: j.project_id as string, client_email: j.client_email as string };
}

// ---------- providers ----------

const PROVIDER_COLS = "slug, mode, upstream_url, auth_header, auth_prefix, env_vars, backend, backend_config";

export async function listProviders(): Promise<ProviderRow[]> {
  // The vault is platform data, out of a tenant's reach (src/tenant-scope.ts): read as the platform.
  return asPlatform(async () => (await getDb()).query<ProviderRow>(`SELECT ${PROVIDER_COLS} FROM vault_providers ORDER BY slug`));
}

export async function getProvider(slug: string): Promise<ProviderRow | null> {
  // The vault is platform data, out of a tenant's reach (src/tenant-scope.ts): read as the platform.
  return asPlatform(async () => {
    const [row] = await (await getDb()).query<ProviderRow>(`SELECT ${PROVIDER_COLS} FROM vault_providers WHERE slug = $1`, [slug]);
    return row ?? null;
  });
}

/**
 * Add or change a provider's settings (upstream, auth header, backend). There is no provider on/off: a provider is
 * usable when it has a key, so an `enabled` field is ignored.
 */
export async function upsertProvider(p: Partial<ProviderRow> & { slug: string }) {
  if (!/^[a-z0-9_]{2,40}$/.test(p.slug)) throw new Error("provider slug must be lowercase letters, digits or _");
  if (p.mode && !["gateway", "direct"].includes(p.mode)) throw new Error("mode must be gateway or direct");
  if (p.upstream_url && !/^https?:\/\//.test(p.upstream_url)) throw new Error("upstream_url must be http(s)");
  if (p.backend && !["direct", "vertex"].includes(p.backend)) throw new Error("backend must be direct or vertex");
  if (p.backend === "vertex") {
    const c = p.backend_config ?? {};
    // project_id and region are optional: by default the project comes from the Vertex AI key and the region from
    // the VERTEX_REGION setting (Agent configuration).
    if (c.project_id && !/^[a-z][a-z0-9-]{4,29}$/.test(c.project_id)) throw new Error("backend_config.project_id must be a GCP project id");
    if (c.region && !/^[a-z0-9-]{2,30}$/.test(c.region)) throw new Error("backend_config.region must be global, us, eu or a region like us-east5");
  }
  await (await getDb()).query(
    `INSERT INTO vault_providers (slug, mode, upstream_url, auth_header, auth_prefix, env_vars, backend, backend_config)
     VALUES ($1, coalesce($2, 'gateway'), $3, coalesce($4, 'authorization'), coalesce($5, 'Bearer '), coalesce($6::text[], '{}'),
             coalesce($7, 'direct'), coalesce($8::jsonb, '{}'))
     ON CONFLICT (slug) DO UPDATE SET mode = coalesce($2, vault_providers.mode), upstream_url = coalesce($3, vault_providers.upstream_url),
       auth_header = coalesce($4, vault_providers.auth_header), auth_prefix = coalesce($5, vault_providers.auth_prefix),
       env_vars = coalesce($6::text[], vault_providers.env_vars),
       backend = coalesce($7, vault_providers.backend), backend_config = coalesce($8::jsonb, vault_providers.backend_config), updated_at = now()`,
    [p.slug, p.mode ?? null, p.upstream_url ?? null, p.auth_header?.toLowerCase() ?? null, p.auth_prefix ?? null, p.env_vars ?? null,
     p.backend ?? null, p.backend_config ? JSON.stringify(p.backend_config) : null],
  );
  return getProvider(p.slug);
}

/** Providers that satisfy a list of required env var names (registry `requires_env`). */
export async function providersForEnv(envVars: string[]): Promise<ProviderRow[]> {
  // The vault is platform data, out of a tenant's reach (src/tenant-scope.ts): read as the platform.
  return asPlatform(async () => {
    if (!envVars.length) return [];
    return (await getDb()).query<ProviderRow>(`SELECT ${PROVIDER_COLS} FROM vault_providers WHERE env_vars && $1 ORDER BY slug`, [envVars]);
  });
}

/** Whether the vault holds this provider's (key type's) key. */
export async function hasCredential(provider: string): Promise<boolean> {
  // The vault is platform data, out of a tenant's reach (src/tenant-scope.ts): read as the platform.
  return asPlatform(async () => (await (await getDb()).query("SELECT 1 FROM vault_credentials WHERE provider = $1", [provider])).length > 0);
}

/**
 * Of these gateway providers, the ones the gateway can serve right now. A provider on a Vertex backend needs the
 * Vertex AI provider's key; any other needs its own key and an upstream URL, except Claude (anthropic), which falls
 * back to Vertex AI when the vault has a Vertex key and no Anthropic key. The same rules as the gateway, read without
 * using a key.
 */
export async function providersWithKeys(rows: ProviderRow[]): Promise<Set<string>> {
  if (!rows.length) return new Set();
  const keyed = new Set((await (await getDb()).query<{ provider: string }>("SELECT provider FROM vault_credentials")).map((k) => k.provider));
  return new Set(rows.filter((p) => p.backend === "vertex"
    ? keyed.has(VERTEX_PROVIDER)
    : (keyed.has(p.slug) && !!p.upstream_url) || (p.slug === "anthropic" && keyed.has(VERTEX_PROVIDER))).map((p) => p.slug));
}

// ---------- credentials: one key per provider ----------

export interface SavedCredential { id: number; provider: string; hint: string; replaced: boolean; project_id?: string; client_email?: string }

/** Store a provider's key; a provider that already has one has it replaced (rotated_at is set). */
export async function setCredential(provider: string, secret: string): Promise<SavedCredential> {
  return (await storeCredential(provider, secret, false))!;
}
/** Store a key only when the provider has none (never overwrites); null when it had one. */
export const addCredentialIfAbsent = (provider: string, secret: string) => storeCredential(provider, secret, true);

async function storeCredential(provider: string, secret: string, insertOnly: boolean): Promise<SavedCredential | null> {
  const p = await getProvider(provider);
  if (!p) throw new Error(`Unknown provider ${provider}; add it first (keyvault provider ...)`);
  // A direct-mode key is handed to agent sessions as is; refuse to store one unless that is explicitly allowed.
  // Orchestrator-only keys (boat, vertex; search providers with no env_vars) never reach a session, so they are always fine.
  if (p.mode === "direct" && provider !== "boat" && p.env_vars.length && process.env.OCTILLION_DIRECT_KEYS !== "allow")
    throw new Error(`${provider} is a direct-mode provider: its real key would be handed to agent sessions. ` +
                    "Set OCTILLION_DIRECT_KEYS=allow only once those sessions run without customer-written tasks (docs/security.md)");
  // The unsubscribe signing key is generated once (src/campaigns.ts, addCredentialIfAbsent) and signs every unsubscribe
  // link already sent: replacing it would break them all, so nothing replaces it (delete it to have a new one generated).
  if (provider === UNSUBSCRIBE_SIGNING_PROVIDER && !insertOnly)
    throw new Error("The email unsubscribe signing key cannot be replaced: every unsubscribe link already sent is signed with it. It is generated automatically; delete it only if those links may stop working");
  const s = secret.trim();
  if (s.length < 8) throw new Error("That does not look like a credential");
  // The Vertex AI key is a Google service-account key, checked in full.
  const meta: ServiceAccountInfo | null = provider === VERTEX_PROVIDER ? checkServiceAccount(s) : null;
  const enc = encrypt(s);
  const [row] = await (await getDb()).query<{ id: number; replaced: boolean }>(
    `INSERT INTO vault_credentials (provider, ciphertext, iv, tag, key_id, hint, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (provider) DO ${insertOnly ? "NOTHING" : `UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag,
       key_id = excluded.key_id, hint = excluded.hint, meta = excluded.meta, rotated_at = now()`}
     RETURNING id, (xmax <> 0) AS replaced`,
    [provider, enc.ciphertext, enc.iv, enc.tag, enc.key_id, hint(s), meta ? JSON.stringify(meta) : null],
  );
  if (!row) return null; // insertOnly and the provider already has a key: left alone
  return { id: row.id, provider, hint: hint(s), replaced: Boolean(row.replaced), ...(meta ? { project_id: meta.project_id, client_email: meta.client_email } : {}) };
}

export interface CredentialRow {
  id: number; provider: string; hint: string; uses: number | string; last_used_at: Date | null; created_at: Date; rotated_at: Date | null;
  key_id: string; meta: { project_id?: string; client_email?: string } | null;
}
/** Every key, one per provider: hints and usage only, never a secret. */
export async function listCredentials(): Promise<CredentialRow[]> {
  return (await getDb()).query<CredentialRow>(
    "SELECT id, provider, hint, uses, last_used_at, created_at, rotated_at, key_id, meta FROM vault_credentials ORDER BY provider");
}

/** Delete a key; returns what it was (for the audit log). */
export async function deleteCredential(id: number): Promise<{ id: number; provider: string; hint: string }> {
  const [row] = await (await getDb()).query<{ id: number; provider: string; hint: string }>(
    "DELETE FROM vault_credentials WHERE id = $1 RETURNING id, provider, hint", [id]);
  if (!row) throw new Error(`No credential ${id}`);
  return row;
}

/** The provider's one key, counted as a use. Throws (status 503) when the provider has none. */
export async function useCredential(provider: string): Promise<{ id: number; secret: string }> {
  // The vault is platform data, out of a tenant's reach (src/tenant-scope.ts): read as the platform.
  return asPlatform(async () => {
    const [row] = await (await getDb()).query<{ id: number; ciphertext: string; iv: string; tag: string; key_id: string }>(
      `UPDATE vault_credentials SET uses = uses + 1, last_used_at = now() WHERE provider = $1
        RETURNING id, ciphertext, iv, tag, key_id`, [provider]);
    if (!row) throw Object.assign(new Error(`No ${provider} credential in the vault`), { status: 503 });
    return { id: row.id, secret: decrypt(row) };
  });
}

/**
 * The Google service-account key every Vertex backend signs in with: the Vertex AI provider's key (anthropic or
 * google on backend=vertex, and Claude's fallback when there is no Anthropic key). No other provider holds one.
 */
export async function useVertexCredential(): Promise<{ id: number; secret: string }> {
  return useCredential(VERTEX_PROVIDER).catch(() => {
    throw Object.assign(new Error("No Vertex service-account key in the vault: add a Vertex AI key on Key vault"), { status: 503 });
  });
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
