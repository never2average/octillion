import { getDb } from "./db.js";
import { apportion, scheduledAgents } from "./agents.js";

/**
 * Global pod fleet across horizontally scaled orchestrators.
 *
 * Each orchestrator runs up to OCTILLION_PODS_PER_ORCHESTRATOR (20) warm worker pods. Orchestrators register and
 * heartbeat via POST /api/worker/fleet; the server apportions the *total* capacity of live orchestrators across
 * worker agents by real-world usage, then deals pods out so each orchestrator gets a near-identical mix.
 * A pod group is one registry agent = harness + model: a harness with several popular models gets one group per
 * model (Claude Code · Opus and Claude Code · Sonnet), each sized by that model's own usage share.
 * 10 orchestrators x 20 = 200 pods; an agent at 40% usage gets 80 pods, ~8 per orchestrator.
 * Planning globally avoids the rounding drift of every orchestrator planning 20 pods on its own.
 */

export const PODS_PER_ORCHESTRATOR = () => Math.max(1, Number(process.env.OCTILLION_PODS_PER_ORCHESTRATOR ?? 20));
const STALE_SECONDS = () => Number(process.env.OCTILLION_FLEET_STALE_SECONDS ?? 90);

export interface AgentShare { agent_id: string; harness: string; model: string; weight: number; image?: string; version?: string }

/** One pod group per runnable registry agent (harness + model), weighted by usage. */
export function agentShares(): AgentShare[] {
  return scheduledAgents()
    .map((a) => ({ agent_id: a.id, harness: a.harness, model: a.model, weight: a.weight, image: a.image?.docker, version: a.harness_version }))
    .sort((a, b) => b.weight - a.weight || a.agent_id.localeCompare(b.agent_id));
}

/**
 * Pods per harness for a total fleet size: strictly proportional to usage (largest remainder), then any harness
 * left with zero pods gets one, taken from whichever harness is most over its exact share (so no harness's
 * sessions starve, and the big shares stay exact: 200 pods at 40% -> 80).
 */
export function planPods(total: number, shares: AgentShare[] = agentShares()): (AgentShare & { pods: number })[] {
  const plan = apportion(shares, total).map(({ item, count }) => ({ ...item, pods: count }));
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
export function assign(plan: { agent_id: string; pods: number }[], orchestrators: { id: string; capacity: number }[]) {
  const out = new Map(orchestrators.map((o) => [o.id, new Map<string, number>()]));
  const load = new Map(orchestrators.map((o) => [o.id, 0]));
  const give = (o: { id: string }, agentId: string, n: number) => {
    const m = out.get(o.id)!;
    m.set(agentId, (m.get(agentId) ?? 0) + n);
    load.set(o.id, load.get(o.id)! + n);
  };
  if (!orchestrators.length) return out;
  const left = new Map(plan.map((p) => [p.agent_id, p.pods]));
  for (const p of plan) {
    const base = Math.floor(p.pods / orchestrators.length);
    for (const o of orchestrators) {
      const n = Math.min(base, o.capacity - load.get(o.id)!);
      if (n > 0) give(o, p.agent_id, n), left.set(p.agent_id, left.get(p.agent_id)! - n);
    }
  }
  for (const p of plan) {
    for (let rem = left.get(p.agent_id)!; rem > 0; rem--) {
      const o = orchestrators
        .filter((x) => load.get(x.id)! < x.capacity)
        .sort((a, b) =>
          load.get(a.id)! / a.capacity - load.get(b.id)! / b.capacity ||
          (out.get(a.id)!.get(p.agent_id) ?? 0) - (out.get(b.id)!.get(p.agent_id) ?? 0) ||
          a.id.localeCompare(b.id))[0];
      if (!o) break;
      give(o, p.agent_id, 1);
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
  const mine = orchestratorId ? dealt.get(orchestratorId) : undefined;
  return {
    orchestrators: live.length,
    total_pods: total,
    plan,
    queue,
    ...(orchestratorId
      ? {
          orchestrator_id: orchestratorId,
          // One entry per pod group: claim with {agent_ids: [agent_id]} so a Sonnet pod only takes Sonnet sessions.
          assignment: plan.map((s) => ({ agent_id: s.agent_id, harness: s.harness, model: s.model, pods: mine?.get(s.agent_id) ?? 0,
                                         image: s.image ?? null, version: s.version ?? null, agents: [s.agent_id] }))
            .filter((a) => a.pods > 0),
          next_checkin_seconds: Math.max(10, Math.floor(STALE_SECONDS() / 3)),
        }
      : { assignments: Object.fromEntries([...dealt].map(([id, m]) => [id, Object.fromEntries(m)])) }),
  };
}
