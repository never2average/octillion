// Production-readiness checks for scripts/smoke.ts, kept out of its main body (TypeScript's control-flow limit).
import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type Db = { query: <T = any>(sql: string, params?: unknown[]) => Promise<T[]> };

/** Agents no key can serve leave runs (queries.ts withKeys, gateway.ts missingAgentKeys): a gateway provider counts
 *  only with an enabled key, a direct one only when direct keys are allowed. */
export async function keyChecks({ db, worker, call, fails, A, sessionId }: { db: Db; worker: (path: string, body: unknown) => Promise<Response>;
  call: (c: Client, name: string, args?: Record<string, unknown>) => Promise<any>; fails: (c: Client, name: string, args: Record<string, unknown>, re: RegExp) => Promise<void>;
  A: Client; sessionId: string }) {
  const { missingAgentKeys } = await import("../src/gateway.js");
  const cc = { id: "claude-code/sonnet", harness: "claude-code", requires_env: ["SMOKE_LLM_API_KEY", "SMOKE_VENDOR_TOKEN"] };
  assert.deepEqual((await missingAgentKeys([cc])).get(cc.id), [], "both keys present (direct keys allowed): runnable");
  await db.query("UPDATE vault_credentials SET enabled = false WHERE provider = 'smoke_llm'");
  assert.deepEqual((await missingAgentKeys([cc])).get(cc.id), ["SMOKE_LLM_API_KEY"], "a gateway provider with no enabled key supplies nothing");
  const refused = await worker(`/sessions/${sessionId}/credentials`, {});
  assert.equal(refused.status, 424, "the session is refused up front, not mid-run on its first model call");
  process.env.OCTILLION_RUN_KEY_CHECK = "on";
  await fails(A, "run_simulation", { agents: ["claude-code/sonnet"], repeats: 1 }, /No vault key can run claude-code\/sonnet/);
  const without = await call(A, "run_simulation", { samples: 1, name: "keys" });
  assert.ok(without.sessions.every((x: any) => x.agent_id !== "claude-code/sonnet") && without.agents_without_keys?.includes("claude-code/sonnet"),
    "a representative run leaves the keyless agent out and says so");
  await call(A, "cancel_simulation", { simulation_id: without.simulation.id });
  process.env.OCTILLION_RUN_KEY_CHECK = "off";
  await db.query("UPDATE vault_credentials SET enabled = true WHERE provider = 'smoke_llm'");
  console.log("✓ agents without a usable vault key: left out of runs, refused before they start");
}

/** Health alerts (src/health-alerts.ts): failure rate over the last hour, by error class and version drift; a stuck
 *  queue; one alert per problem per hour. A month ahead, so only these sessions are in its window. */
export async function healthChecks({ db, sentTo, OPS, stamp, orgId, productId, scenarioId }: { db: Db; sentTo: (to: string, kind?: string) => any[]; OPS: string;
  stamp: string; orgId: number; productId: number; scenarioId: number }) {
  const health = await import("../src/health-alerts.js");
  const T = new Date(Date.now() + 30 * 24 * 3600_000), at = new Date(T.getTime() - 10 * 60_000);
  const hs = (n: number, status: string, error: string | null, meta: Record<string, unknown> = {}) => db.query(
    `INSERT INTO agent_sessions (id, simulation_id, org_id, product_id, scenario_id, model, harness, status, error_message, metadata, ended_at)
     VALUES ($1, $2, $3, $4, $5, 'm', 'claude-code', $6, $7, $8, $9)`, [`ses_health_${n}_${stamp}`, `sim_budget_${stamp}`, orgId, productId, scenarioId, status, error, JSON.stringify(meta), at]);
  for (let i = 0; i < 3; i++) await hs(i, "failed", "API Error: 503 No anthropic credential in the vault");
  for (let i = 3; i < 7; i++) await hs(i, "completed", null, i === 3 ? { harness_drift: { found: "2.1.304 (Claude Code)", pinned: "2.1.296" } } : {});
  const facts = await health.healthFacts(T);
  assert.ok(facts.finished === 7 && facts.failed === 3 && facts.drift[0]?.found.startsWith("2.1.304") && facts.classes[0]?.sessions === 3, `facts: ${JSON.stringify(facts).slice(0, 200)}`);
  assert.deepEqual(health.healthAlerts({ ...facts, oldest_queued_min: null }, { rate: 50, queueMinutes: 30 }), [], "3 of 7 (43%) is under a 50% threshold");
  assert.deepEqual(health.healthAlerts({ ...facts, finished: 4, oldest_queued_min: null }, { rate: 10, queueMinutes: 30 }), [], "fewer than 5 finished: no alert");
  const r1 = await health.checkHealth(T);
  assert.ok(r1.alerts.includes("failure_rate") && r1.emailed >= 1, `alerted: ${JSON.stringify(r1.alerts)}`);
  const ha = sentTo(OPS, "health_alert").find((e: any) => /43% of agent sessions failed/.test(e.subject));
  assert.ok(ha && /3 of the 7/.test(ha.text) && /Missing provider key: 3/.test(ha.text) && /2\.1\.304.*pinned 2\.1\.296/.test(ha.text) && ha.text.includes("/admin/compute"),
    `the alert says how many, why, which versions drifted, and where to look: ${ha?.text}`);
  const r2 = await health.checkHealth(new Date(T.getTime() + 60_000));
  assert.equal(r2.emailed, 0, "one alert per problem per hour");
  await db.query("DELETE FROM agent_sessions WHERE id LIKE $1", [`ses_health_%_${stamp}`]);
  console.log("✓ health alerts: failed-session rate with error classes and version drift, stuck queue, once an hour");
}

/** The public /pricing page's experiment (src/experiments.ts visitorPlans, GET /api/pricing): a visitor gets a cookie
 *  and one sticky variant; an account opened from that browser takes the visitor's variant; FinOps counts visitors. */
export async function pricingVisitorChecks({ db, base, exp, variantIds, adm, json }: { db: Db; base: string; exp: string; variantIds: string[];
  adm: (method: string, path: string, body?: unknown) => Promise<Response>; json: (r: Promise<Response>) => Promise<any> }) {
  const E = await import("../src/experiments.js"), B = await import("../src/billing.js");
  B.invalidatePlans();
  const plans = await B.listPlans();
  const lookupOf = (id: string) => plans.find((p) => p.price_id === id)!.lookup_key;
  const variantLookups = variantIds.map(lookupOf);
  const r1 = await fetch(`${base}/api/pricing`);
  const cookie = /oct_vid=([A-Za-z0-9_-]+)/.exec(r1.headers.get("set-cookie") ?? "")?.[1];
  const p1 = (await r1.json()).plans as { id: string }[];
  assert.ok(cookie && /HttpOnly/.test(r1.headers.get("set-cookie")!), "a first visit gets a first-party visitor cookie");
  const shown = p1.filter((p) => variantLookups.includes(p.id));
  assert.equal(shown.length, 1, "a visitor sees one variant of the experiment");
  assert.ok(p1.some((p) => !variantLookups.includes(p.id)), "and every plan in no experiment");
  const again = (await (await fetch(`${base}/api/pricing`, { headers: { cookie: `oct_vid=${cookie}` } })).json()).plans as { id: string }[];
  assert.deepEqual(again.map((p) => p.id), p1.map((p) => p.id), "the same variant on every visit");
  assert.equal((await db.query("SELECT 1 FROM pricing_exposures WHERE visitor_id = $1 AND experiment = $2", [cookie, exp])).length, 1, "one exposure per visitor and experiment");
  assert.ok(!JSON.stringify(p1).includes(exp), "the page never names the experiment");
  // An account first opened from a browser takes that visitor's variant, even where the account's own pick differs:
  // a visitor shown the variant this new account would not get.
  const [o] = await db.query<{ id: number }>("INSERT INTO organizations (slug, name) VALUES ($1, $1) RETURNING id", [`vis-${cookie!.slice(0, 8).toLowerCase()}`]);
  const orgId = o!.id;
  const ownPick = E.pickVariant(orgId, exp, plans.filter((p) => p.experiment === exp))!.price_id;
  const visitorVariant = variantIds.find((id) => id !== ownPick)!;
  const vid2 = `${cookie}x`;
  await db.query("INSERT INTO pricing_exposures (visitor_id, experiment, price_id) VALUES ($1, $2, $3)", [vid2, exp, visitorVariant]);
  const offered = await E.offeredPlans(orgId, plans, vid2);
  assert.ok(offered.some((p) => p.price_id === visitorVariant) && !offered.some((p) => p.price_id === ownPick), "the account is offered the variant its browser saw on /pricing");
  const [ex] = await db.query<{ price_id: string; visitor_id: string }>("SELECT price_id, visitor_id FROM plan_exposures WHERE org_id = $1 AND experiment = $2", [orgId, exp]);
  assert.deepEqual([ex?.price_id, ex?.visitor_id], [visitorVariant, vid2], "recorded as the visitor's exposure");
  const rep = await json(adm("GET", "/spend/experiments"));
  assert.ok(rep.variants.find((x: any) => x.experiment === exp && x.price_id === visitorVariant)?.visitors >= 1, "FinOps counts visitors per variant");
  console.log("✓ pricing page: visitor cookie, one sticky variant per experiment, the account inherits it, visitors counted per variant");
}
