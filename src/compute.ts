import { getDb } from "./db.js";
import { AUTOSCALE, CAPACITY_NOTE, computeDemand, kickConfigured, type TickState } from "./autoscaler.js";
import { scheduledAgents, variantsOf } from "./agents.js";
import { getPopulation } from "./populations.js";
import { listSettings } from "./settings.js";
import { classifySession } from "./error-classes.js";
import { missingAgentKeys } from "./gateway.js";
import { sandboxConfigError, VERCEL_SANDBOX_PRICE } from "../orchestrator/core/config.js";
import * as lib from "../orchestrator/deploy/orch-lib.js";
import { orchSandboxCostUsd, PROVIDER_LABEL, VERCEL_ORCH } from "../orchestrator/deploy/orchestrator-host.js";

/**
 * The admin Compute page's server side (docs/compute-and-traces-spec.md §2): one summary that answers "is compute
 * healthy, is work flowing, what is stuck, and why" from what already exists: the last autoscaler tick (its lease row),
 * orchestrator_sandboxes, worker_sandboxes, agent_sessions, product_research, gateway spend and compute_events.
 * Read only: nothing here launches, deletes or changes anything.
 *
 * Our sandboxes are Vercel Sandbox's, and every one of them has a row (the autoscaler's orchestrator_sandboxes, the
 * broker's worker_sandboxes): the listing below is read from those rows, and the limits are the configured Vercel ones
 * (Vercel has no limits API). Rows from before boat.dev's retirement stay readable as history.
 */

const env = process.env;
const MIN = 60_000;
const n = (v: unknown) => Number(v ?? 0) || 0;
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const usd = (x: number) => Math.round(x * 10_000) / 10_000;

// ---------------------------------------------------------------- cached provider calls

export interface Fetched<T> {
  /** A value is there (fresh, or the last good one when `stale`). */
  ok: boolean;
  stale: boolean;
  error: string | null;
  /** When the value was fetched. */
  at: string | null;
  value: T | null;
}

/** Reject after `ms` with a plain-English error, so a hung provider call never holds the page. */
export function withTimeout<T>(p: Promise<T>, ms: number, what = "the provider"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)} s`)), ms);
    t.unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * A fetch with an in-process cache and a timeout. A fresh value is reused for `ttlMs`; a failure is remembered for
 * `ttlMs` too (a down provider is not asked again on every refresh), and serves the last good value marked stale.
 * Concurrent callers share one call. `force` skips both caches (the page's "Test connection").
 */
export function cachedFetch<T>(fetch: () => Promise<T>, opts: { ttlMs: number; timeoutMs: number; what?: string }) {
  let good: { at: number; value: T } | null = null;
  let failed: { at: number; error: string } | null = null;
  let inflight: Promise<Fetched<T>> | null = null;
  const result = (): Fetched<T> => {
    const fresh = good && (!failed || failed.at < good.at);
    return { ok: !!good, stale: !!good && !fresh, error: fresh ? null : failed?.error ?? null, at: good ? new Date(good.at).toISOString() : null, value: good?.value ?? null };
  };
  const get = (force = false): Promise<Fetched<T>> => {
    const now = Date.now(), last = Math.max(good?.at ?? 0, failed?.at ?? 0);
    if (!force && last && now - last < opts.ttlMs) return Promise.resolve(result());
    inflight ??= withTimeout(fetch(), opts.timeoutMs, opts.what)
      .then((value) => { good = { at: Date.now(), value }; failed = null; })
      .catch((e) => { failed = { at: Date.now(), error: String((e as Error)?.message ?? e).slice(0, 300) }; })
      .then(result)
      .finally(() => { inflight = null; });
    return inflight;
  };
  return Object.assign(get, { reset: () => { good = null; failed = null; } });
}

// ---------------------------------------------------------------- our live sandboxes, from their rows

export type SandboxKind = "orchestrator" | "worker" | "image_builder" | "image" | "probe" | "other";
export interface ClassifiedSandbox {
  id: string; name?: string; state: string; createdAt?: string;
  kind: SandboxKind;
  live: boolean;
  /** Workers: the orchestrator that owns it (the broker records it), and the agent session it was created for. */
  parent_orchestrator_id: string | null; session_id?: string | null;
  /** Other deployments' sandboxes: the first part of the name; none are listed (every sandbox here is ours). */
  prefix: string | null;
}

export interface SandboxListing { ok: boolean; stale: boolean; error: string | null; at: string | null; sandboxes: ClassifiedSandbox[] }

/**
 * Our live Vercel sandboxes: orchestrators (the autoscaler's live rows) and worker sandboxes (the broker's rows not yet
 * deleted, each with the orchestrator that owns it). A sandbox exists only through a row, so this is the listing.
 */
export async function classifiedSandboxes(_opts: { force?: boolean } = {}): Promise<SandboxListing> {
  const db = await getDb();
  const [orch, workers] = await Promise.all([
    db.query<{ sandbox_id: string; state: string; created_at: Date }>(
      "SELECT sandbox_id, state, created_at FROM orchestrator_sandboxes WHERE state <> 'deleted' AND sandbox_id IS NOT NULL AND provider = 'vercel' ORDER BY id"),
    db.query<{ sandbox_id: string; orchestrator_id: string | null; session_id: string; created_at: Date; ready_at: Date | null }>(
      "SELECT sandbox_id, orchestrator_id, session_id, created_at, ready_at FROM worker_sandboxes WHERE deleted_at IS NULL ORDER BY id"),
  ]);
  const at = new Date().toISOString();
  return { ok: true, stale: false, error: null, at, sandboxes: [
    ...orch.map((r) => ({ id: r.sandbox_id, name: r.sandbox_id, state: r.state, createdAt: iso(r.created_at) ?? undefined, kind: "orchestrator" as const, live: true, parent_orchestrator_id: null, prefix: null })),
    ...workers.map((w) => ({ id: w.sandbox_id, name: w.sandbox_id, state: w.ready_at ? "ready" : "starting", createdAt: iso(w.created_at) ?? undefined, kind: "worker" as const, live: true,
      parent_orchestrator_id: w.orchestrator_id, session_id: w.session_id, prefix: null })),
  ] };
}

/** The configured Vercel Sandbox limits, with what is active now (VERCEL_ORCH; Vercel has no limits API). */
export function vercelLimits(activeNow: number) {
  const perHour = VERCEL_ORCH.startsPerHour();
  return { activeSandboxes: VERCEL_ORCH.maxConcurrent(), startsPerMinute: perHour, startsPerHour: perHour, startsPerDay: perHour * 24, activeNow };
}

/** For tests: forget the cached summary. */
export function resetComputeCaches() { summaryCache = null; }

// ---------------------------------------------------------------- which agents lack a key

/**
 * For each scheduled agent (and its model variants): the env vars its sessions need (registry `requires_env`, else
 * the harness default) that no enabled vault provider the broker may hand out covers. The same rule as
 * `brokerSessionCredentials`, so an agent listed here fails with "No vault provider supplies …" when it runs.
 */
export async function agentKeyCoverage(): Promise<{ agent_id: string; harness: string; missing_env: string[] }[]> {
  let agents: { id: string; harness: string; requires_env?: string[] }[] = [];
  try { agents = scheduledAgents(await getPopulation()).flatMap((a) => [a, ...variantsOf(a).filter((v) => v.id !== a.id)]); }
  catch { return []; }
  const seen = new Set<string>();
  const unique = agents.filter((a) => !seen.has(a.id) && seen.add(a.id));
  const missing = await missingAgentKeys(unique);
  return unique.map((a) => ({ agent_id: a.id, harness: a.harness, missing_env: missing.get(a.id) ?? [] }));
}

// ---------------------------------------------------------------- verdict (pure; smoke-tested)

export type Level = "red" | "amber" | "green";
export interface Verdict { level: Level; code: string; text: string; href: string | null }

/** Everything the verdict rules read, gathered by computeSummary. */
export interface VerdictFacts {
  enabled: boolean; runtime: "vm" | "vercel"; kick_configured: boolean;
  /** A sandbox setting that cannot work (sandboxConfigError: e.g. OCTILLION_SANDBOX_PROVIDER=boat, retired), else null. */
  config_error?: string | null;
  tick: { age_s: number | null; error: string | null; note: string | null };
  queue: { sessions: number; research: number; oldest_session_age_s: number | null; oldest_research_age_s: number | null; unclaimable: number };
  running: { sessions: number; orchestrators: number };
  others: number; free: number | null;
  per_job: boolean; job_orch_live: number; job_orch_cap: number;
  not_checking_in: number;
  launch_failures_1h: { count: number; step: string | null; message: string | null };
  missing_keys: { agent_id: string; missing_env: string[] }[];
  leaked_workers: number;
  orphan_deletes_24h: number; namespace: string;
  idle_orchestrators: number;
}

const mins = (s: number) => Math.max(1, Math.round(s / 60));
const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
const ago = (s: number | null) => (s == null ? "none" : s < 90 ? `${Math.round(s)} s` : `${mins(s)} min`);

/**
 * The verdict rules, worst first, in the spec's order (§2.2 B). Every true rule is returned; the page shows the first
 * and folds the rest under "+N more". With none true: one green line.
 */
export function computeVerdict(f: VerdictFacts): Verdict[] {
  const out: Verdict[] = [];
  const add = (level: Level, code: string, text: string, href: string | null) => out.push({ level, code, text, href });
  const queued = f.queue.sessions + f.queue.research;
  const note = f.tick.note ?? "";
  if (!f.enabled) add("red", "autoscale_off", "The autoscaler is off. Queued work will not get orchestrators.", "#environment");
  if (f.runtime === "vercel" && f.enabled && !f.kick_configured)
    add("red", "kick_unconfigured", "This deployment cannot trigger the autoscaler: PUBLIC_URL is not HTTPS or the worker token is unset.", "#environment");
  if (f.config_error) add("red", "sandbox_config", f.config_error, "#environment");
  if (f.tick.error) add("red", "tick_error", `The last tick failed: ${f.tick.error}`, "/admin/compute?section=decisions&has=error");
  if (f.enabled && queued > 0 && (f.tick.age_s == null || f.tick.age_s > 600)) {
    const what = [f.queue.sessions && plural(f.queue.sessions, "session"), f.queue.research && plural(f.queue.research, "research job")].filter(Boolean).join(" and ");
    add("red", "tick_stale", `${what} ${queued === 1 ? "is" : "are"} queued but ${f.tick.age_s == null ? "the autoscaler has never ticked" : `nothing has ticked for ${mins(f.tick.age_s)} min`}.`, "#tick");
  }
  const oldS = f.queue.oldest_session_age_s ?? 0, oldR = f.queue.oldest_research_age_s ?? 0;
  if (oldS > 15 * 60 || oldR > 20 * 60)
    add("amber", "queue_old", oldS > 15 * 60 ? `The oldest queued session has waited ${mins(oldS)} min.` : `The oldest queued research has waited ${mins(oldR)} min.`,
      "/admin/health?section=sessions&status=queued&sort=queued_at");
  if (f.queue.unclaimable > 0)
    add("amber", "unclaimable", `${plural(f.queue.unclaimable, "session")} can never run: ${f.queue.unclaimable === 1 ? "its" : "their"} agent is not in the scheduled population.`,
      "/admin/health?section=sessions&class=unclaimable");
  const plan = CAPACITY_NOTE.exec(note);
  if (plan) {
    const where = plan[2]?.trim() || PROVIDER_LABEL.boat; // the older wording named no provider: it was boat's plan
    add("amber", "plan_capacity", `${plan[1]} waits for sandbox capacity on ${where}: ${Math.max(0, Number(plan[3]))} free.`, "#limits");
  }
  const rate = /launch rate cap: [^;]*/.exec(note);
  if (rate) add("amber", "rate_cap", `Orchestrator launches are paused by the ${rate[0]}.`, "#limits");
  if (f.per_job && f.job_orch_live >= f.job_orch_cap && queued > 0)
    add("amber", "at_cap", `At the orchestrator limit (${f.job_orch_cap}). Raise it in Limits or wait.`, "#limits");
  if (f.not_checking_in > 0)
    add("amber", "not_checking_in", `${plural(f.not_checking_in, "orchestrator")} ${f.not_checking_in === 1 ? "is" : "are"} not checking in.`, "/admin/compute?section=orchestrators&state=stale");
  if (f.launch_failures_1h.count >= 2)
    add("amber", "launch_failures", `${f.launch_failures_1h.count} orchestrator launches failed in the last hour (latest: ${f.launch_failures_1h.step ?? "unknown"}: ${f.launch_failures_1h.message ?? "no message"}).`,
      "/admin/compute?section=failures");
  const cooldown = /cooldown: [^;]*/.exec(note);
  if (cooldown) add("amber", "cooldown", `Relaunch is paused (cooldown): ${cooldown[0].replace(/^cooldown: /, "")}`, "/admin/compute?section=decisions");
  const missing = f.missing_keys.filter((m) => m.missing_env.length);
  if (missing.length) {
    const envs = [...new Set(missing.flatMap((m) => m.missing_env))];
    const names = missing.length > 3 ? `${missing.slice(0, 3).map((m) => m.agent_id).join(", ")} and ${missing.length - 3} more` : missing.map((m) => m.agent_id).join(", ");
    add("amber", "missing_keys", `${names} cannot run: no vault key for ${envs.join(", ")}.`, "/admin/keys");
  }
  if (f.leaked_workers > 0)
    add("amber", "leaked_workers", `${plural(f.leaked_workers, "worker sandbox", "worker sandboxes")} ${f.leaked_workers === 1 ? "is" : "are"} running with no live orchestrator.`,
      "/admin/compute?section=orchestrators&state=unmatched");
  if (f.orphan_deletes_24h > 0)
    add("amber", "namespace_collision", `${plural(f.orphan_deletes_24h, "orchestrator sandbox", "orchestrator sandboxes")} with no row ${f.orphan_deletes_24h === 1 ? "was" : "were"} deleted in 24 h. Another deployment may share namespace ${f.namespace}.`,
      "/admin/compute?section=decisions");
  if (f.idle_orchestrators > 0)
    add("amber", "idle_orch", `${plural(f.idle_orchestrators, "orchestrator")} ${f.idle_orchestrators === 1 ? "is" : "are"} idle but not drained.`, "/admin/compute?section=orchestrators&state=live");
  if (!out.length)
    add("green", "ok", `Compute is healthy. ${plural(f.running.sessions, "session")} running on ${plural(f.running.orchestrators, "orchestrator")}, queue ${queued}${queued ? `, oldest ${ago(Math.max(oldS, oldR))}` : ""}.`, null);
  return out;
}

// ---------------------------------------------------------------- limits (pure; smoke-tested)

export type Binding = "plan" | "job_orch" | "pods" | null;

/**
 * Which ceiling binds. The latest tick's note wins: it names the cap that actually held a job back. Otherwise the
 * sandbox limit (shared fleet: computeBudget's reason; per job: nothing free while work waits), then the job-orchestrator cap, then pods per orchestrator, each only while
 * work is queued (a full cap with nothing waiting holds nothing back).
 */
export function bindingLimit(x: { note: string | null; budget_reason: string | undefined; queued: number; per_job: boolean; free: number | null;
  job_orch_live: number; job_orch_cap: number; pods_max_reserved: number; pods_cap: number }): Binding {
  if (x.note && /at OCTILLION_MAX_JOB_ORCHESTRATORS/.test(x.note)) return "job_orch";
  if (x.note && CAPACITY_NOTE.test(x.note)) return "plan";
  // Shared fleet: the whole fleet at full pods does not fit the limit. Per job: each orchestrator reserves only its own
  // pods, so the limit binds only when work waits and not one more sandbox is free.
  if (!x.per_job && x.budget_reason) return "plan";
  if (x.per_job && x.queued > 0 && x.free != null && x.free < 1) return "plan";
  if (x.queued > 0 && x.per_job && x.job_orch_live >= x.job_orch_cap) return "job_orch";
  if (x.queued > 0 && x.pods_max_reserved >= x.pods_cap) return "pods";
  return null;
}

/**
 * What is active and whose, from the listing (classifiedSandboxes): orchestrators, workers, images and probes are ours;
 * `others` are anyone else's (none on Vercel, where every sandbox listed is ours). Without a listing, the limits'
 * activeNow less what our rows say we hold (`oursHeld`: live orchestrators plus their running workers).
 */
export function sandboxUsage(sb: { ok: boolean; sandboxes: ClassifiedSandbox[] }, limitsActiveNow: number | null, oursHeld: number) {
  const live = sb.sandboxes.filter((s) => s.live);
  const count = (...kinds: SandboxKind[]) => live.filter((s) => kinds.includes(s.kind)).length;
  const others = live.filter((s) => s.kind === "other");
  return {
    active_now: sb.ok ? live.length : limitsActiveNow,
    ours_orch: count("orchestrator"), ours_workers: count("worker"), ours_images: count("image_builder", "image"), ours_probes: count("probe"),
    others: sb.ok ? others.length : limitsActiveNow != null ? Math.max(0, limitsActiveNow - oursHeld) : 0,
    other_prefixes: [...new Set(others.map((s) => s.prefix!))].sort(),
  };
}

// ---------------------------------------------------------------- environment knobs

const KNOBS: { name: string; def: string; meaning: string }[] = [
  { name: "OCTILLION_AUTOSCALE", def: "on", meaning: "Kill switch: off launches and deletes nothing; running orchestrators idle out." },
  { name: "OCTILLION_ORCH_PER_JOB", def: "on", meaning: "One orchestrator per simulation or research job, instead of a shared fleet." },
  { name: "OCTILLION_AUTOSCALE_TICK_SECONDS", def: "15", meaning: "How often the autoscaler ticks on a VM (Vercel ticks on events instead)." },
  { name: "OCTILLION_ORCH_LAUNCHES_PER_TICK", def: "2", meaning: "Most orchestrators launched in one tick." },
  { name: "OCTILLION_ORCH_IDLE_MINUTES", def: "10", meaning: "An orchestrator with nothing to claim this long drains and exits." },
  { name: "OCTILLION_ORCH_STALE_MINUTES", def: "5", meaning: "A running orchestrator with no check-in this long is deleted." },
  { name: "OCTILLION_ORCH_BOOT_MINUTES", def: "10", meaning: "An orchestrator still booting after this long is deleted." },
  { name: "OCTILLION_ORCH_SNAPSHOT", def: "off", meaning: "Boot orchestrators from a snapshot image of the current code." },
  { name: "OCTILLION_POD_CAPACITY", def: "20", meaning: "Worker sandboxes per shared orchestrator (per-job mode uses the Limits setting)." },
  { name: "OCTILLION_FLEET_STALE_SECONDS", def: "90", meaning: "An orchestrator not seen this long no longer counts as live in the fleet." },
  { name: "OCTILLION_RESEARCH_STALE_MINUTES", def: "20", meaning: "Running research with no heartbeat this long gets a new orchestrator." },
  { name: "OCTILLION_SESSION_INFRA_RETRIES", def: "1", meaning: "Times a session that failed on infrastructure is queued again." },
  { name: "OCTILLION_LEASE_MINUTES", def: "30", meaning: "How long a claimed session is held before it can be claimed again." },
  { name: "MAX_SESSION_MINUTES", def: "45", meaning: "Longest an agent session may run before it is stopped as timed out." },
  { name: "OCTILLION_SANDBOX_TTL_MARGIN_MINUTES", def: "15", meaning: "Extra lifetime a worker sandbox gets beyond the session limit." },
  { name: "OCTILLION_SANDBOX_READY_TIMEOUT_SECONDS", def: "300", meaning: "How long a new sandbox may take to become ready." },
];

export function computeKnobs(runtime: "vm" | "vercel") {
  const set = (k: string) => env[k] !== undefined && env[k] !== "";
  return [
    ...KNOBS.map((k) => ({ name: k.name, value: set(k.name) ? String(env[k.name]) : k.def, source: set(k.name) ? "env" as const : "default" as const, meaning: k.meaning })),
    { name: "OCTILLION_SANDBOX_NAMESPACE", value: lib.SANDBOX_NAMESPACE, source: set("OCTILLION_SANDBOX_NAMESPACE") ? "env" as const : "default" as const,
      meaning: "Name prefix of this deployment's sandboxes; it only ever touches sandboxes named with it." },
    { name: "Runtime", value: runtime === "vercel" ? "Vercel" : "VM", source: set("VERCEL") ? "env" as const : "default" as const,
      meaning: runtime === "vercel" ? "Serverless: the autoscaler ticks on events and a cron every 5 minutes." : "A long-running server: the autoscaler ticks on a timer." },
    { name: "Kick configured", value: kickConfigured() ? "yes" : "no", source: "env" as const,
      meaning: "Events can trigger a tick: the autoscaler is on, PUBLIC_URL is HTTPS and OCTILLION_WORKER_TOKEN is set." },
  ];
}

// ---------------------------------------------------------------- the summary

const HEARTBEAT_STALE_S = 90;
let summaryCache: { at: number; value: Awaited<ReturnType<typeof buildSummary>> } | null = null;

/** GET /compute/summary: cached 5 s; `fresh` skips the cache (the page's Refresh). */
export async function computeSummary(opts: { fresh?: boolean } = {}) {
  if (!opts.fresh && summaryCache && Date.now() - summaryCache.at < 5_000) return summaryCache.value;
  const value = await buildSummary(!!opts.fresh);
  summaryCache = { at: Date.now(), value };
  return value;
}

async function buildSummary(fresh: boolean) {
  const db = await getDb();
  const now = Date.now();
  const runtime: "vm" | "vercel" = env.VERCEL ? "vercel" : "vm";
  const perJob = AUTOSCALE.perJob();
  const configError = sandboxConfigError();

  const [lease] = await db.query<{ holder: string; state: TickState | null }>("SELECT holder, state FROM autoscaler_lease WHERE name = 'autoscaler'");
  const tick = lease?.state ?? null;
  const tickAge = tick?.at ? Math.max(0, (now - Date.parse(tick.at)) / 1000) : null;

  const [ses] = await db.query<Record<string, unknown>>(
    `/* tenant: internal: admin Compute page, counts and sums across all orgs, no row data */
     SELECT count(*) FILTER (WHERE status = 'queued') AS queued,
            min(queued_at) FILTER (WHERE status = 'queued') AS oldest_queued,
            count(DISTINCT simulation_id) FILTER (WHERE status = 'queued') AS queued_jobs,
            count(*) FILTER (WHERE status = 'running') AS running,
            count(*) FILTER (WHERE status IN ('failed', 'timeout') AND ended_at > now() - interval '24 hours') AS failed_24h,
            count(*) FILTER (WHERE ended_at > now() - interval '24 hours') AS ended_24h,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM started_at - queued_at)) FILTER (WHERE started_at > now() - interval '1 hour') AS wait_p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM started_at - queued_at)) FILTER (WHERE started_at > now() - interval '1 hour') AS wait_p95,
            count(*) FILTER (WHERE started_at > now() - interval '1 hour') AS wait_n,
            coalesce(sum(cost_usd) FILTER (WHERE ended_at >= current_date), 0) AS model_today,
            coalesce(sum(coalesce(CASE WHEN jsonb_typeof(metadata->'sandbox_est_cost_usd') = 'number' THEN (metadata->>'sandbox_est_cost_usd')::numeric END, CASE WHEN jsonb_typeof(metadata->'boat_est_cost_usd') = 'number' THEN (metadata->>'boat_est_cost_usd')::numeric END))
                     FILTER (WHERE ended_at >= current_date), 0) AS sandbox_today,
            count(*) FILTER (WHERE sandbox_id LIKE 'vercel:%' AND started_at > now() - interval '1 minute') AS starts_minute,
            count(*) FILTER (WHERE sandbox_id LIKE 'vercel:%' AND started_at > now() - interval '1 hour') AS starts_hour,
            count(*) FILTER (WHERE sandbox_id LIKE 'vercel:%' AND started_at > now() - interval '1 day') AS starts_day
       FROM agent_sessions
      WHERE status IN ('queued', 'running') OR ended_at > now() - interval '24 hours' OR started_at > now() - interval '24 hours'`);
  const [rsh] = await db.query<Record<string, unknown>>(
    `/* tenant: internal: admin Compute page, counts across all orgs */
     SELECT count(*) FILTER (WHERE status = 'queued') AS queued, min(created_at) FILTER (WHERE status = 'queued') AS oldest,
            count(*) FILTER (WHERE status = 'running') AS running
       FROM product_research WHERE status IN ('queued', 'running')`);

  // Our orchestrators: live rows, with their fleet check-in (what each runs, by agent).
  const live = await db.query<{ id: number; orchestrator_id: string | null; state: string; job_id: string | null; pods: number | null; created_at: Date;
    ready_at: Date | null; last_seen: Date | null; fleet_seen: Date | null; meta: { running?: Record<string, number>; worker_id?: string } | null }>(
    `SELECT o.id, o.orchestrator_id, o.state, o.job_id, o.pods, o.created_at, o.ready_at, o.last_seen, f.last_seen AS fleet_seen, f.meta
       FROM orchestrator_sandboxes o LEFT JOIN orchestrators f ON f.id = o.orchestrator_id
      WHERE o.state <> 'deleted' ORDER BY o.id`);
  const runningOf = (r: (typeof live)[number]) => Object.values(r.meta?.running ?? {}).reduce((a, b) => a + n(b), 0);
  const byState = { booting: 0, running: 0, draining: 0 } as Record<string, number>;
  for (const r of live) byState[r.state] = (byState[r.state] ?? 0) + 1;
  const podsUsed = live.reduce((a, r) => a + runningOf(r), 0);
  const podsOf = (r: (typeof live)[number]) => r.pods ?? (r.job_id ? 0 : AUTOSCALE.podCapacity());
  const podsReserved = live.reduce((a, r) => a + podsOf(r), 0);
  const jobLive = live.filter((r) => r.job_id);
  // What OCTILLION_MAX_JOB_ORCHESTRATORS counts, as the autoscaler does: booting and running, not draining.
  const jobActive = jobLive.filter((r) => r.state === "booting" || r.state === "running");
  const heartbeatAge = (r: (typeof live)[number]) => {
    const t = r.fleet_seen ?? r.last_seen ?? r.ready_at;
    return t ? (now - new Date(t).getTime()) / 1000 : null;
  };
  const notCheckingIn = live.filter((r) => r.state === "booting" ? now - new Date(r.created_at).getTime() > AUTOSCALE.bootMinutes() * MIN
    : r.state === "running" ? (heartbeatAge(r) ?? Infinity) > HEARTBEAT_STALE_S : false).length;

  // Idle but not drained: running nothing, and no session or research of its worker active for idle + 5 minutes.
  const idleWindowS = (AUTOSCALE.idleMinutes() + 5) * 60;
  const idleCandidates = live.filter((r) => r.state === "running" && runningOf(r) === 0 && r.meta?.worker_id &&
    r.ready_at && (now - new Date(r.ready_at).getTime()) / 1000 > idleWindowS);
  let idle = 0;
  if (idleCandidates.length) {
    const ids = idleCandidates.map((r) => r.meta!.worker_id!);
    const active = new Set((await db.query<{ worker_id: string }>(
      `/* tenant: internal: admin Compute page, by orchestrator worker id, returns only those ids */
       SELECT worker_id FROM agent_sessions WHERE worker_id = ANY($1) AND greatest(heartbeat_at, ended_at, started_at) > now() - make_interval(secs => $2)
       UNION SELECT worker_id FROM product_research WHERE worker_id = ANY($1) AND greatest(heartbeat_at, finished_at, started_at) > now() - make_interval(secs => $2)`,
      [ids, idleWindowS])).map((x) => x.worker_id));
    idle = ids.filter((id) => !active.has(id)).length;
  }

  const [orch] = await db.query<Record<string, unknown>>(
    `SELECT count(*) FILTER (WHERE launch_step IS NOT NULL AND created_at > now() - interval '1 hour') AS failed_1h,
            count(*) FILTER (WHERE launch_step IS NOT NULL AND created_at > now() - interval '24 hours') AS failed_24h,
            count(*) FILTER (WHERE provider = 'vercel' AND created_at > now() - interval '1 minute') AS starts_minute,
            count(*) FILTER (WHERE provider = 'vercel' AND created_at > now() - interval '1 hour') AS starts_hour,
            count(*) FILTER (WHERE provider = 'vercel' AND created_at > now() - interval '1 day') AS starts_day,
            count(*) FILTER (WHERE provider = 'vercel' AND state <> 'deleted') AS vercel_live,
            coalesce(sum(extract(epoch FROM coalesce(deleted_at, now()) - greatest(created_at, current_date::timestamptz)))
                     FILTER (WHERE provider = 'vercel' AND coalesce(deleted_at, now()) > current_date::timestamptz), 0) AS vercel_seconds_today
       FROM orchestrator_sandboxes WHERE created_at > now() - interval '1 day' OR state <> 'deleted' OR deleted_at >= current_date`);
  // The sandbox reliability probe's creates (src/sandbox-probe.ts) are starts in the same project too.
  const [probeStarts] = await db.query<Record<string, unknown>>(
    `SELECT count(*) FILTER (WHERE started_at > now() - interval '1 minute') AS starts_minute,
            count(*) FILTER (WHERE started_at > now() - interval '1 hour') AS starts_hour, count(*) AS starts_day
       FROM sandbox_probes WHERE provider = 'vercel' AND sandbox_id IS NOT NULL AND started_at > now() - interval '1 day'`);
  const [lastFail] = await db.query<{ launch_step: string; launch_error: string | null }>(
    "SELECT launch_step, launch_error FROM orchestrator_sandboxes WHERE launch_step IS NOT NULL AND created_at > now() - interval '1 hour' ORDER BY created_at DESC LIMIT 1");
  const [orchSpend] = await db.query<{ usd: unknown }>("SELECT coalesce(sum(cost_usd), 0) AS usd FROM gateway_model_usage WHERE consumer = 'orchestrator' AND day = current_date");
  const [orphans] = await db.query<{ n: unknown }>("SELECT count(*) AS n FROM compute_events WHERE kind = 'orphan_deleted' AND at > now() - interval '24 hours'");

  // Failed sessions by class (24 h); the most common one names the Failures tile's "top".
  const failed = await db.query<{ status: string; agent_id: string | null; error_message: string | null; completed_reason: string | null; infra_error: string | null }>(
    `/* tenant: internal: admin Compute page, classified into counts across all orgs */
     SELECT status, agent_id, error_message, completed_reason, metadata->>'infra_error' AS infra_error
       FROM agent_sessions WHERE status IN ('failed', 'timeout') AND ended_at > now() - interval '24 hours' ORDER BY ended_at DESC LIMIT 5000`);
  const classes = new Map<string, { key: string; label: string; count: number }>();
  for (const f of failed) {
    const c = classifySession({ ...f, metadata: { infra_error: f.infra_error } });
    if (!c) continue;
    const e = classes.get(c.key) ?? { key: c.key, label: c.label, count: 0 };
    e.count++; classes.set(c.key, e);
  }
  const top = [...classes.values()].sort((a, b) => b.count - a.count)[0] ?? null;

  const demand = await computeDemand().catch(() => null);
  const missingKeys = await agentKeyCoverage().catch(() => []);

  // Our live sandboxes (their rows) and the configured Vercel limits.
  const sb = await classifiedSandboxes({ force: fresh });
  const liveSb = sb.sandboxes.filter((s) => s.live);
  const L = vercelLimits(liveSb.length);
  const liveOrchIds = new Set(live.map((r) => r.orchestrator_id).filter(Boolean));
  const leaked = liveSb.filter((s) => s.kind === "worker" && !(s.parent_orchestrator_id && liveOrchIds.has(s.parent_orchestrator_id))).length;
  const use = sandboxUsage(sb, L.activeNow, live.length + podsUsed);
  const { active_now: activeNow, ours_orch: oursOrch, ours_workers: oursWorkers, others, other_prefixes: otherPrefixes } = use;
  // Capacity orchestrators cannot use: other deployments' sandboxes and our reliability probes.
  const held = others + use.ours_probes;

  const jobCap = AUTOSCALE.maxJobOrchestrators(), podsCap = AUTOSCALE.jobPodCapacity();
  const podCapacity = perJob ? podsCap : AUTOSCALE.podCapacity();
  const budget = lib.computeBudget(L, live.length, podCapacity, L.activeNow - held) /* its other-active is `held` */;
  // free: what the last per-job tick left, else the same formula (limit - others - ours reserved) here.
  const free = typeof tick?.free === "number" ? tick.free : L.activeSandboxes - held - live.reduce((a, r) => a + 1 + podsOf(r), 0);
  const perOrchestrator = 1 + podCapacity;
  const queuedAll = n(ses?.queued) + n(rsh?.queued);
  const podsMax = jobLive.reduce((a, r) => Math.max(a, r.pods ?? 0), 0);
  const binding = bindingLimit({ note: tick?.note ?? null, budget_reason: budget?.reason, queued: queuedAll, per_job: perJob, free,
    job_orch_live: jobActive.length, job_orch_cap: jobCap, pods_max_reserved: podsMax, pods_cap: podsCap });

  const oldestSession = iso(ses?.oldest_queued), oldestResearch = iso(rsh?.oldest);
  const ageOf = (d: string | null) => (d ? Math.max(0, (now - Date.parse(d)) / 1000) : null);
  const facts: VerdictFacts = {
    enabled: AUTOSCALE.enabled(), runtime, kick_configured: kickConfigured(), config_error: configError,
    tick: { age_s: tickAge, error: tick?.error ?? null, note: tick?.note ?? null },
    queue: { sessions: n(ses?.queued), research: n(rsh?.queued), oldest_session_age_s: ageOf(oldestSession), oldest_research_age_s: ageOf(oldestResearch),
             unclaimable: demand?.unclaimable_sessions ?? 0 },
    running: { sessions: n(ses?.running), orchestrators: live.length },
    others, free, per_job: perJob, job_orch_live: jobActive.length, job_orch_cap: jobCap, not_checking_in: notCheckingIn,
    launch_failures_1h: { count: n(orch?.failed_1h), step: lastFail?.launch_step ?? null, message: lastFail?.launch_error?.slice(0, 160) ?? null },
    missing_keys: missingKeys, leaked_workers: leaked, orphan_deletes_24h: n(orphans?.n), namespace: lib.SANDBOX_NAMESPACE, idle_orchestrators: idle,
  };

  const orchSandboxUsd = orchSandboxCostUsd("vercel", n(orch?.vercel_seconds_today));
  const spend = { session_model_usd: usd(n(ses?.model_today)), orchestrator_model_usd: usd(n(orchSpend?.usd)), sandbox_est_usd: usd(n(ses?.sandbox_today) + orchSandboxUsd) };
  const ended = n(ses?.ended_24h), failedN = n(ses?.failed_24h);

  return {
    at: new Date(now).toISOString(),
    runtime,
    verdict: computeVerdict(facts),
    tick: { at: tick?.at ?? null, age_s: tickAge == null ? null : Math.round(tickAge), holder: lease?.holder ?? null, enabled: AUTOSCALE.enabled(),
            kick_configured: kickConfigured(), note: tick?.note ?? null, error: tick?.error ?? null, tick_seconds: AUTOSCALE.tickMs() / 1000, free },
    queue: { sessions: n(ses?.queued), research: n(rsh?.queued), oldest_session_at: oldestSession, oldest_research_at: oldestResearch,
             unclaimable: demand?.unclaimable_sessions ?? 0, jobs_waiting: n(ses?.queued_jobs) + n(rsh?.queued) },
    running: { sessions: n(ses?.running), research: n(rsh?.running), orchestrators: { booting: byState.booting ?? 0, running: byState.running ?? 0, draining: byState.draining ?? 0 },
               pods_used: podsUsed, pods_reserved: podsReserved },
    wait_1h: { p50_s: ses?.wait_p50 == null ? null : Math.round(n(ses.wait_p50)), p95_s: ses?.wait_p95 == null ? null : Math.round(n(ses.wait_p95)), n: n(ses?.wait_n) },
    failures_24h: { sessions: failedN, launches: n(orch?.failed_24h), ended, rate: ended ? failedN / ended : 0, top },
    spend_today: { ...spend, total_usd: usd(spend.session_model_usd + spend.orchestrator_model_usd + spend.sandbox_est_usd) },
    limits: {
      ok: sb.ok, error: sb.error, stale: sb.stale,
      plan: L.activeSandboxes, active_now: activeNow, ours_orch: oursOrch, ours_workers: oursWorkers, ours_images: use.ours_images, ours_probes: use.ours_probes, others, other_prefixes: otherPrefixes,
      our_starts: { minute: n(orch?.starts_minute) + n(ses?.starts_minute) + n(probeStarts?.starts_minute), hour: n(orch?.starts_hour) + n(ses?.starts_hour) + n(probeStarts?.starts_hour),
                    day: n(orch?.starts_day) + n(ses?.starts_day) + n(probeStarts?.starts_day) },
      starts: { per_minute: L.startsPerMinute, per_hour: L.startsPerHour, per_day: L.startsPerDay },
      job_orch_live: jobActive.length, job_orch_draining: jobLive.length - jobActive.length, job_orch_cap: jobCap, shared_orch_live: live.length - jobLive.length, shared_orch_cap: AUTOSCALE.maxOrchestrators(), per_job_mode: perJob,
      pods_max_reserved: podsMax, pods_avg_running: jobLive.length ? Math.round(jobLive.reduce((a, r) => a + runningOf(r), 0) / jobLive.length) : 0, pods_cap: podsCap,
      available: free == null ? null : Math.max(0, Math.floor(free / perOrchestrator)), per_orchestrator: perOrchestrator,
      sessions_per_day_ceiling: budget?.sessionsPerDayCeiling ?? null, reason: budget?.reason ?? null, binding, note: tick?.note ?? null,
      sandbox_prices: { vercel_cpu_hour: VERCEL_SANDBOX_PRICE.cpuHour, vercel_memory_gb_hour: VERCEL_SANDBOX_PRICE.memGbHour },
    },
    settings: await listSettings(),
    knobs: computeKnobs(runtime),
    // Where orchestrators and worker sandboxes run: Vercel Sandbox, the only provider (boat.dev was retired on 2026-11-01).
    hosting: {
      orchestrators: { provider: "vercel" as const, label: PROVIDER_LABEL.vercel }, workers: { provider: "vercel" as const, label: PROVIDER_LABEL.vercel },
      live: { vercel: n(orch?.vercel_live) }, config_error: configError,
      vercel: { starts_hour: n(orch?.starts_hour), starts_per_hour_cap: VERCEL_ORCH.startsPerHour(), max_concurrent: VERCEL_ORCH.maxConcurrent(),
                timeout_minutes: VERCEL_ORCH.timeoutMinutes(), relaunch_minutes: VERCEL_ORCH.relaunchMinutes(), size: VERCEL_ORCH.size(), egress: VERCEL_ORCH.egress() },
    },
    links: { newrelic: env.NEW_RELIC_DASHBOARD_URL || null },
  };
}
