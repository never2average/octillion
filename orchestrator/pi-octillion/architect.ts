/**
 * Architecture review for product research: a separate Pi session on the strongest model (ARCHITECT_MODEL, default
 * Claude Opus 5.5 at max effort; the broker issues its credentials) that places the product in a developer's stack
 * before the research is accepted, then judges every competitor against that placement. It replaces rules that would
 * otherwise grow one per kind of product ("Slurm is not a competitor of an HPC provider", "Postgres is not a competitor
 * of a hosted-Postgres company", ...): the reviewer reasons about this product's architecture each time.
 *
 *   placement     what the product is (layer), what developers build or run on it, what they use with it, and what
 *                 an agent visibly does when it is using the product (adoption signals)
 *   competitors   each one is a substitute (choosing it means not choosing the product: the only kind that may stay),
 *                 a complement (used with or on the product: its scheduler, runtime, SDK, protocol, framework or the
 *                 open-source project it hosts), a different layer (another part of the stack), or unrelated; with
 *                 the reviewer's confidence
 *   names         the short, former and spoken names developers use for the product that the profile lacks
 *
 * It has the research job's read-only tools (fetch_url, web_search, find_similar, package_search) and its own budget,
 * so it checks docs and comparisons instead of judging from memory. Competitors it is not sure about are investigated
 * again, up to MAX_ROUNDS rounds; what is still unsure after that is not guessed: the competitor is kept off the
 * scoring (unconfirmed) and the customer is asked which description fits (src/questions.ts).
 *
 * Its confident findings go back to the research session as issues to fix, like the task critic's (critic.ts).
 */
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orchestratorCredentials } from "../core/credentials.js";
import { log } from "../core/util.js";

export const MAX_ROUNDS = 5;
export const ARCHITECT_TOOLS = ["fetch_url", "web_search", "find_similar", "package_search"] as const;

export const ARCHITECT_SYSTEM_PROMPT = `You are a software architect reviewing a market study of one developer product before AI coding agents are
measured on whether they choose it. Wrong competitors make the measurement wrong: if a tool developers use together
with the product is listed as a competitor, every agent that uses the product through that tool is scored as a loss.

You have tools: fetch_url (the product's site and docs, package registries), web_search, find_similar and
package_search. Use them: read how the product's own docs describe using it, and check comparisons, before you judge
a relation you are not sure of.

First place the product in a developer's system architecture:
- layer: what kind of thing it is (e.g. "managed HPC cluster provider", "transactional email API", "Python job-queue
  library", "hosted Postgres database").
- runs_on_it: what developers build, deploy or run on it or through it.
- used_with: tools developers use together with or on the product (its scheduler, runtime, SDK, protocol, framework,
  or the open-source project it hosts or packages).
- adoption_signals: concrete things an agent writes or does when it is using the product.

Then judge every listed competitor against that placement:
- "substitute": a developer who picks it would not pick the product for the same job. Only these are competitors.
- "complement": used with, on or by the product; an agent using it is usually using the product.
- "different_layer": solves a different part of the stack, so it does not compete for the same decision.
- "unrelated": not a plausible choice for the product's job at all.
The test: would choosing this tool make the product unnecessary? Only if yes is it a substitute.
Give your confidence: "high" when the docs or clear evidence settle it, "medium" or "low" otherwise. When it is not
high, also write a question for the product's owner: one plain sentence asking how their users use the tool with or
instead of the product, and 2-3 options, each a short description a person would recognise, mapped to a relation.

Buy versus build is always a real threat: a developer can run the open-source option themselves or build the thing
in-house instead of buying the product. Always give build_alternative, the strongest such route for this product's job:
- kind: "self_hosted" (run an open-source project yourself, e.g. your own PostgreSQL server instead of a hosted
  Postgres) or "build" (write it yourself, e.g. a queue on database tables instead of a queue service).
- name: a distinct name for the route, e.g. "Self-hosted PostgreSQL", "In-house job queue".
- signals: 3-8 concrete things an agent writes or runs when it takes that route (commands, compose or config lines,
  code shapes), e.g. "docker run postgres", "image: postgres", "apt-get install postgresql". Never a bare product or
  engine name: the product's own users say "Postgres" too.
- replaces_index: the index of a listed competitor that already is this route (judge that one "substitute", never
  "complement" because it shares a name with the engine), else null.

List missing_names: short, former or spoken names developers use for the product that its aliases lack (e.g.
"the Alliance" for "Digital Research Alliance of Canada", a former company name). Never names of other products.

Finally, the audience: who may sign up? Read the account, eligibility and terms pages (and pricing, if it has
conditions). Default global. HQ, customer logos and cloud regions are NOT restrictions: only a page that says who may
have an account (e.g. "accounts are available to researchers at Canadian institutions with a faculty sponsor") is.
- scope: "global", or "countries" with ISO2 codes when sign-up is limited to people in those countries, and
  strictness: "exclusive" (nobody elsewhere can sign up) or "primary" (built for those countries; others can still).
- gates: other conditions a user must meet, each {requirement, strictness ("required": nobody else can sign up;
  "typical": most users are like this), sector_any (academia | government | finance | healthcare | industry),
  research_role (true when the user must be research-affiliated: a researcher, a scientist at a university or a
  student; working at such an institution is not enough), role_any (["research_role", "academic_staff"] when
  researchers or the university staff they sponsor, such as research software engineers, may sign up)}.
- confidence: "high" only with a quote from a page you read that states the condition (url and quote, copied
  exactly); for global, quote the sentence that shows anyone may sign up when a page has one.

Answer with ONLY one JSON object, no prose:
{"placement": {"layer": "", "runs_on_it": [], "used_with": [], "adoption_signals": []},
 "competitors": [{"index": 0, "name": "", "relation": "substitute" | "complement" | "different_layer" | "unrelated",
                  "confidence": "high" | "medium" | "low", "reason": "",
                  "question": {"text": "", "options": [{"label": "", "relation": "substitute"}]}}],
 "build_alternative": {"kind": "self_hosted" | "build", "name": "", "signals": [], "replaces_index": null, "reason": ""},
 "missing_names": [],
 "audience": {"scope": "global" | "countries", "countries": [], "strictness": "exclusive" | "primary",
              "gates": [{"requirement": "", "strictness": "required" | "typical", "sector_any": [], "research_role": true, "role_any": []}],
              "confidence": "high" | "medium" | "low", "url": "", "quote": ""}}
"reason" is one short sentence with the evidence; "question" only when confidence is not high.`;

export type Relation = "substitute" | "complement" | "different_layer" | "unrelated";
export type Confidence = "high" | "medium" | "low";
export interface Placement { layer: string; runs_on_it: string[]; used_with: string[]; adoption_signals: string[] }
export interface CompetitorJudgement { index: number; name: string; relation: Relation; confidence: Confidence; reason: string;
  question: { text: string; options: { label: string; relation: Relation }[] } | null }
export interface BuildAlternative { kind: "self_hosted" | "build"; name: string; signals: string[]; replaces_index: number | null; reason: string }
/** Who may sign up, as the reviewer read it (cross-checked against research's product.audience: audienceCrossCheck). */
export interface ArchitectGate { requirement: string; strictness: "required" | "typical"; sector_any: string[]; research_role?: boolean; role_any?: string[] }
export interface ArchitectAudience { scope: "global" | "countries"; countries: string[]; strictness?: "exclusive" | "primary"; gates: ArchitectGate[];
  confidence: Confidence; url: string; quote: string }
export interface ArchitectVerdict { placement: Placement; competitors: CompetitorJudgement[]; missing_names: string[]; build_alternative: BuildAlternative | null;
  audience?: ArchitectAudience | null }
export interface ArchitectProduct { name: string; description?: string; category?: string; features?: string[]; aliases?: string[]; website_url?: string;
  docs_url?: string; competitors: { name: string; aliases?: string[]; domains?: string[]; evidence_url?: string }[] }

const RELATIONS: Relation[] = ["substitute", "complement", "different_layer", "unrelated"];
const CONFIDENCE: Confidence[] = ["high", "medium", "low"];
const strs = (v: unknown, max = 8) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim().slice(0, 200)).slice(0, max) : []);
/** The placement is kept as the reviewer wrote it: no length or count limits, so a layer needs no trimming to fit. */
const texts = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : []);

export function architectPrompt(p: ArchitectProduct): string {
  return `Product under study:\n${JSON.stringify({ name: p.name, category: p.category ?? null, description: p.description ?? null, features: p.features ?? [],
    aliases: p.aliases ?? [], website_url: p.website_url ?? null, docs_url: p.docs_url ?? null }, null, 1)}\n\nListed competitors:\n` +
    JSON.stringify(p.competitors.map((c, index) => ({ index, name: c.name, aliases: c.aliases ?? [], domains: c.domains ?? [], evidence_url: c.evidence_url ?? null })), null, 1);
}

/** Something the reviewer is not yet sure of: a competitor's relation, or the audience. */
export interface Unsure { name: string; relation: string; confidence: Confidence }
export const AUDIENCE_UNSURE = "the audience (who may sign up)";

/** The follow-up round: investigate what is still unsure, then answer the whole object again. */
export function followUpPrompt(unsure: Unsure[], round: number): string {
  return `Round ${round} of ${MAX_ROUNDS}. You are not yet sure about: ${unsure.map((c) => `${c.name} (${c.relation}, ${c.confidence})`).join("; ")}.
Investigate each with your tools before answering: how the product's docs mention it, "<tool> vs <product>" comparisons,
whether the product runs it, hosts it or replaces it.${unsure.some((u) => u.name === AUDIENCE_UNSURE) ? `
For the audience: read the sign-up, account, eligibility and terms pages; quote the sentence that limits who may have an
account, or answer global.` : ""} Then answer the whole JSON object again, with updated confidence.`;
}

/** Parse the reviewer's answer: the outermost JSON object in its text, normalised. Null when unusable. */
export function parseArchitect(text: string): ArchitectVerdict | null {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  let v: any;
  try { v = JSON.parse(text.slice(a, b + 1)); } catch { return null; }
  if (!v || typeof v !== "object" || !Array.isArray(v.competitors)) return null;
  const pl = v.placement ?? {};
  return {
    placement: { layer: typeof pl.layer === "string" ? pl.layer.trim() : "", runs_on_it: texts(pl.runs_on_it), used_with: texts(pl.used_with), adoption_signals: texts(pl.adoption_signals) },
    competitors: v.competitors.filter((c: any) => c && Number.isInteger(c.index) && RELATIONS.includes(c.relation)).map((c: any): CompetitorJudgement => {
      const confidence: Confidence = CONFIDENCE.includes(c.confidence) ? c.confidence : "medium";
      const opts = Array.isArray(c.question?.options) ? c.question.options.filter((o: any) => o && typeof o.label === "string" && RELATIONS.includes(o.relation))
        .map((o: any) => ({ label: String(o.label).trim().slice(0, 200), relation: o.relation as Relation })).slice(0, 3) : [];
      return { index: c.index, name: String(c.name ?? "").slice(0, 120), relation: c.relation as Relation, confidence, reason: String(c.reason ?? "").trim().slice(0, 400),
               question: typeof c.question?.text === "string" && c.question.text.trim() && opts.length >= 2 ? { text: c.question.text.trim().slice(0, 400), options: opts } : null };
    }),
    missing_names: strs(v.missing_names, 6),
    build_alternative: buildAlternativeOf(v.build_alternative),
    audience: audienceOf(v.audience),
  };
}

const SECTORS = ["academia", "government", "finance", "healthcare", "industry"];
const ROLES = ["research_role", "academic_staff"];
function audienceOf(a: any): ArchitectAudience | null {
  if (!a || (a.scope !== "global" && a.scope !== "countries")) return null;
  const countries = a.scope === "countries" ? strs(a.countries, 50).map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)) : [];
  const gates: ArchitectGate[] = (Array.isArray(a.gates) ? a.gates : []).filter((g: any) => typeof g?.requirement === "string" && g.requirement.trim()).map((g: any) => ({
    // A condition stated without a strength is read as required: the page said users must meet it.
    requirement: g.requirement.trim().slice(0, 300), strictness: g.strictness === "typical" ? "typical" : "required",
    sector_any: strs(g.sector_any).filter((s) => SECTORS.includes(s)),
    ...(typeof g.research_role === "boolean" ? { research_role: g.research_role } : {}),
    ...(strs(g.role_any).filter((r) => ROLES.includes(r)).length ? { role_any: strs(g.role_any).filter((r) => ROLES.includes(r)) } : {}) }));
  const url = typeof a.url === "string" ? a.url.trim() : "", quote = typeof a.quote === "string" ? a.quote.trim().slice(0, 600) : "";
  let confidence: Confidence = CONFIDENCE.includes(a.confidence) ? a.confidence : "medium";
  // A restriction is only as sure as the page that states it: without a quote it is never high (a US headquarters or a
  // customer list does not limit who may sign up).
  if ((countries.length || gates.length) && confidence === "high" && !(/^https?:\/\//.test(url) && quote.length >= 20)) confidence = "medium";
  return { scope: countries.length ? "countries" : "global", countries, ...(countries.length ? { strictness: a.strictness === "primary" ? "primary" : "exclusive" } : {}),
           gates, confidence, url, quote };
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
const subset = (a: string[] | undefined, b: string[]) => !!a?.length && a.every((x) => b.includes(x));

/** An audience gate's match as the server reads it (src/facets.ts GateMatch), from the reviewer's gate. */
const matchOf = (g: ArchitectGate) => ({ ...(g.sector_any.length ? { sector_any: g.sector_any } : {}),
  ...(typeof g.research_role === "boolean" ? { research_role: g.research_role } : {}), ...(g.role_any?.length ? { role_any: g.role_any } : {}) });

/**
 * Is gate match `a` at least as narrow as `b` (every profile `a` admits, `b` admits too)? Both research affiliation
 * and academic staff are academia by sector (vault/build/so_common.py), so either one satisfies sector academia.
 */
export function implies(a: any, b: any): boolean {
  a = a ?? {}; b = b ?? {};
  const roles: string[] = a.research_role === true ? ["research_role"] : a.academic_staff === true ? ["academic_staff"] : (a.role_any ?? []);
  if (b.sector_any?.length && !subset(a.sector_any, b.sector_any) && !(b.sector_any.includes("academia") && roles.length && roles.every((r: string) => ROLES.includes(r))))
    return false;
  for (const k of ["research_role", "academic_staff"]) {
    if (b[k] === true && !(a[k] === true || sameSet(a.role_any ?? [], [k]))) return false;
    if (b[k] === false && a[k] !== false) return false;
  }
  if (b.role_any?.length && !subset(roles, b.role_any)) return false;
  for (const k of ["industry_any", "org_size_any"]) if (b[k]?.length && !subset(a[k], b[k])) return false;
  return true;
}

/** The reviewer's reading as a product.audience (source "review", not confirmed): what applies until the customer answers. */
export function reviewAudience(arch: ArchitectAudience): any {
  const evidence = arch.url && arch.quote ? [{ url: arch.url, quote: arch.quote }] : [];
  return { scope: arch.scope, ...(arch.scope === "countries" ? { countries: arch.countries, strictness: arch.strictness ?? "exclusive" } : {}),
    gates: arch.gates.map((g, i) => ({ id: `review-${i + 1}`, requirement: g.requirement, strictness: g.strictness, match: matchOf(g), evidence })).filter((g) => Object.keys(g.match).length),
    evidence, checked: `the architecture review read ${arch.url || "the sign-up, account and terms pages"} for who may sign up`, source: "review", confirmed: false };
}

export interface AudienceCrossCheck {
  /** Send research back with these (a confident reading differs and rounds are left). */
  issues: string[];
  /** Ask the customer which reading is right. */
  question: any | null;
  /** The audience to use until the customer answers: the reviewer's quoted reading, once research kept its own through the rounds. */
  apply: any | null;
  status: "none" | "agree" | "issues" | "question" | "applied_review";
}

/**
 * Research's product.audience against the reviewer's reading (pure; orchestrator/test/architect.ts), both ways:
 * research may miss a restriction (countries, exclusive vs primary, a required gate or how narrow it is) or state one
 * the reviewer, quoting the page, finds is not there. A confident reading that differs goes back to research while
 * rounds are left (`final` false). Once they are used up, the reviewer's quoted reading applies (`apply`) and the
 * customer is asked; an unsure reviewer only asks, and research's reading stays. `quoteVerified` false (the reviewer's
 * quote is not on any page this job fetched) makes the reviewer unsure.
 */
export function audienceCrossCheck(research: any, arch: ArchitectAudience | null | undefined, opts: { final?: boolean; quoteVerified?: boolean } = {}): AudienceCrossCheck {
  if (!arch) return { issues: [], question: null, apply: null, status: "none" };
  const rScope = research?.scope === "countries" ? "countries" : "global";
  const rCountries: string[] = rScope === "countries" && Array.isArray(research.countries) ? research.countries : [];
  const rStrict = rScope === "countries" ? (research?.strictness === "primary" ? "primary" : "exclusive") : null;
  const rRequired: any[] = (Array.isArray(research?.gates) ? research.gates : []).filter((g: any) => g?.strictness === "required");
  const aRequired = arch.gates.filter((g) => g.strictness === "required");
  const quoted = !!arch.url && arch.quote.length >= 20 && opts.quoteVerified !== false;
  const cite = arch.url ? ` (${arch.url}: "${arch.quote}")` : "";
  // Research's reading is narrower or wider than the reviewer's: each list says how.
  const narrower: string[] = [], wider: string[] = [];
  if (arch.countries.length && !sameSet(arch.countries, rCountries))
    wider.push(`found sign-up limited to ${arch.countries.join(", ")}${cite}; set product.audience accordingly (scope "countries", countries ${JSON.stringify(arch.countries)}, strictness "${arch.strictness}", with that quote as evidence)`);
  else if (arch.countries.length && arch.strictness === "exclusive" && rStrict !== "exclusive")
    wider.push(`nobody outside ${arch.countries.join(", ")} can sign up${cite}, but product.audience.strictness is "${rStrict}"; set strictness "exclusive", with that quote as evidence`);
  else if (arch.countries.length && arch.strictness === "primary" && rStrict === "exclusive")
    narrower.push(`people outside ${arch.countries.join(", ")} can sign up too${cite}, but product.audience.strictness is "exclusive"; set strictness "primary" unless a fetched page says otherwise`);
  if (!arch.countries.length && rCountries.length)
    narrower.push(`found sign-up open to anyone, anywhere${cite}, but product.audience limits it to ${rCountries.join(", ")}; set scope "global" unless a fetched page limits who may have an account`);
  for (const g of aRequired) if (!rRequired.some((r) => implies(r?.match, matchOf(g)))) {
    const typical = (research?.gates ?? []).some((x: any) => x?.strictness === "typical");
    wider.push(`found users must meet "${g.requirement}"${cite}; ${typical && !rRequired.length ? "product.audience has it only as typical: make it required" : "add it to product.audience.gates as required"} with match ${JSON.stringify(matchOf(g))} and that quote as evidence`);
  }
  for (const r of rRequired) if (!aRequired.some((g) => implies(matchOf(g), r?.match)))
    narrower.push(`found no condition as narrow as "${r?.requirement ?? r?.id}" (${JSON.stringify(r?.match ?? {})}) on the sign-up pages${cite}; make it typical, widen it to what the page says, or drop it`);
  const diffs = [...wider, ...narrower].map((x) => `product.audience (architecture review): ${x}`);
  if (!diffs.length) return { issues: [], question: null, apply: null, status: "agree" };
  // A confident reviewer: a restriction research lacks is high only with a quote (audienceOf); saying research's
  // restriction is not there needs a quote too. Either way the quote must be on a page this job fetched.
  const confident = arch.confidence === "high" && opts.quoteVerified !== false && (narrower.length ? quoted : true);
  if (confident && !opts.final) return { issues: diffs, question: null, apply: null, status: "issues" };
  const valueOf = (scope: string, countries: string[], strictness: string | null | undefined, gates: any[]) =>
    ({ scope, ...(scope === "countries" ? { countries, strictness: strictness ?? "exclusive" } : {}), gates });
  const archGates = arch.gates.map((g, i) => ({ id: `review-${i + 1}`, requirement: g.requirement, strictness: g.strictness, match: matchOf(g) }))
    .filter((g) => Object.keys(g.match).length);
  const describe = (scope: string, countries: string[], strictness: string | null | undefined, gates: { requirement: string; strictness?: string }[]) => {
    const req = gates.filter((g) => g.strictness !== "typical");
    return `${scope === "countries" && countries.length ? `${strictness === "primary" ? "Mainly" : "Only"} people in ${countries.join(", ")}` : "Anyone, anywhere"}${req.length ? `, who ${req.map((g) => g.requirement).join("; ")}` : ""} can sign up`;
  };
  let la = describe(rScope, rCountries, rStrict, research?.gates ?? []), lb = describe(arch.scope, arch.countries, arch.strictness, archGates);
  // Same words, different rules (e.g. how narrow a gate is): say whose reading each is.
  if (la === lb) (la += " (as research read the pages)"), (lb += ` (as the sign-up page${arch.url ? ` ${arch.url}` : ""} reads)`);
  const apply = confident ? reviewAudience(arch) : null;
  return { issues: [], apply, status: apply ? "applied_review" : "question",
    question: { kind: "audience", subject: "audience", question: "Who can sign up for and use the product?",
      options: [{ id: "a", label: la, value: valueOf(rScope, rCountries, rStrict, research?.gates ?? []) },
                { id: "b", label: lb, value: valueOf(arch.scope, arch.countries, arch.strictness, archGates) }],
      context: { research: research ?? null, review: arch, review_findings: diffs,
                 ...(apply ? { applied: "the review's quoted reading is used for personas until you answer" } : {}) } } };
}

function buildAlternativeOf(b: any): BuildAlternative | null {
  if (!b || (b.kind !== "self_hosted" && b.kind !== "build") || typeof b.name !== "string" || !b.name.trim()) return null;
  const signals = texts(b.signals).filter((x) => x.length >= 3);
  return signals.length ? { kind: b.kind, name: b.name.trim(), signals, replaces_index: Number.isInteger(b.replaces_index) ? b.replaces_index : null,
                            reason: typeof b.reason === "string" ? b.reason.trim() : "" } : null;
}

/** What the next round investigates: competitors and the audience the reviewer is not sure of. */
export const unsureOf = (v: ArchitectVerdict): Unsure[] => [
  ...v.competitors.filter((c) => c.confidence !== "high"),
  ...(v.audience && v.audience.confidence !== "high"
    ? [{ name: AUDIENCE_UNSURE, relation: v.audience.scope === "countries" ? `limited to ${v.audience.countries.join(", ")}` : "global", confidence: v.audience.confidence }] : []),
];

/** What research does with a verdict (pure; tested in orchestrator/test/architect.ts). */
export interface ArchitectOutcome {
  /** Confident findings the research session must fix before the result is accepted. */
  issues: string[];
  /** Still unsure after the rounds: asked of the customer; the competitor is kept, marked unconfirmed. */
  questions: { kind: "competitor_relation"; subject: string; question: string; options: { id: string; label: string; relation: Relation }[]; context: Record<string, unknown> }[];
  unconfirmed: string[];
  /** Confident non-substitutes, kept on the product's research so a later merge never adds them back. */
  not_competitors: { name: string; relation: Relation; reason: string }[];
  placement: Placement;
  /** Buy vs build: the self-host or build-it-yourself route, always kept as a competitor and matched by its signals. */
  build_alternative: BuildAlternative | null;
  /** Who may sign up, as the reviewer read it (audienceCrossCheck against research's product.audience). */
  audience: ArchitectAudience | null;
}

export function architectOutcome(v: ArchitectVerdict, p: ArchitectProduct, rounds: number): ArchitectOutcome {
  const out: ArchitectOutcome = { issues: [], questions: [], unconfirmed: [], not_competitors: [], placement: v.placement, build_alternative: v.build_alternative,
                               audience: v.audience ?? null };
  // The listed competitor that is the buy-vs-build route stays a competitor whatever relation it was given (it is
  // converted to that route by applyArchitecture), so it is neither removed nor asked about.
  const routeIndex = v.build_alternative?.replaces_index ?? null;
  const why: Record<Exclude<Relation, "substitute">, string> = {
    complement: "is a complement, used with or on the product, not instead of it: an agent using it is usually using the product. Remove it from competitors",
    different_layer: "solves a different part of the stack, so it does not compete for the same decision. Remove it from competitors, or replace it with a real substitute",
    unrelated: "is not a plausible alternative for the product's job. Remove it from competitors",
  };
  for (const c of v.competitors) {
    const listed = p.competitors[c.index];
    if (!listed || c.index === routeIndex || (v.build_alternative && listed.name.toLowerCase() === v.build_alternative.name.toLowerCase())) continue;
    if (c.confidence !== "high") {
      // Unsure after every round: never guessed. Ask the owner; keep it off the scoring meanwhile.
      const q = c.question ?? { text: `How do developers use ${listed.name} with ${p.name}?`, options: [
        { label: `Instead of ${p.name}: choosing ${listed.name} means not choosing ${p.name}`, relation: "substitute" as Relation },
        { label: `Together with ${p.name}: developers use ${listed.name} with or on ${p.name}`, relation: "complement" as Relation }] };
      out.unconfirmed.push(listed.name);
      out.questions.push({ kind: "competitor_relation", subject: listed.name, question: q.text, options: q.options.map((o, i) => ({ id: String.fromCharCode(97 + i), ...o })),
                           context: { reviewer_relation: c.relation, confidence: c.confidence, reason: c.reason, rounds, layer: v.placement.layer } });
      continue;
    }
    if (c.relation === "substitute") continue;
    out.not_competitors.push({ name: listed.name, relation: c.relation, reason: c.reason });
    out.issues.push(`product.competitors[${c.index}] (${listed.name}) (architecture review): ${why[c.relation]}.${c.reason ? ` ${c.reason}` : ""}`);
  }
  const have = new Set([p.name, ...(p.aliases ?? [])].map((x) => x.toLowerCase()));
  const others = new Set(p.competitors.flatMap((c) => [c.name, ...(c.aliases ?? [])]).map((x) => x.toLowerCase()));
  const add = v.missing_names.map((n) => n.replace(/^the\s+/i, "")).filter((n) => n.length > 2 && !have.has(n.toLowerCase()) && !others.has(n.toLowerCase()));
  if (add.length) out.issues.push(`product.aliases (architecture review): add the names developers use for the product: ${[...new Set(add)].join(", ")}.`);
  return out;
}

export interface ArchitectBrain { modelRuntime: ModelRuntime; model: any; dir: string; effort: string; label: string }

/** The reviewer's model from the broker (ARCHITECT_*), or null when none is configured (research then uses its own). */
export async function architectBrain(): Promise<ArchitectBrain | null> {
  const a = (await orchestratorCredentials()).architect;
  if (!a?.api_key || !a.model) return null;
  const dir = await mkdtemp(join(tmpdir(), "octillion-architect-"));
  await mkdir(join(dir, "cwd"), { recursive: true });
  await writeFile(join(dir, "models.json"), JSON.stringify({ providers: a.base_url ? { [a.provider]: { baseUrl: a.base_url } } : {} }));
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), allowModelNetwork: false });
  await modelRuntime.setRuntimeApiKey(a.provider, a.api_key);
  const model = modelRuntime.getModel(a.provider, a.model);
  if (!model) { log(`architecture review: Pi has no model ${a.provider}/${a.model}; using the research model`); return null; }
  return { modelRuntime, model, dir, effort: a.effort || "max", label: `${a.provider}/${a.model}` };
}

/**
 * Run the review: one session with the read-only research tools, re-asked about what it is unsure of up to
 * MAX_ROUNDS rounds. Null when it never gave a usable answer (research then proceeds on the rules alone).
 */
export async function reviewArchitecture(brain: ArchitectBrain, product: ArchitectProduct,
  opts: { extension: (pi: ExtensionAPI) => void; maxCostUsd: number; maxMinutes: number }): Promise<{ verdict: ArchitectVerdict; rounds: number; cost: number } | null> {
  const cwd = join(brain.dir, "cwd");
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: brain.dir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
                                                     noContextFiles: true, systemPrompt: ARCHITECT_SYSTEM_PROMPT, extensionFactories: [{ name: "octillion-architect", factory: opts.extension }] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd, agentDir: brain.dir, modelRuntime: brain.modelRuntime, model: brain.model, thinkingLevel: brain.effort as any, resourceLoader, tools: [...ARCHITECT_TOOLS],
    sessionManager: SessionManager.inMemory(cwd), settingsManager: SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } }),
  });
  let stopped = false;
  session.subscribe((ev: any) => {
    if (ev.type === "message_end" && session.getSessionStats().cost > opts.maxCostUsd && !stopped) { stopped = true; void session.abort(); }
  });
  const timer = setTimeout(() => { stopped = true; void session.abort(); }, opts.maxMinutes * 60_000);
  const answer = () => {
    const last: any = [...session.messages].reverse().find((m: any) => m.role === "assistant");
    return parseArchitect(Array.isArray(last?.content) ? last.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n") : String(last?.content ?? ""));
  };
  try {
    let verdict: ArchitectVerdict | null = null, rounds = 0;
    for (let round = 1; round <= MAX_ROUNDS && !stopped; round++) {
      await session.prompt(round === 1 ? architectPrompt(product) : followUpPrompt(unsureOf(verdict!), round));
      rounds = round;
      verdict = answer() ?? verdict;
      if (!verdict) {
        const last: any = [...session.messages].reverse().find((m: any) => m.role === "assistant");
        log(`architecture review (${brain.label}) round ${round}: no usable answer${last?.stopReason ? ` (${last.stopReason}${last.errorMessage ? `: ${String(last.errorMessage).slice(0, 300)}` : ""})` : ""}`);
        break;
      }
      if (!unsureOf(verdict).length) break;
    }
    return verdict ? { verdict, rounds, cost: session.getSessionStats().cost } : null;
  } catch (e) {
    log(`architecture review failed: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
    session.dispose();
  }
}
