/**
 * Octillion deterministic worker (no orchestrator LLM).
 *
 * Claims jobs, runs each harness once in a sandbox (boat.dev by default), streams its JSONL, then finishes:
 * git diff event, /complete, sandbox deleted. No simulated developer: if the sub-agent asks a question the
 * session simply ends there. The Pi orchestrator (pi-octillion/main.ts) adds the simulated-developer loop and
 * falls back to exactly this behaviour when its LLM fails.
 *
 * Run: `npx tsx orchestrator/worker.ts`
 */
import { getAdapter } from "./harnesses/adapters.js";
import { CFG } from "./core/config.js";
import { PodPool, POOL } from "./core/pool.js";
import { RUNNERS, checkRunner, type Runner } from "./core/runners.js";
import { activeSessions, adapterFor, claimJobs, markShuttingDown, WorkerSession, type Job } from "./core/session.js";
import { log, sleep } from "./core/util.js";

/** Launch -> wait -> finish. Also the fallback path of the Pi orchestrator. */
export async function runDeterministic(job: Job, runner: Runner, orchestrator: Record<string, unknown> = { orchestrator: "none" }): Promise<void> {
  let s: WorkerSession;
  try { s = await WorkerSession.start(job, runner); }
  catch { return; } // already completed as failed (unsupported harness / missing key)
  await s.waitForTurn();
  await s.finish({ orchestrator });
}

/**
 * Generic claim loop shared by worker.ts and pi-octillion/main.ts.
 * RUNNER=pool: claims per harness with limit = idle pods of that harness, and reserves a pod per job.
 * Other runners: claims up to WORKER_CONCURRENCY free slots.
 */
export async function claimLoop(runJob: (job: Job, runner: Runner) => Promise<void>, label: string): Promise<void> {
  if (!CFG.token) throw new Error("OCTILLION_WORKER_TOKEN is required");
  let pool: PodPool | null = null;
  let runner: Runner;
  if (CFG.runner === "pool") {
    pool = new PodPool();
    await pool.start();
    runner = pool.runner();
  } else {
    const r = RUNNERS[CFG.runner];
    if (!r) throw new Error(`RUNNER must be one of ${[...Object.keys(RUNNERS), "pool"].join(", ")}`);
    await checkRunner(r);
    runner = r;
  }
  const capacity = pool ? POOL.capacity : CFG.concurrency; // pool: also bounded by idle pods per harness
  log(`${label} ${CFG.workerId} runner=${runner.name}${pool ? ` fleet=${pool.mode} orchestrator_id=${pool.orchestratorId}` : ""} capacity=${capacity} url=${CFG.url} max=${CFG.maxSessionMs / 60000}m`);

  let stopping = false;
  let stoppedAt = 0;
  const tasks = new Set<Promise<void>>();
  const stop = async (sig: string) => {
    if (stopping) {
      if (Date.now() - stoppedAt < 3000) return; // npx/tsx forward the same signal twice
      log("second signal: exiting now"); process.exit(1);
    }
    stopping = true;
    stoppedAt = Date.now();
    markShuttingDown();
    log(`${sig}: stopping ${activeSessions.size} session(s)`);
    await Promise.all([...activeSessions].map((s) => s.kill()));
    await Promise.allSettled(tasks);
    await pool?.drain();
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));

  // Only claim harnesses this worker can actually run (adapter + provider key), so jobs aren't burned.
  const runnable = (h: string) => { try { adapterFor({ harness: h } as Job); return true; } catch { return false; } };
  if (pool) {
    const skipped = pool.harnesses().filter((h) => !runnable(h));
    if (skipped.length) log(`pool: not claiming for ${skipped.join(", ")} (no adapter or no provider key); their pods stay idle`);
  }

  const claim = async (): Promise<Job[]> => {
    if (!pool) return claimJobs(capacity - tasks.size);
    const out: Job[] = [];
    for (const h of pool.harnesses()) {
      if (CFG.harness && getAdapterId(h) !== getAdapterId(CFG.harness)) continue;
      const idle = pool.idle(h);
      if (!idle || !runnable(h)) continue;
      for (const job of await claimJobs(idle, h)) {
        if (!pool.reserve(job.session_id, job.harness)) log(`[${job.session_id}] no idle ${job.harness} pod for a claimed job; it will fail fast`);
        out.push(job);
      }
    }
    return out;
  };

  while (!stopping) {
    if (tasks.size >= capacity) { await Promise.race(tasks); continue; }
    let jobs: Job[] = [];
    try { jobs = await claim(); }
    catch (e) { log("claim failed:", String(e)); }
    for (const job of jobs) {
      const t: Promise<void> = runJob(job, runner)
        .catch((e) => log(`[${job.session_id}] crashed:`, e))
        .finally(() => { tasks.delete(t); pool?.release(job.session_id); });
      tasks.add(t);
    }
    if (pool && jobs.length) log(`pool: ${pool.summary()}`);
    if (!jobs.length) await Promise.race([sleep(CFG.pollMs), ...tasks]);
  }
  await Promise.allSettled(tasks);
  log(`${label} stopped`);
}

function getAdapterId(h: string): string {
  try { return getAdapter(h).id; } catch { return h; }
}

// Run only when executed directly (pi-octillion imports runDeterministic/claimLoop).
if (process.argv[1] && /worker\.(ts|js)$/.test(process.argv[1])) {
  claimLoop((job, runner) => runDeterministic(job, runner), "worker").catch((e) => { console.error(e); process.exit(1); });
}
