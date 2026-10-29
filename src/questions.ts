import { randomBytes } from "node:crypto";
import { getDb } from "./db.js";
import { resolveProduct } from "./queries.js";
import { keepAlive } from "./telemetry.js";
import { audienceFormIssues, describeAudience, hardKey, hardMisses, mergeAudience, type Audience } from "./audience.js";
import type { Org } from "./auth.js";
import type { Tool } from "./scoring.js";

/**
 * Questions research asks the customer (sql/migrations/0006_product_questions.sql, 0007_audience_questions.sql):
 *
 *   competitor_relation   the architecture review (orchestrator/pi-octillion/architect.ts) could not tell, after its
 *                         rounds, whether a tool competes with the product or is used with it. The tool stays on the
 *                         product marked unconfirmed (left out of scoring) and the customer picks the description that
 *                         fits. A "substitute" answer confirms it as a competitor; any other removes it and records it
 *                         as not competing (products.research.not_competitors), so research never adds it back. Either
 *                         way the product's sessions are scored again (worker.ts rescoreProduct).
 *   audience              who may use the product (src/audience.ts) is unsure (research and the architecture review
 *                         disagree), or nobody in the developer-profile data fits it (subject 'persona_supply'). Each
 *                         option carries an audience value; the answer is merged into products.research.audience as
 *                         the customer's (confirmed), personas that can no longer use the product are unlinked, and
 *                         research runs again to pick personas for the confirmed audience.
 *
 * Asked from the worker API when research completes (the app's role); listed and answered by the account (tenant scope).
 */

export type QuestionKind = "competitor_relation" | "audience";
export interface QuestionOption { id: string; label: string; relation?: string; value?: Record<string, unknown> }
export interface AskedQuestion { kind: QuestionKind; subject: string; question: string; options: QuestionOption[]; context?: Record<string, unknown> }

const RELATIONS = new Set(["substitute", "complement", "different_layer", "unrelated"]);

/** The options a question may carry, by kind; invalid ones are dropped (a question needs two). */
function validOptions(q: AskedQuestion): QuestionOption[] {
  const base = (q.options ?? []).filter((o) => o?.label);
  const ok = q.kind === "competitor_relation" ? base.filter((o) => RELATIONS.has(String(o.relation)))
    : q.kind === "audience" ? base.filter((o) => o.value && !audienceFormIssues(o.value, { sources: null, partial: true, where: "value" }).length)
    : [];
  return ok.slice(0, 4).map((o, i) => ({ id: o.id || String.fromCharCode(97 + i), label: String(o.label).slice(0, 300),
    ...(q.kind === "competitor_relation" ? { relation: o.relation } : { value: o.value }) }));
}

/**
 * Store research's questions. An open competitor question about the same tool stays as it is. An open audience
 * question with the same subject but other options (asked about an audience since changed) is dismissed and the new
 * one asked in its place: answering the old one would merge an audience nobody holds any more.
 */
export async function askQuestions(orgId: number, productId: number, researchId: string, qs: AskedQuestion[]): Promise<number> {
  const db = await getDb();
  let n = 0;
  for (const q of qs.slice(0, 10)) {
    const options = validOptions(q);
    if ((q.kind !== "competitor_relation" && q.kind !== "audience") || !q.subject?.trim() || !q.question?.trim() || options.length < 2) continue;
    if (q.kind === "audience")
      await db.query(
        `/* tenant: research job's own product (job checked against the job token in http.ts) */ UPDATE product_questions
            SET status = 'dismissed', answered_at = now(), answer = jsonb_build_object('replaced', true, 'by_research', $5::text)
          WHERE org_id = $1 AND product_id = $2 AND kind = 'audience' AND lower(subject) = lower($3) AND status = 'open' AND options <> $4::jsonb`,
        [orgId, productId, q.subject.trim().slice(0, 120), JSON.stringify(options), researchId]);
    const rows = await db.query(
      `/* tenant: research job's own product (job checked against the job token in http.ts) */ INSERT INTO product_questions (id, org_id, product_id, research_id, kind, subject, question, options, context)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING RETURNING id`,
      [`pq_${randomBytes(9).toString("base64url")}`, orgId, productId, researchId, q.kind, q.subject.trim().slice(0, 120), q.question.trim().slice(0, 500),
       JSON.stringify(options), q.context ? JSON.stringify(q.context).slice(0, 4000) : null]);
    n += rows.length;
  }
  return n;
}

export async function listQuestions(org: Org, input: { product?: string; status?: "open" | "answered" | "all" } = {}) {
  const db = await getDb();
  const p = input.product ? await resolveProduct(org, input.product) : null;
  const status = input.status ?? "open";
  const rows = await db.query<{ id: string; product: string; product_slug: string; kind: string; subject: string; question: string; options: QuestionOption[];
                                context: Record<string, unknown> | null; status: string; answer: unknown; answered_by: string | null; created_at: Date; answered_at: Date | null }>(
    `SELECT q.id, p.name AS product, p.slug AS product_slug, q.kind, q.subject, q.question, q.options, q.context, q.status, q.answer, q.answered_by, q.created_at, q.answered_at
       FROM product_questions q JOIN products p ON p.id = q.product_id
      WHERE q.org_id = $1 ${p ? "AND q.product_id = $2" : ""} ${status === "all" ? "" : `AND q.status = '${status === "answered" ? "answered" : "open"}'`}
      ORDER BY q.created_at DESC LIMIT 50`,
    p ? [org.orgId, p.id] : [org.orgId]);
  return { view: "questions" as const, questions: rows };
}

/** Answer a question with one of its options (and an optional note); applies it to the product. */
export async function answerQuestion(org: Org, input: { question_id: string; option: string; note?: string }, by: string | null) {
  const db = await getDb();
  const [q] = await db.query<{ id: string; product_id: number; kind: QuestionKind; subject: string; options: QuestionOption[]; status: string }>(
    "SELECT id, product_id, kind, subject, options, status FROM product_questions WHERE id = $1 AND org_id = $2", [input.question_id, org.orgId]);
  if (!q) throw Object.assign(new Error(`No question ${input.question_id}`), { status: 404 });
  if (q.status === "dismissed") throw Object.assign(new Error("This question was replaced by a newer one: see list_product_questions"), { status: 409 });
  if (q.status !== "open") throw Object.assign(new Error("This question was already answered"), { status: 409 });
  const opt = q.options.find((o) => o.id === input.option || o.label === input.option);
  if (!opt) throw Object.assign(new Error(`Pick one of the options: ${q.options.map((o) => `${o.id} (${o.label})`).join("; ")}`), { status: 400 });
  if (q.kind === "audience") return answerAudience(org, q, opt, input.note, by);

  const [p] = await db.query<{ competitors: Tool[] | null; research: Record<string, any> | null }>(
    "SELECT competitors, research FROM products WHERE id = $1 AND org_id = $2", [q.product_id, org.orgId]);
  const subject = q.subject.toLowerCase();
  const isSubject = (c: Tool) => c.name.trim().toLowerCase() === subject;
  const competing = opt.relation === "substitute";
  const competitors = competing
    ? (p?.competitors ?? []).map((c) => (isSubject(c) ? { ...c, unconfirmed: undefined } : c)).map(({ unconfirmed, ...c }) => (unconfirmed ? { ...c, unconfirmed } : c))
    : (p?.competitors ?? []).filter((c) => !isSubject(c));
  const research = { ...(p?.research ?? {}) };
  if (!competing)
    research.not_competitors = [...(research.not_competitors ?? []).filter((x: { name: string }) => x.name.toLowerCase() !== subject),
      { name: q.subject, relation: opt.relation, reason: `the customer: ${opt.label}${input.note ? ` (${input.note.slice(0, 300)})` : ""}` }];
  await db.transaction(async (tx) => {
    await tx.query("UPDATE products SET competitors = $3, research = $4, updated_at = now() WHERE id = $1 AND org_id = $2",
      [q.product_id, org.orgId, JSON.stringify(competitors), JSON.stringify(research)]);
    await tx.query("UPDATE product_questions SET status = 'answered', answer = $3, answered_by = $4, answered_at = now() WHERE id = $1 AND org_id = $2",
      [q.id, org.orgId, JSON.stringify({ option: opt.id, label: opt.label, relation: opt.relation, ...(input.note ? { note: input.note.slice(0, 500) } : {}) }), by]);
  });
  // Past sessions are scored again with the corrected list (in the background; the Pick rate page updates as it goes).
  keepAlive((await import("./worker.js")).rescoreProduct(q.product_id).catch((e) => console.error(`rescore after question ${q.id}:`, (e as Error).message)));
  return { view: "question_answered" as const, question_id: q.id, subject: q.subject, answer: opt.label,
           effect: competing ? `${q.subject} now counts as a competitor` : `${q.subject} is no longer treated as a competitor`, rescoring: true };
}

/**
 * The customer said who may use the product: it becomes the confirmed audience, linked personas that can no longer
 * use the product are unlinked (kept for history, inactive), and research runs again to pick personas who can.
 */
async function answerAudience(org: Org, q: { id: string; product_id: number; subject: string }, opt: QuestionOption, note: string | undefined, by: string | null) {
  const db = await getDb();
  const [p] = await db.query<{ research: Record<string, any> | null }>("SELECT research FROM products WHERE id = $1 AND org_id = $2", [q.product_id, org.orgId]);
  const audience: Audience = mergeAudience((p?.research?.audience as Audience) ?? null, (opt.value ?? {}) as Partial<Audience>, note);
  const bad = audienceFormIssues(audience, { sources: null });
  if (bad.length) throw Object.assign(new Error(`That answer does not give a usable audience: ${bad.join("; ")}`), { status: 400 });
  // The same matcher as the persona checks (src/audience.ts hardMisses), on the profiles' survey facets.
  const linked = await db.query<{ profile_id: number; slug: string; facets: any }>(
    `SELECT pp.profile_id, dp.slug, dp.attributes->'facets' AS facets FROM product_personas pp JOIN developer_profiles dp ON dp.id = pp.profile_id
      JOIN products p ON p.id = pp.product_id AND p.org_id = $1 WHERE pp.product_id = $2 AND pp.active`, [org.orgId, q.product_id]);
  const unfit = linked.filter((x) => hardMisses(audience, x.facets).length);
  const [last] = await db.query<{ input: Record<string, any> | null }>(
    "SELECT input FROM product_research WHERE org_id = $1 AND product_id = $2 AND kind = 'product' ORDER BY created_at DESC LIMIT 1", [org.orgId, q.product_id]);
  await db.transaction(async (tx) => {
    // Only the audience key: a research completing meanwhile keeps everything else it wrote.
    await tx.query("UPDATE products SET research = jsonb_set(coalesce(research, '{}'::jsonb), '{audience}', $3::jsonb), updated_at = now() WHERE id = $1 AND org_id = $2",
      [q.product_id, org.orgId, JSON.stringify(audience)]);
    if (unfit.length)
      await tx.query("UPDATE product_personas SET active = false WHERE product_id = $1 AND profile_id = ANY($2) AND product_id IN (SELECT id FROM products WHERE org_id = $3)",
        [q.product_id, unfit.map((x) => x.profile_id), org.orgId]);
    await tx.query("UPDATE product_questions SET status = 'answered', answer = $3, answered_by = $4, answered_at = now() WHERE id = $1 AND org_id = $2",
      [q.id, org.orgId, JSON.stringify({ option: opt.id, label: opt.label, value: opt.value ?? null, ...(note ? { note: note.slice(0, 500) } : {}) }), by]);
  });
  // Research again, with the confirmed audience in its brief, so the personas are re-picked from those who may use it.
  // Not when the customer only confirmed what research found nobody for (persona_supply, same hard parts): it would
  // find the same gap; personas are picked once matching profiles are added to the data.
  // Compared with the defaults filled in (hardKey): an audience stored without a strictness is exclusive, the same as
  // the answer that spells it out, so confirming it does not queue research that would find the same gap again.
  if (q.subject === "persona_supply" && hardKey(p?.research?.audience) === hardKey(audience)) {
    return { view: "question_answered" as const, question_id: q.id, subject: q.subject, answer: opt.label,
             effect: `Who can use the product: ${describeAudience(audience)} (confirmed). No developer profile in the data fits yet; research will pick personas once matching profiles are added.`,
             unlinked: unfit.map((x) => x.slug), research_id: null, rescoring: false };
  }
  // Personas only: the product's profile, tasks, aliases and competitors stay as they are (a full research would
  // replace them); the confirmed audience reaches research at claim as final (src/research.ts withStoredProduct).
  const research_id = await queuePersonasResearch(org.orgId, q.product_id, last?.input ?? {});
  return { view: "question_answered" as const, question_id: q.id, subject: q.subject, answer: opt.label,
           effect: `Who can use the product: ${describeAudience(audience)}. ${unfit.length ? `${unfit.length} persona(s) who cannot use it were unlinked (${unfit.map((x) => x.slug).join(", ")}); ` : ""}research is re-selecting personas.`,
           unlinked: unfit.map((x) => x.slug), research_id, rescoring: false };
}

/** Queue research that only re-selects a product's personas for its audience (src/research.ts completePersonasOnly). */
export async function queuePersonasResearch(orgId: number, productId: number, base: Record<string, any>): Promise<string> {
  const { queueResearch } = await import("./research.js");
  // The audience is read from the product at claim (src/research.ts withStoredProduct), never carried in the input.
  const { confirmed_audience: _c, product_profile: _p, audience: _a, not_competitors: _n, ...input } = base;
  return queueResearch(orgId, productId, { ...input, personas_only: true,
    prompt: String(input.prompt ?? "").replace(/\n\nThe customer confirmed who can use the product[\s\S]*$/, "") });
}
