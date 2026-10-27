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

Finally list missing_names: short, former or spoken names developers use for the product that its aliases lack (e.g.
"the Alliance" for "Digital Research Alliance of Canada", a former company name). Never names of other products.

Answer with ONLY one JSON object, no prose:
{"placement": {"layer": "", "runs_on_it": [], "used_with": [], "adoption_signals": []},
 "competitors": [{"index": 0, "name": "", "relation": "substitute" | "complement" | "different_layer" | "unrelated",
                  "confidence": "high" | "medium" | "low", "reason": "",
                  "question": {"text": "", "options": [{"label": "", "relation": "substitute"}]}}],
 "missing_names": []}
"reason" is one short sentence with the evidence; "question" only when confidence is not high.`;

export type Relation = "substitute" | "complement" | "different_layer" | "unrelated";
export type Confidence = "high" | "medium" | "low";
export interface Placement { layer: string; runs_on_it: string[]; used_with: string[]; adoption_signals: string[] }
export interface CompetitorJudgement { index: number; name: string; relation: Relation; confidence: Confidence; reason: string;
  question: { text: string; options: { label: string; relation: Relation }[] } | null }
export interface ArchitectVerdict { placement: Placement; competitors: CompetitorJudgement[]; missing_names: string[] }
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

/** The follow-up round: investigate what is still unsure, then answer the whole object again. */
export function followUpPrompt(unsure: CompetitorJudgement[], round: number): string {
  return `Round ${round} of ${MAX_ROUNDS}. You are not yet sure about: ${unsure.map((c) => `${c.name} (${c.relation}, ${c.confidence})`).join("; ")}.
Investigate each with your tools before answering: how the product's docs mention it, "<tool> vs <product>" comparisons,
whether the product runs it, hosts it or replaces it. Then answer the whole JSON object again, with updated confidence.`;
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
  };
}

export const unsureOf = (v: ArchitectVerdict) => v.competitors.filter((c) => c.confidence !== "high");

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
}

export function architectOutcome(v: ArchitectVerdict, p: ArchitectProduct, rounds: number): ArchitectOutcome {
  const out: ArchitectOutcome = { issues: [], questions: [], unconfirmed: [], not_competitors: [], placement: v.placement };
  const why: Record<Exclude<Relation, "substitute">, string> = {
    complement: "is a complement, used with or on the product, not instead of it: an agent using it is usually using the product. Remove it from competitors",
    different_layer: "solves a different part of the stack, so it does not compete for the same decision. Remove it from competitors, or replace it with a real substitute",
    unrelated: "is not a plausible alternative for the product's job. Remove it from competitors",
  };
  for (const c of v.competitors) {
    const listed = p.competitors[c.index];
    if (!listed) continue;
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
