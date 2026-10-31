/**
 * How to add Octillion to each AI client: the chat apps, the coding agents Octillion measures (the same harness ids as
 * harnesses/registry.json, so the setup page can order them by real-world usage share), and editors. Each entry gives
 * the one way in that client supports best: a one-click install link, a CLI command, a config file snippet, or UI steps.
 *
 * `verified` marks entries checked against the client's own docs; the rest follow the client's documented MCP config
 * shape and say so in the UI ("check your client's docs if this differs"). Clients change these often: keep it honest.
 */
export type Method = "ui" | "cli" | "config" | "link";
export interface ClientEntry {
  id: string;                 // registry harness id where there is one
  client: string;             // display name
  group: "chat" | "agent" | "editor";
  method: Method;
  steps: string;              // one or two sentences
  command?: string;           // a terminal command
  then?: string;              // a second command to run after it (e.g. sign in from the terminal)
  snippet?: string;           // config content
  file?: string;              // where the snippet goes
  install_url?: string;       // one-click install
  verified: boolean;
  source?: string;            // the client doc the command or link was checked against
  /** Back-compat for callers that render { client, steps, snippet }. */
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

/**
 * Without a key, every client connects to the plain URL and signs in (OAuth). With a legacy API key, the key goes in an
 * `Authorization: Bearer` header in each client's own header setting, never in the URL; Claude's and ChatGPT's apps
 * cannot send a header, so they are told to sign in instead.
 */
export function clientCatalog(url: string, key?: string, opts: { signInAvailable?: boolean } = {}): ClientEntry[] {
  const signIn = key ? "" : " When it asks, sign in with your Octillion account.";
  const auth = key ? `Bearer ${key}` : "";
  const headers = key ? { headers: { Authorization: auth } } : {};
  const noHeader = opts.signInAvailable === false
    ? "This app cannot send an API key header, and this Octillion server has no sign-in set up: use a client below that takes a header (Claude Code, Cursor, Codex, VS Code and others)."
    : "This app cannot send an API key header: ask your Octillion admin for a sign-in invitation, then connect with sign-in.";
  const list: ClientEntry[] = [
    { id: "claude", client: "Claude (web & desktop)", group: "chat", method: "ui", verified: true,
      steps: key ? noHeader : `Settings → Connectors → Add custom connector, name it Octillion and paste the URL.${signIn} On Team and Enterprise plans an owner adds it under Organization settings → Connectors.` },
    { id: "chatgpt", client: "ChatGPT", group: "chat", method: "ui", verified: true,
      steps: key ? noHeader : `Turn on developer mode, add a custom MCP server with the URL and choose OAuth.${signIn} Business, Enterprise and Edu workspaces may need an admin to allow custom MCP servers.` },

    { id: "claude-code", client: "Claude Code", group: "agent", method: "cli", verified: true, source: "https://code.claude.com/docs/en/mcp",
      steps: key ? `Run this in your project.` : `Run this in your project, then sign in with the second command (it prints a link to open in any browser, so it works over SSH too), or type /mcp in Claude Code and choose Authenticate.`,
      command: key ? `claude mcp add --transport http octillion ${url} --header "Authorization: ${auth}"` : `claude mcp add --transport http octillion ${url}`,
      ...(key ? {} : { then: "claude mcp login octillion" }),
      file: key ? ".mcp.json (keep the key out of version control)" : ".mcp.json (to share it with your team)", snippet: json({ mcpServers: { octillion: { type: "http", url, ...headers } } }) },
    key
      ? { id: "codex", client: "Codex CLI", group: "agent", method: "config", verified: false,
        steps: `Add this to your Codex config and restart Codex. Older versions need experimental_use_rmcp_client = true at the top of the file.`,
        file: "~/.codex/config.toml", snippet: `[mcp_servers.octillion]\nurl = "${url}"\nhttp_headers = { "Authorization" = "${auth}" }` }
      : { id: "codex", client: "Codex CLI", group: "agent", method: "cli", verified: true, source: "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
        steps: `Run this, then sign in with the second command. Or add the snippet to your Codex config.`,
        command: `codex mcp add octillion --url ${url}`, then: "codex mcp login octillion",
        file: "~/.codex/config.toml", snippet: `[mcp_servers.octillion]\nurl = "${url}"` },
    { id: "copilot", client: "GitHub Copilot CLI", group: "agent", method: "config", verified: false,
      steps: `Run /mcp add in Copilot CLI and enter the URL as an HTTP server${key ? " with an Authorization header" : ""}, or add this to its MCP config.${signIn}`,
      file: "~/.copilot/mcp-config.json", snippet: json({ mcpServers: { octillion: { type: "http", url, ...headers } } }) },
    // Cursor's one-click link carries its config in the link itself: offered only when there is no key to put in it.
    { id: "cursor", client: "Cursor", group: "agent", method: key ? "config" : "link", verified: true, source: "https://cursor.com/docs/context/mcp/install-links",
      steps: key ? `Add this to Cursor's MCP config, then switch the Octillion tools on.` : `Click Add to Cursor (it opens Cursor's MCP settings with Octillion filled in), then switch the Octillion tools on.${signIn}`,
      ...(key ? {} : { install_url: cursorInstallUrl(url) }),
      file: "~/.cursor/mcp.json", snippet: json({ mcpServers: { octillion: { url, ...headers } } }) },
    { id: "opencode", client: "OpenCode", group: "agent", method: "config", verified: false,
      steps: `Add Octillion as a remote MCP server in your OpenCode config.${signIn}`,
      file: "opencode.json", snippet: json({ $schema: "https://opencode.ai/config.json", mcp: { octillion: { type: "remote", url, enabled: true, ...headers } } }) },
    { id: "antigravity", client: "Antigravity", group: "agent", method: "config", verified: false,
      steps: `Open the MCP servers settings, add a custom server with the URL (Streamable HTTP).${signIn}`,
      snippet: json({ mcpServers: { octillion: { serverUrl: url, ...headers } } }) },
    { id: "gemini-cli", client: "Gemini CLI", group: "agent", method: "cli", verified: true,
      steps: `Run this, then restart Gemini CLI.${signIn}`,
      command: key ? `gemini mcp add -t http -H "Authorization: ${auth}" octillion ${url}` : `gemini mcp add -t http octillion ${url}`,
      file: "~/.gemini/settings.json", snippet: json({ mcpServers: { octillion: { httpUrl: url, ...headers } } }) },
    { id: "cline", client: "Cline", group: "agent", method: "config", verified: false,
      steps: `Open MCP Servers → Configure, and add Octillion as a remote server.${signIn}`,
      file: "cline_mcp_settings.json", snippet: json({ mcpServers: { octillion: { type: "streamableHttp", url, ...headers } } }) },
    { id: "kilo", client: "Kilo Code", group: "agent", method: "config", verified: false,
      steps: `Open MCP settings and add Octillion as a remote (Streamable HTTP) server.${signIn}`,
      file: "mcp_settings.json", snippet: json({ mcpServers: { octillion: { type: "streamable-http", url, ...headers } } }) },
    { id: "amp", client: "Amp", group: "agent", method: "config", verified: false,
      steps: `Add Octillion to Amp's MCP servers.${signIn}`,
      file: "settings.json", snippet: json({ "amp.mcpServers": { octillion: { url, ...headers } } }) },
    { id: "droid", client: "Factory droid", group: "agent", method: "ui", verified: false,
      steps: `Open droid's MCP settings (/mcp) and add an HTTP server with the URL${key ? " and an Authorization header" : ""}.${signIn}` },
    { id: "qwen-code", client: "Qwen Code", group: "agent", method: "config", verified: false,
      steps: `Add Octillion to Qwen Code's settings, then restart it.${signIn}`,
      file: "~/.qwen/settings.json", snippet: json({ mcpServers: { octillion: { httpUrl: url, ...headers } } }) },
    { id: "pi", client: "Pi", group: "agent", method: "ui", verified: false,
      steps: `Pi has no built-in MCP client we could verify. Use Octillion from Claude, ChatGPT or another client on this list.` },

    // VS Code's install link carries the server's JSON (name, type, url) URL-encoded: offered only when there is no key in it.
    { id: "vscode", client: "VS Code (Copilot Chat)", group: "editor", method: key ? "config" : "link", verified: !key,
      ...(key ? {} : { source: "https://code.visualstudio.com/api/extension-guides/ai/mcp" }),
      steps: key ? `Add the snippet to your workspace (keep the key out of version control), then start the server from the MCP list.` : `Click Add to VS Code, or run this, or add the snippet to your workspace; then start the server from the MCP list and sign in.`,
      ...(key ? {} : { install_url: vscodeInstallUrl(url), command: `code --add-mcp '${JSON.stringify({ name: "octillion", type: "http", url })}'` }),
      file: ".vscode/mcp.json", snippet: json({ servers: { octillion: { type: "http", url, ...headers } } }) },
    { id: "windsurf", client: "Windsurf", group: "editor", method: "config", verified: false,
      steps: `Add Octillion to Windsurf's MCP config and refresh the server list.${signIn}`,
      file: "~/.codeium/windsurf/mcp_config.json", snippet: json({ mcpServers: { octillion: { serverUrl: url, ...headers } } }) },
    { id: "zed", client: "Zed", group: "editor", method: "config", verified: false,
      steps: `Add Octillion as a context server in Zed's settings.${signIn}`,
      file: "settings.json", snippet: json({ context_servers: { octillion: { url, ...headers } } }) },
  ];
  if (key) list.push({ id: "header", client: "Header-capable clients", group: "agent", method: "config", verified: true,
    steps: `POST ${url} with this header (or X-API-Key: <key>).`, snippet: `Authorization: ${auth}` });
  return list;
}

/** VS Code's MCP install link: vscode:mcp/install?<URL-encoded JSON of name + server config> (code.visualstudio.com/api/extension-guides/ai/mcp). */
export const vscodeInstallUrl = (url: string) => `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: "octillion", type: "http", url }))}`;
/** Cursor's MCP install link: name, and the server's mcp.json entry as base64 (cursor.com/docs/context/mcp/install-links). */
export const cursorInstallUrl = (url: string) =>
  `cursor://anysphere.cursor-deeplink/mcp/install?name=octillion&config=${encodeURIComponent(Buffer.from(JSON.stringify({ url })).toString("base64"))}`;

export interface OneCommand {
  id: string;
  label: string;
  command?: string;
  /** A second command to run after the first (sign in from the terminal). */
  then?: string;
  install_url?: string;
  verified: boolean;
  source?: string;
  note?: string;
}

/**
 * One command (or one click) to add Octillion with sign-in, for the setup page, llms.txt and the agent playbook. Each
 * checked against the tool's own docs on 2026-10-31; anything not checked says so (`verified: false`).
 *   add-mcp      github.com/neondatabase/add-mcp: `npx add-mcp <url>` installs a remote URL as HTTP into the agents it
 *                finds (Claude Code, Codex, Cursor, VS Code and more; -a picks, -y skips prompts)
 *   Claude Code  code.claude.com/docs/en/mcp: `claude mcp login <name>` runs the OAuth flow from the shell (SSH, no browser)
 *   Codex        learn.chatgpt.com/docs/extend/mcp?surface=cli: `codex mcp add <name> --url`, `codex mcp login <name>`
 *   Cursor       cursor.com/docs/context/mcp/install-links: base64 config ({"url"} for a remote server follows the
 *                mcp.json shape; the page shows no remote example)
 *   VS Code      code.visualstudio.com/api/extension-guides/ai/mcp: vscode:mcp/install?<encoded JSON>
 */
export function oneCommandCatalog(url: string): OneCommand[] {
  return [
    { id: "add-mcp", label: "Any agent (Claude Code, Codex, Cursor, VS Code and more)", verified: true, source: "https://github.com/neondatabase/add-mcp",
      command: `npx add-mcp ${url} --name octillion`, note: "Asks which of your installed agents to add it to (-a <agent> to choose, -y to skip the questions). Then sign in from the agent." },
    { id: "claude-code", label: "Claude Code", verified: true, source: "https://code.claude.com/docs/en/mcp",
      command: `claude mcp add --transport http octillion ${url}`, then: "claude mcp login octillion",
      note: "claude mcp login prints a sign-in link when there is no browser (SSH: connect with ssh -t so the paste-back works)." },
    { id: "codex", label: "Codex CLI", verified: true, source: "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
      command: `codex mcp add octillion --url ${url}`, then: "codex mcp login octillion" },
    { id: "cursor", label: "Cursor", verified: true, source: "https://cursor.com/docs/context/mcp/install-links", install_url: cursorInstallUrl(url) },
    { id: "vscode", label: "VS Code", verified: true, source: "https://code.visualstudio.com/api/extension-guides/ai/mcp", install_url: vscodeInstallUrl(url) },
  ];
}

/** The environment variable every headless snippet reads the personal API key from. */
export const API_KEY_ENV = "OCTILLION_API_KEY";

export interface HeadlessEntry {
  id: string;
  client: string;
  steps: string;
  command?: string;
  snippet?: string;
  file?: string;
  /** Checked against the client's own docs (`source`). */
  verified: boolean;
  /** Where the syntax comes from. */
  source?: string;
  note?: string;
}

/**
 * The API key (headless) path: agents that cannot finish a browser sign-in (claude -p, the Agent SDK, CI, SSH,
 * sandboxes) send a personal API key from /app/settings/api-keys. Every snippet reads it from OCTILLION_API_KEY by the
 * client's own environment interpolation, so no key is ever written into a config file or shown here.
 * Checked against each client's docs on 2026-10-31:
 *   Claude Code  code.claude.com/docs/en/mcp: --header on `claude mcp add`; .mcp.json expands ${VAR} in url and headers
 *                (credential names Claude Code itself guards, e.g. ANTHROPIC_API_KEY or NPM_TOKEN, read as empty there;
 *                OCTILLION_API_KEY is not one of them)
 *   Codex        learn.chatgpt.com/docs/extend/mcp: bearer_token_env_var names the variable holding the bearer token
 *   Cursor       cursor.com/docs/context/mcp: ${env:NAME} in url and headers
 */
export function headlessCatalog(url: string): HeadlessEntry[] {
  const v = API_KEY_ENV;
  return [
    { id: "claude-code", client: "Claude Code (claude -p, Agent SDK, CI)", verified: true, source: "https://code.claude.com/docs/en/mcp",
      steps: `Set ${v} in the environment, then add the server once. Works in claude -p and the Agent SDK with no browser.`,
      command: `claude mcp add --transport http octillion ${url} --header "Authorization: Bearer \${${v}}"`,
      note: `In double quotes your shell fills in the key when you run the command, and Claude Code keeps it in your local config (~/.claude.json), not in the project. To keep only the variable's name, use the .mcp.json below: Claude Code reads ${v} each time it starts.` },
    { id: "claude-code-json", client: "Claude Code project file (.mcp.json)", verified: true, source: "https://code.claude.com/docs/en/mcp",
      steps: `Commit this file: it holds the variable's name, never the key. Each person or CI job sets ${v}.`,
      note: `If ${v} is not set when Claude Code starts, it warns in claude mcp list and /mcp, and sends the unexpanded \${${v}} text, which Octillion refuses with a 401 saying the variable is not set: set it and restart.`,
      file: ".mcp.json", snippet: json({ mcpServers: { octillion: { type: "http", url, headers: { Authorization: `Bearer \${${v}}` } } } }) },
    { id: "codex", client: "Codex CLI", verified: true, source: "https://learn.chatgpt.com/docs/extend/mcp",
      steps: `Add this to your Codex config and set ${v}; Codex sends it as Authorization: Bearer.`,
      file: "~/.codex/config.toml", snippet: `[mcp_servers.octillion]\nurl = "${url}"\nbearer_token_env_var = "${v}"` },
    { id: "cursor", client: "Cursor", verified: true, source: "https://cursor.com/docs/context/mcp",
      steps: `Add this to the project's MCP config (or your global ~/.cursor/mcp.json), set ${v} in the environment Cursor starts from, then switch the Octillion tools on.`,
      file: ".cursor/mcp.json", snippet: json({ mcpServers: { octillion: { url, headers: { Authorization: `Bearer \${env:${v}}` } } } }) },
    { id: "curl", client: "Any HTTP client (curl)", verified: true,
      steps: `Any client that can send a header works: Authorization: Bearer, or X-API-Key. This lists the tools.`,
      command: `curl -sS ${url} -H "Authorization: Bearer $${v}" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
      note: `A key always acts in the workspace it was made in. With sign-in (OAuth), pick one of your workspaces with -H "X-Octillion-Org: <slug>".` },
  ];
}
