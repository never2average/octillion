// Live orchestrators, the global usage-proportional pod plan, and each orchestrator's share.
//   npm run fleet:status
import { getDb } from "../src/db.js";
import { fleetStatus } from "../src/fleet.js";

const s = await fleetStatus();
console.log(`${s.orchestrators} live orchestrators, ${s.total_pods} pods; queue: ${s.queue.queued} queued, ${s.queue.running} running`);
console.table(s.plan.map((p) => ({ harness: p.harness, usage: `${(p.weight * 100).toFixed(1)}%`, pods: p.pods })));
if ("assignments" in s) console.table(s.assignments);
await (await getDb()).close();
