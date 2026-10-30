// Production-readiness checks for scripts/smoke.ts, kept out of its main body (TypeScript's control-flow limit).
import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type Db = { query: <T = any>(sql: string, params?: unknown[]) => Promise<T[]> };

/** Agents no key can serve leave runs (queries.ts withKeys, gateway.ts missingAgentKeys): a gateway provider counts
 *  only with its key, a direct one only when direct keys are allowed. */
export async function keyChecks({ db, worker, call, fails, A, sessionId }: { db: Db; worker: (path: string, body: unknown) => Promise<Response>;
  call: (c: Client, name: string, args?: Record<string, unknown>) => Promise<any>; fails: (c: Client, name: string, args: Record<string, unknown>, re: RegExp) => Promise<void>;
  A: Client; sessionId: string }) {
  const { missingAgentKeys } = await import("../src/gateway.js");
  const cc = { id: "claude-code/sonnet", harness: "claude-code", requires_env: ["SMOKE_LLM_API_KEY", "SMOKE_VENDOR_TOKEN"] };
  assert.deepEqual((await missingAgentKeys([cc])).get(cc.id), [], "both keys present (direct keys allowed): runnable");
  // No disable: the key is taken out (and put back as it was below).
  const [llmKey] = await db.query("DELETE FROM vault_credentials WHERE provider = 'smoke_llm' RETURNING row_to_json(vault_credentials.*) AS r");
  assert.deepEqual((await missingAgentKeys([cc])).get(cc.id), ["SMOKE_LLM_API_KEY"], "a gateway provider with no key supplies nothing");
  const refused = await worker(`/sessions/${sessionId}/credentials`, {});
  assert.equal(refused.status, 424, "the session is refused up front, not mid-run on its first model call");
  process.env.OCTILLION_RUN_KEY_CHECK = "on";
  await fails(A, "run_simulation", { agents: ["claude-code/sonnet"], repeats: 1 }, /No vault key can run claude-code\/sonnet/);
  const without = await call(A, "run_simulation", { samples: 1, name: "keys" });
  assert.ok(without.sessions.every((x: any) => x.agent_id !== "claude-code/sonnet") && without.agents_without_keys?.includes("claude-code/sonnet"),
    "a representative run leaves the keyless agent out and says so");
  await call(A, "cancel_simulation", { simulation_id: without.simulation.id });
  process.env.OCTILLION_RUN_KEY_CHECK = "off";
  await db.query("INSERT INTO vault_credentials SELECT * FROM json_populate_record(null::vault_credentials, $1::json)", [JSON.stringify(llmKey.r)]);
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

/** Correcting a product's competitors rescores its past sessions (queries.ts saveProduct, worker.ts rescoreProduct):
 *  a tool listed by mistake (a complement) stops winning, and putting it back restores the losses. */
export async function rescoreChecks({ db, call, A, simulationId }: { db: Db; call: (c: Client, name: string, args?: Record<string, unknown>) => Promise<any>;
  A: Client; simulationId: string }) {
  const [p] = await db.query<{ id: number; slug: string; competitors: { name: string }[] }>(
    "SELECT p.id, p.slug, p.competitors FROM products p JOIN simulations s ON s.product_id = p.id WHERE s.id = $1", [simulationId]);
  const lostTo = async (tool: string) => (await db.query("SELECT 1 FROM agent_sessions WHERE product_id = $1 AND winner = $2", [p!.id, tool])).length;
  const before = await lostTo("BullMQ");
  assert.ok(before > 0, "sessions lost to BullMQ to start with");
  const { rescoreProduct } = await import("../src/worker.js");
  const saved = await call(A, "save_product", { product: p!.slug, competitors: p!.competitors.filter((c) => c.name !== "BullMQ") });
  assert.equal(saved.rescoring, true, "a changed competitor list rescores past sessions");
  const r = await rescoreProduct(p!.id);
  // save_product already started the same rescore in the background; this one waits for a settled state.
  assert.ok(r.rescored >= before && (await lostTo("BullMQ")) === 0, `no session is lost to a tool no longer listed: ${JSON.stringify(r)}`);
  // Unconfirmed (research asked the customer and no answer yet): kept on the product, left out of scoring.
  await call(A, "save_product", { product: p!.slug, competitors: p!.competitors.map((c) => (c.name === "BullMQ" ? { ...c, unconfirmed: true } : c)) });
  await rescoreProduct(p!.id);
  assert.equal(await lostTo("BullMQ"), 0, "an unconfirmed competitor wins nothing until the customer answers");
  await call(A, "save_product", { product: p!.slug, competitors: p!.competitors });
  await rescoreProduct(p!.id);
  assert.equal(await lostTo("BullMQ"), before, "putting it back restores the losses");
  console.log("✓ rescoring: a corrected competitor list (e.g. a complement removed) changes past verdicts, not only new ones");
}

/** Claude on Vertex rejects some beta flags harnesses send (src/vertex.ts): parsed from its 400 and dropped from then on. */
export async function vertexBetaChecks() {
  const v = await import("../src/vertex.js");
  const err = '{"type":"error","error":{"type":"invalid_request_error","message":"Unexpected value(s) `inline-tools-2026-09-15`, `made-up-2026-01-01` for the `anthropic_beta` parameter. Please consult our documentation"}}';
  assert.deepEqual(v.rejectedBetas(err), ["inline-tools-2026-09-15", "made-up-2026-01-01"]);
  assert.deepEqual(v.rejectedBetas('{"error":{"message":"max_tokens is too large"}}'), []);
  const out = v.toVertex({ project_id: "p", region: "global" } as any, "/v1/messages", Buffer.from(JSON.stringify({ model: "claude-opus-5-5", max_tokens: 10, messages: [] })),
    "inline-tools-2026-09-15, context-management-2025-06-27");
  assert.deepEqual(JSON.parse(out.body).anthropic_beta, ["context-management-2025-06-27"], "a known-unsupported beta is dropped before sending");
  console.log("✓ Vertex: beta flags it rejects are dropped (known ones up front, new ones after one retry)");
}

/** Key vault, one key per provider (src/keyvault.ts, migration 0011): a key goes in once and only its hint comes back;
 *  a second key for the same type replaces the first (one row, rotated_at set); no enable/disable anywhere; delete. */
export async function vaultOneKeyChecks({ db, adm, json, base, ADMIN_TOKEN, stamp }: { db: Db; adm: (method: string, path: string, body?: unknown) => Promise<Response>;
  json: (r: Response | Promise<Response>) => Promise<any>; base: string; ADMIN_TOKEN: string; stamp: string }) {
  const kv = await import("../src/keyvault.js");
  const PAGE_KEY = `sk-ant-smoke-page-${stamp}-SECRETTAIL`;
  const addedKey = await json(adm("POST", "/compute/keys", { provider: "anthropic", secret: PAGE_KEY }));
  assert.ok(addedKey.id && addedKey.hint && !JSON.stringify(addedKey).includes(PAGE_KEY), "the add response has the hint, not the key");
  assert.ok(!("label" in addedKey) && !("priority" in addedKey) && !("enabled" in addedKey), "no label, priority or enabled in the API");
  const keysView = await (await adm("GET", "/compute/keys")).text();
  assert.ok(!keysView.includes(PAGE_KEY) && !keysView.includes("ciphertext"), "the key list never carries a secret");
  const kj = JSON.parse(keysView);
  const listedKey = kj.credentials.find((c: any) => c.id === addedKey.id);
  assert.ok(listedKey && listedKey.hint === addedKey.hint && !("enabled" in listedKey) && !("label" in listedKey), "the new key is listed by its hint");
  assert.ok(kj.providers.find((p: any) => p.slug === "anthropic").has_key, "the provider has its key");
  assert.ok(kj.providers.every((p: any) => !("enabled" in p)), "providers have no on/off");
  // One key per type: a second Anthropic key replaces the first (same row, rotated), never a second row.
  const PAGE_KEY_2 = `sk-ant-smoke-page-${stamp}-ROTATED2`;
  const replacedKey = await json(adm("POST", "/compute/keys", { provider: "anthropic", secret: PAGE_KEY_2 }));
  assert.ok(replacedKey.replaced && replacedKey.id === addedKey.id && replacedKey.hint !== addedKey.hint, "a second key for the type replaces the first");
  const anthRows = await db.query<any>("SELECT id, hint, rotated_at FROM vault_credentials WHERE provider = 'anthropic'");
  assert.ok(anthRows.length === 1 && anthRows[0].hint === replacedKey.hint && anthRows[0].rotated_at, "still one Anthropic row, rotated_at set");
  assert.equal((await kv.useCredential("anthropic")).secret, PAGE_KEY_2, "the replacement is the key in use");
  assert.equal((await json(adm("GET", "/compute/keys"))).credentials.filter((c: any) => c.provider === "anthropic").length, 1, "the page lists one Anthropic key");
  await assert.rejects(db.query("INSERT INTO vault_credentials (provider, label, ciphertext, iv, tag, key_id, hint) VALUES ('anthropic', 'second', 'x', 'x', 'x', 'x', 'x')"), /unique|duplicate/i, "the database refuses a second key for a type");
  assert.equal((await adm("POST", "/compute/keys", { provider: "cursor", secret: "cursor-secret-123456" })).status, 400, "direct-mode keys still refused");
  assert.equal((await adm("POST", "/compute/keys", { provider: "anthropic", secret: "" })).status, 400);
  // No enable/disable anywhere: the old routes are gone (410) and change nothing.
  assert.equal((await adm("POST", `/compute/keys/${addedKey.id}/enabled`, { enabled: false })).status, 410, "no key disable");
  assert.equal((await adm("POST", "/compute/providers/anthropic/enabled", { enabled: false })).status, 410, "no provider toggle");
  assert.equal((await fetch(`${base}/api/admin/keyvault/credentials/${addedKey.id}`, { method: "PATCH", headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) })).status, 410, "no vault API disable");
  await kv.upsertProvider({ slug: "anthropic", enabled: false } as any); // an old caller's enabled is ignored
  assert.ok((await json(adm("GET", "/compute/keys"))).credentials.some((c: any) => c.id === addedKey.id), "the key is still there");
  assert.ok((await db.query<any>("SELECT enabled FROM vault_providers WHERE slug = 'anthropic'"))[0].enabled, "the provider stays on");
  assert.equal((await kv.useCredential("anthropic")).secret, PAGE_KEY_2, "and still in use");
  assert.equal((await adm("DELETE", `/compute/keys/${addedKey.id}`)).status, 204);
  assert.ok(!(await json(adm("GET", "/compute/keys"))).credentials.some((c: any) => c.id === addedKey.id), "key deleted");
  assert.ok(!(await json(adm("GET", "/compute/keys"))).providers.find((p: any) => p.slug === "anthropic").has_key, "the type has no key after the delete");
  assert.equal((await adm("DELETE", `/compute/keys/${addedKey.id}`)).status, 404, "deleting it again: not found");
  console.log("✓ key vault: one key per type (a second replaces the first in place), hints only, no enable/disable (410), delete");
}
