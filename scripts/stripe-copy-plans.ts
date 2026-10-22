/**
 * Copy Octillion's plans from one Stripe account or mode to another, e.g. test mode to live mode before launch.
 * Each active plan (prices with an octillion_ lookup key) is read as its JSON config (billing.ts listPlans) and made
 * again with createPlanFromConfig: product, base price, graduated usage prices and any billing meters the target
 * lacks. Plans whose lookup key already exists in the target are skipped. Dry run unless --apply.
 *
 *   STRIPE_FROM_KEY=sk_test_... STRIPE_TO_KEY=sk_live_... npx tsx scripts/stripe-copy-plans.ts [--apply] [--only <lookup_key>,...]
 *
 * Keys come from the environment only and are never printed. Customers, subscriptions and invoices are not copied.
 */
const from = process.env.STRIPE_FROM_KEY, to = process.env.STRIPE_TO_KEY;
if (!from || !to) { console.error("Set STRIPE_FROM_KEY and STRIPE_TO_KEY."); process.exit(2); }
if (from === to) { console.error("STRIPE_FROM_KEY and STRIPE_TO_KEY are the same key."); process.exit(2); }
const apply = process.argv.includes("--apply");
const onlyArg = process.argv[process.argv.indexOf("--only") + 1];
const only = process.argv.includes("--only") && onlyArg ? new Set(onlyArg.split(",")) : null;
const mode = (k: string) => (/^(sk|rk)_live_/.test(k) ? "live" : /^(sk|rk)_test_/.test(k) ? "test" : "unknown");

const billing = await import("../src/billing.js");
const { parsePlanConfig } = await import("../src/plan-config.js");

process.env.STRIPE_SECRET_KEY = from;
const plans = (await billing.listPlans()).filter((p) => !only || only.has(p.lookup_key));
console.log(`${plans.length} plan(s) in the source (${mode(from)} mode)${only ? ` matching --only` : ""}.`);

process.env.STRIPE_SECRET_KEY = to;
billing.invalidatePlans();
const there = new Set((await billing.listPlans()).map((p) => p.lookup_key));
console.log(`Target is ${mode(to)} mode, with ${there.size} Octillion plan(s). ${apply ? "Applying." : "Dry run (add --apply to create)."}\n`);

let made = 0, skipped = 0, failed = 0;
for (const p of plans) {
  if (there.has(p.lookup_key)) { console.log(`skip  ${p.lookup_key}: already in the target`); skipped++; continue; }
  try {
    const config = parsePlanConfig(p.config);
    const r = await billing.createPlanFromConfig(config, !apply);
    const lines: string[] = ("lines" in r && r.lines) || [];
    console.log(`${apply ? "made " : "would"} ${p.lookup_key} (${p.name})${lines.length ? `\n      ${lines.join("\n      ")}` : ""}`);
    made++;
  } catch (e) {
    console.log(`fail  ${p.lookup_key}: ${(e as Error).message}`);
    failed++;
  }
}
console.log(`\n${apply ? "Made" : "Would make"} ${made}, skipped ${skipped}, failed ${failed}.`);
if (apply && made) console.log("Check them on /admin/finops (Plans), then allow accounts to subscribe.");
process.exit(failed ? 1 : 0);
