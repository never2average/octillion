// Re-pick one product's personas without a full research (src/repick.ts): the product's tasks, aliases and competitors
// stay as they are. Requires an explicit DATABASE_URL; never reads .env and never runs migrations.
//   DATABASE_URL=postgres://... npx tsx scripts/repick-personas.ts --product 4 --dry-run
//   DATABASE_URL=postgres://... npx tsx scripts/repick-personas.ts --product 4 \
//     --audience-json '{"scope":"countries","countries":["CA"],"strictness":"exclusive","gates":[...]}' \
//     --not-competitor Slurm=complement
//
// --audience-json <file or inline JSON>  store it as the customer's confirmed audience (final for research)
// --not-competitor <name>[=relation]     record a tool removed from the competitors by hand (repeatable; relation
//                                        complement by default), so no later research adds it back
// --dry-run                              print what would change; write nothing
import { existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const val = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const product = Number(val("--product"));
const audienceArg = val("--audience-json");
const notCompetitors = args.flatMap((a, i) => (a === "--not-competitor" && args[i + 1] ? [args[i + 1]!] : []));
const dryRun = args.includes("--dry-run");
const known = new Set(["--product", "--audience-json", "--not-competitor", "--dry-run"]);
const unknown = args.filter((a, i) => a.startsWith("--") && !known.has(a) && !["--product", "--audience-json", "--not-competitor"].includes(args[i - 1] ?? ""));
if (!Number.isInteger(product) || unknown.length) {
  console.error(`usage: DATABASE_URL=... npx tsx scripts/repick-personas.ts --product <id> [--audience-json <file|json>] [--not-competitor <name>[=relation]] [--dry-run]${unknown.length ? ` (unknown: ${unknown.join(" ")})` : ""}`);
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("Set DATABASE_URL explicitly: this script never falls back to the embedded database or reads .env");
  process.exit(2);
}
let audience: unknown;
if (audienceArg !== undefined) {
  try { audience = JSON.parse(existsSync(audienceArg) ? readFileSync(audienceArg, "utf8") : audienceArg); }
  catch (e) { console.error(`--audience-json: ${(e as Error).message}`); process.exit(2); }
}

const { openDb } = await import("../src/db.js");
const { planRepick, applyRepick } = await import("../src/repick.js");
const { describeAudience } = await import("../src/audience.js");
const db = await openDb();
try {
  const u = new URL(process.env.DATABASE_URL);
  const plan = await planRepick(db, { product, audience, notCompetitors });
  console.log(`${dryRun ? "DRY RUN against" : "Re-picking on"} ${u.hostname}${u.pathname}: #${plan.product.id} ${plan.product.name} (${plan.product.slug})`);
  console.log(`audience: ${plan.audience ? describeAudience(plan.audience) : "not stated"}${plan.audience_changed ? " (set now, as the customer's, confirmed)" : " (unchanged)"}`);
  if (plan.audience_changed) console.log(JSON.stringify(plan.audience, null, 1));
  console.log(`not competitors added: ${plan.not_competitors_added.map((x) => `${x.name} (${x.relation})`).join(", ") || "none"}`);
  if (plan.still_competitors.length) console.log(`still listed as competitors (remove them in the app): ${plan.still_competitors.join(", ")}`);
  console.log(`linked personas kept: ${plan.keep.join(", ") || "none"}`);
  console.log(`linked personas unlinked now (cannot use it):${plan.unlink.length ? "" : " none"}`);
  for (const x of plan.unlink) console.log(`  ${x.slug}: ${x.why.join("; ")}`);
  console.log(`personas-only research to queue (no run): ${JSON.stringify(plan.research_input).slice(0, 400)}`);
  if (dryRun) console.log("dry run: nothing written");
  else console.log(`queued ${await applyRepick(db, plan)}`);
} finally {
  await db.close();
}
