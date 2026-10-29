// The operator scripts on an embedded Postgres. Profile sync (src/profile-sync.ts, scripts/sync-profiles.ts): plans
// inserts, updates, renames and retirements; keeps profiles linked to a product, private or admin-edited ones, and
// library tasks. Persona re-pick (src/repick.ts, scripts/repick-personas.ts): stores a confirmed audience, records
// hand-removed competitors, unlinks ineligible personas and queues a personas-only research with no run. Both scripts
// refuse to run without an explicit DATABASE_URL.
//   npx tsx scripts/operator-scripts-test.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let n = 0;
const check = async (name: string, fn: () => Promise<void>) => { await fn(); n++; console.log(`✓ ${name}`); };

const script = path.join(import.meta.dirname, "sync-profiles.ts"), repickScript = path.join(import.meta.dirname, "repick-personas.ts");
await check("the scripts need an explicit DATABASE_URL and never fall back to the embedded database", async () => {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  const run = (args: string[], e = env) => spawnSync(process.execPath, ["--import", "tsx", ...args], { env: e, encoding: "utf8", cwd: path.join(import.meta.dirname, "..") });
  for (const args of [[script, "vault/example", "--dry-run"], [repickScript, "--product", "4", "--dry-run"]]) {
    const r = run(args);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /Set DATABASE_URL explicitly/);
  }
  const dbEnv = { ...env, DATABASE_URL: "postgres://x@127.0.0.1:1/none" };
  assert.equal(run([script, "vault/example", "--retire-all"], dbEnv).status, 2, "an unknown flag is refused before connecting");
  assert.equal(run([repickScript, "--product", "4", "--requeue"], dbEnv).status, 2);
  assert.equal(run([repickScript, "--product", "4", "--audience-json", "{not json"], dbEnv).status, 2, "bad JSON is refused before connecting");
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

await check("re-pick: a confirmed audience, a hand-removed competitor recorded, ineligible personas unlinked, a personas-only job with no run", async () => {
  const { planRepick, applyRepick } = await import("../src/repick.js");
  const [org] = await db.query<any>("INSERT INTO organizations (slug, name) VALUES ('tanmay', 'Tanmay') RETURNING id");
  const [prod] = await db.query<any>(`INSERT INTO products (org_id, slug, name, aliases, competitors, research) VALUES ($1, 'drac', 'Digital Research Alliance of Canada', '{Alliance,"Compute Canada"}', $2, $3) RETURNING id`,
    [org.id, JSON.stringify([{ name: "Slurm" }, { name: "Rescale" }]), JSON.stringify({ audience: { scope: "global", checked: "x".repeat(30) }, sources: [{ url: "https://alliancecan.ca" }] })]);
  await db.query(`INSERT INTO product_personas (product_id, profile_id) SELECT $1, id FROM developer_profiles WHERE slug IN ('example-se-academic-researcher', 'example-ca-academic-researcher')`, [prod.id]);
  await db.query("INSERT INTO product_research (id, org_id, product_id, input, status) VALUES ('rsh_old', $1, $2, $3, 'completed')",
    [org.id, prod.id, JSON.stringify({ name: "Digital Research Alliance of Canada", prompt: "National research computing for Canadian researchers.", website_url: "https://alliancecan.ca" })]);
  const audience = { scope: "countries", countries: ["CA"], strictness: "exclusive", gates: [{ id: "affiliation", strictness: "required",
    requirement: "a researcher or academic research staff at a Canadian institution", match: { sector_any: ["academia"], role_any: ["research_role", "academic_staff"] } }] };
  await assert.rejects(planRepick(db, { product: prod.id, audience: { scope: "countries", countries: ["Canada"] } }), /unknown ISO2/);
  await assert.rejects(planRepick(db, { product: prod.id, notCompetitors: ["Slurm=friend"] }), /relation|substitute/);
  const plan = await planRepick(db, { product: prod.id, audience, notCompetitors: ["Slurm"] });
  assert.ok(plan.audience_changed && plan.audience!.source === "customer" && plan.audience!.confirmed === true && plan.audience!.countries![0] === "CA");
  assert.deepEqual(plan.not_competitors_added.map((x) => [x.name, x.relation]), [["Slurm", "complement"]]);
  assert.deepEqual(plan.still_competitors, ["Slurm"], "still listed: the operator is told");
  assert.deepEqual(plan.unlink.map((x) => x.slug), ["example-se-academic-researcher"]);
  assert.deepEqual(plan.keep, ["example-ca-academic-researcher"]);
  assert.ok(plan.research_input.personas_only === true && /National research computing/.test(String(plan.research_input.prompt)));
  const unchanged = await db.query<any>("SELECT research FROM products WHERE id = $1", [prod.id]);
  assert.equal(unchanged[0].research.audience.scope, "global", "planning (the dry run) writes nothing");
  const rid = await applyRepick(db, plan);
  const [after] = await db.query<any>("SELECT research, competitors, aliases FROM products WHERE id = $1", [prod.id]);
  assert.ok(after.research.audience.confirmed === true && after.research.not_competitors[0].name === "Slurm" && after.research.sources.length === 1, "audience and not_competitors stored, the rest kept");
  assert.deepEqual(after.aliases, ["Alliance", "Compute Canada"]);
  const [job] = await db.query<any>("SELECT status, input, run FROM product_research WHERE id = $1", [rid]);
  assert.ok(job.status === "queued" && job.input.personas_only === true && job.run === null, "a personas-only job, no run");
  const active = await db.query<any>("SELECT dp.slug FROM product_personas pp JOIN developer_profiles dp ON dp.id = pp.profile_id WHERE pp.product_id = $1 AND pp.active", [prod.id]);
  assert.deepEqual(active.map((x: any) => x.slug), ["example-ca-academic-researcher"]);
  const again = await planRepick(db, { product: prod.id, notCompetitors: ["slurm"] });
  assert.ok(!again.audience_changed && !again.not_competitors_added.length && again.audience!.confirmed === true, "re-running adds nothing twice");
});

await db.close();
console.log(`operator scripts test passed (${n} cases)`);
