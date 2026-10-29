import { INDUSTRIES, ROLES, SECTORS, countryName, gateMisses, gateSql, isIndustry, isIso2, isRole, isSector, type Facets, type GateMatch } from "./facets.js";

/**
 * Who can actually use a product: product.audience, stated by research with evidence and checked by the server.
 *
 *   scope       "global" (the default: anyone may sign up) or "countries" (users must be in one of `countries`)
 *   strictness  for countries: "exclusive" (nobody outside them can use it; a hard rule) or "primary" (mostly there)
 *   gates       eligibility beyond geography (an academic affiliation, a sponsor, a regulated industry), each matched
 *               against the profile facets (src/facets.ts) and "required" (hard) or "typical" (soft)
 *   evidence    a quote from a page fetched in this job, for every restriction: the default is global, and a product is
 *               never narrowed on a guess (a headquarters, customer logos or cloud regions are not restrictions)
 *
 * Hard parts (exclusive countries, required gates) reject any persona pick that fails them; soft parts (primary
 * countries, typical gates) need at least half the picks to match. No rule names a product: everything here reads only
 * the audience and the facets.
 */

export interface Evidence { url: string; quote: string }
export interface AudienceGate { id: string; requirement: string; strictness: "required" | "typical"; match: GateMatch; evidence?: Evidence[] }
export interface Audience {
  scope: "global" | "countries";
  countries?: string[];
  strictness?: "exclusive" | "primary";
  gates?: AudienceGate[];
  evidence?: Evidence[];
  /** What was read to decide (the sign-up, account, eligibility and terms pages): 30+ characters. */
  checked: string;
  source?: "research" | "customer";
  confirmed?: boolean;
  customer_note?: string;
}
/** Research found nobody in the data who may use the product: what it searched, instead of padding with others. */
export interface AudienceGap { searched: string[]; note: string }

export const RESTRICTION_UNCITED = "audience restricts users but cites no fetched page; set scope global or cite the sign-up/eligibility page";
/** The same normalisation as a decision's evidence_url against the job's sources. */
export const urlNorm = (u: unknown) => String(u ?? "").replace(/[#?].*$/, "").replace(/\/$/, "");

/** Whether a cited page counts: one the server recorded for the job (src/research.ts audienceEvidenceIssues). */
export type CitedPage = (url: string) => boolean;
/** `sources` null: the customer stated it, and their word is the evidence. */
const cited = (ev: unknown, sources: CitedPage | null) => sources == null ||
  (Array.isArray(ev) && ev.some((e: any) => typeof e?.quote === "string" && e.quote.trim().length >= 20 && typeof e?.url === "string" && sources(e.url)));

/** Every evidence entry of an audience's restrictions (the countries and the required gates), with where it sits. */
export function restrictionEvidence(a: any): { where: string; evidence: unknown }[] {
  if (!a || typeof a !== "object") return [];
  return [...(a.scope === "countries" ? [{ where: "product.audience", evidence: a.evidence }] : []),
          ...(Array.isArray(a.gates) ? a.gates : []).flatMap((g: any, i: number) => (g?.strictness === "required" ? [{ where: `product.audience.gates[${i}]`, evidence: g.evidence }] : []))];
}

function matchIssues(m: any, where: string): string[] {
  const out: string[] = [];
  const known = ["sector_any", "research_role", "academic_staff", "role_any", "industry_any", "org_size_any"];
  if (!m || typeof m !== "object" || Array.isArray(m)) return [`${where}.match must be {${known.map((k) => `${k}?`).join(", ")}}`];
  const extra = Object.keys(m).filter((k) => !known.includes(k));
  if (extra.length) out.push(`${where}.match has unknown keys ${extra.join(", ")}; use ${known.join(", ")}`);
  if (!known.some((k) => m[k] != null)) out.push(`${where}.match needs at least one of ${known.join(", ")}`);
  if (m.sector_any != null && (!Array.isArray(m.sector_any) || !m.sector_any.length || m.sector_any.some((s: unknown) => !isSector(s))))
    out.push(`${where}.match.sector_any must be a list of ${SECTORS.join(", ")}`);
  for (const k of ROLES) if (m[k] != null && typeof m[k] !== "boolean") out.push(`${where}.match.${k} must be true or false`);
  if (m.role_any != null && (!Array.isArray(m.role_any) || !m.role_any.length || m.role_any.some((s: unknown) => !isRole(s))))
    out.push(`${where}.match.role_any must be a list of ${ROLES.join(", ")} (any of them passes)`);
  if (m.industry_any != null && (!Array.isArray(m.industry_any) || !m.industry_any.length || m.industry_any.some((s: unknown) => !isIndustry(s))))
    out.push(`${where}.match.industry_any must be a list of the survey's industries: ${INDUSTRIES.join("; ")}`);
  if (m.org_size_any != null && (!Array.isArray(m.org_size_any) || !m.org_size_any.length || m.org_size_any.some((s: unknown) => typeof s !== "string")))
    out.push(`${where}.match.org_size_any must be a list of the survey's organisation sizes`);
  return out;
}

/**
 * Everything wrong with an audience. `sources`: which cited pages count (the server's record of the job's pages:
 * src/research.ts audienceEvidenceIssues; a URL-shape check alone in the job-less validator), every restriction
 * quoting one (null for an audience the customer stated: their word is the evidence). `partial`: a customer-question option's value, merged
 * into the stored audience, so only the fields it has are checked.
 */
export function audienceFormIssues(a: any, opts: { sources: CitedPage | null; where?: string; partial?: boolean }): string[] {
  const where = opts.where ?? "product.audience";
  if (!a || typeof a !== "object" || Array.isArray(a))
    return [`${where} is required: who may use the product, {"scope": "global", "checked": "<the sign-up, account and terms pages you read>"} unless a fetched page restricts it`];
  const out: string[] = [];
  const partial = opts.partial === true;
  if (!(partial && a.scope === undefined) && a.scope !== "global" && a.scope !== "countries") out.push(`${where}.scope must be "global" or "countries"`);
  if (!partial && (typeof a.checked !== "string" || a.checked.trim().length < 30))
    out.push(`${where}.checked: list the pages you read to decide who may sign up (30+ characters)`);
  if (a.scope === "countries") {
    if (!Array.isArray(a.countries) || !a.countries.length) out.push(`${where}.countries: list the ISO2 codes of the countries it serves (e.g. ["CA"])`);
    else { const bad = a.countries.filter((c: unknown) => !isIso2(c)); if (bad.length) out.push(`${where}.countries has unknown ISO2 codes: ${bad.join(", ")}`); }
    if (a.strictness != null && a.strictness !== "exclusive" && a.strictness !== "primary") out.push(`${where}.strictness must be "exclusive" or "primary"`);
    if (opts.sources && !cited(a.evidence, opts.sources)) out.push(`${where}: ${RESTRICTION_UNCITED}`);
  } else if (a.countries?.length && a.scope === "global") out.push(`${where}.countries: a global audience lists no countries`);
  if (a.gates != null) {
    if (!Array.isArray(a.gates)) out.push(`${where}.gates must be a list`);
    else a.gates.forEach((g: any, i: number) => {
      const w = `${where}.gates[${i}]`;
      if (typeof g?.id !== "string" || !g.id.trim()) out.push(`${w}.id is required`);
      if (typeof g?.requirement !== "string" || g.requirement.trim().length < 5) out.push(`${w}.requirement: say what a user must be or have`);
      if (g?.strictness !== "required" && g?.strictness !== "typical") out.push(`${w}.strictness must be "required" or "typical"`);
      out.push(...matchIssues(g?.match, w));
      if (g?.strictness === "required" && opts.sources && !cited(g.evidence, opts.sources)) out.push(`${w}: ${RESTRICTION_UNCITED}`);
    });
  }
  return out;
}

/** The audience a pick is checked against: what the customer confirmed wins over research's own reading. */
export function effectiveAudience(stored: any, research: any): Audience | null {
  if (stored && stored.confirmed === true && stored.source === "customer") return stored as Audience;
  return research && typeof research === "object" ? (research as Audience) : null;
}

const exclusive = (a: Audience) => a.scope === "countries" && (a.strictness ?? "exclusive") === "exclusive" && (a.countries?.length ?? 0) > 0;
const firstEvidence = (ev?: Evidence[]) => (ev?.[0]?.url ? ` (evidence: ${ev[0].url})` : "");
export const describeMatch = (m: GateMatch) => [m.sector_any?.length ? `sector ${m.sector_any.join(" or ")}` : "",
  ...ROLES.map((k) => (typeof m[k] === "boolean" ? `${k} ${m[k]}` : "")), m.role_any?.length ? `${m.role_any.join(" or ")}` : "",
  m.industry_any?.length ? `industry ${m.industry_any.join(" or ")}` : "", m.org_size_any?.length ? `org size ${m.org_size_any.join(" or ")}` : ""].filter(Boolean).join(" and ");

/** Why one profile can never use the product (its hard parts), as phrases; empty when it may. */
export function hardMisses(a: Audience | null, f: Facets | null | undefined): string[] {
  if (!a) return [];
  const out: string[] = [];
  if (exclusive(a)) {
    if (!f?.country) out.push(`has no country in the data; the product serves only ${a.countries!.join(", ")}${firstEvidence(a.evidence)}`);
    else if (!a.countries!.includes(f.country)) out.push(`is in ${f.country}; the product serves only ${a.countries!.join(", ")}${firstEvidence(a.evidence)}`);
  }
  for (const g of a.gates ?? []) if (g.strictness === "required") {
    const miss = gateMisses(f, g.match);
    if (miss.length) out.push(`${miss.join(", ")}; gate '${g.requirement}' requires ${describeMatch(g.match)}`);
  }
  return out;
}

/** A gate match with its keys and lists in one order, so two spellings of the same rule compare equal. */
const normMatch = (m: GateMatch | undefined) => Object.fromEntries(Object.entries(m ?? {}).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length))
  .map(([k, v]) => [k, Array.isArray(v) ? [...v].map(String).sort() : v] as const).sort(([x], [y]) => x.localeCompare(y)));

/**
 * The hard parts of an audience (what hardMisses and hardSql enforce) as one comparable string, with the defaults
 * filled in: unset strictness is exclusive, a global or primary market restricts no country, typical gates are not
 * hard. Two audiences with the same key accept and reject exactly the same profiles.
 */
export function hardKey(a: Partial<Audience> | null | undefined): string {
  const countries = a && exclusive(a as Audience) ? [...a.countries!].sort() : [];
  const gates = (a?.gates ?? []).filter((g) => g?.strictness === "required").map((g) => JSON.stringify(normMatch(g.match))).sort();
  return JSON.stringify({ countries, gates });
}

/** The search that finds eligible profiles, as search_profiles arguments (named in the issues so research can run it). */
export function eligibleSearch(a: Audience): Record<string, unknown> {
  const s: Record<string, unknown> = {};
  if (a.scope === "countries" && a.countries?.length) s.country = a.countries;
  const req = (a.gates ?? []).find((g) => g.strictness === "required");
  if (req?.match.sector_any?.length) s.sector = req.match.sector_any;
  for (const k of ROLES) if (typeof req?.match[k] === "boolean") s[k] = req.match[k];
  if (req?.match.role_any?.length) s.role_any = req.match.role_any;
  if (req?.match.industry_any?.length) s.industry = req.match.industry_any;
  return s;
}

/** The hard parts as one SQL condition over developer_profiles (the same rules as hardMisses); pushes its params. */
export function hardSql(a: Audience, params: unknown[]): string {
  const parts: string[] = [];
  if (exclusive(a)) { params.push(a.countries); parts.push(`(attributes->'facets'->>'country') = ANY($${params.length})`); }
  for (const g of a.gates ?? []) if (g.strictness === "required") parts.push(`(${gateSql(g.match, params)})`);
  return parts.length ? parts.join(" AND ") : "true";
}

export interface Pick { slug: string; name: string; facets: Facets | null }

/** The persona picks against the audience: hard failures name the profile and the fix; soft parts need half to match. */
export function pickIssues(a: Audience | null, picks: Pick[]): string[] {
  if (!a || !picks.length) return [];
  const out: string[] = [];
  picks.forEach((p, i) => {
    for (const m of hardMisses(a, p.facets)) {
      const search = JSON.stringify(eligibleSearch(a));
      out.push(`personas[${i}] ${p.slug} ${p.name} ${m}. search_profiles ${search}`);
    }
  });
  out.push(...softIssues(a, picks));
  const names = new Map<string, number>();
  for (const p of picks) names.set(p.name, (names.get(p.name) ?? 0) + 1);
  for (const [n, c] of names) if (c > 1) out.push(`${c} personas share the display name "${n}"; pick profiles with distinct names`);
  return out;
}

/** The soft parts (a primary market, typical gates): at least half the picks must match each. */
export function softIssues(a: Audience | null, picks: Pick[]): string[] {
  if (!a || !picks.length) return [];
  const out: string[] = [];
  const half = Math.ceil(picks.length / 2);
  if (a.scope === "countries" && a.strictness === "primary" && a.countries?.length) {
    const k = picks.filter((p) => p.facets?.country && a.countries!.includes(p.facets.country)).length;
    if (k < half) out.push(`only ${k} of ${picks.length} personas are in ${a.countries.map(countryName).join(" or ")}, the product's main market; at least ${half} must be (search_profiles {"country": ${JSON.stringify(a.countries)}})`);
  }
  for (const g of a.gates ?? []) if (g.strictness === "typical") {
    const k = picks.filter((p) => !gateMisses(p.facets, g.match).length).length;
    if (k < half) out.push(`only ${k} of ${picks.length} personas match '${g.requirement}' (${describeMatch(g.match)}), the product's typical user; at least ${half} must`);
  }
  return out;
}

/**
 * Personas named explicitly for a run (run_simulation profiles) against the audience. Hard parts refuse the run: a
 * profile that fails an exclusive market or a required gate, or a generic developer (profiles: [], no country or
 * affiliation) when the audience has any. Soft parts only warn, in the run's result. Picks are shared profiles; the
 * account's own personas are its choice and are not checked.
 */
export function runPersonaCheck(a: Audience | null, picks: Pick[], generic: boolean): { refuse: string[]; warn: string[] } {
  if (!a) return { refuse: [], warn: [] };
  const who = generic ? [{ slug: "a generic developer (profiles: [])", name: "", facets: null } as Pick] : picks;
  const refuse = who.flatMap((p) => hardMisses(a, p.facets).map((m) => `${p.slug} ${m}`));
  const warn = refuse.length ? [] : softIssues(a, who);
  return { refuse, warn };
}

export const NO_ELIGIBLE_PERSONAS = "No eligible personas for this product's audience yet: no developer profile in the data can use it as its audience describes (see the open audience question)";

/** The audience in a sentence, for the customer. */
export function describeAudience(a: Audience): string {
  const where = a.scope === "countries" && a.countries?.length
    ? `${a.strictness === "primary" ? "mainly " : "only "}users in ${a.countries.map(countryName).join(", ")}` : "users anywhere";
  const gates = (a.gates ?? []).filter((g) => g.strictness === "required").map((g) => g.requirement);
  return `${where}${gates.length ? `, who must meet: ${gates.join("; ")}` : ""}`;
}

/** Asked when research finds nobody eligible: is the audience right, or wider than the pages say? */
export function personaSupplyQuestion(a: Audience, gap: AudienceGap) {
  const required = (a.gates ?? []).filter((g) => g.strictness === "required");
  const options: { id: string; label: string; value: Record<string, unknown> }[] = [
    { id: "a", label: "That is right: wait until developer profiles who fit are added", value: { scope: a.scope, ...(a.countries ? { countries: a.countries, strictness: a.strictness ?? "exclusive" } : {}), gates: a.gates ?? [] } },
  ];
  if (a.scope === "countries") options.push({ id: "b", label: `Developers outside ${a.countries!.map(countryName).join(", ")} can use it too`, value: { scope: "global" } });
  if (required.length) options.push({ id: String.fromCharCode(97 + options.length), label: `Most users meet "${required.map((g) => g.requirement).join("; ")}", but it is not required`,
                                      value: { gates: (a.gates ?? []).map((g) => ({ ...g, strictness: "typical" })) } });
  if (options.length < 2) options.push({ id: "b", label: "Any developer can use it", value: { scope: "global", gates: [] } });
  return { kind: "audience" as const, subject: "persona_supply",
           question: `Research found no developer in Octillion's data who can use the product as its pages describe (${describeAudience(a)}). Is that who can use it?`,
           options, context: { searched: gap.searched, note: gap.note, audience: a } };
}

/** Merge a customer's answer into the stored audience (a question option's value), confirmed by them. */
export function mergeAudience(base: Audience | null, value: Partial<Audience>, note?: string): Audience {
  const merged: any = { ...(base ?? { scope: "global", checked: "" }), ...value };
  if (merged.scope === "global") { delete merged.countries; delete merged.strictness; }
  return { ...merged, checked: merged.checked || "confirmed by the customer in answer to a question", source: "customer", confirmed: true,
           ...(note ? { customer_note: [base?.customer_note, note.slice(0, 500)].filter(Boolean).join(" | ") } : {}) };
}
