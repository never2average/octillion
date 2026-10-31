import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getDb } from "./db.js";
import { checkOAuthToken, clerkEnabled, isSuspended, mcpAudiences, memberships, onMembershipChange, organizations, type ClerkMembership, type OAuthRefusal } from "./clerk.js";
import { accountRoleOf, type AccountRole } from "./account-roles.js";

/** What an API key may do: read-only tools, or every tool the person's role allows. Null (older keys) = full access. */
export type KeyScope = "read" | "write";

/** How a /mcp request signed in: an OAuth access token, or an API key (whoami shows it; server.ts enforces a key's scope). */
export interface Credential {
  kind: "oauth" | "api_key";
  /** OAuth: the MCP client Clerk issued the token to. */
  clientId?: string | null;
  /** API key: its id, name (label), the safe-to-show prefix, scope (null = full access), expiry (null = never). */
  keyId?: number;
  name?: string;
  prefix?: string;
  scope?: KeyScope | null;
  expiresAt?: string | null;
  /** A personal key a person made for themselves on /app/settings/api-keys (created_via = 'portal'). */
  personal?: boolean;
}

/** The tenant a request acts for. Every query in queries.ts is scoped by orgId. */
export interface Org {
  orgId: number;
  slug: string;
  name: string;
  /** The Clerk user, when the request came with a Clerk token (absent for legacy API keys). */
  userId?: string;
  /** Their account role (src/account-roles.ts), from the Clerk membership; absent for legacy API keys (no limits). */
  role?: AccountRole;
  /** How the request signed in, when it came over /mcp. */
  credential?: Credential;
}

const publicUrl = () => (process.env.PUBLIC_URL ?? `http://${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? 3333}`).replace(/\/$/, "");
/** Where a person creates a personal API key (the portal's Settings → API keys). */
export const apiKeysUrl = () => `${publicUrl()}/app/settings/api-keys`;

/**
 * Why a request could not act for an account, in words an agent can act on. 401: no credential, or one that is not
 * valid (`error` per RFC 6750); 403: the credential is valid but its person has no usable account, so signing in
 * again would not help (no WWW-Authenticate challenge, which would send an OAuth client round the sign-in loop).
 */
export interface AuthFailure {
  status: 401 | 403 | 503;
  /** RFC 6750 error code for the WWW-Authenticate challenge; absent when no credential was sent at all. */
  error?: "invalid_request" | "invalid_token";
  /** A short reason for error_description (no secrets, no token). */
  description: string;
  /** The full message with the next step (the JSON-RPC error message). */
  message: string;
  /** A stable code: missing, malformed, key_unknown, key_revoked, key_expired, token_*, no_account, suspended, not_linked, not_member, org_mismatch. */
  reason: string;
}
export type AuthResult = { ok: true; org: Org } | ({ ok: false } & AuthFailure);
const refuse = (f: AuthFailure): AuthResult => ({ ok: false, ...f });
const NEXT_STEP = () => `Sign in through your MCP client, or set OCTILLION_API_KEY (create one at ${apiKeysUrl()})`;
const dateOf = (d: Date) => d.toISOString().slice(0, 10);

const KEY_PREFIX = "oct_";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomId = (prefix: string, bytes = 9) => `${prefix}${randomBytes(bytes).toString("base64url")}`;

export const slugify = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "org";

/** Create an organization and its first API key. The key is returned once and only its hash is stored. */
export async function createOrg(name: string, slug = slugify(name)) {
  const db = await getDb();
  const [org] = await db.query<{ id: number; slug: string; name: string }>(
    "INSERT INTO organizations (slug, name) VALUES ($1, $2) RETURNING id, slug, name",
    [slug, name],
  );
  const key = await createApiKey(org.id);
  return { org: { orgId: org.id, slug: org.slug, name: org.name } satisfies Org, key };
}

/** Where a key came from (api_keys.created_via): a person on the portal, a platform admin, or the CLI. */
export type KeyOrigin = "portal" | "admin" | "cli";
export interface KeyOptions { scope?: KeyScope | null; expiresAt?: Date | null; via?: KeyOrigin | null }

/** Issue a key; the key is returned once and only its hash is stored. Without options it is a key as before 0013. */
export async function createApiKey(orgId: number, label = "default", userId: string | null = null, opts: KeyOptions = {}): Promise<string> {
  return (await insertApiKey(orgId, label, userId, opts)).key;
}

/** createApiKey with the new row's id and prefix (the portal shows the row right away). */
export async function insertApiKey(orgId: number, label: string, userId: string | null, opts: KeyOptions = {}): Promise<{ key: string; id: number; prefix: string }> {
  const key = randomId(KEY_PREFIX, 24);
  const prefix = key.slice(0, KEY_PREFIX.length + 6);
  const db = await getDb();
  const [row] = await db.query<{ id: number }>(
    "INSERT INTO api_keys (org_id, label, key_prefix, key_hash, user_id, scope, expires_at, created_via) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
    [orgId, label, prefix, sha256(key), userId, opts.scope ?? null, opts.expiresAt ?? null, opts.via ?? null],
  );
  return { key, id: Number(row.id), prefix };
}

/** Resolve an API key to its organization, or null if it is unknown, revoked or expired (stdio, the local preview). */
export async function resolveKey(key: string | undefined | null): Promise<Org | null> {
  const r = await resolveKeyDetailed(key);
  return r.ok ? r.org : null;
}

/** last_used_at is written at most once a minute per key and process (and the UPDATE skips a fresher value). */
const keyTouched = new Map<number, number>();
function touchKey(id: number) {
  const now = Date.now();
  if (now - (keyTouched.get(id) ?? 0) < 60_000) return;
  if (keyTouched.size > 10_000) keyTouched.clear();
  keyTouched.set(id, now);
  // Best effort; never block the request on it.
  void getDb().then((db) => db.query(
    "/* tenant: the key row just resolved by its hash */ UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')",
    [id])).catch(() => {});
}

/**
 * Resolve an API key, or say why not. Unknown keys all read the same ("not recognised"), so nothing tells whether a
 * key exists; revoked and expired are told apart only to someone holding the key itself. A key issued before 0013
 * (scope and expiry NULL) works exactly as it did: full access, never expires, its person if it has one. A personal key
 * (made on the portal) also needs its person to still be an active member of its account, and carries their role.
 * `orgSlug` (X-Octillion-Org) must name the key's own account when given.
 */
export async function resolveKeyDetailed(key: string | undefined | null, opts: { orgSlug?: string } = {}): Promise<AuthResult> {
  const unknown = () => refuse({ status: 401, error: "invalid_token", reason: "key_unknown", description: "API key not recognised",
    message: `This API key is not valid. Create one at ${apiKeysUrl()} and set OCTILLION_API_KEY to it, or sign in through your MCP client.` });
  if (!key || !key.startsWith(KEY_PREFIX)) return unknown();
  const db = await getDb();
  const [row] = await db.query<{ id: number; org_id: number; slug: string; name: string; clerk_org_id: string | null; user_id: string | null; label: string;
    key_prefix: string; scope: KeyScope | null; expires_at: Date | null; revoked_at: Date | null; created_via: KeyOrigin | null }>(
    `SELECT k.id, k.org_id, o.slug, o.name, o.clerk_org_id, k.user_id, k.label, k.key_prefix, k.scope, k.expires_at, k.revoked_at, k.created_via
       FROM api_keys k JOIN organizations o ON o.id = k.org_id
      WHERE k.key_hash = $1`,
    [sha256(key)],
  );
  if (!row) return unknown();
  if (row.revoked_at) return refuse({ status: 401, error: "invalid_token", reason: "key_revoked", description: "API key revoked",
    message: `This API key was revoked. Create a new one at ${apiKeysUrl()} and set OCTILLION_API_KEY to it.` });
  const expires = row.expires_at ? new Date(row.expires_at) : null;
  if (expires && expires.getTime() <= Date.now()) return refuse({ status: 401, error: "invalid_token", reason: "key_expired",
    description: `API key expired on ${dateOf(expires)}`,
    message: `This API key expired on ${dateOf(expires)}. Create a new one at ${apiKeysUrl()} and set OCTILLION_API_KEY to it.` });
  if (opts.orgSlug && opts.orgSlug !== row.slug) return refuse({ status: 403, reason: "org_mismatch", description: `this key belongs to ${row.slug}`,
    message: `This API key belongs to ${row.name} (${row.slug}), not ${opts.orgSlug}. Remove the X-Octillion-Org header, or create a key in ${opts.orgSlug} at ${apiKeysUrl()}.` });
  const personal = row.created_via === "portal" && Boolean(row.user_id);
  let role: AccountRole | undefined;
  if (personal && clerkEnabled() && row.clerk_org_id) {
    let ms: ClerkMembership[];
    try { ms = await memberships.forUser(row.user_id!); }
    catch { return refuse({ status: 503, reason: "unverifiable", description: "could not check your membership", message: "Octillion could not check your account membership just now. Try again in a minute." }); }
    const m = ms.find((x) => x.organization?.id === row.clerk_org_id);
    if (!m) return refuse({ status: 403, reason: "not_member", description: `not a member of ${row.slug}`,
      message: `This API key's owner is no longer a member of ${row.name}, so the key no longer works. Ask an owner of ${row.name} for an invitation.` });
    if (isSuspended(m)) return refuse({ status: 403, reason: "suspended", description: `access to ${row.slug} is suspended`,
      message: `Your access to ${row.name} is suspended; ask an owner.` });
    role = accountRoleOf(m);
  }
  touchKey(row.id);
  // A key issued to a person acts as that person (usage, adoption, limits); an account key has no person.
  return { ok: true, org: {
    orgId: row.org_id, slug: row.slug, name: row.name, ...(row.user_id ? { userId: row.user_id } : {}), ...(role ? { role } : {}),
    credential: { kind: "api_key", keyId: Number(row.id), name: row.label, prefix: row.key_prefix, scope: row.scope ?? null,
      expiresAt: expires ? expires.toISOString() : null, personal },
  } };
}

/** Constant-time check of the orchestrator's shared worker token (OCTILLION_WORKER_TOKEN). */
export function isWorkerToken(token: string | undefined | null): boolean {
  const expected = process.env.OCTILLION_WORKER_TOKEN;
  if (!expected || !token) return false;
  const a = Buffer.from(sha256(token));
  const b = Buffer.from(sha256(expected));
  return timingSafeEqual(a, b);
}

/** The Vercel cron's bearer (CRON_SECRET), in constant time. Nothing else opens /api/cron/*. */
export function cronSecretOk(authorization: string | undefined): boolean {
  const want = process.env.CRON_SECRET, got = bearer(authorization);
  if (!want || !got) return false;
  return timingSafeEqual(Buffer.from(sha256(got)), Buffer.from(sha256(want)));
}

export function bearer(header: string | undefined): string | null {
  const m = header?.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

/**
 * The credential an MCP request carries in a header: `Authorization: Bearer <oct_ key or OAuth token>`, else
 * `X-API-Key: oct_...` (for clients whose header setting is a plain name/value pair). Never read from the URL: a URL
 * ends up in proxy and access logs, browser history, Referer headers and screenshots.
 */
export function headerCredential(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = bearer(typeof headers.authorization === "string" ? headers.authorization : undefined);
  if (auth) return auth;
  const x = headers["x-api-key"];
  const v = (Array.isArray(x) ? x[0] : x)?.trim();
  return v && /^\S+$/.test(v) ? v : null;
}

/**
 * Legacy connector URLs (/mcp/oct_...) put the key in the URL. OCTILLION_URL_KEYS:
 *   allow (default)  still accepted, deprecated: each response says so (Deprecation header) and the server logs which
 *                    account and key used one, so those people can be moved to a header or to sign-in
 *   off              refused with a 401 that says how to send the key instead
 * New keys are never issued as URLs (src/admin.ts connectInfo).
 */
export const urlKeysAllowed = () => (process.env.OCTILLION_URL_KEYS ?? "allow").trim().toLowerCase() !== "off";

// ---------- Clerk users on /mcp (OAuth) ----------

/** Per person, per chosen organization ("" = the default): the account they act for, for a minute. */
const tokenOrgs = new Map<string, Map<string, { org: Org; at: number }>>();
onMembershipChange((userId) => tokenOrgs.delete(userId)); // a suspended person is cut off at once, not after the cache

/** X-Octillion-Org: a slug (organizations.slug is slugify()'d), else undefined; a malformed value is kept to be refused. */
export function orgHeader(headers: Record<string, string | string[] | undefined>): string | undefined {
  const raw = headers["x-octillion-org"];
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase();
  return v ? v.slice(0, 80) : undefined;
}

const TOKEN_REFUSAL: Record<OAuthRefusal, string> = {
  expired: "token expired or not valid for this server",
  revoked: "token revoked",
  wrong_resource: "token expired or not valid for this server",
  invalid: "token expired or not valid for this server",
  unverifiable: "the token could not be verified just now",
  not_configured: "not an Octillion API key, and sign-in is not set up on this server",
};

/**
 * Resolve a Clerk OAuth access token issued for /mcp (its audience is checked, src/clerk.ts) to the organization the user acts for: their oldest Clerk membership that is not
 * suspended. A Clerk organization created in the Clerk dashboard gets its Octillion row on first use.
 */
export async function resolveUserToken(token: string): Promise<Org | null> {
  const r = await resolveUserTokenDetailed(token);
  return r.ok ? r.org : null;
}

/**
 * resolveUserToken, saying why not: an invalid token is a 401 (sign in again); a valid one whose person has no
 * Octillion account, only suspended memberships, or an organization Octillion does not know is a 403 with the next step
 * (signing in again would not change it). `orgSlug` (X-Octillion-Org) picks one of the person's accounts; without it,
 * the oldest membership that is not suspended, as before.
 */
export async function resolveUserTokenDetailed(token: string, orgSlug?: string): Promise<AuthResult> {
  const v = await checkOAuthToken(token, mcpAudiences()); // issued for /mcp, not another resource
  if (!v.ok) return refuse({ status: 401, error: "invalid_token", reason: `token_${v.reason}`, description: TOKEN_REFUSAL[v.reason],
    message: v.reason === "not_configured"
      ? `This is not an Octillion API key, and sign-in is not set up on this server. Set OCTILLION_API_KEY to a key from ${apiKeysUrl()}.`
      : `Your sign-in ${v.reason === "revoked" ? "was revoked" : v.reason === "unverifiable" ? "could not be checked just now" : "has expired or is not valid for this server"}. ${NEXT_STEP()}.` });
  const { userId, clientId } = v.claims;
  const credential: Credential = { kind: "oauth", clientId };
  const mine = tokenOrgs.get(userId);
  const hit = mine?.get(orgSlug ?? "");
  if (hit && Date.now() - hit.at < 60_000) return { ok: true, org: { ...hit.org, credential } };
  const all = (await memberships.forUser(userId)).filter((m) => m.organization).sort((a, b) => a.created_at - b.created_at);
  const requestAccess = `request access at ${publicUrl()}`;
  if (!all.length) return refuse({ status: 403, reason: "no_account", description: "no Octillion workspace",
    message: `Your account has no Octillion workspace; ${requestAccess}, or ask your team's Octillion owner to invite you.` });
  let m: ClerkMembership | undefined;
  if (orgSlug) {
    const [row] = await (await getDb()).query<{ clerk_org_id: string | null }>("SELECT clerk_org_id FROM organizations WHERE slug = $1", [orgSlug]);
    m = row?.clerk_org_id ? all.find((x) => x.organization!.id === row.clerk_org_id) : undefined;
    // The same words whether or not the slug exists: it says nothing about other accounts.
    if (!m) return refuse({ status: 403, reason: "not_member", description: `not a member of ${orgSlug}`,
      message: `You are not a member of the Octillion workspace "${orgSlug}" (X-Octillion-Org). Remove the header to use your default workspace, or ask an owner of ${orgSlug} to invite you.` });
    if (isSuspended(m)) return refuse({ status: 403, reason: "suspended", description: `access to ${orgSlug} is suspended`,
      message: `Your access to ${m.organization!.name} is suspended; ask an owner.` });
  } else {
    m = all.find((x) => !isSuspended(x));
    if (!m) return refuse({ status: 403, reason: "suspended", description: "access suspended",
      message: `Your access to ${all.map((x) => x.organization!.name).join(", ")} is suspended; ask an owner.` });
  }
  const found = await orgForClerk(m.organization!.id);
  if (!found) return refuse({ status: 403, reason: "not_linked", description: "organization not linked to Octillion",
    message: `Your organization ${m.organization!.name} is not an Octillion workspace yet; ${requestAccess}.` });
  const org: Org = { ...found, userId, role: accountRoleOf(m) };
  if (!mine) tokenOrgs.set(userId, new Map());
  tokenOrgs.get(userId)!.set(orgSlug ?? "", { org, at: Date.now() });
  return { ok: true, org: { ...org, credential } };
}

/**
 * Who a /mcp request is: `Authorization: Bearer <oct_ key or OAuth token>`, else `X-API-Key: oct_…`, plus an optional
 * X-Octillion-Org. Every refusal says what to do next (AuthFailure). Keys in the URL are handled by the caller.
 */
export async function authenticateMcp(headers: Record<string, string | string[] | undefined>): Promise<AuthResult> {
  const slug = orgHeader(headers);
  if (slug !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) return refuse({ status: 403, reason: "not_member", description: "X-Octillion-Org is not a workspace slug",
    message: `X-Octillion-Org must be a workspace slug (letters, digits and dashes). Remove the header to use your default workspace.` });
  const authz = typeof headers.authorization === "string" ? headers.authorization.trim() : "";
  const viaBearer = bearer(authz);
  const x = headers["x-api-key"];
  const xKey = (Array.isArray(x) ? x[0] : x)?.trim() || null;
  if (!viaBearer && authz && !xKey) return refuse({ status: 401, error: "invalid_request", reason: "malformed", description: "use Authorization: Bearer <token>",
    message: `The Authorization header must be "Bearer <token>". ${NEXT_STEP()}.` });
  if (!viaBearer && !xKey) return refuse({ status: 401, reason: "missing", description: "authentication required", message: `${NEXT_STEP()}.` });
  if (viaBearer) return viaBearer.startsWith(KEY_PREFIX) ? resolveKeyDetailed(viaBearer, { orgSlug: slug }) : resolveUserTokenDetailed(viaBearer, slug);
  // X-API-Key carries Octillion API keys only.
  if (!/^\S+$/.test(xKey!) || !xKey!.startsWith(KEY_PREFIX)) return refuse({ status: 401, error: "invalid_request", reason: "malformed",
    description: "X-API-Key takes Octillion API keys; send OAuth tokens as Authorization: Bearer",
    message: `X-API-Key takes Octillion API keys (oct_…). Send an OAuth access token as "Authorization: Bearer <token>" instead, or set OCTILLION_API_KEY (create one at ${apiKeysUrl()}).` });
  return resolveKeyDetailed(xKey, { orgSlug: slug });
}

/** The Octillion organization joined to a Clerk organization, created (and linked by slug metadata) on first sight. */
const selfServe = () => (process.env.OCTILLION_SELF_SERVE_ACCOUNTS ?? "off").toLowerCase() === "on";

/** The Octillion account for a Clerk organization: linked by id, or by the octillion_slug Octillion wrote when it
 *  created the organization; a new account only in self-serve mode. */
export async function orgForClerk(clerkOrgId: string): Promise<Org | null> {
  const db = await getDb();
  const find = async () => (await db.query<{ id: number; slug: string; name: string }>(
    "SELECT id, slug, name FROM organizations WHERE clerk_org_id = $1", [clerkOrgId]))[0];
  let row = await find();
  if (!row) {
    if (!clerkEnabled()) return null;
    const c = await organizations.get(clerkOrgId);
    const known = typeof c.public_metadata?.octillion_slug === "string" ? c.public_metadata.octillion_slug : null;
    const bySlug = known
      ? (await db.query<{ id: number }>("SELECT id FROM organizations WHERE slug = $1 AND clerk_org_id IS NULL", [known]))[0]
      : undefined;
    if (bySlug) await db.query("UPDATE organizations SET clerk_org_id = $2 WHERE id = $1", [bySlug.id, clerkOrgId]);
    // Accounts are invite-only: a Clerk organization someone made for themselves is not an Octillion account unless
    // self-serve is switched on (OCTILLION_SELF_SERVE_ACCOUNTS=on).
    else if (!selfServe()) return null;
    else {
      let slug = slugify(c.name);
      if ((await db.query("SELECT 1 FROM organizations WHERE slug = $1", [slug])).length) slug = `${slug.slice(0, 40)}-${randomBytes(3).toString("hex")}`;
      const [made] = await db.query<{ id: number }>("INSERT INTO organizations (slug, name, clerk_org_id) VALUES ($1, $2, $3) ON CONFLICT (clerk_org_id) DO NOTHING RETURNING id", [slug, c.name, clerkOrgId]);
      // A GTM trigger (src/gtm-events.ts): a self-serve account was made.
      if (made) void import("./gtm-events.js").then((g) => g.emitLater("account_created", { org_id: Number(made.id), key: String(made.id) })).catch(() => {});
      await organizations.setMetadata(clerkOrgId, { octillion_slug: slug }).catch((err) => console.error("clerk metadata:", (err as Error).message));
    }
    row = await find();
  }
  return row ? { orgId: row.id, slug: row.slug, name: row.name } : null;
}
