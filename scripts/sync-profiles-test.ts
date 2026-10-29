// The operator's profile sync (src/profile-sync.ts, scripts/sync-profiles.ts) on an embedded Postgres: it plans inserts,
// updates, renames and retirements; it keeps profiles linked to a product, private or admin-edited ones, and library
// tasks; and the script refuses to run without an explicit DATABASE_URL.
//   npx tsx scripts/sync-profiles-test.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let n = 0;
const check = async (name: string, fn: () => Promise<void>) => { await fn(); n++; console.log(`✓ ${name}`); };

const script = path.join(import.meta.dirname, "sync-profiles.ts");
await check("the script needs an explicit DATABASE_URL and never falls back to the embedded database", async () => {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  const r = spawnSync(process.execPath, ["--import", "tsx", script, "vault/example", "--dry-run"], { env, encoding: "utf8", cwd: path.join(import.meta.dirname, "..") });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /Set DATABASE_URL explicitly/);
  const bad = spawnSync(process.execPath, ["--import", "tsx", script, "vault/example", "--retire-all"], { env: { ...env, DATABASE_URL: "postgres://x@127.0.0.1:1/none" }, encoding: "utf8" });
  assert.equal(bad.status, 2, "an unknown flag is refused before connecting");
});

process.env.PGLITE_DIR = mkdtempSync(path.join(tmpdir(), "octillion-sync-profiles-"));
delete process.env.DATABASE_URL;
const { openDb } = await import("../src/db.js");
const { runMigrations } = await import("../src/migrate.js");
const { planProfileSync, applyProfileSync } = await import("../src/profile-sync.js");
const db = await openDb();
await runMigrations(db);
const example: any[] = JSON.parse(readFileSync(new URL("../vault/example/profiles.json", import.meta.url), "utf8"));

await check("a first sync inserts every profile; a second changes nothing", async () => {
  const plan = await planProfileSync(db, example);
  assert.equal(plan.inserts.length, example.length);
  assert.deepEqual((await applyProfileSync(db, plan)), { written: example.length, retired: 0 });
  const again = await planProfileSync(db, example);
  assert.deepEqual([again.inserts.length, again.updates.length, again.unchanged, again.retire.length], [0, 0, example.length, 0]);
});

await check("renames, updates and retirements are planned and shown; linked, admin-edited and library rows are kept", async () => {
  const [org] = await db.query<any>("INSERT INTO organizations (slug, name) VALUES ('acme', 'Acme') RETURNING id");
  const [prod] = await db.query<any>("INSERT INTO products (org_id, slug, name) VALUES ($1, 'q', 'Q') RETURNING id", [org.id]);
  await db.query("INSERT INTO product_personas (product_id, profile_id) SELECT $1, id FROM developer_profiles WHERE slug = 'example-startup-backend'", [prod.id]);
  await db.query("UPDATE developer_profiles SET edited_at = now() WHERE slug = 'example-enterprise-platform'");
  await db.query("INSERT INTO library_tasks (slug, title, prompt, source) VALUES ('t-1', 'T', 'a task prompt', 'vault')");
  const next = structuredClone(example).filter((p: any) => !["example-startup-backend", "example-solo-indie"].includes(p.id));
  next.find((p: any) => p.id === "example-agency-frontend").name = "Agency developer (renamed)";
  next.find((p: any) => p.id === "example-enterprise-platform").summary = "an admin edited this one";
  next.find((p: any) => p.id === "example-ca-phd-student").attributes.facets.research_role = false;
  next.push({ ...structuredClone(example[0]), id: "example-new-one", name: "New one (example)" });
  const plan = await planProfileSync(db, next);
  assert.deepEqual(plan.inserts, ["example-new-one"]);
  assert.deepEqual(plan.renames, [["example-agency-frontend", example.find((p) => p.id === "example-agency-frontend").name, "Agency developer (renamed)"]]);
  assert.deepEqual([...plan.updates].sort(), ["example-agency-frontend", "example-ca-phd-student"]);
  assert.deepEqual(plan.kept, ["example-enterprise-platform"], "admin-edited: never written");
  assert.deepEqual(plan.retire, ["example-solo-indie"]);
  assert.deepEqual(plan.retireBlocked, [{ slug: "example-startup-backend", products: 1 }], "linked to a product: kept");
  const tasksBefore = await db.query<any>("SELECT slug, active, synced_at FROM library_tasks ORDER BY slug");
  assert.deepEqual(await applyProfileSync(db, plan), { written: next.length - 1, retired: 1 });
  const active = async (slug: string) => (await db.query<any>("SELECT active FROM developer_profiles WHERE slug = $1", [slug]))[0]?.active;
  assert.equal(await active("example-startup-backend"), true, "the linked persona stays active");
  assert.equal(await active("example-solo-indie"), false, "an unlinked one no longer in the file is retired (kept, inactive)");
  assert.equal((await db.query<any>("SELECT summary FROM developer_profiles WHERE slug = 'example-enterprise-platform'"))[0].summary !== "an admin edited this one", true);
  assert.deepEqual(await db.query<any>("SELECT slug, active, synced_at FROM library_tasks ORDER BY slug"), tasksBefore, "library tasks untouched");
  const forced = await planProfileSync(db, next, { allowRetireLinked: true });
  assert.deepEqual([forced.retire, forced.retireBlocked], [["example-startup-backend"], []], "--allow-retire");
});

await check("a profile without a survey country or a repeated slug is refused before anything is written", async () => {
  await assert.rejects(planProfileSync(db, [{ id: "x", name: "X", attributes: {} }]), /facets\.country/);
  await assert.rejects(planProfileSync(db, [example[0], example[0]]), /repeated slugs: example-solo-indie/);
});

await db.close();
console.log(`sync-profiles test passed (${n} cases)`);
