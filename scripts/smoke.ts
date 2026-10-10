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
process.env.OCTILLION_VAULT_KEY ??= (await import("node:crypto")).randomBytes(32).toString("base64");
process.env.OCTILLION_ADMIN_TOKEN ??= "smoke-admin-token";
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

// ---------- global pod fleet (no I/O) ----------
{
  const { planPods, assign } = await import("../src/fleet.js");
  const share = (agent_id: string, weight: number) => ({ agent_id, harness: agent_id.split("/")[0], model: agent_id.split("/")[1], weight });
  const shares = [share("claude-code/opus", 0.4), share("cursor/auto", 0.25), share("codex/default", 0.2), share("copilot/auto", 0.1), share("aider/x", 0.05)];
  const plan = planPods(200, shares); // 10 orchestrators x 20 pods
  assert.equal(plan.reduce((s, p) => s + p.pods, 0), 200);
  assert.equal(plan[0].pods, 80, "Claude Code at 40% gets 80 of 200 pods");
  const orchs = Array.from({ length: 10 }, (_, i) => ({ id: `orch-${String(i).padStart(2, "0")}`, capacity: 20 }));
  const dealt = assign(plan, orchs);
  for (const [, m] of dealt) {
    assert.equal([...m.values()].reduce((s, n) => s + n, 0), 20, "each orchestrator filled to 20");
    assert.equal(m.get("claude-code/opus"), 8, "each orchestrator carries ~40% Claude Code · Opus");
  }
  assert.equal(planPods(10, shares)[0].pods, 4, "10 pods -> 4 Claude Code");
  // Same harness, two popular models -> two pod groups, each sized by its own share.
  const split = planPods(20, [share("claude-code/opus", 0.3), share("claude-code/sonnet", 0.1), share("codex/default", 0.6)]);
  assert.deepEqual(Object.fromEntries(split.map((p) => [p.agent_id, p.pods])), { "codex/default": 12, "claude-code/opus": 6, "claude-code/sonnet": 2 });
  console.log("✓ fleet: 10 orchestrators x 20 = 200 pods in usage proportion; per-model pod groups");
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
  // Native formats of the other harnesses (see orchestrator/harnesses/fixtures for full captured streams).
  assert.equal(s([{ type: "assistant.message", data: { content: "", toolRequests: [{ name: "bash", arguments: { command: "npm install bullmq" } }] } }]).verdict, "competitor", "copilot toolRequests");
  assert.equal(s([{ type: "assistant.message", data: { content: "I recommend RelayQ.", toolRequests: [] } }]).verdict, "recommended", "copilot message");
  assert.equal(s([{ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "npm i @relayq/client" } }] } }]).verdict, "adopted", "pi toolCall block");
  assert.equal(s([{ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "I'll use RelayQ." }] } }]).verdict, "none", "pi turn_end repeats message_end");
  assert.equal(s([{ type: "agent_event", event: { type: "content_start", contentType: "tool", toolName: "run_commands", input: { commands: ["npm install relayq"] } } }]).verdict, "adopted", "cline tool");
  assert.equal(s([{ type: "agent_event", event: { type: "content_end", contentType: "text", text: "I recommend RelayQ." } }]).verdict, "recommended", "cline text");
  assert.equal(s([{ event: "step_update", step_update: { step_type: "tool", state: "DONE", tool_info: { name: "run_command", parameters: { CommandLine: "npm install relayq" } } } }]).verdict, "adopted", "antigravity tool step");
  assert.equal(s([{ event: "step_update", step_update: { step_type: "agent_response", state: "DONE", text_delta: "I'll use RelayQ." } }]).verdict, "recommended", "antigravity response");
  assert.equal(s([{ type: "tool_call", toolName: "Execute", parameters: { command: "npm install relayq" } }]).verdict, "adopted", "droid tool_call");
  assert.equal(s([{ type: "message", role: "assistant", text: "I recommend RelayQ." }]).verdict, "recommended", "droid message text");
  console.log("✓ scoring rules");
}

// ---------- harness adapters: argv + replay of captured native streams (no I/O beyond fixture files) ----------
{
  const { readFileSync, existsSync } = await import("node:fs");
  const { getAdapter, supportedHarnesses } = await import("../orchestrator/harnesses/adapters.js");
  const o = { model: "M", workdir: "/home/agent/work" };
  const wrap = (pre: string, ...argv: string[]) => ["bash", "-c", `${pre}exec "$@" "$(cat)"`, "octi", ...argv];
  const agySetup = `f="$HOME/.gemini/antigravity-cli/settings.json"; [ -s "$f" ] || { mkdir -p "$(dirname "$f")" && printf '%s' '{"modelProvider":"gemini"}' > "$f"; }; `;
  const ampSetup = `f="$HOME/.config/amp/settings.json"; [ -s "$f" ] || { mkdir -p "$(dirname "$f")" && printf '%s' '{"amp.dangerouslyAllowAll":true}' > "$f"; }; `;
  const argv: Record<string, [string[], string[] | null]> = {
    copilot: [["copilot", "--output-format", "json", "--allow-all-tools", "--no-auto-update", "--model", "M"],
      ["copilot", "--output-format", "json", "--allow-all-tools", "--no-auto-update", "--model", "M", "--resume", "SID"]],
    cursor: [wrap("", "cursor-agent", "-p", "--output-format", "stream-json", "--force", "--trust", "--model", "M", "--"),
      wrap("", "cursor-agent", "-p", "--output-format", "stream-json", "--force", "--trust", "--model", "M", "--resume", "SID", "--")],
    opencode: [["opencode", "run", "--format", "json", "--auto", "-m", "M"], ["opencode", "run", "--format", "json", "--auto", "-m", "M", "-s", "SID"]],
    kilo: [["kilo", "run", "--format", "json", "--auto", "-m", "M"], ["kilo", "run", "--format", "json", "--auto", "-m", "M", "-s", "SID"]],
    "gemini-cli": [["gemini", "-o", "stream-json", "--approval-mode", "yolo", "--skip-trust", "-m", "M"],
      ["gemini", "-o", "stream-json", "--approval-mode", "yolo", "--skip-trust", "-m", "M", "--resume", "SID"]],
    "qwen-code": [["qwen", "-o", "stream-json", "--yolo", "--auth-type", "openai", "-m", "M"],
      ["qwen", "-o", "stream-json", "--yolo", "--auth-type", "openai", "-m", "M", "--resume", "SID"]],
    antigravity: [wrap(agySetup, "agy", "--output-format", "stream-json", "--dangerously-skip-permissions", "--model", "M", "-p"),
      wrap(agySetup, "agy", "--output-format", "stream-json", "--dangerously-skip-permissions", "--model", "M", "--conversation", "SID", "-p")],
    pi: [["pi", "-p", "--mode", "json", "--model", "M"], ["pi", "-p", "--mode", "json", "--model", "M", "--session", "SID"]],
    cline: [["bash", "-c", 'exec "$@" -k "$ANTHROPIC_API_KEY" -- "$(cat)"', "octi", "cline", "--json", "--auto-approve", "true", "-P", "anthropic", "-m", "M"], null],
    amp: [["bash", "-c", `${ampSetup}exec "$@"`, "octi", "amp", "-x", "--stream-json", "--mode", "M"],
      ["bash", "-c", `${ampSetup}exec "$@"`, "octi", "amp", "threads", "continue", "SID", "-x", "--stream-json", "--mode", "M"]],
    droid: [["droid", "exec", "-o", "stream-json", "--skip-permissions-unsafe", "-m", "M"], ["droid", "exec", "-o", "stream-json", "--skip-permissions-unsafe", "-m", "M", "-s", "SID"]],
  };
  // "auto"/"default" = harness default model: no model flag where the CLI has its own default.
  assert.ok(!getAdapter("gemini-cli").launchArgv({ ...o, model: "auto" }).includes("-m"), "gemini auto omits -m");
  assert.ok(!getAdapter("antigravity").launchArgv({ ...o, model: "default" }).includes("--model"), "agy default omits --model");
  assert.ok(!getAdapter("amp").launchArgv({ ...o, model: "default" }).includes("--mode"), "amp default omits --mode");
  assert.equal(getAdapter("cursor-agent").id, "cursor", "alias");
  assert.equal(getAdapter("gemini").id, "gemini-cli", "alias");

  const fx = (f: string) => readFileSync(`orchestrator/harnesses/fixtures/${f}`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const target = { name: "left-pad", packages: ["left-pad"] };
  for (const [h, [launch, resume]] of Object.entries(argv)) {
    const a = getAdapter(h);
    assert.deepEqual(a.launchArgv(o), launch, `${h} launch argv`);
    if (resume) assert.deepEqual(a.resumeArgv({ ...o, sessionId: "SID" }), resume, `${h} resume argv`);
    else assert.throws(() => a.resumeArgv({ ...o, sessionId: "SID" }), `${h} resume unsupported`);
    assert.equal(a.canResume, !!resume, `${h} canResume`);

    const events = fx(`${h}.jsonl`);
    const dg = a.newDigest();
    for (const ev of events) dg.observe(ev);
    const d = dg.result();
    assert.equal(d.lastText, "Installed left-pad with npm. Done.", `${h} digest last text`);
    assert.ok(d.commands.includes("npm install left-pad --no-audit --no-fund"), `${h} digest command: ${JSON.stringify(d.commands)}`);
    assert.equal(d.error, null, `${h} digest error`);
    if (a.canResume) assert.ok(d.sessionId, `${h} session id`); else assert.equal(d.sessionId, null, `${h} no session id`);
    const score = scoreTranscript(events.map((raw, i) => ({ seq: i + 1, ts: "", type: String(raw.type ?? raw.event), text: "", raw })), target, []);
    assert.equal(score.verdict, "adopted", `${h} scored adopted`);
    assert.equal(score.mentions[0]?.evidence[0]?.kind, "action", `${h} adoption comes from the agent's command`);
    if (existsSync(`orchestrator/harnesses/fixtures/${h}.resume.jsonl`)) {
      const rd = a.newDigest();
      for (const ev of fx(`${h}.resume.jsonl`)) rd.observe(ev);
      assert.equal(rd.result().sessionId, d.sessionId, `${h} resume continues the same session`);
      assert.ok(rd.result().lastText, `${h} resume has a reply`);
    }
  }
  assert.deepEqual(supportedHarnesses().sort(), ["claude-code", "codex", ...Object.keys(argv)].sort(), "every adapter covered");
  console.log(`✓ harness adapters (${Object.keys(argv).length} replayed from fixtures)`);
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
  const shareSum = agentsView.agents.filter((a: any) => a.enabled).reduce((s: number, a: any) => s + a.weight, 0);
  assert.ok(Math.abs(shareSum - 1) < 1e-9, "running agents' usage shares are renormalised to 100%");
  assert.equal(agentsView.sandbox_unit, 20);
  assert.ok(agentsView.agents.every((a: any) => Number.isInteger(a.sandboxes) && Math.abs(a.weight * 20 - a.sandboxes) < 1e-9), "shares are whole sandboxes out of 20");
  assert.equal(agentsView.agents.reduce((s: number, a: any) => s + a.sandboxes, 0), 20);
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
  // ---------- key vault + inference gateway ----------
  const kv = await import("../src/keyvault.js");
  const http = await import("node:http");
  const REAL_LLM_KEY = `sk-smoke-real-${stamp}-llm`, REAL_VENDOR_KEY = `vendor-real-${stamp}-token`;
  const seen: { auth?: string; path?: string; body?: string }[] = [];
  const upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ auth: String(req.headers["x-api-key"] ?? ""), path: req.url, body });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":120,"output_tokens":1}}}\n\n`);
      res.write(`event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n`);
      res.end(`event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":30}}\n\n`);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  process.env.PUBLIC_URL = base;
  await kv.upsertProvider({ slug: "smoke_llm", mode: "gateway", upstream_url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
                            auth_header: "x-api-key", auth_prefix: "", env_vars: ["SMOKE_LLM_API_KEY"] });
  await kv.upsertProvider({ slug: "smoke_vendor", mode: "direct", env_vars: ["SMOKE_VENDOR_TOKEN"] });
  await kv.setCredential("smoke_llm", REAL_LLM_KEY);
  await kv.setCredential("smoke_vendor", REAL_VENDOR_KEY);
  const [stored] = await db.query<{ ciphertext: string; hint: string }>("SELECT ciphertext, hint FROM vault_credentials WHERE provider = 'smoke_llm'");
  assert.ok(!stored.ciphertext.includes("smoke-real") && !Buffer.from(stored.ciphertext, "base64").toString().includes("smoke-real"), "stored encrypted");

  const creds = await (await worker(`/sessions/${jobs[0].session_id}/credentials`, {})).json();
  const gw = creds.providers.smoke_llm;
  assert.equal(gw.mode, "gateway");
  assert.ok(gw.api_key.startsWith("ogw_") && gw.base_url === `${base}/gw/smoke_llm`, "gateway providers get a scoped token + base URL");
  assert.equal(creds.providers.smoke_vendor.api_key, REAL_VENDOR_KEY, "direct providers get the real key for this session");
  assert.equal(creds.env.SMOKE_VENDOR_TOKEN, REAL_VENDOR_KEY);
  assert.ok(!JSON.stringify(creds).includes(REAL_LLM_KEY), "the gateway provider's real key never leaves the server");
  const llm = (headers: Record<string, string>, path = "/gw/smoke_llm/v1/messages") =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ model: "m", stream: true }) });
  const streamed = await llm({ "x-api-key": gw.api_key });
  assert.equal(streamed.status, 200);
  assert.ok((await streamed.text()).includes('"output_tokens":30'), "SSE streamed through");
  assert.equal(seen.at(-1)?.auth, REAL_LLM_KEY, "upstream received the real key");
  assert.equal(seen.at(-1)?.path, "/v1/messages");
  assert.ok((await llm({ authorization: `Bearer ${gw.api_key}` })).ok, "bearer form accepted");
  assert.equal((await llm({ "x-api-key": "ogw_forged" })).status, 401);
  assert.equal((await llm({ "x-api-key": REAL_LLM_KEY })).status, 401, "raw provider keys are not accepted by the gateway");
  assert.equal((await llm({ "x-api-key": gw.api_key }, "/gw/smoke_vendor/x")).status, 403, "token is scoped to its providers");
  const orch = await (await worker("/orchestrator/credentials", { orchestrator_id: "smoke-orch" })).json();
  assert.ok(orch.llm?.api_key.startsWith("ogw_") && orch.llm.base_url.endsWith("/gw/anthropic"), "orchestrator LLM goes through the gateway");
  assert.equal((await fetch(`${base}/api/admin/keyvault/credentials`)).status, 401);
  const listed = await (await fetch(`${base}/api/admin/keyvault/credentials`, { headers: { authorization: "Bearer smoke-admin-token" } })).text();
  assert.ok(listed.includes(stored.hint) && !listed.includes(REAL_LLM_KEY) && !listed.includes(REAL_VENDOR_KEY), "admin API shows hints only");
  console.log("✓ key vault + gateway: encrypted at rest, scoped tokens, real key injected upstream, streaming, metering");

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
  assert.equal((await llm({ "x-api-key": gw.api_key })).status, 401, "session token revoked when the session completes");
  const [metered] = await db.query<{ tokens_in: number; tokens_out: number }>("SELECT tokens_in, tokens_out FROM agent_sessions WHERE id = $1", [jobs[0].session_id]);
  assert.ok(Number(metered.tokens_in) >= 1000 && Number(metered.tokens_out) >= 200, "session keeps the larger of reported and metered usage");
  const [gwUse] = await db.query<{ requests: number; input_tokens: number; output_tokens: number }>(
    "SELECT sum(requests) AS requests, sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens FROM gateway_usage WHERE session_id = $1", [jobs[0].session_id]);
  assert.equal(Number(gwUse.requests), 2, "two successful upstream calls metered");
  assert.equal(Number(gwUse.input_tokens), 240);
  assert.equal(Number(gwUse.output_tokens), 60);
  upstream.close();

  // ---------- fleet check-in over HTTP ----------
  {
    const ids = [`smoke-orch-a-${stamp}`, `smoke-orch-b-${stamp}`];
    assert.equal((await worker("/fleet", { orchestrator_id: ids[0] }, { token: "wrong" })).status, 401);
    await worker("/fleet", { orchestrator_id: ids[0], capacity: 20 });
    const b = await (await worker("/fleet", { orchestrator_id: ids[1], capacity: 50 })).json();
    assert.ok(b.orchestrators >= 2 && b.assignment.reduce((s: number, x: any) => s + x.pods, 0) <= 20, "capacity capped at 20 pods per orchestrator");
    const a = await (await worker("/fleet", { orchestrator_id: ids[0], capacity: 20 })).json();
    assert.ok(a.assignment.every((x: any) => x.image || x.harness), "assignment names harnesses");
    for (const id of ids) assert.equal((await fetch(`${base}/api/worker/fleet/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${WORKER_TOKEN}` } })).status, 204);
    console.log("✓ fleet check-in, capacity cap, leave");
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
  await db.query("DELETE FROM vault_providers WHERE slug IN ('smoke_llm', 'smoke_vendor')");
  await db.query("DELETE FROM gateway_tokens WHERE orchestrator_id = 'smoke-orch'");
  await db.query("DELETE FROM access_requests WHERE email = $1", [`smoke+${stamp}@example.com`]);
  await db.query("DELETE FROM organizations WHERE id = ANY($1)", [[a.org.orgId, b.org.orgId]]);
  await A.close();
  await B.close();
  httpServer.close();
  await db.close();
}
console.log("smoke test passed");
