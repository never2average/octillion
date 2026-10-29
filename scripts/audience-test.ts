// Who may use a product (src/audience.ts) against the personas research picks, without a database: the audience
// validator, the hard and soft checks on picks, and the customer-question options. The database side (filtered search,
// the verified gap, questions, the run guard) is in scripts/smoke.ts.
//   npx tsx scripts/audience-test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { audienceFormIssues, hardMisses, mergeAudience, personaSupplyQuestion, pickIssues, RESTRICTION_UNCITED, type Audience, type Pick } from "../src/audience.js";
import { mentionsCountry } from "../src/facets.js";
import { validateResearch } from "../src/research.js";

let n = 0;
const check = (name: string, fn: () => void) => { fn(); n++; console.log(`✓ ${name}`); };

// The example vault's fixtures (vault/example/profiles.json): their facets are what the server reads.
const example: Pick[] = JSON.parse(readFileSync(new URL("../vault/example/profiles.json", import.meta.url), "utf8"))
  .map((p: any) => ({ slug: p.id, name: p.name, facets: p.attributes.facets }));
const pick = (slug: string) => example.find((p) => p.slug === slug)!;
const SIGNUP = "https://alliancecan.ca/en/services/advanced-research-computing/account-management/apply-account";
const quote = "Accounts are available to faculty at Canadian institutions and the students and staff they sponsor.";
const alliance: Audience = {
  scope: "countries", countries: ["CA"], strictness: "exclusive", evidence: [{ url: SIGNUP, quote }],
  gates: [{ id: "affiliation", requirement: "a researcher at a Canadian institution, sponsored by faculty", strictness: "required",
            match: { sector_any: ["academia"], research_role: true }, evidence: [{ url: SIGNUP, quote }] }],
  checked: "the apply-account page, the CCDB sponsorship page and the terms of use",
};

check("validator: a global audience needs no evidence; a restriction cites a fetched page; checked is required", () => {
  const audienceIssues = (a: unknown, sources = [{ url: SIGNUP }]) => validateResearch({ product: { name: "X", audience: a as Audience }, personas: [], scenarios: [], sources } as any)
    .filter((i) => /audience/.test(i) && !/audience_gap/.test(i));
  assert.deepEqual(audienceIssues({ scope: "global", checked: "the pricing, sign-up and terms pages: anyone may sign up" }), []);
  assert.deepEqual(audienceIssues(alliance), [], "cited from a page in sources (the same normalisation as decision.evidence_url)");
  assert.deepEqual(audienceIssues(alliance, [{ url: `${SIGNUP}/#form` }]), [], "a fragment or trailing slash is the same page");
  const uncited = audienceIssues(alliance, [{ url: "https://alliancecan.ca/en" }]);
  assert.ok(uncited.some((i) => i.includes(RESTRICTION_UNCITED)) && uncited.some((i) => /gates\[0\]/.test(i)), uncited.join(" | "));
  assert.ok(audienceIssues({ ...alliance, evidence: [{ url: SIGNUP, quote: "too short" }] }).some((i) => i.includes(RESTRICTION_UNCITED)), "a quote of 20+ characters");
  assert.ok(audienceIssues({ scope: "global" }).some((i) => /checked/.test(i)), "missing checked");
  assert.ok(audienceIssues({ scope: "global", checked: "the homepage" }).some((i) => /checked.*30\+/.test(i)), "checked under 30 characters");
  assert.ok(audienceIssues(undefined).some((i) => /product\.audience is required/.test(i)));
  assert.ok(audienceIssues({ ...alliance, countries: ["Canada"] }).some((i) => /unknown ISO2 codes: Canada/.test(i)));
  assert.ok(audienceIssues({ ...alliance, gates: [{ ...alliance.gates![0], match: { sector_any: ["universities"] } }] }).some((i) => /sector_any must be a list of academia/.test(i)));
});

check("Alliance-like (CA only, researchers at an institution): only the Canadian academic researcher passes", () => {
  const issues = pickIssues(alliance, [pick("example-se-academic-researcher"), pick("example-us-highered-fullstack"), pick("example-ca-industry-fullstack"), pick("example-ca-academic-researcher")]);
  const of = (i: number) => issues.filter((x) => x.startsWith(`personas[${i}]`));
  assert.ok(of(0).some((x) => /example-se-academic-researcher .* is in SE; the product serves only CA \(evidence: https:\/\/alliancecan\.ca.*search_profiles \{"country":\["CA"\],"sector":\["academia"\],"research_role":true\}/.test(x)), of(0).join(" | "));
  assert.ok(of(1).some((x) => /is in US/.test(x)) && of(1).some((x) => /has sector academia but research_role false; gate 'a researcher at a Canadian institution, sponsored by faculty' requires sector academia and research_role true/.test(x)),
    "the US university web developer fails both: wrong country, and works at a university without doing research");
  assert.ok(of(2).length === 1 && /has sector industry, not academia/.test(of(2)[0]!), "the Canadian industry developer fails the gate only");
  assert.deepEqual(of(3), [], "the Canadian academic researcher is accepted");
  assert.deepEqual(hardMisses(alliance, pick("example-ca-phd-student").facets), [], "a Canadian doctoral student is a researcher");
  assert.match(hardMisses(alliance, null)[0]!, /has no country in the data/, "a profile without facets never passes an exclusive market");
});

check("Neon-like (global): picks from any country raise nothing", () => {
  const global: Audience = { scope: "global", checked: "the pricing, sign-up and terms pages: anyone may sign up" };
  assert.deepEqual(pickIssues(global, example.slice(0, 4)), []);
  assert.deepEqual(pickIssues(global, [pick("example-se-academic-researcher"), pick("example-in-fintech-backend")]), []);
});

check("OnFinance-like (India primary, finance typical): half the picks must match each soft part", () => {
  const onfinance: Audience = { scope: "countries", countries: ["IN"], strictness: "primary", evidence: [{ url: "https://onfinance.ai", quote: "Built for Indian banks, NBFCs and asset managers." }],
    gates: [{ id: "bfsi", requirement: "works in banking, financial services or insurance", strictness: "typical", match: { sector_any: ["finance"] } }],
    checked: "the homepage, the solutions pages and the sign-up page" };
  const inFin = (i: number): Pick => ({ slug: `in-fin-${i}`, name: `In Fin ${i}`, facets: { country: "IN", sector: "finance" } });
  const usDev = pick("example-startup-backend"), deDev = pick("example-enterprise-platform");
  const one = pickIssues(onfinance, [inFin(1), usDev, deDev]);
  assert.ok(one.some((x) => /only 1 of 3 personas are in India.*at least 2/.test(x)) && one.some((x) => /only 1 of 3 personas match 'works in banking/.test(x)), one.join(" | "));
  assert.deepEqual(pickIssues(onfinance, [inFin(1), inFin(2), usDev]), [], "2 of 3 passes; a soft part never rejects a single pick");
  assert.deepEqual(hardMisses(onfinance, usDev.facets), [], "primary and typical parts are never hard");
});

check("two picks sharing a display name are rejected", () => {
  const twin = { ...pick("example-ca-phd-student"), slug: "other", name: pick("example-ca-academic-researcher").name };
  assert.ok(pickIssues(alliance, [pick("example-ca-academic-researcher"), twin]).some((x) => /2 personas share the display name/.test(x)));
});

check("a selection reason names the profile's country by code, name or demonym", () => {
  assert.ok(mentionsCountry("CA, academia: researcher on the shared clusters", "CA"));
  assert.ok(mentionsCountry("a Canadian doctoral student", "CA") && mentionsCountry("based in Canada", "CA"));
  assert.ok(mentionsCountry("UK agency developer", "GB") && mentionsCountry("US-based", "US") && mentionsCountry("an Indian fintech", "IN"));
  assert.ok(!mentionsCountry("tells us the stack fits", "US"), "'us' is a word, not the country");
  assert.ok(!mentionsCountry("works in Indiana", "IN") && !mentionsCountry("a backend engineer", "CA"));
});

check("customer questions: audience option values are checked; the persona-supply question's options are all valid", () => {
  const opt = (v: unknown) => audienceFormIssues(v, { sources: null, partial: true, where: "value" });
  assert.deepEqual(opt({ scope: "global" }), []);
  assert.deepEqual(opt({ scope: "countries", countries: ["CA"], strictness: "exclusive" }), []);
  assert.ok(opt({ scope: "countries", countries: ["ZZ"] }).length, "bad ISO2");
  assert.ok(opt({ gates: [{ id: "g", requirement: "a university researcher", strictness: "required", match: { sector_any: ["universities"] } }] }).length, "unknown sector");
  const q = personaSupplyQuestion(alliance, { searched: ['search_profiles {"country":["CA"]}'], note: "no Canadian researchers in the data" });
  assert.equal(q.subject, "persona_supply");
  assert.deepEqual(q.options.map((o) => o.id), ["a", "b", "c"]);
  for (const o of q.options) assert.deepEqual(opt(o.value), [], o.label);
  const widened = mergeAudience(alliance, q.options[1]!.value as Partial<Audience>, "our users are mostly abroad");
  assert.ok(widened.scope === "global" && !widened.countries && widened.source === "customer" && widened.confirmed === true && /abroad/.test(widened.customer_note!));
  assert.deepEqual(audienceFormIssues(widened, { sources: null }), [], "the merged audience is valid");
});

console.log(`audience test passed (${n} cases)`);
