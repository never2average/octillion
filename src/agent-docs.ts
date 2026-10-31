/**
 * Docs for agents, served by the API at the site's root (src/http.ts): /llms.txt (llmstxt.org: what Octillion is, how an
 * agent connects, the key tools and error conventions, links to the rest), /get-started.md (a playbook an agent follows
 * to set Octillion up for its user, stopping only for the user's sign-in or key), and /docs/<slug>.md (each page of the
 * customer guide, /app/docs/<slug>, as markdown, from src/docs-corpus.generated.json).
 *
 * Every address is the request's PUBLIC_URL, filled in when the page is rendered: nothing here names a server, an IP or
 * an internal host. Only the customer guide is served; the internal docs (docs/*.md) never are.
 */
import corpus from "./docs-corpus.generated.json" with { type: "json" };
import { headlessCatalog, oneCommandCatalog } from "./connect-catalog.js";

interface DocsPage { slug: string; title: string; group: string; markdown: string }
const PAGES = ((corpus as { pages?: DocsPage[] }).pages ?? []);

/** The customer guide's pages (slug, title, group), in navigation order. */
export const docsPageList = () => PAGES.map(({ slug, title, group }) => ({ slug, title, group }));

/** Site-relative links and images (`](/app/...)`) made absolute, so a page read outside the site still links home. */
const absolute = (md: string, base: string) => md.replace(/\]\((\/[^)\s]*)\)/g, (_m, p: string) => `](${base}${p})`);

/** One guide page as markdown, or null for a slug that is not a page. */
export function docsPageMarkdown(slug: string, base: string): string | null {
  const p = PAGES.find((x) => x.slug === slug);
  if (!p) return null;
  return `# ${p.title}\n\n${absolute(p.markdown, base)}\n\n---\n\nPart of the Octillion guide (${p.group}). Web version: ${base}/app/docs/${p.slug}. All pages: ${base}/llms.txt\n`;
}

const docsLinks = (base: string) => PAGES.map((p) => `- [${p.title}](${base}/docs/${p.slug}.md): ${p.group}`).join("\n");

/** /llms.txt: the short version, for an agent deciding how to use Octillion. */
export function llmsTxt(base: string): string {
  const mcp = `${base}/mcp`;
  return `# Octillion

> Octillion measures whether AI coding agents recommend your developer tool. It runs real coding agents (Claude Code, Codex, Cursor and others) as sandboxed sub-agents on realistic programming tasks that never name your product, and scores from each transcript whether the agent built on your product, a competitor or nothing. You use it over MCP from the AI client you already have; the web portal is at ${base}/app.

## How agents should use Octillion

- MCP endpoint: ${mcp} (Streamable HTTP, stateless).
- Interactive clients sign in with OAuth: add the URL and the client discovers the authorization server from the 401's WWW-Authenticate (resource_metadata, RFC 9728). Terminal sign-in: \`claude mcp login octillion\` (Claude Code), \`codex mcp login octillion\` (Codex).
- Headless agents (claude -p, the Agent SDK, CI, SSH, sandboxes) send a personal API key: the user creates one at ${base}/app/settings/api-keys (read or write access, an expiry) and you send it as \`Authorization: Bearer $OCTILLION_API_KEY\` (or \`X-API-Key\`). Never put a key in a URL or a committed file.
- One command for most agents: \`npx add-mcp ${mcp} --name octillion\`.
- A person in several workspaces picks one with the \`X-Octillion-Org: <slug>\` header (OAuth only; a key always acts in its own workspace).
- Start every session with \`get_started\`. Call \`whoami\` whenever a call is refused: it names the person, the workspace, what picked it and the credential in use.
- Setting Octillion up for your user: follow ${base}/get-started.md.

## Key tools

- \`get_started\`: where the account stands and the next step.
- \`onboard_product\`: add the user's product from its URL (Octillion researches it and drafts the tasks).
- \`run_simulation\`: run the agents on the product's tasks; \`get_simulation\` and \`list_simulations\` follow it.
- \`get_visibility_report\` and \`export_visibility_report\`: the pick rate, share of voice and losses to competitors.
- \`search_transcripts\`, \`get_agent_session\`, \`get_session_transcript\`: the evidence behind a result.
- \`whoami\`: who this connection acts as.
- Every tool: ${base}/docs/mcp-tools.md

## Errors

- HTTP 401 with \`WWW-Authenticate: Bearer resource_metadata=..., error=..., error_description=...\`: no credential, or one that is not valid (expired, revoked, unknown). Sign in again, or fix OCTILLION_API_KEY. The JSON-RPC \`error.message\` says the next step; \`error.data.reason\` is a stable code (missing, key_expired, key_revoked, key_unknown, token_expired, env_unset, ...).
- HTTP 403, no challenge: the credential is valid but cannot act here (no_account, not_member, suspended, org_mismatch, not_linked). Signing in again will not help: tell the user the message's next step (usually an invitation from a workspace owner).
- HTTP 400 \`bad_org_header\`: X-Octillion-Org is not a workspace slug.
- HTTP 503 \`unverifiable\` with Retry-After: try again after that many seconds.
- A tool result with \`isError: true\`: the text says what to do. A read-only API key or a read-only sign-in (scope octillion:read) is refused write tools this way; the text says how to get write access. Do not retry the same call unchanged.

## Docs

- [Agent playbook: set up Octillion for your user](${base}/get-started.md)
${docsLinks(base)}
`;
}

/** /get-started.md: the steps an agent takes to set Octillion up for its user, pausing only for what the user must do. */
export function getStartedMd(base: string): string {
  const mcp = `${base}/mcp`;
  const one = oneCommandCatalog(mcp);
  const head = headlessCatalog(mcp);
  const cmd = (id: string) => one.find((x) => x.id === id);
  const cc = cmd("claude-code")!, cx = cmd("codex")!, am = cmd("add-mcp")!;
  const hcc = head.find((x) => x.id === "claude-code")!, hjson = head.find((x) => x.id === "claude-code-json")!, hcx = head.find((x) => x.id === "codex")!;
  return `# Set up Octillion for your user

A playbook for an AI agent. Do every step yourself; stop only where it says **PAUSE**, which is when your user must sign in or create a key. Octillion's MCP endpoint is ${mcp}.

## 1. Check for an existing connection

If you already have Octillion tools (for example \`whoami\` or \`get_started\`), call \`whoami\`. If it answers, skip to step 4. If it is refused, read the message: it says what to fix.

## 2. Pick the way in

- **Your user is at a browser on this machine** (Claude Code, Codex, Cursor or VS Code in a desktop session): use sign-in (step 3a).
- **No browser** (claude -p, the Agent SDK, CI, a container, SSH without a browser): use an API key (step 3b). Claude Code and Codex can also sign in over SSH from the terminal (step 3a).

## 3a. Sign in (OAuth)

Add the server:

- Claude Code: \`${cc.command}\`
- Codex: \`${cx.command}\`
- Most agents at once: \`${am.command}\` (asks which installed agents to add it to; \`-a <agent> -y\` to choose without questions)
- Cursor: open ${cmd("cursor")!.install_url}
- VS Code: open ${cmd("vscode")!.install_url}

Then start the sign-in:

- Claude Code: \`${cc.then}\` (prints a link when there is no browser)
- Codex: \`${cx.then}\`
- Other clients: they open the sign-in page the first time they connect.

**PAUSE**: ask your user to finish signing in in the browser page that opened (or the link you show them). They sign in with their work account; if their account has several workspaces they pick one. Continue when they say it is done.

## 3b. API key (headless)

**PAUSE**: ask your user to create a personal API key at ${base}/app/settings/api-keys (write access, unless they only want reports read) and to put it in the environment as \`OCTILLION_API_KEY\` (in CI, a secret with that name). Never ask them to paste the key into the chat, and never write it into a file you commit.

Then add the server so it reads the variable:

- Claude Code: \`${hcc.command}\`, or commit this \`.mcp.json\`, which holds only the variable's name:

\`\`\`json
${hjson.snippet}
\`\`\`

- Codex (\`~/.codex/config.toml\`):

\`\`\`toml
${hcx.snippet}
\`\`\`

- Anything else: send \`Authorization: Bearer $OCTILLION_API_KEY\` (or \`X-API-Key\`) on every POST to ${mcp}.

Restart the client so it picks up the variable.

## 4. Check it works

Call \`whoami\`. It names your user, the workspace and the credential. With several workspaces, send \`X-Octillion-Org: <slug>\` (sign-in only) to choose another.

Without an MCP client, list the tools with curl:

\`\`\`sh
curl -sS ${mcp} -H "Authorization: Bearer $OCTILLION_API_KEY" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
\`\`\`

## 5. First report

1. Call \`get_started\`: it says where the account stands and what to do next.
2. If there is no product yet, call \`onboard_product\` with your user's product URL. Ask for the URL only if you do not know it. Answer the questions \`list_product_questions\` returns from what you know about the product, and ask your user only what you cannot find out.
3. Call \`run_simulation\` when \`get_started\` says the product is ready. Runs take a while: check with \`get_simulation\`.
4. Call \`get_visibility_report\` and summarise it for your user: the pick rate, who wins instead, and the evidence (\`search_transcripts\`).

## When something is refused

- 401: the sign-in expired or the key is wrong, revoked or expired. Sign in again (\`${cc.then}\`), or ask your user for a new key.
- 403: the account cannot act here (no workspace, suspended, not a member). Signing in again will not help: give your user the message, which says who to ask.
- A tool error that says the key or sign-in is read-only: ask your user for a write key, or sign in again allowing write access.
- Anything else: the error text says the next step. \`whoami\` shows what this connection is using.

More: ${base}/llms.txt
`;
}
