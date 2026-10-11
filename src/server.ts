import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import * as q from "./queries.js";
import * as research from "./research.js";
import type { Org } from "./auth.js";

/** Hosts (ChatGPT in particular) cache the template by URI: bump the version on breaking HTML/JS changes. */
export const WIDGET_URI = "ui://octillion/dashboard-v2.html";
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
    onboard_product: (a: research.OnboardInput) => research.onboardProduct(org, a),
    get_onboarding: (a: { research_id?: string; product?: string }) => research.getOnboarding(org, a),
    get_product: (a: { product?: string }) => q.getProduct(org, a.product),
    save_product: (a: q.ProductInput) => q.saveProduct(org, a),
    save_scenarios: (a: { product?: string; scenarios: q.ScenarioInput[] }) => q.saveScenarios(org, a.product, a.scenarios),
    run_simulation: (a: q.RunInput) => q.runSimulation(org, a),
    list_simulations: (a: { product?: string }) => q.listSimulations(org, a.product),
    get_simulation: (a: { simulation_id: string }) => q.getSimulation(org, a.simulation_id),
    cancel_simulation: (a: { simulation_id: string }) => q.cancelSimulation(org, a.simulation_id),
    get_visibility_report: (a: { product?: string; days?: number; model?: string; population?: string }) => q.getReport(org, a),
    get_agent_session: (a: { session_id: string }) => q.getSession(org, a.session_id),
    get_session_transcript: (a: { session_id: string; offset?: number; limit?: number }) =>
      q.getTranscript(org, a.session_id, a.offset, a.limit),
    search_transcripts: (a: Parameters<typeof q.searchTranscripts>[1]) => q.searchTranscripts(org, a),
    list_developer_profiles: (a: { query?: string; product?: string }) => q.listProfiles(org, a),
    list_agents: (a: { population?: string }) => q.listAgents(a),
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
      return `Simulation ${s.id} "${s.name}" for ${s.product}: ${s.status}. ${d.totals.sessions} agent sessions (${Object.entries(d.status).map(([k, v]) => `${v} ${k}`).join(", ")}). Hit rate ${pct(d.totals.hit_rate)} over ${d.totals.scored} scored. Verdicts: ${Object.entries(d.verdicts).map(([k, v]) => `${k} ${v}`).join(", ") || "none yet"}.${Object.keys(d.completed_reasons ?? {}).length ? ` Ended: ${Object.entries(d.completed_reasons).map(([k, v]) => `${k} ${v}`).join(", ")}.` : ""} By agent: ${d.by_agent.map((a: any) => `${a.label} ${pct(a.hit_rate)} (n=${a.scored})`).join(", ")}.${d.capacity ? ` Capacity: ${d.capacity.message}` : ""}`;
    }
    case "report": {
      const t = d.totals;
      return `${d.product.name}, last ${d.filters.days} days${d.filters.model ? ` (${d.filters.model})` : ""}: ${t.sessions} scored agent sessions. Hit rate ${pct(t.hit_rate)}${t.weighted_hit_rate != null ? ` (adoption-weighted ${pct(t.weighted_hit_rate)})` : ""}${t.hit_ci ? ` (95% CI ${pct(t.hit_ci[0])}-${pct(t.hit_ci[1])})` : ""}, adopted ${pct(t.adoption_rate)}, lost to a competitor ${pct(t.competitor_rate)}. Share of voice: ${d.share_of_voice.map((v: any) => `${v.tool} ${pct(v.share)}`).join(", ") || "n/a"}. By agent: ${d.by_agent.map((a: any) => `${a.label} ${pct(a.hit_rate)} (n=${a.sessions})`).join(", ") || "n/a"}. ${d.by_profile.length ? `By developer profile: ${d.by_profile.map((p: any) => `${p.name} ${pct(p.hit_rate)}`).join(", ")}. ` : ""}Weakest scenarios: ${d.by_scenario.slice(0, 3).map((s: any) => `#${s.id} ${s.title} ${pct(s.hit_rate)}${s.usual_winner ? ` (usually ${s.usual_winner})` : ""}`).join("; ") || "n/a"}.`;
    }
    case "session": {
      const s = d.session;
      const ev = (s.mentions ?? []).map((m: any) => `${m.tool}: ${m.level}${m.evidence[0] ? ` (#${m.evidence[0].seq} "${m.evidence[0].snippet}")` : ""}`);
      return `Session ${s.id}: ${s.model} on "${s.scenario}" (${s.product})${s.profile ? ` as ${s.profile}` : ""}, ${s.status}${s.completed_reason ? ` (${s.completed_reason}${s.agent_turns != null ? ` after ${s.agent_turns} agent turns` : ""})` : ""}, ${s.user_turns} questions answered by the simulated developer. Verdict: ${s.verdict ?? "not scored yet"}${s.winner ? `, went with ${s.winner}` : ""}. ${s.events} transcript events.${ev.length ? ` Evidence: ${ev.join("; ")}.` : ""}${s.error_message ? ` Error: ${s.error_message}.` : ""}`;
    }
    case "transcript":
      return `Transcript of ${d.session_id} (${d.model}, "${d.scenario}", verdict ${d.verdict ?? "pending"}): events ${d.total ? d.offset + 1 : 0}-${d.offset + d.events.length} of ${d.total}.`;
    case "agents":
      return `Developer population "${d.population.name}" [${d.population.slug}]${d.populations.length > 1 ? ` (others: ${d.populations.filter((p: any) => p.slug !== d.population.slug).map((p: any) => p.slug).join(", ")})` : ""}. Coding agents (as of ${d.as_of ?? "n/a"}), weighted by real-world developer adoption, rounded to whole sandboxes out of ${d.sandbox_unit}: ${d.agents.filter((a) => a.enabled).map((a) => `${a.id} ${a.sandboxes}/${d.sandbox_unit} (${pct(a.weight)})`).join(", ")}.${d.agents.some((a) => !a.enabled) ? ` Not runnable yet: ${d.agents.filter((a) => !a.enabled).map((a) => a.label).join(", ")}.` : ""}${d.unrepresented_share != null ? ` Usage share not representable (IDE-only tools): ${pct(d.unrepresented_share)}.` : ""} A default run samples ${d.default_samples} sessions per scenario in these proportions. Runnable agents cover ${pct(d.runnable_coverage)} of representable usage${d.agents.some((a) => a.status === "adapter pending") ? `; adapters pending for ${d.agents.filter((a) => a.status === "adapter pending").map((a) => a.label).join(", ")}` : ""}.`;
    case "onboarding": {
      const r = d.research, p = d.product;
      const head = `Onboarding ${r.id} for ${p.name}: ${r.status}${r.stage && r.status === "running" ? ` (${r.stage}${r.note ? `: ${r.note}` : ""})` : ""}${r.error ? `. Error: ${r.error}` : ""}.`;
      if (r.status === "queued" && d.capacity) return `${head} Capacity: ${d.capacity.message} Check again with get_onboarding.`;
      if (r.status !== "completed") return `${head} The orchestrator is researching the website and docs, then writes the product profile, target developer personas and programming problems. Check again with get_onboarding.`;
      return `${head} Profile: ${p.category || "n/a"}; aliases ${p.aliases.join(", ") || "none"}; packages ${p.packages.join(", ") || "none"}; competitors ${p.competitors.map((c: any) => c.name).join(", ") || "none"}. Personas: ${d.personas.map((x: any) => x.name).join("; ")}. Problems (${d.scenarios.length}): ${d.scenarios.map((s: any) => `#${s.id} ${s.title} [${s.source}${s.expectation === "avoid" ? ", avoid" : ""}]`).join("; ")}.${d.simulation ? ` Simulation ${d.simulation.id}: ${d.simulation.status}, ${d.simulation.finished}/${d.simulation.sessions} sessions done; see get_simulation / get_visibility_report.` : " No run started."}`;
    }
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

/**
 * Character budget for structuredContent. Claude (web/desktop) stops passing a tool result inline to the app above
 * ~150k characters, and the text content repeats the JSON for the model, so each half stays well under half of that.
 */
export const STRUCTURED_BUDGET = 50_000;

const capStrings = (v: unknown, cap: number): unknown =>
  typeof v === "string"
    ? v.length > cap ? `${v.slice(0, cap)}… [${v.length - cap} more characters]` : v
    : Array.isArray(v) ? v.map((x) => capStrings(x, cap))
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capStrings(x, cap)]))
    : v;

function largestArray(v: unknown): unknown[] | null {
  let best: unknown[] | null = null, bestSize = 0;
  const walk = (x: unknown) => {
    if (Array.isArray(x)) {
      const size = JSON.stringify(x).length;
      if (x.length > 1 && size > bestSize) { best = x; bestSize = size; }
      x.forEach(walk);
    } else if (x && typeof x === "object") Object.values(x).forEach(walk);
  };
  walk(v);
  return best;
}

/**
 * Shrink a JSON payload to the budget: first cap long strings (transcript tool output, prompts), then drop trailing
 * items from the largest arrays (transcript events, search hits, session lists). Marks the result `truncated: true`.
 */
export function fitPayload<T extends Record<string, any>>(data: T, budget = STRUCTURED_BUDGET): T & { truncated?: true } {
  if (JSON.stringify(data).length <= budget) return data;
  let d = data as Record<string, any>;
  for (const cap of [4000, 1000, 300]) {
    d = capStrings(d, cap) as Record<string, any>;
    if (JSON.stringify(d).length <= budget) break;
  }
  const events = Array.isArray(d.events) ? d.events.length : null;
  for (let size = JSON.stringify(d).length; size > budget; size = JSON.stringify(d).length) {
    const arr = largestArray(d);
    if (!arr) break;
    arr.length = Math.max(1, Math.floor(arr.length * Math.min(0.9, budget / size)));
  }
  // A shortened transcript page must continue right after its last event.
  if (d.view === "transcript" && events != null && d.events.length < events) d.limit = d.events.length;
  return { ...d, truncated: true } as unknown as T & { truncated: true };
}

/** Run a handler and shape its output as an MCP tool result (text for the model, structured data for the UI). */
export async function runTool(org: Org, name: ToolName, args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const data = await (handlersFor(org)[name] as (a: unknown) => Promise<Data>)(args ?? {});
    const structured = fitPayload(JSON.parse(JSON.stringify(data))); // Dates -> ISO strings
    const note = structured.truncated
      ? " (Result shortened to fit the host's size limit: page with offset/limit, lower limit, or narrow the filters for the rest.)"
      : "";
    return {
      content: [{ type: "text", text: `${summarize(structured as Data)}${note}\n\n${JSON.stringify(structured)}` }],
      structuredContent: structured,
    };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: (err as Error).message }] };
  }
}

const WIDGET_DESCRIPTION =
  "Interactive Octillion dashboard showing the result of the last tool call: products, onboarding progress, " +
  "visibility reports (hit rate, share of voice, losses to competitors), simulations, agent sessions and transcripts. " +
  "The user can drill down by clicking; the numbers are already visible to them, so summarise insights rather than restating tables.";

/** ChatGPT status strings shown while a tool runs and after it finishes (max 64 characters each). */
export const TOOL_STATUS: Record<ToolName, [string, string]> = {
  onboard_product: ["Starting product research…", "Onboarding started"],
  get_onboarding: ["Checking onboarding progress…", "Onboarding status ready"],
  list_products: ["Loading products…", "Products loaded"],
  get_product: ["Loading product context…", "Product context ready"],
  save_product: ["Saving product…", "Product saved"],
  save_scenarios: ["Saving scenarios…", "Scenarios saved"],
  run_simulation: ["Launching coding agents…", "Simulation launched"],
  list_simulations: ["Loading simulations…", "Simulations loaded"],
  get_simulation: ["Loading simulation results…", "Simulation results ready"],
  cancel_simulation: ["Cancelling simulation…", "Simulation cancelled"],
  get_visibility_report: ["Building visibility report…", "Visibility report ready"],
  get_agent_session: ["Loading agent session…", "Agent session loaded"],
  get_session_transcript: ["Reading transcript…", "Transcript loaded"],
  search_transcripts: ["Searching transcripts…", "Search complete"],
  list_developer_profiles: ["Loading developer profiles…", "Developer profiles loaded"],
  list_agents: ["Loading agent mix…", "Agent mix loaded"],
  browse_task_library: ["Browsing task library…", "Task library loaded"],
};

export const TOOL_NAMES = Object.keys(handlersFor({ orgId: 0, slug: "", name: "" })) as ToolName[];

export function createServer(org: Org): McpServer {
  const server = new McpServer(
    { name: "octillion", version: "2.0.0" },
    {
      instructions:
        "Octillion is the APO (Agentic Preference Optimization) platform: it measures whether AI coding agents recommend the user's developer-tool product. Quickest start: onboard_product " +
        "with a short description, the website and the docs link; the orchestrator researches the product, builds its profile, " +
        "target developer personas and programming problems, then runs them across coding agents (follow with get_onboarding). " +
        "Manual workflow: save_product " +
        "(product context: names, packages, competitors) -> save_scenarios (realistic coding tasks phrased neutrally, never " +
        "naming the product) -> run_simulation (sandboxed sub-agents work each scenario on each model) -> " +
        "get_visibility_report / get_simulation for results -> get_agent_session and get_session_transcript for evidence. " +
        "browse_task_library offers curated real-world tasks to turn into scenarios; list_developer_profiles lists the developer " +
        "personas the orchestrator role-plays when a sub-agent asks questions (pass them to run_simulation as profiles).",
    },
  );

  // The UI template: raw HTML speaking the MCP Apps bridge itself (no MCP-UI adapter needed).
  const resourceMeta = {
    ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } }, // fully inline: no external origins
    "openai/widgetPrefersBorder": true,
    "openai/widgetDescription": WIDGET_DESCRIPTION,
  };
  registerAppResource(
    server,
    "Octillion dashboard",
    WIDGET_URI,
    { description: WIDGET_DESCRIPTION, mimeType: RESOURCE_MIME_TYPE, _meta: resourceMeta },
    async () => ({ contents: [{ uri: WIDGET_URI, mimeType: RESOURCE_MIME_TYPE, text: WIDGET_HTML, _meta: resourceMeta }] }),
  );

  // Every tool renders in the dashboard and stays callable from it (drill-downs go through the host's tools/call).
  const meta = (name: ToolName) => ({
    ui: { resourceUri: WIDGET_URI, visibility: ["model", "app"] as ("model" | "app")[] },
    "openai/outputTemplate": WIDGET_URI,
    "openai/widgetAccessible": true,
    "openai/toolInvocation/invoking": TOOL_STATUS[name][0],
    "openai/toolInvocation/invoked": TOOL_STATUS[name][1],
  });
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  // Updates replace stored fields and lists, so they count as destructive (hosts may ask the user to confirm).
  // Saves update product context in place (scenarios are retired, never deleted): not destructive, so ChatGPT does not ask to confirm each save.
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const run = (name: ToolName) => (a: Record<string, unknown>) => runTool(org, name, a);
  const product = z.string().optional().describe("Product slug, name or id; optional when there is only one product");

  registerAppTool(server, "onboard_product", {
    title: "Onboard a product",
    description: "Start here. Describe a developer tool with a short prompt plus its website and docs links. The orchestrator reads them, builds a detailed product profile (package names, domains, competitors), target developer personas and realistic programming problems where the product could be the right answer (found in the curated task library or newly written, never naming the product), then runs them across the coding-agent mix. Takes a few minutes; follow progress with get_onboarding.",
    inputSchema: {
      prompt: z.string().describe("What the product is and who it is for, in a sentence or a paragraph"),
      website_url: z.string().optional().describe("Product website, e.g. https://bullmq.io"),
      docs_url: z.string().optional().describe("Documentation, e.g. https://docs.bullmq.io"),
      name: z.string().optional().describe("Product name (otherwise taken from the website)"),
      run: z.boolean().optional().describe("Launch the coding-agent run when research finishes (default true)"),
      samples: z.number().int().min(1).max(20).optional().describe("Sessions per problem and persona (default: fitted to the per-run cap)"),
      population: z.string().optional().describe("Developer population whose coding-agent mix to use"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, _meta: meta("onboard_product"),
  }, run("onboard_product"));

  registerAppTool(server, "get_onboarding", {
    title: "Onboarding progress",
    description: "Progress and output of a product onboarding: research stage, the generated product profile, developer personas, programming problems and the simulation it launched.",
    inputSchema: { research_id: z.string().optional(), product },
    annotations: read, _meta: meta("get_onboarding"),
  }, run("get_onboarding"));

  registerAppTool(server, "list_products", {
    title: "List products",
    description: "List the organization's products with scenario counts and their 30-day recommendation hit rate.",
    inputSchema: {},
    annotations: read, _meta: meta("list_products"),
  }, run("list_products"));

  registerAppTool(server, "get_product", {
    title: "Product context",
    description: "Show a product's configured context (description, aliases, package names, domains, competitors), its scenarios with per-scenario hit rate, and recent simulations.",
    inputSchema: { product },
    annotations: read, _meta: meta("get_product"),
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
    annotations: write, _meta: meta("save_product"),
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
        template: z.enum(["express-ts", "nextjs-ts", "node-ts", "fastapi", "django", "go-http", "auto"]).optional()
          .describe("Starter project seeded into the sandbox when there is no repo_url. Omit (or 'auto') to pick from language, tags and prompt"),
        tags: z.array(z.string()).optional(),
        expectation: z.enum(["recommend", "avoid"]).optional(),
        active: z.boolean().optional(),
      })).min(1),
    },
    annotations: write, _meta: meta("save_scenarios"),
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
      population: z.string().optional().describe("Developer population whose coding-agent mix to sample (list_agents); default population if omitted"),
      profiles: z.array(z.string()).optional().describe("Developer profile slugs (list_developer_profiles); every scenario runs once per profile. Omit for a generic developer"),
      repeats: z.number().int().min(1).max(10).optional().describe("Explicit mode: runs per scenario and agent (default 3)"),
      name: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, _meta: meta("run_simulation"),
  }, run("run_simulation"));

  registerAppTool(server, "list_simulations", {
    title: "List simulations",
    description: "Recent simulations with progress and hit rate.",
    inputSchema: { product },
    annotations: read, _meta: meta("list_simulations"),
  }, run("list_simulations"));

  registerAppTool(server, "get_simulation", {
    title: "Simulation results",
    description: "One simulation: progress, verdict counts, hit rate by model, a scenario x model matrix and every agent session.",
    inputSchema: { simulation_id: z.string().describe("e.g. sim_Ab3...") },
    annotations: read, _meta: meta("get_simulation"),
  }, run("get_simulation"));

  registerAppTool(server, "cancel_simulation", {
    title: "Cancel simulation",
    description: "Cancel a simulation's queued sessions. Sessions already running finish normally.",
    inputSchema: { simulation_id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }, _meta: meta("cancel_simulation"),
  }, run("cancel_simulation"));

  registerAppTool(server, "get_visibility_report", {
    title: "Visibility report",
    description: "How often coding agents pick the product: hit rate, adoption rate, losses to competitors, share of voice against each competitor, breakdown by model and by scenario, a daily trend and recent losses with links to the evidence.",
    inputSchema: {
      product,
      days: z.number().int().min(1).max(365).optional().describe("Look-back window (default 30)"),
      model: z.string().optional().describe("Only this model"),
      population: z.string().optional().describe("Developer population for usage shares and the adoption-weighted rate"),
    },
    annotations: read, _meta: meta("get_visibility_report"),
  }, run("get_visibility_report"));

  registerAppTool(server, "get_agent_session", {
    title: "Agent session",
    description: "One sub-agent session: scenario, model, status, cost, verdict, the tool it went with and the transcript evidence for every product it mentioned.",
    inputSchema: { session_id: z.string().describe("e.g. ses_Ab3...") },
    annotations: read, _meta: meta("get_agent_session"),
  }, run("get_agent_session"));

  registerAppTool(server, "get_session_transcript", {
    title: "Session transcript",
    description: "Read a sub-agent session's raw JSONL transcript (messages, tool calls, commands, results), a page at a time.",
    inputSchema: {
      session_id: z.string(),
      offset: z.number().int().min(0).optional().describe("Index of the first event (default 0)"),
      limit: z.number().int().min(1).max(500).optional().describe("Events per page (default 50)"),
    },
    annotations: read, _meta: meta("get_session_transcript"),
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
    annotations: read, _meta: meta("search_transcripts"),
  }, (a) => runTool(org, "search_transcripts", { ...a, simulationId: a.simulation_id, sessionId: a.session_id }));

  registerAppTool(server, "list_developer_profiles", {
    title: "Developer profiles",
    description: "Curated developer personas (role, experience, company size, stack, constraints) from the vault. During a run the orchestrator role-plays the chosen profile whenever the coding agent asks a question.",
    inputSchema: { query: z.string().optional().describe("Filter, e.g. 'enterprise' or 'Python'") },
    annotations: read, _meta: meta("list_developer_profiles"),
  }, run("list_developer_profiles"));

  registerAppTool(server, "list_agents", {
    title: "Worker agents",
    description: "A developer population's coding-agent mix: the agents Octillion simulates (harness, model, pinned version) and each one's share, in whole sandboxes out of 20, from real-world developer usage with sources. Lists the available populations (e.g. global, enterprise). Default simulations sample agents in these proportions.",
    inputSchema: { population: z.string().optional().describe("Developer population slug; default population if omitted") },
    annotations: read, _meta: meta("list_agents"),
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
    annotations: read, _meta: meta("browse_task_library"),
  }, run("browse_task_library"));

  registerPrompts(server);
  return server;
}

const say = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });
const productArg = z.string().optional().describe("Product slug or name; omit when the organization has one product");
const forProduct = (product?: string) => (product ? `{ product: ${JSON.stringify(product)} }` : "{} (if list_products shows several products, ask which one first)");

/** Slash commands: short, actionable playbooks that chain the tools above. */
export function registerPrompts(server: McpServer) {
  server.registerPrompt("onboard_product", {
    title: "Onboard a product",
    description: "Research a developer tool from its website and docs, build its profile, personas and problems, and start a coding-agent run.",
    argsSchema: {
      prompt: z.string().describe("What the product is and who it is for"),
      website_url: z.string().describe("Product website, e.g. https://bullmq.io"),
      docs_url: z.string().describe("Documentation, e.g. https://docs.bullmq.io"),
    },
  }, ({ prompt, website_url, docs_url }) => say(
    `Onboard this developer tool in Octillion.\n` +
    `1. Call onboard_product with ${JSON.stringify({ prompt, website_url, docs_url })}.\n` +
    `2. Poll get_onboarding with the returned research_id about once a minute until status is "completed" or "failed" (research takes a few minutes). Give a one-line progress update per poll; don't call other tools meanwhile.\n` +
    `3. When completed, summarise: the product profile (category, aliases, packages, competitors), each developer persona in one line, and the programming problems (flag any with expectation "avoid"), then the simulation it launched and that get_visibility_report will show results once sessions finish.\n` +
    `If it failed, report the error and offer to set the product up manually with save_product.`,
  ));

  server.registerPrompt("visibility_report", {
    title: "Visibility report",
    description: "Summarise how often coding agents pick the product, where it loses and what to do next.",
    argsSchema: { product: productArg, days: z.string().optional().describe("Look-back window in days (default 30)") },
  }, ({ product, days }) => {
    const a = { ...(product ? { product } : {}), ...(days && Number(days) > 0 ? { days: Math.round(Number(days)) } : {}) };
    return say(
      `Call get_visibility_report with ${JSON.stringify(a)}${product ? "" : " (if it reports several products, call list_products and ask which one)"}.\n` +
      `Then summarise in at most 8 bullets: hit rate with its 95% CI and sample size, adoption rate, share lost to competitors, the competitor with the most share of voice, the strongest and weakest coding agents, the three weakest scenarios with the tool that usually wins them, and the trend direction.\n` +
      `Treat samples under 10 sessions as inconclusive. End with 2-3 concrete next steps, e.g. run explain_loss on one of the recent losses (give its session id) or add scenarios where coverage is thin.`,
    );
  });

  server.registerPrompt("explain_loss", {
    title: "Explain a loss",
    description: "Read one agent session's evidence and explain why the coding agent chose a competitor.",
    argsSchema: { session_id: z.string().describe("Agent session id, e.g. ses_Ab3...") },
  }, ({ session_id }) => say(
    `Explain why the coding agent in session ${session_id} did not pick our product.\n` +
    `1. Call get_agent_session { session_id: ${JSON.stringify(session_id)} }: note the scenario, model, verdict, the tool it went with and the evidence event numbers (#seq).\n` +
    `2. Call get_session_transcript around the first evidence event (offset about 5 before it, limit 30); read from offset 0 too if the decision happened earlier.\n` +
    `3. Explain the decisive moment: what the agent was trying to do, which options it considered, and why it chose the winner. Quote the events with their #seq. Separate what the transcript shows from your inference.\n` +
    `4. Recommend 2-3 specific changes for the product team (docs, examples, package naming, error messages, llms.txt) that would change this outcome.\n` +
    `If the verdict is not a loss to a competitor, say so and explain what happened instead.`,
  ));

  server.registerPrompt("compare_models", {
    title: "Compare coding agents",
    description: "Compare how each coding agent and model treats the product.",
    argsSchema: { product: productArg },
  }, ({ product }) => say(
    `Call get_visibility_report with ${forProduct(product)}.\n` +
    `Compare the coding agents (by_agent) in a compact table: hit rate with CI, sessions, adoption and the competitor each one picks most when it doesn't choose the product. For the agent-by-scenario detail, open the most recent finished simulation with list_simulations then get_simulation.\n` +
    `Call out agents with fewer than 10 sessions as inconclusive and suggest a run_simulation with those agents to close the gap. Finish with the single biggest difference between agents and a hypothesis for it.`,
  ));

  server.registerPrompt("weekly_digest", {
    title: "Weekly digest",
    description: "A short weekly digest across all products: movement, notable losses, runs and actions.",
  }, () => say(
    `Write this week's Octillion digest.\n` +
    `1. Call list_products.\n` +
    `2. For each product, call get_visibility_report with days 7, and again with days 30 as the baseline.\n` +
    `3. Call list_simulations to see runs from the last 7 days.\n` +
    `Report per product: the 7-day hit rate against the 30-day baseline (with the change in points, marked inconclusive under 10 sessions), the competitor gaining most, one or two notable losses with session ids, and simulations finished or still running. Close with the top 3 actions. Keep it under 250 words.`,
  ));
}
