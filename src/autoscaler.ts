import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { getDb } from "./db.js";
import { useCredential } from "./keyvault.js";
import { scheduledAgents, variantsOf } from "./agents.js";
import { getPopulation } from "./populations.js";
import { orchestratorBusy, retiringSince, staleOrchestratorIds } from "./fleet.js";
import { BOAT } from "../orchestrator/core/config.js";
import * as lib from "../orchestrator/deploy/boat-lib.js";

/**
 * On-demand orchestrators: scale from zero to zero.
 *
 * Every OCTILLION_AUTOSCALE_TICK_SECONDS (15) the leader (a lease row in Postgres, so several server replicas never
 * double-launch) computes demand: claimable queued+running agent sessions and queued+running product research.
 *   desired = 0 without demand, else max(ceil(sessions / pod capacity), research ? 1 : 0),
 * clamped to OCTILLION_MAX_ORCHESTRATORS and to the boat plan (orchestrators + their workers <= plan concurrency).
 * Missing orchestrators are launched with the boat key from the vault (orchestrator/deploy/boat-lib.ts), preferably
 * optionally from a named snapshot image (OCTILLION_ORCH_SNAPSHOT=on; measured slower than a fresh `npm ci`, ~22s vs ~8s).
 *
 * Scale down: an orchestrator with no claimable work for OCTILLION_ORCH_IDLE_MINUTES (10) drains, leaves the fleet
 * (DELETE /api/worker/fleet/:id marks its row `draining`) and exits; the next tick deletes its sandbox. The tick also
 * reaps stale (no fleet check-in for 5 min), stuck-booting (> 10 min), expired and orphan sandboxes, reconciling
 * against boat's own listing by name prefix, so nothing leaks across server restarts.
 *
 * Kill switch: OCTILLION_AUTOSCALE=off (no launches, no deletes; existing orchestrators keep running and idle out).
 */

const env = process.env;
const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
export const AUTOSCALE = {
  enabled: () => (env.OCTILLION_AUTOSCALE ?? "on").toLowerCase() !== "off",
  tickMs: () => Math.max(1, num(env.OCTILLION_AUTOSCALE_TICK_SECONDS, 15)) * 1000,
  podCapacity: () => Math.max(1, Math.min(20, num(env.OCTILLION_POD_CAPACITY, num(env.OCTILLION_PODS_PER_ORCHESTRATOR, 20)))),
  maxOrchestrators: () => num(env.OCTILLION_MAX_ORCHESTRATORS, 4),
  idleMinutes: () => num(env.OCTILLION_ORCH_IDLE_MINUTES, 10),
  staleMinutes: () => num(env.OCTILLION_ORCH_STALE_MINUTES, 5),
  bootMinutes: () => num(env.OCTILLION_ORCH_BOOT_MINUTES, 10),
  // Measured live 2026-10-10: code upload + `npm ci` boots in ~8s; booting from the named snapshot took ~22s (lazy
  // disk hydration) and each image costs a ~170s build per code change. So the image path is opt-in.
  snapshots: () => (env.OCTILLION_ORCH_SNAPSHOT ?? "off").toLowerCase() === "on",
  maxLaunchesPerTick: () => Math.max(1, num(env.OCTILLION_ORCH_LAUNCHES_PER_TICK, 2)),
  publicUrl: () => (env.PUBLIC_URL ?? "").replace(/\/$/, ""),
};

export interface Demand {
  sessions: number; queued_sessions: number; research: number; unclaimable_sessions: number;
  /** Claimable sessions queued after `freshSince` (only when computeDemand was given one). */
  fresh_queued_sessions?: number;
}
export interface Row {
  id: number; sandbox_id: string | null; orchestrator_id: string | null; state: "booting" | "running" | "draining" | "deleted";
  created_at: Date; ready_at: Date | null; last_seen: Date | null; error: string | null; from_image: string | null;
}

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
    `SELECT count(*) FILTER (WHERE ${claimable}) AS sessions,
            count(*) FILTER (WHERE status = 'queued' AND ${claimable}) AS queued,
            count(*) FILTER (WHERE NOT ${claimable}) AS unclaimable,
            count(*) FILTER (WHERE status = 'queued' AND ${claimable} AND $2::timestamptz IS NOT NULL AND queued_at > $2) AS fresh
       FROM agent_sessions WHERE status IN ('queued', 'running')`, [agents, freshSince ?? null]);
  const [r] = await db.query<{ n: number }>("SELECT count(*) AS n FROM product_research WHERE status IN ('queued', 'running')");
  return {
    sessions: Number(s?.sessions ?? 0), queued_sessions: Number(s?.queued ?? 0), research: Number(r?.n ?? 0),
    unclaimable_sessions: Number(s?.unclaimable ?? 0), ...(freshSince ? { fresh_queued_sessions: Number(s?.fresh ?? 0) } : {}),
  };
}

export interface TickState {
  at: string; enabled: boolean; leader: boolean; holder: string; demand?: Demand; desired?: number; cap?: number;
  active?: number; launched?: string[]; reaped?: { sandbox_id: string; reason: string }[]; image?: string | null; note?: string; error?: string;
}

export class Autoscaler {
  readonly holder = `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;
  private inflight = new Map<number, Promise<void>>();
  private imageBuild: Promise<unknown> | null = null;
  private keyAt = 0;
  private limits: { at: number; v: lib.BoatLimits } | null = null;
  private lastDrainAt = 0;
  private timer: NodeJS.Timeout | null = null;
  last: TickState | null = null;

  constructor(private opts: { log?: (m: string) => void; root?: string } = {}) {}
  private log(m: string) { (this.opts.log ?? ((x: string) => console.error(`autoscaler: ${x}`)))(m); }

  start() {
    if (this.timer) return;
    const loop = async () => {
      try { await this.tick(); } catch (e) { this.log(`tick failed: ${(e as Error).message}`); }
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
  /** Wait for in-flight launches and image builds (tests). */
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

  private async cap(oursActive: number): Promise<number> {
    if (!this.limits || Date.now() - this.limits.at > 5 * 60_000) this.limits = { at: Date.now(), v: await lib.boatLimits() };
    const b = lib.computeBudget(this.limits.v, 0, AUTOSCALE.podCapacity(), oursActive);
    return Math.max(0, Math.min(AUTOSCALE.maxOrchestrators(), b.maxOrchestrators));
  }

  async tick(): Promise<TickState> {
    const st: TickState = { at: new Date().toISOString(), enabled: AUTOSCALE.enabled(), leader: false, holder: this.holder };
    if (!st.enabled) { this.last = { ...st, note: "OCTILLION_AUTOSCALE=off" }; return this.last; }
    if (!(await this.acquireLease())) { this.last = { ...st, note: "not the leader" }; return this.last; }
    st.leader = true;
    const db = await getDb();
    try {
      await this.boatKey();
      // Sessions queued in the last FRESH_MS before an idle exit (or after it) were never ignored by a live orchestrator,
      // so they are new work, not stuck work: they must not wait out the relaunch cooldown below.
      const FRESH_MS = 2 * 60_000;
      const demand = await computeDemand(this.lastDrainAt ? new Date(this.lastDrainAt - FRESH_MS) : undefined);
      st.demand = demand;
      const listing = await lib.listSandboxes();
      const byId = new Map(listing.map((s) => [s.id, s]));
      const rows = await db.query<Row>("SELECT * FROM orchestrator_sandboxes WHERE state <> 'deleted' ORDER BY id");
      const seen = new Map((await db.query<{ id: string; last_seen: Date }>("SELECT id, last_seen FROM orchestrators")).map((o) => [o.id, new Date(o.last_seen)]));
      const now = Date.now(), min = 60_000;
      const staleIds = await staleOrchestratorIds();
      const reaped: { sandbox_id: string; reason: string }[] = [];
      const reap = async (row: Row, reason: string, deleteIt = true) => {
        if (row.sandbox_id && deleteIt) await lib.deleteSandbox(row.sandbox_id).catch((e) => this.log(`delete ${row.sandbox_id}: ${(e as Error).message}`));
        await db.query("UPDATE orchestrator_sandboxes SET state = 'deleted', deleted_at = now(), error = coalesce(error, $2) WHERE id = $1", [row.id, reason]);
        if (row.orchestrator_id) {
          await db.query("DELETE FROM orchestrators WHERE id = $1", [row.orchestrator_id]);
          // worker sandboxes a crashed/stale orchestrator could not clean up itself (octi-w-<orch>-<agent>)
          const wp = `${lib.workerPrefixOf(row.orchestrator_id)}-`;
          for (const w of listing.filter((s) => lib.isLive(s) && s.name?.startsWith(wp))) {
            await lib.deleteSandbox(w.id).catch(() => {});
            reaped.push({ sandbox_id: w.id, reason: `worker of reaped ${row.orchestrator_id}` });
          }
        }
        reaped.push({ sandbox_id: row.sandbox_id ?? "(none)", reason });
        this.log(`reaped ${row.sandbox_id ?? `row ${row.id}`}: ${reason}`);
      };

      // 1. reconcile our rows with boat + the fleet, reap what must go
      for (const row of rows) {
        const age = now - new Date(row.created_at).getTime();
        const inflight = this.inflight.has(row.id);
        if (!row.sandbox_id) { if (!inflight && age > AUTOSCALE.bootMinutes() * min) await reap(row, "launch never created a sandbox", false); continue; }
        const sb = byId.get(row.sandbox_id);
        if (!sb || !lib.isLive(sb)) {
          if (inflight && age < 2 * min) continue; // listing can lag a fresh create
          await reap(row, sb ? `sandbox is ${sb.state}` : "sandbox gone from boat", !!sb);
          continue;
        }
        if (row.state === "draining") { this.lastDrainAt = now; await reap(row, "drained (idle exit)"); continue; }
        if (sb.archiveAfter && Date.parse(sb.archiveAfter) < now + 5 * min) { await reap(row, "TTL about to expire"); continue; }
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
          const told = retiringSince(row.orchestrator_id);
          if (told && checkIn && checkIn.getTime() > told && !(await orchestratorBusy(row.orchestrator_id))) {
            await reap(row, "retired: launched before this deploy (old code)");
            continue;
          }
        }
        const since = checkIn?.getTime() ?? (row.ready_at ? new Date(row.ready_at).getTime() : new Date(row.created_at).getTime());
        if (now - since > AUTOSCALE.staleMinutes() * min) await reap(row, `stale: no fleet check-in for ${AUTOSCALE.staleMinutes()} min`);
      }
      // orphans: our name prefix on boat but no live row (e.g. a launch interrupted by a server restart)
      const known = new Set((await db.query<{ sandbox_id: string }>("SELECT sandbox_id FROM orchestrator_sandboxes WHERE state <> 'deleted' AND sandbox_id IS NOT NULL")).map((r) => r.sandbox_id));
      const reapedIds = new Set(reaped.map((r) => r.sandbox_id)); // the listing predates this tick's reaping
      for (const sb of listing) {
        if (!lib.isLive(sb) || known.has(sb.id) || reapedIds.has(sb.id)) continue;
        const isOrch = sb.name?.startsWith(lib.ORCH_PREFIX);
        const isStaleBuilder = sb.name === lib.IMAGE_BUILDER_NAME && !this.imageBuild && sb.createdAt && now - Date.parse(sb.createdAt) > 30 * min;
        if (isOrch || isStaleBuilder) {
          await lib.deleteSandbox(sb.id).catch(() => {});
          reaped.push({ sandbox_id: sb.id, reason: isOrch ? "orphan orchestrator sandbox (no row)" : "stale image builder" });
          this.log(`deleted orphan ${sb.id} (${sb.name})`);
        }
      }
      st.reaped = reaped;

      // 2. scale up within the caps
      // Retiring (pre-deploy) orchestrators claim nothing new, so they do not count as capacity for the demand.
      const active = (await db.query<Row>("SELECT * FROM orchestrator_sandboxes WHERE state IN ('booting', 'running')"))
        .filter((r) => !(r.orchestrator_id && staleIds.has(r.orchestrator_id))).length;
      const oursActive = listing.filter((s) => lib.isLive(s) && (s.name?.startsWith(lib.ORCH_PREFIX) || s.name?.startsWith(lib.WORKER_PREFIX))).length;
      const cap = await this.cap(oursActive);
      let desired = Math.min(desiredOrchestrators(demand, AUTOSCALE.podCapacity()), cap);
      // An orchestrator just idled out while sessions are still "queued": they are not claimable by it; don't relaunch
      // in a loop (each launch is a boat start). Research or freshly queued sessions launch right away.
      if (demand.research === 0 && demand.sessions > 0 && !demand.fresh_queued_sessions && active === 0 &&
          now - this.lastDrainAt < AUTOSCALE.idleMinutes() * min) {
        st.note = "cooldown: the last orchestrator idled out with these sessions still queued";
        desired = 0;
      }
      st.active = active; st.cap = cap; st.desired = desired;
      st.launched = [];
      const image = AUTOSCALE.snapshots() ? await this.readyImage() : null;
      st.image = image;
      for (let i = 0; i < Math.min(desired - active, AUTOSCALE.maxLaunchesPerTick()); i++) st.launched.push(await this.launch(image));

      // 3. keep the image current (built in the background, once per code hash)
      if (AUTOSCALE.snapshots() && !image && !this.imageBuild) {
        this.imageBuild = lib.buildImage({ root: this.opts.root, log: (m) => this.log(m) })
          .catch((e) => this.log(`image build failed: ${(e as Error).message}`))
          .finally(() => { this.imageBuild = null; });
      }
    } catch (e) {
      st.error = (e as Error).message;
      this.log(`tick error: ${st.error}`);
    }
    this.last = st;
    await db.query("UPDATE autoscaler_lease SET state = $2 WHERE name = 'autoscaler' AND holder = $1", [this.holder, JSON.stringify(st)]).catch(() => {});
    return st;
  }

  private imageCache: { hash: string; name: string | null; at: number } | null = null;
  private async readyImage(): Promise<string | null> {
    const hash = lib.codeHash(this.opts.root);
    if (this.imageCache?.hash === hash && this.imageCache.name && Date.now() - this.imageCache.at < 10 * 60_000) return this.imageCache.name;
    const name = lib.imageName(hash);
    const ok = (await lib.imageStatus(name).catch(() => "missing")) === "ready";
    this.imageCache = { hash, name: ok ? name : null, at: Date.now() };
    return ok ? name : null;
  }

  /** Insert the row first (counts toward `active` at once), then create + configure + start in the background. */
  private async launch(image: string | null): Promise<string> {
    const db = await getDb();
    const [row] = await db.query<{ id: number }>("INSERT INTO orchestrator_sandboxes (state, from_image) VALUES ('booting', $1) RETURNING id", [image]);
    const id = row!.id;
    const workerToken = env.OCTILLION_WORKER_TOKEN ?? "";
    const tuning: Record<string, string> = { OCTILLION_ORCH_IDLE_MINUTES: String(AUTOSCALE.idleMinutes()) };
    for (const k of lib.TUNING_VARS) if (env[k]) tuning[k] = env[k]!;
    const p = lib.launchOrchestrator(
      { url: AUTOSCALE.publicUrl(), workerToken, podCapacity: AUTOSCALE.podCapacity(), tuning, root: this.opts.root, log: (m) => this.log(m) },
      { image, onCreated: async (sandboxId, orchId) => { await db.query("UPDATE orchestrator_sandboxes SET sandbox_id = $2, orchestrator_id = $3 WHERE id = $1", [id, sandboxId, orchId]); } },
    ).then(async (r) => {
      await db.query("UPDATE orchestrator_sandboxes SET state = 'running', ready_at = now(), from_image = $2, timings = $3 WHERE id = $1 AND state = 'booting'",
        [id, r.fromImage ? image : null, JSON.stringify(r.timings)]);
      this.log(`launched ${r.sandboxId} (${r.orchId}) in ${Math.round((r.timings.started ?? 0) / 1000)}s${r.fromImage ? " from image" : " (code upload + npm ci)"}`);
    }).catch(async (e) => {
      await db.query("UPDATE orchestrator_sandboxes SET state = 'deleted', deleted_at = now(), error = $2 WHERE id = $1", [id, String((e as Error).message).slice(0, 500)]);
      this.log(`launch failed: ${(e as Error).message}`);
    }).finally(() => { this.inflight.delete(id); });
    this.inflight.set(id, p);
    return `row ${id}`;
  }
}

let singleton: Autoscaler | null = null;
/** Graceful shutdown: stop this process's autoscaler and release its lease. */
export async function stopAutoscaler(): Promise<void> { await singleton?.release(); }

export function startAutoscaler(): Autoscaler {
  singleton ??= new Autoscaler();
  singleton.start();
  return singleton;
}

/** For get_simulation / get_onboarding: what capacity is doing for queued work. */
export async function capacityStatus(): Promise<{ autoscale: "on" | "off"; booting: number; running: number; message: string }> {
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
}

/** Admin / fleet:status view. */
export async function autoscalerStatus() {
  const db = await getDb();
  const [lease] = await db.query<{ holder: string; expires_at: Date; state: TickState }>("SELECT holder, expires_at, state FROM autoscaler_lease WHERE name = 'autoscaler'");
  const rows = await db.query("SELECT id, sandbox_id, orchestrator_id, state, created_at, ready_at, last_seen, error, from_image, timings FROM orchestrator_sandboxes ORDER BY id DESC LIMIT 50");
  return { enabled: AUTOSCALE.enabled(), knobs: {
      pod_capacity: AUTOSCALE.podCapacity(), max_orchestrators: AUTOSCALE.maxOrchestrators(), idle_minutes: AUTOSCALE.idleMinutes(),
      stale_minutes: AUTOSCALE.staleMinutes(), boot_minutes: AUTOSCALE.bootMinutes(), snapshots: AUTOSCALE.snapshots(), tick_seconds: AUTOSCALE.tickMs() / 1000 },
    leader: lease ? { holder: lease.holder, expires_at: lease.expires_at } : null, last_tick: lease?.state ?? null, sandboxes: rows };
}
