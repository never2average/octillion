import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { createUIResource } from "@mcp-ui/server";
import { z } from "zod";
import * as q from "./queries.js";
import type { Org } from "./auth.js";

export const WIDGET_URI = "ui://octillion/dashboard.html";
export const WIDGET_HTML = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "ui", "widget.html"),
  "utf8",
);

const pct = (x: number | null | undefined) => (x == null ? "n/a" : `${Math.round(x * 100)}%`);
const competitor = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  packages: z.array(z.string()).optional(),
  domains: z.array(z.string()).optional(),
});

/** Tool name -> handler, for one organization. Shared by the MCP server and the local preview. */
export function handlersFor(org: Org) {
  return {
    list_products: () => q.listProducts(org),
    get_product: (a: { product?: string }) => q.getProduct(org, a.product),
    save_product: (a: q.ProductInput) => q.saveProduct(org, a),
    save_scenarios: (a: { product?: string; scenarios: q.ScenarioInput[] }) => q.saveScenarios(org, a.product, a.scenarios),
    run_simulation: (a: q.RunInput) => q.runSimulation(org, a),
    list_simulations: (a: { product?: string }) => q.listSimulations(org, a.product),
    get_simulation: (a: { simulation_id: string }) => q.getSimulation(org, a.simulation_id),
    cancel_simulation: (a: { simulation_id: string }) => q.cancelSimulation(org, a.simulation_id),
    get_visibility_report: (a: { product?: string; days?: number; model?: string }) => q.getReport(org, a),
    get_agent_session: (a: { session_id: string }) => q.getSession(org, a.session_id),
    get_session_transcript: (a: { session_id: string; offset?: number; limit?: number }) =>
      q.getTranscript(org, a.session_id, a.offset, a.limit),
    search_transcripts: (a: Parameters<typeof q.searchTranscripts>[1]) => q.searchTranscripts(org, a),
    list_developer_profiles: (a: { query?: string }) => q.listProfiles(a),
    list_agents: () => Promise.resolve(q.listAgents()),
    browse_task_library: (a: { query?: string; category?: string; language?: string; limit?: number }) => q.browseTaskLibrary(a),
  };
}
type Handlers = ReturnType<typeof handlersFor>;
export type ToolName = keyof Handlers;
type Data = Awaited<ReturnType<Handlers[ToolName]>>;

/** Model-readable summary placed in the text content next to the structured data. */
function summarize(d: Data): string {
  switch (d.view) {
    case "products":
      return d.products.length
        ? `${d.org.name} has ${d.products.length} product(s): ${d.products.map((p: any) => `${p.name} [${p.slug}] (${p.scenarios} scenarios, ${p.sessions_30d} scored runs in 30d, hit rate ${pct(p.hit_rate_30d)})`).join("; ")}.`
        : `${d.org.name} has no products yet. Use save_product to describe one (name, description, aliases, packages, competitors).`;
    case "product": {
      const p = d.product;
      return `${p.name} [${p.slug}]: ${p.description || "(no description)"} Category: ${p.category || "n/a"}. Aliases: ${p.aliases.join(", ") || "none"}. Packages: ${p.packages.join(", ") || "none"}. Competitors: ${p.competitors.map((c) => c.name).join(", ") || "none"}. ${d.scenarios.length} scenarios (${d.scenarios.filter((s: any) => s.active).length} active)${d.scenarios.length ? `: ${d.scenarios.map((s: any) => `#${s.id} ${s.title} (${s.expectation}, hit ${pct(s.hit_rate)} of ${s.sessions})`).join("; ")}` : ""}. Worker agents: ${d.agents.map((a: any) => `${a.id} (${pct(a.weight)})`).join(", ")}.${d.warnings.length ? ` Warnings: ${d.warnings.join(" ")}` : ""}`;
    }
    case "simulations":
      return d.simulations.length
        ? `${d.simulations.length} simulations: ${d.simulations.slice(0, 10).map((s: any) => `${s.id} "${s.name}" ${s.status} ${s.finished}/${s.sessions} done, hit ${pct(s.hit_rate)}`).join("; ")}.`
        : "No simulations yet. Launch one with run_simulation.";
    case "simulation": {
      const s = d.simulation;
      return `Simulation ${s.id} "${s.name}" for ${s.product}: ${s.status}. ${d.totals.sessions} agent sessions (${Object.entries(d.status).map(([k, v]) => `${v} ${k}`).join(", ")}). Hit rate ${pct(d.totals.hit_rate)} over ${d.totals.scored} scored. Verdicts: ${Object.entries(d.verdicts).map(([k, v]) => `${k} ${v}`).join(", ") || "none yet"}. By agent: ${d.by_agent.map((a: any) => `${a.label} ${pct(a.hit_rate)} (n=${a.scored})`).join(", ")}.`;
    }
    case "report": {
      const t = d.totals;
      return `${d.product.name}, last ${d.filters.days} days${d.filters.model ? ` (${d.filters.model})` : ""}: ${t.sessions} scored agent sessions. Hit rate ${pct(t.hit_rate)}${t.weighted_hit_rate != null ? ` (adoption-weighted ${pct(t.weighted_hit_rate)})` : ""}${t.hit_ci ? ` (95% CI ${pct(t.hit_ci[0])}-${pct(t.hit_ci[1])})` : ""}, adopted ${pct(t.adoption_rate)}, lost to a competitor ${pct(t.competitor_rate)}. Share of voice: ${d.share_of_voice.map((v: any) => `${v.tool} ${pct(v.share)}`).join(", ") || "n/a"}. By agent: ${d.by_agent.map((a: any) => `${a.label} ${pct(a.hit_rate)} (n=${a.sessions})`).join(", ") || "n/a"}. ${d.by_profile.length ? `By developer profile: ${d.by_profile.map((p: any) => `${p.name} ${pct(p.hit_rate)}`).join(", ")}. ` : ""}Weakest scenarios: ${d.by_scenario.slice(0, 3).map((s: any) => `#${s.id} ${s.title} ${pct(s.hit_rate)}${s.usual_winner ? ` (usually ${s.usual_winner})` : ""}`).join("; ") || "n/a"}.`;
    }
    case "session": {
      const s = d.session;
      const ev = (s.mentions ?? []).map((m: any) => `${m.tool}: ${m.level}${m.evidence[0] ? ` (#${m.evidence[0].seq} "${m.evidence[0].snippet}")` : ""}`);
      return `Session ${s.id}: ${s.model} on "${s.scenario}" (${s.product})${s.profile ? ` as ${s.profile}` : ""}, ${s.status}, ${s.user_turns} questions answered by the simulated developer. Verdict: ${s.verdict ?? "not scored yet"}${s.winner ? `, went with ${s.winner}` : ""}. ${s.events} transcript events.${ev.length ? ` Evidence: ${ev.join("; ")}.` : ""}${s.error_message ? ` Error: ${s.error_message}.` : ""}`;
    }
    case "transcript":
      return `Transcript of ${d.session_id} (${d.model}, "${d.scenario}", verdict ${d.verdict ?? "pending"}): events ${d.total ? d.offset + 1 : 0}-${d.offset + d.events.length} of ${d.total}.`;
    case "agents":
      return `Worker agents (registry as of ${d.as_of ?? "n/a"}), weighted by real-world developer adoption: ${d.agents.filter((a) => a.enabled).map((a) => `${a.id} ${pct(a.weight)}`).join(", ")}.${d.agents.some((a) => !a.enabled) ? ` Not runnable yet: ${d.agents.filter((a) => !a.enabled).map((a) => a.label).join(", ")}.` : ""}${d.unrepresented_share != null ? ` Usage share not representable (IDE-only tools): ${pct(d.unrepresented_share)}.` : ""} A default run samples ${d.default_samples} sessions per scenario in these proportions.`;
    case "profiles":
      return d.profiles.length
        ? `${d.profiles.length} developer profiles${d.query ? ` matching "${d.query}"` : ""}: ${d.profiles.map((p: any) => `${p.slug} (${p.name}: ${p.summary})`).join("; ")}. Pass slugs as run_simulation profiles.`
        : "No developer profiles synced from the vault yet.";
    case "library":
      return d.tasks.length
        ? `${d.tasks.length} library tasks: ${d.tasks.map((t: any) => `#${t.id} ${t.title} [${t.category ?? "uncategorized"}${t.language ? `, ${t.language}` : ""}]`).join("; ")}. Categories: ${d.categories.map((c: any) => `${c.category ?? "uncategorized"} (${c.tasks})`).join(", ")}. Add one to a product with save_scenarios {library_task_id}.`
        : "No matching tasks in the library.";
    case "search": {
      const r = d.results;
      return `${r.total} transcript events match "${d.query}" (${d.filters.mode}).${r.hits.length ? ` Top: ${r.hits.slice(0, 5).map((h) => `${h.session_id}#${h.seq} (${h.type}, ${h.model}): ${h.text.slice(0, 120)}`).join(" | ")}` : ""}`;
    }
  }
}

/** Run a handler and shape its output as an MCP tool result (text for the model, structured data for the UI). */
export async function runTool(org: Org, name: ToolName, args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const data = await (handlersFor(org)[name] as (a: unknown) => Promise<Data>)(args ?? {});
    const structured = JSON.parse(JSON.stringify(data)); // Dates -> ISO strings
    return {
      content: [{ type: "text", text: `${summarize(data)}\n\n${JSON.stringify(structured)}` }],
      structuredContent: structured,
    };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: (err as Error).message }] };
  }
}

export const TOOL_NAMES = Object.keys(handlersFor({ orgId: 0, slug: "", name: "" })) as ToolName[];

export function createServer(org: Org): McpServer {
  const server = new McpServer(
    { name: "octillion", version: "2.0.0" },
    {
      instructions:
        "Octillion measures whether AI coding agents recommend the user's developer-tool product. Workflow: save_product " +
        "(product context: names, packages, competitors) -> save_scenarios (realistic coding tasks phrased neutrally, never " +
        "naming the product) -> run_simulation (sandboxed sub-agents work each scenario on each model) -> " +
        "get_visibility_report / get_simulation for results -> get_agent_session and get_session_transcript for evidence. " +
        "browse_task_library offers curated real-world tasks to turn into scenarios; list_developer_profiles lists the developer " +
        "personas the orchestrator role-plays when a sub-agent asks questions (pass them to run_simulation as profiles).",
    },
  );

  registerAppResource(
    server,
    "Octillion dashboard",
    WIDGET_URI,
    { description: "Interactive views for products, scenarios, simulations, visibility reports and agent transcripts", mimeType: RESOURCE_MIME_TYPE },
    async () => {
      const ui = createUIResource({
        uri: WIDGET_URI,
        content: { type: "rawHtml", htmlString: WIDGET_HTML },
        encoding: "text",
        adapters: { mcpApps: { enabled: true } },
      });
      return { contents: [ui.resource] };
    },
  );

  const meta = { ui: { resourceUri: WIDGET_URI }, "openai/outputTemplate": WIDGET_URI };
  const read = { readOnlyHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const run = (name: ToolName) => (a: Record<string, unknown>) => runTool(org, name, a);
  const product = z.string().optional().describe("Product slug, name or id; optional when there is only one product");

  registerAppTool(server, "list_products", {
    title: "List products",
    description: "List the organization's products with scenario counts and their 30-day recommendation hit rate.",
    inputSchema: {},
    annotations: read, _meta: meta,
  }, run("list_products"));

  registerAppTool(server, "get_product", {
    title: "Product context",
    description: "Show a product's configured context (description, aliases, package names, domains, competitors), its scenarios with per-scenario hit rate, and recent simulations.",
    inputSchema: { product },
    annotations: read, _meta: meta,
  }, run("get_product"));

  registerAppTool(server, "save_product", {
    title: "Create or update product",
    description: "Create a product, or update one when `product` names an existing one. This is the context used to detect the product in agent transcripts: list every alias, package name (npm/PyPI/crates/Go module) and domain, and the competitors with theirs. List fields replace the stored list.",
    inputSchema: {
      product: z.string().optional().describe("Existing product slug to update; omit to create"),
      name: z.string().optional().describe("Product name, e.g. 'Neon'"),
      description: z.string().optional().describe("What it does and who it is for"),
      category: z.string().optional().describe("e.g. 'Serverless Postgres'"),
      website_url: z.string().optional(),
      docs_url: z.string().optional(),
      aliases: z.array(z.string()).optional().describe("Other names, e.g. ['Neon Postgres', 'neon.tech']"),
      packages: z.array(z.string()).optional().describe("Package names, e.g. ['@neondatabase/serverless']"),
      domains: z.array(z.string()).optional().describe("e.g. ['neon.tech']"),
      competitors: z.array(competitor).optional().describe("Competing products with their aliases, packages and domains"),
    },
    annotations: write, _meta: meta,
  }, run("save_product"));

  registerAppTool(server, "save_scenarios", {
    title: "Add or edit scenarios",
    description: "Add scenarios (omit id) or edit existing ones (pass id). A scenario is a realistic coding task handed verbatim to a sandboxed coding agent, e.g. 'Add a Postgres database to this Next.js app and persist the todos'. Phrase it the way a developer would and never name the product. expectation 'recommend' (default) means the product should be picked; 'avoid' means it should not. Set active=false to retire one.",
    inputSchema: {
      product,
      scenarios: z.array(z.object({
        id: z.number().int().optional(),
        library_task_id: z.number().int().optional().describe("Start from a curated task (browse_task_library); its prompt, title, repo and language are copied unless given"),
        title: z.string().optional(),
        prompt: z.string().optional().describe("The task given to the agent"),
        repo_url: z.string().optional().describe("Optional starter git repo cloned into the sandbox"),
        language: z.string().optional(),
        tags: z.array(z.string()).optional(),
        expectation: z.enum(["recommend", "avoid"]).optional(),
        active: z.boolean().optional(),
      })).min(1),
    },
    annotations: write, _meta: meta,
  }, run("save_scenarios"));

  registerAppTool(server, "run_simulation", {
    title: "Run simulation",
    description: "Launch sandboxed coding sub-agents on the product's scenarios. Default (representative): `samples` sessions per scenario (default 10), with worker agents (Claude Code, Codex, Cursor, ...) mixed in proportion to real-world developer adoption (see list_agents). Explicit: pass agents and/or models to run exactly those, `repeats` times each. Runs asynchronously; check progress with get_simulation.",
    inputSchema: {
      product,
      scenario_ids: z.array(z.number().int()).optional(),
      agents: z.array(z.string()).optional().describe("Explicit worker agent ids (list_agents), e.g. 'claude-code/sonnet'"),
      models: z.array(z.string()).optional().describe("Explicit: only agents using these models"),
      samples: z.number().int().min(1).max(100).optional().describe("Representative mode: sessions per scenario (default 10)"),
      profiles: z.array(z.string()).optional().describe("Developer profile slugs (list_developer_profiles); every scenario runs once per profile. Omit for a generic developer"),
      repeats: z.number().int().min(1).max(10).optional().describe("Explicit mode: runs per scenario and agent (default 3)"),
      name: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, _meta: meta,
  }, run("run_simulation"));

  registerAppTool(server, "list_simulations", {
    title: "List simulations",
    description: "Recent simulations with progress and hit rate.",
    inputSchema: { product },
    annotations: read, _meta: meta,
  }, run("list_simulations"));

  registerAppTool(server, "get_simulation", {
    title: "Simulation results",
    description: "One simulation: progress, verdict counts, hit rate by model, a scenario x model matrix and every agent session.",
    inputSchema: { simulation_id: z.string().describe("e.g. sim_Ab3...") },
    annotations: read, _meta: meta,
  }, run("get_simulation"));

  registerAppTool(server, "cancel_simulation", {
    title: "Cancel simulation",
    description: "Cancel a simulation's queued sessions. Sessions already running finish normally.",
    inputSchema: { simulation_id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }, _meta: meta,
  }, run("cancel_simulation"));

  registerAppTool(server, "get_visibility_report", {
    title: "Visibility report",
    description: "How often coding agents pick the product: hit rate, adoption rate, losses to competitors, share of voice against each competitor, breakdown by model and by scenario, a daily trend and recent losses with links to the evidence.",
    inputSchema: {
      product,
      days: z.number().int().min(1).max(365).optional().describe("Look-back window (default 30)"),
      model: z.string().optional().describe("Only this model"),
    },
    annotations: read, _meta: meta,
  }, run("get_visibility_report"));

  registerAppTool(server, "get_agent_session", {
    title: "Agent session",
    description: "One sub-agent session: scenario, model, status, cost, verdict, the tool it went with and the transcript evidence for every product it mentioned.",
    inputSchema: { session_id: z.string().describe("e.g. ses_Ab3...") },
    annotations: read, _meta: meta,
  }, run("get_agent_session"));

  registerAppTool(server, "get_session_transcript", {
    title: "Session transcript",
    description: "Read a sub-agent session's raw JSONL transcript (messages, tool calls, commands, results), a page at a time.",
    inputSchema: {
      session_id: z.string(),
      offset: z.number().int().min(0).optional().describe("Index of the first event (default 0)"),
      limit: z.number().int().min(1).max(500).optional().describe("Events per page (default 50)"),
    },
    annotations: read, _meta: meta,
  }, run("get_session_transcript"));

  registerAppTool(server, "search_transcripts", {
    title: "Search transcripts",
    description: "Full-text search across this organization's agent transcripts. Case-insensitive; mode 'all' (default) needs every word, 'any' one of them, 'phrase' the exact phrase.",
    inputSchema: {
      query: z.string().describe("e.g. 'prisma migrate' or a competitor's name"),
      mode: z.enum(["all", "any", "phrase"]).optional(),
      product,
      simulation_id: z.string().optional(),
      session_id: z.string().optional(),
      model: z.string().optional(),
      type: z.string().optional().describe("Event type, e.g. assistant_message or tool_call"),
      days: z.number().int().min(1).max(365).optional(),
      limit: z.number().int().min(1).max(200).optional().describe("Max hits (default 25)"),
    },
    annotations: read, _meta: meta,
  }, (a) => runTool(org, "search_transcripts", { ...a, simulationId: a.simulation_id, sessionId: a.session_id }));

  registerAppTool(server, "list_developer_profiles", {
    title: "Developer profiles",
    description: "Curated developer personas (role, experience, company size, stack, constraints) from the vault. During a run the orchestrator role-plays the chosen profile whenever the coding agent asks a question.",
    inputSchema: { query: z.string().optional().describe("Filter, e.g. 'enterprise' or 'Python'") },
    annotations: read, _meta: meta,
  }, run("list_developer_profiles"));

  registerAppTool(server, "list_agents", {
    title: "Worker agents",
    description: "The coding agents Octillion simulates (harness, model, pinned version) and each one's weight: its share of real-world developer usage, with sources. Default simulations sample agents in these proportions.",
    inputSchema: {},
    annotations: read, _meta: meta,
  }, run("list_agents"));

  registerAppTool(server, "browse_task_library", {
    title: "Task library",
    description: "Browse the curated library of real-world developer tasks. Turn one into a scenario with save_scenarios {library_task_id}.",
    inputSchema: {
      query: z.string().optional(),
      category: z.string().optional(),
      language: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    annotations: read, _meta: meta,
  }, run("browse_task_library"));

  return server;
}
