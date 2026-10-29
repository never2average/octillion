// Which personas each product runs with, and whether they can use it (src/audience.ts). Read-only by default: it opens
// its own connection in a read-only transaction and never runs migrations (src/db.ts getDb would).
//   DATABASE_URL=... npx tsx scripts/persona-audit.ts                  report (text)
//   DATABASE_URL=... npx tsx scripts/persona-audit.ts --json           the same as JSON
//   DATABASE_URL=... npx tsx scripts/persona-audit.ts --requeue=4,3    OPERATOR ONLY, with approval: queue product
//                                                                      research again for those product ids
// For each product with active personas: each persona's slug, name, country, sector, research_role and a verdict
// against the product's stored audience: ok, violates (fails a hard part: an exclusive market or a required gate), or
// unknown-audience (research has not stated one yet). Facets come from the database, or from the curated vault file
// (vault/curated/profiles.json) when the database has not been synced with them yet. Slugs used by 2+ products are listed.
import pg from "pg";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hardMisses, type Audience } from "../src/audience.js";
import type { Facets } from "../src/facets.js";

const args = process.argv.slice(2);
const requeue = (args.find((a) => a.startsWith("--requeue="))?.split("=")[1] ?? "").split(",").map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x > 0);
const asJson = args.includes("--json");
if (!process.env.DATABASE_URL) { console.error("Set DATABASE_URL"); process.exit(2); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const local = new Map<string, Facets>();
const curated = path.join(ROOT, "vault", "curated", "profiles.json");
if (existsSync(curated)) for (const p of JSON.parse(readFileSync(curated, "utf8"))) if (p?.attributes?.facets) local.set(String(p.slug ?? p.id).toLowerCase(), p.attributes.facets);

export interface AuditRow { product_id: number; product: string; org: string; audience: Audience | null;
  personas: { slug: string; name: string; country: string | null; sector: string | null; research_role: boolean | null; academic_staff: boolean | null; verdict: "ok" | "violates" | "unknown-audience"; why: string[]; facets_from: string }[] }

/** The verdicts (pure): each persona against the product's stored audience. */
export function auditProduct(p: { id: number; name: string; org: string; audience: Audience | null }, personas: { slug: string; name: string; facets: Facets | null }[]): AuditRow {
  return { product_id: p.id, product: p.name, org: p.org, audience: p.audience, personas: personas.map((x) => {
    const f = x.facets ?? local.get(x.slug) ?? null;
    const why = p.audience ? hardMisses(p.audience, f) : [];
    return { slug: x.slug, name: x.name, country: f?.country ?? null, sector: f?.sector ?? null, research_role: f?.research_role ?? null, academic_staff: f?.academic_staff ?? null,
             verdict: !p.audience ? "unknown-audience" : why.length ? "violates" : "ok", why, facets_from: x.facets ? "database" : f ? "vault file" : "none" };
  }) };
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("BEGIN READ ONLY");
  const products = (await client.query(
    `SELECT p.id, p.name, o.slug AS org, p.research->'audience' AS audience FROM products p JOIN organizations o ON o.id = p.org_id
      WHERE EXISTS (SELECT 1 FROM product_personas pp WHERE pp.product_id = p.id AND pp.active)
         OR EXISTS (SELECT 1 FROM developer_profiles dp WHERE dp.product_id = p.id AND dp.active)
      ORDER BY p.id`)).rows;
  const links = (await client.query(
    `SELECT pp.product_id, dp.slug, dp.name, dp.attributes->'facets' AS facets FROM product_personas pp JOIN developer_profiles dp ON dp.id = pp.profile_id WHERE pp.active
     UNION ALL SELECT dp.product_id, dp.slug, dp.name, dp.attributes->'facets' FROM developer_profiles dp WHERE dp.product_id IS NOT NULL AND dp.active
     ORDER BY 1, 2`)).rows;
  await client.query("COMMIT");
  const rows = products.map((p: any) => auditProduct({ id: p.id, name: p.name, org: p.org, audience: p.audience }, links.filter((l: any) => l.product_id === p.id)));
  const uses = new Map<string, string[]>();
  for (const r of rows) for (const x of r.personas) uses.set(x.slug, [...(uses.get(x.slug) ?? []), `${r.product_id} ${r.product}`]);
  const reused = [...uses].filter(([, ps]) => ps.length > 1).map(([slug, ps]) => ({ slug, products: ps }));
  if (asJson) console.log(JSON.stringify({ products: rows, reused }, null, 1));
  else {
    for (const r of rows) {
      const a = r.audience;
      console.log(`\n#${r.product_id} ${r.product} (${r.org}) audience: ${a ? `${a.scope}${a.countries?.length ? ` ${a.countries.join(",")} ${a.strictness ?? "exclusive"}` : ""}` +
        `${(a.gates ?? []).length ? `; gates: ${a.gates!.map((g) => `${g.requirement} [${g.strictness}]`).join("; ")}` : ""}${a.source ? ` (${a.source}${a.confirmed ? ", confirmed" : ""})` : ""}` : "not stated yet"}`);
      for (const x of r.personas)
        console.log(`  ${x.verdict.padEnd(16)} ${x.slug.padEnd(14)} ${x.name.padEnd(12)} ${String(x.country ?? "?").padEnd(3)} ${String(x.sector ?? "?").padEnd(11)} research_role=${x.research_role ?? "?"} academic_staff=${x.academic_staff ?? "?"}` +
          `${x.facets_from === "vault file" ? " (facets from the vault file)" : ""}${x.why.length ? `  <- ${x.why.join("; ")}` : ""}`);
    }
    console.log(`\nPersonas used by 2+ products: ${reused.length ? "" : "none"}`);
    for (const r of reused) console.log(`  ${r.slug}: ${r.products.join(" | ")}`);
  }
  if (requeue.length) {
    // Operator only: research again for these products, with the brief to re-select personas for who may use them.
    for (const id of requeue) {
      const last = (await client.query("SELECT org_id, input FROM product_research WHERE product_id = $1 AND kind = 'product' ORDER BY created_at DESC LIMIT 1", [id])).rows[0];
      if (!last) { console.error(`product ${id}: never researched; onboard it instead`); continue; }
      const rid = `rsh_${randomBytes(9).toString("base64url")}`;
      const prompt = String(last.input?.prompt ?? "").replace(/\n\nRe-select personas:[\s\S]*$/, "") +
        "\n\nRe-select personas: state product.audience from the sign-up and eligibility pages first, then pick only developers who may use the product.";
      await client.query("INSERT INTO product_research (id, org_id, product_id, input, run) VALUES ($1, $2, $3, $4, NULL)", [rid, last.org_id, id, JSON.stringify({ ...last.input, prompt })]);
      console.log(`queued research ${rid} for product ${id}`);
    }
  }
} finally {
  await client.end();
}
