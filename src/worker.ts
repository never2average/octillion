import { getDb } from "./db.js";
import { normalize, transcripts, type RawEvent, type SessionRef, type StoredEvent } from "./transcripts.js";
import { scoreTranscript, type Tool } from "./scoring.js";
import { findAgent } from "./agents.js";
import { revokeSessionTokens, sessionGatewayUsage } from "./gateway.js";

/**
 * The orchestrator's side: agent_sessions rows are the job queue.
 *   claim     queued -> running (FOR UPDATE SKIP LOCKED, so many orchestrator replicas can pull safely)
 *   append    raw JSONL events for a running session (also counts as a heartbeat)
 *   complete  running -> completed / failed / timeout, then score the transcript
 *   sweep     sessions whose heartbeat is older than the lease are completed as `timeout`
 * A job carries the task and the developer profile the orchestrator role-plays when the sub-agent asks a question
 * (plus org/product ids so an orchestrator may write events straight to ClickHouse). Nothing in it names the
 * customer's product: the sub-agent and the simulated developer must both be blind.
 */

const LEASE_MINUTES = () => Number(process.env.OCTILLION_LEASE_MINUTES ?? 30);
const MAX_USER_TURNS = () => Number(process.env.OCTILLION_MAX_USER_TURNS ?? 5);
/** Event type an orchestrator uses when the simulated developer answers the sub-agent. */
export const SIMULATED_USER = "simulated_user";
const FINAL = ["completed", "failed", "timeout", "cancelled"];

export interface Job {
  session_id: string; simulation_id: string; org_id: number; product_id: number; model: string; harness: string; attempt: number;
  agent_id: string | null; agent: { label: string; harness_version?: string; event_format?: string; image?: { docker?: string; boat_snapshot?: string }; requires_env?: string[] } | null;
  prompt: string; repo_url: string | null; language: string | null; max_user_turns: number;
  /** Starter workspace hint + scenario tags/title (the orchestrator picks a template when repo_url is null). */
  template: string | null; tags: string[]; title: string;
  profile: { slug: string; name: string; summary: string; attributes: Record<string, unknown>; instructions: string } | null;
}

export async function claimJobs(workerId: string, opts: { limit?: number; models?: string[]; harness?: string; agent_ids?: string[] } = {}): Promise<Job[]> {
  await sweepStale();
  const db = await getDb();
  const params: unknown[] = [workerId, Math.min(Math.max(opts.limit ?? 1, 1), 50)];
  let filter = "";
  if (opts.models?.length) params.push(opts.models), (filter += ` AND model = ANY($${params.length})`);
  if (opts.harness) params.push(opts.harness), (filter += ` AND harness = $${params.length}`);
  if (opts.agent_ids?.length) params.push(opts.agent_ids), (filter += ` AND agent_id = ANY($${params.length})`);
  const jobs = await db.transaction(async (tx) => {
    const rows = await tx.query<Omit<Job, "max_user_turns" | "profile" | "agent"> & { profile_id: number | null }>(
      `UPDATE agent_sessions s SET status = 'running', worker_id = $1, started_at = now(), heartbeat_at = now()
         FROM scenarios sc
        WHERE sc.id = s.scenario_id AND s.id IN (
              -- Fair share across organizations, not first-come-first-served: an org's k-th queued session is ranked
              -- after the sessions it already has running, and the lowest ranks are claimed first. One org's large
              -- run can no longer hold every pod while another org's sessions wait behind it.
              SELECT id FROM agent_sessions
               WHERE status = 'queued' AND id IN (
                     SELECT id FROM (
                       SELECT q.id, q.queued_at,
                              row_number() OVER (PARTITION BY q.org_id ORDER BY q.queued_at, q.id)
                              + (SELECT count(*) FROM agent_sessions r WHERE r.org_id = q.org_id AND r.status = 'running') AS pos
                         FROM agent_sessions q WHERE q.status = 'queued' ${filter}) ranked
                      ORDER BY pos, queued_at, id LIMIT $2)
                 FOR UPDATE SKIP LOCKED)
        RETURNING s.id AS session_id, s.simulation_id, s.org_id, s.product_id, s.model, s.harness, s.agent_id, s.attempt, s.profile_id,
                  sc.prompt, sc.repo_url, sc.language, sc.template, sc.tags, sc.title`,
      params,
    );
    if (rows.length)
      await tx.query(
        "UPDATE simulations SET status = 'running', started_at = coalesce(started_at, now()) WHERE id = ANY($1) AND status = 'queued'",
        [[...new Set(rows.map((r) => r.simulation_id))]],
      );
    const profileIds = [...new Set(rows.map((r) => r.profile_id).filter((x): x is number => x != null))];
    const profiles = profileIds.length
      ? await tx.query<Job["profile"] & { id: number }>("SELECT id, slug, name, summary, attributes, instructions FROM developer_profiles WHERE id = ANY($1)", [profileIds])
      : [];
    return rows.map(({ profile_id, ...r }) => {
      const p = profiles.find((x) => x!.id === profile_id);
      const spec = r.agent_id ? findAgent(r.agent_id) : undefined;
      const agent = spec ? { label: spec.label, harness_version: spec.harness_version, event_format: spec.event_format, image: spec.image, requires_env: spec.requires_env } : null;
      return { ...r, agent, max_user_turns: MAX_USER_TURNS(), profile: p ? { slug: p.slug, name: p.name, summary: p.summary, attributes: p.attributes, instructions: p.instructions } : null };
    });
  });
  return jobs;
}

async function sessionRef(sessionId: string) {
  const db = await getDb();
  const [s] = await db.query<SessionRef & { status: string; events: number }>(
    "SELECT id, org_id, product_id, simulation_id, model, status, events FROM agent_sessions WHERE id = $1",
    [sessionId],
  );
  if (!s) throw Object.assign(new Error(`No session ${sessionId}`), { status: 404 });
  return s;
}

export async function appendEvents(sessionId: string, raw: RawEvent[]) {
  const s = await sessionRef(sessionId);
  if (s.status !== "running") throw Object.assign(new Error(`Session ${sessionId} is ${s.status}, not running`), { status: 409 });
  if (!raw.length) return { appended: 0, last_seq: s.events };
  const events = normalize(raw, s.events);
  await transcripts().append(s, events);
  const lastSeq = Math.max(s.events, ...events.map((e) => e.seq));
  const db = await getDb();
  await db.query("UPDATE agent_sessions SET events = greatest(events, $2), heartbeat_at = now() WHERE id = $1", [sessionId, lastSeq]);
  return { appended: events.length, last_seq: lastSeq };
}

export async function heartbeat(sessionId: string) {
  const db = await getDb();
  const [row] = await db.query("UPDATE agent_sessions SET heartbeat_at = now() WHERE id = $1 AND status = 'running' RETURNING id", [sessionId]);
  if (!row) throw Object.assign(new Error(`Session ${sessionId} is not running`), { status: 409 });
}

export const COMPLETED_REASONS = ["done", "turn_cap", "time_cap", "agent_gave_up", "error"] as const;

export interface CompleteInput {
  status?: "completed" | "failed" | "timeout"; error_message?: string; sandbox_id?: string;
  /** Why the session ended (orchestrator's deterministic done check / caps). */
  completed_reason?: (typeof COMPLETED_REASONS)[number];
  tokens_in?: number; tokens_out?: number; cost_usd?: number; metadata?: Record<string, unknown>;
}

async function allEvents(orgId: number, sessionId: string): Promise<StoredEvent[]> {
  const out: StoredEvent[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await transcripts().read(orgId, sessionId, offset, 500);
    out.push(...page.events);
    if (page.events.length < 500) return out;
  }
}

/** Finish a session and score it. Re-completing an already finished session just re-scores it. */
export async function completeSession(sessionId: string, input: CompleteInput = {}) {
  const s = await sessionRef(sessionId);
  const db = await getDb();
  if (!FINAL.includes(s.status)) {
    await db.query(
      `UPDATE agent_sessions SET status = $2, ended_at = now(), error_message = $3, sandbox_id = coalesce($4, sandbox_id),
              tokens_in = coalesce($5, tokens_in), tokens_out = coalesce($6, tokens_out), cost_usd = coalesce($7, cost_usd),
              metadata = metadata || $8::jsonb, completed_reason = coalesce($9, completed_reason)
        WHERE id = $1`,
      [sessionId, input.status ?? "completed", input.error_message ?? null, input.sandbox_id ?? null, input.tokens_in ?? null,
       input.tokens_out ?? null, input.cost_usd ?? null, JSON.stringify(input.metadata ?? {}),
       (COMPLETED_REASONS as readonly string[]).includes(input.completed_reason ?? "") ? input.completed_reason : null],
    );
  }
  // The session's gateway token dies with it; tokens and cost the gateway metered are authoritative when larger
  // than what the worker parsed from the CLI's own output (Codex, for one, reports no cost at all).
  await revokeSessionTokens(sessionId);
  const metered = await sessionGatewayUsage(sessionId);
  if (metered.requests)
    await db.query(
      `UPDATE agent_sessions SET tokens_in = greatest(tokens_in, $2), tokens_out = greatest(tokens_out, $3),
              cost_usd = greatest(cost_usd, $4) WHERE id = $1`,
      [sessionId, metered.input_tokens, metered.output_tokens, metered.cost_usd]);
  const score = await scoreSession(sessionId);
  await finishSimulationIfDone(s.simulation_id);
  return score;
}

export async function scoreSession(sessionId: string) {
  const db = await getDb();
  const [row] = await db.query<{ org_id: number; status: string; name: string; aliases: string[]; packages: string[]; domains: string[]; competitors: Tool[] }>(
    `SELECT s.org_id, s.status, p.name, p.aliases, p.packages, p.domains, p.competitors
       FROM agent_sessions s JOIN products p ON p.id = s.product_id WHERE s.id = $1`,
    [sessionId],
  );
  const events = await allEvents(row.org_id, sessionId);
  // A session that died before producing anything has nothing to judge.
  if (!events.length && row.status !== "completed") return null;
  const score = scoreTranscript(events, { name: row.name, aliases: row.aliases, packages: row.packages, domains: row.domains }, row.competitors);
  // Recount from the store too, so transcripts an orchestrator wrote straight to ClickHouse are reflected.
  const lastSeq = events.reduce((m, e) => Math.max(m, e.seq), 0);
  const userTurns = events.filter((e) => e.type === SIMULATED_USER).length;
  await db.query(
    `UPDATE agent_sessions SET verdict = $2, winner = $3, mentions = $4, scored_at = now(),
            events = greatest(events, $5), user_turns = $6 WHERE id = $1`,
    [sessionId, score.verdict, score.winner, JSON.stringify(score.mentions), lastSeq, userTurns],
  );
  return score;
}

async function finishSimulationIfDone(simulationId: string) {
  const db = await getDb();
  await db.query(
    `UPDATE simulations SET status = CASE WHEN status = 'cancelled' THEN 'cancelled' ELSE 'completed' END,
            finished_at = coalesce(finished_at, now())
      WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM agent_sessions WHERE simulation_id = $1 AND status IN ('queued', 'running'))`,
    [simulationId],
  );
}

/** Time out sessions whose worker went quiet for longer than the lease. */
export async function sweepStale() {
  const db = await getDb();
  const stale = await db.query<{ id: string }>(
    `SELECT id FROM agent_sessions WHERE status = 'running' AND heartbeat_at < now() - make_interval(mins => $1)`,
    [LEASE_MINUTES()],
  );
  for (const { id } of stale)
    await completeSession(id, { status: "timeout", error_message: `No heartbeat for ${LEASE_MINUTES()} minutes` });
  return stale.length;
}
