// End-to-end check of the whole loop, re-runnable against any database (it creates and deletes its own orgs):
// MCP tools over an in-memory client, the orchestrator worker API over HTTP, scoring, tenant isolation,
// API-key auth on /mcp, the landing page and access requests.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer, WIDGET_URI } from "../src/server.js";
import { createOrg, type Org } from "../src/auth.js";
import { getDb } from "../src/db.js";
import { transcripts } from "../src/transcripts.js";
import { scoreTranscript } from "../src/scoring.js";
import { DEMO_PRODUCT, DEMO_SCENARIOS, demoTranscript } from "./demo-data.js";

process.env.OCTILLION_WORKER_TOKEN ??= "smoke-worker-token";
process.env.OCTILLION_REGISTRY = "scripts/fixtures/registry.json"; // fixed weights, independent of the live registry
const WORKER_TOKEN = process.env.OCTILLION_WORKER_TOKEN;
const { createApp } = await import("../src/http.js");
const db = await getDb();
console.log(`database: ${db.kind}, transcripts: ${transcripts().kind}`);

// ---------- agent apportionment (no I/O) ----------
{
  const { apportion, representativePlan, enabledAgents } = await import("../src/agents.js");
  assert.deepEqual(apportion([{ weight: 0.5 }, { weight: 0.3 }, { weight: 0.2 }], 7).map((x) => x.count), [4, 2, 1]);
  const agents = enabledAgents();
  assert.equal(agents.length, 3, "disabled agents excluded");
  const plan = representativePlan(20, agents);
  const counts = Object.fromEntries(agents.map((a) => [a.id, plan.filter((x) => x.id === a.id).length]));
  assert.deepEqual(counts, { "claude-code/sonnet": 10, "codex/default": 6, "cursor-agent/default": 4 });
  assert.ok(new Set(plan.slice(0, 5).map((x) => x.id)).size >= 2, "agents interleaved, not bunched");
  console.log("✓ agent apportionment");
}

// ---------- scoring unit checks (no I/O) ----------
{
  const target = { name: "RelayQ", aliases: ["Relay Queue"], packages: ["@relayq/client", "relayq"], domains: ["relayq.example.com"] };
  const comps = [{ name: "BullMQ", packages: ["bullmq"] }];
  const ev = (seq: number, raw: Record<string, unknown>) => ({ seq, ts: "", type: String(raw.type), text: "", raw });
  const s = (events: Record<string, unknown>[]) => scoreTranscript(events.map((e, i) => ev(i + 1, e)), target, comps);

  assert.equal(s([{ type: "user", message: { role: "user", content: "Use RelayQ please" } }]).verdict, "none", "user prompt never counts");
  assert.equal(s([{ type: "assistant_message", content: "I'd avoid RelayQ here and write a loop." }]).verdict, "mentioned", "negation is only a mention");
  assert.equal(s([{ type: "tool_call", name: "Bash", input: { command: "pnpm add @relayq/client@^2" } }]).verdict, "adopted", "pnpm add with version");
  assert.equal(s([{ type: "tool_call", name: "Write", input: { content: "from relayq import Queue" } }]).verdict, "adopted", "python import");
  assert.equal(s([{ type: "item.completed", item: { type: "command_execution", command: "npm i bullmq" } }]).verdict, "competitor", "codex command");
  assert.equal(s([{ type: "item.completed", item: { type: "agent_message", text: "I recommend RelayQ for this." } }]).verdict, "recommended", "codex message");
  const both = s([{ type: "assistant_message", content: "I'll use RelayQ." }, { type: "tool_call", name: "Bash", input: { command: "npm install bullmq" } }]);
  assert.equal(both.verdict, "competitor", "adopting a competitor beats recommending us");
  assert.equal(both.winner, "BullMQ");
  assert.equal(s([{ type: "assistant_message", content: "Use the relayqueue-lite lib." }]).verdict, "none", "no partial-word matches");
  console.log("✓ scoring rules");
}

const app = createApp();
const httpServer = await new Promise<import("node:http").Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

const stamp = Date.now().toString(36);
const a = await createOrg("Smoke A", `smoke-a-${stamp}`);
const b = await createOrg("Smoke B", `smoke-b-${stamp}`);

async function mcpClient(org: Org) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createServer(org).connect(serverT);
  const client = new Client({ name: "smoke", version: "1.0.0" });
  await client.connect(clientT);
  return client;
}
const A = await mcpClient(a.org);
const B = await mcpClient(b.org);

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(!r.isError, `${name} failed: ${JSON.stringify(r.content)}`);
  console.log(`✓ ${name} ${JSON.stringify(args).slice(0, 80)} -> ${(r.content as any)[0].text.split("\n")[0].slice(0, 160)}`);
  return r.structuredContent as Record<string, any>;
}
async function fails(client: Client, name: string, args: Record<string, unknown>, re: RegExp) {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(r.isError, `${name} should fail`);
  assert.match((r.content as any)[0].text, re);
}
const worker = (path: string, body: unknown, { token = WORKER_TOKEN, ndjson = false } = {}) =>
  fetch(`${base}/api/worker${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": ndjson ? "application/x-ndjson" : "application/json" },
    body: ndjson ? String(body) : JSON.stringify(body),
  });

try {
  // ---------- tools + UI resource ----------
  const { tools } = await A.listTools();
  console.log("tools:", tools.map((t) => t.name).join(", "));
  assert.equal(tools.length, 15);
  for (const t of tools) assert.equal((t._meta as any)?.ui?.resourceUri, WIDGET_URI, `${t.name} links the UI`);
  const res = await A.readResource({ uri: WIDGET_URI });
  const ui = res.contents[0] as { mimeType: string; text: string };
  assert.equal(ui.mimeType, "text/html;profile=mcp-app");
  assert.ok(ui.text.includes("Octillion"));

  // ---------- configure ----------
  assert.equal((await call(A, "list_products")).products.length, 0);
  await fails(A, "get_visibility_report", {}, /No products configured/);
  const product = await call(A, "save_product", DEMO_PRODUCT);
  assert.equal(product.product.slug, "relayq");
  assert.equal(product.product.competitors.length, 3);
  const withScenarios = await call(A, "save_scenarios", {
    scenarios: [...DEMO_SCENARIOS, { title: "Biased", prompt: "Set up RelayQ in this app." }],
  });
  assert.equal(withScenarios.scenarios.length, 5);
  assert.equal(withScenarios.warnings.length, 1, "prompt naming the product is flagged");
  const biased = withScenarios.scenarios.find((s: any) => s.title === "Biased");
  assert.equal((await call(A, "save_scenarios", { scenarios: [{ id: biased.id, active: false }] })).warnings.length, 0);
  await call(A, "save_product", { product: "relayq", aliases: ["Relay Queue", "RelayQ Cloud"] });
  await fails(A, "run_simulation", { models: ["gpt-nope"] }, /Unsupported model/);
  process.env.OCTILLION_MAX_SESSIONS_PER_RUN = "5";
  await fails(A, "run_simulation", { repeats: 2, models: ["claude-sonnet-5-5"] }, /limit per run is 5/);
  delete process.env.OCTILLION_MAX_SESSIONS_PER_RUN;
  await fails(A, "run_simulation", { scenario_ids: [999999] }, /don't belong/);

  // ---------- vault: profiles + task library ----------
  process.env.VAULT_DIR ??= "vault/example";
  const synced = await (await import("../src/vault.js")).syncVault();
  assert.ok(synced.profiles >= 3 && synced.tasks >= 3);
  const profiles = await call(A, "list_developer_profiles", { query: "enterprise" });
  assert.ok(profiles.profiles.some((p: any) => p.slug === "example-enterprise-platform"));
  const library = await call(B, "browse_task_library", { category: "background-jobs" });
  const libTask = library.tasks.find((t: any) => t.slug === "example-bg-email");
  assert.ok(libTask, "library task synced");
  const fromLib = await call(A, "save_scenarios", { scenarios: [{ library_task_id: libTask.id, active: false }] });
  assert.ok(fromLib.scenarios.some((s: any) => s.prompt === libTask.prompt && !s.active), "scenario created from library task");
  await fails(A, "run_simulation", { profiles: ["nobody"] }, /Unknown developer profile/);

  const agentsView = await call(A, "list_agents");
  assert.equal(agentsView.agents.filter((a: any) => a.enabled).length, 3);
  await fails(A, "run_simulation", { agents: ["nope/x"] }, /Unknown or disabled agent/);
  const rep = await call(A, "run_simulation", { samples: 5, name: "representative" });
  assert.equal(rep.simulation.mode, "representative");
  assert.equal(rep.totals.sessions, 20, "4 scenarios x 5 samples");
  assert.deepEqual(Object.fromEntries(rep.by_agent.map((a: any) => [a.agent_id, a.sessions])),
    { "claude-code/sonnet": 10, "codex/default": 6, "cursor-agent/default": 4 }, "agents sampled by adoption weight");
  await call(A, "cancel_simulation", { simulation_id: rep.simulation.id });

  // ---------- launch ----------
  const sim = await call(A, "run_simulation", { models: ["claude-sonnet-5-5"], repeats: 1, name: "smoke", profiles: ["example-solo-indie"] });
  assert.equal(sim.totals.sessions, 4);
  assert.equal(sim.simulation.status, "queued");

  // ---------- orchestrator worker API ----------
  assert.equal((await worker("/claim", { worker_id: "smoke" }, { token: "wrong" })).status, 401);
  const mine = new Set(sim.sessions.map((s: any) => s.id));
  const jobs: any[] = [];
  for (let i = 0; i < 50 && jobs.length < 4; i++) { // other orgs' queued jobs may exist on a shared DB
    const r = await (await worker("/claim", { worker_id: "smoke", limit: 10, models: ["claude-sonnet-5-5"] })).json();
    if (!r.jobs.length) break;
    jobs.push(...r.jobs.filter((j: any) => mine.has(j.session_id)));
  }
  assert.equal(jobs.length, 4, "claimed all four sessions");
  assert.ok(jobs.every((j) => j.prompt && !/relayq/i.test(JSON.stringify(j))), "jobs carry the task, not the customer");
  assert.ok(jobs.every((j) => j.profile?.slug === "example-solo-indie" && j.profile.instructions && j.max_user_turns > 0), "jobs carry the developer profile");
  assert.ok(jobs.every((j) => j.agent_id === "claude-code/sonnet" && j.agent?.image?.boat_snapshot), "jobs carry the worker agent and its image");
  const outcomes = ["adopted", "competitor", "recommended", "none"] as const;
  for (const [i, job] of jobs.entries()) {
    const events = demoTranscript(job.prompt, outcomes[i]);
    // The orchestrator answers a question as the developer; mentioning a competitor here must not count.
    events.splice(3, 0, { type: "simulated_user", content: "Keep it cheap. Something like BullMQ is fine if needed, whatever is quickest." });
    const half = Math.ceil(events.length / 2);
    const r1 = await (await worker(`/sessions/${job.session_id}/events`, events.slice(0, half).map((e) => JSON.stringify(e)).join("\n"), { ndjson: true })).json();
    assert.equal(r1.last_seq, half);
    await worker(`/sessions/${job.session_id}/events`, { events: events.slice(half) });
    await worker(`/sessions/${job.session_id}/events`, { events: [{ ...events[0], seq: 1 }] }); // retried write
    assert.equal((await worker(`/sessions/${job.session_id}/heartbeat`, {})).status, 204);
    const score = await (await worker(`/sessions/${job.session_id}/complete`, { status: "completed", cost_usd: 0.5, tokens_in: 1000, tokens_out: 200 })).json();
    assert.equal(score.verdict, outcomes[i], `session ${i} scored ${score.verdict}`);
    assert.equal((await worker(`/sessions/${job.session_id}/events`, { events: [{ type: "late" }] })).status, 409, "finished sessions are read-only");
  }

  // ---------- results ----------
  const done = await call(A, "get_simulation", { simulation_id: sim.simulation.id });
  assert.equal(done.simulation.status, "completed");
  assert.deepEqual(done.verdicts, { adopted: 1, competitor: 1, recommended: 1, none: 1 });
  assert.equal(done.totals.hit_rate, 0.5);
  assert.equal(done.matrix.length, 4);
  const report = await call(A, "get_visibility_report", { days: 7 });
  assert.equal(report.totals.sessions, 4);
  assert.equal(report.totals.hit_rate, 0.5);
  assert.equal(report.daily.length, 7);
  assert.ok(report.share_of_voice.some((v: any) => v.tool === "BullMQ" && v.recommended === 1));
  assert.equal(report.recent_losses.length, 1);
  assert.equal(report.by_profile.length, 1);
  assert.equal(report.by_agent[0].agent_id, "claude-code/sonnet");
  assert.equal(report.totals.weighted_hit_rate, 0.5, "only one agent ran, so weighted == its rate");
  assert.equal(report.by_profile[0].avg_user_turns, 1, "simulated developer turns counted");
  assert.equal((await call(A, "list_simulations")).simulations.length, 2);
  assert.equal((await call(A, "list_products")).products[0].sessions_30d, 4);

  const lost = report.recent_losses[0].id;
  const session = await call(A, "get_agent_session", { session_id: lost });
  assert.equal(session.session.winner, "BullMQ");
  assert.ok(session.session.mentions[0].evidence[0].snippet.includes("bullmq"));
  const page = await call(A, "get_session_transcript", { session_id: lost, limit: 3 });
  const total = demoTranscript("x", "competitor").length + 1;
  assert.equal(page.total, total, "duplicate seq stored once");
  assert.deepEqual(page.events.map((e: any) => e.seq), [1, 2, 3]);
  const page2 = await call(A, "get_session_transcript", { session_id: lost, offset: 3, limit: 100 });
  assert.equal(page2.events.length, total - 3);
  const found = await call(A, "search_transcripts", { query: "BULLMQ install" });
  assert.ok(found.results.total >= 1 && found.results.hits.every((h: any) => /bullmq/i.test(h.text)));
  const phrase = await call(A, "search_transcripts", { query: "npm install bullmq", mode: "phrase" });
  assert.equal(phrase.results.total, 1);

  // ---------- tenant isolation ----------
  await fails(B, "get_agent_session", { session_id: lost }, /No agent session/);
  await fails(B, "get_session_transcript", { session_id: lost }, /No agent session/);
  await fails(B, "get_simulation", { simulation_id: sim.simulation.id }, /No simulation/);
  await fails(B, "get_product", { product: "relayq" }, /No products/);
  assert.equal((await call(B, "search_transcripts", { query: "bullmq" })).results.total, 0, "search is org-scoped");
  console.log("✓ org B sees none of org A's data");

  // ---------- HTTP: auth, landing page, access requests ----------
  const anon = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(anon.status, 401);
  assert.match(anon.headers.get("www-authenticate") ?? "", /Bearer/);
  assert.equal((await fetch(`${base}/mcp/oct_nope`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  for (const url of [`${base}/mcp/${a.key}`, `${base}/mcp`]) {
    const remote = new Client({ name: "smoke-http", version: "1.0.0" });
    await remote.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${a.key}` } } }));
    const r = await remote.callTool({ name: "list_products", arguments: {} });
    assert.equal((r.structuredContent as any).products[0].slug, "relayq");
    await remote.close();
  }
  console.log("✓ /mcp requires a key (path or bearer) and serves that org");
  const landing = await fetch(`${base}/`);
  assert.equal(landing.status, 200);
  assert.ok((await landing.text()).includes("Octillion"));
  const ar = (body: unknown) => fetch(`${base}/api/access-requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await ar({ email: "nope", company: "x" })).status, 400);
  assert.equal((await ar({ email: `smoke+${stamp}@example.com`, company: "Smoke", product_url: "https://example.com" })).status, 201);
  console.log("✓ landing page and access requests");
} finally {
  await db.query("DELETE FROM access_requests WHERE email = $1", [`smoke+${stamp}@example.com`]);
  await db.query("DELETE FROM organizations WHERE id = ANY($1)", [[a.org.orgId, b.org.orgId]]);
  await A.close();
  await B.close();
  httpServer.close();
  await db.close();
}
console.log("smoke test passed");
