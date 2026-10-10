import { getDb } from "./db.js";
import { apportion, enabledAgents } from "./agents.js";

/**
 * Global pod fleet across horizontally scaled orchestrators.
 *
 * Each orchestrator runs up to OCTILLION_PODS_PER_ORCHESTRATOR (20) warm worker pods. Orchestrators register and
 * heartbeat via POST /api/worker/fleet; the server apportions the *total* capacity of live orchestrators across
 * harnesses by real-world usage (registry weights summed per harness), then deals pods out so each orchestrator
 * gets a near-identical mix. 10 orchestrators x 20 = 200 pods, Claude Code at 40% -> 80 pods, ~8 per orchestrator.
 * Planning globally avoids the rounding drift of every orchestrator planning 20 pods on its own.
 */

export const PODS_PER_ORCHESTRATOR = () => Math.max(1, Number(process.env.OCTILLION_PODS_PER_ORCHESTRATOR ?? 20));
const STALE_SECONDS = () => Number(process.env.OCTILLION_FLEET_STALE_SECONDS ?? 90);

export interface HarnessShare { harness: string; weight: number; agents: string[]; image?: string; version?: string }

export function harnessShares(): HarnessShare[] {
  const m = new Map<string, HarnessShare>();
  for (const a of enabledAgents()) {
    const h = m.get(a.harness) ?? { harness: a.harness, weight: 0, agents: [], image: a.image?.docker, version: a.harness_version };
    h.weight += a.weight;
    h.agents.push(a.id);
    m.set(a.harness, h);
  }
  return [...m.values()].sort((a, b) => b.weight - a.weight || a.harness.localeCompare(b.harness));
}

/**
 * Pods per harness for a total fleet size: strictly proportional to usage (largest remainder), then any harness
 * left with zero pods gets one, taken from whichever harness is most over its exact share (so no harness's
 * sessions starve, and the big shares stay exact: 200 pods at 40% -> 80).
 */
export function planPods(total: number, shares = harnessShares()): { harness: string; weight: number; pods: number }[] {
  const plan = apportion(shares, total).map(({ item, count }) => ({ harness: item.harness, weight: item.weight, pods: count }));
  if (total >= plan.length)
    for (const empty of plan.filter((p) => p.pods === 0)) {
      const donor = plan.filter((p) => p.pods > 1).sort((a, b) => (b.pods - b.weight * total) - (a.pods - a.weight * total))[0];
      if (!donor) break;
      donor.pods--;
      empty.pods++;
    }
  return plan;
}

/**
 * Deal a global plan to orchestrators (sorted by id, deterministic): every orchestrator first gets an even base
 * share of each harness (floor(pods / N), within its capacity); leftover pods then go one at a time to the
 * orchestrator with the most free room relative to its capacity that holds the fewest of that harness.
 */
export function assign(plan: { harness: string; pods: number }[], orchestrators: { id: string; capacity: number }[]) {
  const out = new Map(orchestrators.map((o) => [o.id, new Map<string, number>()]));
  const load = new Map(orchestrators.map((o) => [o.id, 0]));
  const give = (o: { id: string }, harness: string, n: number) => {
    const m = out.get(o.id)!;
    m.set(harness, (m.get(harness) ?? 0) + n);
    load.set(o.id, load.get(o.id)! + n);
  };
  if (!orchestrators.length) return out;
  const left = new Map(plan.map((p) => [p.harness, p.pods]));
  for (const p of plan) {
    const base = Math.floor(p.pods / orchestrators.length);
    for (const o of orchestrators) {
      const n = Math.min(base, o.capacity - load.get(o.id)!);
      if (n > 0) give(o, p.harness, n), left.set(p.harness, left.get(p.harness)! - n);
    }
  }
  for (const p of plan) {
    for (let rem = left.get(p.harness)!; rem > 0; rem--) {
      const o = orchestrators
        .filter((x) => load.get(x.id)! < x.capacity)
        .sort((a, b) =>
          load.get(a.id)! / a.capacity - load.get(b.id)! / b.capacity ||
          (out.get(a.id)!.get(p.harness) ?? 0) - (out.get(b.id)!.get(p.harness) ?? 0) ||
          a.id.localeCompare(b.id))[0];
      if (!o) break;
      give(o, p.harness, 1);
    }
  }
  return out;
}

/** Register / heartbeat an orchestrator and return its share of the global fleet. */
export async function fleetCheckin(orchestratorId: string, capacity?: number, meta: Record<string, unknown> = {}) {
  const cap = Math.min(Math.max(1, Math.trunc(capacity ?? PODS_PER_ORCHESTRATOR())), PODS_PER_ORCHESTRATOR());
  const db = await getDb();
  await db.query(
    `INSERT INTO orchestrators (id, capacity, meta, registered_at, last_seen) VALUES ($1, $2, $3, now(), now())
     ON CONFLICT (id) DO UPDATE SET capacity = excluded.capacity, meta = excluded.meta, last_seen = now()`,
    [orchestratorId, cap, JSON.stringify(meta)],
  );
  return fleetStatus(orchestratorId);
}

export async function fleetLeave(orchestratorId: string) {
  const db = await getDb();
  await db.query("DELETE FROM orchestrators WHERE id = $1", [orchestratorId]);
}

export async function fleetStatus(orchestratorId?: string) {
  const db = await getDb();
  const live = await db.query<{ id: string; capacity: number; last_seen: Date }>(
    `SELECT id, capacity, last_seen FROM orchestrators WHERE last_seen > now() - make_interval(secs => $1) ORDER BY id`,
    [STALE_SECONDS()],
  );
  const total = live.reduce((s, o) => s + Number(o.capacity), 0);
  const plan = planPods(total);
  const dealt = assign(plan, live.map((o) => ({ id: o.id, capacity: Number(o.capacity) })));
  const [queue] = await db.query<{ queued: number; running: number }>(
    "SELECT count(*) FILTER (WHERE status = 'queued') AS queued, count(*) FILTER (WHERE status = 'running') AS running FROM agent_sessions",
  );
  const shares = harnessShares();
  const mine = orchestratorId ? dealt.get(orchestratorId) : undefined;
  return {
    orchestrators: live.length,
    total_pods: total,
    plan,
    queue,
    ...(orchestratorId
      ? {
          orchestrator_id: orchestratorId,
          assignment: shares.map((s) => ({ harness: s.harness, pods: mine?.get(s.harness) ?? 0, image: s.image ?? null, version: s.version ?? null, agents: s.agents }))
            .filter((a) => a.pods > 0),
          next_checkin_seconds: Math.max(10, Math.floor(STALE_SECONDS() / 3)),
        }
      : { assignments: Object.fromEntries([...dealt].map(([id, m]) => [id, Object.fromEntries(m)])) }),
  };
}
