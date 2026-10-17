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
  assert.deepEqual(promptArgs.visibility_report, ["product?", "days?"]);
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

  // ---------- onboarding admin console: legacy keys (no Clerk) ----------
  const adm = (method: string, path: string, body?: unknown) => fetch(`${base}/api/admin/onboarding${path}`, {
    method, headers: { authorization: `Bearer ${process.env.OCTILLION_ADMIN_TOKEN}`, "x-admin-actor": "smoke", "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined });
  const json = async (r: Response | Promise<Response>) => { const x = await r; const j = await x.json(); assert.ok(x.ok, `${x.status} ${JSON.stringify(j)}`); return j; };
  const post = (key: string) => fetch(`${base}/mcp/${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const orgRow = async (slug: string) => (await json(adm("GET", "/orgs"))).orgs.find((o: any) => o.slug === slug);
  const settle = () => new Promise((r) => setTimeout(r, 200)); // connector events are recorded fire-and-forget
  assert.equal((await fetch(`${base}/api/admin/onboarding/overview`)).status, 401, "admin API needs the admin token");
  const request = (await json(adm("GET", "/requests?status=pending"))).requests.find((q: any) => q.email === `smoke+${stamp}@example.com`);
  assert.ok(request, "new access request is pending");
  const ap = await json(adm("POST", `/requests/${request.id}/approve`, { name: `Smoke Admin ${stamp}`, slug: `smoke-admin-${stamp}` }));
  assert.match(ap.key, /^oct_/, "without Clerk, approval issues a legacy key");
  assert.ok(ap.secret && ap.connector_url.endsWith(`/mcp/${ap.key}`) && ap.email.body.includes(ap.connector_url) && ap.email.to === request.email);
  assert.equal((await adm("POST", `/requests/${request.id}/approve`, {})).status, 409, "no double approval");
  assert.equal((await adm("POST", "/requests/abc/approve", {})).status, 400, "bad id is a 400");
  const slugA = ap.org.slug;
  assert.equal((await orgRow(slugA)).stage, "created");
  const viaKey = new Client({ name: "smoke-onboarded", version: "1.0.0" });
  await viaKey.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${ap.key}`)));
  await viaKey.callTool({ name: "list_products", arguments: {} });
  await viaKey.close();
  await settle();
  assert.equal((await orgRow(slugA)).stage, "first_call", "funnel follows real connector use");
  const second = await json(adm("POST", `/orgs/${slugA}/invitations`, { email: "teammate@example.com" }));
  assert.ok(second.key && second.email.to === "teammate@example.com", "without Clerk, inviting someone is a key labelled with their email");
  const detail = await json(adm("GET", `/orgs/${slugA}`));
  assert.equal(detail.keys.length, 2);
  assert.ok(!JSON.stringify(detail).includes(ap.key), "detail never returns a full key");
  const k1 = detail.keys.find((k: any) => k.label === request.email);
  const rotated = await json(adm("POST", `/orgs/${slugA}/keys/${k1.id}/rotate`));
  assert.equal((await post(ap.key)).status, 401, "rotated key stops working");
  assert.notEqual((await post(rotated.key)).status, 401, "its replacement works");
  const k2 = detail.keys.find((k: any) => k.label === "teammate@example.com");
  assert.equal((await adm("POST", `/orgs/${slugA}/keys/${k2.id}/revoke`)).status, 204);
  assert.equal((await post(second.key)).status, 401, "revoked key stops working");
  assert.equal((await adm("POST", `/orgs/${slugA}/invitations`, { email: "nope" })).status, 400);
  assert.equal((await adm("POST", `/orgs/${slugA}/billing/portal`)).status, 503, "billing says it is off, not a 500");
  const ov = await json(adm("GET", "/overview"));
  assert.ok(ov.funnel.length === 8 && !ov.integrations.clerk && !ov.integrations.stripe);
  console.log("✓ onboarding console (legacy keys): approve, funnel from real use, per-person keys, rotate, revoke");

  // The customer API needs Clerk: without it, it says so instead of half-working.
  const appCall = (session: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/app${path}`, {
    method, headers: { ...(session ? { authorization: `Bearer ${session}` } : {}), "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await appCall("", "GET", "/me")).status, 503, "no Clerk: the portal API is off");
  if ((await import("node:fs")).existsSync("web/out/app/index.html")) assert.equal((await fetch(`${base}/app/`)).status, 200, "the portal page itself is public (after npm run web:build)");
  for (const gone of ["/app/login-key", "/admin/login"]) assert.equal((await fetch(`${base}${gone}`, { method: "POST" })).status, 404, `${gone} is gone: Clerk signs people in`);

  // ---------- onboarding console with Clerk (people, sign-in) and Stripe (billing), against the mock ----------
  const { startMockProviders } = await import("../src/mock-providers.js");
  const mock = await startMockProviders();
  const { pem } = await (await fetch(`${mock.url}/_mock/public-key`)).json();
  const providerEnv = { CLERK_SECRET_KEY: "sk_test_mock", CLERK_API_URL: mock.url, CLERK_FRONTEND_API_URL: mock.url, CLERK_JWT_KEY: pem,
                        STRIPE_SECRET_KEY: "sk_test_mock", STRIPE_API_URL: mock.url, STRIPE_SPEND_METER: "octillion_model_spend" };
  Object.assign(process.env, providerEnv);
  const { mcpAudience } = await import("../src/clerk.js");
  const mockPost = async (path: string, body: unknown = {}) => (await fetch(`${mock.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  /** A Clerk session token (what the UI sends): v2 claims with the active organization, unless told otherwise. */
  const clerkSession = async (userId: string, orgId?: string | null, role = "member", extra: Record<string, unknown> = {}) =>
    (await mockPost("/_mock/session", { user_id: userId, org_id: orgId ?? undefined, org_role: role, ...extra })).token as string;
  /** A Clerk OAuth access token for an MCP client (opaque by default; jwt: true for a JWT). */
  const token = async (claims: { user_id: string; jwt?: boolean; revoked?: boolean; expired?: boolean; [k: string]: unknown }) =>
    (await mockPost("/_mock/oauth", claims)).access_token as string;
  try {
    const anonW = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(anonW.status, 401);
    const prm = /resource_metadata="([^"]+)"/.exec(anonW.headers.get("www-authenticate") ?? "")?.[1];
    assert.ok(prm, "401 points MCP clients at the protected-resource metadata");
    assert.equal(anonW.headers.get("access-control-expose-headers"), "WWW-Authenticate", "browser MCP clients can read it");
    const metaRes = await fetch(prm!.replace(/^https?:\/\/[^/]+/, base));
    assert.equal(metaRes.headers.get("access-control-allow-origin"), "*", "discovery is CORS-open");
    const meta = await metaRes.json();
    assert.deepEqual(meta.authorization_servers, [mock.url], "Clerk is the authorization server");
    assert.equal(meta.resource, mcpAudience());
    assert.equal((await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()).issuer, mock.url, "AS metadata proxied from Clerk");

    const reqW = await ar({ email: `owner+${stamp}@acme-smoke.dev`, company: `Acme Smoke ${stamp}`, product_url: "https://acme-smoke.dev" });
    assert.equal(reqW.status, 201);
    const qW = (await json(adm("GET", "/requests?status=pending"))).requests.find((q: any) => q.email === `owner+${stamp}@acme-smoke.dev`);
    const apW = await json(adm("POST", `/requests/${qW.id}/approve`, {}));
    assert.equal(apW.key, null, "with Clerk, no secret is handed out");
    assert.equal(apW.invitation.state, "pending", "Clerk sends the invitation");
    assert.equal(apW.invitation.role, "admin", "the requester is invited as the account's admin");
    assert.ok(!apW.secret && apW.connector_url === `${ap.connector_url.split("/mcp/")[0]}/mcp`);
    const slugW = apW.org.slug;
    const [rowW] = await db.query<{ id: number; clerk_org_id: string; stripe_customer_id: string }>("SELECT id, clerk_org_id, stripe_customer_id FROM organizations WHERE slug = $1", [slugW]);
    const corg = mock.state.orgs.get(rowW.clerk_org_id);
    assert.ok(corg, "the Clerk organization exists");
    assert.equal(corg.public_metadata.octillion_slug, slugW, "joined by public_metadata.octillion_slug");
    assert.equal(corg.public_metadata.stripe_customer_id, rowW.stripe_customer_id, "Stripe customer recorded on the Clerk org");
    assert.equal(mock.state.invitations.get(apW.invitation.id).role, "org:admin");
    assert.equal(await db.query("SELECT 1 FROM api_keys WHERE org_id = $1", [rowW.id]).then((r) => r.length), 0, "no API key minted");
    assert.equal((await orgRow(slugW)).stage, "invited");

    // The invitee accepts, signs in through the client's OAuth flow and calls a tool with the access token.
    const accepted = await mockPost(`/_mock/invitations/${apW.invitation.id}/accept`);
    assert.equal((await orgRow(slugW)).stage, "joined");
    const callWith = async (t: string) => {
      const c = new Client({ name: "smoke-oauth", version: "1.0.0" });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${t}` } } }));
      const r = await c.callTool({ name: "get_started", arguments: {} });
      await c.close();
      return r;
    };
    assert.ok(!(await callWith(await token({ user_id: accepted.user.id }))).isError, "an opaque Clerk OAuth token (oat_) works");
    assert.ok(!(await callWith(await token({ user_id: accepted.user.id, jwt: true }))).isError, "a JWT Clerk OAuth token (at+jwt) works");
    const bad = (t: string) => fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${t}` }, body: "{}" }).then((r) => r.status);
    assert.equal(await bad(await token({ user_id: accepted.user.id, revoked: true })), 401, "revoked token rejected");
    assert.equal(await bad(await token({ user_id: accepted.user.id, jwt: true, expired: true })), 401, "expired token rejected");
    assert.equal(await bad(await clerkSession(accepted.user.id, rowW.clerk_org_id, "admin")), 401, "a session token is not an OAuth token");
    const loner = await mockPost("/_mock/clerk/users", { email: `loner+${stamp}@nowhere.dev` });
    assert.equal(await bad(await token({ user_id: loner.id })), 401, "a user with no membership gets nothing");
    await settle();
    assert.equal((await orgRow(slugW)).stage, "first_call");

    // A second person from the same company; suspending them ends their access, not their colleague's.
    const invA = await json(adm("POST", `/orgs/${slugW}/invitations`, { email: `lead+${stamp}@acme-smoke.dev`, role: "admin" }));
    assert.equal(mock.state.invitations.get(invA.invitation.id).role, "org:admin", "the chosen role reaches Clerk");
    const inv2 = await json(adm("POST", `/orgs/${slugW}/invitations`, { email: `dev+${stamp}@acme-smoke.dev` }));
    const again = await json(adm("POST", `/orgs/${slugW}/invitations`, { email: `dev+${stamp}@acme-smoke.dev` }));
    assert.equal(mock.state.invitations.get(inv2.invitation.id).status, "revoked", "inviting again replaces the pending invitation (as Clerk does)");
    assert.equal((await adm("POST", `/orgs/${slugW}/invitations/${inv2.invitation.id}/revoke`)).status, 409, "a replaced invitation cannot be revoked");
    const re = await json(adm("POST", `/orgs/${slugW}/invitations/${again.invitation.id}/resend`));
    assert.notEqual(re.invitation.id, again.invitation.id, "resend = a fresh invitation");
    assert.equal(mock.state.invitations.get(again.invitation.id).status, "revoked");
    const taken = await adm("POST", "/orgs", { name: `Clash ${stamp}`, slug: slugW });
    assert.equal(taken.status, 409, "a taken slug is refused before reaching Clerk");
    assert.equal((await adm("POST", `/orgs/${slugW}/invitations/${invA.invitation.id}/revoke`)).status, 204);
    const acc2 = await mockPost(`/_mock/invitations/${re.invitation.id}/accept`, { first_name: "Dana" });
    const dW = await json(adm("GET", `/orgs/${slugW}`));
    assert.equal(dW.members.length, 2);
    assert.ok(dW.members.some((m: any) => m.email === `owner+${stamp}@acme-smoke.dev` && m.role === "admin"), "members carry their email and role");
    assert.ok(dW.members.every((m: any) => m.id.startsWith("user_")), "members are keyed by Clerk user id");
    assert.ok(dW.clerk_dashboard && !("workos_error" in dW));
    assert.equal((await adm("POST", `/orgs/${slugW}/members/${acc2.user.id}/deactivate`)).status, 204);
    assert.equal(mock.state.memberships.get(`${rowW.clerk_org_id}:${acc2.user.id}`).public_metadata.suspended, true, "suspension is membership metadata");
    assert.equal(await bad(await token({ user_id: acc2.user.id })), 401, "a suspended member has no account on /mcp");
    assert.equal((await adm("POST", `/orgs/${slugW}/members/${acc2.user.id}/reactivate`)).status, 204);
    assert.equal((await adm("POST", `/orgs/${slugW}/members/${acc2.user.id}/role`, { role: "admin" })).status, 204);
    assert.equal(mock.state.memberships.get(`${rowW.clerk_org_id}:${acc2.user.id}`).role, "org:admin", "role changes reach Clerk");
    assert.equal((await adm("POST", `/orgs/${slugW}/members/${acc2.user.id}/role`, { role: "member" })).status, 204);
    assert.equal((await adm("POST", `/orgs/${slugW}/members/${acc2.user.id}/role`, { role: "owner" })).status, 400);

    // The customer portal with Clerk sessions: the owner (admin) and the second person (member).
    const ownerC = await clerkSession(accepted.user.id, rowW.clerk_org_id, "admin");
    const meO = await json(appCall(ownerC, "GET", "/me"));
    assert.equal(meO.role, "admin", "the requester administers the account");
    assert.equal(meO.org_role, "org:admin");
    assert.equal(meO.via, "clerk");
    assert.equal(meO.account.clerk_org_id, rowW.clerk_org_id);
    assert.equal(meO.organizations.length, 1);
    assert.equal((await json(appCall("", "GET", "/me", undefined, { cookie: `__session=${ownerC}` }))).account.slug, slugW, "the __session cookie works");
    assert.equal((await json(appCall("", "GET", "/me", undefined, { cookie: `__session_Ab12=${ownerC}` }))).account.slug, slugW, "so does a suffixed one");
    assert.equal((await json(appCall(await clerkSession(accepted.user.id, rowW.clerk_org_id, "org:admin", { v1: true }), "GET", "/me"))).role, "admin", "v1 org claims work");
    assert.equal((await json(appCall(await clerkSession(accepted.user.id, null), "GET", "/me"))).account.slug, slugW, "no active organization: their oldest membership");
    const tampered = ownerC.slice(0, -4) + (ownerC.endsWith("AAAA") ? "BBBB" : "AAAA");
    const s401 = await appCall(tampered, "GET", "/me");
    assert.equal(s401.status, 401, "a tampered session is rejected");
    assert.equal((await s401.json()).sign_in_url, "/sign-in");
    assert.equal((await appCall(await clerkSession(accepted.user.id, rowW.clerk_org_id, "admin", { expired: true }), "GET", "/me")).status, 401, "an expired session is rejected");
    assert.equal((await appCall(await token({ user_id: accepted.user.id, jwt: true }), "GET", "/me")).status, 401, "an OAuth token is not a portal session");
    process.env.CLERK_AUTHORIZED_PARTIES = "https://app.octillion.test";
    assert.equal((await appCall(await clerkSession(accepted.user.id, rowW.clerk_org_id, "admin", { azp: "https://evil.test" }), "GET", "/me")).status, 401, "a session minted for another origin (azp) is rejected");
    assert.equal((await appCall(await clerkSession(accepted.user.id, rowW.clerk_org_id, "admin", { azp: "https://app.octillion.test" }), "GET", "/me")).status, 200);
    delete process.env.CLERK_AUTHORIZED_PARTIES;
    const lonerS = await appCall(await clerkSession(loner.id), "GET", "/me");
    assert.equal(lonerS.status, 403);
    assert.equal((await lonerS.json()).code, "no_account", "signed in but in no account: 403, not a sign-in loop");
    const setupO = await json(appCall(ownerC, "GET", "/setup"));
    assert.equal(setupO.steps.find((x: any) => x.id === "first_call").done, true, "OAuth tool calls are recorded per person");
    assert.equal(setupO.connect.secret, false);
    const devC = await clerkSession(acc2.user.id, rowW.clerk_org_id, "admin"); // the claim says admin; Clerk's membership (member) wins
    assert.equal((await json(appCall(devC, "GET", "/me"))).role, "member", "the role comes from Clerk, not the token's claim");
    const setupD = await json(appCall(devC, "GET", "/setup"));
    assert.equal(setupD.steps.find((x: any) => x.id === "connected").done, false, "a person who never connected is not marked connected");
    const { since } = await json(appCall(devC, "POST", "/setup/test"));
    assert.equal((await json(appCall(devC, "GET", `/setup?since=${encodeURIComponent(since)}`))).live, null);
    await callWith(await token({ user_id: acc2.user.id }));
    await settle();
    assert.ok((await json(appCall(devC, "GET", `/setup?since=${encodeURIComponent(since)}`))).live, "live test sees the new connection");
    assert.equal((await appCall(devC, "POST", "/team/invitations", { email: "x@acme-smoke.dev" })).status, 403, "members cannot invite");
    assert.equal((await appCall(devC, "POST", "/billing/portal")).status, 403, "members cannot open billing");
    const teamO = await json(appCall(ownerC, "GET", "/team"));
    assert.equal(teamO.members.length, 2);
    const meMember = teamO.members.find((m: any) => m.email === `owner+${stamp}@acme-smoke.dev`);
    assert.equal((await appCall(ownerC, "POST", `/team/members/${meMember.id}/deactivate`)).status, 400, "cannot remove yourself");
    assert.equal((await appCall(ownerC, "POST", `/team/members/${meMember.id}/role`, { role: "member" })).status, 400, "cannot demote yourself");
    assert.equal((await appCall(ownerC, "POST", "/team/invitations", { email: `third+${stamp}@acme-smoke.dev`, role: "member" })).status, 201, "admins invite from /app");
    const usageO = await json(appCall(ownerC, "GET", "/usage"));
    assert.ok(usageO.people.some((p: any) => p.email === `dev+${stamp}@acme-smoke.dev`), "usage per person, by email");
    assert.equal((await appCall(ownerC, "POST", `/team/members/${acc2.user.id}/deactivate`)).status, 204);
    const gone = await appCall(devC, "GET", "/me");
    assert.equal(gone.status, 403, "a suspended member loses the page");
    assert.equal((await gone.json()).code, "suspended");
    assert.equal((await appCall(ownerC, "POST", `/team/members/${acc2.user.id}/reactivate`)).status, 204);
    console.log("✓ customer portal with Clerk sessions: bearer or __session cookie, v1/v2 claims, azp, fallback org, roles from Clerk, setup, team, suspension");

    // ---------- platform admins: Clerk session + allowlist (address, domain, verified email) or public_metadata ----------
    {
      process.env.OCTILLION_PLATFORM_ADMINS = `boss@octillion.test,*@staff.octillion.test,old@octillion.test:scrypt:x:y`;
      const user = (email: string, extra: Record<string, unknown> = {}) => mockPost("/_mock/clerk/users", { email, ...extra });
      const asAdmin = (sess: string, method: string, path: string, opts: { cookie?: boolean; csrf?: boolean; body?: unknown } = {}) =>
        fetch(`${base}/api/admin/onboarding${path}`, { method, headers: { "content-type": "application/json",
          ...(opts.cookie ? { cookie: `__session=${sess}` } : { authorization: `Bearer ${sess}` }), ...(opts.csrf ? { "x-octillion-admin": "1" } : {}) },
          body: opts.body ? JSON.stringify(opts.body) : undefined });
      const boss = await clerkSession((await user("Boss@octillion.test")).id);
      assert.equal((await asAdmin(boss, "GET", "/overview")).status, 200, "a listed address (any case) opens the admin API");
      const sessInfo = await (await fetch(`${base}/admin/session`, { headers: { authorization: `Bearer ${boss}` } })).json();
      assert.ok(sessInfo.signed_in && sessInfo.is_platform_admin && sessInfo.email === "boss@octillion.test");
      assert.deepEqual(await (await fetch(`${base}/admin/session`)).json(), { signed_in: false, email: null, is_platform_admin: false, clerk: true });
      assert.equal((await asAdmin(await clerkSession((await user(`any+${stamp}@staff.octillion.test`)).id), "GET", "/overview")).status, 200, "a domain entry admits the domain");
      assert.equal((await asAdmin(await clerkSession((await user(`old@octillion.test`)).id), "GET", "/overview")).status, 200, "old password entries still name their admin");
      const unverified = await clerkSession((await user(`fake+${stamp}@staff.octillion.test`, { verified: false })).id);
      assert.equal((await asAdmin(unverified, "GET", "/overview")).status, 403, "an unverified address is not enough");
      assert.equal((await asAdmin(await clerkSession((await user(`meta+${stamp}@elsewhere.test`, { platform_admin: true })).id), "GET", "/overview")).status, 200, "public_metadata.platform_admin works");
      const stranger = await asAdmin(await clerkSession(loner.id), "GET", "/overview");
      assert.equal(stranger.status, 403, "everyone else is turned away");
      assert.equal((await asAdmin(boss, "POST", `/orgs/${slugA}/keys`, { cookie: true, body: { label: "csrf" } })).status, 403, "cookie writes need the X-Octillion-Admin header");
      assert.equal((await asAdmin(boss, "POST", `/orgs/${slugA}/keys`, { cookie: true, csrf: true, body: { label: "by-session" } })).status, 201);
      assert.equal((await asAdmin(boss, "POST", `/orgs/${slugA}/keys`, { body: { label: "by-bearer" } })).status, 201, "bearer writes need no header");
      assert.equal((await asAdmin(await token({ user_id: accepted.user.id, jwt: true }), "GET", "/overview")).status, 401, "an OAuth token is not an admin session");
      process.env.OCTILLION_PLATFORM_ADMINS = "*@staff.octillion.test";
      assert.equal((await asAdmin(boss, "GET", "/overview")).status, 403, "removing an admin from the env ends their access");
      delete process.env.OCTILLION_PLATFORM_ADMINS;
      console.log("✓ platform admins: Clerk session + allowlist (address, domain, verified email) or public_metadata, CSRF header on cookie writes");
    }

    // ---------- usage limits: budget split, teams, rollout, throughput (set by account admins on /app) ----------
    {
      const { saveProduct, saveScenarios } = await import("../src/queries.js");
      const orgW = { orgId: rowW.id, slug: slugW, name: `Acme Smoke ${stamp}` };
      await saveProduct(orgW, { ...DEMO_PRODUCT });
      await saveScenarios(orgW, undefined, DEMO_SCENARIOS);
      const run = async (t: string, args: Record<string, unknown>) => {
        const c = new Client({ name: "smoke-limits", version: "1.0.0" });
        await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${t}` } } }));
        const r = await c.callTool({ name: "run_simulation", arguments: args });
        await c.close();
        return { error: r.isError ? (r.content as any[])[0].text as string : null, id: (r.structuredContent as any)?.simulation?.id as string | undefined };
      };
      const ownerT = await token({ user_id: accepted.user.id }), devT = await token({ user_id: acc2.user.id });
      const lim0 = await json(appCall(ownerC, "GET", "/limits"));
      assert.equal(lim0.policy.mode, "pool");
      assert.equal(lim0.members.length, 2);
      assert.ok(lim0.members.every((m: any) => m.allowance_usd === null && m.can_run), "pool: no personal caps");
      assert.equal((await appCall(devC, "PUT", "/limits/policy", { mode: "even" })).status, 403, "members cannot change limits");
      const devView = await json(appCall(devC, "GET", "/limits"));
      assert.ok(!devView.can_manage && devView.members.length === 1 && devView.members[0].user_id === acc2.user.id, "members see only themselves");
      // Even split: (budget - reserve) / people, plus adjustments.
      const budget = lim0.budget_usd;
      assert.equal((await appCall(ownerC, "PUT", "/limits/policy", { mode: "even", reserve_usd: 100 })).status, 204);
      assert.equal((await appCall(ownerC, "PUT", `/limits/members/${acc2.user.id}`, { adjust_usd: -50 })).status, 204);
      let lim = await json(appCall(ownerC, "GET", "/limits"));
      const share = (budget - 100) / 2;
      assert.equal(lim.members.find((m: any) => m.user_id === accepted.user.id).allowance_usd, share);
      assert.equal(lim.members.find((m: any) => m.user_id === acc2.user.id).allowance_usd, share - 50, "minus the adjustment");
      // A team with a budget: its people share it; everyone else shares the rest.
      const devrel = await json(appCall(ownerC, "POST", "/limits/teams", { name: "DevRel", budget_usd: 200 }));
      assert.equal((await appCall(ownerC, "POST", "/limits/teams", { name: "DevRel" })).status, 409, "team names are unique");
      await appCall(ownerC, "PUT", `/limits/members/${acc2.user.id}`, { team_id: devrel.id });
      lim = await json(appCall(ownerC, "GET", "/limits"));
      assert.equal(lim.members.find((m: any) => m.user_id === acc2.user.id).allowance_usd, 150, "team budget / team size, minus 50");
      assert.equal(lim.members.find((m: any) => m.user_id === accepted.user.id).allowance_usd, budget - 100 - 200, "the rest after reserve and team budgets");
      assert.equal((await appCall(ownerC, "PUT", "/limits/members/user_nobody", { cap_usd: 5 })).status, 404, "only members of the account");
      // Rollout: turn running off for one person.
      await appCall(ownerC, "PUT", `/limits/members/${acc2.user.id}`, { can_run: false });
      assert.match((await run(devT, { samples: 1 })).error ?? "", /not switched on for you/, "rollout blocks launching");
      // Throughput: sessions per launch, and runs at once.
      await appCall(ownerC, "PUT", "/limits/policy", { max_sessions_per_run: 1 });
      assert.match((await run(ownerT, { samples: 1 })).error ?? "", /limit per run is 1 \(set by your account admin\)/);
      await appCall(ownerC, "PUT", "/limits/policy", { max_sessions_per_run: null, max_concurrent_runs: 1 });
      const first = await run(ownerT, { samples: 1, name: "limits-1" });
      assert.ok(first.id && !first.error, `a run within limits starts (${first.error})`);
      assert.equal((await db.query<{ created_by: string }>("SELECT created_by FROM simulations WHERE id = $1", [first.id]))[0].created_by, accepted.user.id, "runs record who launched them");
      assert.match((await run(ownerT, { samples: 1 })).error ?? "", /already have 1 simulation running/, "runs at once");
      await db.query("UPDATE simulations SET status = 'cancelled' WHERE id = $1", [first.id]);
      await db.query("UPDATE agent_sessions SET status = 'cancelled' WHERE simulation_id = $1", [first.id]);
      // Custom caps: a person at their cap cannot launch.
      await appCall(ownerC, "PUT", "/limits/policy", { mode: "custom", max_concurrent_runs: null });
      await appCall(ownerC, "PUT", `/limits/members/${accepted.user.id}`, { cap_usd: 0 });
      assert.match((await run(ownerT, { samples: 1 })).error ?? "", /used your \$0\.00 model allowance/);
      lim = await json(appCall(ownerC, "GET", "/limits"));
      assert.equal(lim.members.find((m: any) => m.user_id === accepted.user.id).allowance_usd, 0);
      await appCall(ownerC, "PUT", "/limits/policy", { mode: "pool" });
      await appCall(ownerC, "PUT", `/limits/members/${acc2.user.id}`, { can_run: true, team_id: null });
      console.log("✓ usage limits: even split with reserve and adjustments, team budgets, rollout, sessions per launch, runs at once, custom caps");
    }

    // ---------- context: company (admins), person (self), product (admins); reaches the AI client and research ----------
    {
      assert.equal((await appCall(devC, "PUT", "/context/company", { about: "x" })).status, 403, "members cannot change company context");
      const co = await json(appCall(ownerC, "PUT", "/context/company", { about: "Acme builds a job queue for Node teams.", audience: "Backend engineers at SaaS startups",
        competitors: "BullMQ, Inngest, , BullMQ", terms: "AQ = Acme Queue", notes_for_ai: "Prefer TypeScript examples." }));
      assert.deepEqual(co.competitors, ["BullMQ", "Inngest"], "competitors: trimmed, blanks and duplicates dropped");
      const ctxDev = await json(appCall(devC, "GET", "/context"));
      assert.equal(ctxDev.company.about, "Acme builds a job queue for Node teams.", "everyone sees the company context");
      assert.equal(ctxDev.can_manage, false);
      const slugP = ctxDev.products[0].slug;
      assert.equal((await appCall(devC, "PUT", "/context/me", { answer_style: "loud" })).status, 400);
      assert.equal((await appCall(devC, "PUT", "/context/me", { focus_product: "no-such-product" })).status, 404);
      assert.equal((await json(appCall(devC, "PUT", "/context/me", { title: "Head of DevRel", focus_product: slugP, answer_style: "executive", interests: "why we lose to BullMQ" }))).title, "Head of DevRel");
      const instructionsFor = async (t: string) => {
        const c = new Client({ name: "smoke-context", version: "1.0.0" });
        await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${t}` } } }));
        const i = c.getInstructions() ?? ""; await c.close(); return i;
      };
      const devI = await instructionsFor(await token({ user_id: acc2.user.id }));
      assert.match(devI, /Acme builds a job queue/, "company context reaches the AI client");
      assert.match(devI, /role: Head of DevRel; focus product: /, "so does the person's own");
      assert.match(devI, /Write for an executive/);
      const ownerI = await instructionsFor(await token({ user_id: accepted.user.id }));
      assert.ok(ownerI.includes("Acme builds") && !ownerI.includes("Head of DevRel"), "personal context stays personal");
      // Product context, edited on the page.
      assert.equal((await appCall(devC, "PUT", `/context/products/${slugP}`, { packages: ["x"] })).status, 403);
      assert.equal((await appCall(ownerC, "PUT", "/context/products/no-such-product", { name: "Ghost" })).status, 404, "no product created by accident");
      const pr = await json(appCall(ownerC, "PUT", `/context/products/${slugP}`, { packages: ["acme-queue", "@acme/queue"], competitors: [{ name: "BullMQ", packages: ["bullmq"], domains: ["bullmq.io"], aliases: [] }] }));
      assert.deepEqual(pr.product.packages, ["acme-queue", "@acme/queue"]);
      const scn = pr.scenarios.find((x: any) => x.active);
      assert.equal((await appCall(ownerC, "PUT", `/context/products/${slugP}/scenarios/${scn.id}`, { active: false })).status, 204);
      assert.equal((await json(appCall(ownerC, "GET", `/context/products/${slugP}`))).scenarios.find((x: any) => x.id === scn.id).active, false, "tasks can be retired from the page");
      await appCall(ownerC, "PUT", `/context/products/${slugP}/scenarios/${scn.id}`, { active: true });
      assert.equal((await appCall(ownerC, "POST", "/context/products", { name: "Acme Cron", website_url: "https://acme.dev/cron" })).status, 201, "admins add products");
      // Research starts from the company's context.
      const { onboardProduct } = await import("../src/research.js");
      const job = await onboardProduct({ orgId: rowW.id, slug: slugW, name: "Acme" }, { prompt: "Acme Workflows: durable workflows for Node services.", website_url: "https://acme.dev/workflows" } as any);
      const [inp] = await db.query<{ input: any }>("SELECT input FROM product_research WHERE id = $1", [(job as any).research.id]);
      assert.match(inp.input.prompt, /Company context from the account:[\s\S]*BullMQ, Inngest/, "research gets the company's competitors");
      console.log("✓ context: company (admins), person (self), product editing, in the AI client's instructions and in research");
      // Journeys as a guide on Setup: every recipe, with each step marked from what actually happened.
      const jg = (await json(appCall(ownerC, "GET", "/journeys"))).journeys;
      assert.deepEqual(jg.map((j: any) => j.id), ["connect", "first-report", "evidence", "rerun", "team", "win-back"]);
      assert.equal(jg.find((j: any) => j.id === "connect").steps[0].done, true, "the owner connected earlier in this test");
      assert.equal(jg.find((j: any) => j.id === "team").steps[0].done, true, "the account has a second member");
      assert.ok(jg.every((j: any) => j.total === j.steps.length && j.steps.every((x: any) => x.title && x.message)));
      console.log("✓ journey guide: recipes with per-step progress for /app Setup");
    }

    // ---------- platform analytics and health (/admin Analytics) ----------
    {
      assert.equal((await fetch(`${base}/api/admin/onboarding/analytics`)).status, 401);
      const an = await json(adm("GET", "/analytics?days=30"));
      assert.equal(an.days, 30);
      assert.ok(an.totals.active_accounts >= 2 && an.totals.calls > 0 && an.totals.p95_ms != null, "totals across accounts");
      assert.ok(an.tools.some((t: any) => t.name === "list_products" && t.accounts >= 2), "tool adoption counts accounts");
      assert.ok(an.daily.length >= 1 && an.retention.length >= 1 && an.retention[0].weeks.length === 8 && an.retention[0].weeks[0] === 100, "retention: week 0 is everyone");
      assert.ok(an.accounts.some((a: any) => a.slug === slugW), "per-account activity");
      assert.ok(typeof an.ops.sessions === "number" && typeof an.ops.gateway_requests === "number");
      assert.equal((await json(adm("GET", "/analytics?days=999"))).days, 90, "period capped at 90 days");
      console.log("✓ platform analytics: totals, daily, tool adoption, clients, retention cohorts, accounts at risk, ops health");
    }

    // ---------- journeys: PostHog Workflows webhook -> in-chat and /app tips ----------
    process.env.OCTILLION_JOURNEY_SECRET = "smoke-journey-secret";
    const hook = (body: unknown, auth?: string, path = "") => fetch(`${base}/api/journeys/nudges${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) });
    const step = { distinct_id: accepted.user.id, journey: "first-report", step: "onboard", message: "Start by onboarding your product.", prompt: "Onboard my product: X" };
    assert.equal((await hook(step)).status, 401, "the webhook needs the secret");
    assert.equal((await hook(step, "Bearer wrong")).status, 401);
    assert.equal((await hook(step, "Bearer smoke-journey-secret")).status, 201, "bearer secret");
    assert.equal((await hook({ ...step, step: "via-path" }, undefined, "/smoke-journey-secret")).status, 201, "secret in the path");
    assert.equal((await hook({ distinct_id: "user_unknown", message: "x" }, "Bearer smoke-journey-secret")).status, 404, "unknown person");
    assert.equal((await hook({ distinct_id: `org:${slugW}`, message: "" }, "Bearer smoke-journey-secret")).status, 400, "message required");
    await db.query("DELETE FROM nudges WHERE step = 'via-path'");
    const ownerTok = await token({ user_id: accepted.user.id });
    const callTool = async (t: string, tool: string) => {
      const c = new Client({ name: "smoke-journey", version: "1.0.0" });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${t}` } } }));
      const r = await c.callTool({ name: tool, arguments: {} });
      await c.close();
      return { text: (r.content as any[])[0].text as string, nudge: (r.structuredContent as any)?.nudge };
    };
    await db.query("DELETE FROM nudge_prefs WHERE org_id = $1", [rowW.id]);
    const first = await callTool(ownerTok, "list_products");
    assert.match(first.text, /Octillion tip for the user .*Start by onboarding your product\./s, "the tip rides on the next tool result");
    assert.equal(first.nudge?.prompt, "Onboard my product: X");
    assert.ok(!(await callTool(ownerTok, "list_products")).text.includes("Octillion tip"), "at most one tip per interval");
    assert.ok((await callTool(ownerTok, "get_started")).text.includes("Start by onboarding"), "get_started always shows the waiting tip");
    const devTok = await token({ user_id: acc2.user.id });
    await db.query("DELETE FROM nudge_prefs WHERE org_id = $1", [rowW.id]);
    assert.ok(!(await callTool(devTok, "list_products")).text.includes("Octillion tip"), "a person-level tip is not shown to colleagues");
    await json(adm("POST", "/journeys/nudges", { org_slug: slugW, journey: "manual", step: "hello", message: "New: transcript search." }));
    assert.ok((await callTool(devTok, "list_products")).text.includes("New: transcript search."), "account-wide tips reach everyone");
    const tipsO = await json(appCall(ownerC, "GET", "/nudges"));
    assert.ok(tipsO.nudges.length >= 2 && tipsO.muted === false);
    const onboardTip = tipsO.nudges.find((n: any) => n.step === "onboard");
    assert.equal((await appCall(ownerC, "POST", `/nudges/${onboardTip.id}/dismiss`)).status, 204);
    assert.ok(!(await json(appCall(ownerC, "GET", "/nudges"))).nudges.some((n: any) => n.step === "onboard"), "dismissed tips go away");
    assert.equal((await appCall(devC, "POST", `/nudges/${onboardTip.id}/dismiss`)).status, 404, "nobody dismisses someone else's tip");
    await appCall(ownerC, "POST", "/nudges/mute", { muted: true });
    assert.ok(!(await callTool(ownerTok, "get_started")).text.includes("Octillion tip"), "muted: no tips in chat, even in get_started");
    const jv = await json(adm("GET", "/journeys"));
    assert.ok(jv.recent.some((r: any) => r.email === `owner+${stamp}@acme-smoke.dev`), "recent tips name the person by email");
    assert.ok(jv.configured && jv.recipes.length >= 5 && jv.steps.some((x: any) => x.journey === "first-report" && Number(x.shown) >= 1));
    assert.ok(jv.recipes.every((r: any) => r.steps.every((x: any) => JSON.parse(x.body).distinct_id === "{event.distinct_id}")), "recipe bodies are valid JSON");
    delete process.env.OCTILLION_JOURNEY_SECRET;
    console.log("✓ journeys: webhook auth, in-chat tips (one a day, per person or account), get_started, /app dismiss and mute, admin stats");

    // Billing: plans come from Stripe; the plan's budget caps simulations; portal and checkout are Stripe-hosted.
    assert.deepEqual(dW.plans.map((p: any) => p.lookup_key), ["octillion_starter", "octillion_growth"], "only octillion_ prices are plans");
    assert.match((await json(adm("POST", `/orgs/${slugW}/billing/checkout`, { price_id: "price_mock_starter" }))).url, /\/checkout\//);
    assert.equal((await adm("POST", `/orgs/${slugW}/billing/checkout`, { price_id: "price_unrelated" })).status, 400);
    assert.match((await json(adm("POST", `/orgs/${slugW}/billing/portal`))).url, /\/billing\//);
    const { orgBudget, invalidateSubscriptions } = await import("../src/billing.js");
    assert.equal((await orgBudget(rowW.id)).budget, Number(process.env.OCTILLION_ORG_MONTHLY_BUDGET_USD ?? 1000), "no plan yet: the default budget");
    await fetch(`${mock.url}/_mock/subscriptions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ customer: rowW.stripe_customer_id, price: "price_mock_starter" }) });
    invalidateSubscriptions();
    assert.equal((await orgBudget(rowW.id)).budget, 300, "the Starter plan's monthly_budget_usd");
    const billO = await json(appCall(ownerC, "GET", "/billing"));
    assert.equal(billO.subscription.plan, "Starter");
    assert.equal(billO.budget_usd, 300);
    assert.match((await json(appCall(ownerC, "POST", "/billing/portal"))).url, /\/billing\//, "admins reach the Stripe portal");
    const sW = await orgRow(slugW);
    assert.equal(sW.subscription.status, "active");
    assert.equal(sW.subscription.plan, "Starter");
    process.env.OCTILLION_REQUIRE_SUBSCRIPTION = "1";
    await assert.rejects(orgBudget(a.org.orgId), /no active Octillion plan/, "OCTILLION_REQUIRE_SUBSCRIPTION refuses orgs without a plan");
    delete process.env.OCTILLION_REQUIRE_SUBSCRIPTION;

    // Usage metering: a finished session's cost goes to the Stripe meter once.
    const { reportSessionSpend } = await import("../src/billing.js");
    const [sess] = await db.query<{ id: string }>("SELECT id FROM agent_sessions WHERE org_id = $1 LIMIT 1", [a.org.orgId]);
    await db.query("UPDATE organizations SET stripe_customer_id = $2 WHERE id = $1", [a.org.orgId, `cus_smoke_${stamp}`]);
    await db.query("UPDATE agent_sessions SET cost_usd = 1.234 WHERE id = $1", [sess.id]);
    reportSessionSpend(sess.id); reportSessionSpend(sess.id);
    await settle();
    const metered = mock.state.meterEvents.filter((e: any) => e.identifier === sess.id);
    assert.equal(metered.length, 1, "deduplicated by session id");
    assert.equal(metered[0].payload.value, "123");
    assert.equal(metered[0].payload.stripe_customer_id, `cus_smoke_${stamp}`);

    // An organization created straight in the Clerk dashboard gets its Octillion row on first use.
    const clerkApi = (path: string, body: unknown) => fetch(`${mock.url}/v1${path}`, { method: "POST", headers: { authorization: "Bearer sk_test_mock", "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    const direct = await clerkApi("/organizations", { name: `Dashboard Made ${stamp}` });
    const dashUser = await mockPost("/_mock/clerk/users", { email: `x+${stamp}@dash.dev` });
    await mockPost("/_mock/clerk/memberships", { org_id: direct.id, user_id: dashUser.id, role: "org:admin" });
    assert.ok(!(await callWith(await token({ user_id: dashUser.id }))).isError);
    const [rowD] = await db.query<{ slug: string }>("SELECT slug FROM organizations WHERE clerk_org_id = $1", [direct.id]);
    assert.ok(rowD, "linked on first use");
    assert.equal(mock.state.orgs.get(direct.id).public_metadata.octillion_slug, rowD.slug, "and the slug is written back to Clerk");
    assert.equal((await json(appCall(await clerkSession(dashUser.id, direct.id, "admin"), "GET", "/me"))).account.slug, rowD.slug, "the portal finds it too");

    // A legacy account gets a Clerk organization on demand; its keys keep working.
    const linked = await json(adm("POST", `/orgs/${slugA}/clerk`));
    assert.match(linked.clerk_org_id, /^org_/);
    assert.equal(mock.state.orgs.get(linked.clerk_org_id).public_metadata.octillion_slug, slugA);
    assert.notEqual((await post(rotated.key)).status, 401);
    const ovW = await json(adm("GET", "/overview"));
    assert.ok(ovW.integrations.clerk && ovW.integrations.oauth_on_mcp && ovW.integrations.stripe && ovW.paying >= 1);
    await db.query("DELETE FROM organizations WHERE slug = ANY($1)", [[slugA, slugW, rowD.slug]]);
    await db.query("DELETE FROM access_requests WHERE id = $1", [qW.id]);
    console.log("✓ onboarding console with Clerk + Stripe: invitations, roles, suspension, OAuth on /mcp, plans, budget, metering, dashboard-made orgs");
  } finally {
    for (const k of Object.keys(providerEnv)) delete process.env[k];
    await mock.close();
  }
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
