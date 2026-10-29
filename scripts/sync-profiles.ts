// Sync ONLY the shared developer profiles from a vault directory into the database DATABASE_URL names (src/profile-sync.ts).
//   DATABASE_URL=postgres://... npx tsx scripts/sync-profiles.ts vault/curated --dry-run    # counts and name changes; writes nothing
//   DATABASE_URL=postgres://... npx tsx scripts/sync-profiles.ts vault/curated              # apply
//   ... --allow-retire     also deactivate profiles no longer in the file that a product still links as a persona
//
// The safe way to update production's profiles: unlike `npm run vault:sync` it never reads .env, VAULT_URL or VAULT_DIR
// (VAULT_URL wins over VAULT_DIR there), never touches library tasks, never runs migrations, and keeps linked personas.
// DATABASE_URL must be set explicitly on the command line or in the environment; there is no embedded-database fallback.
import { readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run"), allowRetire = args.includes("--allow-retire");
const unknown = args.filter((a) => a.startsWith("--") && !["--dry-run", "--allow-retire"].includes(a));
if (!dir || unknown.length) {
  console.error(`usage: DATABASE_URL=... npx tsx scripts/sync-profiles.ts <vault dir> [--dry-run] [--allow-retire]${unknown.length ? ` (unknown: ${unknown.join(" ")})` : ""}`);
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("Set DATABASE_URL explicitly: this script never falls back to the embedded database or reads .env");
  process.exit(2);
}
const file = ["profiles.json", "profiles.jsonl"].map((f) => path.join(dir, f)).find((f) => { try { readFileSync(f); return true; } catch { return false; } });
if (!file) { console.error(`${dir} has no profiles.json or profiles.jsonl`); process.exit(2); }
const text = readFileSync(file, "utf8");
const profiles = file.endsWith(".jsonl") ? text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : JSON.parse(text);

const { openDb } = await import("../src/db.js");
const { planProfileSync, applyProfileSync } = await import("../src/profile-sync.js");
const db = await openDb();
try {
  // Only the host and database, never the credentials.
  const u = new URL(process.env.DATABASE_URL);
  console.log(`${dryRun ? "DRY RUN against" : "Syncing into"} ${u.hostname}${u.pathname}: ${profiles.length} profiles from ${file}`);
  const plan = await planProfileSync(db, profiles, { allowRetireLinked: allowRetire });
  console.log(`inserts ${plan.inserts.length}, updates ${plan.updates.length} (renames ${plan.renames.length}), unchanged ${plan.unchanged}, ` +
    `kept (private or admin-edited) ${plan.kept.length}, retirements ${plan.retire.length}, linked and kept ${plan.retireBlocked.length}`);
  const show = (title: string, xs: string[]) => xs.length && console.log(`${title}:\n${xs.map((x) => `  ${x}`).join("\n")}`);
  show("insert", plan.inserts);
  show("rename", plan.renames.map(([slug, from, to]) => `${slug}: ${from} -> ${to}`));
  show("update", plan.updates.filter((s) => !plan.renames.some(([r]) => r === s)));
  show("kept (not written)", plan.kept);
  show("retire (deactivated, never deleted)", plan.retire);
  show("not in the file but linked to a product, kept active (--allow-retire to deactivate)", plan.retireBlocked.map((x) => `${x.slug} (${x.products} product${x.products === 1 ? "" : "s"})`));
  if (dryRun) console.log("dry run: nothing written");
  else {
    const r = await applyProfileSync(db, plan);
    console.log(`done: ${r.written} written, ${r.retired} retired`);
  }
} finally {
  await db.close();
}
