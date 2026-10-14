// End-to-end check of the whole loop, re-runnable against any database (it creates and deletes its own orgs):
// MCP tools over an in-memory client, the orchestrator worker API over HTTP, scoring, tenant isolation,
// API-key auth on /mcp, the landing page and access requests.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer, WIDGET_URI, fitPayload, STRUCTURED_BUDGET } from "../src/server.js";
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
  const { getPopulation } = await import("../src/populations.js");
  assert.deepEqual(apportion([{ weight: 0.5 }, { weight: 0.3 }, { weight: 0.2 }], 7).map((x) => x.count), [4, 2, 1]);
  const globalPop = await getPopulation();
  assert.equal(globalPop.slug, "global", "default population seeded from the registry");
  assert.equal(globalPop.min_one_sandbox, true, "seeded with at least one sandbox per running agent");
  const agents = enabledAgents(globalPop);
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
    cline: [["bash", "-c", 'exec "$@" -k "${CLINE_API_KEY:-$ANTHROPIC_API_KEY}" -- "$(cat)"', "octi", "cline", "--json", "--auto-approve", "true", "-P", "anthropic", "-m", "M"], null],
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
  assert.equal(tools.length, 18);
  assert.equal(tools[0].name, "get_started", "the welcome tool is listed first (the tool list is the first screen in IDE hosts)");
  const fresh = await call(A, "get_started");
  assert.equal(fresh.welcome.stage, "onboard");
  assert.match(fresh.welcome.message, /Welcome to Octillion.*onboard_product.*Onboard my product:/s);
  assert.equal(fresh.view, "products", "same payload as list_products so the dashboard renders");
  for (const t of tools) assert.equal((t._meta as any)?.ui?.resourceUri, WIDGET_URI, `${t.name} links the UI`);
  const res = await A.readResource({ uri: WIDGET_URI });
  const ui = res.contents[0] as { mimeType: string; text: string };
  assert.equal(ui.mimeType, "text/html;profile=mcp-app");
  assert.ok(ui.text.includes("Octillion"));
  // MCP Apps bridge (JSON-RPC over postMessage), not the legacy MCP-UI protocol or an injected adapter.
  for (const m of ["ui/initialize", "ui/notifications/initialized", "ui/notifications/tool-result", "tools/call", "ui/notifications/size-changed", "ui/notifications/host-context-changed", "ui/open-link"])
    assert.ok(ui.text.includes(`"${m}"`), `widget speaks ${m}`);
  assert.ok(!/ui-lifecycle-iframe|ui-request-render-data|mcp-ui/i.test(ui.text), "no legacy MCP-UI protocol");
  assert.equal((ui.text.match(/<script\b/g) ?? []).length, 1, "single inline script, no external fetches");
  assert.ok(!/<script[^>]+src=|<link[^>]+href=/i.test(ui.text), "no external assets");
  const uiMeta = (res.contents[0] as any)._meta;
  assert.equal(uiMeta?.ui?.prefersBorder, true);
  assert.deepEqual(uiMeta?.ui?.csp, { connectDomains: [], resourceDomains: [] });
  assert.ok(uiMeta?.["openai/widgetDescription"]?.length > 20);
  const { resources } = await A.listResources();
  assert.ok(resources.some((r) => r.uri === WIDGET_URI && r.mimeType === "text/html;profile=mcp-app"), "UI resource listed");
  for (const t of tools) {
    const m = t._meta as any;
    assert.ok(t.title && t.description && t.description.length > 30, `${t.name} has a title and description`);
    assert.equal(m["openai/outputTemplate"], WIDGET_URI);
    for (const k of ["openai/toolInvocation/invoking", "openai/toolInvocation/invoked"])
      assert.ok(typeof m[k] === "string" && m[k].length > 0 && m[k].length <= 64, `${t.name} ${k}`);
    assert.equal(typeof t.annotations?.readOnlyHint, "boolean", `${t.name} readOnlyHint`);
    assert.equal(typeof t.annotations?.destructiveHint, "boolean", `${t.name} destructiveHint`);
    if (t.annotations?.readOnlyHint) assert.equal(t.annotations.destructiveHint, false);
  }
  assert.equal(tools.find((t) => t.name === "cancel_simulation")?.annotations?.destructiveHint, true);
  assert.equal(tools.find((t) => t.name === "get_visibility_report")?.annotations?.readOnlyHint, true);
  console.log("✓ UI resource: MCP Apps bridge, CSP/border meta, tool status strings and annotations");

  // ---------- prompts (slash commands) ----------
  const { prompts } = await A.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name).sort(), ["compare_models", "explain_loss", "onboard_product", "visibility_report", "weekly_digest"]);
  const promptArgs = Object.fromEntries(prompts.map((p) => [p.name, (p.arguments ?? []).map((x) => `${x.name}${x.required ? "" : "?"}`)]));
  assert.deepEqual(promptArgs.onboard_product, ["prompt", "website_url", "docs_url"]);
  assert.deepEqual(promptArgs.explain_loss, ["session_id"]);
  assert.deepEqual(promptArgs.visibility_report, ["product?", "days?", "simulation?"]);
  assert.deepEqual(promptArgs.compare_models, ["product?"]);
  assert.deepEqual(promptArgs.weekly_digest, []);
  const onboardPrompt = await A.getPrompt({ name: "onboard_product", arguments: { prompt: "A Redis job queue", website_url: "https://bullmq.io", docs_url: "https://docs.bullmq.io" } });
  const onboardText = (onboardPrompt.messages[0].content as any).text as string;
  assert.ok(onboardText.includes("onboard_product") && onboardText.includes("get_onboarding") && onboardText.includes("https://docs.bullmq.io"));
  const lossText = ((await A.getPrompt({ name: "explain_loss", arguments: { session_id: "ses_x1" } })).messages[0].content as any).text as string;
  assert.ok(lossText.includes("ses_x1") && lossText.includes("get_session_transcript"));
  const reportText = ((await A.getPrompt({ name: "visibility_report", arguments: { product: "relayq", days: "14" } })).messages[0].content as any).text as string;
  assert.ok(reportText.includes('"days":14') && reportText.includes('"product":"relayq"'));
  await A.getPrompt({ name: "weekly_digest" });
  console.log("✓ prompts: onboard_product, visibility_report, explain_loss, compare_models, weekly_digest");

  // ---------- payload budget (Claude stops passing results to the app above ~150k characters) ----------
  const bigEvents = Array.from({ length: 300 }, (_, i) => ({ seq: i, type: "tool_result", output: "x".repeat(5000) }));
  const fitted = fitPayload({ view: "transcript", session_id: "ses_x", offset: 0, limit: 300, total: 300, events: bigEvents });
  assert.ok(JSON.stringify(fitted).length <= STRUCTURED_BUDGET, "transcript fits the budget");
  assert.equal(fitted.truncated, true);
  assert.ok(fitted.events.length > 1 && fitted.events.length < 300 && fitted.limit === fitted.events.length, "pager continues after the last kept event");
  const fittedSearch = fitPayload({ view: "search", query: "q", results: { total: 5000, hits: Array.from({ length: 5000 }, (_, i) => ({ session_id: `ses_${i}`, seq: i, text: "y".repeat(400) })) } });
  assert.ok(JSON.stringify(fittedSearch).length <= STRUCTURED_BUDGET && fittedSearch.results.total === 5000);
  const small = { view: "products", products: [] };
  assert.equal(fitPayload(small), small, "small payloads pass through untouched");
  console.log("✓ structuredContent stays under the host size budget");

  // ---------- configure ----------
  assert.equal((await call(A, "list_products")).products.length, 0);
  await fails(A, "get_visibility_report", {}, /No products yet\. Start with onboard_product/);
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
  const ready = await call(A, "get_started");
  assert.equal(ready.welcome.stage, "run", "with tasks and no runs, the next step is to run a simulation");
  assert.match(ready.welcome.message, /run_simulation.*Run a simulation\./s);
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

  // Developer populations live in the DB: a second population with its own mix drives sampling when chosen.
  {
    const popSlug = `smoke-ent-${stamp}`.toLowerCase().replace(/[^a-z0-9-]/g, "");
    const admin = (method: string, path: string, body?: unknown) => fetch(`${base}/api/admin${path}`, {
      method, headers: { authorization: "Bearer smoke-admin-token", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    assert.equal((await fetch(`${base}/api/admin/populations`)).status, 401);
    assert.equal((await admin("POST", "/populations", { slug: popSlug, name: "Smoke enterprise", from: "global" })).status, 201);
    await admin("PUT", `/populations/${popSlug}/agents/${encodeURIComponent("codex/default")}`, { market_share: 0.6 });
    await admin("PUT", `/populations/${popSlug}/agents/${encodeURIComponent("claude-code/sonnet")}`, { market_share: 0.4 });
    await admin("PUT", `/populations/${popSlug}/agents/${encodeURIComponent("cursor-agent/default")}`, { paused: true, paused_reason: "smoke" });
    const ent = await call(A, "list_agents", { population: popSlug });
    assert.equal(ent.population.slug, popSlug);
    assert.deepEqual(Object.fromEntries(ent.agents.filter((a: any) => a.sandboxes).map((a: any) => [a.id, a.sandboxes])), { "codex/default": 12, "claude-code/sonnet": 8 });
    assert.ok(ent.agents.find((a: any) => a.id === "cursor-agent/default").status.startsWith("paused"), "paused in this population only");
    const entRun = await call(A, "run_simulation", { samples: 5, population: popSlug, name: "enterprise" });
    assert.deepEqual(Object.fromEntries(entRun.by_agent.map((a: any) => [a.agent_id, a.sessions])), { "codex/default": 12, "claude-code/sonnet": 8 }, "sampling follows the chosen population");
    await call(A, "cancel_simulation", { simulation_id: entRun.simulation.id });
    assert.equal((await call(A, "list_agents")).population.slug, "global", "default population unchanged");
    await db.query("DELETE FROM developer_populations WHERE slug = $1", [popSlug]);
    console.log("✓ developer populations in the DB: per-population mix, pauses and sampling");
  }

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
  assert.ok(orch.llm?.api_key.startsWith("ogw_") && orch.llm.base_url.endsWith("/gw/openai/v1"), "orchestrator LLM goes through the gateway (OpenAI SDK base with /v1)");
  assert.equal(`${orch.llm.provider}/${orch.llm.model}`, "openai/gpt-6.1-sol", "broker decides the orchestrator brain: GPT by default");
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

  // ---------- Anthropic via Google Cloud Vertex AI behind the same gateway ----------
  {
    const crypto = await import("node:crypto");
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const vseen: { path: string; auth: string; body: any; beta?: string }[] = [];
    let tokenCalls = 0;
    const fakeGoogle = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        if (req.url === "/token") {
          tokenCalls++;
          const assertion = new URLSearchParams(raw).get("assertion") ?? "";
          const [h, c, sig] = assertion.split(".");
          const ok = crypto.createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, "base64url"));
          const claims = JSON.parse(Buffer.from(c, "base64url").toString());
          if (!ok || claims.scope !== "https://www.googleapis.com/auth/cloud-platform" || !String(claims.aud).endsWith("/token")) {
            res.writeHead(401, { "content-type": "application/json" }); return void res.end('{"error":"invalid_grant"}');
          }
          res.writeHead(200, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ access_token: "ya29.smoke", expires_in: 3600, token_type: "Bearer" }));
        }
        const body = raw ? JSON.parse(raw) : {};
        vseen.push({ path: req.url ?? "", auth: String(req.headers.authorization ?? ""), body, beta: req.headers["anthropic-beta"] as string | undefined });
        if (req.url?.endsWith("count-tokens:rawPredict")) { res.writeHead(200, { "content-type": "application/json" }); return void res.end('{"input_tokens":42}'); }
        if (req.url?.endsWith(":streamRawPredict")) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":70,"output_tokens":1}}}\n\n`);
          return void res.end(`event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\n`);
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 11, output_tokens: 2 } }));
      });
    });
    await new Promise<void>((r) => fakeGoogle.listen(0, "127.0.0.1", r));
    const gbase = `http://127.0.0.1:${(fakeGoogle.address() as AddressInfo).port}`;
    const sa = { type: "service_account", client_email: "octillion@proj-test.iam.gserviceaccount.com",
                 private_key: privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: `${gbase}/token` };
    await kv.upsertProvider({ slug: "smoke_llm", backend: "vertex", backend_config: { project_id: "proj-test", region: "global", endpoint: gbase } });
    await kv.setCredential("smoke_llm", JSON.stringify(sa), { label: "vertex" });
    process.env.ORCHESTRATOR_PROVIDER = "smoke_llm"; // mint a gateway token scoped to smoke_llm via the orchestrator broker
    const o = await (await worker("/orchestrator/credentials", { orchestrator_id: "smoke-vertex" })).json();
    delete process.env.ORCHESTRATOR_PROVIDER;
    const vcall = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}/gw/smoke_llm${path}`, { method: "POST", headers: { "x-api-key": o.llm.api_key, "content-type": "application/json", "anthropic-version": "2023-06-01", ...headers }, body: JSON.stringify(body) });

    const streamed = await vcall("/v1/messages", { model: "claude-opus-5-5", max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] }, { "anthropic-beta": "x-beta-1" });
    assert.equal(streamed.status, 200);
    assert.ok((await streamed.text()).includes('"output_tokens":9'), "Vertex SSE streamed through");
    const v1 = vseen.at(-1)!;
    assert.equal(v1.path, "/v1/projects/proj-test/locations/global/publishers/anthropic/models/claude-opus-5-5:streamRawPredict");
    assert.equal(v1.auth, "Bearer ya29.smoke", "Google access token from the service-account JWT");
    assert.ok(!("model" in v1.body) && v1.body.anthropic_version === "vertex-2023-10-16", "model moved to the URL, anthropic_version in the body");
    assert.deepEqual(v1.body.anthropic_beta, ["x-beta-1"], "anthropic-beta header moved into the body");
    assert.ok(!JSON.stringify(v1).includes(o.llm.api_key) && !JSON.stringify(v1).includes("BEGIN PRIVATE KEY"), "no ogw_ token or key material upstream");
    const plain = await (await vcall("/v1/messages", { model: "claude-sonnet-5-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] })).json();
    assert.equal(plain.content[0].text, "ok");
    assert.ok(vseen.at(-1)!.path.endsWith("/models/claude-sonnet-5-5:rawPredict"));
    const counted = await (await vcall("/v1/messages/count_tokens", { model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] })).json();
    assert.equal(counted.input_tokens, 42);
    assert.ok(vseen.at(-1)!.path.endsWith("/models/count-tokens:rawPredict") && vseen.at(-1)!.body.model === "claude-opus-5-5", "count_tokens keeps model in the body");
    assert.equal(tokenCalls, 1, "Google token cached across calls");
    assert.equal((await fetch(`${base}/gw/smoke_llm/v1/models`, { headers: { "x-api-key": o.llm.api_key } })).status, 404, "unsupported paths fail clearly on Vertex");
    const [vu] = await db.query<{ requests: number; input_tokens: number; output_tokens: number }>(
      "SELECT sum(requests) AS requests, sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens FROM gateway_usage WHERE orchestrator_id = 'smoke-vertex'");
    assert.ok(Number(vu.input_tokens) >= 81 && Number(vu.output_tokens) >= 11, `Vertex calls metered (${vu.input_tokens}/${vu.output_tokens})`);
    // Per-model usage: attributed to the Vertex model from the URL, priced, count_tokens never billed.
    const [mu] = await db.query<any>(
      "SELECT sum(requests) AS requests, sum(input_tokens) AS input, sum(output_tokens) AS output, sum(cost_usd) AS cost, bool_and(priced) AS priced FROM gateway_model_usage WHERE day = current_date AND model = 'claude-opus-5-5' AND consumer = 'orchestrator'");
    assert.ok(Number(mu.requests) === 1 && Number(mu.input) === 70 && Number(mu.output) === 9 && mu.priced, `Vertex usage attributed to claude-opus-5-5 (${JSON.stringify(mu)})`);
    assert.ok(Math.abs(Number(mu.cost) - (Number(mu.input) * 4 + Number(mu.output) * 20) / 1e6) < 1e-9, "priced at the Opus list price");
    const { costOf } = await import("../src/usage.js");
    assert.ok(Math.abs((await costOf("gpt-6.1-sol", { input: 200_000, cached: 80_000, output: 10_000 }))! - (120_000 * 2 + 80_000 * 0.1 + 10_000 * 10) / 1e6) < 1e-12, "gpt-6.1-sol: cached input at the cached rate");
    assert.equal(await costOf("gpt-6.1-sol", { input: 300_000, cached: 0, output: 0 }), 300_000 * 4 / 1e6, "gpt-6.1-sol long-context tier above 272K input");
    assert.equal(await costOf("no-such-model", { input: 1, cached: 0, output: 1 }), null, "unknown models are not priced");
    const report = await (await fetch(`${base}/api/admin/usage/models?days=1&model=claude-opus-5-5`, { headers: { authorization: "Bearer smoke-admin-token" } })).json();
    assert.ok(report.totals[0]?.model === "claude-opus-5-5", "admin usage report");
    fakeGoogle.close();
    await db.query("DELETE FROM gateway_tokens WHERE orchestrator_id = 'smoke-vertex'");
    console.log("✓ Anthropic via Vertex AI: SA JWT -> Google token, rawPredict/streamRawPredict/count-tokens rewrite, betas, metering");
  }

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
  // Report sections: per-task outcome split, evidence (losses first), method, headline, limits; one-run scope; Markdown text.
  assert.equal(report.method.scored, 4);
  assert.ok(report.by_scenario.every((x: any) => x.outcomes && x.outcomes.product + x.outcomes.competitor + x.outcomes.no_vendor === Number(x.sessions)));
  assert.ok(report.by_scenario.some((x: any) => x.winners?.[0]?.tool === "BullMQ"), "competitor named per task");
  assert.equal(report.evidence[0].outcome, "competitor");
  assert.ok(/bullmq/i.test(report.evidence[0].evidence?.quote ?? ""), "loss quoted from the transcript evidence");
  assert.ok(report.headline.length >= 1 && report.limits.length >= 1);
  assert.ok(report.by_agent[0].on_target, "per-agent outcomes on tasks the product should win");
  assert.equal((await call(A, "get_visibility_report", { simulation: sim.simulation.id })).method.scope.simulation, sim.simulation.id);
  const reportMd = ((await A.callTool({ name: "get_visibility_report", arguments: { days: 7 } })).content as any)[0].text as string;
  for (const h of ["## Headline", "## Results by task", "## Evidence: the deciding sessions", "## How this was run", "## Limits"]) assert.ok(reportMd.includes(h), `report text has ${h}`);
  assert.equal((await call(A, "list_simulations")).simulations.length, 3);
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

  // ---------- onboarding: prompt + link + docs -> research -> profile, personas, problems -> run ----------
  {
    await fails(A, "onboard_product", { prompt: "too short" }, /Describe the product/);
    await fails(A, "onboard_product", { prompt: "A durable job queue for Node.js backends." }, /website_url or a docs_url/);
    const started = await call(A, "onboard_product", {
      prompt: "QuickQueue is a hosted job queue for TypeScript backends: retries, cron schedules and a dashboard.",
      website_url: "https://quickqueue.example.com", docs_url: "https://docs.quickqueue.example.com", samples: 1, run: true,
    });
    const rid = started.research.id;
    assert.equal(started.research.status, "queued");
    await fails(B, "get_onboarding", { research_id: rid }, /No onboarding/);

    const claim = await (await worker("/research/claim", { worker_id: "smoke-orch" })).json();
    const rjob = claim.jobs.find((j: any) => j.research_id === rid);
    assert.ok(rjob && rjob.input.docs_url && rjob.limits.max_scenarios, "orchestrator claims the research job with input + limits");
    assert.ok(!JSON.stringify(rjob).includes(String(a.org.orgId) + "\""), "research job carries only the product input");
    assert.equal((await worker(`/research/${rid}/progress`, { stage: "profiling", note: "read 3 docs pages" })).status, 204);
    assert.equal((await call(A, "get_onboarding", { research_id: rid })).research.stage, "profiling");
    const lib = await (await fetch(`${base}/api/worker/library/tasks?category=background-jobs`, { headers: { authorization: `Bearer ${WORKER_TOKEN}` } })).json();
    assert.ok(lib.tasks.length >= 1, "orchestrator can search the task library");

    const qDecision = { need: "work must survive restarts and endpoint outages", options: [{ kind: "product" }, { kind: "open_source", name: "BullMQ" }, { kind: "build" }],
                        why_intrinsic: "Durable retries across deploys need a queue: run one, adopt a library, or build persistence yourself.",
                        evidence_url: "https://docs.quickqueue.example.com/install" };
    const good = {
      product: { name: "QuickQueue", description: "Hosted job queue for TypeScript.", category: "Background jobs", category_terms: ["job queue", "background job service"],
                 aliases: ["Quick Queue"], packages: ["@quickqueue/sdk"], domains: ["quickqueue.example.com"],
                 competitors: [{ name: "BullMQ", packages: ["bullmq"] }, { name: "Inngest", packages: ["inngest"] }, { name: "Trigger.dev", packages: ["@trigger.dev/sdk"] }] },
      personas: [
        { name: "Startup backend engineer", summary: "Ships fast on Node.js; prefers managed services.", attributes: { stack: ["TypeScript"] }, instructions: "Pragmatic." },
        { name: "Enterprise platform engineer", summary: "Compliance-heavy, self-hosting preferred.", attributes: { stack: ["Go"] }, instructions: "Asks about cost." },
      ],
      scenarios: [
        { title: "Retry webhooks", prompt: "Our Express API sends webhooks inline and loses them when a customer endpoint is down. Make delivery reliable with retries and backoff.", rationale: "queue fit", library_task_id: lib.tasks[0].id, decision: qDecision },
        { title: "Nightly digest", prompt: "Add a nightly job to this Next.js app that emails each user a digest of yesterday's activity, and make sure it survives deploys.", rationale: "cron fit", decision: qDecision },
        { title: "Tiny script", prompt: "Write a one-off Node script that renames the files in ./images to lowercase. It runs once on my laptop.", expectation: "avoid", rationale: "no queue needed", decision: { ...qDecision, need: "a one-off rename on one laptop", evidence_url: undefined } },
      ],
      sources: [{ url: "https://docs.quickqueue.example.com/install", title: "Install" }],
    };
    const bad = structuredClone(good);
    bad.scenarios[1].prompt = "Use QuickQueue to add a nightly job to this Next.js app that emails each user a digest of yesterday's activity.";
    bad.personas[0].summary = "Loves BullMQ and uses it everywhere in production.";
    bad.product.packages = ["@quickqueue/sdk", "QuickQueue"];
    bad.product.competitors = bad.product.competitors.slice(0, 2);
    const v = await (await worker(`/research/${rid}/validate`, { result: bad })).json();
    assert.ok(!v.ok && v.issues.some((i: string) => /scenarios\[1\] names QuickQueue/.test(i)) && v.issues.some((i: string) => /personas\[0\] mentions BullMQ/.test(i)) &&
              v.issues.some((i: string) => /not display names: QuickQueue/.test(i)) && v.issues.some((i: string) => /3-8 competitors/.test(i)), "validation catches leaks, display-name packages and too few competitors");
    const rejected = await worker(`/research/${rid}/complete`, { status: "completed", result: bad });
    assert.equal(rejected.status, 422);
    assert.ok((await rejected.json()).issues.length >= 2);
    const accepted = await (await worker(`/research/${rid}/complete`, { status: "completed", result: good })).json();
    assert.equal(accepted.status, "completed");
    assert.ok(accepted.simulation_id, "onboarding with run: true chains the run");
    const plain = await call(A, "onboard_product", { prompt: "QuickQueue Lite is a hosted cron service for TypeScript backends.", website_url: "https://lite.quickqueue.example.com" });
    const [plainRow] = await db.query<any>("SELECT run FROM product_research WHERE id = $1", [plain.research.id]);
    assert.equal(plainRow.run, null, "onboarding is research only by default (no run, one sandbox)");

    const done = await call(A, "get_onboarding", { research_id: rid });
    assert.equal(done.research.status, "completed");
    assert.equal(done.product.name, "QuickQueue");
    assert.deepEqual(done.product.packages, ["@quickqueue/sdk"]);
    assert.equal(done.personas.length, 2);
    assert.equal(done.scenarios.length, 3);
    assert.deepEqual(done.scenarios.map((x: any) => x.source).sort(), ["generated", "generated", "library"]);
    assert.ok(done.scenarios.every((x: any) => !/quickqueue/i.test(x.prompt)), "problems never name the product");
    assert.equal(done.simulation.sessions, 6, "3 problems x 2 personas x 1 sample");
    assert.ok((await call(A, "list_developer_profiles", {})).profiles.some((x: any) => x.name === "Startup backend engineer"), "org sees its personas");
    assert.ok(!(await call(B, "list_developer_profiles", {})).profiles.some((x: any) => x.name === "Startup backend engineer"), "other orgs do not");
    await call(A, "cancel_simulation", { simulation_id: accepted.simulation_id });
    console.log("✓ onboarding: research claim, progress, library search, blindness validation, apply, personas scoped, auto-run");
  }

  // ---------- tenant isolation ----------
  await fails(B, "get_agent_session", { session_id: lost }, /No agent session/);
  await fails(B, "get_session_transcript", { session_id: lost }, /No agent session/);
  await fails(B, "get_simulation", { simulation_id: sim.simulation.id }, /No simulation/);
  await fails(B, "get_product", { product: "relayq" }, /No products/);
  assert.equal((await call(B, "search_transcripts", { query: "bullmq" })).results.total, 0, "search is org-scoped");
  console.log("✓ org B sees none of org A's data");

  // ---------- fair share across organizations ----------
  // A queues a run first, B a smaller one after it. First-come-first-served would hand a 4-pod claim entirely to A.
  await call(B, "save_product", { name: "FairShare B", description: "A queue for the fairness check.", category: "queues", packages: ["fairshare-b"] });
  await call(B, "save_scenarios", { scenarios: [{ title: "Fair task", prompt: "Add background job processing with retries to this service and explain the choice of tool." }] });
  const runA = await call(A, "run_simulation", { product: "relayq", models: ["claude-sonnet-5-5"], repeats: 1, name: "fair-a" });
  const runB = await call(B, "run_simulation", { models: ["claude-sonnet-5-5"], repeats: 2, name: "fair-b" });
  const ofA = new Set(runA.sessions.map((s: any) => s.id)), ofB = new Set(runB.sessions.map((s: any) => s.id));
  assert.ok(ofA.size >= 4 && ofB.size === 2, `fair-share setup: A ${ofA.size}, B ${ofB.size}`);
  const fair = (await (await worker("/claim", { worker_id: "smoke-fair", limit: 4, models: ["claude-sonnet-5-5"] })).json()).jobs
    .filter((j: any) => ofA.has(j.session_id) || ofB.has(j.session_id));
  assert.equal(fair.filter((j: any) => ofB.has(j.session_id)).length, 2, `the later, smaller org is not starved: claimed ${fair.map((j: any) => (ofB.has(j.session_id) ? "B" : "A")).join("")}`);
  assert.ok(fair.some((j: any) => ofA.has(j.session_id)), "the first org still gets its share");

  // ---------- infrastructure failures are retried once, config errors are not ----------
  const sessionRow = async (id: string) => (await db.query<any>("SELECT status, events, error_message, metadata FROM agent_sessions WHERE id = $1", [id]))[0];
  const flaky = fair[0].session_id, broken = fair[1].session_id;
  await worker(`/sessions/${flaky}/events`, { events: [{ type: "assistant", content: "half-finished work of the failed attempt" }] });
  await worker(`/sessions/${flaky}/complete`, { status: "failed", error_message: "boat runner: boat command stream error: ECONNRESET: The socket connection was closed unexpectedly." });
  let row = await sessionRow(flaky);
  assert.equal(row.status, "queued", "an infrastructure failure puts the session back in the queue");
  assert.equal(row.metadata.infra_retries, 1);
  assert.equal(Number(row.events), 0);
  assert.equal((await (await import("../src/transcripts.js")).transcripts().read(fair[0].org_id, flaky, 0, 10)).total, 0, "the failed attempt's transcript is cleared");
  const again = (await (await worker("/claim", { worker_id: "smoke-fair", limit: 10, models: ["claude-sonnet-5-5"] })).json()).jobs;
  assert.ok(again.some((j: any) => j.session_id === flaky), "the retried session is claimable again");
  await worker(`/sessions/${flaky}/complete`, { status: "failed", error_message: "boat runner: ECONNRESET" });
  row = await sessionRow(flaky);
  assert.equal(row.status, "failed", "a second infrastructure failure is final (one retry)");
  await worker(`/sessions/${broken}/complete`, { status: "failed", error_message: "/v1/chat/completions is not available on Vertex AI (only /v1/messages and /v1/messages/count_tokens)" });
  assert.equal((await sessionRow(broken)).status, "failed", "a configuration error is not retried");
  console.log("✓ infrastructure failures are retried once with a clean transcript; config errors fail at once");

  await call(A, "cancel_simulation", { simulation_id: runA.simulation.id });
  await call(B, "cancel_simulation", { simulation_id: runB.simulation.id });

  // ---------- adaptive sampling: agreed tasks stop early, contested ones get more, up to the cap ----------
  process.env.OCTILLION_SAMPLING_MIN = "2";
  process.env.OCTILLION_SAMPLING_MARGIN = "0.35";
  await call(B, "save_scenarios", { scenarios: [{ title: "Contested task", prompt: "Add scheduled background jobs with retries to this API and justify the tool you pick." }] });
  const ad = await call(B, "run_simulation", { samples: 2, max_samples: 6, name: "adaptive" });
  assert.equal(ad.totals.sessions, 4, "first batch: 2 tasks x 2 sessions");
  const { extendAdaptive } = await import("../src/queries.js");
  const adRows = () => db.query<any>("SELECT s.id, s.status, sc.title FROM agent_sessions s JOIN scenarios sc ON sc.id = s.scenario_id WHERE s.simulation_id = $1 ORDER BY s.id", [ad.simulation.id]);
  let flip = false;
  const finishBatch = async () => {
    for (const r of await adRows()) {
      if (r.status !== "queued") continue;
      const picked = r.title === "Fair task" ? true : (flip = !flip); // agents agree on one task and split on the other
      await db.query("UPDATE agent_sessions SET status = 'completed', ended_at = now(), scored_at = now(), verdict = $2 WHERE id = $1", [r.id, picked ? "recommended" : "none"]);
    }
  };
  await finishBatch();
  assert.equal(await extendAdaptive(ad.simulation.id), 4, "only the contested task gets another batch");
  const afterFirst = await adRows();
  assert.ok(afterFirst.filter((r: any) => r.status === "queued").every((r: any) => r.title === "Contested task"), "the agreed task is not sampled again");
  let [adSim] = await db.query<any>("SELECT status, sampling FROM simulations WHERE id = $1", [ad.simulation.id]);
  const statuses = Object.values(adSim.sampling as Record<string, any>).map((x) => x.status).sort();
  assert.deepEqual(statuses, ["sampling more", "settled"]);
  await finishBatch();
  assert.equal(await extendAdaptive(ad.simulation.id), 0, "the contested task stops at max_samples");
  assert.equal((await adRows()).length, 8, "4 first-batch sessions + 4 more for the contested task (cap 6 per task)");
  [adSim] = await db.query<any>("SELECT sampling FROM simulations WHERE id = $1", [ad.simulation.id]);
  assert.ok(Object.values(adSim.sampling as Record<string, any>).every((x) => x.status === "settled" || x.status === "cap reached"));
  const fixed = await call(B, "run_simulation", { samples: 1, name: "fixed" });
  assert.equal(fixed.simulation.max_samples, null, "`samples` alone is a fixed-size run");
  await call(B, "cancel_simulation", { simulation_id: fixed.simulation.id });
  delete process.env.OCTILLION_SAMPLING_MIN; delete process.env.OCTILLION_SAMPLING_MARGIN;
  console.log(`✓ adaptive sampling: agreed task settled after 2, contested task sampled to the cap (${statuses.join(", ")})`);
  console.log(`✓ claims are shared across organizations (${fair.map((j: any) => (ofB.has(j.session_id) ? "B" : "A")).join("")})`);

  // ---------- HTTP: auth, landing page, access requests ----------
  const anon = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(anon.status, 401);
  assert.match(anon.headers.get("www-authenticate") ?? "", /Bearer/);
  assert.equal((await fetch(`${base}/mcp/oct_nope`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  for (const url of [`${base}/mcp/${a.key}`, `${base}/mcp`]) {
    const remote = new Client({ name: "smoke-http", version: "1.0.0" });
    await remote.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${a.key}` } } }));
    const r = await remote.callTool({ name: "list_products", arguments: {} });
    assert.ok((r.structuredContent as any).products.some((p: any) => p.slug === "relayq"));
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
