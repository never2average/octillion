/**
 * Octillion reference orchestrator worker.
 *
 * Claims queued agent sessions from the Octillion server, runs the requested coding-agent
 * harness (Claude Code / Codex CLI) headless in a sandbox, streams raw JSONL stdout to the
 * server in ~2s batches, heartbeats, enforces a max duration and reports completion.
 *
 * BLINDNESS: the sub-agent receives exactly `job.prompt` (+ optional starter repo). No customer
 * identity, session id, Octillion URL or worker token is ever placed in the sandbox.
 *
 * Runners: `boat` (default; one boat.dev VM per session over its REST API), `docker`, `local` (dev).
 *
 * Node built-ins only. Run: `npx tsx orchestrator/worker.ts`
 */
import { spawn, type ChildProcess } from "node:child_process";
import { PassThrough, type Readable } from "node:stream";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------- config

const env = process.env;
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

const CFG = {
  url: (env.OCTILLION_URL ?? "http://localhost:3000").replace(/\/+$/, ""),
  token: env.OCTILLION_WORKER_TOKEN ?? "",
  workerId: env.WORKER_ID ?? `${hostname()}-${process.pid}`,
  concurrency: Math.max(1, num(env.WORKER_CONCURRENCY, 2)),
  runner: (env.RUNNER ?? "boat") as "boat" | "docker" | "local",
  maxSessionMs: num(env.MAX_SESSION_MINUTES, 45) * 60_000,
  pollMs: num(env.POLL_INTERVAL_SECONDS, 5) * 1000,
  flushMs: num(env.FLUSH_INTERVAL_MS, 2000),
  heartbeatMs: num(env.HEARTBEAT_SECONDS, 60) * 1000,
  models: env.WORKER_MODELS ? env.WORKER_MODELS.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
  harness: env.WORKER_HARNESS || undefined,
  dockerImage: env.SANDBOX_IMAGE ?? "octillion-sandbox:latest",
  dockerNetwork: env.DOCKER_NETWORK || undefined, // e.g. a bridge network with egress filtering
  dockerCpus: env.DOCKER_CPUS ?? "2",
  dockerMemory: env.DOCKER_MEMORY ?? "4g",
  anthropicKey: env.ANTHROPIC_API_KEY ?? "",
  openaiKey: env.OPENAI_API_KEY ?? env.CODEX_API_KEY ?? "",
  maxBudgetUsd: env.MAX_BUDGET_USD || undefined, // Claude Code --max-budget-usd per session
  claudeBin: env.CLAUDE_BIN ?? "claude",
  codexBin: env.CODEX_BIN ?? "codex",
};

/** boat.dev (https://docs.boat.dev/api/v1). Only used by RUNNER=boat. */
const BOAT = {
  apiUrl: (env.BOAT_API_URL ?? "https://boat.dev/api/v1").replace(/\/+$/, ""),
  apiKey: env.BOAT_API_KEY ?? "",
  size: env.BOAT_SANDBOX_SIZE ?? "default", // small | default | large | xlarge
  org: env.BOAT_ORG || undefined, // bill an organization wallet instead of the key's active wallet
  // Auto-stop TTL counts from creation and is NOT extended by exec'd work, so it must cover setup + the run.
  ttlSeconds: Math.round(CFG.maxSessionMs / 1000) + num(env.BOAT_TTL_MARGIN_MINUTES, 15) * 60,
  readyTimeoutMs: num(env.BOAT_READY_TIMEOUT_SECONDS, 300) * 1000,
  // "agent": run the harness as a fresh unprivileged `agent` user (default, most blind);
  // "user": run as Boat's default sandbox user with a fresh HOME (has passwordless sudo).
  agentUser: (env.BOAT_AGENT_USER === "user" ? "user" : "agent") as "agent" | "user",
  onFinish: (env.BOAT_ON_FINISH === "stop" ? "stop" : "delete") as "delete" | "stop",
  diffMaxBytes: num(env.BOAT_DIFF_MAX_BYTES, 2_000_000),
};
/** $/hour per size, from https://docs.boat.dev/pricing (2026-10). Used for an estimate in /complete metadata only. */
const BOAT_PRICE_PER_HOUR: Record<string, number> = { small: 0.018, default: 0.036, large: 0.072, xlarge: 0.2 };

// ---------------------------------------------------------------- types

interface Job {
  session_id: string;
  simulation_id: string;
  model: string;
  harness: string;
  attempt: number;
  prompt: string;
  repo_url: string | null;
  language: string | null;
}

type Harness = "claude-code" | "codex";

/** Everything a runner needs. Deliberately excludes session/simulation ids and server credentials. */
interface RunSpec {
  harness: Harness;
  model: string;
  prompt: string;
  repoUrl: string | null;
}

interface RunExit { code: number | null; signal: string | null; error?: string }

interface RunHandle {
  sandboxId: string;
  /** Harness stdout: one JSON event per line (runners may append synthetic events, e.g. the git diff). */
  stdout: Readable;
  stderr: Readable;
  /** Resolves when the harness has exited and stdout/stderr have ended. Never rejects. */
  exited: Promise<RunExit>;
  /** Hard-stop the sandbox (idempotent). */
  kill(): Promise<void>;
  /** Free resources after exit (idempotent). */
  cleanup(): Promise<void>;
  /** Extra runner metadata for /complete (read after cleanup). */
  meta?(): Record<string, unknown>;
}

function childHandle(sandboxId: string, child: ChildProcess, kill: () => Promise<void>, cleanup: () => Promise<void>): RunHandle {
  const exited = new Promise<RunExit>((resolve) => {
    child.on("error", (e) => resolve({ code: null, signal: null, error: String(e) }));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  return { sandboxId, stdout: child.stdout!, stderr: child.stderr!, exited, kill, cleanup };
}

interface Runner {
  name: string;
  start(spec: RunSpec): Promise<RunHandle>;
}

// ---------------------------------------------------------------- harness command lines

function normalizeHarness(h: string): Harness | null {
  const k = h.toLowerCase().replace(/[_\s]/g, "-");
  if (k === "claude-code" || k === "claude" || k === "claudecode") return "claude-code";
  if (k === "codex" || k === "codex-cli") return "codex";
  return null;
}

/**
 * argv for the agent CLI. The prompt is fed on stdin (avoids shell quoting / argv limits and
 * prompts that start with "-"), so it is byte-for-byte the scenario prompt with nothing added.
 *  - claude: `-p` with no positional prompt reads stdin.
 *  - codex:  `exec -` reads the prompt from stdin.
 */
function harnessArgv(spec: RunSpec, workdir: string): string[] {
  if (spec.harness === "claude-code") {
    const a = [
      CFG.claudeBin, "-p",
      "--output-format", "stream-json",
      "--verbose", // required by stream-json in print mode
      "--model", spec.model,
      "--dangerously-skip-permissions", // we are the sandbox
      "--no-session-persistence",
    ];
    if (CFG.maxBudgetUsd) a.push("--max-budget-usd", CFG.maxBudgetUsd);
    return a;
  }
  return [
    CFG.codexBin, "exec",
    "--json",
    "--model", spec.model,
    "--dangerously-bypass-approvals-and-sandbox", // no approvals, no inner landlock/seatbelt sandbox: we are the sandbox
    "--skip-git-repo-check",
    "--ephemeral",
    "--color", "never",
    "-C", workdir,
    "-",
  ];
}

/** Env passed into the sandbox: API key for the harness only, nothing Octillion-specific. */
function harnessEnv(spec: RunSpec): Record<string, string> {
  const e: Record<string, string> = {
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    NO_COLOR: "1",
    CI: "1",
  };
  if (spec.harness === "claude-code") e.ANTHROPIC_API_KEY = CFG.anthropicKey;
  else e.CODEX_API_KEY = CFG.openaiKey; // codex exec reads CODEX_API_KEY for API-key auth
  return e;
}

// ---------------------------------------------------------------- runners

function sh(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", (e) => resolve({ code: -1, out: String(e) }));
    p.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

const WORKDIR_IN_CONTAINER = "/home/agent/work";

/** Docker: one throwaway container per session from SANDBOX_IMAGE (see Dockerfile.sandbox). */
const dockerRunner: Runner = {
  name: "docker",
  async start(spec) {
    const name = `octi-${randomUUID().slice(0, 12)}`; // not derived from session id; container can't see it anyway
    const henv = harnessEnv(spec);
    const args = [
      "run", "--rm", "-i", "--init",
      "--name", name,
      "--label", "octillion.sandbox=1",
      "--cpus", CFG.dockerCpus,
      "--memory", CFG.dockerMemory,
      "--pids-limit", "1024",
      "--security-opt", "no-new-privileges",
      "--cap-drop", "ALL",
      "-w", WORKDIR_IN_CONTAINER,
    ];
    if (CFG.dockerNetwork) args.push("--network", CFG.dockerNetwork);
    // Pass secrets by name (-e KEY) so values don't show up in `ps` output.
    for (const k of Object.keys(henv)) args.push("-e", k);
    if (spec.repoUrl) args.push("-e", "OCTI_REPO_URL");
    // Clone (optional), then exec the harness; stdin (the prompt) flows through to it.
    const script = [
      "set -e",
      `mkdir -p ${WORKDIR_IN_CONTAINER} && cd ${WORKDIR_IN_CONTAINER}`,
      'if [ -n "${OCTI_REPO_URL:-}" ]; then git clone --depth 1 -q "$OCTI_REPO_URL" . </dev/null 1>&2; fi',
      'exec "$@"',
    ].join("\n");
    const argv = harnessArgv(spec, WORKDIR_IN_CONTAINER);
    argv[0] = spec.harness === "claude-code" ? "claude" : "codex"; // CLAUDE_BIN/CODEX_BIN are host-only overrides
    args.push(CFG.dockerImage, "bash", "-c", script, "octi", ...argv);
    const child = spawn("docker", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...henv, ...(spec.repoUrl ? { OCTI_REPO_URL: spec.repoUrl } : {}) },
    });
    child.stdin!.end(spec.prompt);
    let killed = false;
    return childHandle(
      `docker:${name}`,
      child,
      async () => {
        if (killed) return;
        killed = true;
        await sh("docker", ["rm", "-f", name]);
        child.kill("SIGKILL");
      },
      async () => {
        await sh("docker", ["rm", "-f", name]); // --rm normally handles it; belt and braces
      },
    );
  },
};

/**
 * Local: spawns the CLI on the host in a fresh temp dir. DEV ONLY - no isolation.
 * HOME / CODEX_HOME point at an empty temp dir so the agent doesn't pick up the developer's
 * ~/.claude or ~/.codex config, CLAUDE.md, memories, MCP servers, etc. (would break blindness).
 */
const localRunner: Runner = {
  name: "local",
  async start(spec) {
    const root = await mkdtemp(join(tmpdir(), "agent-"));
    const work = join(root, "work");
    const home = join(root, "home");
    await mkdir(work, { recursive: true });
    await mkdir(join(home, ".codex"), { recursive: true });
    const baseEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      LANG: process.env.LANG ?? "C.UTF-8",
      TERM: "dumb",
      HOME: home,
      CODEX_HOME: join(home, ".codex"),
      TMPDIR: root,
      ...harnessEnv(spec),
    };
    if (spec.repoUrl) {
      const r = await sh("git", ["clone", "--depth", "1", "-q", spec.repoUrl, work], { env: baseEnv });
      if (r.code !== 0) {
        await rm(root, { recursive: true, force: true });
        throw new Error(`git clone failed: ${r.out.slice(-500)}`);
      }
    }
    const [cmd, ...args] = harnessArgv(spec, work);
    const child = spawn(cmd!, args, { cwd: work, env: baseEnv, stdio: ["pipe", "pipe", "pipe"], detached: true });
    child.stdin!.end(spec.prompt);
    const killGroup = () => {
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    };
    return childHandle(
      `local:${root}`,
      child,
      async () => { killGroup(); },
      async () => { killGroup(); await rm(root, { recursive: true, force: true }).catch(() => {}); },
    );
  },
};

// ---------------------------------------------------------------- boat.dev runner
//
// One fresh boat.dev VM per session, driven over the REST API (https://docs.boat.dev/api/v1):
//   POST /sandboxes {type, ttlSeconds, noEnv:true, snapshots:false}   (Idempotency-Key)
//   GET  /sandboxes/{id}                       poll until state ready|idle|running
//   PUT  /sandboxes/{id}/files                 prompt, env, scripts -> /tmp/octi (mode 700)
//   POST /sandboxes/{id}/commands              prepare (sync), launch harness (detached),
//                                              tail its JSONL (stream:true, NDJSON frames), git diff
//   GET  /sandboxes/{id}/commands/{processId}  is the harness still running?
//   DELETE /sandboxes/{id} + X-Ascii-Confirm-Delete   force-stop + permanently delete (finally)
//
// We do NOT use Boat's managed `POST /prompt` + `GET /events`: Boat adds its own system prompt, a `boat`
// skill and a `computer` MCP server to its managed harnesses (breaks blindness), and its events are a
// normalized format without Claude's `result` usage/cost. Instead we exec the stock `claude`/`codex` CLI
// that Boat preinstalls, as an isolated user under `env -i`, and stream its native JSONL.

class HttpError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}

class BoatError extends HttpError {
  constructor(status: number, public code: string, msg: string, public retryable?: boolean) { super(status, msg); }
}

const boatSandboxPath = (id: string) => `/sandboxes/${encodeURIComponent(id)}`;

function boatHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${BOAT.apiKey}`, ...extra };
}

async function boatErrorFrom(res: Response, what: string): Promise<BoatError> {
  const text = await res.text().catch(() => "");
  let d: any = null;
  try { d = JSON.parse(text); } catch { /* not JSON */ }
  const code = String(d?.code ?? d?.error?.code ?? "");
  const msg = d?.message ?? d?.error?.message ?? text.slice(0, 300);
  return new BoatError(res.status, code, `boat ${what} -> ${res.status} ${code}: ${msg}`, d?.error?.details?.retryable);
}

async function boatApi(path: string, init: { method?: string; json?: unknown; headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<any> {
  const method = init.method ?? "GET";
  const headers = boatHeaders(init.headers);
  let body: string | undefined;
  if (init.json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(init.json); }
  const signals = [AbortSignal.timeout(init.timeoutMs ?? 60_000)];
  if (init.signal) signals.push(init.signal);
  const res = await fetch(BOAT.apiUrl + path, { method, headers, body, signal: AbortSignal.any(signals) });
  if (!res.ok) throw await boatErrorFrom(res, `${method} ${path}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Retry a command call only when Boat says it provably did not run (still starting / restoring / rate limited). */
async function boatCommandRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      const safe = e instanceof BoatError &&
        ((e.status === 409 && /starting/.test(e.code)) || (e.status === 502 && e.retryable === true) || e.status === 429);
      if (!safe || i >= 20) throw e;
      await sleep(3000);
    }
  }
}

/** Synchronous command (<= 600s). Boat may truncate long output (stdoutTruncated). */
async function boatExec(id: string, command: string, timeoutSeconds = 120): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const r = await boatCommandRetry(() => boatApi(`${boatSandboxPath(id)}/commands`, {
    method: "POST", json: { command, timeoutSeconds }, timeoutMs: (timeoutSeconds + 60) * 1000,
  }));
  return { exitCode: r?.exitCode ?? null, stdout: r?.stdout ?? "", stderr: r?.stderr ?? "" };
}

/**
 * Streamed command: POST /commands {stream:true} answers application/x-ndjson frames:
 * {"type":"started"}, {"type":"stdout"|"stderr","data":"..."}..., then {"type":"exit",exitCode,...} or {"type":"error",...}.
 */
async function boatExecStream(
  id: string, command: string, timeoutSeconds: number,
  onStdout: (s: string) => void, onStderr: (s: string) => void, signal?: AbortSignal,
): Promise<{ exitCode: number | null }> {
  const signals = [AbortSignal.timeout((timeoutSeconds + 60) * 1000)];
  if (signal) signals.push(signal);
  const res = await boatCommandRetry(async () => {
    const r = await fetch(`${BOAT.apiUrl}${boatSandboxPath(id)}/commands`, {
      method: "POST",
      headers: boatHeaders({ "Content-Type": "application/json", Accept: "application/x-ndjson" }),
      body: JSON.stringify({ command, timeoutSeconds, stream: true }),
      signal: AbortSignal.any(signals),
    });
    if (!r.ok) throw await boatErrorFrom(r, "POST commands(stream)");
    return r;
  });
  if (!(res.headers.get("content-type") ?? "").includes("ndjson")) { // server answered with the sync JSON result
    const d: any = await res.json();
    onStdout(d?.stdout ?? ""); onStderr(d?.stderr ?? "");
    return { exitCode: d?.exitCode ?? null };
  }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let exitCode: number | null = null;
  const frame = (line: string) => {
    if (!line.trim()) return;
    let f: any;
    try { f = JSON.parse(line); } catch { return; }
    if (f.type === "stdout") onStdout(String(f.data ?? ""));
    else if (f.type === "stderr") onStderr(String(f.data ?? ""));
    else if (f.type === "exit") exitCode = f.exitCode ?? null;
    else if (f.type === "error") throw new BoatError(502, String(f.error ?? "stream_error"), `boat command stream error: ${f.message ?? f.error}`, f.retryable);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) { frame(buf.slice(0, i)); buf = buf.slice(i + 1); }
  }
  frame(buf + dec.decode());
  return { exitCode };
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const BOAT_DIR = "/tmp/octi"; // worker-private staging dir on the VM (mode 700, Boat's user; the agent user can't read it)
const BOAT_AGENT_HOME = "/home/agent"; // same paths as the docker runner
const BOAT_WORKDIR = `${BOAT_AGENT_HOME}/work`;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const TAIL_SECONDS = 540; // each streamed tail call stays under the 600s command cap, then reconnects

function boatRunAs(): string {
  return BOAT.agentUser === "agent" ? "sudo -n -u agent -H" : "";
}

function boatPrepareScript(spec: RunSpec): string {
  const bin = spec.harness === "claude-code" ? "claude" : "codex";
  const clone = spec.repoUrl
    ? `$RUN git clone --depth 1 -q ${shq(spec.repoUrl)} "$W" </dev/null\n$RUN git -C "$W" rev-parse HEAD > "$O/base"`
    : ":";
  return `set -euo pipefail
cd /
O=${BOAT_DIR}; AH=${BOAT_AGENT_HOME}; W=${BOAT_WORKDIR}
if [ ${shq(BOAT.agentUser)} = agent ]; then
  id -u agent >/dev/null 2>&1 || sudo -n useradd -m -s /bin/bash agent
  OWNER=agent
else
  sudo -n mkdir -p "$AH"; sudo -n chown "$(id -un):" "$AH"
  OWNER=$(id -un)
fi
RUN="${boatRunAs()}"
# Agent PATH: system dirs + wherever the preinstalled tools live, never Boat's own home dir.
P=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
for b in claude codex node npm npx git python3 pip3 uv; do
  d=$(bash -lc "command -v $b" 2>/dev/null | head -n1 || true)
  case "$d" in /*) d=$(dirname "$d");; *) continue;; esac
  case "$d" in /home/*|/root*) continue;; esac
  case ":$P:" in *":$d:"*) ;; *) P="$P:$d";; esac
done
echo "$AH/.npm-global/bin:$AH/.local/bin:$P" > "$O/path"
$RUN mkdir -p "$W" "$AH/.npm-global" "$AH/.codex"
sudo -n install -o "$OWNER" -m 600 "$O/env" "$AH/.octi-env"
rm -f "$O/env"
${clone}
$RUN env -i HOME="$AH" PATH="$(cat "$O/path")" bash -c 'command -v ${bin}' >/dev/null || { echo "${bin} is not on the agent PATH ($(cat "$O/path")); try BOAT_AGENT_USER=user" >&2; exit 127; }
`;
}

function boatLaunchScript(spec: RunSpec): string {
  const argv = harnessArgv(spec, BOAT_WORKDIR);
  argv[0] = spec.harness === "claude-code" ? "claude" : "codex"; // CLAUDE_BIN/CODEX_BIN are host-only overrides
  const hardLimit = Math.ceil(CFG.maxSessionMs / 1000) + 60; // the worker kills first; this is belt and braces
  return `cd /
O=${BOAT_DIR}; AH=${BOAT_AGENT_HOME}
U=${BOAT.agentUser === "agent" ? "agent" : "$(id -un)"}
${boatRunAs()} env -i HOME="$AH" USER="$U" LOGNAME="$U" SHELL=/bin/bash LANG=C.UTF-8 TERM=dumb PATH="$(cat "$O/path")" \\
  bash -c 'set -a; . "$HOME/.octi-env"; set +a; rm -f "$HOME/.octi-env"; cd "$HOME/work" && exec timeout -k 30 ${hardLimit} "$@"' octi ${argv.map(shq).join(" ")} \\
  < "$O/prompt.txt" > "$O/out.jsonl" 2> "$O/err.log"
c=$?
echo "$c" > "$O/exit"
exit "$c"
`;
}

/** Diff of everything the agent changed: vs the cloned commit, or (no repo) vs an empty tree via a git dir outside the workdir. */
function boatDiffScript(): string {
  const inner = `cd "$HOME/work" 2>/dev/null || exit 0
G="git -c core.quotepath=off -c safe.directory=*"
if [ -d .git ]; then
  $G add -A >/dev/null 2>&1
  $G diff --cached --no-color --no-ext-diff "\${BASE:-${EMPTY_TREE}}"
else
  export GIT_DIR=/tmp/.octi-snap.git GIT_WORK_TREE="$HOME/work"
  rm -rf "$GIT_DIR"; git init -q
  printf "node_modules/\\n.venv/\\nvenv/\\n__pycache__/\\n" > "$GIT_DIR/info/exclude"
  $G add -A >/dev/null 2>&1
  $G diff --cached --no-color --no-ext-diff ${EMPTY_TREE}
fi`;
  return `cd /
${boatRunAs()} env -i HOME=${BOAT_AGENT_HOME} PATH="$(cat ${BOAT_DIR}/path)" BASE="$(cat ${BOAT_DIR}/base 2>/dev/null)" bash -c ${shq(inner)} | head -c ${BOAT.diffMaxBytes + 1}
`;
}

function boatEnvFile(spec: RunSpec): string {
  const e: Record<string, string> = {
    ...harnessEnv(spec),
    NPM_CONFIG_PREFIX: `${BOAT_AGENT_HOME}/.npm-global`,
    PIP_BREAK_SYSTEM_PACKAGES: "1",
    CODEX_HOME: `${BOAT_AGENT_HOME}/.codex`,
  };
  return Object.entries(e).map(([k, v]) => `${k}=${shq(v)}`).join("\n") + "\n";
}

const boatRunner: Runner = {
  name: "boat",
  async start(spec) {
    const idemKey = randomUUID(); // same key on retries -> a lost response never creates a second billable VM
    const created = await withRetry(async () => {
      try {
        return await boatApi("/sandboxes", {
          method: "POST",
          headers: { "Idempotency-Key": idemKey },
          json: { type: BOAT.size, ttlSeconds: BOAT.ttlSeconds, noEnv: true, snapshots: false, ...(BOAT.org ? { org: BOAT.org } : {}) },
          timeoutMs: 120_000,
        });
      } catch (e) {
        if (e instanceof BoatError && e.code === "idempotency_in_progress") throw new HttpError(503, e.message); // retryable
        throw e;
      }
    });
    const id: string = created?.sandbox?.id;
    if (!id) throw new Error(`boat create returned no sandbox id: ${JSON.stringify(created).slice(0, 300)}`);
    const createdAt = Date.now();
    let destroyedAt: number | null = null;
    let destroying: Promise<void> | null = null;
    const abort = new AbortController();

    const destroy = () => (destroying ??= (async () => {
      abort.abort();
      try {
        if (BOAT.onFinish === "stop") await withRetry(() => boatApi(`${boatSandboxPath(id)}/stop`, { method: "POST", json: {} }), 3);
        else await withRetry(() => boatApi(boatSandboxPath(id), { method: "DELETE", headers: { "X-Ascii-Confirm-Delete": id } }), 3);
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 404)) {
          log(`[boat ${id}] ${BOAT.onFinish} failed, falling back to stop:`, String(e));
          await boatApi(`${boatSandboxPath(id)}/stop`, { method: "POST", json: { force: true } }).catch((e2) =>
            log(`[boat ${id}] stop failed too; it auto-stops at its TTL (${BOAT.ttlSeconds}s after create):`, String(e2)));
        }
      }
      destroyedAt = Date.now();
    })());

    let processId: number;
    let pid: number;
    try {
      // 1. wait for the VM
      const until = Date.now() + BOAT.readyTimeoutMs;
      for (;;) {
        const g = await withRetry(() => boatApi(boatSandboxPath(id)), 3);
        const st = g?.sandbox?.state;
        if (st === "ready" || st === "idle" || st === "running") break;
        if (st === "error" || st === "cancelled" || st === "archived" || st === "archiving") throw new Error(`boat sandbox ${id} is ${st}: ${g?.sandbox?.error ?? ""}`);
        if (Date.now() > until) throw new Error(`boat sandbox ${id} not ready after ${BOAT.readyTimeoutMs / 1000}s (state ${st})`);
        await sleep(2000);
      }
      // 2. stage prompt / secrets / scripts in a private dir (the files API only writes under /home/user or /tmp)
      const mk = await boatExec(id, `install -d -m 700 ${BOAT_DIR}`, 30);
      if (mk.exitCode !== 0) throw new Error(`mkdir ${BOAT_DIR} failed: ${mk.stderr.slice(-300)}`);
      const put = (path: string, content: string) =>
        withRetry(() => boatApi(`${boatSandboxPath(id)}/files`, { method: "PUT", json: { path, content } }), 3);
      await put(`${BOAT_DIR}/prompt.txt`, spec.prompt); // byte-for-byte; fed to the CLI on stdin
      await put(`${BOAT_DIR}/env`, boatEnvFile(spec));
      await put(`${BOAT_DIR}/prepare.sh`, boatPrepareScript(spec));
      await put(`${BOAT_DIR}/launch.sh`, boatLaunchScript(spec));
      await put(`${BOAT_DIR}/diff.sh`, boatDiffScript());
      // 3. agent user, PATH, secrets, optional clone
      const prep = await boatExec(id, `bash ${BOAT_DIR}/prepare.sh`, 600);
      if (prep.exitCode !== 0) throw new Error(`sandbox prepare failed (exit ${prep.exitCode}): ${(prep.stderr || prep.stdout).slice(-800)}`);
      // 4. launch the harness detached (synchronous commands cap at 600s)
      const started = await boatCommandRetry(() => boatApi(`${boatSandboxPath(id)}/commands`, {
        method: "POST", json: { command: `bash ${BOAT_DIR}/launch.sh`, detached: true },
      }));
      processId = Number(started?.processId);
      pid = Number(started?.pid ?? started?.processId);
      if (!Number.isFinite(processId)) throw new Error(`boat detached start returned no processId: ${JSON.stringify(started).slice(0, 300)}`);
    } catch (e) {
      await destroy();
      throw e;
    }

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let finished = false;
    let resolveExit!: (x: RunExit) => void;
    const exited = new Promise<RunExit>((r) => (resolveExit = r));
    const finish = (x: RunExit) => {
      if (finished) return;
      finished = true;
      stdout.end();
      stderr.end();
      resolveExit(x);
    };

    // 5. follow out.jsonl by line number, reconnecting every TAIL_SECONDS; `tail --pid` returns once the launcher exits
    void (async () => {
      let lines = 0;
      let partial = "";
      const onOut = (d: string) => {
        partial += d;
        let i: number;
        while ((i = partial.indexOf("\n")) >= 0) {
          const line = partial.slice(0, i);
          partial = partial.slice(i + 1);
          lines++;
          stdout.write(line + "\n");
        }
      };
      const noop = () => {};
      let failures = 0;
      try {
        for (;;) {
          if (abort.signal.aborted) return;
          const t0 = Date.now();
          partial = ""; // a torn last line is re-read from its start by the next call
          try {
            await boatExecStream(id,
              `timeout ${TAIL_SECONDS} tail -n +${lines + 1} -F --pid=${pid} ${BOAT_DIR}/out.jsonl 2>/dev/null; true`,
              TAIL_SECONDS + 30, onOut, noop, abort.signal);
            failures = 0;
          } catch (e) {
            if (abort.signal.aborted) return;
            if (++failures > 10) throw e;
            log(`[boat ${id}] tail stream failed (${failures}), reconnecting:`, String(e));
          }
          const st = await withRetry(() => boatApi(`${boatSandboxPath(id)}/commands/${processId}?tailBytes=2000`, { signal: abort.signal }), 3);
          if (!st?.running) break;
          if (Date.now() - t0 < 5000) await sleep(3000); // don't hot-loop if tail returns early
        }
        // drain the rest, then exit code + stderr tail + git diff
        partial = "";
        await boatExecStream(id, `tail -n +${lines + 1} ${BOAT_DIR}/out.jsonl 2>/dev/null; true`, 120, onOut, noop, abort.signal);
        if (partial.trim()) { stdout.write(partial + "\n"); partial = ""; }
        const fin = await boatExec(id, `cat ${BOAT_DIR}/exit 2>/dev/null; tail -c 8000 ${BOAT_DIR}/err.log >&2 2>/dev/null; true`, 60);
        if (fin.stderr) stderr.write(fin.stderr);
        const code = /^\s*(\d+)/.exec(fin.stdout)?.[1];
        let diff = "";
        try {
          await boatExecStream(id, `bash ${BOAT_DIR}/diff.sh`, 300, (d) => { if (diff.length <= BOAT.diffMaxBytes) diff += d; }, noop, abort.signal);
          if (diff.length > BOAT.diffMaxBytes) diff = diff.slice(0, BOAT.diffMaxBytes) + "\n[diff truncated by worker]\n";
          // Codex's JSONL has no edit contents, so every run gets one synthetic diff event for the scorer.
          stdout.write(JSON.stringify({ type: "file_edit", name: "git diff", content: diff }) + "\n");
        } catch (e) {
          if (!abort.signal.aborted) stderr.write(`\n[worker] git diff collection failed: ${String(e)}\n`);
        }
        finish({ code: code !== undefined ? Number(code) : null, signal: null });
      } catch (e) {
        if (abort.signal.aborted) finish({ code: null, signal: "SIGKILL" });
        else finish({ code: null, signal: null, error: `boat runner: ${String(e instanceof Error ? e.message : e)}` });
      } finally {
        if (abort.signal.aborted) finish({ code: null, signal: "SIGKILL" });
      }
    })();

    return {
      sandboxId: `boat:${id}`,
      stdout,
      stderr,
      exited,
      async kill() {
        await destroy(); // DELETE force-stops the VM; aborting the stream ends the follower above
        finish({ code: null, signal: "SIGKILL" });
      },
      async cleanup() { await destroy(); },
      meta() {
        const secs = ((destroyedAt ?? Date.now()) - createdAt) / 1000;
        return {
          boat_sandbox_id: id,
          boat_sandbox_type: BOAT.size,
          boat_sandbox_seconds: Math.round(secs),
          // list-price estimate; the exact meter is GET /sandboxes/{id}/usage
          boat_est_cost_usd: Number(((secs / 3600) * (BOAT_PRICE_PER_HOUR[BOAT.size] ?? 0.036)).toFixed(5)),
        };
      },
    };
  },
};

const RUNNERS: Record<string, Runner> = { boat: boatRunner, docker: dockerRunner, local: localRunner };

// ---------------------------------------------------------------- API client

async function api(path: string, init: { method?: string; json?: unknown; ndjson?: string } = {}): Promise<unknown> {
  const headers: Record<string, string> = { Authorization: `Bearer ${CFG.token}` };
  let body: string | undefined;
  if (init.ndjson !== undefined) { headers["Content-Type"] = "application/x-ndjson"; body = init.ndjson; }
  else if (init.json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(init.json); }
  const res = await fetch(CFG.url + path, { method: init.method ?? "POST", headers, body, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, `${init.method ?? "POST"} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function withRetry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 429) throw e;
      if (i >= tries - 1) throw e;
      await sleep(Math.min(1000 * 2 ** i, 15_000));
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- usage parsing

interface Usage { tokens_in?: number; tokens_out?: number; cost_usd?: number; meta: Record<string, unknown> }

/** Accumulates token usage / cost / errors from the harness event stream. */
class UsageTracker {
  private claudeResult: Record<string, any> | null = null;
  private codexIn = 0; private codexCached = 0; private codexOut = 0; private codexReasoning = 0; private codexTurns = 0;
  lastError: string | null = null;

  observe(ev: Record<string, any>) {
    // Claude Code stream-json final event
    if (ev.type === "result") {
      this.claudeResult = ev;
      if (ev.is_error) this.lastError = String(ev.result ?? ev.subtype ?? "claude error").slice(0, 1000);
    }
    // Codex exec --json: usage per turn
    if (ev.type === "turn.completed" && ev.usage) {
      this.codexTurns++;
      this.codexIn += ev.usage.input_tokens ?? 0;
      this.codexCached += ev.usage.cached_input_tokens ?? 0;
      this.codexOut += ev.usage.output_tokens ?? 0;
      this.codexReasoning += ev.usage.reasoning_output_tokens ?? 0;
    }
    if (ev.type === "turn.failed") this.lastError = String(ev.error?.message ?? "codex turn failed").slice(0, 1000);
    if (ev.type === "error") this.lastError = String(ev.message ?? "codex error").slice(0, 1000);
  }

  get claudeSucceeded() { return this.claudeResult ? !this.claudeResult.is_error : null; }

  usage(): Usage {
    const r = this.claudeResult;
    if (r) {
      const u = r.usage ?? {};
      return {
        // input includes cache writes + reads so totals are comparable across harnesses
        tokens_in: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        tokens_out: u.output_tokens ?? 0,
        cost_usd: typeof r.total_cost_usd === "number" ? r.total_cost_usd : undefined,
        meta: { usage: u, num_turns: r.num_turns, duration_ms: r.duration_ms, duration_api_ms: r.duration_api_ms, subtype: r.subtype, model_usage: r.modelUsage },
      };
    }
    if (this.codexTurns) {
      return {
        tokens_in: this.codexIn,
        tokens_out: this.codexOut,
        cost_usd: undefined, // codex doesn't report cost; compute server-side from a price table if needed
        meta: { usage: { input_tokens: this.codexIn, cached_input_tokens: this.codexCached, output_tokens: this.codexOut, reasoning_output_tokens: this.codexReasoning }, turns: this.codexTurns },
      };
    }
    return { meta: {} };
  }
}

// ---------------------------------------------------------------- session execution

const active = new Map<string, RunHandle | null>();
let shuttingDown = false;

async function complete(sessionId: string, body: Record<string, unknown>) {
  try {
    const res = await withRetry(() => api(`/api/worker/sessions/${encodeURIComponent(sessionId)}/complete`, { json: body }));
    log(`[${sessionId}] complete ${body.status}`, JSON.stringify(res));
  } catch (e) {
    log(`[${sessionId}] /complete failed (server will time it out):`, String(e));
  }
}

async function runSession(job: Job, runner: Runner): Promise<void> {
  const sid = job.session_id;
  const enc = encodeURIComponent(sid);
  const started = Date.now();
  const harness = normalizeHarness(job.harness);
  if (!harness) {
    await complete(sid, { status: "failed", error_message: `Unsupported harness: ${job.harness}` });
    return;
  }
  const keyMissing = harness === "claude-code" ? !CFG.anthropicKey : !CFG.openaiKey;
  if (keyMissing) {
    await complete(sid, { status: "failed", error_message: `Worker has no API key for ${harness}` });
    return;
  }

  const spec: RunSpec = { harness, model: job.model, prompt: job.prompt, repoUrl: job.repo_url };
  const tracker = new UsageTracker();
  let buffer: string[] = [];
  let flushing: Promise<void> | null = null;
  let cancelledByServer = false;
  let stderrTail = "";
  let handle: RunHandle | null = null;

  const flush = async () => {
    if (flushing) return flushing;
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    flushing = (async () => {
      try {
        await withRetry(() => api(`/api/worker/sessions/${enc}/events`, { ndjson: batch.join("\n") + "\n" }), 3);
      } catch (e) {
        if (e instanceof HttpError && (e.status === 409 || e.status === 404)) {
          // session cancelled / timed out / gone server-side: stop burning tokens
          cancelledByServer = true;
          log(`[${sid}] server rejected events (${e.status}); stopping sandbox`);
          void handle?.kill();
        } else {
          buffer = batch.concat(buffer); // keep for next tick
          if (buffer.length > 50_000) buffer = buffer.slice(-50_000);
          log(`[${sid}] events flush failed, will retry:`, String(e));
        }
      } finally {
        flushing = null;
      }
    })();
    return flushing;
  };

  const push = (obj: Record<string, unknown>) => buffer.push(JSON.stringify(obj));

  let timedOut = false;
  let startError: string | null = null;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;

  const flushTimer = setInterval(() => void flush(), CFG.flushMs);
  const hbTimer = setInterval(() => {
    api(`/api/worker/sessions/${enc}/heartbeat`).catch((e) => {
      if (e instanceof HttpError && (e.status === 409 || e.status === 404)) { cancelledByServer = true; void handle?.kill(); }
    });
  }, CFG.heartbeatMs);
  const deadline = setTimeout(() => { timedOut = true; log(`[${sid}] max duration hit; killing`); void handle?.kill(); }, CFG.maxSessionMs);

  try {
    handle = await runner.start(spec);
    active.set(sid, handle);
    log(`[${sid}] started ${harness}/${job.model} in ${handle.sandboxId}${job.repo_url ? ` repo=${job.repo_url}` : ""}`);

    handle.stderr.on("data", (d: Buffer | string) => { stderrTail = (stderrTail + d.toString()).slice(-8000); });
    const rl = createInterface({ input: handle.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      try {
        const ev = JSON.parse(t);
        if (ev && typeof ev === "object" && !Array.isArray(ev)) {
          tracker.observe(ev);
          buffer.push(t); // verbatim
          return;
        }
      } catch { /* non-JSON */ }
      push({ type: "raw_stdout", text: t.slice(0, 20_000) });
    });

    const ex = await handle.exited;
    if (ex.error) startError = ex.error;
    exitCode = ex.code;
    exitSignal = ex.signal;
    await new Promise<void>((r) => (handle!.stdout.readableEnded ? r() : rl.once("close", () => r())));
    rl.close();
  } catch (e) {
    startError = String(e instanceof Error ? e.message : e);
  } finally {
    clearInterval(flushTimer);
    clearInterval(hbTimer);
    clearTimeout(deadline);
  }

  if (stderrTail.trim()) push({ type: "worker_stderr", text: stderrTail.slice(-4000) });
  if (flushing) await flushing;
  await flush();
  if (flushing) await flushing;
  await handle?.cleanup().catch(() => {});
  active.delete(sid);

  const u = tracker.usage();
  const wall = Date.now() - started;
  let status: "completed" | "failed" | "timeout";
  let error: string | undefined;
  if (timedOut) { status = "timeout"; error = `Exceeded MAX_SESSION_MINUTES (${CFG.maxSessionMs / 60000})`; }
  else if (startError) { status = "failed"; error = startError; }
  else if (shuttingDown && exitCode !== 0) { status = "failed"; error = "Worker shut down"; }
  else if (tracker.claudeSucceeded === false || exitCode !== 0) {
    status = "failed";
    error = tracker.lastError ?? `Exit code ${exitCode}${exitSignal ? ` (${exitSignal})` : ""}: ${stderrTail.slice(-500)}`;
  } else status = "completed";

  if (cancelledByServer) { log(`[${sid}] cancelled server-side; skipping /complete`); return; }
  await complete(sid, {
    status,
    error_message: error,
    sandbox_id: handle?.sandboxId,
    tokens_in: u.tokens_in,
    tokens_out: u.tokens_out,
    cost_usd: u.cost_usd,
    metadata: { ...u.meta, ...(handle?.meta?.() ?? {}), runner: runner.name, worker_id: CFG.workerId, exit_code: exitCode, exit_signal: exitSignal, wall_ms: wall, attempt: job.attempt },
  });
}

// ---------------------------------------------------------------- main loop

async function main() {
  if (!CFG.token) throw new Error("OCTILLION_WORKER_TOKEN is required");
  const runner = RUNNERS[CFG.runner];
  if (!runner) throw new Error(`RUNNER must be one of ${Object.keys(RUNNERS).join(", ")}`);
  if (runner.name === "boat") {
    if (!BOAT.apiKey) throw new Error("BOAT_API_KEY is required for RUNNER=boat (create one with `boat api-key create octillion-worker --preset ci --ttl 90d`)");
    const me = await boatApi("/me").catch((e) => { throw new Error(`boat.dev auth check failed: ${String(e)}`); });
    log(`boat.dev OK as ${me?.user?.login ?? me?.login ?? "?"}; size=${BOAT.size} ttl=${BOAT.ttlSeconds}s agentUser=${BOAT.agentUser} onFinish=${BOAT.onFinish}`);
  }
  if (runner.name === "docker") {
    const r = await sh("docker", ["image", "inspect", CFG.dockerImage]);
    if (r.code !== 0) throw new Error(`Docker image ${CFG.dockerImage} not found. Build it: docker build -f orchestrator/Dockerfile.sandbox -t ${CFG.dockerImage} orchestrator`);
  }
  log(`worker ${CFG.workerId} runner=${runner.name} concurrency=${CFG.concurrency} url=${CFG.url} max=${CFG.maxSessionMs / 60000}m`);

  const tasks = new Set<Promise<void>>();
  const stop = async (sig: string) => {
    if (shuttingDown) { log("second signal: exiting now"); process.exit(1); }
    shuttingDown = true;
    log(`${sig}: stopping ${active.size} session(s)`);
    await Promise.all([...active.values()].map((h) => h?.kill()));
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));

  while (!shuttingDown) {
    const free = CFG.concurrency - tasks.size;
    if (free <= 0) { await Promise.race(tasks); continue; }
    let jobs: Job[] = [];
    try {
      const res = (await api("/api/worker/claim", {
        json: { worker_id: CFG.workerId, limit: Math.min(free, 50), models: CFG.models, harness: CFG.harness },
      })) as { jobs?: Job[] };
      jobs = res?.jobs ?? [];
    } catch (e) {
      log("claim failed:", String(e));
    }
    for (const job of jobs) {
      active.set(job.session_id, null);
      const t: Promise<void> = runSession(job, runner)
        .catch((e) => log(`[${job.session_id}] crashed:`, e))
        .finally(() => { tasks.delete(t); active.delete(job.session_id); });
      tasks.add(t);
    }
    if (!jobs.length) await Promise.race([sleep(CFG.pollMs), ...tasks]);
  }
  await Promise.allSettled(tasks);
  log("worker stopped");
}

main().catch((e) => { console.error(e); process.exit(1); });
