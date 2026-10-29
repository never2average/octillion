// Who may use a product (src/audience.ts) against the personas research picks, without a database: the audience
// validator, the hard and soft checks on picks, and the customer-question options. The database side (filtered search,
// the verified gap, questions, the run guard) is in scripts/smoke.ts.
//   npx tsx scripts/audience-test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { audienceFormIssues, hardKey, hardMisses, mergeAudience, personaSupplyQuestion, pickIssues, RESTRICTION_UNCITED, runPersonaCheck, type Audience, type Pick } from "../src/audience.js";
import { mentionsCountry } from "../src/facets.js";
import { audienceEvidenceIssues, validateResearch } from "../src/research.js";

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

check("validator: a global audience needs no evidence; a restriction quotes a page; checked is required", () => {
  const audienceIssues = (a: unknown, sources = [{ url: SIGNUP }]) => validateResearch({ product: { name: "X", audience: a as Audience }, personas: [], scenarios: [], sources } as any)
    .filter((i) => /audience/.test(i) && !/audience_gap/.test(i));
  assert.deepEqual(audienceIssues({ scope: "global", checked: "the pricing, sign-up and terms pages: anyone may sign up" }), []);
  assert.deepEqual(audienceIssues(alliance), [], "a url and a quote");
  const unquoted = audienceIssues({ ...alliance, evidence: [] });
  assert.ok(unquoted.some((i) => i.includes(RESTRICTION_UNCITED)), unquoted.join(" | "));
  assert.ok(audienceIssues({ ...alliance, evidence: [{ url: SIGNUP, quote: "too short" }] }).some((i) => i.includes(RESTRICTION_UNCITED)), "a quote of 20+ characters");
  assert.ok(audienceIssues({ scope: "global" }).some((i) => /checked/.test(i)), "missing checked");
  assert.ok(audienceIssues({ scope: "global", checked: "the homepage" }).some((i) => /checked.*30\+/.test(i)), "checked under 30 characters");
  assert.ok(audienceIssues(undefined).some((i) => /product\.audience is required/.test(i)));
  assert.ok(audienceIssues({ ...alliance, countries: ["Canada"] }).some((i) => /unknown ISO2 codes: Canada/.test(i)));
  assert.ok(audienceIssues({ ...alliance, gates: [{ ...alliance.gates![0], match: { sector_any: ["universities"] } }] }).some((i) => /sector_any must be a list of academia/.test(i)));
});

check("a restriction's quote is on the page it cites, as this job fetched it, on the same evidence entry", () => {
  const page = { url: SIGNUP, text: `Apply for an account\n\nAccounts  are available to faculty at Canadian institutions and the students and staff they sponsor. Sponsored users renew yearly.` };
  const result = (a: Audience) => ({ product: { name: "Alliance", audience: a }, sources: [{ url: "https://made-up.example.net/eligibility" }] } as any);
  const job = { pages: [page] };
  assert.deepEqual(audienceEvidenceIssues(job, result(alliance)), [], "quoted word for word (whitespace and case aside)");
  assert.deepEqual(audienceEvidenceIssues(job, result({ ...alliance, evidence: [{ url: `https://www.alliancecan.ca/en/services/advanced-research-computing/account-management/apply-account/#x`, quote: quote.toUpperCase() }] })), [],
    "the same page by URL (scheme, www, fragment, trailing slash aside)");
  const paraphrase = audienceEvidenceIssues(job, result({ ...alliance, evidence: [{ url: SIGNUP, quote: "Only Canadian faculty and the people they sponsor may have an account." }] }));
  assert.ok(paraphrase.length === 1 && /the quote is not on .*apply-account as this job fetched it/.test(paraphrase[0]!), paraphrase.join(" | "));
  // Research listing a page in its own sources is not fetching it: the server never saw it.
  const unfetched = audienceEvidenceIssues(job, result({ ...alliance, evidence: [{ url: "https://made-up.example.net/eligibility", quote }] }));
  assert.ok(unfetched.length === 1 && unfetched[0]!.startsWith("product.audience: ") && /was never fetched by this job/.test(unfetched[0]!), unfetched.join(" | "));
  // The fetched URL on one entry and the quote on another prove nothing about either.
  const split = audienceEvidenceIssues(job, result({ ...alliance, evidence: [{ url: SIGNUP, quote: "Apply for an account today, it is quick." }, { url: "https://made-up.example.net/x", quote }] }));
  assert.equal(split.length, 1, split.join(" | "));
  assert.ok(audienceEvidenceIssues({ pages: [] }, result(alliance)).length === 2, "the gate's evidence is checked too");
  assert.deepEqual(audienceEvidenceIssues(job, result({ scope: "global", checked: "x".repeat(30) })), []);
  assert.deepEqual(audienceEvidenceIssues({ pages: [] }, result({ ...alliance, source: "customer" })), [], "the customer's own word needs no page");
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
  // research_role is research-affiliated (vault/build/so_common.py): a student whose job is at a software company,
  // a government data scientist and a university's own developers are not researchers.
  assert.match(hardMisses(alliance, pick("example-ca-student-at-software-company").facets).join(), /has sector academia but research_role false/);
  assert.match(hardMisses(alliance, pick("example-ca-gov-data-scientist").facets).join(), /research_role false/);
  assert.match(hardMisses(alliance, pick("example-ca-research-software-engineer").facets).join(), /research_role false/);
  assert.match(hardMisses(alliance, null)[0]!, /has no country in the data/, "a profile without facets never passes an exclusive market");
});

check("researchers or academic staff: role_any lets a gate admit a university's research software engineers, not its students at companies", () => {
  const sponsored: Audience = { ...alliance, gates: [{ ...alliance.gates![0]!, requirement: "researchers at Canadian institutions and the staff they sponsor",
                                                      match: { sector_any: ["academia"], role_any: ["research_role", "academic_staff"] } }] };
  assert.deepEqual(audienceFormIssues(sponsored, { sources: () => true }), []);
  assert.ok(audienceFormIssues({ ...sponsored, gates: [{ ...sponsored.gates![0]!, match: { role_any: ["student"] } }] }, { sources: () => true })
    .some((i) => /role_any must be a list of research_role, academic_staff/.test(i)));
  const ok = (slug: string) => hardMisses(sponsored, pick(slug).facets);
  assert.deepEqual(ok("example-ca-research-software-engineer"), [], "university staff pass");
  assert.deepEqual(ok("example-ca-academic-researcher"), [], "researchers pass");
  assert.match(ok("example-ca-student-at-software-company").join(), /is neither research_role nor academic_staff/);
  assert.match(ok("example-us-highered-fullstack").join(), /is in US/, "staff elsewhere still fail the country");
  assert.deepEqual(pickIssues(sponsored, [pick("example-ca-research-software-engineer"), pick("example-ca-phd-student")]), []);
});

check("hardKey: the same hard parts compare equal whatever defaults were spelled out", () => {
  const nz = (strictness?: "exclusive" | "primary") => ({ scope: "countries" as const, countries: ["NZ"], ...(strictness ? { strictness } : {}), gates: [], checked: "x".repeat(30) });
  assert.equal(hardKey(nz()), hardKey(nz("exclusive")), "unset strictness is exclusive (the persona_supply confirmation loop)");
  assert.equal(hardKey(nz("primary")), hardKey({ scope: "global", checked: "" }), "a primary market restricts nobody");
  assert.notEqual(hardKey(nz()), hardKey(nz("primary")));
  const g = (match: any, strictness: "required" | "typical" = "required") => ({ ...alliance, gates: [{ ...alliance.gates![0]!, strictness, match }] });
  assert.equal(hardKey(g({ research_role: true, sector_any: ["academia"] })), hardKey(g({ sector_any: ["academia"], research_role: true })), "key order");
  assert.equal(hardKey(g({ sector_any: ["academia"] }, "typical")), hardKey({ ...alliance, gates: [] }), "typical gates are not hard");
  assert.notEqual(hardKey(g({ sector_any: ["academia"] })), hardKey(g({ sector_any: ["academia"], research_role: true })));
});

check("personas named for a run: an exclusive audience refuses ineligible ones and a generic developer; a primary one warns", () => {
  const refused = runPersonaCheck(alliance, [pick("example-ca-academic-researcher"), pick("example-se-academic-researcher")], false);
  assert.ok(refused.refuse.length === 1 && /^example-se-academic-researcher is in SE/.test(refused.refuse[0]!), refused.refuse.join(" | "));
  assert.match(runPersonaCheck(alliance, [], true).refuse.join(), /^a generic developer \(profiles: \[\]\) has no country/, "profiles: [] is refused too");
  assert.deepEqual(runPersonaCheck(alliance, [pick("example-ca-academic-researcher")], false), { refuse: [], warn: [] });
  const primary: Audience = { ...alliance, strictness: "primary", gates: [] };
  const warned = runPersonaCheck(primary, [pick("example-se-academic-researcher")], false);
  assert.ok(!warned.refuse.length && /only 0 of 1 personas are in Canada/.test(warned.warn.join()), "primary: runs, with a warning");
  assert.ok(!runPersonaCheck(primary, [], true).refuse.length && runPersonaCheck(primary, [], true).warn.length === 1);
  const global: Audience = { scope: "global", checked: "x".repeat(30) };
  assert.deepEqual(runPersonaCheck(global, [], true), { refuse: [], warn: [] });
  assert.deepEqual(runPersonaCheck(null, [pick("example-se-academic-researcher")], false), { refuse: [], warn: [] });
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
