# octillion (CLI)

Sign in to Octillion from a terminal or an agent, check who you are, and print MCP connect snippets. No dependencies,
Node 20 or later, plain ESM.

```sh
export OCTILLION_URL=https://<your Octillion address>
octillion login          # opens nothing: shows a link and a code, then waits for you to approve
octillion whoami         # person, workspace (and what picked it), credential
octillion mcp-config claude-code
curl -H "Authorization: Bearer $(octillion token)" "$OCTILLION_URL/mcp" ...
```

## Commands

| Command | What it does |
|---|---|
| `octillion login` | OAuth 2.0 Device Authorization Grant (RFC 8628) against Octillion's authorization server (Clerk). Shows the verification link and code, polls until you approve, stores the tokens. Asks for `user:org:read` (the org picker) when the server honours the picked organization (`org_claim` in `/api/cli/config`). |
| `octillion login --non-interactive` | Prints `{verification_uri_complete, user_code, expires_in, next_step}` as JSON and exits 0. Automatic when stdin is not a TTY or an agent is detected (`AI_AGENT`, `CLAUDECODE`, `CURSOR_AGENT`, `CODEX_SANDBOX`, `GEMINI_CLI`, ...). `--interactive` forces the waiting mode. |
| `octillion login --complete <handle>` | Finishes a non-interactive login: polls until approved, declined or expired, then stores the tokens. `--timeout <seconds>` returns exit 2 while still pending. |
| `octillion login --read` | Asks for read-only access (`octillion:read`), when the server offers Octillion's scopes. |
| `octillion whoami` | Calls the MCP `whoami` tool and prints the person, the workspace, what picked it (`X-Octillion-Org`, the sign-in, the default, or the key's own workspace) and the credential in use. |
| `octillion logout` | Revokes (best effort) and forgets the stored login for this server. |
| `octillion token` | Prints the current access token and nothing else, refreshing it first if it expired. |
| `octillion mcp-config <client>` | The connect snippet for `claude-code`, `codex`, `cursor`, `vscode` or `json`, from the server's catalog (`GET /api/connect`), else built in. Sign-in by default; with `OCTILLION_API_KEY` set (or `--api-key`), the variant that reads the variable. No snippet ever holds a key. |

`octillion keys` is not offered: the portal's API key endpoints take a portal session, not a CLI sign-in. Create keys
on the portal (Settings, API keys) at `$OCTILLION_URL/app/settings/api-keys`.

## Options and environment

| | |
|---|---|
| `--json` | Machine-readable output on every command (errors too: `{ok: false, error, message, next_step?, source?}`). |
| `--token <t>` | Use this token or API key. |
| `--url <url>` / `OCTILLION_URL` | The Octillion server (https, or a loopback address). A default can be set in this package's `package.json` (`"octillion": {"url": ...}`) before packing. |
| `--org <slug>` / `OCTILLION_ORG` | Act in another of your workspaces (`X-Octillion-Org`, sign-in only). |
| `OCTILLION_API_KEY` | A personal API key from the portal. |
| `OCTILLION_CLI_CLIENT_ID` | Override the CLI's OAuth client id (normally served by `GET /api/cli/config`). |
| `OCTILLION_CONFIG_DIR` | Where credentials live (default `$XDG_CONFIG_HOME/octillion`, else `~/.config/octillion`). |

**Credentials, first match wins:** `--token`, then `OCTILLION_API_KEY`, then the stored login
(`~/.config/octillion/credentials.json`, mode 0600, one entry per server). Every command and every error says which one
it used.

**Exit codes:** 0 ok, 1 error, 2 needs the user (sign in, approve the login, create a key).

## If device login is not enabled

`octillion login` reads the CLI's public OAuth client id from `GET $OCTILLION_URL/api/cli/config`. When the server has
none (`OCTILLION_CLI_CLIENT_ID` unset there), or the authorization server does not offer the device grant, it says so
and points to API keys: create one at `$OCTILLION_URL/app/settings/api-keys` and `export OCTILLION_API_KEY=<key>`.

## Development

```sh
npm test                                              # node --test, fake server and authorization server
node --no-experimental-require-module bin/octillion.js --help
npm pack                                              # the tarball to publish (publishing is a separate, manual step)
```

`package.json` has `"private": true` so nothing publishes it by accident: flip it to `false` (and choose a license)
when you are ready to publish.

Credentials are written atomically (a new 0600 temp file in the 0700 config directory, fsync'd, renamed over the old
one); pending device logins past their expiry are removed on every run. Requests that carry a token never follow a
redirect, and the token, device and revocation endpoints from the authorization server's metadata must be https
(loopback excepted).

The end-to-end run against the real server and a mock Clerk with the device grant is `scripts/smoke-agent-auth-p1.ts`,
part of `scripts/smoke.ts`.
