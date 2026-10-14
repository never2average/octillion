import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * The worker-agent registry (harnesses/registry.json): every coding agent we can run (harness + model + pinned
 * image + adapter). Its `weight`s are only the cited seed for the default developer population; the live mix
 * (shares, pauses, sandbox unit) is in Postgres under developer populations (src/populations.ts).
 * Without a registry file, agents come from OCTILLION_MODELS x OCTILLION_HARNESS with equal weights.
 */

export interface AgentSpec {
  id: string; harness: string; label: string; model: string; weight: number; enabled: boolean;
  vendor?: string; harness_version?: string; event_format?: string;
  image?: { docker?: string; boat_snapshot?: string }; requires_env?: string[]; notes?: string;
  worker_adapter?: "supported" | "todo" | string;  // whether orchestrator workers can run this harness yet
  paused?: boolean; paused_reason?: string;          // operator switch: keep the agent defined but don't sample or pod it
  /**
   * In-harness model split: this agent holds the harness's one population slot, and each session sampled for it runs
   * as one of these registry agents (same harness), drawn by share. Shares sum to 1 and may include this agent itself.
   * Keeps a small harness at its real share instead of one minimum sandbox per model.
   */
  model_variants?: Record<string, number>;
}
export interface Registry { version: number; as_of?: string; unrepresented_share?: number; sources?: unknown[]; agents: AgentSpec[] }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let cached: { file: string; registry: Registry } | undefined;

export function registry(): Registry {
  const file = path.resolve(ROOT, process.env.OCTILLION_REGISTRY ?? "harnesses/registry.json");
  if (cached?.file === file) return cached.registry;
  let reg: Registry;
  try {
    reg = JSON.parse(readFileSync(file, "utf8")) as Registry;
  } catch {
    const models = (process.env.OCTILLION_MODELS ?? "claude-sonnet-5-5,claude-opus-5-5").split(",").map((s) => s.trim()).filter(Boolean);
    const harness = process.env.OCTILLION_HARNESS ?? "claude-code";
    reg = { version: 0, agents: models.map((model) => ({ id: `${harness}/${model}`, harness, label: `${harness} · ${model}`, model, weight: 1 / models.length, enabled: true })) };
  }
  cached = { file, registry: reg };
  return reg;
}

export const isRunnable = (a: AgentSpec) => a.enabled !== false && a.weight > 0 && a.worker_adapter !== "todo" && !a.paused;

/**
 * A developer population (src/populations.ts): registry agents with this population's market shares (`weight`) and
 * pause switches, plus its sandbox unit. Everything below is pure math over a population.
 */
export interface Population {
  id: number; slug: string; name: string; description: string; as_of: string | null; methodology: string;
  sources: unknown[]; unrepresented_share: number | null; sandbox_unit: number; min_one_sandbox: boolean; is_default: boolean;
  agents: AgentSpec[];
}

/** Share of representable usage (enabled agents with a share) that workers can run today, 0..1. */
export function runnableCoverage(pop: Population): number {
  const enabled = pop.agents.filter((a) => a.enabled !== false && a.weight > 0);
  const total = enabled.reduce((s, a) => s + a.weight, 0);
  return total ? enabled.filter(isRunnable).reduce((s, a) => s + a.weight, 0) / total : 0;
}

/** Runnable agents (enabled, adapter, not paused, share > 0) with shares renormalised to sum to 1. */
export function enabledAgents(pop: Population): AgentSpec[] {
  const agents = pop.agents.filter(isRunnable);
  const total = agents.reduce((s, a) => s + a.weight, 0) || 1;
  return agents.map((a) => ({ ...a, weight: a.weight / total }));
}

/**
 * The sandbox unit: the running mix in whole sandboxes out of the population's `sandbox_unit` (20), so every share
 * is runnable (multiples of 5% at 20). Largest-remainder rounding keeps the total exact: Opus 43.5% -> 8.7 -> 9.
 * Agents that round to 0 sit out unless the population sets `min_one_sandbox`, which gives every running agent at
 * least one (taken from whoever is most over their exact share). This unit drives displayed shares, run sampling
 * and pod plans: N orchestrators run N x the unit.
 */
export function sandboxMix(pop: Population): { agent: AgentSpec; sandboxes: number; exact: number }[] {
  const unit = pop.sandbox_unit;
  const rows = apportion(enabledAgents(pop), unit).map(({ item, count }) => ({ agent: item, sandboxes: count, exact: item.weight * unit }));
  if (pop.min_one_sandbox && unit >= rows.length)
    for (const empty of rows.filter((r) => r.sandboxes === 0)) {
      const donor = rows.filter((r) => r.sandboxes > 1).sort((a, b) => (b.sandboxes - b.exact) - (a.sandboxes - a.exact))[0];
      if (!donor) break;
      donor.sandboxes--;
      empty.sandboxes++;
    }
  return rows.sort((a, b) => b.sandboxes - a.sandboxes || b.exact - a.exact);
}

/** Agents in the sandbox unit, weighted by their whole-sandbox share (sandboxes / unit; sums to 1). */
export function scheduledAgents(pop: Population): AgentSpec[] {
  return sandboxMix(pop).filter((r) => r.sandboxes > 0).map((r) => ({ ...r.agent, weight: r.sandboxes / pop.sandbox_unit }));
}

/**
 * The scheduled agents with their real usage shares as weights, for allocating a run's sessions (planFirstBatch,
 * dealToCells). scheduledAgents' weights are the pod mix (shares rounded to a sandbox unit with at least one sandbox
 * each), which already lifts small agents: Kilo's 0.5% becomes 1/20 = 5%. Allocating from those and then applying
 * the batch floor boosted small agents twice (seen live 2026-10-14: Opus 9 and Codex 5 instead of 10 and 6).
 */
export function schedulingShares(pop: Population): AgentSpec[] {
  return sandboxMix(pop).filter((r) => r.sandboxes > 0).map((r) => r.agent);
}

export function findAgent(id: string): AgentSpec | undefined {
  return registry().agents.find((a) => a.id === id);
}

/** The agents a slot agent's sessions may run as: itself, or its model_variants entries (registry agents, same harness). */
export function variantsOf(slot: AgentSpec): AgentSpec[] {
  if (!slot.model_variants) return [slot];
  return Object.keys(slot.model_variants).map((id) => findAgent(id)).filter((a): a is AgentSpec => !!a && a.harness === slot.harness);
}

/** Draw the agent one session of `slot` runs as, by model_variants share (`rand` in [0, 1)). */
export function drawVariant(slot: AgentSpec, rand: number = Math.random()): AgentSpec {
  const variants = variantsOf(slot);
  if (variants.length <= 1) return variants[0] ?? slot;
  const total = variants.reduce((s, v) => s + (slot.model_variants![v.id] ?? 0), 0) || 1;
  let acc = 0;
  for (const v of variants) {
    acc += (slot.model_variants![v.id] ?? 0) / total;
    if (rand < acc) return v;
  }
  return variants[variants.length - 1];
}

/**
 * Every agent with weight gets at least `floor` slots, the rest go by weight (largest remainder). With 4 problems x 2
 * personas x 3 samples = 24 and the 2026-10-14 mix (Claude Code on Opus 40.4%, Codex 19.7%, OpenCode 5.5%,
 * Antigravity 4.9%, Pi 1.6%, Cline 1.1%, Kilo 0.5%) and floor 1: Opus 10, Codex 6, OpenCode 2, Antigravity 2, Pi 2,
 * Cline 1, Kilo 1. When n cannot cover the floor for every agent, it is plain weighted apportionment.
 */
export function apportionWithFloor<T extends { weight: number }>(items: T[], n: number, floor: number): { item: T; count: number }[] {
  if (floor <= 0 || floor * items.length > n) return apportion(items, n);
  return apportion(items, n - floor * items.length).map(({ item, count }) => ({ item, count: count + floor }));
}

/**
 * Size a run's first batch from its grid: the smallest samples-per-cell s (cell = problem x persona) such that, with
 * N = problems x personas x s sessions dealt by apportionWithFloor:
 *   1. every scheduled harness gets at least `floor` sessions (default 1);
 *   2. every major harness (normalised share >= `majorShare`, default 15%) gets at least one session per problem;
 *   3. N <= `maxSessions`.
 * If no s satisfies 1-2 within the cap, the largest s within the cap is used and `met` is false.
 * Today's mix with 4 problems x 2 personas gives s = 3, N = 24: Opus 10, Codex 6, OpenCode 2, Antigravity 2, Pi 2,
 * Cline 1, Kilo 1.
 */
export function planFirstBatch(problems: number, personas: number, agents: { id: string; weight: number }[],
  opts: { floor?: number; majorShare?: number; maxSessions?: number; maxSamples?: number } = {}) {
  const live = agents.filter((a) => a.weight > 0);
  const floor = opts.floor ?? 1, majorShare = opts.majorShare ?? 0.15, maxSessions = opts.maxSessions ?? 120, maxSamples = opts.maxSamples ?? 20;
  const total = live.reduce((t, a) => t + a.weight, 0) || 1;
  const majors = live.filter((a) => a.weight / total >= majorShare);
  const cells = Math.max(1, problems) * Math.max(1, personas);
  let pick: { samples: number; sessions: number; counts: Record<string, number>; met: boolean } | null = null;
  for (let s = 1; s <= maxSamples && cells * s <= maxSessions; s++) {
    const n = cells * s;
    const counts = Object.fromEntries(apportionWithFloor(live, n, floor).map(({ item, count }) => [item.id, count]));
    const met = live.every((a) => counts[a.id]! >= floor) && majors.every((a) => counts[a.id]! >= problems);
    pick = { samples: s, sessions: n, counts, met };
    if (met) break;
  }
  return { ...(pick ?? { samples: 1, sessions: cells, counts: {}, met: false }), cells, floor, majors: majors.map((a) => a.id) };
}

/** Largest-remainder apportionment of `n` slots by weight (deterministic; ties go to the larger weight). */
export function apportion<T extends { weight: number }>(items: T[], n: number): { item: T; count: number }[] {
  const total = items.reduce((s, x) => s + x.weight, 0) || 1;
  const rows = items.map((item) => {
    const exact = (item.weight / total) * n;
    return { item, count: Math.floor(exact), rest: exact - Math.floor(exact) };
  });
  let left = n - rows.reduce((s, r) => s + r.count, 0);
  for (const r of [...rows].sort((a, b) => b.rest - a.rest || b.item.weight - a.item.weight)) {
    if (left-- <= 0) break;
    r.count++;
  }
  return rows.map(({ item, count }) => ({ item, count }));
}

/**
 * Weighted allocation, dealt so every cell gets a near-proportional mix. The run's sessions are apportioned by weight
 * over the whole run (as representativePlan does), then dealt heaviest agent first: each next session of an agent
 * goes to the cell holding the fewest of that agent, then the least-filled cell. So Opus and Codex spread evenly
 * over all cells, and agents with only a slot or two land in different cells instead of piling into one (seen live
 * 2026-10-14: the strided deal put Cline, Kilo and Pi into the same scenario x persona cell). A cell is one scenario x
 * profile (first batch) or one scenario's top-up (adaptive); `sizes` are the sessions each cell needs.
 */
export function dealToCells(sizes: number[], agents: AgentSpec[], opts: { floor?: number; groups?: number[] } = {}): AgentSpec[][] {
  const cells: AgentSpec[][] = sizes.map(() => []);
  const total = sizes.reduce((a, b) => a + b, 0);
  const queue = apportionWithFloor(agents.filter((a) => a.weight > 0), total, opts.floor ?? 0).filter((r) => r.count > 0)
    .sort((a, b) => b.item.weight - a.item.weight || a.item.id.localeCompare(b.item.id))
    .flatMap(({ item, count }) => Array.from({ length: count }, () => item));
  for (const agent of queue) {
    let best = -1;
    for (let c = 0; c < cells.length; c++) {
      if (cells[c]!.length >= sizes[c]!) continue;
      if (best < 0) { best = c; continue; }
      const mine = cells[c]!.filter((a) => a.id === agent.id).length, theirs = cells[best]!.filter((a) => a.id === agent.id).length;
      // Same problem (group) already has this agent: prefer another problem, so a harness covers different problems.
      const inGroup = (i: number) => opts.groups ? cells.reduce((n, cell, j) => n + (opts.groups![j] === opts.groups![i] ? cell.filter((a) => a.id === agent.id).length : 0), 0) : 0;
      const g = inGroup(c), gb = inGroup(best);
      const fill = cells[c]!.length / sizes[c]!, bestFill = cells[best]!.length / sizes[best]!;
      if (mine < theirs || (mine === theirs && (g < gb || (g === gb && fill < bestFill)))) best = c;
    }
    if (best >= 0) cells[best]!.push(agent);
  }
  return cells;
}

/**
 * Spread a run's agent sessions over its slots (scenario x profile x sample) so every scenario gets a mix close to the
 * overall weights: apportion over the whole run, then deal agents out in a strided order.
 */
export function representativePlan(slots: number, agents: AgentSpec[]): AgentSpec[] {
  // Each agent's sessions sit at evenly spaced positions (i + 0.5) / count, so no agent is bunched on a few scenarios.
  return apportion(agents, slots)
    .flatMap(({ item, count }) => Array.from({ length: count }, (_, i) => ({ item, key: (i + 0.5) / count })))
    .sort((a, b) => a.key - b.key)
    .map((p) => p.item);
}
