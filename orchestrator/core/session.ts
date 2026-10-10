/**
 * WorkerSession: one claimed Octillion job running in one sandbox, possibly over several harness runs
 * (launch, then resumes carrying the simulated developer's replies).
 *
 * This is the deterministic core. The Pi orchestrator (pi-octillion/) drives it through tools; worker.ts drives
 * it with no LLM at all (launch -> wait -> finish). Both share every guarantee here: heartbeats, the
 * MAX_SESSION_MINUTES deadline, server-side cancellation, max_user_turns, the git diff event, /complete, cleanup.
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { getAdapter, type HarnessAdapter, type TurnDigest } from "../harnesses/adapters.js";
import { CFG } from "./config.js";
import type { Runner, Sandbox, RunExit } from "./runners.js";
import { EventSink } from "./sink.js";
import { UsageTracker } from "./usage.js";
import { api, HttpError, log, withRetry } from "./util.js";

export interface Profile {
  slug?: string;
  name?: string;
  summary?: string;
  attributes?: Record<string, unknown>;
  instructions?: string;
}

export interface Job {
  session_id: string;
  simulation_id: string;
  org_id?: number;
  product_id?: number;
  model: string;
  harness: string;
  attempt: number;
  prompt: string;
  repo_url: string | null;
  language: string | null;
  max_user_turns?: number;
  profile?: Profile | null;
}

/** What the orchestrator sees after a harness run. Contains no Octillion ids. */
export interface TurnReport {
  session: string;
  run: number;
  exited: boolean;
  exit_code: number | null;
  ok: boolean;
  error: string | null;
  last_assistant_text: string;
  commands: string[];
  files: string[];
  user_turns_used: number;
  user_turns_left: number;
  /** True when a reply is possible: run ended cleanly, the harness gave a resumable id, turns left, session alive. */
  can_reply: boolean;
  /** Set when the session can only be finished (timeout, cancelled, shutdown, failure). */
  stop_reason: string | null;
}

export type FinishHint = { status?: string; note?: string; orchestrator?: Record<string, unknown> };

export const activeSessions = new Set<WorkerSession>();
let shuttingDown = false;
export function markShuttingDown() { shuttingDown = true; }

const TEXT_CAP = 8000;

/** Validate harness + key without touching a sandbox. */
export function adapterFor(job: Job): HarnessAdapter {
  const a = getAdapter(job.harness);
  if (!a.hasKey({ anthropic: CFG.anthropicKey, openai: CFG.openaiKey })) throw new Error(`Worker has no API key for ${a.id}`);
  return a;
}

export async function completeJob(sessionId: string, body: Record<string, unknown>) {
  try {
    const res = await withRetry(() => api(`/api/worker/sessions/${encodeURIComponent(sessionId)}/complete`, { json: body }));
    log(`[${sessionId}] complete ${body.status}`, JSON.stringify(res));
  } catch (e) {
    log(`[${sessionId}] /complete failed (server will time it out):`, String(e));
  }
}

export async function claimJobs(limit: number, harness: string | undefined = CFG.harness): Promise<Job[]> {
  const res = (await api("/api/worker/claim", {
    json: { worker_id: CFG.workerId, limit: Math.max(1, Math.min(limit, 50)), models: CFG.models, harness },
  })) as { jobs?: Job[] };
  return res?.jobs ?? [];
}

export class WorkerSession {
  readonly handle = `w_${randomUUID().slice(0, 8)}`;
  readonly maxUserTurns: number;
  readonly started = Date.now();
  private sandbox: Sandbox | null = null;
  private sink: EventSink;
  private tracker = new UsageTracker();
  private hbTimer: NodeJS.Timeout | null = null;
  private deadline: NodeJS.Timeout | null = null;
  private current: Promise<{ exit: RunExit; digest: TurnDigest }> | null = null;
  private last: { exit: RunExit; digest: TurnDigest } | null = null;
  private resumeId: string | null = null;
  private stderrTail = "";
  private finishing: Promise<{ status: string; skipped: boolean }> | null = null;
  runs = 0;
  userTurns = 0;
  timedOut = false;
  cancelledByServer = false;
  startError: string | null = null;

  private constructor(readonly job: Job, readonly adapter: HarnessAdapter, private runner: Runner) {
    this.maxUserTurns = Math.max(0, Number.isFinite(job.max_user_turns) ? Number(job.max_user_turns) : CFG.defaultMaxUserTurns);
    this.sink = new EventSink(
      { org_id: job.org_id ?? 0, product_id: job.product_id ?? 0, simulation_id: job.simulation_id, session_id: job.session_id, model: job.model },
      (status) => this.serverRejected(status),
    );
  }

  get finished() { return this.finishing !== null; }
  get running() { return this.current !== null; }

  /**
   * Open the sandbox and launch the harness with the scenario prompt (verbatim, on stdin).
   * Never throws for job-level problems: the session is finished as failed and returned.
   */
  static async start(job: Job, runner: Runner): Promise<WorkerSession> {
    let adapter: HarnessAdapter;
    try { adapter = adapterFor(job); }
    catch (e) {
      await completeJob(job.session_id, { status: "failed", error_message: String(e instanceof Error ? e.message : e) });
      throw e;
    }
    const s = new WorkerSession(job, adapter, runner);
    activeSessions.add(s);
    await s.sink.init();
    s.sink.start();
    const enc = encodeURIComponent(job.session_id);
    s.hbTimer = setInterval(() => {
      api(`/api/worker/sessions/${enc}/heartbeat`).catch((e) => {
        if (e instanceof HttpError && (e.status === 409 || e.status === 404)) s.serverRejected(e.status);
      });
    }, CFG.heartbeatMs);
    s.deadline = setTimeout(() => { s.timedOut = true; log(`[${job.session_id}] max duration hit; killing`); void s.sandbox?.kill(); }, CFG.maxSessionMs);
    try {
      s.sandbox = await runner.open({ adapter, harness: job.harness, jobKey: job.session_id, repoUrl: job.repo_url, env: adapter.env({ anthropic: CFG.anthropicKey, openai: CFG.openaiKey }) });
      log(`[${job.session_id}] ${s.handle} started ${adapter.id}/${job.model} in ${s.sandbox.id}${job.repo_url ? ` repo=${job.repo_url}` : ""}`);
      await s.launch(job.prompt, null);
    } catch (e) {
      s.startError = String(e instanceof Error ? e.message : e);
      log(`[${job.session_id}] start failed:`, s.startError);
    }
    return s;
  }

  private serverRejected(status: number) {
    if (this.cancelledByServer) return;
    this.cancelledByServer = true;
    log(`[${this.job.session_id}] server rejected the session (${status}); stopping sandbox`);
    void this.sandbox?.kill();
  }

  private argvBin(): string | undefined {
    if (this.runner.name !== "local") return undefined;
    return this.adapter.id === "claude-code" ? CFG.claudeBin : this.adapter.id === "codex" ? CFG.codexBin : undefined;
  }

  /** Start one harness run. `resumeId` null = first launch. */
  private async launch(input: string, resumeId: string | null): Promise<void> {
    const sb = this.sandbox!;
    const o = { model: this.job.model, workdir: sb.workdir, maxBudgetUsd: CFG.maxBudgetUsd, bin: this.argvBin() };
    const argv = resumeId ? this.adapter.resumeArgv({ ...o, sessionId: resumeId }) : this.adapter.launchArgv(o);
    const run = ++this.runs;
    const digest = this.adapter.newDigest();
    const turn = await sb.runTurn(argv, input);
    let tail = "";
    turn.stderr.on("data", (d: Buffer | string) => { tail = (tail + d.toString()).slice(-8000); });
    const rl = createInterface({ input: turn.stdout, crlfDelay: Infinity });
    const linesDone = new Promise<void>((r) => rl.once("close", () => r()));
    rl.on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      try {
        const ev = JSON.parse(t);
        if (ev && typeof ev === "object" && !Array.isArray(ev)) {
          this.tracker.observe(ev);
          digest.observe(ev);
          this.sink.pushLine(t, ev); // verbatim (api mode)
          return;
        }
      } catch { /* non-JSON */ }
      this.sink.push({ type: "raw_stdout", text: t.slice(0, 20_000) });
    });
    this.current = (async () => {
      const exit = await turn.exited;
      await Promise.race([linesDone, new Promise((r) => setTimeout(r, 5000))]);
      rl.close();
      if (tail.trim()) { this.stderrTail = tail; this.sink.push({ type: "worker_stderr", run, text: tail.slice(-4000) }); }
      const d = digest.result();
      if (d.sessionId) this.resumeId = d.sessionId;
      const r = { exit, digest: d };
      this.last = r;
      this.current = null;
      return r;
    })();
  }

  private stopReason(): string | null {
    if (this.startError) return `start failed: ${this.startError}`;
    if (this.timedOut) return "timeout";
    if (this.cancelledByServer) return "cancelled by server";
    if (shuttingDown) return "worker shutting down";
    if (this.finished) return "finished";
    return null;
  }

  private lastFailed(): string | null {
    if (!this.last) return this.startError ? this.startError : "no run";
    const { exit, digest } = this.last;
    if (exit.error) return exit.error;
    if (digest.error) return digest.error;
    if (exit.code !== 0) return `Exit code ${exit.code}${exit.signal ? ` (${exit.signal})` : ""}: ${this.stderrTail.slice(-500)}`;
    return null;
  }

  /** Wait for the current harness run to end (or `timeoutMs`), then report what the agent said and did. */
  async waitForTurn(timeoutMs?: number): Promise<TurnReport> {
    if (this.current) {
      const t = timeoutMs ? new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs)) : null;
      const res = await (t ? Promise.race([this.current, t]) : this.current);
      if (res === "timeout") return this.report(false);
    }
    return this.report(true);
  }

  private report(exited: boolean): TurnReport {
    const d = this.last?.digest;
    const failure = exited ? this.lastFailed() : null;
    const stop = this.stopReason();
    const left = Math.max(0, this.maxUserTurns - this.userTurns);
    const text = d?.lastText ?? "";
    return {
      session: this.handle,
      run: this.runs,
      exited,
      exit_code: this.last?.exit.code ?? null,
      ok: exited && !failure,
      error: failure,
      last_assistant_text: text.length > TEXT_CAP ? "…" + text.slice(-TEXT_CAP) : text, // questions sit at the end
      commands: d?.commands.slice(-25) ?? [],
      files: d?.files.slice(-40) ?? [],
      user_turns_used: this.userTurns,
      user_turns_left: left,
      can_reply: exited && !failure && !stop && left > 0 && !!this.resumeId,
      stop_reason: stop ?? (failure ? "harness failed" : left === 0 ? "max_user_turns reached" : !this.resumeId && exited ? "harness gave no resumable session id" : null),
    };
  }

  /** Emit the simulated developer's reply and resume the same harness conversation with it (verbatim, on stdin). */
  async replyAsDeveloper(text: string): Promise<{ run: number; user_turns_left: number }> {
    const reply = text.trim();
    if (!reply) throw new Error("reply is empty");
    if (reply.length > 4000) throw new Error("reply too long (max 4000 chars); developers type short chat messages");
    if (this.current) throw new Error("the sub-agent is still running; call wait_for_turn first");
    const r = this.report(true);
    if (!r.can_reply) throw new Error(`cannot reply: ${r.stop_reason ?? "not resumable"}; call finish_session`);
    this.userTurns++;
    this.sink.push({ type: "simulated_user", turn: this.userTurns, content: reply });
    await this.launch(reply, this.resumeId);
    return { run: this.runs, user_turns_left: this.maxUserTurns - this.userTurns };
  }

  kill(): Promise<void> { return this.sandbox?.kill() ?? Promise.resolve(); }

  /**
   * Idempotent. Waits for a running harness run (bounded by the session deadline), emits the git diff event,
   * flushes, deletes the sandbox and calls /complete. Status is computed here, never taken from the LLM.
   */
  finish(hint: FinishHint = {}): Promise<{ status: string; skipped: boolean }> {
    this.finishing ??= (async () => {
      try { if (this.current) await this.current; } catch { /* reported below */ }
      const sb = this.sandbox;
      if (sb && !this.timedOut && !this.cancelledByServer) {
        // Codex's stream has no edit contents: one diff event lets the scorer see every change.
        const diff = await sb.diff().catch(() => null);
        if (diff !== null) this.sink.push({ type: "file_edit", name: "git diff", content: diff });
      }
      if (this.hbTimer) clearInterval(this.hbTimer);
      if (this.deadline) clearTimeout(this.deadline);
      this.sink.stop();
      await this.sink.drain();
      await sb?.cleanup().catch(() => {});
      activeSessions.delete(this);

      let status: "completed" | "failed" | "timeout";
      let error: string | undefined;
      const failure = this.lastFailed();
      if (this.timedOut) { status = "timeout"; error = `Exceeded MAX_SESSION_MINUTES (${CFG.maxSessionMs / 60000})`; }
      else if (this.startError) { status = "failed"; error = this.startError; }
      else if (shuttingDown && failure) { status = "failed"; error = "Worker shut down"; }
      else if (failure) { status = "failed"; error = failure; }
      else status = "completed";

      if (this.cancelledByServer) { log(`[${this.job.session_id}] cancelled server-side; skipping /complete`); return { status: "cancelled", skipped: true }; }
      const u = this.tracker.usage();
      await completeJob(this.job.session_id, {
        status,
        error_message: error,
        sandbox_id: sb?.id,
        tokens_in: u.tokens_in,
        tokens_out: u.tokens_out,
        cost_usd: u.cost_usd,
        metadata: {
          ...u.meta, ...(sb?.meta() ?? {}),
          runner: this.runner.name, harness: this.adapter.id, worker_id: CFG.workerId,
          exit_code: this.last?.exit.code ?? null, exit_signal: this.last?.exit.signal ?? null,
          wall_ms: Date.now() - this.started, attempt: this.job.attempt,
          harness_runs: this.runs, simulated_user_turns: this.userTurns, max_user_turns: this.maxUserTurns,
          events: this.sink.count,
          ...(hint.status ? { orchestrator_status: hint.status } : {}),
          ...(hint.note ? { orchestrator_note: hint.note.slice(0, 500) } : {}),
          ...(hint.orchestrator ?? {}),
        },
      });
      return { status, skipped: false };
    })();
    return this.finishing;
  }
}
