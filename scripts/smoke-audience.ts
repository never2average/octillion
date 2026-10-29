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
  // research_role is research-affiliated: the Canadian student who works at a software company is academia, not a researcher.
  assert.ok(!caAcademics.profiles.some((x: any) => x.slug === "example-ca-student-at-software-company"), "a student working at a company is no researcher");
  const staffOrResearch = await libraryProfiles({ country: ["CA"], role_any: ["research_role", "academic_staff"], limit: 40 });
  assert.ok(staffOrResearch.profiles.some((x: any) => x.slug === "example-ca-research-software-engineer") && staffOrResearch.profiles.some((x: any) => x.slug === "example-ca-academic-researcher") &&
    staffOrResearch.profiles.every((x: any) => x.attributes.facets.research_role === true || x.attributes.facets.academic_staff === true), "role_any: researchers or academic staff");
  await assert.rejects(libraryProfiles({ role_any: ["student"] }), (e: any) => e.status === 400 && /academic_staff/.test(e.message));
  const staffHttp = await (await get("country=CA&academic_staff=true&limit=40")).json();
  assert.ok(staffHttp.profiles.length >= 1 && staffHttp.profiles.every((x: any) => x.attributes.facets.academic_staff === true), "academic_staff over the worker API");
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
  // The quoted page as fetch_url read it (the orchestrator posts every page): only then does the restriction stand.
  assert.ok((await iss(al)).some((x) => /was never fetched by this job/.test(x)), "the page was not fetched yet");
  assert.equal((await worker(`/research/${rid}/page`, { url: "not a url", text: "x" })).status, 400);
  assert.equal((await worker(`/research/${rid}/page`, { url: SIGNUP, text: `Install\n\n${quote}\n\nThen run the worker.` })).status, 200);
  assert.ok(!(await iss(al)).some((x) => /audience restricts users/.test(x)), "quoted on a page the job fetched");
  const reworded = structuredClone(al); reworded.product.audience.evidence = [{ url: SIGNUP, quote: "Only Canadian researchers with a faculty sponsor may have accounts." }];
  assert.ok((await iss(reworded)).some((x) => /the quote is not on .* as this job fetched it/.test(x)), "a paraphrase is not a quote");
  // A restricted audience with 4+ eligible profiles needs at least 3 personas.
  const wide = structuredClone(good); wide.product.audience = { ...caOnly, countries: ["US", "DE", "GB", "CA"], gates: [] };
  assert.ok((await iss(wide)).some((x) => /may use this product: pick at least 3 personas, different in role, seniority and education/.test(x)), "two personas for a wide restricted audience");
  // One entry per page; past the cap the server says so (409) instead of dropping the page silently.
  const { recordFetchedPage } = await import("../src/research.js");
  for (let i = 0; i < 199; i++) await recordFetchedPage(rid, { url: `https://docs.quickqueue.example.com/p/${i}`, text: "page" });
  await assert.rejects(recordFetchedPage(rid, { url: "https://docs.quickqueue.example.com/p/over", text: "page" }), (e: any) => e.status === 409 && /page limit reached/.test(e.message));
  await recordFetchedPage(rid, { url: `${SIGNUP}/`, text: `Install\n\n${quote}` });
  assert.ok(!(await iss(al)).some((x) => /audience restricts users/.test(x)), "a page fetched again replaces its entry, even at the cap");
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
    const job = c.jobs.find((j: any) => j.research_id === want);
    assert.ok(job, `claimed ${want}`);
    // Competitor evidence for this job: the same searches the first job ran.
    await worker(`/research/${want}/search`, { kind: "web", query: "alternatives to GapLab" });
    await worker(`/research/${want}/search`, { kind: "packages", query: "job queue", ecosystem: "npm" });
    return job;
  };
  const asLab = (r: any) => { const x = structuredClone(r); x.product.name = "GapLab"; x.product.aliases = ["Gap Lab"]; x.product.packages = ["@gaplab/sdk"]; x.product.domains = ["gaplab.example.com"]; return x; };
  // A tool removed by hand before (an operator's --not-competitor): research is told, and never brings it back.
  const [{ product_id: labId }] = await db.query<any>("SELECT product_id FROM product_research WHERE id = $1", [lab.research.id]);
  await db.query("UPDATE products SET research = $2 WHERE id = $1", [labId, JSON.stringify({ not_competitors: [{ name: "Inngest", relation: "complement", reason: "removed by hand" }] })]);
  const labJob = await claimNext(lab.research.id);
  assert.deepEqual(labJob.input.not_competitors, ["Inngest"], "the claimed job carries the stored not-competitors");
  const first = await (await worker(`/research/${lab.research.id}/complete`, { status: "completed", result: asLab(good) })).json();
  assert.equal(first.status, "completed", JSON.stringify(first).slice(0, 800));
  const [labRow] = await db.query<any>("SELECT id, competitors, research FROM products WHERE org_id = $1 AND slug = $2", [orgId, first.product]);
  assert.ok(!labRow.competitors.some((c: any) => c.name === "Inngest") && labRow.research.not_competitors.some((x: any) => x.name === "Inngest"),
    "research listed it again; it is dropped and stays recorded as not competing");
  // The customer lists it again (by hand): it is no longer "not competing", so the next research keeps it. Answering a
  // competitor question "substitute" does the same.
  await call(A, "save_product", { product: first.product, competitors: [...labRow.competitors, { name: "Inngest", packages: ["inngest"] }] });
  const [readded] = await db.query<any>("SELECT competitors, research FROM products WHERE id = $1", [labRow.id]);
  assert.ok(readded.competitors.some((c: any) => c.name === "Inngest") && !(readded.research.not_competitors ?? []).some((x: any) => x.name === "Inngest"),
    "a competitor added back by the customer is off the not-competing list");
  await db.query("UPDATE products SET research = jsonb_set(research, '{not_competitors}', $2::jsonb) WHERE id = $1",
    [labRow.id, JSON.stringify([{ name: "BullMQ", relation: "complement", reason: "the review" }])]);
  const { askQuestions: ask } = await import("../src/questions.js");
  assert.equal(await ask(orgId, labRow.id, lab.research.id, [{ kind: "competitor_relation", subject: "BullMQ", question: "Does BullMQ compete with GapLab?",
    options: [{ id: "a", label: "Instead of GapLab", relation: "substitute" }, { id: "b", label: "Alongside it", relation: "complement" }] }]), 1);
  const cq = (await call(A, "list_product_questions", { product: first.product })).questions.find((q: any) => q.subject === "BullMQ");
  await call(A, "answer_product_question", { question_id: cq.id, option: "a" });
  const [subst] = await db.query<any>("SELECT research FROM products WHERE id = $1", [labRow.id]);
  assert.ok(!(subst.research.not_competitors ?? []).some((x: any) => x.name === "BullMQ") && subst.research.audience, "a substitute answer takes it off the list; other keys kept");
  const linksOf = () => db.query<any>("/* tenant: smoke */ SELECT dp.slug, pp.active FROM product_personas pp JOIN developer_profiles dp ON dp.id = pp.profile_id WHERE pp.product_id = $1 ORDER BY dp.slug", [labRow.id]);
  assert.deepEqual((await linksOf()).map((x: any) => [x.slug, x.active]), [["example-enterprise-platform", true], ["example-startup-backend", true]]);
  await reportAndRunChecks({ db, call, fails, A, product: first.product, productId: labRow.id });
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
  assert.ok(queued.status === "queued" && queued.input.personas_only === true && queued.input.audience === undefined,
    "research runs again, personas only; the confirmed audience is read from the product at claim, never carried in the input");
  const before = await productState(db, labRow.id);
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
  assert.deepEqual(await productState(db, labRow.id), before, "a personas-only research leaves the profile, competitors, sources and tasks as they were");
  const supply = (await call(A, "list_product_questions", { product: first.product })).questions.find((q: any) => q.subject === "persona_supply");
  assert.ok(supply && supply.kind === "audience" && supply.status === "open" && supply.options.length >= 2, "an open persona_supply question");
  await fails(A, "run_simulation", { product: first.product, samples: 1 }, /No eligible personas/);
  // A new gap question about another audience replaces the open one: an answer never merges an audience since changed.
  const { personaSupplyQuestion } = await import("../src/audience.js");
  const au = { scope: "countries" as const, countries: ["AU"], strictness: "exclusive" as const, gates: [], checked: "the sign-up and terms pages say Australia only" };
  const auGap = { searched: ['search_profiles {"country":["AU"]}'], note: "nobody in the developer data is in Australia" };
  assert.equal(await askQuestions(orgId, labRow.id, ans.research_id, [personaSupplyQuestion(au, auGap)]), 1);
  const openSupply = (await call(A, "list_product_questions", { product: first.product })).questions.filter((q: any) => q.subject === "persona_supply");
  assert.ok(openSupply.length === 1 && openSupply[0].id !== supply.id && openSupply[0].context.audience.countries[0] === "AU", "the open question is about the new audience");
  assert.equal((await db.query<any>("SELECT status FROM product_questions WHERE id = $1", [supply.id]))[0].status, "dismissed", "the old one is dismissed");
  await fails(A, "answer_product_question", { question_id: supply.id, option: "a" }, /replaced by a newer one/);
  assert.equal(await askQuestions(orgId, labRow.id, ans.research_id, [personaSupplyQuestion(au, auGap)]), 0, "the same question again keeps the open one");
  // Confirming a gap for the audience in force does not queue research again, even when the stored audience leaves its
  // strictness unset (exclusive by default) and the answer spells it out.
  const [labNow] = await db.query<any>("SELECT research FROM products WHERE id = $1", [labRow.id]);
  assert.equal(await askQuestions(orgId, labRow.id, ans.research_id, [personaSupplyQuestion(labNow.research.audience, gap.audience_gap)]), 1);
  await db.query("UPDATE products SET research = research #- '{audience,strictness}' WHERE id = $1", [labRow.id]);
  const nzSupply = (await call(A, "list_product_questions", { product: first.product })).questions.find((q: any) => q.subject === "persona_supply");
  assert.equal(nzSupply.context.audience.countries[0], "NZ");
  const confirmed = await call(A, "answer_product_question", { question_id: nzSupply.id, option: "a" });
  assert.ok(confirmed.research_id === null && /No developer profile in the data fits yet/.test(confirmed.effect), `confirming the gap does not loop: ${JSON.stringify(confirmed).slice(0, 300)}`);
  console.log("✓ audience: customer answer narrows it and unlinks unfit personas, re-research, verified gap with a question, no stand-in run, stale questions replaced, no confirmation loop");
  await personasOnlyChecks({ db, worker, call, A, orgId, productId: labRow.id, product: first.product, good });
}

/**
 * Reports and runs on a product against its audience (src/queries.ts getReport, runSimulation): a global audience never
 * splits the figures, explicitly named personas stay in; a restricted one leaves out (and lists) only sessions whose
 * persona cannot use the product, and refuses a run naming such personas or a generic developer.
 */
async function reportAndRunChecks({ db, call, fails, A, product, productId }: { db: Db; call: Call; fails: Fails; A: Client; product: string; productId: number }) {
  const named = ["example-startup-backend", "example-enterprise-platform", "example-ca-academic-researcher"];
  const run = await call(A, "run_simulation", { product, samples: 1, profiles: named });
  await db.query("/* tenant: smoke fixture */ UPDATE agent_sessions SET status = 'completed', verdict = 'recommended', ended_at = now() WHERE simulation_id = $1", [run.simulation.id]);
  await db.query("UPDATE simulations SET status = 'completed', finished_at = now() WHERE id = $1", [run.simulation.id]);
  const by = await db.query<any>(`/* tenant: smoke */ SELECT dp.slug, count(*)::int AS n FROM agent_sessions s JOIN developer_profiles dp ON dp.id = s.profile_id
                                   WHERE s.simulation_id = $1 GROUP BY dp.slug`, [run.simulation.id]);
  const n = (slug: string) => by.find((x: any) => x.slug === slug)?.n ?? 0;
  const all = by.reduce((t: number, x: any) => t + x.n, 0);
  assert.ok(named.every((x) => n(x) > 0), `a session per named persona: ${JSON.stringify(by)}`);
  const wide = await call(A, "get_visibility_report", { product, days: 7 });
  assert.ok(wide.totals.sessions === all && !wide.ineligible_personas, `global audience: every session counts, explicitly named personas too (${wide.totals.sessions} of ${all})`);
  const [{ research: was }] = await db.query<any>("SELECT research FROM products WHERE id = $1", [productId]);
  const quote = "Accounts are only for researchers at Canadian institutions, sponsored by a faculty member.";
  const caOnly = { scope: "countries", countries: ["CA"], strictness: "exclusive", evidence: [{ url: "https://quickqueue.example.com/accounts", quote }], checked: "the account, eligibility and terms pages",
                   gates: [{ id: "affiliation", requirement: "a researcher at a Canadian institution", strictness: "required", match: { sector_any: ["academia"], research_role: true } }] };
  await db.query("UPDATE products SET research = jsonb_set(research, '{audience}', $2::jsonb) WHERE id = $1", [productId, JSON.stringify(caOnly)]);
  try {
    const narrow = await call(A, "get_visibility_report", { product, days: 7 });
    assert.equal(narrow.totals.sessions, n("example-ca-academic-researcher"), "only the persona who can use it stays in, though it was never linked");
    assert.equal(narrow.ineligible_personas?.sessions, n("example-startup-backend") + n("example-enterprise-platform"));
    assert.deepEqual([...narrow.ineligible_personas.personas].sort(), ["example-enterprise-platform", "example-startup-backend"]);
    assert.match(narrow.ineligible_personas.label, /cannot use the product as its audience now reads \(only users in Canada/);
    await fails(A, "run_simulation", { product, samples: 1, profiles: ["example-startup-backend", "example-ca-academic-researcher"] },
      /cannot use GapLab .*example-startup-backend is in US; the product serves only CA/);
    await fails(A, "run_simulation", { product, samples: 1, profiles: [] }, /a generic developer \(profiles: \[\]\) has no country/);
    // The linked personas (US, DE) cannot use it now: a default run leaves them out, and with nobody left it refuses.
    await fails(A, "run_simulation", { product, samples: 1 }, /No eligible personas.*linked but ineligible now: example-(enterprise-platform|startup-backend), example-(enterprise-platform|startup-backend)/);
  } finally {
    await db.query("UPDATE products SET research = $2 WHERE id = $1", [productId, JSON.stringify(was)]);
  }
  console.log("✓ reports and runs against the audience: global never split, ineligible personas left out by name, ineligible runs refused");
}

/** What a personas-only research must leave alone: the product's profile, competitors, sources and active tasks. */
async function productState(db: Db, productId: number) {
  const [p] = await db.query<any>("SELECT name, description, aliases, packages, domains, competitors, features, research->'sources' AS sources, research->'placement' AS placement FROM products WHERE id = $1", [productId]);
  const tasks = await db.query<any>("/* tenant: smoke */ SELECT id FROM scenarios WHERE product_id = $1 AND active ORDER BY id", [productId]);
  return { ...p, tasks: tasks.map((x: any) => x.id) };
}

/**
 * Personas only (src/research.ts completePersonasOnly): with a customer-confirmed audience, the claimed job carries it
 * as final and the stored profile; completing swaps the persona links, drops prompt variants of personas no longer
 * linked and changes nothing else.
 */
async function personasOnlyChecks({ db, worker, call, A, orgId, productId, product, good }: { db: Db; worker: Worker; call: Call; A: Client; orgId: number; productId: number; product: string; good: any }) {
  const { queuePersonasResearch, askQuestions } = await import("../src/questions.js");
  const claim = async (rid: string) => (await (await worker("/research/claim", { worker_id: "smoke-orch", research_id: rid })).json()).jobs.find((j: any) => j.research_id === rid);
  const [task] = await db.query<any>("/* tenant: smoke */ SELECT id FROM scenarios WHERE product_id = $1 AND active ORDER BY id LIMIT 1", [productId]);
  const variant = "Our Express API sends webhooks inline and loses them when an endpoint is down; make delivery reliable with retries.";
  await db.query("/* tenant: smoke */ UPDATE scenarios SET prompt_variants = $2 WHERE id = $1",
    [task.id, JSON.stringify({ "example-startup-backend": variant, "example-enterprise-platform": variant })]);
  const openSupply = async () => (await db.query<any>("SELECT count(*)::int AS n FROM product_questions WHERE product_id = $1 AND subject = 'persona_supply' AND status = 'open'", [productId]))[0].n;
  // The customer confirmed the New Zealand gap (answered above): the same gap found again is not asked about again,
  // and a gap (no personas) keeps every task's prompt variants.
  const gapRid = await queuePersonasResearch(orgId, productId, { prompt: "GapLab is a hosted job queue." });
  assert.equal((await claim(gapRid)).input.confirmed_audience?.countries?.[0], "NZ");
  const gapResult = { product: {}, personas: [], audience_gap: { searched: ['search_profiles {"country":["NZ"]}'], note: "still nobody in the developer data is in New Zealand" } };
  const gapDone = await (await worker(`/research/${gapRid}/complete`, { status: "completed", result: gapResult })).json();
  assert.equal(gapDone.status, "completed", JSON.stringify(gapDone).slice(0, 400));
  assert.equal(await openSupply(), 0, "no persona_supply question again for an audience the customer already answered");
  assert.deepEqual(Object.keys((await db.query<any>("/* tenant: smoke */ SELECT prompt_variants FROM scenarios WHERE id = $1", [task.id]))[0].prompt_variants).sort(),
    ["example-enterprise-platform", "example-startup-backend"], "a gap keeps the variants");
  // A personas-only result's audience is never the customer's unless the stored one is: claiming source "customer"
  // and confirmed: true on an uncited restriction is refused, and the model's own audience_check dismisses nothing.
  const research = { scope: "global", checked: "the sign-up and terms pages say anyone may sign up", source: "research" };
  await db.query("UPDATE products SET research = jsonb_set(research, '{audience}', $2::jsonb) - 'audience_gap' WHERE id = $1", [productId, JSON.stringify(research)]);
  assert.equal(await askQuestions(orgId, productId, gapRid, [{ kind: "audience", subject: "audience", question: "Who can sign up?",
    options: [{ id: "a", label: "Anyone", value: { scope: "global" } }, { id: "b", label: "Only the US", value: { scope: "countries", countries: ["US"], strictness: "exclusive" } }] }]), 1);
  const claimRid = await queuePersonasResearch(orgId, productId, { prompt: "GapLab is a hosted job queue.", audience: "only the US" });
  const claimed = await claim(claimRid);
  assert.ok(claimed.input.personas_only && claimed.input.confirmed_audience === undefined && (await db.query<any>("SELECT input FROM product_research WHERE id = $1", [claimRid]))[0].input.audience === undefined,
    "a personas-only job never carries an audience of its own");
  const pick = good.personas[0];
  const rounds = [
    { round: 1, candidates: ["example-startup-backend", "example-enterprise-platform", "example-solo-indie"].map((slug, j) => ({ profile_slug: slug, keep: j < 2, reason: `${["US", "DE", "US"][j]}, industry: a backend role on a queue-heavy stack` })) },
    { round: 2, candidates: ["example-startup-backend", "example-enterprise-platform"].map((slug, j) => ({ profile_slug: slug, keep: j === 0, reason: `${["US", "DE"][j]}, industry: ${j ? "dropped, platform teams standardise on managed queues" : "kept, owns job infrastructure"}` })) },
    { round: 3, converged: true, why: "rechecked eligibility, stack and redundancy; nothing left to change",
      candidates: [{ profile_slug: "example-startup-backend", keep: true, reason: "US, industry: still the closest fit" }] }];
  const claimsCustomer = { product: { audience: { scope: "countries", countries: ["US"], strictness: "exclusive", checked: "the customer told us so, in writing", source: "customer", confirmed: true } },
                           personas: [pick], selection: { personas: rounds } };
  const refused = await (await worker(`/research/${claimRid}/validate`, { result: claimsCustomer })).json();
  assert.ok(!refused.ok && refused.issues.some((i: string) => /source "customer" is only for/.test(i)) && refused.issues.some((i: string) => /audience restricts users but cites no fetched page/.test(i)),
    `a result cannot make its audience the customer's: ${refused.issues.join(" | ")}`);
  const sneaky = await (await worker(`/research/${claimRid}/complete`, { status: "completed", result: { personas: [pick], selection: { personas: rounds }, product: {}, audience_check: "agree" } })).json();
  assert.equal(sneaky.status, "completed", JSON.stringify(sneaky).slice(0, 300));
  const [still] = await db.query<any>("SELECT status FROM product_questions WHERE product_id = $1 AND subject = 'audience' AND status = 'open'", [productId]);
  assert.ok(still, "the model's own audience_check dismisses nothing");
  const [afterSneaky] = await db.query<any>("SELECT research FROM products WHERE id = $1", [productId]);
  assert.ok(afterSneaky.research.audience.source === "research" && afterSneaky.research.audience.confirmed !== true, "the stored audience is still research's");
  const global = { scope: "global", checked: "confirmed by the customer in answer to a question", source: "customer", confirmed: true };
  await db.query("UPDATE products SET research = jsonb_set(research, '{audience}', $2::jsonb) - 'audience_gap' WHERE id = $1", [productId, JSON.stringify(global)]);
  await db.query("/* tenant: smoke */ UPDATE scenarios SET prompt_variants = $2 WHERE id = $1",
    [task.id, JSON.stringify({ "example-startup-backend": variant, "example-enterprise-platform": variant })]);
  const before = await productState(db, productId);
  const rid = await queuePersonasResearch(orgId, productId, { prompt: "GapLab is a hosted job queue.", website_url: "https://quickqueue.example.com" });
  const job = await claim(rid);
  assert.ok(job.input.personas_only === true && job.input.product_profile?.name === "GapLab" && job.input.confirmed_audience?.scope === "global",
    `the claimed job is personas only, with the stored profile and the confirmed audience: ${JSON.stringify(job.input).slice(0, 300)}`);
  const result = { product: {}, personas: [pick], selection: { personas: rounds } };
  const bad = await (await worker(`/research/${rid}/validate`, { result: { ...result, personas: [{ profile_slug: "example-startup-backend", name: "Wrong name" }] } })).json();
  assert.ok(!bad.ok && bad.issues.some((i: string) => /is named/.test(i)) && !bad.issues.some((i: string) => /scenarios|competitors|category_terms/.test(i)),
    `personas-only results are checked on their personas only: ${bad.issues.join(" | ")}`);
  const done = await (await worker(`/research/${rid}/complete`, { status: "completed", result })).json();
  assert.ok(done.status === "completed" && done.personas_only === true && done.simulation_id === null, JSON.stringify(done).slice(0, 400));
  assert.deepEqual(await productState(db, productId), before, "profile, competitors, sources and tasks unchanged");
  const links = await db.query<any>("/* tenant: smoke */ SELECT dp.slug, pp.active FROM product_personas pp JOIN developer_profiles dp ON dp.id = pp.profile_id WHERE pp.product_id = $1 AND pp.active", [productId]);
  assert.deepEqual(links.map((x: any) => x.slug), ["example-startup-backend"], "the links are swapped");
  const [v] = await db.query<any>("/* tenant: smoke */ SELECT prompt_variants FROM scenarios WHERE id = $1", [task.id]);
  assert.deepEqual(Object.keys(v.prompt_variants), ["example-startup-backend"], "variants of personas no longer linked are dropped");
  const [r] = await db.query<any>("SELECT research FROM products WHERE id = $1", [productId]);
  assert.ok(r.research.personas_research_id === rid && r.research.audience.confirmed === true && !r.research.audience_gap, "the confirmed audience stays; the old gap is gone");
  // A global product with no personas linked runs with a generic developer, as before (only a restricted one refuses).
  await db.query("/* tenant: smoke */ UPDATE product_personas SET active = false WHERE product_id = $1", [productId]);
  const generic = await call(A, "run_simulation", { product, samples: 1 });
  assert.ok(generic.simulation?.id, "a global product without personas still runs");
  await call(A, "cancel_simulation", { simulation_id: generic.simulation.id });
  console.log("✓ personas only: claimed with the stored profile and confirmed audience, links swapped, stale variants dropped, nothing else touched; a global product without personas still runs");
}
