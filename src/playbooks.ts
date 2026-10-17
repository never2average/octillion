/**
 * Journeys on /app Setup: real use cases as pipelines a customer can replicate in their AI client, one prompt at a
 * time. Platform admins manage them on /admin (create, edit, promote, order); PLAYBOOKS below are the built-in
 * templates the table is seeded with once. Each stage names the prompt to paste (filled in with the account's own product and competitor), the Octillion
 * tool it runs, and what the person will see; a worked example from the Resend case study (docs/case-studies/resend.md)
 * shows what a finished pipeline produced.
 *
 * Progress is real: a stage is done when one of its tools ran successfully for this account after the previous stage
 * was done (so re-running a pipeline after a fix counts again only from where it restarted). Stages with no tool
 * (shipping a docs change) are marked by the person.
 */
import { getDb } from "./db.js";
import { capture } from "./telemetry.js";

export interface Stage {
  id: string; title: string; why: string; prompt: string; tools: string[]; expect: string; manual?: boolean;
}
export interface Playbook {
  id: string; name: string; outcome: string; who: string; time: string;
  example: { title: string; result: string };
  stages: Stage[];
}

/** {product} and {competitor} are filled in per account. */
export const PLAYBOOKS: Playbook[] = [
  {
    id: "baseline", name: "Get your APO baseline", time: "about an hour, mostly waiting for agents",
    outcome: "Your first measured answer to “do coding agents pick us?”, per task and per agent.",
    who: "Anyone starting out; run once per product.",
    example: { title: "Resend, 14 Oct 2026", result: "4 tasks, 2 personas, 32 sessions across 7 agents: agents built on Resend in 14 of 19 sending sessions, and 0 of 6 receiving sessions." },
    stages: [
      { id: "onboard", title: "Onboard the product", tools: ["onboard_product"],
        why: "Octillion researches your site and docs and writes realistic coding tasks that never name you.",
        prompt: "Onboard my product: {product}, <website>, <docs link>. It is a <one-line description>.",
        expect: "A research job starts; in a few minutes you get a product profile (packages, domains), competitors, personas and 3 to 10 tasks." },
      { id: "review", title: "Review the profile and competitors", tools: ["get_onboarding", "get_product", "save_product"],
        why: "A competitor missing from the list can't be credited when agents pick it, so check before you run.",
        prompt: "Show me the onboarding result for {product}. Add {competitor} as a competitor if it's missing.",
        expect: "The profile, personas and tasks, with any warnings (e.g. a task that names your product)." },
      { id: "run", title: "Run the agent mix", tools: ["run_simulation"],
        why: "Real coding agents work each task in fresh sandboxes, in proportion to how developers use them.",
        prompt: "Run a simulation for {product}.",
        expect: "A run starts with sessions dealt across Claude Code, Codex, Copilot, Cursor and others; tasks sample until their result settles." },
      { id: "watch", title: "Watch it settle", tools: ["get_simulation", "list_simulations"],
        why: "Contested tasks get more sessions; agreed ones stop early.",
        prompt: "How is my simulation doing?",
        expect: "Sessions done and running, and which tasks are settled or still sampling." },
      { id: "report", title: "Read the visibility report", tools: ["get_visibility_report"],
        why: "Your headline number, where you win, and who wins where you don't.",
        prompt: "Show my visibility report for {product}.",
        expect: "Hit rate with a 95% range, results per task and per agent, losses to competitors and share of voice." },
    ],
  },
  {
    id: "fix-loss", name: "Fix a losing task", time: "a day, including your docs change",
    outcome: "Find why agents skip you on one task, change what they learn from, and prove the change worked.",
    who: "DevRel and docs owners after the first report.",
    example: { title: "Resend inbound email", result: "0 of 6 sessions picked Resend to receive email although its docs show it can; agents shortlisted Postmark, SES and SendGrid. The fix to test: an inbound quickstart and the words agents search for." },
    stages: [
      { id: "weakest", title: "Find your weakest task", tools: ["get_visibility_report"],
        why: "Start where agents should pick you and don't.",
        prompt: "Which of my tasks has the lowest hit rate where agents should pick {product}?",
        expect: "The task, its hit rate and range, and which competitor or approach won instead." },
      { id: "evidence", title: "Read the losing sessions", tools: ["get_agent_session", "get_session_transcript"],
        why: "The transcript shows what the agent searched, which options it listed and why it chose.",
        prompt: "Show me a session where the agent chose {competitor} on that task, with the key lines of the transcript.",
        expect: "The verdict, the evidence lines (install commands, imports, the agent's own reasoning) and the transcript." },
      { id: "pattern", title: "Check it's a pattern", tools: ["search_transcripts"],
        why: "One session is an anecdote; search all of them for the competitor or the phrase that tipped it.",
        prompt: "Search my transcripts for {competitor} and summarise how often and why agents picked it.",
        expect: "Matching sessions across agents with the surrounding lines." },
      { id: "ship", title: "Ship the fix", tools: [], manual: true,
        why: "Change what agents learn from: a quickstart for this use case, examples, package metadata, error messages.",
        prompt: "(In your docs or SDK) Add the page or example the transcripts show agents were missing.",
        expect: "Mark this done when the change is live; agents read the public web and package registries." },
      { id: "rerun", title: "Re-run the same task", tools: ["run_simulation"],
        why: "Same task, same personas, the current agent mix: the only thing that changed is you.",
        prompt: "Re-run my last simulation for {product}, only the task we just looked at.",
        expect: "A new run on that task; it samples until the result settles." },
      { id: "compare", title: "Compare before and after", tools: ["get_visibility_report"],
        why: "Proof the change moved agents' choices, task by task and agent by agent.",
        prompt: "Compare the hit rate on that task before and after my change.",
        expect: "The daily trend and both runs' results with their ranges; overlapping ranges mean run more sessions." },
    ],
  },
  {
    id: "head-to-head", name: "Competitor head-to-head", time: "an hour",
    outcome: "Where one competitor beats you, on which tasks and with which agents, in the agents' own words.",
    who: "Product marketing and founders.",
    example: { title: "Resend vs Postmark", result: "Postmark took 2 of the 10 password-recovery sessions and both receiving-email wins; Claude Code's provider shortlist named SES, Postmark and SendGrid but not Resend." },
    stages: [
      { id: "competitors", title: "Make sure the competitor is tracked", tools: ["get_product", "save_product"],
        why: "Octillion only credits competitors it knows by name, package and domain.",
        prompt: "Make sure {competitor} is a competitor of {product}, with its npm/PyPI packages and domains.",
        expect: "The product's competitor list with packages and domains." },
      { id: "run", title: "Run with enough sessions", tools: ["run_simulation"],
        why: "Head-to-head numbers need sessions on every task and every major agent.",
        prompt: "Run a simulation for {product} with at least 6 sessions per task.",
        expect: "A run sized to your tasks, across the agent mix." },
      { id: "share", title: "Read share of voice", tools: ["get_visibility_report"],
        why: "How often agents chose you versus each competitor, overall and per task.",
        prompt: "Show share of voice for {product} versus {competitor}, by task and by agent.",
        expect: "Picks per product per task and per agent, and where you lose head to head." },
      { id: "why", title: "Read why they win", tools: ["search_transcripts", "get_agent_session"],
        why: "The reasons agents give for the competitor are your positioning gaps.",
        prompt: "Search my transcripts where agents chose {competitor} and list the reasons they gave.",
        expect: "Quotes and evidence lines grouped by reason." },
    ],
  },
  {
    id: "agent-audit", name: "Agent-by-agent audit", time: "an hour",
    outcome: "Which coding agents never pick you, weighted by how many developers use them.",
    who: "Teams prioritising where to spend docs and partnership effort.",
    example: { title: "Resend by agent", result: "Codex built on Resend in 5 of its 6 sending sessions; Claude Code's two password-recovery losses both went to Postmark." },
    stages: [
      { id: "mix", title: "See the agent mix", tools: ["list_agents"],
        why: "Agents are sampled by real-world usage share, with sources.",
        prompt: "Which coding agents do you test with, and what share of developers uses each?",
        expect: "Agents with their share, sandboxes out of 20 and sources." },
      { id: "run", title: "Run across the mix", tools: ["run_simulation"],
        why: "Every agent needs sessions on your tasks to compare them.",
        prompt: "Run a simulation for {product} across the full agent mix.",
        expect: "Sessions dealt so every harness gets a share." },
      { id: "by-agent", title: "Read results by agent", tools: ["get_visibility_report"],
        why: "The adoption-weighted hit rate tells you what most developers' agents do.",
        prompt: "Show my visibility report for {product} broken down by agent.",
        expect: "Hit rate per agent with ranges, and the adoption-weighted total." },
      { id: "worst", title: "Dig into the agent that skips you", tools: ["get_agent_session", "search_transcripts"],
        why: "Each agent has its own defaults; its transcripts show which ones.",
        prompt: "For the agent with the lowest hit rate, show a session where it chose something else and why.",
        expect: "The session's verdict, evidence and transcript." },
    ],
  },
  {
    id: "new-capability", name: "Launch a new capability", time: "an hour plus the run",
    outcome: "Know whether agents use your new feature for the job it was built for, before and after launch.",
    who: "Product teams shipping a feature or SDK.",
    example: { title: "Resend receiving email", result: "A capability agents didn't associate with Resend at all: the task to add before and after launching inbound." },
    stages: [
      { id: "tasks", title: "Add tasks for the capability", tools: ["save_scenarios", "browse_task_library"],
        why: "Tasks phrased the way a developer would ask, without naming you or the feature.",
        prompt: "Add a task for {product}: <what a developer would ask an agent to build that needs the new capability>.",
        expect: "The task saved, with warnings if it names your product or a competitor." },
      { id: "run", title: "Run the new tasks", tools: ["run_simulation"],
        why: "A baseline before you announce, so the launch has a measurable effect.",
        prompt: "Run a simulation for {product} on the new task only.",
        expect: "A run on that task across the agent mix." },
      { id: "report", title: "Read the result", tools: ["get_visibility_report"],
        why: "Whether agents reach for you, a competitor, or build it themselves.",
        prompt: "Show the result for the new task, and who won if not {product}.",
        expect: "Hit rate on the new task with the winners and evidence." },
    ],
  },
  {
    id: "release-watch", name: "Release watch", time: "minutes, every few weeks",
    outcome: "Catch it when a new model or agent version stops picking you.",
    who: "Anyone with a baseline; repeat when major models ship.",
    example: { title: "Why re-run", result: "Each model, version and harness has its own defaults; a release can change who gets picked without anything changing on your side." },
    stages: [
      { id: "run", title: "Re-run your tasks", tools: ["run_simulation"],
        why: "The same tasks on today's agent mix.",
        prompt: "Re-run my last simulation for {product} on the current agent mix.",
        expect: "A new run with today's agent versions." },
      { id: "trend", title: "Read the trend", tools: ["get_visibility_report"],
        why: "The daily trend shows whether preference moved.",
        prompt: "Show my hit rate trend for {product} over the last 90 days, by agent.",
        expect: "The trend line and per-agent change since the last run." },
    ],
  },
];

// ---------- templates in the database (managed on /admin) ----------

export class PlaybookError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

interface Row { id: string; name: string; outcome: string; who: string; time: string; example_title: string; example_result: string;
  stages: Stage[]; promoted: boolean; position: number; updated_at: Date; updated_by: string | null }

const toPlaybook = (r: Row): Playbook & { promoted: boolean; position: number; updated_at: Date; updated_by: string | null } => ({
  id: r.id, name: r.name, outcome: r.outcome, who: r.who, time: r.time, example: { title: r.example_title, result: r.example_result },
  stages: r.stages, promoted: r.promoted, position: r.position, updated_at: r.updated_at, updated_by: r.updated_by,
});

let seeded = false;
/** The built-in pipelines become the first templates, once (an admin may delete or rewrite them afterwards). */
async function ensureSeeded() {
  if (seeded) return;
  const db = await getDb();
  const [{ n }] = await db.query<{ n: number }>("SELECT count(*) AS n FROM journey_templates");
  if (!Number(n)) {
    for (const [i, p] of PLAYBOOKS.entries())
      await db.query(
        `INSERT INTO journey_templates (id, name, outcome, who, time, example_title, example_result, stages, promoted, position, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, 'built-in') ON CONFLICT (id) DO NOTHING`,
        [p.id, p.name, p.outcome, p.who, p.time, p.example.title, p.example.result, JSON.stringify(p.stages), i]);
  }
  seeded = true;
}

export async function listTemplates(opts: { promotedOnly?: boolean } = {}) {
  await ensureSeeded();
  const rows = await (await getDb()).query<Row>(
    `SELECT * FROM journey_templates ${opts.promotedOnly ? "WHERE promoted" : ""} ORDER BY position, name`);
  return rows.map(toPlaybook);
}

const slug = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
const txt = (v: unknown, max: number, field: string, required = true) => {
  const s = String(v ?? "").trim().slice(0, max);
  if (required && !s) throw new PlaybookError(`${field} is required`);
  return s;
};

/** Check and normalise a template from the admin editor. `tools` must be Octillion tool names. */
export function cleanTemplate(b: Record<string, any>, toolNames: readonly string[]) {
  const stagesIn = Array.isArray(b.stages) ? b.stages : [];
  if (!stagesIn.length || stagesIn.length > 12) throw new PlaybookError("A journey needs 1 to 12 stages");
  const ids = new Set<string>();
  const stages: Stage[] = stagesIn.map((st: any, i: number) => {
    const id = slug(st.id || st.title) || `stage-${i + 1}`;
    if (ids.has(id)) throw new PlaybookError(`Two stages are called ${id}`);
    ids.add(id);
    const tools = (Array.isArray(st.tools) ? st.tools : []).map(String).filter(Boolean);
    const bad = tools.find((t: string) => !toolNames.includes(t));
    if (bad) throw new PlaybookError(`Stage ${i + 1}: ${bad} is not an Octillion tool`);
    const manual = Boolean(st.manual) || tools.length === 0;
    return { id, title: txt(st.title, 120, `Stage ${i + 1} title`), why: txt(st.why, 500, `Stage ${i + 1} why`, false),
             prompt: txt(st.prompt, 600, `Stage ${i + 1} prompt`), tools, expect: txt(st.expect, 500, `Stage ${i + 1} "you'll see"`), ...(manual ? { manual: true } : {}) };
  });
  return {
    name: txt(b.name, 80, "name"), outcome: txt(b.outcome, 300, "outcome"), who: txt(b.who, 200, "who", false), time: txt(b.time, 80, "time", false),
    example_title: txt(b.example?.title ?? b.example_title, 120, "example title", false), example_result: txt(b.example?.result ?? b.example_result, 600, "example result", false),
    stages,
  };
}

export async function createTemplate(actor: string, b: Record<string, any>, toolNames: readonly string[]) {
  await ensureSeeded();
  const t = cleanTemplate(b, toolNames);
  const id = slug(b.id || t.name);
  if (!id) throw new PlaybookError("A journey needs a name");
  const db = await getDb();
  const [{ next }] = await db.query<{ next: number }>("SELECT coalesce(max(position), -1) + 1 AS next FROM journey_templates");
  try {
    await db.query(
      `INSERT INTO journey_templates (id, name, outcome, who, time, example_title, example_result, stages, promoted, position, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, t.name, t.outcome, t.who, t.time, t.example_title, t.example_result, JSON.stringify(t.stages), Boolean(b.promoted), Number(next), actor]);
  } catch (e) {
    if (/duplicate|unique/i.test((e as Error).message)) throw new PlaybookError(`There is already a journey called ${id}`, 409);
    throw e;
  }
  return id;
}

export async function updateTemplate(actor: string, id: string, b: Record<string, any>, toolNames: readonly string[]) {
  await ensureSeeded();
  const t = cleanTemplate(b, toolNames);
  const r = await (await getDb()).query(
    `UPDATE journey_templates SET name = $2, outcome = $3, who = $4, time = $5, example_title = $6, example_result = $7, stages = $8,
            updated_at = now(), updated_by = $9 WHERE id = $1 RETURNING id`,
    [id, t.name, t.outcome, t.who, t.time, t.example_title, t.example_result, JSON.stringify(t.stages), actor]);
  if (!r.length) throw new PlaybookError("No such journey", 404);
}

export async function setPromoted(actor: string, id: string, promoted: boolean) {
  const r = await (await getDb()).query("UPDATE journey_templates SET promoted = $2, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING id", [id, promoted, actor]);
  if (!r.length) throw new PlaybookError("No such journey", 404);
}

export async function reorder(actor: string, ids: unknown) {
  if (!Array.isArray(ids) || !ids.length) throw new PlaybookError("ids must be the journeys in their new order");
  const db = await getDb();
  for (const [i, id] of ids.entries()) await db.query("UPDATE journey_templates SET position = $2, updated_by = $3 WHERE id = $1", [String(id), i, actor]);
}

export async function deleteTemplate(id: string) {
  const r = await (await getDb()).query("DELETE FROM journey_templates WHERE id = $1 RETURNING id", [id]);
  if (!r.length) throw new PlaybookError("No such journey", 404);
}

// ---------- progress, events and analytics ----------

/**
 * Record newly done stages for an account and send the journey events to PostHog once each: journey_started (first
 * stage of a journey), journey_stage_completed, journey_completed. Runs after tool calls and when /app loads journeys.
 */
export async function syncProgress(org: { orgId: number; slug: string }, distinctId?: string) {
  const db = await getDb();
  const templates = await listTemplates({ promotedOnly: true });
  const progress = await progressFor(org.orgId, templates);
  const have = new Set((await db.query<{ journey_id: string; stage_id: string }>(
    "SELECT journey_id, stage_id FROM journey_progress WHERE org_id = $1", [org.orgId])).map((r) => `${r.journey_id}/${r.stage_id}`));
  const actor = { distinctId: distinctId ?? `org:${org.slug}`, orgSlug: org.slug };
  for (const p of progress) {
    const before = p.stages.filter((x) => have.has(`${p.id}/${x.id}`)).length;
    let added = 0;
    for (const [i, st] of p.stages.entries()) {
      if (!st.done || st.manual || have.has(`${p.id}/${st.id}`)) continue; // manual stages are recorded when marked
      const r = await db.query("INSERT INTO journey_progress (org_id, journey_id, stage_id, done_at, source) VALUES ($1, $2, $3, $4, 'tool') ON CONFLICT DO NOTHING RETURNING stage_id",
        [org.orgId, p.id, st.id, st.at]);
      if (!r.length) continue;
      if (before + added === 0) capture(actor, "journey_started", { journey: p.id });
      added++;
      capture(actor, "journey_stage_completed", { journey: p.id, stage: st.id, stage_index: i + 1, stages: p.total, source: "tool" });
    }
    if (added && p.done === p.total) capture(actor, "journey_completed", { journey: p.id, stages: p.total });
  }
  return progress;
}

const pending = new Map<number, ReturnType<typeof setTimeout>>();
/** After a tool call: sync this account's journey progress a few seconds later (calls in a burst sync once). */
export function scheduleSync(org: { orgId: number; slug: string }, distinctId?: string) {
  if (pending.has(org.orgId)) return;
  pending.set(org.orgId, setTimeout(() => {
    pending.delete(org.orgId);
    syncProgress(org, distinctId).catch((e) => console.error("journey sync:", (e as Error).message));
  }, 3000).unref());
}

/** A person marks a stage with no tool (e.g. "ship the fix") done, or undoes it. */
export async function markStage(org: { orgId: number; slug: string }, userId: string | null, journeyId: string, stageId: string, done: boolean) {
  const t = (await listTemplates()).find((x) => x.id === journeyId);
  const st = t?.stages.find((x) => x.id === stageId);
  if (!t || !st) throw new PlaybookError("No such journey stage", 404);
  if (!st.manual) throw new PlaybookError("This stage is marked done by your AI client's tool calls, not by hand");
  const db = await getDb();
  const actor = { distinctId: userId ?? `org:${org.slug}`, orgSlug: org.slug };
  if (done) {
    const r = await db.query("INSERT INTO journey_progress (org_id, journey_id, stage_id, source, user_id) VALUES ($1, $2, $3, 'manual', $4) ON CONFLICT DO NOTHING RETURNING stage_id",
      [org.orgId, journeyId, stageId, userId]);
    if (r.length) capture(actor, "journey_stage_completed", { journey: journeyId, stage: stageId, stage_index: t.stages.indexOf(st) + 1, stages: t.stages.length, source: "manual" });
  } else {
    await db.query("DELETE FROM journey_progress WHERE org_id = $1 AND journey_id = $2 AND stage_id = $3 AND source = 'manual'", [org.orgId, journeyId, stageId]);
  }
  return syncProgress(org, userId ?? undefined);
}

/**
 * For /admin: every template with its funnel across accounts: how many reached each stage, started, completed, the
 * median time from first stage to completion, and the stage where most accounts stopped.
 */
export async function templatesWithAdoption() {
  const templates = await listTemplates();
  const rows = await (await getDb()).query<{ org_id: number; journey_id: string; stage_id: string; done_at: Date }>(
    "SELECT org_id, journey_id, stage_id, done_at FROM journey_progress");
  const [{ n: active }] = await (await getDb()).query<{ n: number }>("SELECT count(DISTINCT org_id) AS n FROM mcp_events WHERE method = 'tools/call'");
  return templates.map((t) => {
    const mine = rows.filter((r) => r.journey_id === t.id);
    const byOrg = new Map<number, Map<string, Date>>();
    for (const r of mine) { const m = byOrg.get(r.org_id) ?? new Map(); m.set(r.stage_id, r.done_at); byOrg.set(r.org_id, m); }
    const stageIds = t.stages.map((s) => s.id);
    const funnel = t.stages.map((s) => ({ id: s.id, title: s.title, reached: [...byOrg.values()].filter((m) => m.has(s.id)).length }));
    const completedOrgs = [...byOrg.values()].filter((m) => stageIds.every((id) => m.has(id)));
    const hours = completedOrgs.map((m) => {
      const ts = stageIds.map((id) => new Date(m.get(id)!).getTime());
      return (Math.max(...ts) - Math.min(...ts)) / 3_600_000;
    }).sort((a, b) => a - b);
    const median = hours.length ? hours[Math.floor(hours.length / 2)] : null;
    // Where accounts stop: the stage with the biggest drop from the one before it.
    let dropoff: { id: string; title: string; lost: number } | null = null;
    for (let i = 1; i < funnel.length; i++) {
      const lost = funnel[i - 1].reached - funnel[i].reached;
      if (lost > 0 && (!dropoff || lost > dropoff.lost)) dropoff = { id: funnel[i].id, title: funnel[i].title, lost };
    }
    const last = mine.reduce<Date | null>((a, r) => (!a || new Date(r.done_at) > new Date(a) ? r.done_at : a), null);
    return { ...t, adoption: { started: byOrg.size, completed: completedOrgs.length, median_hours_to_complete: median, dropoff, last_activity: last, funnel },
             accounts_active: Number(active) };
  });
}

/** Every promoted journey with its stages marked from this account's tool calls, prompts filled in with its product. */
export async function playbooksFor(orgId: number) {
  return progressFor(orgId, await listTemplates({ promotedOnly: true }));
}

async function progressFor(orgId: number, templates: Playbook[]) {
  const db = await getDb();
  const marked = new Map((await db.query<{ journey_id: string; stage_id: string; done_at: Date }>(
    "SELECT journey_id, stage_id, done_at FROM journey_progress WHERE org_id = $1 AND source = 'manual'", [orgId])).map((r) => [`${r.journey_id}/${r.stage_id}`, r.done_at]));
  const events = await db.query<{ name: string; at: Date }>(
    "SELECT name, at FROM mcp_events WHERE org_id = $1 AND method = 'tools/call' AND ok ORDER BY at", [orgId]);
  const [prod] = await db.query<{ name: string; competitors: { name: string }[] }>(
    "SELECT name, competitors FROM products WHERE org_id = $1 ORDER BY created_at LIMIT 1", [orgId]);
  const product = prod?.name ?? "my product";
  const competitor = (prod?.competitors ?? [])[0]?.name ?? "<competitor>";
  const fill = (t: string) => t.replace(/\{product\}/g, product).replace(/\{competitor\}/g, competitor);
  return templates.map((p) => {
    let since = 0; // a stage only counts tool calls after the previous stage was done
    const stages = p.stages.map((st) => {
      const manualAt = st.manual ? marked.get(`${p.id}/${st.id}`) ?? null : null;
      const hit = st.manual ? null : events.find((e) => st.tools.includes(e.name) && new Date(e.at).getTime() >= since);
      const at = hit?.at ?? manualAt;
      if (at) since = Math.max(since, new Date(at).getTime());
      return { ...st, prompt: fill(st.prompt), why: fill(st.why), expect: fill(st.expect), done: Boolean(at), at };
    });
    return { id: p.id, name: p.name, outcome: p.outcome, who: p.who, time: p.time, example: { ...p.example }, stages,
             done: stages.filter((x) => x.done).length, total: stages.length, manualCount: stages.filter((x) => x.manual).length };
  });
}
