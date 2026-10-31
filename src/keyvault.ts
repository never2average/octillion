import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
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
/** The generated HMAC key for unsubscribe links (src/campaigns.ts): a singleton, only ever added once, never replaced. */
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

/** Whether the vault holds at least one key of this provider (key type). */
export async function hasCredential(provider: string): Promise<boolean> {
  // The vault is platform data, out of a tenant's reach (src/tenant-scope.ts): read as the platform.
  return asPlatform(async () => (await (await getDb()).query("SELECT 1 FROM vault_credentials WHERE provider = $1", [provider])).length > 0);
}

/**
 * Of these gateway providers, the ones the gateway can serve right now. A provider on a Vertex backend needs a
 * Vertex AI key; any other needs a key of its own and an upstream URL, except Claude (anthropic), which falls
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

// ---------- credentials: one row per key ----------
// A key type (provider) may hold several keys, each its own row. Adding a key always creates a row; a key is replaced
// on its own row or deleted, never disabled. Requests pick among a type's keys least recently used first.

/** Display names for the vault's provider ids (the admin page, the CLI, automatic key names). */
const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic", openai: "OpenAI", google: "Google Gemini", cloudflare: "Cloudflare Workers AI", dashscope: "Alibaba DashScope",
  vertex: "Vertex AI", boat: "boat.dev", exa: "Exa", libraries_io: "Libraries.io", resend: "Resend", amp: "Amp", cursor: "Cursor",
  factory: "Factory", github_copilot: "GitHub Copilot", apollo: "Apollo", slack: "Slack", resend_webhook: "Resend Webhook",
  email_unsubscribe: "Email Unsubscribe Signing",
};
/** A provider's display name; Title Case of the id for one the map does not know ("smoke_llm" → "Smoke Llm"). */
export const providerName = (slug: string) => PROVIDER_NAMES[slug]
  ?? slug.replace(/[_-]+/g, " ").trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");

/**
 * A digest of a key's plaintext, to refuse the same key twice for a type without decrypting every row: HMAC-SHA256
 * under a subkey of the master key that encrypted the row, so a database dump alone cannot test guesses against it.
 * A row's digest always uses the same master key as its ciphertext (rekey recomputes both).
 */
function digestWith(master: Buffer, secret: string): string {
  const sub = createHmac("sha256", master).update("octillion-vault/secret-digest/v1").digest();
  return createHmac("sha256", sub).update(secret).digest("hex");
}
/** The digest for a row encrypted under master key `keyIdOf`; null when that key is not loaded. */
function digestFor(keyIdOf: string, secret: string): string | null {
  const k = masterKeys().byId.get(keyIdOf);
  return k ? digestWith(k, secret) : null;
}
/** The digest of a secret under every loaded master key (current and previous), for the duplicate check. */
const digestCandidates = (secret: string) => [...masterKeys().byId.values()].map((k) => digestWith(k, secret));

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "23505" || /unique|duplicate key/i.test(String((e as Error)?.message));
const duplicateError = (provider: string, name?: string | null) =>
  Object.assign(new Error(`This key is already in the vault${name ? ` (${name})` : ""}: the same ${providerName(provider)} key cannot be added twice`), { status: 409 });

interface EncRow { id: number; ciphertext: string; iv: string; tag: string; key_id: string; secret_digest: string | null }

/** Fill a row's missing digest from its plaintext (rows stored before migration 0012). Leaves it null on a clash. */
async function fillDigest(row: EncRow, secret: string): Promise<boolean> {
  if (row.secret_digest) return true;
  const d = digestFor(row.key_id, secret);
  if (!d) return false;
  try {
    const r = await (await getDb()).query("UPDATE vault_credentials SET secret_digest = $2 WHERE id = $1 AND secret_digest IS NULL RETURNING id", [row.id, d]);
    return r.length > 0;
  } catch (e) {
    // An identical older row of the same type already has this digest: leave this one null (both still work).
    if (!isUniqueViolation(e)) throw e;
    return false;
  }
}

/** The row of this type that already holds this exact secret (other than `exceptId`), filling missing digests on the way. */
async function findSameSecret(provider: string, secret: string, exceptId: number | null): Promise<{ id: number; label: string | null } | null> {
  const db = await getDb();
  // Rows without a digest yet are decrypted and compared directly (and get their digest).
  const legacy = await db.query<EncRow & { label: string | null }>(
    "SELECT id, ciphertext, iv, tag, key_id, secret_digest, label FROM vault_credentials WHERE provider = $1 AND secret_digest IS NULL ORDER BY id", [provider]);
  let hit: { id: number; label: string | null } | null = null;
  for (const r of legacy) {
    let plain: string;
    try { plain = decrypt(r); } catch { continue; } // encrypted with a master key no longer loaded: cannot compare
    await fillDigest(r, plain);
    if (plain === secret && r.id !== exceptId) hit ??= { id: r.id, label: r.label };
  }
  if (hit) return hit;
  const [row] = await db.query<{ id: number; label: string | null }>(
    "SELECT id, label FROM vault_credentials WHERE provider = $1 AND secret_digest = ANY($2::text[]) AND ($3::int IS NULL OR id <> $3) ORDER BY id LIMIT 1",
    [provider, digestCandidates(secret), exceptId]);
  return row ?? null;
}

/** The checks every stored key passes; returns the trimmed secret and its service-account details (Vertex AI). */
async function checkSecret(provider: string, secret: string, generated: boolean) {
  const p = await getProvider(provider);
  if (!p) throw new Error(`Unknown provider ${provider}; add it first (keyvault provider ...)`);
  // A direct-mode key is handed to agent sessions as is; refuse to store one unless that is explicitly allowed.
  // Orchestrator-only keys (boat, vertex; search providers with no env_vars) never reach a session, so they are always fine.
  if (p.mode === "direct" && provider !== "boat" && p.env_vars.length && process.env.OCTILLION_DIRECT_KEYS !== "allow")
    throw new Error(`${provider} is a direct-mode provider: its real key would be handed to agent sessions. ` +
                    "Set OCTILLION_DIRECT_KEYS=allow only once those sessions run without customer-written tasks (docs/security.md)");
  // The unsubscribe signing key is generated once (src/campaigns.ts, addCredentialIfAbsent) and signs every unsubscribe
  // link already sent: replacing it, or adding another, would break them, so only its generator stores it.
  if (provider === UNSUBSCRIBE_SIGNING_PROVIDER && !generated)
    throw new Error("The email unsubscribe signing key cannot be replaced or added: every unsubscribe link already sent is signed with it. It is generated automatically; delete it only if those links may stop working");
  const s = secret.trim();
  if (s.length < 8) throw new Error("That does not look like a credential");
  // The Vertex AI key is a Google service-account key, checked in full.
  const meta: ServiceAccountInfo | null = provider === VERTEX_PROVIDER ? checkServiceAccount(s) : null;
  return { s, meta };
}

/** An automatic name for a new key of this type: "Vertex AI key", then "Vertex AI key 2", "Vertex AI key 3", ... */
async function autoName(provider: string): Promise<string> {
  const base = `${providerName(provider)} key`;
  const rows = await (await getDb()).query<{ label: string | null }>("SELECT label FROM vault_credentials WHERE provider = $1", [provider]);
  const taken = new Set(rows.map((r) => r.label));
  for (let n = rows.length + 1; ; n++) {
    const name = n === 1 ? base : `${base} ${n}`;
    if (!taken.has(name)) return name;
  }
}

const cleanName = (name: string | null | undefined) => {
  const n = (name ?? "").replace(/\s+/g, " ").trim();
  if (n.length > 80) throw new Error("A key name is at most 80 characters");
  return n || null;
};

export interface SavedCredential { id: number; provider: string; name: string; hint: string; project_id?: string; client_email?: string }

const saved = (id: number, provider: string, name: string, s: string, meta: ServiceAccountInfo | null): SavedCredential =>
  ({ id, provider, name, hint: hint(s), ...(meta ? { project_id: meta.project_id, client_email: meta.client_email } : {}) });

/**
 * Add a key as a new row of its type (never replaces another). The exact same secret already stored for the type is
 * refused (status 409). `name` is optional; without one the key gets an automatic "<Type> key N".
 */
export async function addCredential(provider: string, secret: string, opts: { name?: string | null } = {}): Promise<SavedCredential> {
  const { s, meta } = await checkSecret(provider, secret, false);
  const name = cleanName(opts.name) ?? await autoName(provider);
  const same = await findSameSecret(provider, s, null);
  if (same) throw duplicateError(provider, same.label);
  const enc = encrypt(s);
  try {
    const [row] = await (await getDb()).query<{ id: number }>(
      `INSERT INTO vault_credentials (provider, label, ciphertext, iv, tag, key_id, hint, meta, secret_digest)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) RETURNING id`,
      [provider, name, enc.ciphertext, enc.iv, enc.tag, enc.key_id, hint(s), meta ? JSON.stringify(meta) : null, digestFor(enc.key_id, s)]);
    return saved(row!.id, provider, name, s, meta);
  } catch (e) {
    if (isUniqueViolation(e)) throw duplicateError(provider); // the same key added at the same moment
    throw e;
  }
}

/**
 * Store a key only when its type has none at all (never adds a second, never overwrites); null when it had one. Used
 * by the one-time environment import and the unsubscribe key's generator (a singleton: replicas racing on the first
 * one all end up with the winner's).
 */
export async function addCredentialIfAbsent(provider: string, secret: string): Promise<SavedCredential | null> {
  const { s, meta } = await checkSecret(provider, secret, true);
  const enc = encrypt(s);
  const name = `${providerName(provider)} key`;
  const [row] = await (await getDb()).query<{ id: number }>(
    `INSERT INTO vault_credentials (provider, label, ciphertext, iv, tag, key_id, hint, meta, secret_digest)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9
      WHERE NOT EXISTS (SELECT 1 FROM vault_credentials WHERE provider = $1)
     ON CONFLICT DO NOTHING RETURNING id`,
    [provider, name, enc.ciphertext, enc.iv, enc.tag, enc.key_id, hint(s), meta ? JSON.stringify(meta) : null, digestFor(enc.key_id, s)]);
  return row ? saved(row.id, provider, name, s, meta) : null;
}

/** Replace one key's secret on its own row (rotated_at set); the type's other keys are untouched. */
export async function replaceCredential(id: number, secret: string): Promise<SavedCredential> {
  const db = await getDb();
  const [cur] = await db.query<{ provider: string; label: string | null }>("SELECT provider, label FROM vault_credentials WHERE id = $1", [id]);
  if (!cur) throw Object.assign(new Error(`No credential ${id}`), { status: 404 });
  const { s, meta } = await checkSecret(cur.provider, secret, false);
  const same = await findSameSecret(cur.provider, s, id);
  if (same) throw duplicateError(cur.provider, same.label);
  const enc = encrypt(s);
  let row: { id: number } | undefined;
  try {
    [row] = await db.query<{ id: number }>(
      `UPDATE vault_credentials SET ciphertext = $2, iv = $3, tag = $4, key_id = $5, hint = $6, meta = $7::jsonb, secret_digest = $8, rotated_at = now()
        WHERE id = $1 RETURNING id`,
      [id, enc.ciphertext, enc.iv, enc.tag, enc.key_id, hint(s), meta ? JSON.stringify(meta) : null, digestFor(enc.key_id, s)]);
  } catch (e) {
    if (isUniqueViolation(e)) throw duplicateError(cur.provider);
    throw e;
  }
  if (!row) throw Object.assign(new Error(`No credential ${id}`), { status: 404 });
  return saved(id, cur.provider, cur.label ?? `${providerName(cur.provider)} key`, s, meta);
}

export interface CredentialRow {
  id: number; provider: string; name: string; hint: string; uses: number | string; last_used_at: Date | null; created_at: Date; rotated_at: Date | null;
  key_id: string; meta: { project_id?: string; client_email?: string } | null;
}
/** Every key, one row each: hints and usage only, never a secret. A key without a name gets "<Type> key N" by age. */
export async function listCredentials(): Promise<CredentialRow[]> {
  const rows = await (await getDb()).query<Omit<CredentialRow, "name"> & { label: string | null; n: number | string }>(
    `SELECT id, provider, label, hint, uses, last_used_at, created_at, rotated_at, key_id, meta,
            row_number() OVER (PARTITION BY provider ORDER BY id) AS n
       FROM vault_credentials ORDER BY provider, id`);
  return rows.map(({ label, n, ...r }) => ({ ...r, name: label ?? `${providerName(r.provider)} key${Number(n) > 1 ? ` ${n}` : ""}` }));
}

/** Delete a key; returns what it was (for the audit log). */
export async function deleteCredential(id: number): Promise<{ id: number; provider: string; hint: string; name: string | null }> {
  const [row] = await (await getDb()).query<{ id: number; provider: string; hint: string; name: string | null }>(
    "DELETE FROM vault_credentials WHERE id = $1 RETURNING id, provider, hint, label AS name", [id]);
  if (!row) throw Object.assign(new Error(`No credential ${id}`), { status: 404 });
  return row;
}

/**
 * One of the provider's keys, counted as a use: the least recently used one (never used first, then the oldest last
 * use; ties by id), so a type's keys take turns. Throws (status 503) when the provider has none.
 */
export async function useCredential(provider: string): Promise<{ id: number; secret: string }> {
  // The vault is platform data, out of a tenant's reach (src/tenant-scope.ts): read as the platform.
  return asPlatform(async () => {
    const [row] = await (await getDb()).query<EncRow>(
      `UPDATE vault_credentials SET uses = uses + 1, last_used_at = clock_timestamp()
        WHERE id = (SELECT id FROM vault_credentials WHERE provider = $1 ORDER BY last_used_at ASC NULLS FIRST, id LIMIT 1)
        RETURNING id, ciphertext, iv, tag, key_id, secret_digest`, [provider]);
    if (!row) throw Object.assign(new Error(`No ${provider} credential in the vault`), { status: 503 });
    const secret = decrypt(row);
    await fillDigest(row, secret).catch(() => false); // best effort: the key works either way
    return { id: row.id, secret };
  });
}

/**
 * Every key of a type, not counted as a use: for checking something against each of them (a webhook signature that
 * any of the type's secrets may have made). Count the one that matched with recordUse.
 */
export async function credentialSecrets(provider: string): Promise<{ id: number; secret: string }[]> {
  // The vault is platform data, out of a tenant's reach (src/tenant-scope.ts): read as the platform.
  return asPlatform(async () => {
    const rows = await (await getDb()).query<EncRow>(
      "SELECT id, ciphertext, iv, tag, key_id, secret_digest FROM vault_credentials WHERE provider = $1 ORDER BY last_used_at DESC NULLS LAST, id", [provider]);
    return rows.map((r) => ({ id: r.id, secret: decrypt(r) }));
  });
}
/** Count a use of one key (after credentialSecrets found it was the one). */
export async function recordUse(id: number): Promise<void> {
  // The vault is platform data, out of a tenant's reach (src/tenant-scope.ts): read as the platform.
  await asPlatform(async () => (await getDb()).query("UPDATE vault_credentials SET uses = uses + 1, last_used_at = clock_timestamp() WHERE id = $1", [id]));
}

/**
 * The Google service-account key a Vertex backend signs in with: one of the Vertex AI provider's (vertex) keys, least
 * recently used first like any other type (anthropic or google on backend=vertex, and Claude's fallback when there is
 * no Anthropic key). No other provider holds one.
 */
export async function useVertexCredential(): Promise<{ id: number; secret: string }> {
  return useCredential(VERTEX_PROVIDER).catch(() => {
    throw Object.assign(new Error("No Vertex service-account key in the vault: add a Vertex AI key on Key vault"), { status: 503 });
  });
}

/** Fill the digest of every key stored before migration 0012 (the duplicate check); returns how many were filled. */
export async function backfillDigests(): Promise<number> {
  const rows = await (await getDb()).query<EncRow>("SELECT id, ciphertext, iv, tag, key_id, secret_digest FROM vault_credentials WHERE secret_digest IS NULL ORDER BY id");
  let n = 0;
  for (const r of rows) if (await fillDigest(r, decrypt(r))) n++;
  return n;
}

/** Re-encrypt every credential with the current master key (after rotating OCTILLION_VAULT_KEY); digests follow. */
export async function rekey() {
  const db = await getDb();
  const { currentId } = masterKeys();
  const rows = await db.query<{ id: number; ciphertext: string; iv: string; tag: string; key_id: string }>(
    "SELECT id, ciphertext, iv, tag, key_id FROM vault_credentials WHERE key_id <> $1", [currentId]);
  for (const r of rows) {
    const plain = decrypt(r);
    const enc = encrypt(plain);
    // The digest moves to the new master key with the ciphertext; it is filled again just below.
    await db.query("UPDATE vault_credentials SET ciphertext = $2, iv = $3, tag = $4, key_id = $5, secret_digest = NULL WHERE id = $1",
      [r.id, enc.ciphertext, enc.iv, enc.tag, enc.key_id]);
  }
  await backfillDigests();
  // Organizations' data keys (src/orgcrypto.ts) are wrapped by the master key too.
  await (await import("./orgcrypto.js")).rewrapOrgKeys();
  return rows.length;
}
