/**
 * RUNNER=pool: a warm pool of per-harness Docker pods, sized in proportion to real-world usage.
 *
 * Sizing (FLEET_MODE):
 *  - server (default): the Octillion server plans the GLOBAL fleet across all orchestrators. Each orchestrator
 *    checks in (POST /api/worker/fleet {orchestrator_id, capacity}) at start and every next_checkin_seconds and
 *    reconciles its pool to the returned `assignment`. N orchestrators x POD_CAPACITY (<= 20) pods, proportions
 *    hold globally. Server unreachable -> keep the current pool and retry. SIGTERM -> DELETE /api/worker/fleet/:id.
 *  - standalone: fleet/plan.ts planFleet(POD_CAPACITY) from harnesses/registry.json, no server planning.
 *
 * Reconcile: scale up by starting warm pods; scale down only idle pods; busy pods over target are retired when
 * their session ends (not replaced).
 *
 * Pods: `orchestrator/images/Dockerfile.<harness>` images idling on `sleep infinity` (user agent, workdir
 * /home/agent/work), with the docker runner's cpu/memory/pids/network limits and labels octillion.pool=1,
 * octillion.harness=<h>, octillion.pool.owner=<ORCHESTRATOR_ID>. Busy pods are renamed octi-busy-* (idle:
 * octi-pool-*), so `docker ps` and fleet/status.ts show the state.
 *
 * Jobs: claims per harness with limit = idle pods of that harness; one reserved pod per job. Each harness run is
 * `docker exec -u agent` + `env -i` with the image's non-OCTILLION env and only that harness's provider key
 * (by name with `-e`, never in argv, the image or the container env). The worker token and the orchestrator key
 * never enter pods. Resumes run in the same pod. After the session the pod is destroyed and (if still within
 * target) a fresh one is started, so every session starts clean.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { normalizeHarnessId } from "../harnesses/adapters.js";
import { planFleet } from "../fleet/plan.js";
import { CFG, env, num } from "./config.js";
import type { Runner, Sandbox, RunExit, Turn } from "./runners.js";
import { DIFF_SCRIPT, capDiff, AGENT_WORKDIR, AGENT_HOME, imageEnv, dockerExecHarness } from "./runners.js";
import { api, log, sh } from "./util.js";

export const POOL = {
  capacity: Math.max(1, Math.min(20, num(env.POD_CAPACITY ?? env.FLEET_SIZE, 20))),
  mode: (env.FLEET_MODE === "standalone" ? "standalone" : "server") as "server" | "standalone",
  orchestratorId: env.ORCHESTRATOR_ID || hostname(),
  /** Dev/test only: run every harness's pods from this image. */
  imageOverride: env.POOL_IMAGE_OVERRIDE || undefined,
};

interface Pod {
  id: string;
  name: string;
  harness: string;
  image: string;
  state: "starting" | "idle" | "reserved" | "busy";
  /** Non-secret image env (HOME, PATH, NPM_CONFIG_PREFIX...), OCTILLION_* removed. */
  baseEnv: string[];
}

export interface Target { harness: string; pods: number; image: string }

function limits(): string[] {
  const a = ["--cpus", CFG.dockerCpus, "--memory", CFG.dockerMemory, "--pids-limit", "1024", "--security-opt", "no-new-privileges", "--cap-drop", "ALL"];
  if (CFG.dockerNetwork) a.push("--network", CFG.dockerNetwork);
  return a;
}

const imageFor = (harness: string, image?: string | null, version?: string | null) =>
  POOL.imageOverride ?? image ?? `octillion/agent-${harness}:${version ?? "latest"}`;

export class PodPool {
  readonly pods = new Map<string, Pod>();
  targets = new Map<string, Target>();
  private reservations = new Map<string, Pod>(); // job session_id -> pod
  private envCache = new Map<string, string[]>();
  private draining = false;
  private timer: NodeJS.Timeout | null = null;
  private reconciling: Promise<void> | null = null;
  lastCheckin: Record<string, unknown> | null = null;

  constructor(readonly opts: { capacity?: number; mode?: "server" | "standalone"; orchestratorId?: string } = {}) {}

  get capacity() { return this.opts.capacity ?? POOL.capacity; }
  get mode() { return this.opts.mode ?? POOL.mode; }
  get orchestratorId() { return this.opts.orchestratorId ?? POOL.orchestratorId; }

  /** Remove leftovers of this orchestrator id, get a plan, start pods, then keep checking in. */
  async start(): Promise<void> {
    await this.removeOwned();
    await this.refresh();
    log(`pool[${this.orchestratorId}] ${this.mode}: ${this.summary()}`);
  }

  /** One planning round (check-in or local plan) + reconcile; schedules the next round. */
  async refresh(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    let next = 30;
    try {
      if (this.mode === "standalone") {
        this.setTargets(planFleet(this.capacity).map((g) => ({ harness: g.harness, pods: g.pods, image: imageFor(g.harness, g.image) })));
      } else {
        const r = (await api("/api/worker/fleet", {
          json: { orchestrator_id: this.orchestratorId, capacity: this.capacity, meta: { worker_id: CFG.workerId, runner: "pool", pods: this.pods.size } },
        })) as { assignment?: { harness: string; pods: number; image?: string | null; version?: string | null }[]; next_checkin_seconds?: number };
        this.lastCheckin = r as Record<string, unknown>;
        this.setTargets((r.assignment ?? []).map((a) => ({ harness: a.harness, pods: a.pods, image: imageFor(a.harness, a.image, a.version) })));
        next = Math.max(5, Number(r.next_checkin_seconds ?? 30));
      }
      await this.reconcile();
    } catch (e) {
      next = 10;
      log(`pool[${this.orchestratorId}] fleet check-in failed (keeping current pool, retry in ${next}s):`, String(e));
    }
    if (!this.draining) this.timer = setTimeout(() => void this.refresh(), next * 1000);
  }

  setTargets(list: Target[]) {
    this.targets = new Map(list.filter((t) => t.pods > 0).map((t) => [t.harness, t]));
  }

  private podsOf(h: string) { return [...this.pods.values()].filter((p) => p.harness === h); }

  /** Converge pods to targets: start missing, remove surplus idle pods (busy ones retire after their session). */
  reconcile(): Promise<void> {
    this.reconciling ??= (async () => {
      const work: Promise<void>[] = [];
      for (const t of this.targets.values()) {
        for (let i = this.podsOf(t.harness).length; i < t.pods; i++) work.push(this.spawnPod(t));
      }
      const harnesses = new Set([...this.pods.values()].map((p) => p.harness));
      for (const h of harnesses) {
        const want = this.targets.get(h)?.pods ?? 0;
        const ps = this.podsOf(h);
        let surplus = ps.length - want;
        for (const p of ps) {
          if (surplus <= 0) break;
          if (p.state !== "idle") continue;
          this.pods.delete(p.id);
          surplus--;
          work.push(sh("docker", ["rm", "-f", p.name]).then(() => {}));
        }
      }
      await Promise.allSettled(work);
    })().finally(() => { this.reconciling = null; });
    return this.reconciling;
  }

  private async spawnPod(t: Target): Promise<void> {
    if (this.draining) return;
    const id = randomUUID().slice(0, 8);
    const pod: Pod = { id, name: `octi-pool-${t.harness}-${id}`, harness: t.harness, image: t.image, state: "starting", baseEnv: [] };
    this.pods.set(id, pod);
    try {
      if (!this.envCache.has(t.image)) this.envCache.set(t.image, await imageEnv(t.image));
      pod.baseEnv = this.envCache.get(t.image)!;
      const labels = ["--label", "octillion.pool=1", "--label", `octillion.harness=${t.harness}`, "--label", `octillion.pool.owner=${this.orchestratorId}`];
      const r = await sh("docker", ["run", "-d", "--init", "--name", pod.name, ...labels, ...limits(), "-w", AGENT_WORKDIR, t.image, "sleep", "infinity"]);
      if (r.code !== 0) throw new Error(r.out.slice(-300));
      if (this.draining || !this.pods.has(id)) { await sh("docker", ["rm", "-f", pod.name]); return; }
      pod.state = "idle";
    } catch (e) {
      this.pods.delete(id);
      log(`pool: could not start a ${t.harness} pod (${t.image}; build it with orchestrator/images/build.sh): ${String(e instanceof Error ? e.message : e).slice(0, 300)}`);
    }
  }

  idle(harness: string): number { return this.podsOf(harness).filter((p) => p.state === "idle").length; }

  /** Harnesses that currently have pods or targets. */
  harnesses(): string[] { return [...new Set([...this.targets.keys(), ...[...this.pods.values()].map((p) => p.harness)])]; }

  /** Reserve an idle pod of `harness` for a claimed job. */
  reserve(jobKey: string, harness: string): boolean {
    const h = normalizeHarnessId(harness);
    const pod = [...this.pods.values()].find((p) => p.state === "idle" && normalizeHarnessId(p.harness) === h);
    if (!pod) return false;
    pod.state = "reserved";
    this.reservations.set(jobKey, pod);
    return true;
  }

  /** Called when a job ends: a reservation that never ran goes back to idle (pod is still clean). */
  release(jobKey: string) {
    const pod = this.reservations.get(jobKey);
    this.reservations.delete(jobKey);
    if (pod && pod.state === "reserved") pod.state = "idle";
  }

  /** Take the reserved pod for a job (or any idle pod of the harness) and mark it busy. */
  async take(jobKey: string | undefined, harness: string): Promise<Pod> {
    let pod = jobKey ? this.reservations.get(jobKey) : undefined;
    if (!pod && jobKey && this.reserve(jobKey, harness)) pod = this.reservations.get(jobKey);
    if (!pod) throw new Error(`no idle pod for harness ${harness}`);
    pod.state = "busy";
    const busy = `octi-busy-${pod.harness}-${pod.id}`;
    if ((await sh("docker", ["rename", pod.name, busy])).code === 0) pod.name = busy;
    return pod;
  }

  /** Destroy a used pod; reconcile starts a fresh one if the harness is still below target (else it retires). */
  async recycle(pod: Pod): Promise<void> {
    for (const [k, p] of this.reservations) if (p === pod) this.reservations.delete(k);
    this.pods.delete(pod.id);
    await sh("docker", ["rm", "-f", pod.name]);
    if (!this.draining) await this.reconcile();
  }

  private async removeOwned(): Promise<void> {
    const r = await sh("docker", ["ps", "-aq", "--filter", "label=octillion.pool=1", "--filter", `label=octillion.pool.owner=${this.orchestratorId}`]);
    const ids = r.out.split(/\s+/).filter(Boolean);
    if (ids.length) await sh("docker", ["rm", "-f", ...ids]);
  }

  /** SIGTERM: leave the fleet (server mode), stop refreshing, remove every pod this orchestrator owns. */
  async drain(): Promise<void> {
    this.draining = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.mode === "server") {
      await api(`/api/worker/fleet/${encodeURIComponent(this.orchestratorId)}`, { method: "DELETE" })
        .catch((e) => log(`pool: fleet leave failed (server drops us after 90s anyway):`, String(e)));
    }
    if (this.reconciling) await this.reconciling.catch(() => {});
    await this.removeOwned();
    this.pods.clear();
    log(`pool[${this.orchestratorId}]: drained`);
  }

  counts(): Record<string, { idle: number; busy: number; target: number }> {
    const out: Record<string, { idle: number; busy: number; target: number }> = {};
    for (const h of this.harnesses()) {
      const ps = this.podsOf(h);
      out[h] = { idle: ps.filter((p) => p.state === "idle").length, busy: ps.filter((p) => p.state === "reserved" || p.state === "busy").length, target: this.targets.get(h)?.pods ?? 0 };
    }
    return out;
  }

  summary(): string {
    return Object.entries(this.counts()).map(([h, c]) => `${h} ${c.idle} idle/${c.busy} busy (target ${c.target})`).join(", ") || "no pods";
  }

  runner(): Runner {
    const pool = this;
    return {
      name: "pool",
      async open(spec): Promise<Sandbox> {
        const pod = await pool.take(spec.jobKey, spec.harness ?? spec.adapter.id);
        let base = "";
        const exec = (args: string[]) => sh("docker", ["exec", "-u", "agent", ...args]);
        try {
          if (spec.repoUrl) {
            const c = await exec([pod.name, "git", "clone", "--depth", "1", "-q", spec.repoUrl, AGENT_WORKDIR]);
            if (c.code !== 0) throw new Error(`git clone failed: ${c.out.slice(-500)}`);
            base = (await exec([pod.name, "git", "-C", AGENT_WORKDIR, "rev-parse", "HEAD"])).out.trim();
          }
        } catch (e) { await pool.recycle(pod); throw e; }
        const keys = Object.keys(spec.env);
        let current: ChildProcess | null = null;
        let gone = false;
        const destroy = async () => { if (gone) return; gone = true; current?.kill("SIGKILL"); await pool.recycle(pod); };
        return {
          id: `pool:${pod.harness}-${pod.id}`,
          workdir: AGENT_WORKDIR,
          async runTurn(argv: string[], input: string): Promise<Turn> {
            const child = spawn("docker", dockerExecHarness(pod.name, pod.baseEnv, keys, argv), { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...spec.env } });
            current = child;
            child.stdin!.end(input);
            const exited = new Promise<RunExit>((resolve) => {
              child.on("error", (e) => resolve({ code: null, signal: null, error: String(e) }));
              child.on("close", (code, signal) => resolve({ code, signal }));
            });
            return { stdout: child.stdout!, stderr: child.stderr!, exited };
          },
          async diff() {
            const r = await exec(["-e", `BASE=${base}`, "-e", `WORK=${AGENT_WORKDIR}`, "-e", "SNAP=/tmp/.octi-snap.git", "-e", `HOME=${AGENT_HOME}`, pod.name, "bash", "-c", DIFF_SCRIPT]);
            return r.code === 0 ? capDiff(r.out) : null;
          },
          kill: destroy,
          cleanup: destroy,
          meta: () => ({ pool_harness: pod.harness, pool_image: pod.image, pool_orchestrator: pool.orchestratorId }),
        };
      },
    };
  }
}
