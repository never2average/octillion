import { ISO2_NAME, ISO2_NAMES, ISO2_REGION, REGIONS } from "./geo-data.js";

/**
 * Who a shared developer profile is, as structured data: attributes.facets, written from the respondent's own survey
 * answers by vault/build/so_backfill.py (never by a model). Research filters on these (search_profiles) and the server
 * checks every persona pick against the product's audience with them (src/research.ts audienceIssues).
 */

export { REGIONS };
export const SECTORS = ["academia", "government", "finance", "healthcare", "industry"] as const;
/** The survey's Industry answer options (vault/build/so_common.py INDUSTRIES). */
export const INDUSTRIES = ["Software Development", "Internet, Telecomm or Information Services", "Fintech", "Banking/Financial Services",
  "Healthcare", "Manufacturing", "Government", "Higher Education", "Retail and Consumer Services", "Transportation, or Supply Chain",
  "Computer Systems Design and Services", "Media & Advertising Services", "Energy", "Insurance", "Other"] as const;

export interface Facets {
  country?: string; country_name?: string; region?: string; sector?: string; sector_basis?: string[]; research_role?: boolean;
  academic_staff?: boolean;
  dev_type?: string | null; industry_survey?: string; org_size?: string | null; employment?: string[]; ai_agents?: string | null;
}

export const isIso2 = (x: unknown): x is string => typeof x === "string" && x in ISO2_REGION;
export const isRegion = (x: unknown) => (REGIONS as readonly string[]).includes(String(x));
export const isSector = (x: unknown) => (SECTORS as readonly string[]).includes(String(x));
export const isIndustry = (x: unknown) => (INDUSTRIES as readonly string[]).includes(String(x));
export const countryName = (iso: string) => ISO2_NAME[iso] ?? iso;

/** Words that name a country in a search ("Canadian", "Sweden", "US"), case-insensitive except the short codes. */
const NAME_TO_ISO = new Map<string, string>();
for (const [iso, names] of Object.entries(ISO2_NAMES))
  for (const n of names) NAME_TO_ISO.set(n.length <= 4 && n === n.toUpperCase() ? n : n.toLowerCase(), iso);

/** The country a search word names, if any: "Canadian" -> CA. Short codes (US, UK) only in capitals ("us" is a word). */
export function countryOfWord(w: string): string | null {
  return NAME_TO_ISO.get(w) ?? NAME_TO_ISO.get(w.toLowerCase()) ?? null;
}

/** Every text that names a country (its short display name first), for matching prose. */
export const countryTexts = (iso: string) => [...new Set([countryName(iso), ...(ISO2_NAMES[iso] ?? [])])].filter((n) => n.length > 3);

/** A mention of the profile's country in free text (its ISO2 code, or a name or demonym), e.g. in a selection reason. */
export function mentionsCountry(text: string, iso: string): boolean {
  const word = (n: string, flags: string) => new RegExp(`(?<![A-Za-z])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`, flags).test(text);
  return [iso, countryName(iso), ...(ISO2_NAMES[iso] ?? [])].some((n) => (n.length <= 4 && n === n.toUpperCase() ? word(n, "") : word(n, "i")));
}

/**
 * The two affiliations a gate can name (vault/build/so_common.py): research_role is research-affiliated (an academic
 * researcher, a scientist at a university, a student with no job in another industry); academic_staff is a
 * university's technical staff (research software engineers, research-computing staff), who are not researchers.
 */
export const ROLES = ["research_role", "academic_staff"] as const;
export type Role = (typeof ROLES)[number];
export const isRole = (x: unknown): x is Role => (ROLES as readonly string[]).includes(String(x));

/** One gate's match: keys combine with AND, the values inside one key with OR ("researchers or academic staff" is
 *  role_any: ["research_role", "academic_staff"]). */
export interface GateMatch { sector_any?: string[]; research_role?: boolean; academic_staff?: boolean; role_any?: Role[]; industry_any?: string[]; org_size_any?: string[] }

/** Why a profile fails a gate's match (empty when it passes). */
export function gateMisses(f: Facets | null | undefined, m: GateMatch): string[] {
  const out: string[] = [];
  if (m.sector_any?.length && !m.sector_any.includes(String(f?.sector))) out.push(`has sector ${f?.sector ?? "unknown"}, not ${m.sector_any.join(" or ")}`);
  for (const k of ROLES) if (typeof m[k] === "boolean" && f?.[k] !== m[k])
    out.push(`${f?.sector ? `has sector ${f.sector} but ` : ""}${k} ${f?.[k] ?? "unknown"}`);
  if (m.role_any?.length && !m.role_any.some((k) => f?.[k] === true))
    out.push(`${f?.sector ? `has sector ${f.sector} but ` : ""}is neither ${m.role_any.join(" nor ")}`);
  if (m.industry_any?.length && !m.industry_any.includes(String(f?.industry_survey))) out.push(`is in ${f?.industry_survey ?? "an unknown industry"}, not ${m.industry_any.join(" or ")}`);
  if (m.org_size_any?.length && !m.org_size_any.includes(String(f?.org_size))) out.push(`works at ${f?.org_size ?? "an unknown size"}, not ${m.org_size_any.join(" or ")}`);
  return out;
}

/** SQL for a gate's match over developer_profiles.attributes (same semantics as gateMisses); pushes its params. */
export function gateSql(m: GateMatch, params: unknown[]): string {
  const parts: string[] = [];
  const f = (k: string) => `(attributes->'facets'->>'${k}')`;
  if (m.sector_any?.length) { params.push(m.sector_any); parts.push(`${f("sector")} = ANY($${params.length})`); }
  for (const k of ROLES) if (typeof m[k] === "boolean") { params.push(String(m[k])); parts.push(`${f(k)} = $${params.length}`); }
  // Only the two known facet names reach the SQL text (isRole), never a model's string.
  if (m.role_any?.length) parts.push(`(${m.role_any.filter(isRole).map((k) => `${f(k)} = 'true'`).join(" OR ") || "false"})`);
  if (m.industry_any?.length) { params.push(m.industry_any); parts.push(`${f("industry_survey")} = ANY($${params.length})`); }
  if (m.org_size_any?.length) { params.push(m.org_size_any); parts.push(`${f("org_size")} = ANY($${params.length})`); }
  return parts.length ? parts.join(" AND ") : "true";
}
