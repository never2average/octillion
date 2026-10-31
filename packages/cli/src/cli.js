// The octillion command: sign in to Octillion and use it from a terminal or an agent.
//
//   octillion login [--non-interactive | --complete <handle>] [--read]   OAuth Device Authorization Grant (RFC 8628)
//   octillion whoami                                                     who the MCP server says you are
//   octillion logout                                                     forget the stored sign-in
//   octillion token                                                      print the access token: $(octillion token)
//   octillion mcp-config <claude-code|codex|cursor|vscode|json>          the connect snippet for a client
//
// Credentials, first match wins: --token, then OCTILLION_API_KEY, then the stored sign-in
// (~/.config/octillion/credentials.json, mode 0600). Every command and error says which one it used.
// Output: --json on every command. Exit codes: 0 ok, 1 error, 2 needs the user (sign in, approve, create a key).
// Plain ESM with no dependencies (Node 20+): nothing here needs require(), so it loads with --no-experimental-require-module.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXIT = { OK: 0, ERROR: 1, NEEDS_USER: 2 };
const API_KEY_ENV = "OCTILLION_API_KEY";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** Environment variables agents set in the shells they run: login then prints JSON and returns instead of waiting. */
export const AGENT_ENV = ["AI_AGENT", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CURSOR_AGENT", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED",
  "GEMINI_CLI", "OPENCODE", "AMP_AGENT", "CLINE_ACTIVE", "GOOSE_TERMINAL", "REPL_ID"];
export const CLIENTS = ["claude-code", "codex", "cursor", "vscode", "json"];

export class CliError extends Error {
  /** @param {string} message @param {{ code?: string, exit?: number, next_step?: string, source?: string }} [o] */
  constructor(message, o = {}) {
    super(message);
    this.code = o.code ?? "error";
    this.exit = o.exit ?? EXIT.ERROR;
    this.next_step = o.next_step;
    this.source = o.source;
  }
}

// ---------- arguments ----------

const BOOL = new Set(["json", "non-interactive", "interactive", "read", "api-key", "help", "version"]);
const VALUE = new Set(["token", "url", "org", "complete", "timeout", "name", "expires"]);

/** argv -> { _: positionals, flags }. --flag=value and --flag value; unknown flags are an error. */
export function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") { out.flags.help = true; continue; }
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const eq = a.indexOf("=");
    const name = a.slice(2, eq === -1 ? undefined : eq);
    if (BOOL.has(name)) { out.flags[name] = true; continue; }
    if (!VALUE.has(name)) throw new CliError(`Unknown option --${name}. Run octillion --help.`, { code: "usage" });
    const v = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (v === undefined || v === "") throw new CliError(`--${name} needs a value.`, { code: "usage" });
    out.flags[name] = v;
  }
  return out;
}

// ---------- where things live ----------

export const configDir = (env = process.env) =>
  env.OCTILLION_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "octillion");
const credentialsFile = (env) => path.join(configDir(env), "credentials.json");
const pendingFile = (env, handle) => path.join(configDir(env), "pending", `${handle}.json`);

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch (e) { if (e.code === "ENOENT") return null; throw new CliError(`Could not read ${file}: ${e.message}`); }
}
/**
 * Written atomically, 0600 in a 0700 directory: a new temp file (wx: never an existing file or a planted symlink) in the
 * same directory, fsync'd, then renamed over the real one. A crash leaves the old file or the new one, never half of one.
 */
export async function writeSecret(file, data) {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fh = await open(tmp, "wx", 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(data, null, 2)}\n`);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try { await rename(tmp, file); } catch (e) { await rm(tmp, { force: true }); throw e; }
}

/** Pending device logins past their expiry (or unreadable) are deleted on every run: a device code outlives nothing. */
export async function cleanPending(env) {
  const dir = path.join(configDir(env), "pending");
  let names = [];
  try { names = await readdir(dir); } catch { return; }
  await Promise.all(names.filter((n) => n.endsWith(".json")).map(async (n) => {
    const f = path.join(dir, n);
    let exp = NaN;
    try { exp = Date.parse(JSON.parse(await readFile(f, "utf8")).expires_at); } catch { /* unreadable: remove */ }
    if (!(exp > Date.now())) await rm(f, { force: true }).catch(() => {});
  }));
}

async function packageDefaultUrl() {
  try {
    const pkg = JSON.parse(await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
    return typeof pkg.octillion?.url === "string" && pkg.octillion.url ? pkg.octillion.url : null;
  } catch { return null; }
}

/** The Octillion server: --url, OCTILLION_URL, the package's configured default. */
export async function baseUrl(flags, env = process.env) {
  const raw = flags.url || env.OCTILLION_URL || await packageDefaultUrl();
  if (!raw) throw new CliError("No Octillion server set. Set OCTILLION_URL to your Octillion address (e.g. export OCTILLION_URL=https://octillion.example.com), or pass --url.",
    { code: "no_url", next_step: "export OCTILLION_URL=<your Octillion address>" });
  let u;
  try { u = new URL(raw); } catch { throw new CliError(`OCTILLION_URL is not a URL: ${raw}`, { code: "bad_url" }); }
  if (u.protocol !== "https:" && !LOOPBACK.includes(u.hostname)) throw new CliError(`OCTILLION_URL must use https (got ${u.origin}).`, { code: "bad_url" });
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

// ---------- HTTP ----------

/** `secret`: the request carries a token, device code or refresh token, so a redirect is refused, never followed. */
async function request(url, init = {}) {
  let r;
  try {
    r = await fetch(url, { ...init, ...(init.secret ? { redirect: "manual" } : {}), signal: AbortSignal.timeout(init.timeoutMs ?? 20_000) });
  } catch (e) {
    throw new CliError(`Could not reach ${new URL(url).origin}: ${e.cause?.code ?? e.message}. Check OCTILLION_URL and your network.`, { code: "network" });
  }
  if (init.secret && (r.type === "opaqueredirect" || (r.status >= 300 && r.status < 400))) {
    throw new CliError(`${new URL(url).origin} answered with a redirect${r.headers.get("location") ? ` to ${r.headers.get("location")}` : ""}; a credential is never sent on to another address. Check OCTILLION_URL (use the final address).`, { code: "redirect" });
  }
  return r;
}
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];
/** An endpoint from the authorization server's metadata that tokens go to: https, or a loopback address. */
export function secureEndpoint(raw, what) {
  let u;
  try { u = new URL(raw); } catch { throw new CliError(`The authorization server's ${what} is not a URL.`, { code: "insecure_endpoint" }); }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.includes(u.hostname))) {
    throw new CliError(`The authorization server's ${what} (${u.origin}) is not https; refusing to send credentials to it.`, { code: "insecure_endpoint" });
  }
  return u.href;
}
const form = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== ""));
async function postForm(url, body) {
  const r = await request(secureEndpoint(url, "endpoint"), { method: "POST", secret: true, headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form(body) });
  const text = await r.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { error: "invalid_response", error_description: text.slice(0, 200) }; }
  return { status: r.status, ok: r.ok, json };
}

// ---------- credentials ----------

const sourceLabel = { flag: "--token", env: API_KEY_ENV, login: "stored login" };
export const describeSource = (s) => sourceLabel[s] ?? s;

async function loadProfile(env, base) {
  const all = await readJson(credentialsFile(env));
  return all?.profiles?.[base] ?? null;
}
async function saveProfile(env, base, profile) {
  const all = (await readJson(credentialsFile(env))) ?? {};
  const profiles = { ...(all.profiles ?? {}) };
  if (profile) profiles[base] = profile; else delete profiles[base];
  await writeSecret(credentialsFile(env), { version: 1, profiles });
}

/** A token response as a stored profile. */
function profileFrom(tok, meta) {
  return {
    access_token: tok.access_token, refresh_token: tok.refresh_token ?? meta.refresh_token ?? null, token_type: tok.token_type ?? "Bearer",
    scope: tok.scope ?? meta.scope ?? null, expires_at: tok.expires_in ? new Date(Date.now() + Number(tok.expires_in) * 1000).toISOString() : null,
    client_id: meta.client_id, token_endpoint: meta.token_endpoint, revocation_endpoint: meta.revocation_endpoint ?? null, issuer: meta.issuer ?? null,
    obtained_at: new Date().toISOString(),
  };
}

/** The stored sign-in, refreshed with its refresh token when it has expired (or is about to). */
async function storedToken(env, base) {
  const p = await loadProfile(env, base);
  if (!p?.access_token) return null;
  const expiring = p.expires_at && Date.parse(p.expires_at) - Date.now() < 60_000;
  if (!expiring) return p;
  if (!p.refresh_token || !p.token_endpoint) throw new CliError("Your stored login has expired. Run octillion login.", { code: "login_expired", exit: EXIT.NEEDS_USER, next_step: "octillion login", source: "login" });
  const r = await postForm(p.token_endpoint, { grant_type: "refresh_token", refresh_token: p.refresh_token, client_id: p.client_id });
  if (!r.ok || !r.json.access_token) {
    throw new CliError(`Your stored login has expired and could not be refreshed (${r.json.error ?? r.status}). Run octillion login.`,
      { code: "login_expired", exit: EXIT.NEEDS_USER, next_step: "octillion login", source: "login" });
  }
  const next = profileFrom(r.json, p);
  await saveProfile(env, base, next);
  return next;
}

/** --token, then OCTILLION_API_KEY, then the stored login. */
export async function resolveCredential(flags, env, base) {
  if (flags.token) return { source: "flag", token: flags.token };
  if (env[API_KEY_ENV]) return { source: "env", token: env[API_KEY_ENV].trim() };
  const p = await storedToken(env, base);
  if (p) return { source: "login", token: p.access_token, expires_at: p.expires_at };
  throw new CliError(`Not signed in to ${base}. Run octillion login, or set ${API_KEY_ENV} to a personal API key (create one at ${base}/app/settings/api-keys).`,
    { code: "not_signed_in", exit: EXIT.NEEDS_USER, next_step: "octillion login" });
}

// ---------- MCP ----------

/** The JSON-RPC message in a Streamable HTTP response: a JSON body, or the last `data:` line of an SSE stream. */
export function rpcMessage(contentType, text) {
  if (/text\/event-stream/i.test(contentType ?? "")) {
    const datas = text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean);
    for (let i = datas.length - 1; i >= 0; i--) { try { const m = JSON.parse(datas[i]); if (m.result || m.error) return m; } catch { /* keep looking */ } }
    return null;
  }
  try { return JSON.parse(text); } catch { return null; }
}

/** Call one MCP tool on <base>/mcp (stateless Streamable HTTP). Refusals become CliErrors carrying the server's next step. */
export async function callTool(base, cred, name, args = {}, { org } = {}) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", authorization: `Bearer ${cred.token}` };
  if (org) headers["x-octillion-org"] = org;
  const r = await request(`${base}/mcp`, { method: "POST", secret: true, headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const text = await r.text();
  const msg = rpcMessage(r.headers.get("content-type"), text);
  const via = `(credential: ${describeSource(cred.source)})`;
  if (!r.ok) {
    const serverMsg = msg?.error?.message ?? `HTTP ${r.status}`;
    const reason = msg?.error?.data?.reason ?? `http_${r.status}`;
    const needsUser = r.status === 401 || r.status === 403;
    const next = r.status === 401 ? (cred.source === "env" ? `Fix ${API_KEY_ENV}, or unset it and run octillion login` : cred.source === "flag" ? "Pass a valid --token" : "octillion login") : undefined;
    throw new CliError(`${serverMsg} ${via}`, { code: reason, exit: needsUser ? EXIT.NEEDS_USER : EXIT.ERROR, next_step: next, source: cred.source });
  }
  if (!msg) throw new CliError(`Unexpected answer from ${base}/mcp (${r.headers.get("content-type") ?? "no content type"}) ${via}`, { code: "bad_response", source: cred.source });
  if (msg.error) throw new CliError(`${msg.error.message} ${via}`, { code: "rpc_error", source: cred.source });
  return msg.result;
}

// ---------- discovery ----------

/** GET /api/cli/config: the CLI's OAuth client and the scopes to ask for (null on a server without it). */
async function cliConfig(base) {
  const r = await request(`${base}/api/cli/config`, { headers: { accept: "application/json" } });
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}
async function asMetadata(base) {
  const r = await request(`${base}/.well-known/oauth-authorization-server`, { headers: { accept: "application/json" } });
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}

function disabled(base, why) {
  return new CliError(`Device login is not enabled on ${base} yet (${why}). Use an API key instead: create one at ${base}/app/settings/api-keys, then export ${API_KEY_ENV}=<the key>.`,
    { code: "device_login_disabled", next_step: `Create a key at ${base}/app/settings/api-keys and export ${API_KEY_ENV}` });
}

// ---------- commands ----------

export const isAgent = (env) => AGENT_ENV.some((k) => env[k] && env[k] !== "0" && env[k] !== "false");

async function login(ctx) {
  const { flags, env, base, out } = ctx;
  if (flags.complete) return completeLogin(ctx, flags.complete);
  const cfg = await cliConfig(base);
  const clientId = (env.OCTILLION_CLI_CLIENT_ID || "").trim() || cfg?.client_id || null;
  if (!clientId) throw disabled(base, cfg ? "the server has no CLI OAuth client configured" : "the server does not offer CLI sign-in");
  const meta = await asMetadata(base);
  if (!meta?.device_authorization_endpoint || !meta?.token_endpoint) throw disabled(base, "the authorization server does not offer the device grant");
  secureEndpoint(meta.device_authorization_endpoint, "device authorization endpoint");
  secureEndpoint(meta.token_endpoint, "token endpoint");
  if (meta.revocation_endpoint) secureEndpoint(meta.revocation_endpoint, "revocation endpoint");
  let scope = (cfg?.scope || "profile email").split(/\s+/).filter(Boolean);
  // The server honours the sign-in's picked organization: ask for the org picker.
  if (cfg?.org_claim && !scope.includes("user:org:read")) scope.push("user:org:read");
  if (flags.read) {
    if (!scope.includes("octillion:read")) throw new CliError("--read needs the octillion:read scope, which this server does not offer yet. Use a read-only API key instead.", { code: "no_read_scope" });
    scope = scope.filter((s) => s !== "octillion:write");
  }
  const d = await postForm(meta.device_authorization_endpoint, { client_id: clientId, scope: scope.join(" ") });
  if (!d.ok || !d.json.device_code) throw new CliError(`The authorization server refused to start a device login: ${d.json.error_description ?? d.json.error ?? d.status}.`, { code: d.json.error ?? "device_start_failed" });
  const pending = {
    base, device_code: d.json.device_code, user_code: d.json.user_code, verification_uri: d.json.verification_uri, verification_uri_complete: d.json.verification_uri_complete ?? null,
    interval: Math.max(1, Number(d.json.interval ?? 5)), expires_at: new Date(Date.now() + Number(d.json.expires_in ?? 600) * 1000).toISOString(),
    client_id: clientId, token_endpoint: meta.token_endpoint, revocation_endpoint: meta.revocation_endpoint ?? null, issuer: meta.issuer ?? null, scope: scope.join(" "),
  };
  const nonInteractive = !flags.interactive && (flags["non-interactive"] || !process.stdin.isTTY || isAgent(env));
  if (nonInteractive) {
    // Stripe-style split: hand the user's part to whoever is driving, and finish with --complete.
    const handle = randomBytes(6).toString("hex");
    await writeSecret(pendingFile(env, handle), pending);
    out.json({ ok: true, status: "pending", verification_uri_complete: pending.verification_uri_complete ?? pending.verification_uri, verification_uri: pending.verification_uri,
      user_code: pending.user_code, expires_in: Number(d.json.expires_in ?? 600), next_step: `octillion login --complete ${handle}`,
      message: `Ask the user to open the link and approve (code ${pending.user_code}), then run: octillion login --complete ${handle}` });
    return EXIT.OK;
  }
  out.err(`To sign in to Octillion, open:\n\n  ${pending.verification_uri_complete ?? pending.verification_uri}\n\nand confirm the code ${pending.user_code}. Waiting…`);
  return poll(ctx, pending, null, { firstWait: true });
}

async function completeLogin(ctx, handle) {
  const { env } = ctx;
  if (!/^[a-f0-9]{6,32}$/.test(handle)) throw new CliError(`Not a login handle: ${handle}. Start again with octillion login.`, { code: "usage" });
  const pending = await readJson(pendingFile(env, handle));
  if (!pending) throw new CliError(`No pending login ${handle} (already finished, or it expired). Start again with octillion login.`, { code: "no_pending", exit: EXIT.NEEDS_USER, next_step: "octillion login" });
  return poll(ctx, pending, handle, { firstWait: false });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll the token endpoint (RFC 8628 §3.4-3.5) until approved, denied, expired, or --timeout. */
async function poll(ctx, pending, handle, { firstWait }) {
  const { flags, env, out } = ctx;
  let interval = pending.interval * 1000;
  const deadline = Math.min(Date.parse(pending.expires_at), flags.timeout ? Date.now() + Number(flags.timeout) * 1000 : Infinity);
  const again = handle ? `octillion login --complete ${handle}` : "octillion login";
  if (firstWait) await sleep(interval);
  for (;;) {
    const r = await postForm(pending.token_endpoint, { grant_type: DEVICE_GRANT, device_code: pending.device_code, client_id: pending.client_id });
    if (r.ok && r.json.access_token) {
      await saveProfile(env, pending.base, profileFrom(r.json, pending));
      if (handle) await rm(pendingFile(env, handle), { force: true });
      const result = { ok: true, status: "signed_in", source: "login", url: pending.base, credentials_file: credentialsFile(env), scope: r.json.scope ?? pending.scope };
      out.result(result, `Signed in to ${pending.base}. Stored in ${credentialsFile(env)} (credential: stored login). Check it with: octillion whoami`);
      if (env[API_KEY_ENV]) out.err(`Note: ${API_KEY_ENV} is set, and it comes before the stored login. Unset it to use this sign-in.`);
      return EXIT.OK;
    }
    const e = r.json.error;
    if (e === "slow_down") interval += 5000;
    else if (e === "access_denied") {
      if (handle) await rm(pendingFile(env, handle), { force: true });
      throw new CliError("The sign-in was declined. Run octillion login to try again.", { code: "access_denied", next_step: "octillion login" });
    } else if (e === "expired_token") {
      if (handle) await rm(pendingFile(env, handle), { force: true });
      throw new CliError("The sign-in code expired before it was approved. Run octillion login again.", { code: "expired_token", exit: EXIT.NEEDS_USER, next_step: "octillion login" });
    } else if (e !== "authorization_pending") {
      throw new CliError(`Sign-in failed: ${r.json.error_description ?? e ?? `HTTP ${r.status}`}.`, { code: e ?? "token_failed" });
    }
    if (Date.now() + interval > deadline) {
      const expired = Date.now() + interval >= Date.parse(pending.expires_at);
      if (expired) {
        if (handle) await rm(pendingFile(env, handle), { force: true });
        throw new CliError("The sign-in code expired before it was approved. Run octillion login again.", { code: "expired_token", exit: EXIT.NEEDS_USER, next_step: "octillion login" });
      }
      throw new CliError(`Still waiting for the user to approve (code ${pending.user_code} at ${pending.verification_uri_complete ?? pending.verification_uri}).`,
        { code: "authorization_pending", exit: EXIT.NEEDS_USER, next_step: again });
    }
    await sleep(interval);
  }
}

async function whoami(ctx) {
  const { flags, env, base, out } = ctx;
  const cred = await resolveCredential(flags, env, base);
  const res = await callTool(base, cred, "whoami", {}, { org: flags.org || env.OCTILLION_ORG });
  if (res.isError) throw new CliError(`${res.content?.[0]?.text ?? "whoami failed"} (credential: ${describeSource(cred.source)})`, { source: cred.source });
  const d = res.structuredContent ?? {};
  const person = d.person ? (d.person.email ?? d.person.name ?? d.person.user_id) : "no person (an account-wide key)";
  const picked = { header: "X-Octillion-Org", token: "the sign-in", default: "your oldest membership", key: "the API key's own workspace" }[d.org_source] ?? "unknown";
  const c = d.credential ?? {};
  const how = c.type === "oauth" ? `OAuth${c.client_id ? ` (client ${c.client_id})` : ""}${c.access === "read" ? ", read-only" : ""}`
    : c.type === "api_key" ? `API key "${c.name}" (${c.prefix}…, ${c.scope === "read" ? "read-only" : c.scope === "write" ? "read and write" : "full access"})` : "unknown";
  out.result({ ok: true, source: cred.source, source_label: describeSource(cred.source), url: base, person: d.person ?? null, org: d.org ?? null, org_source: d.org_source ?? null,
    role: d.role ?? null, credential: c },
  [`Person:     ${person}`, `Workspace:  ${d.org?.name} (${d.org?.slug}), picked by ${picked}`, ...(d.role ? [`Role:       ${d.role}`] : []),
    `Signed in:  ${how}`, `Credential: ${describeSource(cred.source)}`, `Server:     ${base}`].join("\n"));
  return EXIT.OK;
}

async function logout(ctx) {
  const { env, base, out } = ctx;
  const p = await loadProfile(env, base);
  if (p?.revocation_endpoint && (p.refresh_token || p.access_token)) {
    // Best effort (RFC 7009): the local copy goes either way.
    await postForm(p.revocation_endpoint, { token: p.refresh_token ?? p.access_token, client_id: p.client_id }).catch(() => null);
  }
  await saveProfile(env, base, null);
  const still = env[API_KEY_ENV] ? ` ${API_KEY_ENV} is still set and is still used: unset it to sign out completely.` : "";
  out.result({ ok: true, status: p ? "signed_out" : "not_signed_in", url: base, api_key_env_set: Boolean(env[API_KEY_ENV]) },
    `${p ? `Signed out of ${base}.` : `No stored login for ${base}.`}${still}`);
  return EXIT.OK;
}

async function token(ctx) {
  const { flags, env, base, out } = ctx;
  const cred = await resolveCredential(flags, env, base);
  if (ctx.json) out.json({ ok: true, token: cred.token, source: cred.source, source_label: describeSource(cred.source), expires_at: cred.expires_at ?? null });
  else out.raw(`${cred.token}\n`); // nothing else on stdout, so $(octillion token) is the token
  return EXIT.OK;
}

/** Built in, for servers without GET /api/connect: the same shapes as src/connect-catalog.ts. */
export function builtinConnect(mcpUrl) {
  const json = (v) => JSON.stringify(v, null, 2);
  const cursorConfig = Buffer.from(JSON.stringify({ url: mcpUrl })).toString("base64");
  return {
    mcp_url: mcpUrl,
    one_command: [
      { id: "claude-code", command: `claude mcp add --transport http octillion ${mcpUrl}`, then: "claude mcp login octillion" },
      { id: "codex", command: `codex mcp add octillion --url ${mcpUrl}`, then: "codex mcp login octillion" },
      { id: "cursor", install_url: `cursor://anysphere.cursor-deeplink/mcp/install?name=octillion&config=${encodeURIComponent(cursorConfig)}` },
      { id: "vscode", install_url: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: "octillion", type: "http", url: mcpUrl }))}` },
    ],
    clients: [
      { id: "cursor", file: "~/.cursor/mcp.json", snippet: json({ mcpServers: { octillion: { url: mcpUrl } } }) },
      { id: "vscode", file: ".vscode/mcp.json", snippet: json({ servers: { octillion: { type: "http", url: mcpUrl } } }) },
      { id: "codex", file: "~/.codex/config.toml", snippet: `[mcp_servers.octillion]\nurl = "${mcpUrl}"` },
    ],
    headless: [
      { id: "claude-code", command: `claude mcp add --transport http octillion ${mcpUrl} --header "Authorization: Bearer \${${API_KEY_ENV}}"` },
      { id: "claude-code-json", file: ".mcp.json", snippet: json({ mcpServers: { octillion: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer \${${API_KEY_ENV}}` } } } }) },
      { id: "codex", file: "~/.codex/config.toml", snippet: `[mcp_servers.octillion]\nurl = "${mcpUrl}"\nbearer_token_env_var = "${API_KEY_ENV}"` },
      { id: "cursor", file: ".cursor/mcp.json", snippet: json({ mcpServers: { octillion: { url: mcpUrl, headers: { Authorization: `Bearer \${env:${API_KEY_ENV}}` } } } }) },
    ],
  };
}

/** One client's snippet from a catalog: `key` mode reads OCTILLION_API_KEY, sign-in mode has no secret at all. */
export function pickSnippet(catalog, client, mode) {
  const url = catalog.mcp_url;
  const find = (list, id) => (list ?? []).find((x) => x.id === id);
  const one = (id) => find(catalog.one_command, id), cl = (id) => find(catalog.clients, id), hl = (id) => find(catalog.headless, id);
  const json = (v) => JSON.stringify(v, null, 2);
  if (client === "json") {
    return { file: "mcp.json (any client that takes the common mcpServers shape)",
      snippet: json({ mcpServers: { octillion: { type: "http", url, ...(mode === "key" ? { headers: { Authorization: `Bearer \${${API_KEY_ENV}}` } } : {}) } } }) };
  }
  if (mode === "key") {
    if (client === "claude-code") { const c = hl("claude-code"), j = hl("claude-code-json"); return { command: c?.command, file: j?.file, snippet: j?.snippet }; }
    if (client === "codex") { const c = hl("codex"); return { file: c?.file, snippet: c?.snippet }; }
    if (client === "cursor") { const c = hl("cursor"); return { file: c?.file, snippet: c?.snippet }; }
    // VS Code prompts for the key once and stores it (input variables), so the file holds no secret.
    return { file: ".vscode/mcp.json", snippet: json({ inputs: [{ type: "promptString", id: "octillion-api-key", description: "Octillion API key", password: true }],
      servers: { octillion: { type: "http", url, headers: { Authorization: "Bearer ${input:octillion-api-key}" } } } }) };
  }
  const o = one(client), c = cl(client);
  if (client === "claude-code") return { command: o?.command, then: o?.then };
  if (client === "codex") return { command: o?.command, then: o?.then, file: c?.file, snippet: c?.snippet };
  if (client === "cursor") return { install_url: o?.install_url, file: c?.file, snippet: c?.snippet };
  return { install_url: o?.install_url, command: c?.command, file: c?.file, snippet: c?.snippet };
}

async function mcpConfig(ctx) {
  const { flags, env, base, out } = ctx;
  const client = ctx.args[0];
  if (!client || !CLIENTS.includes(client)) throw new CliError(`Name a client: octillion mcp-config <${CLIENTS.join("|")}>.`, { code: "usage" });
  const mode = flags["api-key"] || env[API_KEY_ENV] || flags.token ? "key" : "signin";
  let catalog = null, from = "server";
  try {
    const r = await request(`${base}/api/connect`, { headers: { accept: "application/json" } });
    if (r.ok) catalog = await r.json();
  } catch { /* offline: built in */ }
  if (!catalog?.mcp_url) { catalog = builtinConnect(`${base}/mcp`); from = "built-in"; }
  const s = pickSnippet(catalog, client, mode);
  const why = mode === "key" ? `reads ${API_KEY_ENV} (create a key at ${base}/app/settings/api-keys); no key is written into it` : "signs in with your Octillion account (OAuth); no secret in it";
  const lines = [`# ${client}: ${why}`];
  if (s.install_url) lines.push(`Install link: ${s.install_url}`);
  if (s.command) lines.push(s.command);
  if (s.then) lines.push(s.then);
  if (s.snippet) lines.push(`${s.command || s.install_url ? "\n# or add to" : "# in"} ${s.file}:`, s.snippet);
  out.result({ ok: true, client, mode, url: catalog.mcp_url, from, ...s }, lines.join("\n"));
  return EXIT.OK;
}

const HELP = `octillion: use Octillion from a terminal or an agent

Usage:
  octillion login                      sign in in the browser (OAuth device login)
  octillion login --non-interactive    print the sign-in link as JSON and return (automatic for agents and non-TTY stdin)
  octillion login --complete <handle>  finish a non-interactive login (waits for approval; --timeout <s>)
  octillion whoami                     who the server says you are, which workspace, which credential
  octillion logout                     forget the stored login
  octillion token                      print the current access token, e.g. Authorization: Bearer $(octillion token)
  octillion mcp-config <client>        connect snippet: ${CLIENTS.join(", ")} (--api-key for the OCTILLION_API_KEY variant)

Options:
  --json             machine-readable output on every command
  --token <t>        use this token or API key (before ${API_KEY_ENV} and the stored login)
  --url <url>        the Octillion server (default: OCTILLION_URL)
  --org <slug>       act in another of your workspaces (X-Octillion-Org; or OCTILLION_ORG)
  --read             login: ask for read-only access (when the server offers octillion:read)

Credentials, first match wins: --token, ${API_KEY_ENV}, the stored login (~/.config/octillion/credentials.json).
Exit codes: 0 ok, 1 error, 2 needs you (sign in, approve, create a key).`;

/** Run one command. Returns the exit code; writes only to the streams given (tests pass their own). */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const stdout = io.stdout ?? process.stdout, stderr = io.stderr ?? process.stderr;
  let parsed;
  const wantsJson = argv.includes("--json");
  const out = {
    json: (o) => stdout.write(`${JSON.stringify(o, null, 2)}\n`),
    raw: (s) => stdout.write(s),
    err: (s) => stderr.write(`${s}\n`),
    result: (o, text) => (wantsJson ? stdout.write(`${JSON.stringify(o, null, 2)}\n`) : stdout.write(`${text}\n`)),
  };
  try {
    parsed = parseArgs(argv);
    const [cmd, ...args] = parsed._;
    if (parsed.flags.version) { const pkg = JSON.parse(await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")); out.result({ ok: true, version: pkg.version }, pkg.version); return EXIT.OK; }
    if (!cmd || parsed.flags.help || cmd === "help") { out.result({ ok: true, commands: ["login", "whoami", "logout", "token", "mcp-config"] }, HELP); return cmd || parsed.flags.help ? EXIT.OK : EXIT.ERROR; }
    const commands = { login, whoami, logout, token, "mcp-config": mcpConfig };
    if (cmd === "keys") {
      throw new CliError("octillion keys is not available: the portal's key API takes a portal session, not a CLI sign-in. Create keys on the portal's API keys page (Settings, API keys).",
        { code: "not_supported", next_step: "Open <OCTILLION_URL>/app/settings/api-keys" });
    }
    const run = commands[cmd];
    if (!run) throw new CliError(`Unknown command ${cmd}. Run octillion --help.`, { code: "usage" });
    await cleanPending(env);
    const base = await baseUrl(parsed.flags, env);
    return await run({ flags: parsed.flags, args, env, base, out, json: wantsJson });
  } catch (e) {
    const err = e instanceof CliError ? e : new CliError(e?.message ?? String(e));
    if (wantsJson) out.json({ ok: false, error: err.code, message: err.message, ...(err.next_step ? { next_step: err.next_step } : {}), ...(err.source ? { source: err.source, source_label: describeSource(err.source) } : {}) });
    else out.err(`octillion: ${err.message}${err.next_step ? `\nNext: ${err.next_step}` : ""}`);
    return err.exit;
  }
}
