/**
 * Architecture review (pi-octillion/architect.ts), without a model: parsing the reviewer's answer, turning a verdict
 * into issues, questions for the customer and tools that do not compete, and putting them on the research result.
 *
 *   npx tsx orchestrator/test/architect.ts
 */
import assert from "node:assert/strict";
import { architectOutcome, audienceCrossCheck, followUpPrompt, parseArchitect, unsureOf, type ArchitectProduct } from "../pi-octillion/architect.js";
import { AUDIENCE_ROUNDS, applyArchitecture, audienceStep } from "../pi-octillion/research.js";

let n = 0;
const check = (name: string, fn: () => void) => { fn(); n++; console.log(`✓ ${name}`); };

const drac: ArchitectProduct = {
  name: "Digital Research Alliance of Canada", aliases: ["DRAC"],
  competitors: [{ name: "Rescale" }, { name: "Slurm" }, { name: "AWS ParallelCluster" }, { name: "Apptainer" }],
};
const answer = (competitors: unknown[], extra: Record<string, unknown> = {}) => `Here is my review:\n${JSON.stringify({
  placement: { layer: "managed HPC cluster provider", runs_on_it: ["batch jobs", "GPU training"], used_with: ["Slurm", "Apptainer"], adoption_signals: ["sbatch to an Alliance cluster"] },
  competitors, missing_names: ["the Alliance", "Compute Canada", "Rescale"], ...extra })}\nDone.`;

check("parses the JSON object out of surrounding prose and normalises it", () => {
  const v = parseArchitect(answer([{ index: 0, name: "Rescale", relation: "substitute", confidence: "high", reason: "Cloud HPC instead of the Alliance." },
    { index: 1, name: "Slurm", relation: "complement", confidence: "weird", reason: "Its scheduler." }, { index: 9, name: "x", relation: "nope" }]))!;
  assert.equal(v.placement.layer, "managed HPC cluster provider");
  assert.equal(v.competitors.length, 2, "an unknown relation is dropped");
  assert.equal(v.competitors[1]!.confidence, "medium", "an unknown confidence reads as medium (not sure)");
  assert.equal(parseArchitect("no json here"), null);
  const long = "hosted serverless Postgres database (DBaaS) with branching, autoscaling and scale-to-zero, now one service in Neon's wider platform alongside Lakebase";
  const w = parseArchitect(JSON.stringify({ placement: { layer: long, used_with: Array.from({ length: 12 }, (_, i) => `tool ${i}`) }, competitors: [] }))!;
  assert.equal(w.placement.layer, long, "the layer is kept whole");
  assert.equal(w.placement.used_with.length, 12, "and every item of the placement lists");
});

check("confident complement and different layer become issues and are remembered as not competing; substitutes stay", () => {
  const v = parseArchitect(answer([
    { index: 0, name: "Rescale", relation: "substitute", confidence: "high", reason: "x" },
    { index: 1, name: "Slurm", relation: "complement", confidence: "high", reason: "Alliance clusters run Slurm." },
    { index: 2, name: "AWS ParallelCluster", relation: "substitute", confidence: "high", reason: "x" },
    { index: 3, name: "Apptainer", relation: "different_layer", confidence: "high", reason: "Containers on the clusters." }]))!;
  const o = architectOutcome(v, drac, 1);
  assert.deepEqual(o.not_competitors.map((c) => c.name), ["Slurm", "Apptainer"]);
  assert.ok(o.issues.some((i) => /competitors\[1\] \(Slurm\) \(architecture review\): is a complement/.test(i)));
  assert.ok(o.issues.some((i) => /competitors\[3\] \(Apptainer\).*different part of the stack/.test(i)));
  assert.equal(o.questions.length, 0);
});

check("missing names: added as aliases, never another product's name or one already there", () => {
  const v = parseArchitect(answer([{ index: 0, name: "Rescale", relation: "substitute", confidence: "high", reason: "" }]))!;
  const issue = architectOutcome(v, drac, 1).issues.find((i) => /product\.aliases/.test(i))!;
  assert.match(issue, /Alliance, Compute Canada\.$/, "'the' dropped; Rescale (a competitor) left out");
});

check("unsure after the rounds: no issue, a question for the customer, and the tool kept off scoring", () => {
  const v = parseArchitect(answer([
    { index: 0, name: "Rescale", relation: "substitute", confidence: "high", reason: "" },
    { index: 1, name: "Slurm", relation: "complement", confidence: "low", reason: "Docs mention Slurm; unclear if users choose it instead.",
      question: { text: "How do your users use Slurm with the Alliance?", options: [
        { label: "They submit Slurm jobs to Alliance clusters", relation: "complement" }, { label: "They run their own Slurm cluster instead", relation: "substitute" }] } },
    { index: 2, name: "AWS ParallelCluster", relation: "substitute", confidence: "medium", reason: "" }]))!;
  assert.deepEqual(unsureOf(v).map((c) => c.name), ["Slurm", "AWS ParallelCluster"]);
  assert.match(followUpPrompt(unsureOf(v), 2), /Round 2 of 5.*Slurm \(complement, low\); AWS ParallelCluster/s);
  const o = architectOutcome(v, drac, 5);
  assert.ok(!o.issues.some((i) => /competitors\[/.test(i)), "never guessed into an issue");
  assert.deepEqual(o.unconfirmed, ["Slurm", "AWS ParallelCluster"]);
  const [q1, q2] = o.questions;
  assert.deepEqual(q1!.options.map((x) => [x.id, x.relation]), [["a", "complement"], ["b", "substitute"]]);
  assert.equal(q1!.context.rounds, 5);
  assert.ok(/instead/i.test(q2!.options[0]!.label) && q2!.options.length === 2, "a reviewer with no question gets the default two descriptions");
  // On the result the server saves: unconfirmed flags, questions, not_competitors, placement.
  const result: any = { product: { name: drac.name, competitors: drac.competitors.map((c) => ({ ...c })) } };
  applyArchitecture(result, o);
  assert.deepEqual(result.product.competitors.filter((c: any) => c.unconfirmed).map((c: any) => c.name), ["Slurm", "AWS ParallelCluster"]);
  assert.equal(result.questions.length, 2);
  assert.equal(result.product.placement.layer, "managed HPC cluster provider");
});

check("a question about a competitor research then removed is not asked", () => {
  const o = architectOutcome(parseArchitect(answer([{ index: 1, name: "Slurm", relation: "complement", confidence: "low", reason: "" }]))!, drac, 5);
  const result: any = { product: { name: drac.name, competitors: [{ name: "Rescale" }] } };
  applyArchitecture(result, o);
  assert.equal(result.questions, undefined);
});

check("buy vs build: the self-host route converts the listed entry that shared the engine's name, matched by signals", () => {
  const neon: ArchitectProduct = { name: "Neon", competitors: [{ name: "Supabase" }, { name: "Self-hosted PostgreSQL", aliases: ["PostgreSQL", "Postgres"], domains: ["postgresql.org"] }] };
  const v = parseArchitect(answer([{ index: 0, name: "Supabase", relation: "substitute", confidence: "high", reason: "" },
    { index: 1, name: "Self-hosted PostgreSQL", relation: "complement", confidence: "high", reason: "Neon is Postgres." }],
    { build_alternative: { kind: "self_hosted", name: "Self-hosted PostgreSQL", signals: ["docker run postgres", "image: postgres", "x"], replaces_index: 1, reason: "Run your own server." } }))!;
  const o = architectOutcome(v, neon, 1);
  assert.ok(!o.issues.some((i) => /Self-hosted/.test(i)) && !o.not_competitors.length, "never removed as a complement");
  const result: any = { product: { name: "Neon", competitors: neon.competitors.map((c) => ({ ...c })) } };
  applyArchitecture(result, o);
  const route = result.product.competitors[1];
  assert.deepEqual([route.kind, route.signals, route.aliases], ["self_hosted", ["docker run postgres", "image: postgres"], undefined], "names and aliases dropped, signals kept (too-short ones out)");
});
check("buy vs build: added when research listed no such route", () => {
  const v = parseArchitect(answer([{ index: 0, name: "Rescale", relation: "substitute", confidence: "high", reason: "" }],
    { build_alternative: { kind: "build", name: "Own cluster on cloud VMs", signals: ["terraform apply", "sbatch on our own cluster"], replaces_index: null, reason: "" } }))!;
  const result: any = { product: { name: drac.name, competitors: [{ name: "Rescale" }] } };
  applyArchitecture(result, architectOutcome(v, { ...drac, competitors: [{ name: "Rescale" }] }, 1));
  assert.deepEqual(result.product.competitors.map((c: any) => [c.name, c.kind ?? "vendor"]), [["Rescale", "vendor"], ["Own cluster on cloud VMs", "build"]]);
});

// ---------- who may sign up: the review's audience, cross-checked against research's product.audience ----------

const ccdb = { url: "https://alliancecan.ca/en/services/advanced-research-computing/account-management/apply-account",
               quote: "Faculty members at Canadian institutions can apply for an account; students and staff are sponsored by a faculty member." };
const allianceAudience = (extra: Record<string, unknown> = {}) => ({ scope: "countries", countries: ["ca"], gates: [{ requirement: "a researcher at a Canadian institution, sponsored by faculty", sector_any: ["academia", "space"], research_role: true }],
  confidence: "high", ...ccdb, ...extra });

check("parses the optional audience block; without one the verdict has none", () => {
  const v = parseArchitect(answer([], { audience: allianceAudience() }))!;
  assert.deepEqual([v.audience!.scope, v.audience!.countries, v.audience!.gates[0]!.sector_any, v.audience!.gates[0]!.research_role, v.audience!.confidence],
    ["countries", ["CA"], ["academia"], true, "high"], "ISO2 upper-cased, unknown sectors dropped");
  assert.equal(parseArchitect(answer([]))!.audience, null);
  assert.equal(architectOutcome(v, drac, 1).audience!.countries[0], "CA", "the outcome carries it");
});

check("a US headquarters without a quote never becomes a confident restriction", () => {
  const v = parseArchitect(answer([], { audience: { scope: "countries", countries: ["US"], confidence: "high", url: "", quote: "" } }))!;
  assert.equal(v.audience!.confidence, "medium", "no quote: not high");
  const x = audienceCrossCheck({ scope: "global", checked: "pricing, sign-up and terms pages: anyone may sign up" }, v.audience);
  assert.deepEqual(x.issues, [], "never an issue that narrows research's global audience");
  assert.equal(x.question?.kind, "audience", "the customer is asked instead");
  assert.deepEqual(x.question.options.map((o: any) => o.value.scope), ["global", "countries"], "research's reading first");
  const global = parseArchitect(answer([], { audience: { scope: "global", confidence: "high", url: "", quote: "" } }))!;
  assert.equal(global.audience!.confidence, "high", "global needs no quote");
  assert.deepEqual(audienceCrossCheck({ scope: "global", checked: "x".repeat(30) }, global.audience), { issues: [], question: null });
});

check("unsureOf includes an audience that is not high confidence; follow-up asks for the sign-up pages", () => {
  const v = parseArchitect(answer([{ index: 0, name: "Rescale", relation: "substitute", confidence: "high", reason: "" }], { audience: allianceAudience({ confidence: "low" }) }))!;
  const u = unsureOf(v);
  assert.deepEqual(u.map((x) => x.name), ["the audience (who may sign up)"]);
  assert.match(followUpPrompt(u, 2), /sign-up, account, eligibility and terms pages/);
  assert.equal(unsureOf(parseArchitect(answer([], { audience: allianceAudience() }))!).length, 0, "a high-confidence audience is settled");
});

check("a confident, quoted restriction research lacks goes back as an issue; matching audiences pass", () => {
  const a = parseArchitect(answer([], { audience: allianceAudience() }))!.audience;
  const x = audienceCrossCheck({ scope: "global", checked: "x".repeat(30) }, a);
  assert.ok(x.issues.some((i) => /found sign-up limited to CA \(https:\/\/alliancecan\.ca.*Faculty members/.test(i) && /set product\.audience accordingly/.test(i)), x.issues.join(" | "));
  assert.ok(x.issues.some((i) => /add it to product\.audience\.gates as required/.test(i)));
  assert.match(audienceCrossCheck({ scope: "countries", countries: ["US"], gates: [{ strictness: "required" }] }, a).issues.join(), /limited to CA/, "other countries");
  const matching = { scope: "countries", countries: ["CA"], strictness: "exclusive", gates: [{ id: "g", strictness: "required", requirement: "x", match: { sector_any: ["academia"], research_role: true } }] };
  assert.deepEqual(audienceCrossCheck(matching, a), { issues: [], question: null });
  assert.deepEqual(audienceCrossCheck({ ...matching, strictness: undefined }, a).issues, [], "unset strictness is exclusive, as the server reads it");
});

check("strictness is compared: an exclusive market is never accepted as primary, a required gate never as typical or wider", () => {
  const a = parseArchitect(answer([], { audience: allianceAudience({ strictness: "exclusive" }) }))!.audience!;
  assert.equal(a.strictness, "exclusive");
  assert.equal(a.gates[0]!.strictness, "required", "a gate with no strength stated is required");
  const gate = { id: "g", strictness: "required", requirement: "x", match: { sector_any: ["academia"], research_role: true } };
  const primary = audienceCrossCheck({ scope: "countries", countries: ["CA"], strictness: "primary", gates: [gate] }, a);
  assert.ok(primary.issues.length === 1 && /strictness is "primary"; set strictness "exclusive"/.test(primary.issues[0]!), primary.issues.join(" | "));
  const typical = audienceCrossCheck({ scope: "countries", countries: ["CA"], strictness: "exclusive", gates: [{ ...gate, strictness: "typical" }] }, a);
  assert.ok(typical.issues.length === 1 && /has it only as typical: make it required/.test(typical.issues[0]!), typical.issues.join(" | "));
  const wider = audienceCrossCheck({ scope: "countries", countries: ["CA"], strictness: "exclusive", gates: [{ ...gate, match: { sector_any: ["academia"] } }] }, a);
  assert.ok(wider.issues.length === 1 && /"research_role":true/.test(wider.issues[0]!), "a gate without the research affiliation the page requires is too wide");
  // The review reads "researchers or the staff they sponsor": research's researchers-only gate is narrower, never an issue.
  const staff = parseArchitect(answer([], { audience: allianceAudience({ gates: [{ requirement: "researchers or sponsored staff", sector_any: ["academia"], role_any: ["research_role", "academic_staff", "bogus"] }] }) }))!.audience!;
  assert.deepEqual(staff.gates[0]!.role_any, ["research_role", "academic_staff"], "unknown roles dropped");
  assert.deepEqual(audienceCrossCheck({ scope: "countries", countries: ["CA"], gates: [gate] }, staff).issues, []);
  assert.deepEqual(audienceCrossCheck({ scope: "countries", countries: ["CA"], gates: [{ ...gate, match: { sector_any: ["academia"], role_any: ["research_role", "academic_staff"] } }] }, staff).issues, []);
  const primaryReview = parseArchitect(answer([], { audience: allianceAudience({ strictness: "primary", gates: [] }) }))!.audience!;
  assert.deepEqual(audienceCrossCheck({ scope: "countries", countries: ["CA"], strictness: "primary" }, primaryReview), { issues: [], question: null });
  const unsure = audienceCrossCheck({ scope: "countries", countries: ["CA"], strictness: "primary", gates: [gate] }, { ...a, confidence: "medium" });
  assert.equal(unsure.question?.options[1].value.strictness, "exclusive", "an unsure strictness difference is asked, with the review's strictness as an option");
});

check("rounds used up: a confident restriction research still lacks becomes a customer question, never dropped", () => {
  const ctx = { architecture: architectOutcome(parseArchitect(answer([], { audience: allianceAudience() }))!, drac, 1), audienceRounds: 0 };
  const result: any = { product: { audience: { scope: "global", checked: "x".repeat(30) } }, questions: [] };
  for (let i = 0; i < AUDIENCE_ROUNDS; i++) assert.ok(audienceStep(ctx, result).length > 0, `round ${i + 1} goes back to research`);
  assert.deepEqual(audienceStep(ctx, result), [], "after the rounds the result is not sent back again");
  const q = result.questions.find((x: any) => x.kind === "audience");
  assert.ok(q, "but the customer is asked");
  assert.deepEqual(q.options.map((o: any) => [o.value.scope, o.value.countries ?? null, o.value.strictness ?? null]), [["global", null, null], ["countries", ["CA"], "exclusive"]]);
  assert.ok(q.context.review_findings.some((x: string) => /limited to CA/.test(x)), "with the review's quoted finding");
  audienceStep(ctx, result);
  assert.equal(result.questions.filter((x: any) => x.kind === "audience").length, 1, "submitting again does not ask twice");
  const agreed: any = { product: { audience: { scope: "countries", countries: ["CA"], gates: [{ strictness: "required", match: { sector_any: ["academia"], research_role: true } }] } } };
  assert.deepEqual(audienceStep(ctx, agreed), []);
  assert.equal(agreed.questions, undefined, "agreement asks nothing");
});

console.log(`architect test passed (${n} cases)`);
