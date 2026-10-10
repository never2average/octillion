import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * The worker-agent registry (harnesses/registry.json): every coding agent we can run (harness + model + pinned
 * image) and its weight, i.e. its share of real-world developer usage. A default ("representative") simulation
 * samples agents in proportion to these weights, so results reflect what developers actually run.
 * Without a registry file, agents come from OCTILLION_MODELS x OCTILLION_HARNESS with equal weights.
 */

export interface AgentSpec {
  id: string; harness: string; label: string; model: string; weight: number; enabled: boolean;
  vendor?: string; harness_version?: string; event_format?: string;
  image?: { docker?: string; boat_snapshot?: string }; requires_env?: string[]; notes?: string;
  worker_adapter?: "supported" | "todo" | string;  // whether orchestrator workers can run this harness yet
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

export const isRunnable = (a: AgentSpec) => a.enabled !== false && a.weight > 0 && a.worker_adapter !== "todo";

/** Share of enabled (representable) usage that workers can run today, 0..1. */
export function runnableCoverage(): number {
  const enabled = registry().agents.filter((a) => a.enabled !== false && a.weight > 0);
  const total = enabled.reduce((s, a) => s + a.weight, 0);
  return total ? enabled.filter(isRunnable).reduce((s, a) => s + a.weight, 0) / total : 0;
}

/** Runnable agents (enabled, with a worker adapter) with weights renormalised to sum to 1. */
export function enabledAgents(): AgentSpec[] {
  const agents = registry().agents.filter(isRunnable);
  const total = agents.reduce((s, a) => s + a.weight, 0) || 1;
  return agents.map((a) => ({ ...a, weight: a.weight / total }));
}

export function findAgent(id: string): AgentSpec | undefined {
  return registry().agents.find((a) => a.id === id);
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
export function representativePlan(slots: number, agents: AgentSpec[] = enabledAgents()): AgentSpec[] {
  // Each agent's sessions sit at evenly spaced positions (i + 0.5) / count, so no agent is bunched on a few scenarios.
  return apportion(agents, slots)
    .flatMap(({ item, count }) => Array.from({ length: count }, (_, i) => ({ item, key: (i + 0.5) / count })))
    .sort((a, b) => a.key - b.key)
    .map((p) => p.item);
}
