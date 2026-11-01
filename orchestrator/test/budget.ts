/**
 * Pure unit test of the sandbox budget (orchestrator/deploy/orch-lib.ts computeBudget), used by the shared-fleet cap
 * (src/autoscaler.ts) and the Compute page (src/compute.ts). Ported from the retired boat-fleet test:
 *  - budget maths: each orchestrator = 1 sandbox + podCapacity worker sandboxes, against the concurrency limit minus
 *    the sandboxes others hold; the refusal names the numbers
 *  - our own active sandboxes are not double-counted as "other active"
 *  - throughput ceiling: starts/day minus the orchestrators' own starts
 *
 *   npx tsx orchestrator/test/budget.ts
 */
import { computeBudget } from "../deploy/orch-lib.js";

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (...a: unknown[]) => console.log(`[budget ${new Date().toISOString().slice(11, 19)}]`, ...a);
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok, detail }); log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`); };

const L = { activeSandboxes: 100, startsPerMinute: 12, startsPerHour: 60, startsPerDay: 200, activeNow: 5 };
const b4 = computeBudget(L, 4, 20, 0), b5 = computeBudget(L, 5, 20, 0), bOurs = computeBudget({ ...L, activeNow: 44 }, 2, 20, 42);
check("budget: 4 x (1+20) = 84 of 95 available -> OK; 5 -> 105 refused; max 4",
  b4.ok && !b5.ok && b4.maxOrchestrators === 4 && b4.perOrchestrator === 21 && b4.requestedSandboxes === 84 && b5.requestedSandboxes === 105 &&
  b4.available === 95 && b4.otherActive === 5 && b4.plan === 100 && b4.reason === undefined, `${b5.reason}`);
check("budget: a refusal names the request, the available sandboxes and the max",
  b5.reason === "5 orchestrators x (1 + 20) = 105 sandboxes > 95 available (limit 100 - 5 other active); max 4", `${b5.reason}`);
check("budget: our own active sandboxes are not double-counted", bOurs.otherActive === 2 && bOurs.available === 98 && bOurs.ok, `otherActive ${bOurs.otherActive}`);
const bOurs3 = computeBudget({ ...L, activeNow: 44 }, 3, 20, 42), bCounted3 = computeBudget({ ...L, activeNow: 44 }, 3, 20, 0);
check("budget: counting ours as other active would refuse 3 orchestrators (63 > 56) that fit (63 <= 98)",
  bOurs3.ok && bOurs3.maxOrchestrators === 4 && !bCounted3.ok && bCounted3.otherActive === 44 && bCounted3.available === 56 && bCounted3.maxOrchestrators === 2, `${bCounted3.reason}`);
const bLag = computeBudget({ ...L, activeNow: 3 }, 1, 20, 10);
check("budget: ours above the provider's active count (listing lag) never makes other-active negative", bLag.otherActive === 0 && bLag.available === 100, `otherActive ${bLag.otherActive}`);
check("budget: throughput ceiling = starts/day minus orchestrator starts", b4.sessionsPerDayCeiling === 196 && b4.startsPerDay === 200, `${b4.sessionsPerDayCeiling}/day`);
const bMany = computeBudget({ ...L, startsPerDay: 3 }, 4, 20, 0);
check("budget: the throughput ceiling never goes below 0", bMany.sessionsPerDayCeiling === 0, `${bMany.sessionsPerDayCeiling}/day`);
const bFull = computeBudget({ ...L, activeNow: 90 }, 0, 20, 0);
check("budget: no room for one orchestrator -> max 0, asking for none is still OK", bFull.maxOrchestrators === 0 && bFull.ok && bFull.available === 10, `max ${bFull.maxOrchestrators}`);

const pass = results.every((r) => r.ok);
console.log(`\n${pass ? "BUDGET TEST PASS" : "BUDGET TEST FAIL"} (${results.filter((r) => r.ok).length}/${results.length} assertions)`);
process.exit(pass ? 0 : 1);
