import { vaultProfileRow, type VaultProfile } from "./vault.js";

/**
 * Shared developer profiles only, from a vault file, into a given database: the operator's step after the profile data
 * changes (scripts/sync-profiles.ts). Unlike the full vault sync (src/vault.ts syncVault) it never reads VAULT_URL,
 * never touches library tasks and never runs migrations; it plans first (inserts, updates, renames, retirements, with
 * the names that change) so a dry run shows exactly what would happen; and it never retires a profile some product
 * has linked as a persona unless told to (allowRetireLinked), since that product's runs would lose it.
 * The same rows and guards as syncVault: only shared vault rows nobody edited on /admin are written.
 */

type Q = { query: <T = any>(sql: string, params?: unknown[]) => Promise<T[]> };
type Db = Q & { transaction: <T>(fn: (tx: Q) => Promise<T>) => Promise<T> };

interface Row { id: number; slug: string; name: string; summary: string; attributes: any; instructions: string; external_id: string | null;
                active: boolean; source: string; org_id: number | null; edited_at: Date | null; linked: number }

export interface ProfileSyncPlan {
  inserts: string[];
  updates: string[];
  /** Updates whose display name changes: [slug, old name, new name]. */
  renames: [string, string, string][];
  unchanged: number;
  /** In the file, but the slug belongs to a private, admin-written or admin-edited profile: left alone. */
  kept: string[];
  /** Shared vault profiles no longer in the file that will be deactivated (never deleted). */
  retire: string[];
  /** No longer in the file but linked to a product as a persona: kept active unless allowRetireLinked. */
  retireBlocked: { slug: string; products: number }[];
  rows: ReturnType<typeof vaultProfileRow>[];
}

const same = (a: Row, b: ReturnType<typeof vaultProfileRow>) => a.active && a.name === b.name && a.summary === b.summary && a.instructions === b.instructions &&
  (a.external_id ?? null) === b.external_id && JSON.stringify(sortKeys(a.attributes)) === JSON.stringify(sortKeys(JSON.parse(b.attributes)));
const sortKeys = (v: any): any => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);

export async function planProfileSync(db: Q, profiles: VaultProfile[], opts: { allowRetireLinked?: boolean } = {}): Promise<ProfileSyncPlan> {
  const rows = profiles.map((p, i) => vaultProfileRow(p, i));
  const dup = rows.map((r) => r.slug).filter((s, i, all) => all.indexOf(s) !== i);
  if (dup.length) throw new Error(`the file has repeated slugs: ${[...new Set(dup)].join(", ")}`);
  const slugs = rows.map((r) => r.slug);
  const existing = await db.query<Row>(
    `/* platform: shared developer profiles (org_id NULL) and slug collisions */ SELECT dp.id, dp.slug, dp.name, dp.summary, dp.attributes, dp.instructions, dp.external_id,
            dp.active, dp.source, dp.org_id, dp.edited_at, (SELECT count(*)::int FROM product_personas pp WHERE pp.profile_id = dp.id AND pp.active) AS linked
       FROM developer_profiles dp WHERE dp.slug = ANY($1) OR (dp.org_id IS NULL AND dp.source = 'vault' AND dp.active)`, [slugs]);
  const bySlug = new Map(existing.map((r) => [r.slug, r]));
  const plan: ProfileSyncPlan = { inserts: [], updates: [], renames: [], unchanged: 0, kept: [], retire: [], retireBlocked: [], rows };
  for (const r of rows) {
    const old = bySlug.get(r.slug);
    if (!old) plan.inserts.push(r.slug);
    else if (old.org_id != null || old.source !== "vault" || old.edited_at != null) plan.kept.push(r.slug);
    else if (same(old, r)) plan.unchanged++;
    else {
      plan.updates.push(r.slug);
      if (old.name !== r.name) plan.renames.push([r.slug, old.name, r.name]);
    }
  }
  const inFile = new Set(slugs);
  for (const old of existing) {
    if (inFile.has(old.slug) || old.org_id != null || old.source !== "vault" || old.edited_at != null || !old.active) continue;
    if (old.linked && !opts.allowRetireLinked) plan.retireBlocked.push({ slug: old.slug, products: old.linked });
    else plan.retire.push(old.slug);
  }
  return plan;
}

/** Apply a plan in one transaction: the same upsert as syncVault, then the planned retirements only. */
export async function applyProfileSync(db: Db, plan: ProfileSyncPlan): Promise<{ written: number; retired: number }> {
  return db.transaction(async (tx) => {
    let written = 0;
    for (const r of plan.rows) {
      written += (await tx.query(
        `/* platform: shared developer profiles only (org_id NULL, source vault, never admin-edited) */ INSERT INTO developer_profiles (slug, external_id, name, summary, attributes, instructions, source, active, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'vault', true, now())
         ON CONFLICT (slug) DO UPDATE SET external_id = excluded.external_id, name = excluded.name, summary = excluded.summary,
           attributes = excluded.attributes, instructions = excluded.instructions, active = true, synced_at = now()
         WHERE developer_profiles.org_id IS NULL AND developer_profiles.source = 'vault' AND developer_profiles.edited_at IS NULL
         RETURNING 1`, [r.slug, r.external_id, r.name, r.summary, r.attributes, r.instructions])).length;
    }
    const retired = plan.retire.length ? (await tx.query(
      `/* platform: shared developer profiles only */ UPDATE developer_profiles SET active = false
        WHERE slug = ANY($1) AND active AND org_id IS NULL AND source = 'vault' AND edited_at IS NULL RETURNING 1`, [plan.retire])).length : 0;
    return { written, retired };
  });
}
