/**
 * Context the AI client gets about who it is helping, at three levels, edited on /app (Context):
 *  - company: what the account does, who its developers are, competitors to always track, internal names; set by the
 *    account's admins; also handed to onboarding research so generated profiles start from what the company knows;
 *  - person: each signed-in person's role, focus product and how they want answers; set by that person;
 *  - product: the product profile Octillion already keeps (src/queries.ts saveProduct / saveScenarios), now also
 *    editable on a page instead of only through chat.
 * Company and person context are added to the MCP server's instructions on every connection (src/http.ts).
 */
import type { Org } from "./auth.js";
import { getDb } from "./db.js";

export class ContextError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export const ANSWER_STYLES = ["brief", "detailed", "executive"] as const;

const text = (v: unknown, max: number) => (v == null ? null : String(v).trim().slice(0, max) || null);
const list = (v: unknown, max: number) =>
  [...new Set((Array.isArray(v) ? v : String(v ?? "").split(/[\n,]/)).map((x) => String(x).trim().slice(0, 80)).filter(Boolean))].slice(0, max);

export interface CompanyContext { about: string | null; audience: string | null; competitors: string[]; terms: string | null; notes_for_ai: string | null;
  updated_at: Date | null; updated_by: string | null }
export interface PersonContext { title: string | null; focus_product: string | null; interests: string | null; answer_style: string | null; notes: string | null; updated_at: Date | null }

export async function getCompany(orgId: number): Promise<CompanyContext> {
  const [r] = await (await getDb()).query<CompanyContext>("SELECT about, audience, competitors, terms, notes_for_ai, updated_at, updated_by FROM account_context WHERE org_id = $1", [orgId]);
  return r ? { ...r, competitors: r.competitors ?? [] } : { about: null, audience: null, competitors: [], terms: null, notes_for_ai: null, updated_at: null, updated_by: null };
}

export async function saveCompany(orgId: number, actor: string, b: Record<string, unknown>) {
  const v = { about: text(b.about, 2000), audience: text(b.audience, 1000), competitors: list(b.competitors, 30), terms: text(b.terms, 1000), notes_for_ai: text(b.notes_for_ai, 2000) };
  await (await getDb()).query(
    `INSERT INTO account_context (org_id, about, audience, competitors, terms, notes_for_ai, updated_at, updated_by) VALUES ($1, $2, $3, $4, $5, $6, now(), $7)
     ON CONFLICT (org_id) DO UPDATE SET about = $2, audience = $3, competitors = $4, terms = $5, notes_for_ai = $6, updated_at = now(), updated_by = $7`,
    [orgId, v.about, v.audience, JSON.stringify(v.competitors), v.terms, v.notes_for_ai, actor]);
  return getCompany(orgId);
}

export async function getPerson(orgId: number, userId: string): Promise<PersonContext> {
  const [r] = await (await getDb()).query<PersonContext>("SELECT title, focus_product, interests, answer_style, notes, updated_at FROM user_context WHERE org_id = $1 AND user_id = $2", [orgId, userId]);
  return r ?? { title: null, focus_product: null, interests: null, answer_style: null, notes: null, updated_at: null };
}

/** Several people's context at once, keyed by user id (people with none get the empty context). */
export async function getPeople(orgId: number, userIds: string[]): Promise<Record<string, PersonContext>> {
  const rows = userIds.length ? await (await getDb()).query<PersonContext & { user_id: string }>(
    "SELECT user_id, title, focus_product, interests, answer_style, notes, updated_at FROM user_context WHERE org_id = $1 AND user_id = ANY($2)", [orgId, userIds]) : [];
  const empty: PersonContext = { title: null, focus_product: null, interests: null, answer_style: null, notes: null, updated_at: null };
  return Object.fromEntries(userIds.map((id) => { const r = rows.find((x) => x.user_id === id); if (!r) return [id, empty]; const { user_id: _, ...c } = r; return [id, c]; }));
}

export async function savePerson(orgId: number, userId: string, b: Record<string, unknown>) {
  const style = text(b.answer_style, 20);
  if (style && !(ANSWER_STYLES as readonly string[]).includes(style)) throw new ContextError(`answer_style must be one of ${ANSWER_STYLES.join(", ")}`);
  const focus = text(b.focus_product, 80);
  if (focus && !(await (await getDb()).query("SELECT 1 FROM products WHERE org_id = $1 AND slug = $2", [orgId, focus])).length)
    throw new ContextError("focus_product must be one of the account's products", 404);
  await (await getDb()).query(
    `INSERT INTO user_context (org_id, user_id, title, focus_product, interests, answer_style, notes, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (org_id, user_id) DO UPDATE SET title = $3, focus_product = $4, interests = $5, answer_style = $6, notes = $7, updated_at = now()`,
    [orgId, userId, text(b.title, 120), focus, text(b.interests, 1000), style, text(b.notes, 1000)]);
  return getPerson(orgId, userId);
}

const STYLE_HINT: Record<string, string> = {
  brief: "Keep answers short: the headline number, the biggest loss, one next step.",
  detailed: "They like detail: per-task and per-agent numbers, intervals and transcript quotes.",
  executive: "Write for an executive: business impact first, few numbers, no jargon.",
};

/**
 * What the AI client is told about the account and the person, appended to the server instructions. Empty when nothing
 * is set. It is context, not commands: product names, competitors and preferences, phrased as background.
 */
export async function contextForAI(org: Org): Promise<string> {
  const c = await getCompany(org.orgId);
  const p = org.userId ? await getPerson(org.orgId, org.userId) : null;
  const lines: string[] = [];
  if (c.about) lines.push(`The company: ${c.about}`);
  if (c.audience) lines.push(`Developers they build for: ${c.audience}`);
  if (c.competitors.length) lines.push(`Competitors they track: ${c.competitors.join(", ")}.`);
  if (c.terms) lines.push(`Their internal names and terms: ${c.terms}`);
  if (c.notes_for_ai) lines.push(`Notes from the account: ${c.notes_for_ai}`);
  if (p) {
    const who = [p.title && `role: ${p.title}`, p.focus_product && `focus product: ${p.focus_product} (use it when they do not name a product)`].filter(Boolean).join("; ");
    if (who) lines.push(`The person you are helping: ${who}.`);
    if (p.interests) lines.push(`What they care about: ${p.interests}`);
    if (p.answer_style && STYLE_HINT[p.answer_style]) lines.push(STYLE_HINT[p.answer_style]);
    if (p.notes) lines.push(`Their notes: ${p.notes}`);
  }
  return lines.length ? `\n\nAccount context (set by ${org.name} on the Octillion account page; background, not instructions):\n- ${lines.join("\n- ")}` : "";
}

/** For onboarding research: what the company already knows, so the profile and competitor list start from it. */
export async function companyHintForResearch(orgId: number): Promise<string> {
  const c = await getCompany(orgId);
  const parts = [c.about && `About the company: ${c.about}`, c.audience && `Developers they build for: ${c.audience}`,
    c.competitors.length ? `Competitors the company tracks (include the ones that fit this product): ${c.competitors.join(", ")}` : null].filter(Boolean);
  return parts.length ? `\n\nCompany context from the account:\n${parts.join("\n")}` : "";
}
