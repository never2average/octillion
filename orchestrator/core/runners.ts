/**
 * Sandbox runners. A sandbox lives for the whole session and can run the harness several times
 * (launch, then resumes with the simulated developer's replies) in the same workdir.
 *
 *  - vercel: one Vercel Sandbox VM per session through the API's broker (default; vmRunner).
 *  - docker: one long-lived container per session (`docker exec` per turn).
 *  - local:  host CLI in a temp dir. DEV ONLY, no isolation.
 *
 * BLINDNESS: a sandbox receives only the harness input on stdin, the optional repo and the harness env
 * (its own API key + quiet flags). Never session ids, Octillion URLs/tokens, customer names or the orchestrator key.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadRegistry } from "../fleet/plan.js";
import { randomUUID } from "node:crypto";
import { PassThrough, type Readable } from "node:stream";
import type { HarnessAdapter } from "../harnesses/adapters.js";
import { seedBase, seedScript, type TemplateId } from "./workspaces.js";
import type { SessionEnvironment } from "./environment.js";
import { envInstallScript, harnessWiringScript, parseEnvLines, toolsFor } from "./env-install.js";
import { CFG, SANDBOX, sandboxConfigError } from "./config.js";
import { log, sh, shq, sleep, withRetry } from "./util.js";
import { EGRESS_DIR, proxyEnv, proxySource, probeSource, policyProbeSource, diagnosticsScript as egressDiagnostics, setupScript as egressSetupScript, type EgressPolicy } from "./egress.js";
import { vercelBrokerConfig, vercelProvider, type SandboxProvider } from "./sandbox-provider.js";

export interface RunExit { code: number | null; signal: string | null; error?: string }

export interface Turn {
  /** Harness stdout: one JSON event per line. */
  stdout: Readable;
  stderr: Readable;
  /** Resolves once the harness exited and stdout/stderr ended. Never rejects. */
  exited: Promise<RunExit>;
}

export interface Sandbox {
  id: string;
  /** Absolute harness workdir inside the sandbox. */
  workdir: string;
  /** Run the harness once: argv[0] is the binary, `input` goes to stdin byte-for-byte. One turn at a time. */
  /**
   * `env` = the harness credentials + flags for THIS run (from the broker). Injected only at exec time under
   * `env -i`; never written into the image, the container env or argv.
   */
  runTurn(argv: string[], input: string, env: Record<string, string>): Promise<Turn>;
  /** Network lockdown applied at open (private runs): allowed host count and the probe result. */
  egress?: { hosts: number; probe: unknown };
  /** Unified diff of everything the agent changed (vs the cloned commit, or vs empty). null if unavailable. */
  diff(): Promise<string | null>;
  /**
   * Stop the current harness run gracefully (SIGTERM to the CLI), keeping the sandbox and its workspace: used when
   * the session's agent-turn cap is reached mid-run. Optional; without it the run continues until the deadline.
   */
  stopTurn?(): Promise<void>;
  /** Hard-stop (idempotent). */
  kill(): Promise<void>;
  /** Free resources (idempotent). */
  cleanup(): Promise<void>;
  meta(): Record<string, unknown>;
  /** What the developer environment step did (VM runner); undefined when the session had none. */
  environment?: EnvironmentResult;
}

export interface EnvironmentResult {
  /** present = already on the sandbox (not reinstalled); installed = installed for this session. */
  /** launch: "acp" = the harness ran over the Agent Client Protocol with a Zed-like client; "cli" = as a CLI. */
  launch: "acp" | "cli";
  editor: string; language: string | null; requested: string[]; present: string[]; installed: string[]; failed: string[]; dropped: string[];
  wired: Record<string, string>; wiring: string; seconds: number;
  /** Skill names and whether standing rules were written (contents are in the persona, not repeated here). */
  skills: string[]; agent_rules: boolean;
}

export interface OpenSpec {
  adapter: HarnessAdapter;
  repoUrl: string | null;
  /**
   * Starter workspace (orchestrator/workspaces/<template>) seeded and committed when there is no repoUrl, so the
   * agent sees an existing project. The diff is taken against that commit. null/undefined = empty workdir.
   */
  template?: TemplateId | null;
  /** Raw job harness id (pool runner picks a pod by it). */
  harness?: string;
  /** Host-side job key (Octillion session id) for pool reservations. Never passed into a sandbox. */
  jobKey?: string;
  /** Registry agent id (pool group) and the job's model; the pool asserts the group's model matches. */
  agentId?: string;
  model?: string;
  /** The persona's developer environment (CLI tools, language servers), installed and wired before the first run (VM runner only). */
  environment?: SessionEnvironment | null;
  /**
   * Network lockdown for the agent (core/egress.ts; VM runner only): after setup, the agent reaches only these hosts
   * (the provider's network policy), verified by a probe; the open fails if it cannot be enforced. Set for private runs.
   */
  egress?: EgressPolicy | null;
}

export interface Runner {
  name: string;
  open(spec: OpenSpec): Promise<Sandbox>;
}

export const AGENT_HOME = "/home/agent"; // same layout in the VM and docker
export const AGENT_WORKDIR = `${AGENT_HOME}/work`;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Lockfiles: their content (every transitive package name) stays out of the scored diff; only a name line. */
export const LOCKFILES = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock", "poetry.lock", "Pipfile.lock", "uv.lock", "go.sum", "Cargo.lock", "Gemfile.lock", "composer.lock"];
const LOCK_EXCLUDE = LOCKFILES.map((f) => `':(exclude,glob)**/${f}'`).join(" ");
const LOCK_ONLY = LOCKFILES.map((f) => `':(glob)**/${f}'`).join(" ");

/**
 * Diff script, parameterized by env WORK, SNAP (git dir used when the workdir is not a repo; kept outside the
 * workdir so the agent never sees a .git it did not create) and BASE (cloned commit, optional).
 * Lockfile changes are listed by name only ("# lockfile changed: ...").
 */
/**
 * A repo URL may pin a commit (or tag/branch) after "#": https://github.com/acme/app#3f2c1d0. Pinned repos fetch exactly
 * that commit, so every run of a scenario sees the identical codebase; unpinned ones clone the default branch.
 */
export function parseRepoUrl(raw: string): { url: string; ref: string | null } {
  const i = raw.lastIndexOf("#");
  if (i < 0) return { url: raw, ref: null };
  const ref = raw.slice(i + 1);
  if (!/^[\w][\w.\/-]{0,199}$/.test(ref)) throw new Error(`Invalid repo ref "${ref}"`);
  return { url: raw.slice(0, i), ref };
}

/** Clone URL (at REF when set) into W; prints the checked-out commit last. Inputs come from the environment. */
export const CLONE_SCRIPT = `set -euo pipefail
if [ -n "\${REF:-}" ]; then
  git init -q "$W"
  git -C "$W" remote add origin "$URL"
  git -C "$W" fetch -q --depth 1 origin "$REF"
  git -C "$W" checkout -q FETCH_HEAD
else
  git clone --depth 1 -q "$URL" "$W"
fi
git -C "$W" rev-parse HEAD`;

export const DIFF_SCRIPT = `cd "$WORK" 2>/dev/null || exit 0
G="git -c core.quotepath=off -c safe.directory=*"
if [ -d .git ]; then
  B="\${BASE:-${EMPTY_TREE}}"
else
  export GIT_DIR="$SNAP" GIT_WORK_TREE="$WORK"
  rm -rf "$GIT_DIR"; git init -q
  printf "node_modules/\\n.venv/\\nvenv/\\n__pycache__/\\n" > "$GIT_DIR/info/exclude"
  B=${EMPTY_TREE}
fi
$G add -A >/dev/null 2>&1
$G diff --cached --no-color --no-ext-diff "$B" -- . ${LOCK_EXCLUDE} ':(exclude,glob)**/.serena/**'
$G diff --cached --name-only "$B" -- ${LOCK_ONLY} | sed 's/^/# lockfile changed (content omitted): /'`;

export function capDiff(d: string): string {
  return d.length > SANDBOX.diffMaxBytes ? d.slice(0, SANDBOX.diffMaxBytes) + "\n[diff truncated by worker]\n" : d;
}

/** Image env minus anything OCTILLION_* (blindness), for `env -i` at exec time. */
export async function imageEnv(image: string): Promise<string[]> {
  const r = await sh("docker", ["image", "inspect", "-f", "{{json .Config.Env}}", image]);
  if (r.code !== 0) throw new Error(`image ${image} not found: ${r.out.slice(-200)}`);
  const list: string[] = JSON.parse(r.out.trim() || "[]") ?? [];
  return list.filter((kv) => !/^OCTILLION_/i.test(kv));
}

/**
 * `docker exec` argv running `argv` under `env -i` with only `baseEnv` (neutral image env) plus the harness keys.
 * Key values travel as `-e NAME` from the docker CLI's env (never in argv / host `ps`) and never sit in the
 * container's own env.
 */
export function dockerExecHarness(container: string, baseEnv: string[], keys: string[], argv: string[], user = "agent"): string[] {
  const script = `exec env -i ${baseEnv.map(shq).join(" ")} ${keys.map((k) => `${k}="$${k}"`).join(" ")} "$@"`;
  return ["exec", "-i", "-u", user, "-w", AGENT_WORKDIR, ...keys.flatMap((k) => ["-e", k]), container, "bash", "-c", script, "octi", ...argv];
}

function childTurn(child: ChildProcess): Turn {
  const exited = new Promise<RunExit>((resolve) => {
    child.on("error", (e) => resolve({ code: null, signal: null, error: String(e) }));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  return { stdout: child.stdout!, stderr: child.stderr!, exited };
}

// ---------------------------------------------------------------- docker

/** One long-lived container per session from SANDBOX_IMAGE (see Dockerfile.sandbox); `docker exec` per turn. */
export const dockerRunner: Runner = {
  name: "docker",
  async open(spec) {
    const name = `octi-${randomUUID().slice(0, 12)}`;
    const args = [
      "run", "-d", "--init",
      "--name", name,
      "--label", "octillion.sandbox=1",
      "--cpus", CFG.dockerCpus,
      "--memory", CFG.dockerMemory,
      "--pids-limit", "1024",
      "--security-opt", "no-new-privileges",
      "--cap-drop", "ALL",
      "-w", AGENT_WORKDIR,
    ];
    if (CFG.dockerNetwork) args.push("--network", CFG.dockerNetwork);
    args.push(CFG.dockerImage, "sleep", "infinity");
    const baseEnv = await imageEnv(CFG.dockerImage);
    const r = await sh("docker", args);
    if (r.code !== 0) throw new Error(`docker run failed: ${r.out.slice(-500)}`);
    const rmContainer = () => sh("docker", ["rm", "-f", name]).then(() => {});
    let base = "";
    if (spec.repoUrl) {
      const { url, ref } = parseRepoUrl(spec.repoUrl);
      const c = await sh("docker", ["exec", "-e", `URL=${url}`, "-e", `REF=${ref ?? ""}`, "-e", `W=${AGENT_WORKDIR}`, name, "bash", "-c", CLONE_SCRIPT]);
      if (c.code !== 0) { await rmContainer(); throw new Error(`git clone failed: ${c.out.slice(-500)}`); }
      base = c.out.trim().split("\n").pop() ?? "";
    } else if (spec.template) {
      const c = await sh("docker", ["exec", "-e", `W=${AGENT_WORKDIR}`, name, "bash", "-c", seedScript(spec.template)]);
      if (c.code !== 0) { await rmContainer(); throw new Error(`workspace seed failed: ${c.out.slice(-500)}`); }
      base = seedBase(c.out);
    }
    let current: ChildProcess | null = null;
    let killed = false;
    return {
      id: `docker:${name}`,
      workdir: AGENT_WORKDIR,
      async runTurn(argv, input, env) {
        // Key values travel as `docker exec -e NAME` from our env (never argv, never the container env).
        const child = spawn("docker", dockerExecHarness(name, baseEnv, Object.keys(env), argv), { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
        current = child;
        child.stdin!.end(input);
        return childTurn(child);
      },
      async diff() {
        const r = await sh("docker", ["exec", "-e", `BASE=${base}`, "-e", `WORK=${AGENT_WORKDIR}`, "-e", "SNAP=/tmp/.octi-snap.git", name, "bash", "-c", DIFF_SCRIPT]);
        return r.code === 0 ? capDiff(r.out) : null;
      },
      async stopTurn() { await sh("docker", ["exec", name, "bash", "-c", "pkill -TERM -u agent || true"]); },
      async kill() {
        if (killed) return;
        killed = true;
        await rmContainer();
        current?.kill("SIGKILL");
      },
      async cleanup() { await rmContainer(); },
      meta: () => ({}),
    };
  },
};

// ---------------------------------------------------------------- local

/**
 * Local: runs the CLI on the host in a fresh temp dir. DEV ONLY - no isolation.
 * HOME / CODEX_HOME point at an empty temp dir so the developer's ~/.claude, ~/.codex, CLAUDE.md, memories
 * and MCP servers don't leak in (would break blindness).
 */
export const localRunner: Runner = {
  name: "local",
  async open(spec) {
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
    };
    let base = "";
    if (spec.repoUrl) {
      const { url, ref } = parseRepoUrl(spec.repoUrl);
      const r = await sh("bash", ["-c", CLONE_SCRIPT], { env: { ...baseEnv, URL: url, REF: ref ?? "", W: work } });
      if (r.code !== 0) {
        await rm(root, { recursive: true, force: true });
        throw new Error(`git clone failed: ${r.out.slice(-500)}`);
      }
      base = r.out.trim().split("\n").pop() ?? "";
    } else if (spec.template) {
      const r = await sh("bash", ["-c", seedScript(spec.template)], { env: { ...baseEnv, W: work } });
      if (r.code !== 0) {
        await rm(root, { recursive: true, force: true });
        throw new Error(`workspace seed failed: ${r.out.slice(-500)}`);
      }
      base = seedBase(r.out);
    }
    let current: ChildProcess | null = null;
    const killGroup = () => {
      try { if (current?.pid) process.kill(-current.pid, "SIGKILL"); } catch { /* already gone */ }
    };
    return {
      id: `local:${root}`,
      workdir: work,
      async runTurn(argv, input, env) {
        const [cmd, ...args] = argv;
        const child = spawn(cmd!, args, { cwd: work, env: { ...baseEnv, ...env }, stdio: ["pipe", "pipe", "pipe"], detached: true });
        current = child;
        child.stdin!.end(input);
        return childTurn(child);
      },
      async diff() {
        const r = await sh("bash", ["-c", DIFF_SCRIPT], { env: { ...baseEnv, WORK: work, SNAP: join(root, "snap.git"), BASE: base } });
        return r.code === 0 ? capDiff(r.out) : null;
      },
      async stopTurn() { try { if (current?.pid) process.kill(-current.pid, "SIGTERM"); } catch { /* already gone */ } },
      async kill() { killGroup(); },
      async cleanup() { killGroup(); await rm(root, { recursive: true, force: true }).catch(() => {}); },
      meta: () => ({}),
    };
  },
};

// ---------------------------------------------------------------- VM runner (Vercel Sandbox)
//
// One fresh VM per session, driven over a provider's API (core/sandbox-provider.ts), on Vercel Sandbox through
// Octillion's broker (src/worker-sandboxes.ts): files, sync / streamed / detached commands, network policy and delete.
//   files:    env + scripts + per-turn input -> /tmp/octi (mode 700, the image's user; the agent user can't read it)
//   commands: prepare (sync); per turn: launch (detached) + follow its JSONL (streamed); diff (streamed)
// The image is Amazon Linux 2023 (user vercel-sandbox with sudo, Node from /vercel/runtimes), which the setup scripts
// detect. We exec the stock CLI as the unprivileged `agent` user under `env -i`.

const VM_DIR = "/tmp/octi";
/** The coding agent always runs as the unprivileged `agent` user (no sudo; docs/security.md). */
const RUN_AS = "sudo -n -u agent -H";

/**
 * Developer environment (core/environment.ts): install the persona's CLI tools and language servers system-wide, then
 * wire them into the harness as the agent user (config under its HOME only). Never fails the session: a tool that does
 * not install is reported, and the agent runs without it.
 */
async function vmEnvironment(p: SandboxProvider, id: string, put: (path: string, content: string) => Promise<unknown>, harness: string, env: SessionEnvironment): Promise<EnvironmentResult> {
  const t0 = Date.now();
  let tools = toolsFor(harness, env);
  // Zed over ACP needs the client file; without it the session runs as a CLI rather than failing.
  if (tools.some((t) => t.id === "acp/client")) {
    try { await put(`${VM_DIR}/acp-client.mjs`, readFileSync(ACP_CLIENT_SRC, "utf8")); }
    catch (e) { log(`[${p.name} ${id}] ACP client unavailable (${String(e).slice(0, 200)}); running as a CLI`); tools = tools.filter((t) => !t.id.startsWith("acp/")); }
  }
  await put(`${VM_DIR}/env-install.sh`, envInstallScript(tools));
  // One call per tool (each allowed 600 s): a slow install (a JDK) must not take the others with it.
  const inst = { exitCode: 0, stdout: "", stderr: "" };
  for (let i = 0; i < tools.length; i++) {
    const r = await p.exec(id, `ACP_CLIENT_SRC=${VM_DIR}/acp-client.mjs bash ${VM_DIR}/env-install.sh ${i}`, { timeoutSec: 600 })
      .catch((e) => ({ exitCode: -1, stdout: `ENV ${tools[i]!.id} fail 0\n`, stderr: String(e) }));
    inst.stdout += r.stdout;
    if (r.exitCode !== 0) { inst.exitCode = r.exitCode ?? -1; inst.stderr += `${tools[i]!.id}: ${r.stderr.slice(-300)}\n`; }
  }
  const wiring = harnessWiringScript(harness, tools, env);
  await put(`${VM_DIR}/env-wire.sh`, wiring.script);
  const wire = await p.exec(id, `cd / && ${RUN_AS} env -i HOME=${AGENT_HOME} PATH="$(cat ${VM_DIR}/path)" bash -s < ${VM_DIR}/env-wire.sh`, { timeoutSec: 300 })
    .catch((e) => ({ exitCode: -1, stdout: "", stderr: String(e) }));
  const r = parseEnvLines(`${inst.stdout}\n${wire.stdout}`);
  if (r.failed.length || inst.exitCode !== 0 || wire.exitCode !== 0)
    log(`[${p.name} ${id}] environment: failed ${r.failed.join(", ") || "-"}: ${(inst.stderr || "").slice(-400)} ${wire.exitCode !== 0 ? `wiring: ${(wire.stderr || "").slice(-300)}` : ""}`);
  // ACP only when its pieces are really there (installed now or already present), never on silence.
  const have = new Set([...r.installed, ...r.present]);
  const acpOk = tools.filter((t) => t.id.startsWith("acp/")).every((t) => have.has(t.id)) && tools.some((t) => t.id === "acp/client");
  return { launch: acpOk ? "acp" : "cli", editor: env.editor, language: env.language, requested: tools.map((t) => t.id), present: r.present, installed: r.installed, failed: r.failed,
           dropped: env.dropped ?? [], skills: (env.skills ?? []).map((s) => s.name), agent_rules: !!env.agent_rules, wired: r.wired, wiring: wiring.summary, seconds: Math.round((Date.now() - t0) / 1000) };
}

function prepareScript(bin: string, repoUrl: string | null, seed = false): string {
  // Seed: the template script is read by this (image) user's shell and piped to the agent user's bash.
  const repo = repoUrl ? parseRepoUrl(repoUrl) : null;
  const clone = repo
    ? `$RUN env URL=${shq(repo.url)} REF=${shq(repo.ref ?? "")} W="$W" bash -c ${shq(CLONE_SCRIPT)} </dev/null | tail -n 1 > "$O/base"\ntest -s "$O/base"`
    : seed
      ? `$RUN env -i HOME="$AH" PATH="$(cat "$O/path")" W="$W" bash -s < "$O/seed.sh" | tail -n 1 > "$O/base"\ntest -s "$O/base"`
      : ":";
  return `set -euo pipefail
cd /
O=${VM_DIR}; AH=${AGENT_HOME}; W=${AGENT_WORKDIR}
id -u agent >/dev/null 2>&1 || sudo -n useradd -m -s /bin/bash agent
OWNER=agent
RUN="${RUN_AS}"
# Agent PATH: system dirs + wherever the preinstalled tools live, never the image user's own home dir.
P=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
for b in claude codex node npm npx git python3 pip3 uv; do
  d=$(bash -lc "command -v $b" 2>/dev/null | head -n1 || true)
  case "$d" in /*) d=$(dirname "$d");; *) continue;; esac
  case "$d" in /home/*|/root*) continue;; esac
  case ":$P:" in *":$d:"*) ;; *) P="$P:$d";; esac
done
echo "$AH/.npm-global/bin:$AH/.local/bin:$P" > "$O/path"
$RUN mkdir -p "$W" "$AH/.npm-global" "$AH/.codex"
echo "$OWNER" > "$O/owner"
${clone}
$RUN env -i HOME="$AH" PATH="$(cat "$O/path")" bash -c 'command -v ${bin}' >/dev/null || { echo "${bin} is not on the agent PATH ($(cat "$O/path"))" >&2; exit 127; }
`;
}

/** `pidFile`: the launcher records its own pid (providers that don't report one: the follower's `tail --pid`). */
function launchScript(n: number, argv: string[], pidFile = false): string {
  const hardLimit = Math.ceil(CFG.maxSessionMs / 1000) + 60; // the worker kills first; belt and braces
  return `cd /
${pidFile ? `echo $$ > ${VM_DIR}/pid-${n}\n` : ""}O=${VM_DIR}; AH=${AGENT_HOME}
U=agent
# This run's credentials: handed to the agent user (0600), sourced and deleted before the harness execs.
sudo -n install -o "$(cat "$O/owner")" -m 600 "$O/env-${n}" "$AH/.octi-env-${n}" && rm -f "$O/env-${n}"
${RUN_AS} env -i HOME="$AH" USER="$U" LOGNAME="$U" SHELL=/bin/bash LANG=C.UTF-8 TERM=dumb PATH="$(cat "$O/path")" \\
  bash -c 'set -a; . "$HOME/.octi-env-${n}"; set +a; rm -f "$HOME/.octi-env-${n}"; cd "$HOME/work" && exec timeout -k 30 ${hardLimit} "$@"' octi ${argv.map(shq).join(" ")} \\
  < "$O/in-${n}.txt" > "$O/out-${n}.jsonl" 2> "$O/err-${n}.log"
c=$?
echo "$c" > "$O/exit-${n}"
exit "$c"
`;
}

function diffScript(): string {
  return `cd /
${RUN_AS} env -i HOME=${AGENT_HOME} PATH="$(cat ${VM_DIR}/path)" WORK=${AGENT_WORKDIR} SNAP=/tmp/.octi-snap.git BASE="$(cat ${VM_DIR}/base 2>/dev/null)" bash -c ${shq(DIFF_SCRIPT)} | head -c ${SANDBOX.diffMaxBytes + 1}
`;
}

/** Worker sandbox name hint: attributes a worker sandbox to its orchestrator (the broker adds its own prefix). */
export function workerSandboxName(agentId: string): string {
  return `${(process.env.OCTILLION_SANDBOX_NAMESPACE || "octi").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 8) || "octi"}-w-${CFG.orchestratorId}-${agentId}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 60);
}

/** Pinned harness version from the registry (by agent id, else the first agent of that harness). */
export function harnessPin(agentId: string | undefined, harness: string): string | null {
  try {
    const agents = loadRegistry().agents;
    return (agents.find((a) => a.id === agentId) ?? agents.find((a) => a.harness === harness))?.harness_version ?? null;
  } catch { return null; }
}

const SETUP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "images", "setup");
const ACP_CLIENT_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "harnesses", "acp-client.mjs");

/** orchestrator/images/setup/<harness>.sh + _common.sh, if this harness has one. */
export function setupScripts(harness: string): { common: string; script: string } | null {
  try { return { common: readFileSync(join(SETUP_DIR, "_common.sh"), "utf8"), script: readFileSync(join(SETUP_DIR, `${harness}.sh`), "utf8") }; }
  catch { return null; }
}

/**
 * Keep the preinstalled CLI if it reports the pinned version; else install it with its setup script. If the pinned
 * version can't be had (no setup script, or its install fails) but a working CLI is preinstalled, the session runs on
 * that one instead of failing: it prints `harness <id>: drift <found> (pinned <pin>)`, which the runner records on the
 * session (metadata.harness_drift) and the failure-rate alert reports. Only a missing CLI fails the session.
 */
export function ensureHarnessScript(harness: string, bin: string, pin: string | null, hasSetup: boolean): string {
  return `set -uo pipefail
# An image may ship /usr/local/bin/node as a symlink into a private home (an nvm tree): the agent user would fall back
# to an older system node (breaks pi, cline warns). Make it a real, world-executable copy first.
real="$(readlink -f /usr/local/bin/node 2>/dev/null || true)"
case "$real" in /home/*|/root/*) sudo -n cp --remove-destination "$real" /usr/local/bin/node && sudo -n chmod 0755 /usr/local/bin/node ;; esac
cur="$( (sudo -n -u nobody env -i HOME=/tmp PATH=/usr/local/bin:/usr/bin:/bin ${shq(bin)} --version 2>/dev/null || true) | grep -v -i -E '^(warning|\\[|\\(node)' | head -n1)"
pin=${shq(pin ?? "")}
if [ -n "$cur" ] && { [ -z "$pin" ] || printf '%s' "$cur" | grep -qF -- "$pin"; }; then echo "harness ${harness}: preinstalled ($cur)"; exit 0; fi
${hasSetup
    ? `echo "harness ${harness}: installing pinned \${pin:-latest} (found: \${cur:-none})" >&2
bash ${VM_DIR}/setup/${harness}.sh "$pin" >&2 || echo "harness ${harness}: install of $pin failed" >&2
now="$( (sudo -n -u nobody env -i HOME=/tmp PATH=/usr/local/bin:/usr/bin:/bin ${shq(bin)} --version 2>/dev/null || true) | grep -v -i -E '^(warning|\\[|\\(node)' | head -n1)"
if printf '%s' "$now" | grep -qF -- "$pin"; then echo "harness ${harness}: installed ($now)"; exit 0; fi
[ -n "$now" ] || { echo "harness ${harness}: after install, unprivileged --version reports nothing, expected $pin" >&2; exit 1; }
echo "harness ${harness}: drift $now (pinned $pin)"`
    : `[ -n "$cur" ] || { echo "harness ${harness}: ${bin} is missing, expected \${pin:-any}, and there is no setup script" >&2; exit 1; }
echo "harness ${harness}: drift $cur (pinned $pin; no setup script)"`}
`;
}

/** Runners whose sandboxes are provider VMs (fleet assignment, egress lockdown). */
export const isVmRunner = (r: { name: string }) => r.name === "vercel";

/**
 * One VM per session on `p`: create, prepare (harness pinned, workdir, repo or template), optional developer environment
 * and egress lockdown, then turns as detached launches followed by line number. vercelRunner = vmRunner(vercelProvider()).
 */
export function vmRunner(p: SandboxProvider): Runner {
  return {
    name: p.name,
    async open(spec) {
      const id = await p.create({ size: p.size, timeoutSec: SANDBOX.ttlSeconds, name: workerSandboxName(spec.agentId ?? spec.adapter.id), sessionId: spec.jobKey });
      let envResult: EnvironmentResult | undefined;
      let harnessDrift: { found: string; pinned: string } | null = null;
      let egressReport: { hosts: number; probe: unknown } | undefined;
      const createdAt = Date.now();
      let destroyedAt: number | null = null;
      let destroying: Promise<void> | null = null;
      const abort = new AbortController();
      const tag = `[${p.name} ${id}]`;

      const destroy = () => (destroying ??= (async () => {
        abort.abort();
        await p.delete(id);
        destroyedAt = Date.now();
      })());

      const put = (path: string, content: string) => withRetry(() => p.writeFile(id, path, content), 3);
      const exec = (command: string, timeoutSec: number) => p.exec(id, command, { timeoutSec });

      try {
        await p.waitReady(id, SANDBOX.readyTimeoutMs);
        const mk = await exec(`install -d -m 700 ${VM_DIR}`, 30);
        if (mk.exitCode !== 0) throw new Error(`mkdir ${VM_DIR} failed: ${mk.stderr.slice(-300)}`);
        // Harness pinned by the registry: keep the preinstalled CLI when it is the pinned version, otherwise
        // install it system-wide with orchestrator/images/setup/<harness>.sh (which verifies `--version`).
        const pin = harnessPin(spec.agentId, spec.adapter.id);
        const setup = setupScripts(spec.adapter.id);
        if (setup) {
          await put(`${VM_DIR}/setup/_common.sh`, setup.common);
          await put(`${VM_DIR}/setup/${spec.adapter.id}.sh`, setup.script);
        }
        const ensure = await exec(ensureHarnessScript(spec.adapter.id, spec.adapter.bin, pin, !!setup), 600);
        if (ensure.exitCode !== 0) throw new Error(`harness ${spec.adapter.id}${pin ? `@${pin}` : ""} not available: ${(ensure.stderr || ensure.stdout).slice(-800)}`);
        // Ran on another version than the pin (see ensureHarnessScript): kept on the session, not a failure.
        const drift = /harness \S+: drift (.+?) \(pinned ([^;)]+)/.exec(ensure.stdout);
        harnessDrift = drift ? { found: drift[1]!.trim().slice(0, 80), pinned: drift[2]!.trim() } : null;
        if (harnessDrift) log(`${tag} ${spec.adapter.id} runs ${harnessDrift.found}, pinned ${harnessDrift.pinned}`);
        const seed = !spec.repoUrl && !!spec.template;
        if (seed) await put(`${VM_DIR}/seed.sh`, seedScript(spec.template!));
        await put(`${VM_DIR}/prepare.sh`, prepareScript(spec.adapter.bin, spec.repoUrl, seed));
        await put(`${VM_DIR}/diff.sh`, diffScript());
        const prep = await exec(`bash ${VM_DIR}/prepare.sh`, 600);
        if (prep.exitCode !== 0) throw new Error(`sandbox prepare failed (exit ${prep.exitCode}): ${(prep.stderr || prep.stdout).slice(-800)}`);
        if (spec.environment) envResult = await vmEnvironment(p, id, put, spec.adapter.id, spec.environment);
        // Last step before the agent's first turn: everything that needs the network (harness, repo, tools) is done.
        if (spec.egress) {
          let probeCmd: string;
          if (p.lockdown) {
            // Native allow-list (Vercel network policy): the whole VM reaches only these hosts, enforced outside the VM.
            await p.lockdown(id, spec.egress.hosts);
            await put(`${VM_DIR}/egress-probe.mjs`, policyProbeSource(spec.egress.gatewayHost));
            // VM_DIR is 0700 (the sandbox user's): install the probe root-owned and world-readable, as the proxy path does,
            // so the agent user can run it (it read MODULE_NOT_FOUND from VM_DIR, seen live 2026-11-01).
            const inst = await exec(`sudo -n install -d -m 755 -o root -g root ${EGRESS_DIR} && sudo -n install -m 644 -o root -g root ${VM_DIR}/egress-probe.mjs ${EGRESS_DIR}/probe.mjs`, 60);
            if (inst.exitCode !== 0) throw new Error(`egress probe install failed (exit ${inst.exitCode}): ${(inst.stderr || inst.stdout).slice(-400)}`);
            probeCmd = `cd / && NODE="$(command -v node)" && ${RUN_AS} env -i HOME=${AGENT_HOME} PATH="$(cat ${VM_DIR}/path)" "$NODE" ${EGRESS_DIR}/probe.mjs`;
          } else {
            await put(`${VM_DIR}/egress-proxy.mjs`, proxySource());
            await put(`${VM_DIR}/egress-allow.json`, JSON.stringify({ hosts: spec.egress.hosts }));
            await put(`${VM_DIR}/egress-probe.mjs`, probeSource(spec.egress.gatewayHost));
            await put(`${VM_DIR}/egress-setup.sh`, egressSetupScript(VM_DIR));
            const lock = await exec(`bash ${VM_DIR}/egress-setup.sh`, 120);
            if (lock.exitCode !== 0) throw new Error(`egress lockdown failed (exit ${lock.exitCode}): ${(lock.stderr || lock.stdout).slice(-600)}`);
            probeCmd = `cd / && NODE="$(command -v node)" && ${RUN_AS} env -i HOME=${AGENT_HOME} PATH="$(cat ${VM_DIR}/path)" "$NODE" ${EGRESS_DIR}/probe.mjs`;
          }
          const probe = await exec(probeCmd, 120);
          const last = probe.stdout.trim().split("\n").pop() ?? "";
          if (probe.exitCode !== 0) {
            // The VM is destroyed right after this: collect what the proxy and firewall look like first.
            const diag = p.lockdown ? "" : await exec(egressDiagnostics(), 60).then((d) => d.stdout.trim().slice(-1400), () => "(diagnostics unavailable)");
            let failedChecks = last.slice(0, 300);
            try { failedChecks = JSON.parse(last).checks.filter((c: { want: boolean; got: boolean }) => c.want !== c.got).map((c: { name: string }) => c.name).join("; "); } catch { /* keep raw */ }
            throw new Error(`egress probe failed, refusing to run the agent. Unexpected: ${failedChecks || probe.stderr.slice(-300)}\n${diag}`);
          }
          egressReport = { hosts: spec.egress.hosts.length, probe: JSON.parse(last) };
          log(`${tag} egress locked down${p.lockdown ? " (network policy)" : ""}: ${spec.egress.hosts.length} allowed hosts, probe ok`);
        }
      } catch (e) {
        await destroy();
        throw e;
      }

      let turnNo = 0;
      let finishCurrent: ((x: RunExit) => void) | null = null;

      return {
        id: `${p.name}:${id}`,
        workdir: AGENT_WORKDIR,
        environment: envResult,
        egress: egressReport,
        async runTurn(argv, input, env) {
          const n = ++turnNo;
          if (spec.egress && !p.lockdown) env = { ...env, ...proxyEnv() }; // HTTP clients go through the in-VM proxy
          argv = [...argv];
          argv[0] = argv[0]!.split("/").pop()!; // host bin overrides don't apply in the VM
          await put(`${VM_DIR}/env-${n}`, Object.entries(env).map(([k, v]) => `${k}=${shq(v)}`).join("\n") + "\n");
          await put(`${VM_DIR}/in-${n}.txt`, input); // byte-for-byte; fed to the CLI on stdin
          await put(`${VM_DIR}/launch-${n}.sh`, launchScript(n, argv, true));
          const started = await p.execDetached(id, `bash ${VM_DIR}/launch-${n}.sh`);
          const launchedAt = Date.now(), followUntil = launchedAt + (Math.ceil(CFG.maxSessionMs / 1000) + 60 + 300) * 1000;
          const pidArg = started.pid != null && Number.isFinite(started.pid) ? `--pid=${started.pid}` : `\${P:+--pid=$P}`;
          const pidRead = started.pid != null && Number.isFinite(started.pid) ? "" : `for i in 1 2 3 4 5; do P=$(cat ${VM_DIR}/pid-${n} 2>/dev/null); [ -n "$P" ] && break; sleep 1; done; `;

          const stdout = new PassThrough();
          const stderr = new PassThrough();
          let finished = false;
          let resolveExit!: (x: RunExit) => void;
          const exited = new Promise<RunExit>((r) => (resolveExit = r));
          const finish = (x: RunExit) => {
            if (finished) return;
            finished = true;
            finishCurrent = null;
            stdout.end();
            stderr.end();
            resolveExit(x);
          };
          finishCurrent = finish;
          const out = `${VM_DIR}/out-${n}.jsonl`;

          // Follow out-N.jsonl by line number, reconnecting every tailSeconds; `tail --pid` returns once the launcher exits.
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
                  await p.execStream(id, `${pidRead}timeout ${p.tailSeconds} tail -n +${lines + 1} -F ${pidArg} ${out} 2>/dev/null; true`,
                    { timeoutSec: p.tailSeconds + 30, onStdout: onOut, onStderr: noop, signal: abort.signal });
                  failures = 0;
                } catch (e) {
                  if (abort.signal.aborted) return;
                  if (++failures > 10) throw e;
                  log(`${tag} tail stream failed (${failures}), reconnecting:`, String(e));
                }
                // No provider pid (Vercel): the launcher's own exit file is the ground truth; the provider's status is a
                // second opinion (a stale "running" once kept a finished launch polled for 52 minutes).
                if (started.pid == null) {
                  const ex = await exec(`test -e ${VM_DIR}/exit-${n} && echo exited || true`, 30).catch(() => ({ stdout: "" }));
                  if (/exited/.test(ex.stdout)) break;
                }
                if (!(await p.running(id, started.handle, abort.signal))) break;
                // Past the harness's own hard limit (timeout -k 30 in the launcher) plus a margin: fail, never poll on.
                if (Date.now() > followUntil) throw new Error(`the run did not report its exit within ${Math.round((followUntil - launchedAt) / 1000)}s of its launch`);
                if (Date.now() - t0 < 5000) await sleep(3000); // don't hot-loop if tail returns early
              }
              // The run has exited and its output is on disk: a dropped connection here (ECONNRESET mid-stream) must not
              // fail a finished session. Both reads are idempotent; the drain resumes after the last complete line.
              const afterExit = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
                for (let attempt = 1; ; attempt++) {
                  try { return await fn(); }
                  catch (e) {
                    if (abort.signal.aborted || attempt >= 6) throw e;
                    log(`${tag} ${what} failed (${attempt}), retrying:`, String(e));
                    await sleep(Math.min(2000 * attempt, 10_000));
                  }
                }
              };
              await afterExit("final output drain", () => {
                partial = ""; // a torn last line is re-read from its start
                return p.execStream(id, `tail -n +${lines + 1} ${out} 2>/dev/null; true`, { timeoutSec: 120, onStdout: onOut, onStderr: noop, signal: abort.signal });
              });
              if (partial.trim()) { stdout.write(partial + "\n"); partial = ""; }
              const fin = await afterExit("exit status read", () =>
                exec(`cat ${VM_DIR}/exit-${n} 2>/dev/null; tail -c 8000 ${VM_DIR}/err-${n}.log >&2 2>/dev/null; true`, 60));
              if (fin.stderr) stderr.write(fin.stderr);
              const code = /^\s*(\d+)/.exec(fin.stdout)?.[1];
              finish({ code: code !== undefined ? Number(code) : null, signal: null });
            } catch (e) {
              if (abort.signal.aborted) finish({ code: null, signal: "SIGKILL" });
              else finish({ code: null, signal: null, error: `${p.name} runner: ${String(e instanceof Error ? e.message : e)}` });
            } finally {
              if (abort.signal.aborted) finish({ code: null, signal: "SIGKILL" });
            }
          })();
          return { stdout, stderr, exited };
        },
        async diff() {
          if (abort.signal.aborted) return null;
          let d = "";
          try {
            await p.execStream(id, `bash ${VM_DIR}/diff.sh`, { timeoutSec: 300, onStdout: (s) => { if (d.length <= SANDBOX.diffMaxBytes) d += s; }, onStderr: () => {}, signal: abort.signal });
          } catch (e) {
            log(`${tag} diff failed:`, String(e));
            return null;
          }
          return capDiff(d);
        },
        async stopTurn() {
          // The harness runs under `timeout -k 30 <limit>`; GNU timeout forwards SIGTERM to the CLI.
          if (abort.signal.aborted) return;
          await exec("sudo -n pkill -TERM -f '^timeout -k 30 ' || pkill -TERM -f '^timeout -k 30 ' || true", 30).catch(() => {});
        },
        async kill() {
          await destroy(); // DELETE force-stops the VM; aborting ends any follower
          finishCurrent?.({ code: null, signal: "SIGKILL" });
        },
        async cleanup() { await destroy(); },
        meta() {
          const secs = ((destroyedAt ?? Date.now()) - createdAt) / 1000;
          const cost = p.estCostUsd(secs); // estimate from the provider's price table
          return {
            ...(spec.template && !spec.repoUrl ? { workspace_template: spec.template } : {}),
            ...(harnessDrift ? { harness_drift: harnessDrift } : {}),
            sandbox_provider: p.name,
            sandbox_vm_id: id,
            sandbox_type: p.size,
            sandbox_seconds: Math.round(secs),
            sandbox_est_cost_usd: cost,
          };
        },
      };
    },
  };
}

/** Vercel Sandbox workers through the API's broker (created lazily: it reads CFG at open time). */
export const vercelRunner: Runner = vmRunner(vercelProvider());

export const RUNNERS: Record<string, Runner> = { vercel: vercelRunner, docker: dockerRunner, local: localRunner };

/**
 * The worker runner for this orchestrator: RUNNER (default vercel; docker / local / pool are for tests and development).
 * A retired provider (RUNNER=boat, OCTILLION_SANDBOX_PROVIDER=boat) throws a clear error instead of falling back.
 */
export function selectRunner(runnerName: string): Runner | undefined {
  const bad = sandboxConfigError({ RUNNER: runnerName, OCTILLION_SANDBOX_PROVIDER: process.env.OCTILLION_SANDBOX_PROVIDER });
  if (bad) throw new Error(bad);
  return RUNNERS[runnerName];
}

/** Startup checks for the selected runner. */
export async function checkRunner(runner: Runner): Promise<void> {
  if (runner.name === "vercel") {
    // Vercel Sandbox is reached only through the API's broker: it must be configured there (the function's OIDC token).
    const c = await vercelBrokerConfig().catch((e) => { throw new Error(`Vercel Sandbox broker check failed: ${String(e)}`); });
    if (!c?.configured) throw new Error(`Vercel Sandbox is not configured on the Octillion API: ${c?.reason ?? "unknown"}`);
    log(`vercel sandbox broker OK (${c.via ?? "?"}, ${c.region ?? "?"}); size=${SANDBOX.vercelSize} timeout=${SANDBOX.ttlSeconds}s`);
  }
  if (runner.name === "docker") {
    const r = await sh("docker", ["image", "inspect", CFG.dockerImage]);
    if (r.code !== 0) throw new Error(`Docker image ${CFG.dockerImage} not found. Build it: docker build -f orchestrator/Dockerfile.sandbox -t ${CFG.dockerImage} orchestrator`);
  }
}
