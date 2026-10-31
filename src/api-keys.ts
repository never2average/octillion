/**
 * Personal API keys (docs/accounts.md): the headless way into /mcp, for agents that cannot finish a browser sign-in
 * (claude -p, the Agent SDK, CI, SSH, sandboxes). Any signed-in member makes keys for themselves on
 * /app/settings/api-keys and sets OCTILLION_API_KEY to one; the key is shown once and only its hash is kept.
 *
 *   * A key is always its creator's (api_keys.user_id): their role, Budget rules and audit trail apply, and it stops
 *     working when they leave the account or are suspended (src/auth.ts resolveKeyDetailed).
 *   * scope: write (default; every tool their role allows) or read (read-only tools: src/server.ts TOOL_ACCESS).
 *   * expiry: 30, 90 (default) or 365 days, or never.
 *   * Members list and revoke their own keys; owners (the Team permission) see and revoke every key in the account,
 *     including the older account-wide connector keys a platform admin issued.
 *
 * Keys sit in api_keys beside the older ones (migration 0013). Tenant work may read its own account's keys but never
 * write them (row-level security, 0003), so issuing and revoking run as the platform, always filtered by organization.
 */
import { asPlatform } from "./tenant-scope.js";
import { getDb } from "./db.js";
import { apiKeysUrl, insertApiKey, type KeyScope, type Org } from "./auth.js";
import * as clerk from "./clerk.js";

export class ApiKeyError extends Error { constructor(message: string, public status = 400) { super(message); } }

/** Expiry choices, in days; null = never. */
export const EXPIRY_DAYS = [30, 90, 365, null] as const;
export const DEFAULT_EXPIRY_DAYS = 90;
/** Active (not revoked, not expired) personal keys one person may hold in one account. */
export const MAX_ACTIVE_KEYS = 25;

export interface KeyRow {
  id: number; name: string; prefix: string;
  /** read, write, or full (an older key with no scope: every tool, as before). */
  scope: "read" | "write" | "full";
  expires_at: string | null; created_at: string; last_used_at: string | null; revoked_at: string | null;
  created_via: string | null; user_id: string | null;
  status: "active" | "expired" | "revoked";
  mine: boolean;
  owner: { email: string | null; name: string | null } | null;
}

type Raw = { id: number; label: string; key_prefix: string; scope: KeyScope | null; expires_at: Date | null; created_at: Date; last_used_at: Date | null;
  revoked_at: Date | null; created_via: string | null; user_id: string | null };
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const COLS = "id, label, key_prefix, scope, expires_at, created_at, last_used_at, revoked_at, created_via, user_id";

function shape(r: Raw, me: string | null, people: Map<string, { email: string | null; name: string | null }>): KeyRow {
  const expired = r.expires_at != null && new Date(r.expires_at).getTime() <= Date.now();
  return {
    id: Number(r.id), name: r.label, prefix: r.key_prefix, scope: r.scope ?? "full",
    expires_at: iso(r.expires_at), created_at: iso(r.created_at)!, last_used_at: iso(r.last_used_at), revoked_at: iso(r.revoked_at),
    created_via: r.created_via, user_id: r.user_id,
    status: r.revoked_at ? "revoked" : expired ? "expired" : "active",
    mine: Boolean(me && r.user_id === me),
    owner: r.user_id ? people.get(r.user_id) ?? { email: null, name: null } : null,
  };
}

/** The keys a person sees: their own, or (`all`, owners) every key in the account. Never the hash or the key. */
export async function listKeys(orgId: number, me: string | null, opts: { all: boolean; people?: { user_id: string; email: string | null; name?: string | null }[] }): Promise<KeyRow[]> {
  const db = await getDb();
  const rows = opts.all
    ? await db.query<Raw>(`SELECT ${COLS} FROM api_keys WHERE org_id = $1 ORDER BY revoked_at IS NOT NULL, created_at DESC`, [orgId])
    : await db.query<Raw>(`SELECT ${COLS} FROM api_keys WHERE org_id = $1 AND user_id = $2 ORDER BY revoked_at IS NOT NULL, created_at DESC`, [orgId, me ?? ""]);
  const people = new Map((opts.people ?? []).map((p) => [p.user_id, { email: p.email, name: p.name ?? null }]));
  return rows.map((r) => shape(r, me, people));
}

/** Parse the create form: name (required), access read | write (default write), expiry 30/90/365 days or never (default 90). */
export function parseCreate(body: Record<string, unknown>): { name: string; scope: KeyScope; days: number | null } {
  const name = String(body.name ?? "").trim().replace(/\s+/g, " ");
  if (!name) throw new ApiKeyError("Give the key a name, e.g. \"CI\" or \"laptop claude -p\"");
  if (name.length > 80) throw new ApiKeyError("A key name is at most 80 characters");
  const scope = body.scope == null || body.scope === "" ? "write" : body.scope;
  if (scope !== "read" && scope !== "write") throw new ApiKeyError("Access must be read or write");
  const raw = body.expires_days === undefined ? DEFAULT_EXPIRY_DAYS : body.expires_days;
  const days = raw === null || raw === "never" || raw === "" ? null : Number(raw);
  if (days !== null && !(EXPIRY_DAYS as readonly (number | null)[]).includes(days)) throw new ApiKeyError("Expiry must be 30, 90 or 365 days, or never");
  return { name, scope, days };
}

/** A new personal key for `userId` in the account. The key is returned once; the row is what the list shows. */
export async function createPersonalKey(orgId: number, userId: string, body: Record<string, unknown>): Promise<{ key: string; row: KeyRow }> {
  const { name, scope, days } = parseCreate(body);
  const db = await getDb();
  const [{ n }] = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM api_keys WHERE org_id = $1 AND user_id = $2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())", [orgId, userId]);
  if (Number(n) >= MAX_ACTIVE_KEYS) throw new ApiKeyError(`You have ${MAX_ACTIVE_KEYS} active keys in this account: revoke one you no longer use first`, 409);
  const expiresAt = days === null ? null : new Date(Date.now() + days * 86_400_000);
  // Tenant work may not write api_keys (0003): issuing is the platform's, for this organization and person only.
  const made = await asPlatform(() => insertApiKey(orgId, name, userId, { scope, expiresAt, via: "portal" }));
  const [raw] = await db.query<Raw>(`SELECT ${COLS} FROM api_keys WHERE org_id = $1 AND id = $2`, [orgId, made.id]);
  return { key: made.key, row: shape(raw, userId, new Map()) };
}

/**
 * Revoke a key in the account: one's own, or (`any`, owners) anyone's. Another person's key reads as not found to a
 * member, so a member learns nothing about keys that are not theirs.
 */
export async function revokeKey(orgId: number, keyId: number, by: { userId: string | null; any: boolean }): Promise<KeyRow> {
  if (!Number.isSafeInteger(keyId) || keyId <= 0) throw new ApiKeyError("No such key", 404);
  const db = await getDb();
  const [k] = await db.query<Raw>(`SELECT ${COLS} FROM api_keys WHERE org_id = $1 AND id = $2`, [orgId, keyId]);
  if (!k || (!by.any && (!by.userId || k.user_id !== by.userId))) throw new ApiKeyError("No such key", 404);
  if (k.revoked_at) throw new ApiKeyError("This key is already revoked", 409);
  await asPlatform(() => db.query("UPDATE api_keys SET revoked_at = now() WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL", [orgId, keyId]));
  return shape({ ...k, revoked_at: new Date() }, by.userId, new Map());
}

/** How to use a new key: the variable, and where it goes. */
export const envInstructions = (url: string) => ({
  variable: "OCTILLION_API_KEY",
  shell: "export OCTILLION_API_KEY=<paste the key>",
  note: `Keep it in your shell profile, a secret manager or your CI's secrets, never in a file you commit. Clients send it as "Authorization: Bearer $OCTILLION_API_KEY" to ${url}.`,
});

/** whoami (MCP): the person, the account and how this connection signed in. */
export async function whoami(org: Org) {
  const c = org.credential;
  let person: { user_id: string; email: string | null; name: string | null } | null = null;
  if (org.userId) {
    const u = clerk.clerkEnabled() ? await clerk.users.get(org.userId).catch(() => null) : null;
    person = { user_id: org.userId, email: u ? clerk.primaryEmail(u).email : null, name: u ? clerk.displayName(u) : null };
  }
  return {
    view: "whoami" as const,
    person,
    org: { slug: org.slug, name: org.name },
    role: org.role ?? null,
    credential: !c ? { type: "unknown" as const }
      : c.kind === "oauth" ? { type: "oauth" as const, client_id: c.clientId ?? null }
      : { type: "api_key" as const, name: c.name ?? null, prefix: c.prefix ?? null, scope: c.scope ?? "full", expires_at: c.expiresAt ?? null, personal: Boolean(c.personal) },
    api_keys_url: apiKeysUrl(),
  };
}
