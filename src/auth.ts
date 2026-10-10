import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getDb } from "./db.js";

/** The tenant a request acts for. Every query in queries.ts is scoped by orgId. */
export interface Org {
  orgId: number;
  slug: string;
  name: string;
}

const KEY_PREFIX = "oct_";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomId = (prefix: string, bytes = 9) => `${prefix}${randomBytes(bytes).toString("base64url")}`;

const slugify = (s: string) =>
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

export async function createApiKey(orgId: number, label = "default"): Promise<string> {
  const key = randomId(KEY_PREFIX, 24);
  const db = await getDb();
  await db.query("INSERT INTO api_keys (org_id, label, key_prefix, key_hash) VALUES ($1, $2, $3, $4)", [
    orgId,
    label,
    key.slice(0, KEY_PREFIX.length + 6),
    sha256(key),
  ]);
  return key;
}

/** Resolve an API key to its organization, or null if it is unknown or revoked. */
export async function resolveKey(key: string | undefined | null): Promise<Org | null> {
  if (!key || !key.startsWith(KEY_PREFIX)) return null;
  const db = await getDb();
  const [row] = await db.query<{ id: number; org_id: number; slug: string; name: string }>(
    `SELECT k.id, k.org_id, o.slug, o.name
       FROM api_keys k JOIN organizations o ON o.id = k.org_id
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
    [sha256(key)],
  );
  if (!row) return null;
  // Best effort; never block the request on it.
  db.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [row.id]).catch(() => {});
  return { orgId: row.org_id, slug: row.slug, name: row.name };
}

/** Constant-time check of the orchestrator's shared worker token (OCTILLION_WORKER_TOKEN). */
export function isWorkerToken(token: string | undefined | null): boolean {
  const expected = process.env.OCTILLION_WORKER_TOKEN;
  if (!expected || !token) return false;
  const a = Buffer.from(sha256(token));
  const b = Buffer.from(sha256(expected));
  return timingSafeEqual(a, b);
}

export function bearer(header: string | undefined): string | null {
  const m = header?.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}
