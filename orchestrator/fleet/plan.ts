import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fleet plan: how many warm worker pods each coding harness gets. Pods are apportioned by the harness's share of
 * real-world developer usage (sum of its registry agents' weights), largest remainder, at least one pod per
 * enabled harness when the fleet is big enough. With FLEET_SIZE=10 and Claude Code at 40%, Claude Code gets 4 pods.
 */

export interface RegistryAgent {
  id: string; harness: string; label: string; model: string; weight: number; enabled?: boolean;
  harness_version?: string; image?: { docker?: string; boat_snapshot?: string }; requires_env?: string[];
}
export interface PodGroup { harness: string; weight: number; pods: number; image: string; version?: string; requires_env: string[]; agents: string[] }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function loadRegistry(file = process.env.OCTILLION_REGISTRY ?? "harnesses/registry.json"): { agents: RegistryAgent[] } {
  return JSON.parse(readFileSync(path.resolve(ROOT, file), "utf8"));
}

export function planFleet(size: number, agents: RegistryAgent[] = loadRegistry().agents): PodGroup[] {
  const groups = new Map<string, PodGroup>();
  for (const a of agents.filter((x) => x.enabled !== false && x.weight > 0 && (x as { worker_adapter?: string }).worker_adapter !== "todo")) {
    const g = groups.get(a.harness) ?? {
      harness: a.harness, weight: 0, pods: 0, version: a.harness_version, agents: [], requires_env: [],
      image: a.image?.docker ?? `octillion/agent-${a.harness}:${a.harness_version ?? "latest"}`,
    };
    g.weight += a.weight;
    g.agents.push(a.id);
    g.requires_env = [...new Set([...g.requires_env, ...(a.requires_env ?? [])])];
    groups.set(a.harness, g);
  }
  const list = [...groups.values()].sort((a, b) => b.weight - a.weight);
  const total = list.reduce((s, g) => s + g.weight, 0) || 1;
  for (const g of list) g.weight /= total;

  // Same rule as the server (src/fleet.ts planPods): strictly proportional by largest remainder, then a harness left
  // with zero pods takes one from whichever harness is most over its exact share, when the fleet can afford it.
  const rows = list.map((g) => ({ g, exact: g.weight * size }));
  for (const r of rows) r.g.pods = Math.floor(r.exact);
  let left = size - rows.reduce((s, r) => s + r.g.pods, 0);
  for (const r of [...rows].sort((a, b) => (b.exact % 1) - (a.exact % 1) || b.g.weight - a.g.weight)) {
    if (left-- <= 0) break;
    r.g.pods++;
  }
  if (size >= list.length)
    for (const empty of list.filter((g) => g.pods === 0)) {
      const donor = list.filter((g) => g.pods > 1).sort((a, b) => (b.pods - b.weight * size) - (a.pods - a.weight * size))[0];
      if (!donor) break;
      donor.pods--;
      empty.pods++;
    }
  return list;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const size = Number(process.argv[2] ?? process.env.FLEET_SIZE ?? 10);
  const plan = planFleet(size);
  console.table(plan.map((g) => ({ harness: g.harness, usage: `${(g.weight * 100).toFixed(1)}%`, pods: g.pods, image: g.image })));
  console.log(`${plan.reduce((s, g) => s + g.pods, 0)} pods total`);
  const starved = plan.filter((g) => !g.pods).map((g) => g.harness);
  if (starved.length) console.warn(`Warning: no pod for ${starved.join(", ")}; their sessions will wait. Use FLEET_SIZE >= ${plan.length}.`);
}
