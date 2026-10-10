/**
 * Sandbox runners. A sandbox lives for the whole session and can run the harness several times
 * (launch, then resumes with the simulated developer's replies) in the same workdir.
 *
 *  - boat:   one boat.dev VM per session over its REST API (default).
 *  - docker: one long-lived container per session (`docker exec` per turn).
 *  - local:  host CLI in a temp dir. DEV ONLY, no isolation.
 *
 * BLINDNESS: a sandbox receives only the harness input on stdin, the optional repo and the harness env
 * (its own API key + quiet flags). Never session ids, Octillion URLs/tokens, customer names or the orchestrator key.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PassThrough, type Readable } from "node:stream";
import type { HarnessAdapter } from "../harnesses/adapters.js";
import { BOAT, BOAT_PRICE_PER_HOUR, CFG } from "./config.js";
import { HttpError, log, sh, shq, sleep, withRetry } from "./util.js";
import { boatApi, boatCommandRetry, boatExec, boatExecStream, boatSandboxPath, BoatError } from "./boat.js";

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
  runTurn(argv: string[], input: string): Promise<Turn>;
  /** Unified diff of everything the agent changed (vs the cloned commit, or vs empty). null if unavailable. */
  diff(): Promise<string | null>;
  /** Hard-stop (idempotent). */
  kill(): Promise<void>;
  /** Free resources (idempotent). */
  cleanup(): Promise<void>;
  meta(): Record<string, unknown>;
}

export interface OpenSpec {
  adapter: HarnessAdapter;
  repoUrl: string | null;
  /** Harness env (API key etc.), from adapter.env(). */
  env: Record<string, string>;
  /** Raw job harness id (pool runner picks a pod by it). */
  harness?: string;
  /** Host-side job key (Octillion session id) for pool reservations. Never passed into a sandbox. */
  jobKey?: string;
}

export interface Runner {
  name: string;
  open(spec: OpenSpec): Promise<Sandbox>;
}

export const AGENT_HOME = "/home/agent"; // same layout in boat and docker
export const AGENT_WORKDIR = `${AGENT_HOME}/work`;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Diff script, parameterized by env WORK, SNAP (git dir used when the workdir is not a repo; kept outside the
 * workdir so the agent never sees a .git it did not create) and BASE (cloned commit, optional).
 */
export const DIFF_SCRIPT = `cd "$WORK" 2>/dev/null || exit 0
G="git -c core.quotepath=off -c safe.directory=*"
if [ -d .git ]; then
  $G add -A >/dev/null 2>&1
  $G diff --cached --no-color --no-ext-diff "\${BASE:-${EMPTY_TREE}}"
else
  export GIT_DIR="$SNAP" GIT_WORK_TREE="$WORK"
  rm -rf "$GIT_DIR"; git init -q
  printf "node_modules/\\n.venv/\\nvenv/\\n__pycache__/\\n" > "$GIT_DIR/info/exclude"
  $G add -A >/dev/null 2>&1
  $G diff --cached --no-color --no-ext-diff ${EMPTY_TREE}
fi`;

export function capDiff(d: string): string {
  return d.length > BOAT.diffMaxBytes ? d.slice(0, BOAT.diffMaxBytes) + "\n[diff truncated by worker]\n" : d;
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
    const keys = Object.keys(spec.env); // passed per exec, never into the container env
    const r = await sh("docker", args);
    if (r.code !== 0) throw new Error(`docker run failed: ${r.out.slice(-500)}`);
    const rmContainer = () => sh("docker", ["rm", "-f", name]).then(() => {});
    let base = "";
    if (spec.repoUrl) {
      const c = await sh("docker", ["exec", name, "git", "clone", "--depth", "1", "-q", spec.repoUrl, AGENT_WORKDIR]);
      if (c.code !== 0) { await rmContainer(); throw new Error(`git clone failed: ${c.out.slice(-500)}`); }
      base = (await sh("docker", ["exec", name, "git", "-C", AGENT_WORKDIR, "rev-parse", "HEAD"])).out.trim();
    }
    let current: ChildProcess | null = null;
    let killed = false;
    return {
      id: `docker:${name}`,
      workdir: AGENT_WORKDIR,
      async runTurn(argv, input) {
        const child = spawn("docker", dockerExecHarness(name, baseEnv, keys, argv), { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...spec.env } });
        current = child;
        child.stdin!.end(input);
        return childTurn(child);
      },
      async diff() {
        const r = await sh("docker", ["exec", "-e", `BASE=${base}`, "-e", `WORK=${AGENT_WORKDIR}`, "-e", "SNAP=/tmp/.octi-snap.git", name, "bash", "-c", DIFF_SCRIPT]);
        return r.code === 0 ? capDiff(r.out) : null;
      },
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
      ...spec.env,
    };
    let base = "";
    if (spec.repoUrl) {
      const r = await sh("git", ["clone", "--depth", "1", "-q", spec.repoUrl, work], { env: baseEnv });
      if (r.code !== 0) {
        await rm(root, { recursive: true, force: true });
        throw new Error(`git clone failed: ${r.out.slice(-500)}`);
      }
      base = (await sh("git", ["-C", work, "rev-parse", "HEAD"], { env: baseEnv })).out.trim();
    }
    let current: ChildProcess | null = null;
    const killGroup = () => {
      try { if (current?.pid) process.kill(-current.pid, "SIGKILL"); } catch { /* already gone */ }
    };
    return {
      id: `local:${root}`,
      workdir: work,
      async runTurn(argv, input) {
        const [cmd, ...args] = argv;
        const child = spawn(cmd!, args, { cwd: work, env: baseEnv, stdio: ["pipe", "pipe", "pipe"], detached: true });
        current = child;
        child.stdin!.end(input);
        return childTurn(child);
      },
      async diff() {
        const r = await sh("bash", ["-c", DIFF_SCRIPT], { env: { ...baseEnv, WORK: work, SNAP: join(root, "snap.git"), BASE: base } });
        return r.code === 0 ? capDiff(r.out) : null;
      },
      async kill() { killGroup(); },
      async cleanup() { killGroup(); await rm(root, { recursive: true, force: true }).catch(() => {}); },
      meta: () => ({}),
    };
  },
};

// ---------------------------------------------------------------- boat.dev
//
// One fresh VM per session, driven over the REST API (https://docs.boat.dev/api/v1):
//   POST /sandboxes {type, ttlSeconds, noEnv:true, snapshots:false} (Idempotency-Key); poll GET until ready
//   PUT  /files: env + scripts + per-turn input -> /tmp/octi (mode 700, Boat's user; the agent user can't read it)
//   POST /commands: prepare (sync); per turn: launch (detached) + follow its JSONL (stream:true); diff (stream)
//   GET  /commands/{processId}: is the turn still running?
//   DELETE /sandboxes/{id} + X-Ascii-Confirm-Delete: force-stop + permanent delete (cleanup / kill)
//
// We don't use Boat's managed POST /prompt + GET /events: Boat injects its own system prompt, `boat` skill and
// `computer` MCP server into managed harnesses (breaks blindness), and its events are a normalized format without
// Claude's `result` usage/cost. We exec the stock preinstalled CLI as an isolated user under `env -i`.

const BOAT_DIR = "/tmp/octi";
const TAIL_SECONDS = 540; // each streamed tail call stays under the 600s command cap, then reconnects

function boatRunAs(): string {
  return BOAT.agentUser === "agent" ? "sudo -n -u agent -H" : "";
}

function boatPrepareScript(bin: string, repoUrl: string | null): string {
  const clone = repoUrl
    ? `$RUN git clone --depth 1 -q ${shq(repoUrl)} "$W" </dev/null\n$RUN git -C "$W" rev-parse HEAD > "$O/base"`
    : ":";
  return `set -euo pipefail
cd /
O=${BOAT_DIR}; AH=${AGENT_HOME}; W=${AGENT_WORKDIR}
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
# Harness env (its own API key + quiet flags) for every turn; readable only by the agent user.
sudo -n install -o "$OWNER" -m 600 "$O/env" "$AH/.octi-env"
rm -f "$O/env"
${clone}
$RUN env -i HOME="$AH" PATH="$(cat "$O/path")" bash -c 'command -v ${bin}' >/dev/null || { echo "${bin} is not on the agent PATH ($(cat "$O/path")); try BOAT_AGENT_USER=user" >&2; exit 127; }
`;
}

function boatLaunchScript(n: number, argv: string[]): string {
  const hardLimit = Math.ceil(CFG.maxSessionMs / 1000) + 60; // the worker kills first; belt and braces
  return `cd /
O=${BOAT_DIR}; AH=${AGENT_HOME}
U=${BOAT.agentUser === "agent" ? "agent" : "$(id -un)"}
${boatRunAs()} env -i HOME="$AH" USER="$U" LOGNAME="$U" SHELL=/bin/bash LANG=C.UTF-8 TERM=dumb PATH="$(cat "$O/path")" \\
  bash -c 'set -a; . "$HOME/.octi-env"; set +a; cd "$HOME/work" && exec timeout -k 30 ${hardLimit} "$@"' octi ${argv.map(shq).join(" ")} \\
  < "$O/in-${n}.txt" > "$O/out-${n}.jsonl" 2> "$O/err-${n}.log"
c=$?
echo "$c" > "$O/exit-${n}"
exit "$c"
`;
}

function boatDiffScript(): string {
  return `cd /
${boatRunAs()} env -i HOME=${AGENT_HOME} PATH="$(cat ${BOAT_DIR}/path)" WORK=${AGENT_WORKDIR} SNAP=/tmp/.octi-snap.git BASE="$(cat ${BOAT_DIR}/base 2>/dev/null)" bash -c ${shq(DIFF_SCRIPT)} | head -c ${BOAT.diffMaxBytes + 1}
`;
}

export const boatRunner: Runner = {
  name: "boat",
  async open(spec) {
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

    const put = (path: string, content: string) =>
      withRetry(() => boatApi(`${boatSandboxPath(id)}/files`, { method: "PUT", json: { path, content } }), 3);

    try {
      const until = Date.now() + BOAT.readyTimeoutMs;
      for (;;) {
        const g = await withRetry(() => boatApi(boatSandboxPath(id)), 3);
        const st = g?.sandbox?.state;
        if (st === "ready" || st === "idle" || st === "running") break;
        if (st === "error" || st === "cancelled" || st === "archived" || st === "archiving") throw new Error(`boat sandbox ${id} is ${st}: ${g?.sandbox?.error ?? ""}`);
        if (Date.now() > until) throw new Error(`boat sandbox ${id} not ready after ${BOAT.readyTimeoutMs / 1000}s (state ${st})`);
        await sleep(2000);
      }
      const mk = await boatExec(id, `install -d -m 700 ${BOAT_DIR}`, 30);
      if (mk.exitCode !== 0) throw new Error(`mkdir ${BOAT_DIR} failed: ${mk.stderr.slice(-300)}`);
      await put(`${BOAT_DIR}/env`, Object.entries(spec.env).map(([k, v]) => `${k}=${shq(v)}`).join("\n") + "\n");
      await put(`${BOAT_DIR}/prepare.sh`, boatPrepareScript(spec.adapter.bin, spec.repoUrl));
      await put(`${BOAT_DIR}/diff.sh`, boatDiffScript());
      const prep = await boatExec(id, `bash ${BOAT_DIR}/prepare.sh`, 600);
      if (prep.exitCode !== 0) throw new Error(`sandbox prepare failed (exit ${prep.exitCode}): ${(prep.stderr || prep.stdout).slice(-800)}`);
    } catch (e) {
      await destroy();
      throw e;
    }

    let turnNo = 0;
    let finishCurrent: ((x: RunExit) => void) | null = null;

    return {
      id: `boat:${id}`,
      workdir: AGENT_WORKDIR,
      async runTurn(argv, input) {
        const n = ++turnNo;
        argv = [...argv];
        argv[0] = argv[0]!.split("/").pop()!; // host bin overrides don't apply in the VM
        await put(`${BOAT_DIR}/in-${n}.txt`, input); // byte-for-byte; fed to the CLI on stdin
        await put(`${BOAT_DIR}/launch-${n}.sh`, boatLaunchScript(n, argv));
        const started = await boatCommandRetry(() => boatApi(`${boatSandboxPath(id)}/commands`, {
          method: "POST", json: { command: `bash ${BOAT_DIR}/launch-${n}.sh`, detached: true },
        }));
        const processId = Number(started?.processId);
        const pid = Number(started?.pid ?? started?.processId);
        if (!Number.isFinite(processId)) throw new Error(`boat detached start returned no processId: ${JSON.stringify(started).slice(0, 300)}`);

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
        const out = `${BOAT_DIR}/out-${n}.jsonl`;

        // Follow out-N.jsonl by line number, reconnecting every TAIL_SECONDS; `tail --pid` returns once the launcher exits.
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
                await boatExecStream(id, `timeout ${TAIL_SECONDS} tail -n +${lines + 1} -F --pid=${pid} ${out} 2>/dev/null; true`,
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
            partial = "";
            await boatExecStream(id, `tail -n +${lines + 1} ${out} 2>/dev/null; true`, 120, onOut, noop, abort.signal);
            if (partial.trim()) { stdout.write(partial + "\n"); partial = ""; }
            const fin = await boatExec(id, `cat ${BOAT_DIR}/exit-${n} 2>/dev/null; tail -c 8000 ${BOAT_DIR}/err-${n}.log >&2 2>/dev/null; true`, 60);
            if (fin.stderr) stderr.write(fin.stderr);
            const code = /^\s*(\d+)/.exec(fin.stdout)?.[1];
            finish({ code: code !== undefined ? Number(code) : null, signal: null });
          } catch (e) {
            if (abort.signal.aborted) finish({ code: null, signal: "SIGKILL" });
            else finish({ code: null, signal: null, error: `boat runner: ${String(e instanceof Error ? e.message : e)}` });
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
          await boatExecStream(id, `bash ${BOAT_DIR}/diff.sh`, 300, (s) => { if (d.length <= BOAT.diffMaxBytes) d += s; }, () => {}, abort.signal);
        } catch (e) {
          log(`[boat ${id}] diff failed:`, String(e));
          return null;
        }
        return capDiff(d);
      },
      async kill() {
        await destroy(); // DELETE force-stops the VM; aborting ends any follower
        finishCurrent?.({ code: null, signal: "SIGKILL" });
      },
      async cleanup() { await destroy(); },
      meta() {
        const secs = ((destroyedAt ?? Date.now()) - createdAt) / 1000;
        return {
          boat_sandbox_id: id,
          boat_sandbox_type: BOAT.size,
          boat_sandbox_seconds: Math.round(secs),
          boat_est_cost_usd: Number(((secs / 3600) * (BOAT_PRICE_PER_HOUR[BOAT.size] ?? 0.036)).toFixed(5)), // exact meter: GET /sandboxes/{id}/usage
        };
      },
    };
  },
};

export const RUNNERS: Record<string, Runner> = { boat: boatRunner, docker: dockerRunner, local: localRunner };

/** Startup checks for the selected runner. */
export async function checkRunner(runner: Runner): Promise<void> {
  if (runner.name === "boat") {
    if (!BOAT.apiKey) throw new Error("BOAT_API_KEY is required for RUNNER=boat (create one with `boat api-key create octillion-worker --preset ci --ttl 90d`)");
    const me = await boatApi("/me").catch((e) => { throw new Error(`boat.dev auth check failed: ${String(e)}`); });
    log(`boat.dev OK as ${me?.user?.login ?? me?.login ?? "?"}; size=${BOAT.size} ttl=${BOAT.ttlSeconds}s agentUser=${BOAT.agentUser} onFinish=${BOAT.onFinish}`);
  }
  if (runner.name === "docker") {
    const r = await sh("docker", ["image", "inspect", CFG.dockerImage]);
    if (r.code !== 0) throw new Error(`Docker image ${CFG.dockerImage} not found. Build it: docker build -f orchestrator/Dockerfile.sandbox -t ${CFG.dockerImage} orchestrator`);
  }
}
