// Who may use a product, against the personas research picks (src/audience.ts), for scripts/smoke.ts: kept out of its
// main body (TypeScript's control-flow limit). Persona search on the survey facets, the checks on picks of a running
// research job, and the audience's life: a customer answer, unlinked personas, a verified gap, no stand-in run.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type Db = { query: <T = any>(sql: string, params?: unknown[]) => Promise<T[]> };
type Worker = (path: string, body: unknown) => Promise<Response>;
type Call = (c: Client, name: string, args?: Record<string, unknown>) => Promise<any>;
type Fails = (c: Client, name: string, args: Record<string, unknown>, re: RegExp) => Promise<void>;

/** src/research.ts libraryProfiles: structured filters on attributes.facets, word scores, true counts, seeded order. */
export async function personaSearchChecks({ db, base, token }: { db: Db; base: string; token: string }) {
  const { libraryProfiles } = await import("../src/research.js");
  const caAcademics = await libraryProfiles({ country: ["CA"], sector: ["academia"], research_role: true, limit: 40 });
  const [{ n: trueCount }] = await db.query<any>(`SELECT count(*) AS n FROM developer_profiles WHERE active AND org_id IS NULL AND attributes->'facets'->>'country' = 'CA'
                                                  AND attributes->'facets'->>'sector' = 'academia' AND attributes->'facets'->>'research_role' = 'true'`);
  assert.ok(caAcademics.profiles.length >= 2 && caAcademics.profiles.every((x: any) => x.attributes.facets.country === "CA" && x.attributes.facets.sector === "academia" && x.attributes.facets.research_role === true),
    "facet filters return only matching profiles");
  assert.equal(caAcademics.matched, Number(trueCount), "matched is the true count");
  const worded = await libraryProfiles({ query: "Canadian academic researcher", limit: 3 });
  assert.ok(worded.matched > 0 && worded.profiles[0].attributes.facets.country === "CA" && worded.profiles[0].attributes.facets.sector === "academia",
    `'Canadian academic researcher' ranks Canadian academics first: ${worded.profiles.map((x: any) => x.slug).join(", ")}`);
  assert.ok(worded.hints.some((h: any) => h.country === "CA"), "a country word comes back as a hint");
  const one = await libraryProfiles({ limit: 1 });
  assert.ok(one.matched > 1 && one.profiles.length === 1 && /showing 1/.test((one as any).note ?? ""), "matched > limit is reported");
  const order = async (seed: string) => (await libraryProfiles({ limit: 40, seed })).profiles.map((x: any) => x.slug).join();
  assert.notEqual(await order("rsh_seed_a"), await order("rsh_seed_b"), "equal scores are ordered by the seed, not by slug");
  assert.equal(await order("rsh_seed_a"), await order("rsh_seed_a"), "the same seed gives the same order");
  await assert.rejects(libraryProfiles({ sector: ["universities"] }), (e: any) => e.status === 400 && /academia/.test(e.message), "an unknown sector is a 400 listing the valid ones");
  await assert.rejects(libraryProfiles({ region: ["mars"] }), (e: any) => e.status === 400 && /north_america/.test(e.message));
  const get = (q: string) => fetch(`${base}/api/worker/library/profiles?${q}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await get("sector=universities")).status, 400, "the worker API answers 400");
  const viaHttp = await (await get("country=CA&country=SE&sector=academia&research_role=true&limit=40")).json();
  assert.ok(viaHttp.profiles.some((x: any) => x.attributes.facets.country === "SE") && viaHttp.profiles.every((x: any) => ["CA", "SE"].includes(x.attributes.facets.country)),
    "repeated params are any-of");
  // A shared profile without a country could be picked for any market: the vault sync refuses it.
  const { syncVault } = await import("../src/vault.js");
  const dir = mkdtempSync(path.join(tmpdir(), "octillion-vault-"));
  writeFileSync(path.join(dir, "profiles.json"), JSON.stringify([{ id: "no-facets", name: "No facets", attributes: { role: "dev" } }]));
  writeFileSync(path.join(dir, "tasks.json"), "[]");
  const was = process.env.VAULT_DIR;
  process.env.VAULT_DIR = dir;
  try { await assert.rejects(syncVault(), /facets\.country/, "the sync refuses a shared profile without a country"); }
  finally { process.env.VAULT_DIR = was; }
  console.log("✓ persona search: facet filters, word scores with country hints, true counts, seeded order, 400 on unknown values; sync needs facets");
}

/** A running research job's picks against an Alliance-like audience (Canadian researchers only, cited). */
export async function pickChecks({ db, worker, rid, good }: { db: Db; worker: Worker; rid: string; good: any }) {
  const iss = async (r: any) => ((await (await worker(`/research/${rid}/validate`, { result: r })).json()).issues ?? []) as string[];
  const SIGNUP = "https://docs.quickqueue.example.com/install";
  const quote = "Accounts are only for researchers at Canadian institutions, sponsored by a faculty member.";
  const caOnly = { scope: "countries", countries: ["CA"], strictness: "exclusive", evidence: [{ url: SIGNUP, quote }], checked: "the install, account and terms pages",
                   gates: [{ id: "affiliation", requirement: "a researcher at a Canadian institution", strictness: "required", match: { sector_any: ["academia"], research_role: true }, evidence: [{ url: SIGNUP, quote }] }] };
  const names: Record<string, string> = Object.fromEntries((await db.query<any>("SELECT slug, name FROM developer_profiles WHERE org_id IS NULL")).map((x: any) => [x.slug, x.name]));
  const al = structuredClone(good);
  al.product.audience = caOnly;
  al.personas = ["example-se-academic-researcher", "example-us-highered-fullstack", "example-ca-industry-fullstack", "example-ca-academic-researcher"].map((slug) => ({ profile_slug: slug, name: names[slug] }));
  const ai = await iss(al);
  const at = (i: number) => ai.filter((x) => x.startsWith(`personas[${i}]`));
  assert.ok(at(0).some((x) => /is in SE; the product serves only CA \(evidence: https:\/\/docs\.quickqueue/.test(x)), `the Swedish academic is rejected: ${ai.join(" | ")}`);
  assert.ok(at(1).some((x) => /research_role false/.test(x)) && at(1).some((x) => /is in US/.test(x)), "the US university web developer is rejected");
  assert.ok(at(2).length === 1 && /sector industry/.test(at(2)[0]!), "the Canadian industry developer fails the gate");
  assert.equal(at(3).length, 0, "the Canadian academic researcher is accepted");
  const uncited = structuredClone(al); uncited.product.audience.evidence = [{ url: "https://made-up.example.net/eligibility", quote }];
  assert.ok((await iss(uncited)).some((x) => /audience restricts users but cites no fetched page/.test(x)), "a restriction must quote a fetched page");
  const nameless = structuredClone(good); nameless.selection.personas[0].candidates[0].reason = "backend role on a matching stack, owns the queue";
  assert.ok((await iss(nameless)).some((x) => /selection\.personas\[0\]\.candidates\[0\]\.reason: say where example-startup-backend is \(US\)/.test(x)), "a reason must name the country");
  // A gap is accepted only when nobody fits: here Canadian researchers do.
  const gapped = structuredClone(al); gapped.personas = []; delete gapped.selection.personas;
  gapped.audience_gap = { searched: ['search_profiles {"country":["CA"],"sector":["academia"],"research_role":true}'], note: "no Canadian researchers in the data" };
  for (const sc of gapped.scenarios) delete sc.variants;
  const gi = await iss(gapped);
  assert.ok(gi.some((x) => /audience_gap: \d+ eligible profiles exist \(e\.g\. .*example-ca-academic-researcher.*\); pick from them/.test(x)) && !gi.some((x) => /give 1-4 personas|selection\.personas/.test(x)),
    `a false gap names the eligible profiles: ${gi.join(" | ")}`);
  console.log("✓ persona picks against the audience: wrong country, failed gate, uncited restriction, reasons name the country, a false gap");
}

/** The audience's life on one product: the customer narrows it, unfit personas are unlinked, a verified gap, no stand-in run. */
export async function audienceLifecycleChecks({ db, worker, call, fails, A, orgId, good }: { db: Db; worker: Worker; call: Call; fails: Fails; A: Client; orgId: number; good: any }) {
  const lab = await call(A, "onboard_product", { name: "GapLab", prompt: "GapLab is a hosted job queue for TypeScript backends with retries and cron.", website_url: "https://quickqueue.example.com" });
  const claimNext = async (want: string) => {
    const c = await (await worker("/research/claim", { worker_id: "smoke-orch", research_id: want })).json();
    assert.ok(c.jobs.some((j: any) => j.research_id === want), `claimed ${want}`);
    // Competitor evidence for this job: the same searches the first job ran.
    await worker(`/research/${want}/search`, { kind: "web", query: "alternatives to GapLab" });
    await worker(`/research/${want}/search`, { kind: "packages", query: "job queue", ecosystem: "npm" });
  };
  const asLab = (r: any) => { const x = structuredClone(r); x.product.name = "GapLab"; x.product.aliases = ["Gap Lab"]; x.product.packages = ["@gaplab/sdk"]; x.product.domains = ["gaplab.example.com"]; return x; };
  await claimNext(lab.research.id);
  const first = await (await worker(`/research/${lab.research.id}/complete`, { status: "completed", result: asLab(good) })).json();
  assert.equal(first.status, "completed", JSON.stringify(first).slice(0, 800));
  const [labRow] = await db.query<any>("SELECT id FROM products WHERE org_id = $1 AND slug = $2", [orgId, first.product]);
  const linksOf = () => db.query<any>("/* tenant: smoke */ SELECT dp.slug, pp.active FROM product_personas pp JOIN developer_profiles dp ON dp.id = pp.profile_id WHERE pp.product_id = $1 ORDER BY dp.slug", [labRow.id]);
  assert.deepEqual((await linksOf()).map((x: any) => [x.slug, x.active]), [["example-enterprise-platform", true], ["example-startup-backend", true]]);
  // Questions about the audience: options carry an audience value, checked like research's (bad ISO2, unknown sector).
  const { askQuestions } = await import("../src/questions.js");
  const bad = await askQuestions(orgId, labRow.id, lab.research.id, [{ kind: "audience", subject: "audience", question: "Who can sign up?",
    options: [{ id: "a", label: "Only Zedland", value: { scope: "countries", countries: ["ZZ"] } },
              { id: "b", label: "Universities", value: { gates: [{ id: "g", requirement: "a university", strictness: "required", match: { sector_any: ["universities"] } }] } }] }]);
  assert.equal(bad, 0, "invalid audience options are refused");
  assert.equal(await askQuestions(orgId, labRow.id, lab.research.id, [{ kind: "audience", subject: "audience", question: "Who can sign up for GapLab?",
    options: [{ id: "a", label: "Only teams in New Zealand", value: { scope: "countries", countries: ["NZ"], strictness: "exclusive" } }, { id: "b", label: "Anyone", value: { scope: "global" } }] }]), 1);
  const aq = (await call(A, "list_product_questions", { product: first.product })).questions.find((q: any) => q.kind === "audience");
  const ans = await call(A, "answer_product_question", { question_id: aq.id, option: "a", note: "we only sell in NZ" });
  assert.ok(/only users in New Zealand/.test(ans.effect) && ans.unlinked.length === 2 && ans.research_id, ans.effect);
  const [afterAnswer] = await db.query<any>("SELECT research FROM products WHERE id = $1", [labRow.id]);
  assert.ok(afterAnswer.research.audience.source === "customer" && afterAnswer.research.audience.confirmed === true && afterAnswer.research.audience.countries[0] === "NZ",
    "the answer is the confirmed audience");
  assert.ok((await linksOf()).every((x: any) => !x.active), "personas who cannot use it are unlinked (kept, inactive)");
  const [queued] = await db.query<any>("SELECT status, input FROM product_research WHERE id = $1", [ans.research_id]);
  assert.ok(queued.status === "queued" && /The customer confirmed who can use the product/.test(queued.input.prompt), "research runs again with the confirmed audience in its brief");
  await fails(A, "run_simulation", { product: first.product, samples: 1 }, /No eligible personas for this product's audience yet/);
  // The re-research finds nobody in New Zealand: a verified gap, no personas, a question about supply.
  await claimNext(ans.research_id);
  const gap = asLab(good);
  gap.personas = []; delete gap.selection.personas;
  gap.audience_gap = { searched: ['search_profiles {"country":["NZ"]}', 'search_profiles {"region":["oceania"]}'], note: "nobody in the developer data is in New Zealand" };
  const gapDone = await (await worker(`/research/${ans.research_id}/complete`, { status: "completed", result: gap })).json();
  assert.equal(gapDone.status, "completed", JSON.stringify(gapDone).slice(0, 800));
  assert.deepEqual(gapDone.personas, []);
  const [gapRow] = await db.query<any>("SELECT research FROM products WHERE id = $1", [labRow.id]);
  assert.ok(gapRow.research.audience_gap?.searched.length === 2 && gapRow.research.audience.countries[0] === "NZ", "the gap is stored; the customer's audience stays");
  assert.equal((await linksOf()).length, 2, "old links are kept, never deleted");
  const supply = (await call(A, "list_product_questions", { product: first.product })).questions.find((q: any) => q.subject === "persona_supply");
  assert.ok(supply && supply.kind === "audience" && supply.status === "open" && supply.options.length >= 2, "an open persona_supply question");
  await fails(A, "run_simulation", { product: first.product, samples: 1 }, /No eligible personas/);
  console.log("✓ audience: customer answer narrows it and unlinks unfit personas, re-research, verified gap with a question, no stand-in run");
}
