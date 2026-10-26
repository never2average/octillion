import { randomBytes } from "node:crypto";
import { getDb } from "./db.js";
import { resolveProduct } from "./queries.js";
import { keepAlive } from "./telemetry.js";
import type { Org } from "./auth.js";
import type { Tool } from "./scoring.js";

/**
 * Questions research asks the customer (sql/migrations/0006_product_questions.sql). Today one kind:
 *
 *   competitor_relation   the architecture review (orchestrator/pi-octillion/architect.ts) could not tell, after its
 *                         rounds, whether a tool competes with the product or is used with it. The tool stays on the
 *                         product marked unconfirmed (left out of scoring) and the customer picks the description that
 *                         fits. A "substitute" answer confirms it as a competitor; any other removes it and records it
 *                         as not competing (products.research.not_competitors), so research never adds it back. Either
 *                         way the product's sessions are scored again (worker.ts rescoreProduct).
 *
 * Asked from the worker API when research completes (the app's role); listed and answered by the account (tenant scope).
 */

export interface QuestionOption { id: string; label: string; relation: string }
export interface AskedQuestion { kind: "competitor_relation"; subject: string; question: string; options: QuestionOption[]; context?: Record<string, unknown> }

const RELATIONS = new Set(["substitute", "complement", "different_layer", "unrelated"]);

/** Store research's questions; an open question about the same tool stays as it is. */
export async function askQuestions(orgId: number, productId: number, researchId: string, qs: AskedQuestion[]): Promise<number> {
  const db = await getDb();
  let n = 0;
  for (const q of qs.slice(0, 10)) {
    const options = (q.options ?? []).filter((o) => o?.label && RELATIONS.has(o.relation)).slice(0, 4)
      .map((o, i) => ({ id: o.id || String.fromCharCode(97 + i), label: String(o.label).slice(0, 300), relation: o.relation }));
    if (q.kind !== "competitor_relation" || !q.subject?.trim() || !q.question?.trim() || options.length < 2) continue;
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

/** Answer a question with one of its options (and an optional note); applies it to the product and rescores. */
export async function answerQuestion(org: Org, input: { question_id: string; option: string; note?: string }, by: string | null) {
  const db = await getDb();
  const [q] = await db.query<{ id: string; product_id: number; subject: string; options: QuestionOption[]; status: string }>(
    "SELECT id, product_id, subject, options, status FROM product_questions WHERE id = $1 AND org_id = $2", [input.question_id, org.orgId]);
  if (!q) throw Object.assign(new Error(`No question ${input.question_id}`), { status: 404 });
  if (q.status !== "open") throw Object.assign(new Error("This question was already answered"), { status: 409 });
  const opt = q.options.find((o) => o.id === input.option || o.label === input.option);
  if (!opt) throw Object.assign(new Error(`Pick one of the options: ${q.options.map((o) => `${o.id} (${o.label})`).join("; ")}`), { status: 400 });

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
