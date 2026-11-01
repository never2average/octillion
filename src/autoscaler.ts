import { mintJobWorkerToken, revokeSandboxWorkerTokens } from "./workerauth.js";
import { hostname } from "node:os";
import { asPlatform } from "./tenant-scope.js";
import { randomBytes } from "node:crypto";
import { getDb } from "./db.js";
import { useCredential } from "./keyvault.js";
import { scheduledAgents, variantsOf } from "./agents.js";
import { getPopulation } from "./populations.js";
import { JOB_POD_CAPACITY, jobState, orchestratorBusy, retireReason, setCurrentCodeHash, staleOrchestratorIds } from "./fleet.js";
import { BOAT } from "../orchestrator/core/config.js";
import { freshSettings, setting, settingNumber } from "./settings.js";
import { freshPlatformHarnesses } from "./harnesses.js";
import { launchFailure, recordComputeEvent } from "./compute-events.js";
import { pruneComputeHistory, recordTick } from "./autoscaler-ticks.js";
import { keepAlive } from "./telemetry.js";
import * as lib from "../orchestrator/deploy/boat-lib.js";
import { boatHost, orchestratorProvider, PROVIDER_LABEL, vercelHost, VERCEL_ORCH, workerProvider,
  type HostLimits, type HostProvider, type HostSandbox, type OrchestratorHost } from "../orchestrator/deploy/orchestrator-host.js";
import { vercelClient } from "./vercel-sandbox.js";
import { environmentTag } from "./worker-sandboxes.js";

/**
 * On-demand orchestrators: scale from zero to zero.
 *
 * Every OCTILLION_AUTOSCALE_TICK_SECONDS (15) the leader (a lease row in Postgres, so several server replicas never
 * double-launch) computes demand: claimable queued+running agent sessions and queued+running product research.
 *   desired = 0 without demand, else max(ceil(sessions / pod capacity), research ? 1 : 0),
 * clamped to OCTILLION_MAX_ORCHESTRATORS and to the provider's capacity (boat: orchestrators + their workers <= plan
 * concurrency; Vercel Sandbox: static limits and a launch rate cap).
 *
 * Where orchestrators run (orchestrator/deploy/orchestrator-host.ts): boat.dev by default (the boat key from the vault,
 * deploy/boat-lib.ts), or Vercel Sandbox with OCTILLION_SANDBOX_PROVIDER=vercel (or OCTILLION_ORCHESTRATOR_PROVIDER, an
 * override for orchestrators only), launched with this function's OIDC token (deploy/vercel-orch.ts). Every row records
 * its provider and is reconciled, reaped and priced there, so orchestrators launched before a switch finish their jobs.
 * Optionally from a snapshot image (OCTILLION_ORCH_SNAPSHOT=on; on boat measured slower than a fresh `npm ci`, ~22s vs ~8s).
 *
 * Scale down: an orchestrator with no claimable work for OCTILLION_ORCH_IDLE_MINUTES (10) drains, leaves the fleet
 * (DELETE /api/worker/fleet/:id marks its row `draining`) and exits; the next tick deletes its sandbox. The tick also
 * reaps stale (no fleet check-in for 5 min), stuck-booting (> 10 min), expired and orphan sandboxes, reconciling
 * against each provider's own listing by name prefix, so nothing leaks across server restarts. A sandbox missing from a
 * listing is reaped only after the provider's get by id says it is gone (listings lag).
 *
 * Kill switch: OCTILLION_AUTOSCALE=off (no launches, no deletes; existing orchestrators keep running and idle out).
 *
 * One orchestrator per job (OCTILLION_ORCH_PER_JOB=on, the default): instead of a shared fleet sized by total demand,
 * every onboarding research and every simulation with claimable sessions gets its own orchestrator, launched with
 * ORCHESTRATOR_JOB=<id>. It claims only that job (claims filtered by simulation_id / research_id), runs a simulation's
 * sessions on up to OCTILLION_JOB_POD_CAPACITY (40) worker sandboxes, and exits when its check-in says the job is
 * over. Launches fit the boat plan: each reserves 1 + its pods; a job that does not fit waits for the next tick. At
 * most OCTILLION_MAX_JOB_ORCHESTRATORS (12) at once. Context passes between the two kinds only through the database
 * (research writes personas with their developer environment and the problems in each persona's words; jobs carry them).
 */

const env = process.env;
const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
export const AUTOSCALE = {
  enabled: () => (env.OCTILLION_AUTOSCALE ?? "on").toLowerCase() !== "off",
  tickMs: () => Math.max(1, num(env.OCTILLION_AUTOSCALE_TICK_SECONDS, 15)) * 1000,
  podCapacity: () => Math.max(1, Math.min(20, num(env.OCTILLION_POD_CAPACITY, num(env.OCTILLION_PODS_PER_ORCHESTRATOR, 20)))),
  maxOrchestrators: () => settingNumber("OCTILLION_MAX_ORCHESTRATORS"), // global setting (/admin/compute), else env
  idleMinutes: () => num(env.OCTILLION_ORCH_IDLE_MINUTES, 10),
  staleMinutes: () => num(env.OCTILLION_ORCH_STALE_MINUTES, 5),
  bootMinutes: () => num(env.OCTILLION_ORCH_BOOT_MINUTES, 10),
  // Measured live 2026-10-10: code upload + `npm ci` boots in ~8s; booting from the named snapshot took ~22s (lazy
  // disk hydration) and each image costs a ~170s build per code change. So the image path is opt-in.
  snapshots: () => (env.OCTILLION_ORCH_SNAPSHOT ?? "off").toLowerCase() === "on",
  maxLaunchesPerTick: () => Math.max(1, num(env.OCTILLION_ORCH_LAUNCHES_PER_TICK, 2)),
  perJob: () => (env.OCTILLION_ORCH_PER_JOB ?? "on").toLowerCase() !== "off",
  jobPodCapacity: () => JOB_POD_CAPACITY(),
  maxJobOrchestrators: () => Math.max(1, settingNumber("OCTILLION_MAX_JOB_ORCHESTRATORS")),
  // Where orchestrators reach the API: OCTILLION_INTERNAL_URL (the API itself) when the public URL is a proxy in front of it.
  publicUrl: () => (env.OCTILLION_INTERNAL_URL || env.PUBLIC_URL || "").replace(/\/$/, ""),
};

export interface Demand {
  sessions: number; queued_sessions: number; research: number;
  /** Queued sessions whose agent is not in the scheduled population: no orchestrator will ever claim them. */
  unclaimable_sessions: number;
  /** Claimable sessions queued after `freshSince` (only when computeDemand was given one). */
  fresh_queued_sessions?: number;
}
export interface Row {
  id: number; sandbox_id: string | null; orchestrator_id: string | null; state: "booting" | "running" | "draining" | "deleted";
  created_at: Date; ready_at: Date | null; last_seen: Date | null; error: string | null; from_image: string | null;
  code_hash: string | null; retiring_since: Date | null; job_id: string | null; pods: number | null;
  /** Which provider hosts it (migration 0017; 'boat' for every older row), and when that provider stops it by itself. */
  provider?: HostProvider | null; expires_at?: Date | null;
  /** Why it ended: the launch step that failed and its error, or the reap reason (`error` holds either, as before). */
  launch_step?: string | null; launch_error?: string | null; reap_reason?: string | null;
}

/**
 * Pure: whether the orphan reaper deletes a live sandbox that no row of ours knows. Only our orchestrator names
 * (`${ns}-orch-`) and an image builder left over 30 minutes; never workers (their orchestrator's reap deletes them),
 * never the sandbox reliability probe's `${ns}-probe-` sandboxes (src/sandbox-probe.ts deletes its own), never others'.
 */
export function orphanKind(sb: Pick<lib.Sb, "name" | "createdAt">, now: number, building: boolean,
  host: Pick<OrchestratorHost, "orchPrefix" | "isImageBuilder"> = { orchPrefix: lib.ORCH_PREFIX, isImageBuilder: (n) => n === lib.IMAGE_BUILDER_NAME }): "orchestrator" | "image_builder" | null {
  // Spared while younger than 2 minutes: a launch records its sandbox right after the create call, and a listing can
  // show it in between (a launch of another tick, or another replica's).
  if (sb.name?.startsWith(host.orchPrefix)) return sb.createdAt && now - Date.parse(sb.createdAt) < 2 * 60_000 ? null : "orchestrator";
  if (host.isImageBuilder(sb.name) && !building && sb.createdAt && now - Date.parse(sb.createdAt) > 30 * 60_000) return "image_builder";
  return null;
}

/** The capacity note a job gets when it cannot launch. Compute pages parse it (CAPACITY_NOTE), old boat wording included. */
export const capacityNote = (job: string, provider: HostProvider, free: number) => `${job} waits for sandbox capacity on ${PROVIDER_LABEL[provider]} (${Math.max(0, free)} free)`;
export const CAPACITY_NOTE = /(\S+) waits for (?:boat plan capacity|sandbox capacity on ([^(]+?)) \((-?\d+) free\)/;

/** Pure: how many orchestrators the demand needs (before caps). */
export function desiredOrchestrators(d: Demand, podCapacity: number): number {
  const s = d.sessions > 0 ? Math.ceil(d.sessions / podCapacity) : 0;
  return Math.max(s, d.research > 0 ? 1 : 0);
}

export async function computeDemand(freshSince?: Date): Promise<Demand> {
  const db = await getDb();
  let agents: string[] = [];
  try { agents = scheduledAgents(await getPopulation()).flatMap((a) => [a.id, ...variantsOf(a).map((v) => v.id)]); }
  catch { /* no population: count everything */ }
  const claimable = "(agent_id IS NULL OR cardinality($1::text[]) = 0 OR agent_id = ANY($1))";
  const [s] = await db.query<{ sessions: number; queued: number; unclaimable: number; fresh: number }>(
    `/* tenant: internal: autoscaler demand counts across all orgs, counts only */ SELECT count(*) FILTER (WHERE ${claimable}) AS sessions,
            count(*) FILTER (WHERE status = 'queued' AND ${claimable}) AS queued,
            count(*) FILTER (WHERE status = 'queued' AND NOT ${claimable}) AS unclaimable,
            count(*) FILTER (WHERE status = 'queued' AND ${claimable} AND $2::timestamptz IS NOT NULL AND queued_at > $2) AS fresh
       FROM agent_sessions WHERE status IN ('queued', 'running')`, [agents, freshSince ?? null]);
  const [r] = await db.query<{ n: number }>("/* tenant: internal: autoscaler demand counts across all orgs, counts only */ SELECT count(*) AS n FROM product_research WHERE status IN ('queued', 'running')");
  return {
    sessions: Number(s?.sessions ?? 0), queued_sessions: Number(s?.queued ?? 0), research: Number(r?.n ?? 0),
    unclaimable_sessions: Number(s?.unclaimable ?? 0), ...(freshSince ? { fresh_queued_sessions: Number(s?.fresh ?? 0) } : {}),
  };
}

/** A job that wants its own orchestrator (per-job mode). */
export interface JobDemand { id: string; kind: "simulation" | "research"; sessions: number; queued: number; last_queued: Date | null }

/** Research that is queued (or stalled), and simulations with claimable sessions still to run, oldest first. */
export async function computeJobDemand(): Promise<JobDemand[]> {
  const db = await getDb();
  let agents: string[] = [];
  try { agents = scheduledAgents(await getPopulation()).flatMap((a) => [a.id, ...variantsOf(a).map((v) => v.id)]); }
  catch { /* no population: count everything */ }
  const research = await db.query<{ id: string }>(
    `/* tenant: internal: autoscaler job demand across all orgs, ids go to the orchestrator only */ SELECT id FROM product_research WHERE status = 'queued'
        OR (status = 'running' AND heartbeat_at < now() - make_interval(mins => $1)) ORDER BY created_at`,
    [num(env.OCTILLION_RESEARCH_STALE_MINUTES, 20)]);
  const sims = await db.query<{ id: string; sessions: number; queued: number; last_queued: Date | null }>(
    `/* tenant: internal: autoscaler job demand across all orgs, ids go to the orchestrator only */ SELECT simulation_id AS id, count(*) AS sessions, count(*) FILTER (WHERE status = 'queued') AS queued,
            max(queued_at) FILTER (WHERE status = 'queued') AS last_queued
       FROM agent_sessions
      WHERE status IN ('queued', 'running') AND (agent_id IS NULL OR cardinality($1::text[]) = 0 OR agent_id = ANY($1))
      GROUP BY simulation_id HAVING count(*) FILTER (WHERE status = 'queued') > 0 ORDER BY min(queued_at)`, [agents]);
  return [
    ...research.map((r) => ({ id: r.id, kind: "research" as const, sessions: 0, queued: 0, last_queued: null })),
    ...sims.map((s) => ({ id: s.id, kind: "simulation" as const, sessions: Number(s.sessions), queued: Number(s.queued),
                          last_queued: s.last_queued ? new Date(s.last_queued) : null })),
  ];
}

export interface TickState {
  at: string; enabled: boolean; leader: boolean; holder: string; demand?: Demand; desired?: number; cap?: number;
  active?: number; launched?: string[]; reaped?: { sandbox_id: string; reason: string }[]; image?: string | null; note?: string; error?: string;
  /** Per-job mode: the jobs wanting an orchestrator and whether one serves them. */
  jobs?: { id: string; kind: string; sessions: number; served: boolean }[];
  /** Per-job mode: sandboxes left on the provider after this tick's launches (plan - other deployments - ours reserved). */
  free?: number;
  /** Where new orchestrators start (boat or vercel), and where worker sandboxes run. */
  provider?: HostProvider; worker_provider?: HostProvider;
  /** What `launched` names, as data: the orchestrator row inserted, and its job and pods (per-job mode). */
  launches?: Launch[];
}
export interface Launch { row: number; job_id: string | null; pods: number | null; label: string }

/** Ticks a row may stay unlisted with a failing get before it is ended (should-fix: never kept forever). */
const GET_FAILURES = 3;

export class Autoscaler {
  readonly holder = `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;
  private inflight = new Map<number, Promise<void>>();
  /** Rows whose sandbox the listing lacks and whose get keeps failing: consecutive failed ticks. */
  private getFailures = new Map<number, number>();
  /** When the current tick's launches must be done by (the cron function's limit); null on a VM. */
  private launchDeadline: number | null = null;
  private imageBuild: Promise<unknown> | null = null;
  private keyAt = 0;
  private limits = new Map<HostProvider, { at: number; v: HostLimits }>();
  private hostCache: Partial<Record<HostProvider, OrchestratorHost>> = {};
  private lastDrainAt = 0;
  /** Per-job mode: when each job's orchestrator last idled out (cooldown against relaunch loops). */
  private jobDrainAt = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  last: TickState | null = null;

  /** `hosts` replaces a provider's host (tests). */
  constructor(private opts: { log?: (m: string) => void; root?: string; hosts?: Partial<Record<HostProvider, OrchestratorHost>> } = {}) {}
  private log(m: string) { (this.opts.log ?? ((x: string) => console.error(`autoscaler: ${x}`)))(m); }

  start() {
    if (this.timer) return;
    let prunedAt = 0;
    const loop = async () => {
      try { await this.tick(); } catch (e) { this.log(`tick failed: ${(e as Error).message}`); }
      // History retention (autoscaler_ticks 14 days, compute_events 90), never inside a tick. Vercel prunes from its cron.
      // Loss reasons (src/reasons.ts) queued while no drain ran, or due for a retry. Never inside a tick.
      void import("./reasons.js").then((r) => r.kickReasons()).catch(() => {});
      if (Date.now() - prunedAt > 6 * 3600_000) {
        prunedAt = Date.now();
        await pruneComputeHistory().catch((e) => this.log(`prune failed: ${(e as Error).message}`));
      }
      this.timer = setTimeout(loop, AUTOSCALE.tickMs());
      this.timer.unref();
    };
    this.timer = setTimeout(loop, 1000);
    this.timer.unref();
  }
  stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  /** Stop ticking and give up the lease, so another replica (a rolling deploy's new one) leads on its next tick. */
  async release(): Promise<void> {
    this.stop();
    await (await getDb()).query("DELETE FROM autoscaler_lease WHERE name = 'autoscaler' AND holder = $1", [this.holder]).catch(() => {});
  }
  /** Wait for in-flight launches and image builds (tests; serverless, before the function is frozen). */
  async settle() { await Promise.allSettled([...this.inflight.values(), this.imageBuild]); }

  /** Lease row: one leader across replicas; renewed every tick, expires after 3 ticks. */
  async acquireLease(): Promise<boolean> {
    const db = await getDb();
    const ttl = Math.ceil((AUTOSCALE.tickMs() * 3) / 1000);
    const rows = await db.query<{ holder: string }>(
      `INSERT INTO autoscaler_lease (name, holder, expires_at) VALUES ('autoscaler', $1, now() + make_interval(secs => $2))
       ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
         WHERE autoscaler_lease.holder = excluded.holder OR autoscaler_lease.expires_at < now()
       RETURNING holder`, [this.holder, ttl]);
    return rows[0]?.holder === this.holder;
  }

  private async boatKey() {
    if (BOAT.apiKey && Date.now() - this.keyAt < 10 * 60_000) return;
    BOAT.apiKey = (await useCredential("boat")).secret;
    this.keyAt = Date.now();
  }

  /**
   * The host for a provider. boat: deploy/boat-lib.ts with the vault key. vercel: this function's OIDC token (the latest
   * request's), built again on every call so a rotated token is picked up; never handed to an orchestrator.
   */
  host(p: HostProvider): OrchestratorHost {
    const given = this.opts.hosts?.[p];
    if (given) return given;
    if (p === "boat") return (this.hostCache.boat ??= boatHost());
    const c = vercelClient();
    if ("not_configured" in c) throw new Error(`Vercel Sandbox is not configured on this deployment: ${c.not_configured}`);
    return vercelHost({ client: c, namespace: lib.BOAT_NAMESPACE, envTag: environmentTag() });
  }

  private async hostLimits(h: OrchestratorHost): Promise<HostLimits> {
    const c = this.limits.get(h.provider);
    if (c && Date.now() - c.at <= 5 * 60_000) return c.v;
    const v = await h.limits();
    this.limits.set(h.provider, { at: Date.now(), v });
    return v;
  }

  /** Sandboxes of ours a listing holds (boat: orchestrators and workers on the account; Vercel: our orchestrators). */
  private static oursActive(h: OrchestratorHost, listing: HostSandbox[]): number {
    if (h.provider === "boat") return listing.filter((s) => s.live && (s.name?.startsWith(lib.ORCH_PREFIX) || s.name?.startsWith(lib.WORKER_PREFIX))).length;
    return listing.filter((s) => s.live && s.name?.startsWith(h.orchPrefix)).length;
  }

  private async cap(h: OrchestratorHost, oursActive: number): Promise<number> {
    const b = lib.computeBudget(await this.hostLimits(h), 0, AUTOSCALE.podCapacity(), oursActive);
    return Math.max(0, Math.min(AUTOSCALE.maxOrchestrators(), b.maxOrchestrators));
  }

  /** Vercel: orchestrator launches in the last hour against OCTILLION_VERCEL_ORCH_STARTS_PER_HOUR (boat's plan limits pace boat). */
  private async rateCapped(p: HostProvider): Promise<string | null> {
    if (p !== "vercel") return null;
    const [r] = await (await getDb()).query<{ n: number }>(
      "SELECT count(*) AS n FROM orchestrator_sandboxes WHERE provider = 'vercel' AND created_at > now() - interval '1 hour'");
    const cap = VERCEL_ORCH.startsPerHour();
    return Number(r?.n ?? 0) >= cap ? `launch rate cap: ${cap} Vercel orchestrators per hour (OCTILLION_VERCEL_ORCH_STARTS_PER_HOUR)` : null;
  }

  /** One tick. A tick asked for while one runs (the loop and "Run a tick now" in the same process) shares that tick
   * rather than starting a second one beside it, which could launch the same job's orchestrator twice. */
  tick(opts: { launchDeadline?: number | null } = {}): Promise<TickState> {
    if (!this.ticking) this.launchDeadline = opts.launchDeadline ?? null;
    return (this.ticking ??= this.tickOnce().finally(() => { this.ticking = null; }));
  }
  private ticking: Promise<TickState> | null = null;

  private async tickOnce(): Promise<TickState> {
    await freshSettings(); // caps and launch tuning come from global settings
    await freshPlatformHarnesses(); // demand and pod plans count admin-added harnesses (registry())
    const st: TickState = { at: new Date().toISOString(), enabled: AUTOSCALE.enabled(), leader: false, holder: this.holder };
    if (!st.enabled) { this.last = { ...st, note: "OCTILLION_AUTOSCALE=off" }; return this.last; }
    if (!(await this.acquireLease())) { this.last = { ...st, note: "not the leader" }; return this.last; }
    st.leader = true;
    const db = await getDb();
    try {
      const current = orchestratorProvider();
      st.provider = current; st.worker_provider = workerProvider();
      const rowsAll = await db.query<Row>("SELECT * FROM orchestrator_sandboxes WHERE state <> 'deleted' ORDER BY id");
      // The providers this tick talks to: where new orchestrators start, and wherever a live row still is. boat also for
      // its worker sandboxes (the workers of a reaped orchestrator). No boat key is needed when nothing is on boat.
      const providers = new Set<HostProvider>([current, ...rowsAll.map((r) => (r.provider ?? "boat") as HostProvider)]);
      if (st.worker_provider === "boat") providers.add("boat");
      if (providers.has("boat")) await this.boatKey();
      // Sessions queued in the last FRESH_MS before an idle exit (or after it) were never ignored by a live orchestrator,
      // so they are new work, not stuck work: they must not wait out the relaunch cooldown below.
      const FRESH_MS = 2 * 60_000;
      const demand = await computeDemand(this.lastDrainAt ? new Date(this.lastDrainAt - FRESH_MS) : undefined);
      st.demand = demand;
      // Each provider's listing. The current provider's failure fails the tick, as before; another's only skips its rows.
      const hosts = new Map<HostProvider, OrchestratorHost>();
      const listings = new Map<HostProvider, HostSandbox[]>();
      const skipped: string[] = [];
      for (const p of providers) {
        try { const h = this.host(p); hosts.set(p, h); listings.set(p, await h.list()); }
        catch (e) { if (p === current) throw e; skipped.push(`${PROVIDER_LABEL[p]} not listed (${(e as Error).message.slice(0, 160)}): its orchestrators wait for the next tick`); }
      }
      const listing = listings.get(current) ?? [];
      const byId = new Map([...listings.values()].flat().map((s) => [s.id, s]));
      const boatListing = listings.get("boat") ?? [];
      const rows = rowsAll;
      const seen = new Map((await db.query<{ id: string; last_seen: Date }>("SELECT id, last_seen FROM orchestrators")).map((o) => [o.id, new Date(o.last_seen)]));
      const now = Date.now(), min = 60_000;
      setCurrentCodeHash(lib.codeHash(this.opts.root)); // what this autoscaler launches; older code is retired
      const staleIds = await staleOrchestratorIds();
      const reaped: { sandbox_id: string; reason: string }[] = [];
      const reap = async (row: Row, reason: string, deleteIt = true) => {
        const h = hosts.get((row.provider ?? "boat") as HostProvider);
        if (row.sandbox_id && deleteIt && h) await h.delete(row.sandbox_id).catch((e) => this.log(`delete ${row.sandbox_id}: ${(e as Error).message}`));
        await db.query("UPDATE orchestrator_sandboxes SET state = 'deleted', deleted_at = now(), error = coalesce(error, $2), reap_reason = coalesce(reap_reason, $2) WHERE id = $1", [row.id, reason]);
        await recordComputeEvent({ kind: "reaped", sandbox_id: row.sandbox_id, orchestrator_id: row.orchestrator_id, job_id: row.job_id, reason });
        await revokeSandboxWorkerTokens(row.id);
        if (row.orchestrator_id) {
          await db.query("DELETE FROM orchestrators WHERE id = $1", [row.orchestrator_id]);
          // boat worker sandboxes a crashed/stale orchestrator could not clean up itself (octi-w-<orch>-<agent>). Vercel
          // worker sandboxes belong to the API's broker, whose reaper deletes them once this orchestrator's token is revoked.
          const wp = `${lib.workerPrefixOf(row.orchestrator_id)}-`;
          for (const w of boatListing.filter((s) => s.live && s.name?.startsWith(wp))) {
            await lib.deleteSandbox(w.id).catch(() => {});
            reaped.push({ sandbox_id: w.id, reason: `worker of reaped ${row.orchestrator_id}` });
            await recordComputeEvent({ kind: "worker_deleted", sandbox_id: w.id, orchestrator_id: row.orchestrator_id, job_id: row.job_id, reason: `worker of reaped ${row.orchestrator_id} (${reason})` });
          }
        }
        reaped.push({ sandbox_id: row.sandbox_id ?? "(none)", reason });
        this.log(`reaped ${row.sandbox_id ?? `row ${row.id}`}: ${reason}`);
      };

      // 1. reconcile our rows with their provider + the fleet, reap what must go
      for (const row of rows) {
        const age = now - new Date(row.created_at).getTime();
        const inflight = this.inflight.has(row.id);
        const prov = (row.provider ?? "boat") as HostProvider;
        const h = hosts.get(prov);
        if (!h || !listings.has(prov)) continue; // its provider did not answer this tick
        if (!row.sandbox_id) { if (!inflight && age > AUTOSCALE.bootMinutes() * min) await reap(row, "launch never created a sandbox", false); continue; }
        let sb = byId.get(row.sandbox_id);
        if (!sb || !sb.live) {
          if (inflight && age < 2 * min) continue; // listing can lag a fresh create
          // A listing can lag or drop a live sandbox: only the provider's own get by id may say it is gone.
          let got: HostSandbox | null | undefined;
          try { got = await h.get(row.sandbox_id); this.getFailures.delete(row.id); }
          catch (e) {
            // The provider could not tell. Keep the row, but not forever: after GET_FAILURES ticks in a row it is ended
            // (without a delete call, which would fail the same way); meanwhile the boot, TTL and stale checks below apply.
            const n = (this.getFailures.get(row.id) ?? 0) + 1;
            this.getFailures.set(row.id, n);
            this.log(`get ${row.sandbox_id}: ${(e as Error).message} (${n}/${GET_FAILURES})`);
            if (n >= GET_FAILURES) {
              this.getFailures.delete(row.id);
              await reap(row, `sandbox gone from ${prov === "boat" ? "boat" : PROVIDER_LABEL[prov]}: not listed and its get failed ${n} ticks in a row (${(e as Error).message.slice(0, 120)})`, false);
              continue;
            }
            got = undefined;
          }
          if (got === null || (got && !got.live)) {
            await reap(row, got ? `sandbox is ${got.state}` : `sandbox gone from ${prov === "boat" ? "boat" : PROVIDER_LABEL[prov]}`, !!got);
            continue;
          }
          if (got) this.log(`${row.sandbox_id} is live although ${sb ? `listed as ${sb.state}` : "not listed"} (listing lag): kept`);
          sb = got;
        }
        if (row.state === "draining") {
          this.lastDrainAt = now;
          if (row.job_id) this.jobDrainAt.set(row.job_id, now);
          await reap(row, row.job_id ? `drained (job ${row.job_id} over or idle)` : "drained (idle exit)");
          continue;
        }
        const expires = sb?.expiresAt ?? (row.expires_at ? new Date(row.expires_at).getTime() : null);
        if (expires && expires < now + 5 * min) { await reap(row, prov === "boat" ? "TTL about to expire" : "TTL about to expire (sandbox timeout)"); continue; }
        if (row.state === "booting") {
          if (!inflight && age > AUTOSCALE.bootMinutes() * min) await reap(row, `stuck booting > ${AUTOSCALE.bootMinutes()} min`);
          continue;
        }
        // running
        const checkIn = row.orchestrator_id ? seen.get(row.orchestrator_id) : undefined;
        if (checkIn) await db.query("UPDATE orchestrator_sandboxes SET last_seen = $2 WHERE id = $1", [row.id, checkIn]);
        // Recycle on deploy (src/fleet.ts): once a pre-deploy orchestrator has been handed its empty assignment and
        // has checked in again since, delete it as soon as nothing of its is running. No idle-timeout wait.
        if (row.orchestrator_id && staleIds.has(row.orchestrator_id)) {
          const told = row.retiring_since ? new Date(row.retiring_since).getTime() : 0;
          if (told && checkIn && checkIn.getTime() > told && !(await orchestratorBusy(row.orchestrator_id))) {
            await reap(row, retireReason(row, now));
            continue;
          }
        }
        // Per-job backstop: the orchestrator leaves by itself when its check-in reports the job over; if it has not
        // within 3 minutes and runs nothing, delete it.
        if (row.job_id && row.orchestrator_id) {
          const js = await jobState(row.job_id);
          if (js.done && now - (js.finished_at?.getTime() ?? 0) > 3 * min && !(await orchestratorBusy(row.orchestrator_id))) {
            await reap(row, `job ${row.job_id} is ${js.status ?? "gone"}`);
            continue;
          }
        }
        const since = checkIn?.getTime() ?? (row.ready_at ? new Date(row.ready_at).getTime() : new Date(row.created_at).getTime());
        if (now - since > AUTOSCALE.staleMinutes() * min) await reap(row, `stale: no fleet check-in for ${AUTOSCALE.staleMinutes()} min`);
      }
      // orphans: our name prefix on a provider but no live row (e.g. a launch interrupted by a server restart)
      const known = new Set((await db.query<{ sandbox_id: string }>("SELECT sandbox_id FROM orchestrator_sandboxes WHERE state <> 'deleted' AND sandbox_id IS NOT NULL")).map((r) => r.sandbox_id));
      const reapedIds = new Set(reaped.map((r) => r.sandbox_id)); // the listing predates this tick's reaping
      for (const [p, list] of listings) {
        const h = hosts.get(p)!;
        for (const sb of list) {
          if (!sb.live || known.has(sb.id) || reapedIds.has(sb.id)) continue;
          const kind = orphanKind(sb, now, !!this.imageBuild, h);
          const isOrch = kind === "orchestrator";
          if (kind) {
            await h.delete(sb.id).catch(() => {});
            const reason = isOrch ? "orphan orchestrator sandbox (no row)" : "stale image builder";
            reaped.push({ sandbox_id: sb.id, reason });
            await recordComputeEvent({ kind: isOrch ? "orphan_deleted" : "image_builder_deleted", sandbox_id: sb.id,
                                       orchestrator_id: isOrch ? h.orchIdOf(sb.id) : null, reason: `${reason}: ${sb.name}` });
            this.log(`deleted orphan ${sb.id} (${sb.name})`);
          }
        }
      }
      st.reaped = reaped;
      const host = hosts.get(current)!;

      // 2. scale up within the caps
      if (AUTOSCALE.perJob()) {
        await this.scaleJobs(st, staleIds, host, listing, now, listings.get("boat") ?? null);
      } else {
        // Retiring (pre-deploy) orchestrators claim nothing new, so they do not count as capacity for the demand.
        const active = (await db.query<Row>("SELECT * FROM orchestrator_sandboxes WHERE state IN ('booting', 'running')"))
          .filter((r) => !(r.orchestrator_id && staleIds.has(r.orchestrator_id))).length;
        const cap = await this.cap(host, Autoscaler.oursActive(host, listing));
        let desired = Math.min(desiredOrchestrators(demand, AUTOSCALE.podCapacity()), cap);
        // An orchestrator just idled out while sessions are still "queued": they are not claimable by it; don't relaunch
        // in a loop (each launch is a boat start). Research or freshly queued sessions launch right away.
        if (demand.research === 0 && demand.sessions > 0 && !demand.fresh_queued_sessions && active === 0 &&
            now - this.lastDrainAt < AUTOSCALE.idleMinutes() * min) {
          st.note = "cooldown: the last orchestrator idled out with these sessions still queued";
          desired = 0;
        }
        st.active = active; st.cap = cap; st.desired = desired;
        st.launched = []; st.launches = [];
        const image = AUTOSCALE.snapshots() ? await this.readyImage(host) : null;
        st.image = image;
        for (let i = 0; i < Math.min(desired - active, AUTOSCALE.maxLaunchesPerTick()); i++) {
          const capped = await this.rateCapped(current);
          if (capped) { st.note = [st.note, capped].filter(Boolean).join("; "); break; }
          const l = await this.launch(host, image);
          st.launched.push(l.label); st.launches.push(l);
        }
      }
      if (skipped.length) st.note = [st.note, ...skipped].filter(Boolean).join("; ");

      // 3. keep the image current (built in the background, once per code hash)
      if (AUTOSCALE.snapshots() && !st.image && !this.imageBuild && host.image) {
        this.imageBuild = host.image.build({ root: this.opts.root, log: (m) => this.log(m) })
          .catch((e) => this.log(`image build failed: ${(e as Error).message}`))
          .finally(() => { this.imageBuild = null; });
      }
    } catch (e) {
      // undici's "fetch failed" hides the reason (DNS, refused, TLS) in .cause
      const cause = (e as { cause?: { code?: string; message?: string; hostname?: string } }).cause;
      st.error = (e as Error).message + (cause ? ` (${[cause.code, cause.hostname, cause.message].filter(Boolean).join(" ")})` : "");
      this.log(`tick error: ${st.error}`);
      await recordComputeEvent({ kind: "tick_error", reason: st.error });
    }
    this.last = st;
    await db.query("UPDATE autoscaler_lease SET state = $2 WHERE name = 'autoscaler' AND holder = $1", [this.holder, JSON.stringify(st)]).catch(() => {});
    await recordTick(st); // history for the Compute page: acting ticks, and a sample once a minute
    return st;
  }

  private imageCache: { key: string; name: string | null; at: number } | null = null;
  private async readyImage(h: OrchestratorHost): Promise<string | null> {
    if (!h.image) return null;
    const hash = lib.codeHash(this.opts.root), key = `${h.provider}:${hash}`;
    if (this.imageCache?.key === key && this.imageCache.name && Date.now() - this.imageCache.at < 10 * 60_000) return this.imageCache.name;
    const name = await h.image.ready(hash).catch(() => null);
    this.imageCache = { key, name, at: Date.now() };
    return name;
  }

  /**
   * Per-job mode: one orchestrator for each job that has none, oldest first (research before runs: a customer is
   * waiting on it and it needs a single sandbox). Each launch reserves 1 + its pods on the provider; a run gets
   * min(JOB_POD_CAPACITY, its unfinished sessions, what is free). A job whose orchestrator just idled out with nothing
   * new queued waits out the idle period (no relaunch loop on work it cannot claim).
   */
  private async scaleJobs(st: TickState, staleIds: Set<string>, host: OrchestratorHost, listing: HostSandbox[], now: number, boatListing: HostSandbox[] | null = null): Promise<void> {
    const db = await getDb();
    const min = 60_000, FRESH_MS = 2 * min;
    const jobs = await computeJobDemand();
    const live = await db.query<Row>("SELECT * FROM orchestrator_sandboxes WHERE state IN ('booting', 'running')");
    const isRetiring = (r: Row) => !!(r.orchestrator_id && staleIds.has(r.orchestrator_id));
    const served = new Set(live.filter((r) => r.job_id && !isRetiring(r)).map((r) => r.job_id!));
    const workersOf = (orchId: string) => listing.filter((s) => s.live && s.name?.startsWith(`${lib.workerPrefixOf(orchId)}-`)).length;
    // The provider's capacity: what others use, plus what each live orchestrator of ours there holds or has reserved. A
    // retiring one only holds the workers it still runs (it claims nothing new); a shared one counts the workers it has.
    // boat: the plan from /limits. Vercel: static limits (OCTILLION_VERCEL_MAX_CONCURRENT), nobody else's sandboxes.
    const limits = await this.hostLimits(host);
    const oursActive = Autoscaler.oursActive(host, listing);
    const here = live.filter((r) => (r.provider ?? "boat") === host.provider);
    const reserved = here.reduce((n, r) => n + 1 + (r.pods != null && !isRetiring(r) ? r.pods : r.orchestrator_id ? workersOf(r.orchestrator_id) : 0), 0);
    let free = limits.activeSandboxes - Math.max(0, limits.activeNow - oursActive) - reserved;
    let active = live.filter((r) => !isRetiring(r)).length;
    // Orchestrators on Vercel with workers on boat (OCTILLION_ORCHESTRATOR_PROVIDER=vercel alone): the workers still need
    // boat's plan. Every live orchestrator's pods (or the boat workers it runs) and boat-hosted orchestrators count there.
    let boatFree = Infinity;
    if (host.provider !== "boat" && workerProvider() === "boat" && boatListing) {
      const bh = this.host("boat"), bl = await this.hostLimits(bh);
      const boatWorkersOf = (orchId: string) => boatListing.filter((s) => s.live && s.name?.startsWith(`${lib.workerPrefixOf(orchId)}-`)).length;
      const reservedBoat = live.reduce((n, r) => n + ((r.provider ?? "boat") === "boat" ? 1 : 0) +
        (r.pods != null && !isRetiring(r) ? r.pods : r.orchestrator_id ? boatWorkersOf(r.orchestrator_id) : 0), 0);
      boatFree = bl.activeSandboxes - Math.max(0, bl.activeNow - Autoscaler.oursActive(bh, boatListing)) - reservedBoat;
    }
    const image = AUTOSCALE.snapshots() ? await this.readyImage(host) : null;
    const notes: string[] = [];
    st.launched = []; st.launches = [];
    st.image = image;
    for (const j of jobs) {
      if (served.has(j.id)) continue;
      if (st.launched.length >= AUTOSCALE.maxLaunchesPerTick()) break;
      if (active >= AUTOSCALE.maxJobOrchestrators()) { notes.push(`at OCTILLION_MAX_JOB_ORCHESTRATORS (${AUTOSCALE.maxJobOrchestrators()})`); break; }
      const capped = await this.rateCapped(host.provider); // counted again per launch: each inserts its row first
      if (capped) { notes.push(capped); break; }
      const drained = this.jobDrainAt.get(j.id);
      if (drained && now - drained < AUTOSCALE.idleMinutes() * min && !(j.last_queued && j.last_queued.getTime() > drained - FRESH_MS)) {
        notes.push(`cooldown: ${j.id}'s orchestrator idled out with its sessions still queued`);
        continue;
      }
      const pods = j.kind === "research" ? 0 : Math.min(AUTOSCALE.jobPodCapacity(), j.sessions, free - 1, boatFree);
      if (free < 1 || (j.kind === "simulation" && pods < 1)) {
        notes.push(free >= 1 && boatFree < 1 ? capacityNote(j.id, "boat", boatFree) : capacityNote(j.id, host.provider, free));
        continue;
      }
      const l = await this.launch(host, image, { id: j.id, pods });
      st.launched.push(l.label); st.launches.push(l);
      served.add(j.id);
      free -= 1 + pods;
      boatFree -= pods;
      active++;
    }
    st.jobs = jobs.map((j) => ({ id: j.id, kind: j.kind, sessions: j.sessions, served: served.has(j.id) }));
    st.active = active; st.cap = AUTOSCALE.maxJobOrchestrators(); st.desired = jobs.length; st.free = free;
    if (notes.length) st.note = notes.join("; ");
  }

  /** Insert the row first (counts toward `active` at once), then create + configure + start in the background. */
  private async launch(host: OrchestratorHost, image: string | null, job?: { id: string; pods: number }): Promise<Launch> {
    const db = await getDb();
    const [row] = await db.query<{ id: number }>(
      "INSERT INTO orchestrator_sandboxes (state, from_image, code_hash, job_id, pods, provider) VALUES ('booting', $1, $2, $3, $4, $5) RETURNING id",
      [image, lib.codeHash(this.opts.root), job?.id ?? null, job ? job.pods : null, host.provider]);
    const id = row!.id;
    // A per-job orchestrator gets a token bound to its job, never the fleet token (docs/security.md, phase 0b).
    const workerToken = job ? await mintJobWorkerToken(job.id, id) : env.OCTILLION_WORKER_TOKEN ?? "";
    const tuning: Record<string, string> = { OCTILLION_ORCH_IDLE_MINUTES: String(AUTOSCALE.idleMinutes()) };
    // Global settings (/admin/compute) win over this server's env: e.g. BOAT_SANDBOX_SIZE, RESEARCH_MAX_COST_USD, ORCHESTRATOR_MODEL.
    for (const k of lib.TUNING_VARS) { const v = setting(k) ?? env[k]; if (v != null && v !== "") tuning[k] = String(v); }
    if (job) tuning.ORCHESTRATOR_JOB = job.id;
    tuning.OCTILLION_BOAT_NAMESPACE = lib.BOAT_NAMESPACE; // its worker sandboxes carry this deployment's prefix
    const p = host.launch(
      { url: AUTOSCALE.publicUrl(), workerToken, podCapacity: job ? Math.max(1, job.pods) : AUTOSCALE.podCapacity(), tuning, root: this.opts.root, log: (m) => this.log(m) },
      { image, deadline: this.launchDeadline ?? undefined, onCreated: async (sandboxId, orchId, info) => {
        await db.query("UPDATE orchestrator_sandboxes SET sandbox_id = $2, orchestrator_id = $3, expires_at = $4 WHERE id = $1", [id, sandboxId, orchId, info?.expiresAt ?? null]);
      } },
    ).then(async (r) => {
      await db.query("UPDATE orchestrator_sandboxes SET state = 'running', ready_at = now(), from_image = $2, timings = $3 WHERE id = $1 AND state = 'booting'",
        [id, r.fromImage ? image : null, JSON.stringify(r.timings)]);
      this.log(`launched ${r.sandboxId} (${r.orchId}) on ${host.label} in ${Math.round((r.timings.started ?? 0) / 1000)}s${r.fromImage ? " from image" : " (code upload + npm ci)"}`);
    }).catch(async (e) => {
      const f = launchFailure(e);
      const [r] = await db.query<{ sandbox_id: string | null; orchestrator_id: string | null }>(
        `UPDATE orchestrator_sandboxes SET state = 'deleted', deleted_at = now(), error = $2, launch_step = $3, launch_error = $4
          WHERE id = $1 RETURNING sandbox_id, orchestrator_id`, [id, f.message.slice(0, 500), f.step, f.error.slice(0, 500)]);
      await recordComputeEvent({ kind: "launch_failed", sandbox_id: r?.sandbox_id, orchestrator_id: r?.orchestrator_id, job_id: job?.id, step: f.step, reason: f.error });
      await revokeSandboxWorkerTokens(id);
      this.log(`launch failed: ${f.message}`);
    }).finally(() => { this.inflight.delete(id); });
    this.inflight.set(id, p);
    return { row: id, job_id: job?.id ?? null, pods: job ? job.pods : null, label: job ? `row ${id} (${job.id}, ${job.pods} pods)` : `row ${id}` };
  }
}

let singleton: Autoscaler | null = null;

/**
 * Serverless (Vercel) has no ticking loop, so the autoscaler runs on events instead: a deep research job queued, an
 * orchestrator checking in or leaving, and a cron every 5 minutes (vercel.json). One tick, then wait for its launches (boat create + code
 * upload + start) so the function is not frozen mid-launch. At most one kick per instance every 10 seconds.
 */
let lastKick = 0;
/** Can this deployment kick the autoscaler at all: on, an HTTPS URL orchestrators reach, and a worker token. A null
 * from kickAutoscaler means this is false, or the kick was debounced. */
export const kickConfigured = (): boolean => AUTOSCALE.enabled() && /^https:\/\//.test(AUTOSCALE.publicUrl()) && !!env.OCTILLION_WORKER_TOKEN;
/**
 * Launch time budget on Vercel: a function stops at 300 s (vercel.json maxDuration). Launches started by a kick get a
 * deadline (`deadline` - LAUNCH_RESERVE_MS, the work the cron does after the tick), checked between launch steps; a
 * launch that runs out deletes its half-launched sandbox. A lease wait is skipped when it would leave a launch less
 * than LAUNCH_MIN_MS.
 */
const LAUNCH_RESERVE_MS = 45_000, LAUNCH_MIN_MS = 150_000;
export async function kickAutoscaler(opts: { force?: boolean; deadline?: number } = {}): Promise<TickState | null> {
  // Cross-tenant by design: demand across every organization (src/tenant-scope.ts).
  return asPlatform(async () => {
  if (!kickConfigured()) return null;
  if (!opts.force && Date.now() - lastKick < 10_000) return null;
  lastKick = Date.now();
  singleton ??= new Autoscaler();
  const fnDeadline = opts.deadline ?? (process.env.VERCEL ? Date.now() + 300_000 : null);
  const launchDeadline = fnDeadline ? fnDeadline - LAUNCH_RESERVE_MS : null;
  let st = await singleton.tick({ launchDeadline });
  // Another instance holds the lease (it ticked moments ago): wait for it to lapse, then tick here, so work that only
  // this event announces (an orchestrator that just left) is not left for the next cron.
  if (!st.leader && st.enabled) {
    const db = await getDb();
    const [l] = await db.query<{ expires_at: Date }>("SELECT expires_at FROM autoscaler_lease WHERE name = 'autoscaler'");
    const wait = l ? new Date(l.expires_at).getTime() - Date.now() + 1000 : 0;
    const room = launchDeadline ? launchDeadline - Date.now() - wait : Infinity;
    if (wait > 0 && wait < 120_000 && room >= LAUNCH_MIN_MS) { await new Promise((r) => setTimeout(r, wait)); st = await singleton.tick({ launchDeadline }); }
  }
  await singleton.settle();
  return st;
});
}

/**
 * "Run a tick now" on /admin/compute (src/compute-actions.ts): one tick at once, past the kick's 10-second debounce. A
 * VM ticks with its loop's own autoscaler; Vercel needs what a kick needs (an HTTPS PUBLIC_URL and the worker token),
 * and waits out another instance's lease as a kick does. The answer comes back once the tick has decided; its launches
 * finish in the background (kept alive on Vercel). Throws 409 when this deployment cannot tick.
 */
export async function runTickNow(): Promise<TickState> {
  if (!AUTOSCALE.enabled()) throw Object.assign(new Error("Autoscaling is off on this deployment (OCTILLION_AUTOSCALE=off), so there is nothing to tick."), { status: 409 });
  const vercel = !!process.env.VERCEL;
  if (vercel && !kickConfigured()) throw Object.assign(new Error("This deployment cannot trigger the autoscaler: PUBLIC_URL is not HTTPS or the worker token is unset."), { status: 409 });
  lastKick = Date.now();
  singleton ??= new Autoscaler();
  const launchDeadline = vercel ? Date.now() + 300_000 - LAUNCH_RESERVE_MS : null;
  let st = await singleton.tick({ launchDeadline });
  if (vercel && !st.leader && st.enabled) {
    const db = await getDb();
    const [l] = await db.query<{ expires_at: Date }>("SELECT expires_at FROM autoscaler_lease WHERE name = 'autoscaler'");
    const wait = l ? new Date(l.expires_at).getTime() - Date.now() + 1000 : 0;
    if (wait > 0 && wait < 60_000 && launchDeadline! - Date.now() - wait >= LAUNCH_MIN_MS) { await new Promise((r) => setTimeout(r, wait)); st = await singleton.tick({ launchDeadline }); }
  }
  keepAlive(singleton.settle());
  return st;
}

/** Graceful shutdown: stop this process's autoscaler and release its lease. */
export async function stopAutoscaler(): Promise<void> { await singleton?.release(); }

export function startAutoscaler(): Autoscaler {
  singleton ??= new Autoscaler();
  singleton.start();
  return singleton;
}

/** For get_simulation / get_onboarding: what capacity is doing for queued work. */
export async function capacityStatus(): Promise<{ autoscale: "on" | "off"; booting: number; running: number; message: string }> {
  // Cross-tenant by design: capacity across every organization (src/tenant-scope.ts).
  return asPlatform(async () => {
  const db = await getDb();
  const [c] = await db.query<{ booting: number; running: number }>(
    "SELECT count(*) FILTER (WHERE state = 'booting') AS booting, count(*) FILTER (WHERE state = 'running') AS running FROM orchestrator_sandboxes WHERE state <> 'deleted'");
  const [o] = await db.query<{ n: number }>("SELECT count(*) AS n FROM orchestrators WHERE last_seen > now() - interval '90 seconds'");
  const booting = Number(c?.booting ?? 0), running = Math.max(Number(c?.running ?? 0), Number(o?.n ?? 0));
  const autoscale = AUTOSCALE.enabled() ? "on" : "off";
  const message = running > 0 ? "an orchestrator is running and will pick this up"
    : autoscale === "off" ? "waiting for an orchestrator (autoscaling is off)"
    : booting > 0 ? "starting orchestrator…" : "starting orchestrator… (queued for the next autoscaler tick)";
  return { autoscale, booting, running, message };
});
}

/** Admin / fleet:status view. */
export async function autoscalerStatus() {
  const db = await getDb();
  const [lease] = await db.query<{ holder: string; expires_at: Date; state: TickState }>("SELECT holder, expires_at, state FROM autoscaler_lease WHERE name = 'autoscaler'");
  const rows = await db.query("SELECT id, sandbox_id, orchestrator_id, job_id, pods, state, provider, expires_at, created_at, ready_at, last_seen, error, launch_step, launch_error, reap_reason, from_image, timings FROM orchestrator_sandboxes ORDER BY id DESC LIMIT 50");
  return { enabled: AUTOSCALE.enabled(), knobs: {
      orchestrator_provider: orchestratorProvider(), worker_provider: workerProvider(),
      per_job: AUTOSCALE.perJob(), job_pod_capacity: AUTOSCALE.jobPodCapacity(), max_job_orchestrators: AUTOSCALE.maxJobOrchestrators(),
      pod_capacity: AUTOSCALE.podCapacity(), max_orchestrators: AUTOSCALE.maxOrchestrators(), idle_minutes: AUTOSCALE.idleMinutes(),
      stale_minutes: AUTOSCALE.staleMinutes(), boot_minutes: AUTOSCALE.bootMinutes(), snapshots: AUTOSCALE.snapshots(), tick_seconds: AUTOSCALE.tickMs() / 1000 },
    leader: lease ? { holder: lease.holder, expires_at: lease.expires_at } : null, last_tick: lease?.state ?? null, sandboxes: rows };
}
