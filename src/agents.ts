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
