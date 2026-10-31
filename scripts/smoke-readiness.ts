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

/** Key vault, one row per key and one type per key (src/keyvault.ts, migration 0012): a key goes in once and only its
 *  hint comes back; two keys of one type are two rows, used in turn (least recently used first); replace changes only
 *  its own row; the same secret twice for a type is refused; the unsubscribe key stays a singleton that nothing
 *  replaces; no enable/disable anywhere (410); delete. */
export async function vaultRowPerKeyChecks({ db, adm, json, base, ADMIN_TOKEN, stamp }: { db: Db; adm: (method: string, path: string, body?: unknown) => Promise<Response>;
  json: (r: Response | Promise<Response>) => Promise<any>; base: string; ADMIN_TOKEN: string; stamp: string }) {
  const kv = await import("../src/keyvault.js");
  const PAGE_KEY = `sk-ant-smoke-page-${stamp}-SECRETTAIL`;
  const addedKey = await json(adm("POST", "/compute/keys", { provider: "anthropic", secret: PAGE_KEY }));
  assert.ok(addedKey.id && addedKey.hint && addedKey.name && !JSON.stringify(addedKey).includes(PAGE_KEY), "the add response has the hint and a name, not the key");
  assert.ok(!("priority" in addedKey) && !("enabled" in addedKey) && !("replaced" in addedKey), "no priority, enabled or replaced in the API");
  const keysView = await (await adm("GET", "/compute/keys")).text();
  assert.ok(!keysView.includes(PAGE_KEY) && !keysView.includes("ciphertext") && !keysView.includes("secret_digest"), "the key list never carries a secret or its digest");
  const kj = JSON.parse(keysView);
  const listedKey = kj.credentials.find((c: any) => c.id === addedKey.id);
  assert.ok(listedKey && listedKey.hint === addedKey.hint && listedKey.name === addedKey.name && listedKey.type_name === "Anthropic" && !("enabled" in listedKey), "the new key is listed by name, type and hint");
  assert.ok(kj.providers.find((p: any) => p.slug === "anthropic").has_key, "the provider has a key");
  assert.ok(kj.providers.every((p: any) => !("enabled" in p)), "providers have no on/off");

  // Two keys of one type: two rows, both used in rotation (least recently used first).
  const PAGE_KEY_2 = `sk-ant-smoke-page-${stamp}-SECONDKEY`;
  const second = await json(adm("POST", "/compute/keys", { provider: "anthropic", secret: PAGE_KEY_2, name: `Team B ${stamp}` }));
  assert.ok(second.id && second.id !== addedKey.id && second.name === `Team B ${stamp}`, "adding a second key of the type creates a new row, with the name given");
  const anthRows = await db.query<any>("SELECT id, hint, rotated_at FROM vault_credentials WHERE provider = 'anthropic' ORDER BY id");
  assert.ok(anthRows.some((r: any) => r.id === addedKey.id) && anthRows.some((r: any) => r.id === second.id) && anthRows.every((r: any) => !r.rotated_at), "both rows are there, neither replaced");
  const listed = (await json(adm("GET", "/compute/keys"))).credentials.filter((c: any) => c.provider === "anthropic");
  assert.equal(listed.length, anthRows.length, "the page lists every Anthropic key as its own row");
  const used = new Map<number, string>();
  for (let i = 0; i < anthRows.length; i++) { const c = await kv.useCredential("anthropic"); used.set(c.id, c.secret); }
  assert.ok(used.size === anthRows.length && used.get(addedKey.id) === PAGE_KEY && used.get(second.id) === PAGE_KEY_2, "each key of the type is used in turn");
  const useCounts = await db.query<any>("SELECT id, uses FROM vault_credentials WHERE id = ANY($1) ORDER BY id", [[addedKey.id, second.id]]);
  assert.ok(useCounts.every((r: any) => Number(r.uses) === 1), `one use each (${JSON.stringify(useCounts)})`);

  // Replace changes only that row.
  const PAGE_KEY_3 = `sk-ant-smoke-page-${stamp}-ROTATED3`;
  const replaced = await json(adm("POST", `/compute/keys/${addedKey.id}/replace`, { secret: PAGE_KEY_3 }));
  assert.ok(replaced.id === addedKey.id && replaced.hint !== addedKey.hint && replaced.name === addedKey.name, "replace keeps the row and its name");
  const after = await db.query<any>("SELECT id, hint, rotated_at FROM vault_credentials WHERE id = ANY($1) ORDER BY id", [[addedKey.id, second.id]]);
  const r1 = after.find((r: any) => r.id === addedKey.id), r2 = after.find((r: any) => r.id === second.id);
  assert.ok(r1.rotated_at && r1.hint === replaced.hint, "the replaced row is rotated");
  assert.ok(!r2.rotated_at && r2.hint === second.hint, "the other key of the type is untouched");
  assert.equal((await db.query<any>("SELECT count(*)::int AS n FROM vault_credentials WHERE provider = 'anthropic'"))[0].n, anthRows.length, "no row added by a replace");
  const viaVault = await (await fetch(`${base}/api/admin/keyvault/credentials/${second.id}`, { method: "PUT", headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ secret: `sk-ant-smoke-page-${stamp}-VIAPUT` }) })).json();
  assert.ok(viaVault.id === second.id, "the vault API replaces with PUT /keyvault/credentials/:id");

  // The same secret twice for a type is refused, whether added or put on another row.
  const dupe = await adm("POST", "/compute/keys", { provider: "anthropic", secret: PAGE_KEY_3 });
  assert.equal(dupe.status, 409, "adding a key already in the vault is refused");
  assert.match((await dupe.json()).error, /already in the vault/);
  assert.equal((await adm("POST", `/compute/keys/${second.id}/replace`, { secret: PAGE_KEY_3 })).status, 409, "replacing with another row's key is refused");
  assert.equal((await adm("POST", "/compute/keys", { provider: "anthropic", secret: `  ${PAGE_KEY_3}\n` })).status, 409, "surrounding whitespace does not make it a new key");
  // A row from before migration 0012 has no digest: the check decrypts it, refuses the duplicate and fills the digest.
  await db.query("UPDATE vault_credentials SET secret_digest = NULL WHERE id = $1", [addedKey.id]);
  assert.equal((await adm("POST", "/compute/keys", { provider: "anthropic", secret: PAGE_KEY_3 })).status, 409, "a duplicate of a key without a digest is refused too");
  assert.ok((await db.query<any>("SELECT secret_digest FROM vault_credentials WHERE id = $1", [addedKey.id]))[0].secret_digest, "and its digest is filled");
  await assert.rejects(db.query("INSERT INTO vault_credentials (provider, ciphertext, iv, tag, key_id, hint, secret_digest) SELECT provider, 'x', 'x', 'x', 'x', 'x', secret_digest FROM vault_credentials WHERE id = $1", [addedKey.id]),
    /unique|duplicate/i, "the database refuses a second row with the same digest for a type");
  assert.equal((await adm("POST", "/compute/keys", { provider: "cursor", secret: "cursor-secret-123456" })).status, 400, "direct-mode keys still refused");
  assert.equal((await adm("POST", "/compute/keys", { provider: "anthropic", secret: "" })).status, 400);

  // The unsubscribe signing key is a singleton nothing replaces (every link already sent is signed with it).
  const unsubRows = async () => (await db.query<any>("SELECT id, hint FROM vault_credentials WHERE provider = 'email_unsubscribe'")).map((r: any) => `${r.id}:${r.hint}`).join();
  await (await import("../src/campaigns.js")).unsubscribeKey(); // generated on first need (a no-op when it exists)
  const unsubBefore = await unsubRows();
  assert.equal(unsubBefore.split(",").filter(Boolean).length, 1, "exactly one unsubscribe key (generated)");
  const unsubPost = await adm("POST", "/compute/keys", { provider: "email_unsubscribe", secret: `unsub-${stamp}-replacement` });
  assert.equal(unsubPost.status, 400, "the API refuses to add an unsubscribe signing key");
  assert.match((await unsubPost.json()).error, /cannot be replaced/);
  const unsubId = Number(unsubBefore.split(":")[0]);
  assert.equal((await adm("POST", `/compute/keys/${unsubId}/replace`, { secret: `unsub-${stamp}-replacement` })).status, 400, "nor replace it");
  await assert.rejects(kv.addCredential("email_unsubscribe", `unsub-${stamp}-replacement`), /cannot be replaced/, "addCredential refuses it too");
  await assert.rejects(kv.replaceCredential(unsubId, `unsub-${stamp}-replacement`), /cannot be replaced/, "replaceCredential refuses it too");
  assert.equal(await kv.addCredentialIfAbsent("email_unsubscribe", `unsub-${stamp}-generated-again`), null, "the generator never adds a second");
  await assert.rejects(db.query("INSERT INTO vault_credentials (provider, ciphertext, iv, tag, key_id, hint) VALUES ('email_unsubscribe', 'x', 'x', 'x', 'x', 'x')"), /unique|duplicate/i,
    "the database holds at most one unsubscribe key");
  assert.equal(await unsubRows(), unsubBefore, "the unsubscribe key is untouched");

  // No enable/disable anywhere: the old routes are gone (410) and change nothing.
  assert.equal((await adm("POST", `/compute/keys/${addedKey.id}/enabled`, { enabled: false })).status, 410, "no key disable");
  assert.equal((await adm("POST", "/compute/providers/anthropic/enabled", { enabled: false })).status, 410, "no provider toggle");
  assert.equal((await fetch(`${base}/api/admin/keyvault/credentials/${addedKey.id}`, { method: "PATCH", headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) })).status, 410, "no vault API disable");
  await kv.upsertProvider({ slug: "anthropic", enabled: false } as any); // an old caller's enabled is ignored
  assert.ok((await json(adm("GET", "/compute/keys"))).credentials.some((c: any) => c.id === addedKey.id), "the key is still there");
  assert.ok((await db.query<any>("SELECT enabled FROM vault_providers WHERE slug = 'anthropic'"))[0].enabled, "the provider stays on");

  // Delete: one row goes, the type's other key stays and is the one used.
  assert.equal((await adm("DELETE", `/compute/keys/${addedKey.id}`)).status, 204);
  const left = (await json(adm("GET", "/compute/keys")));
  assert.ok(!left.credentials.some((c: any) => c.id === addedKey.id) && left.credentials.some((c: any) => c.id === second.id), "only that key is deleted");
  assert.equal((await adm("DELETE", `/compute/keys/${addedKey.id}`)).status, 404, "deleting it again: not found");
  assert.equal((await adm("POST", `/compute/keys/${addedKey.id}/replace`, { secret: `sk-ant-smoke-page-${stamp}-GONE` })).status, 404, "a deleted key cannot be replaced");
  assert.equal((await adm("DELETE", `/compute/keys/${second.id}`)).status, 204);
  // An unreadable row (master key not loaded, or damaged) is skipped by the webhook check and the digest backfill, never
  // failing them for the type's other keys.
  const [bad] = await db.query<any>("INSERT INTO vault_credentials (provider, ciphertext, iv, tag, key_id, hint) VALUES ('resend_webhook', 'AAAA', 'AAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAAAAAAAA==', 'nosuchkey000', 'broken') RETURNING id");
  const WH = `whsec_smoke_${stamp}_readable`;
  const good = await kv.addCredential("resend_webhook", WH);
  const secrets = await kv.credentialSecrets("resend_webhook");
  assert.ok(secrets.some((c) => c.id === good.id && c.secret === WH) && !secrets.some((c) => c.id === bad.id), "credentialSecrets skips the unreadable row and keeps the others");
  const bf = await kv.backfillDigests();
  assert.ok(bf.skipped.some((x) => x.id === bad.id && x.provider === "resend_webhook"), "backfillDigests reports the unreadable row instead of stopping");
  await db.query("DELETE FROM vault_credentials WHERE id = ANY($1)", [[bad.id, good.id]]);
  console.log("✓ key vault: one row per key (two of a type used in turn), replace on its own row, duplicates refused (409), unsubscribe key a singleton, no enable/disable (410), delete");
}
