/**
 * The worker sandbox provider: what the VM runner (core/runners.ts vmRunner) needs from a sandbox service, and nothing more.
 *
 *  - vercel: Vercel Sandbox through Octillion's own broker (POST /api/worker/sandboxes..., src/worker-sandboxes.ts). The
 *            Vercel credentials are the API function's OIDC token, which exists only inside our Vercel functions: this
 *            process never holds them. It authenticates with its worker token, and the server lets it use only the
 *            sandboxes it created (same job, same token kind). One broker call stays under the function's 300 s, so long
 *            commands run detached and are polled, and log follows reconnect (the runner already resumes by line number).
 *
 * BLINDNESS is unchanged: a worker sandbox receives files and commands from this process, never its worker token.
 */
import { randomBytes } from "node:crypto";
import { CFG, SANDBOX, VERCEL_SIZES, vercelEstCostUsd } from "./config.js";
import { HttpError, log, shq, sleep, withRetry } from "./util.js";

export interface ExecResult { exitCode: number | null; stdout: string; stderr: string }
export type VmState = "ready" | "starting" | "stopped" | "gone";

export interface SandboxProvider {
  name: "vercel";
  /** Size label recorded on the session (small|default|large|xlarge, see VERCEL_SIZES). */
  size: string;
  /** Seconds one streamed log follow may last before the runner reconnects (it resumes by line number). */
  tailSeconds: number;
  create(o: { size: string; timeoutSec: number; name: string; sessionId?: string }): Promise<string>;
  get(id: string): Promise<{ state: VmState; detail?: string }>;
  /** Resolves once the sandbox can run commands; throws when it failed or did not get there in time. */
  waitReady(id: string, timeoutMs: number): Promise<void>;
  exec(id: string, command: string, o: { timeoutSec: number }): Promise<ExecResult>;
  /** Streamed stdout / stderr frames, then the exit code. */
  execStream(id: string, command: string, o: { timeoutSec: number; onStdout: (s: string) => void; onStderr: (s: string) => void; signal?: AbortSignal }): Promise<{ exitCode: number | null }>;
  /** Start without waiting. `pid` is the launcher's pid in the VM when the provider reports it, else null (Vercel). */
  execDetached(id: string, command: string): Promise<{ handle: string; pid: number | null }>;
  running(id: string, handle: string, signal?: AbortSignal): Promise<boolean>;
  writeFile(id: string, path: string, content: string | { base64: string }): Promise<void>;
  /** Hard stop + delete (idempotent: an id the provider no longer has is fine). */
  delete(id: string): Promise<void>;
  /** Sandboxes this caller may see whose name starts with `prefix` (orphan cleanup). */
  list(prefix: string): Promise<{ id: string; name: string; createdAt: string | null }[]>;
  /**
   * Native egress allow-list (Vercel network policy). When present the runner uses it for the session lockdown instead
   * of the in-VM proxy + nftables (core/egress.ts). Throws when it cannot be applied: the open then fails (fail closed).
   */
  lockdown?(id: string, hosts: string[]): Promise<void>;
  /** Provider-neutral cost estimate for `seconds` of this size. */
  estCostUsd(seconds: number): number;
}

// ---------------------------------------------------------------- vercel (through the broker)

const BROKER = "/api/worker/sandboxes";

async function broker(path: string, init: { method?: string; json?: unknown; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${CFG.token}`, "X-Octillion-Orchestrator": CFG.orchestratorId };
  let body: string | undefined;
  if (init.json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(init.json); }
  const signals = [AbortSignal.timeout(init.timeoutMs ?? 60_000)];
  if (init.signal) signals.push(init.signal);
  const res = await fetch(`${CFG.url}${BROKER}${path}`, { method: init.method ?? "GET", headers, body, signal: AbortSignal.any(signals) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError(res.status, `broker ${init.method ?? "GET"} ${BROKER}${path.split("?")[0]} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return res;
}
const brokerJson = async (path: string, init: Parameters<typeof broker>[1] = {}): Promise<any> => {
  const t = await (await broker(path, init)).text();
  return t ? JSON.parse(t) : null;
};
const one = (id: string) => `/${encodeURIComponent(id)}`;

/** Reads the broker's ND-JSON command stream (frames: stdout / stderr / exit / error). */
export async function readCommandFrames(res: Response, onStdout: (s: string) => void, onStderr: (s: string) => void): Promise<{ exitCode: number | null }> {
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
    else if (f.type === "error") throw new HttpError(502, `sandbox command stream error: ${f.message ?? f.error}`);
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

const LONG_DIR = "/tmp/.octi-x";

/** `graceSec`: how long past its timeout a long (detached) step may still report before it fails (tests shorten it). */
export function vercelProvider(o2: { graceSec?: number } = {}): SandboxProvider {
  const max = SANDBOX.vercelExecMaxSeconds;
  const longDirReady = new Set<string>();
  const p: SandboxProvider = {
    name: "vercel",
    get size() { return VERCEL_SIZES[SANDBOX.vercelSize] ? SANDBOX.vercelSize : "default"; },
    tailSeconds: Math.max(20, max - 40),
    async create(o) {
      // The server names it (o.name is a hint for attribution), records it as ours, and sizes and times it out.
      const r = await brokerJson("", { method: "POST", json: { session_id: o.sessionId, size: o.size, timeout_sec: o.timeoutSec, name: o.name }, timeoutMs: 120_000 });
      if (!r?.id) throw new Error(`sandbox broker returned no id: ${JSON.stringify(r).slice(0, 300)}`);
      return String(r.id);
    },
    async get(id) {
      try {
        const r = await withRetry(() => brokerJson(one(id), { timeoutMs: 30_000 }), 3);
        return { state: (["ready", "starting", "stopped", "gone"].includes(r?.state) ? r.state : "starting") as VmState, detail: r?.detail };
      } catch (e) {
        if (e instanceof HttpError && (e.status === 404 || e.status === 410)) return { state: "gone" };
        throw e;
      }
    },
    async waitReady(id, timeoutMs) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const g = await p.get(id);
        if (g.state === "ready") return;
        if (g.state === "stopped" || g.state === "gone") throw new Error(`vercel sandbox ${id} is ${g.state}${g.detail ? `: ${g.detail}` : ""}`);
        if (Date.now() > until) throw new Error(`vercel sandbox ${id} not ready after ${timeoutMs / 1000}s (${g.detail ?? g.state})`);
        await sleep(1000);
      }
    },
    async exec(id, command, o) {
      if (o.timeoutSec <= max) {
        const r = await brokerJson(`${one(id)}/exec`, { method: "POST", json: { command, timeout_sec: o.timeoutSec }, timeoutMs: (o.timeoutSec + 30) * 1000 });
        return { exitCode: r?.exitCode ?? null, stdout: r?.stdout ?? "", stderr: r?.stderr ?? "" };
      }
      // Longer than one broker call may last: the script runs detached under `timeout`, writing its output and exit code
      // to files; we poll until it is done and read them back.
      if (!longDirReady.has(id)) {
        const mk = await p.exec(id, `install -d -m 700 ${LONG_DIR}`, { timeoutSec: 30 });
        if (mk.exitCode !== 0) throw new Error(`mkdir ${LONG_DIR} failed: ${mk.stderr.slice(-300)}`);
        longDirReady.add(id);
      }
      const f = `${LONG_DIR}/${randomBytes(6).toString("hex")}`;
      await withRetry(() => p.writeFile(id, `${f}.sh`, command), 3);
      const { handle } = await p.execDetached(id, `timeout -k 10 ${o.timeoutSec} bash ${f}.sh > ${f}.out 2> ${f}.err < /dev/null; echo $? > ${f}.rc`);
      const label = (command.split("\n").find((l) => l.trim() && !l.trim().startsWith("#")) ?? "command").trim().slice(0, 120);
      // Our wrapper's rc file is the ground truth; the provider's status is a second opinion. Past the step's timeout
      // (+60 s for `timeout -k`) the step fails with a clear error instead of being polled forever.
      const grace = o2.graceSec ?? 60, until = Date.now() + (o.timeoutSec + grace) * 1000;
      for (;;) {
        const rc = await p.exec(id, `test -e ${f}.rc && echo done || true`, { timeoutSec: 30 }).catch(() => ({ exitCode: null, stdout: "", stderr: "" }));
        if (/done/.test(rc.stdout)) break;
        if (!(await p.running(id, handle).catch(() => true))) break;
        if (Date.now() > until) {
          await p.exec(id, `pkill -KILL -f ${shq(`${f}.sh`)} || true`, { timeoutSec: 30 }).catch(() => {});
          throw new Error(`setup step did not finish within ${o.timeoutSec}s (+${grace}s): ${label}`);
        }
        await sleep(4000);
      }
      const r = await withRetry(() => brokerJson(`${one(id)}/exec`, { method: "POST", timeoutMs: 120_000,
        // Each stream read back at most 16 MiB (the broker buffers it), with a marker when cut; the step's tail is also
        // kept in setup.log for the admin diagnostics (Compute: sandbox logs).
        json: { command: `o() { s=$(stat -c %s "$1" 2>/dev/null || echo 0); head -c 16777216 "$1" 2>/dev/null; [ "$s" -le 16777216 ] || printf "\\n[output truncated at 16 MiB]\\n"; }; rc=$(cat ${f}.rc 2>/dev/null || echo 124); { echo "== $(date -u +%FT%TZ) exit $rc: "${shq(label)}; tail -c 32768 ${f}.out; tail -c 32768 ${f}.err; } >> ${LONG_DIR}/setup.log 2>/dev/null; o ${f}.out; o ${f}.err >&2; rm -f ${shq(f)}.*; exit "$rc"`, timeout_sec: 60 } }), 3);
      return { exitCode: r?.exitCode ?? null, stdout: r?.stdout ?? "", stderr: r?.stderr ?? "" };
    },
    async execStream(id, command, o) {
      const t = Math.min(o.timeoutSec, max);
      const res = await broker(`${one(id)}/exec`, { method: "POST", json: { command, timeout_sec: t, stream: true }, timeoutMs: (t + 30) * 1000, signal: o.signal });
      return readCommandFrames(res, o.onStdout, o.onStderr);
    },
    async execDetached(id, command) {
      const r = await brokerJson(`${one(id)}/commands`, { method: "POST", json: { command }, timeoutMs: 60_000 });
      if (!r?.command_id) throw new Error(`sandbox broker detached start returned no command id: ${JSON.stringify(r).slice(0, 300)}`);
      return { handle: String(r.command_id), pid: null };
    },
    async running(id, handle, signal) {
      const r = await withRetry(() => brokerJson(`${one(id)}/commands/${encodeURIComponent(handle)}`, { timeoutMs: 30_000, signal }), 3);
      return !!r?.running;
    },
    async writeFile(id, path, content) {
      await brokerJson(`${one(id)}/files`, { method: "PUT", timeoutMs: 120_000,
        json: typeof content === "string" ? { path, content } : { path, content_base64: content.base64 } });
    },
    async delete(id) {
      try { await withRetry(() => broker(one(id), { method: "DELETE", timeoutMs: 60_000 }), 3); }
      catch (e) {
        if (e instanceof HttpError && (e.status === 404 || e.status === 410)) return;
        // Vercel stops it at its timeout anyway (persistent: false), and the server's reaper deletes what is left.
        log(`[vercel ${id}] delete failed; it stops at its timeout and the server's reaper deletes it:`, String(e));
      }
    },
    async list(prefix) {
      const r = await withRetry(() => brokerJson(`?${new URLSearchParams({ prefix })}`, { timeoutMs: 30_000 }), 3);
      return ((r?.sandboxes ?? []) as any[]).map((s) => ({ id: String(s.id), name: String(s.name ?? s.id), createdAt: s.created_at ?? null }));
    },
    async lockdown(id, hosts) {
      await brokerJson(`${one(id)}/network-policy`, { method: "POST", json: { allow: hosts }, timeoutMs: 60_000 });
    },
    estCostUsd: (seconds) => vercelEstCostUsd(p.size, seconds),
  };
  return p;
}

/** The broker's view of Vercel Sandbox (startup check): configured or not, and why. */
export async function vercelBrokerConfig(): Promise<{ configured: boolean; reason?: string; region?: string; via?: string }> {
  return brokerJson("/config", { timeoutMs: 30_000 });
}
