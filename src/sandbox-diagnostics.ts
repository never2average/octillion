import { getDb } from "./db.js";
import { vercelClient, type VercelClient } from "./vercel-sandbox.js";
import { VLOG, VPID } from "../orchestrator/deploy/vercel-orch.js";

/**
 * Admin diagnostics for Vercel Sandboxes (Compute: "Sandbox logs" in the orchestrator and session peeks). Before this,
 * nothing inside a Vercel sandbox could be seen: the API holds the only credentials, and the orchestrator log lives in
 * the sandbox. Read-only by construction:
 *  - two fixed scripts (an orchestrator's log and supervisor state; a worker's setup log, harness error logs and run
 *    state). The only input that reaches a script is the byte count, clamped to 1..256 KB. No arbitrary commands.
 *  - platform admins only (the admin router's requirePlatformAdmin), through the provider client on the server.
 *  - everything token-like in the output is redacted (redactSecrets) before it leaves the API.
 */

export const LOG_KB_MAX = 256;
/** The worker runner's setup log and run files (orchestrator/core/sandbox-provider.ts LONG_DIR, runners.ts VM_DIR). */
const WORKER_SETUP_LOG = "/tmp/.octi-x/setup.log";
const WORKER_DIR = "/tmp/octi";

/** Token-shaped values out: our own (ogw_, owk_, wt_), providers' keys, bearer and basic credentials, KEY=value secrets, JWTs. */
export function redactSecrets(s: string): string {
  return s
    .replace(/\b(ogw_|owk_|wt_|sk-ant-|sk-proj-|sk-|gho_|ghp_|ghs_|github_pat_|xox[abpr]-|AKIA|AIza|re_|vcp_)[A-Za-z0-9_\-]{6,}/g, "$1***")
    .replace(/\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}(\.[A-Za-z0-9_\-]*)?/g, "eyJ***")
    .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+\/\-]{8,}=*/gi, "$1 ***")
    .replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)[A-Z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/g, "$1=***")
    .replace(/(\/\/[^\/\s:@]+:)[^@\s\/]+@/g, "$1***@");
}

const orchestratorScript = (bytes: number) => `echo "== ${VLOG} (last ${bytes} bytes)"
(sudo -n tail -c ${bytes} ${VLOG} 2>/dev/null || tail -c ${bytes} ${VLOG} 2>&1)
echo; echo "== supervisor"; (sudo -n cat ${VPID} 2>/dev/null || echo "no ${VPID}")
echo "== processes"; ps -eo pid,user,etime,args 2>/dev/null | grep -v ' \\[' | head -40
echo "== disk"; df -h / 2>/dev/null | tail -n 1`;

const workerScript = (bytes: number) => `for f in ${WORKER_SETUP_LOG} ${WORKER_DIR}/err-*.log; do [ -e "$f" ] || continue; echo "== $f (last ${bytes} bytes)"; tail -c ${bytes} "$f"; echo; done
echo "== run files"; ls -la ${WORKER_DIR} 2>&1 | head -60
for f in ${WORKER_DIR}/pid-* ${WORKER_DIR}/exit-*; do [ -e "$f" ] && echo "$f: $(cat "$f")"; done
echo "== processes"; ps -eo pid,user,etime,args 2>/dev/null | grep -v ' \\[' | head -40`;

/** Runs one of the fixed scripts and reads its output (bounded wait). */
async function readOut(c: VercelClient, name: string, script: string): Promise<{ output: string; exit_code: number | null }> {
  const g = await c.get(name);
  if (!g.session) throw Object.assign(new Error(`sandbox ${name} has no running session (${g.sessionStatus || g.status || "unknown"})`), { status: 409 });
  const id = await c.run(g.session, script);
  const deadline = Date.now() + 60_000;
  let fin = { done: false, exitCode: null as number | null };
  while (!fin.done && Date.now() < deadline) fin = await c.finished(g.session, id, 5000);
  if (!fin.done) { await c.kill(g.session, id).catch(() => {}); throw Object.assign(new Error("the log read did not finish within 60 s"), { status: 504 }); }
  let output = "";
  for await (const f of c.logs(g.session, id, AbortSignal.timeout(30_000))) if (f.stream !== "error") output += f.data;
  return { output: redactSecrets(output).slice(-(LOG_KB_MAX * 1024 + 8192)), exit_code: fin.exitCode };
}

export class DiagnosticsError extends Error { constructor(public status: number, msg: string) { super(msg); } }

/**
 * The last `kb` KB of an orchestrator's log (orchestrator_sandboxes row id), or of a worker session's setup and run logs
 * (agent session id: its newest worker sandbox). Vercel sandboxes only (sessions from before boat.dev's retirement have none).
 */
export async function sandboxLogs(q: { orchestrator?: unknown; session?: unknown; kb?: unknown }, o: { oidcToken?: string | null; client?: VercelClient | { not_configured: string } } = {}) {
  const kb = Math.max(1, Math.min(LOG_KB_MAX, Math.round(Number(q.kb) || 64)));
  const db = await getDb();
  let target: { kind: "orchestrator" | "session"; name: string; provider: string; live: boolean };
  if (q.orchestrator != null && q.orchestrator !== "") {
    const [r] = await db.query<{ sandbox_id: string | null; provider: string; state: string }>(
      "/* tenant: admin-only (platform admins): an orchestrator sandbox by row id */ SELECT sandbox_id, provider, state FROM orchestrator_sandboxes WHERE id = $1", [Number(q.orchestrator)]);
    if (!r?.sandbox_id) throw new DiagnosticsError(404, "No such orchestrator sandbox");
    target = { kind: "orchestrator", name: r.sandbox_id, provider: r.provider, live: r.state !== "deleted" };
  } else if (typeof q.session === "string" && q.session) {
    const [r] = await db.query<{ sandbox_id: string; deleted_at: Date | null }>(
      "/* tenant: admin-only (platform admins): a session's newest worker sandbox */ SELECT sandbox_id, deleted_at FROM worker_sandboxes WHERE session_id = $1 ORDER BY (deleted_at IS NULL) DESC, id DESC LIMIT 1", [q.session]);
    if (!r) throw new DiagnosticsError(404, "This session has no Vercel worker sandbox (sessions from before boat.dev's retirement have none)");
    target = { kind: "session", name: r.sandbox_id, provider: "vercel", live: !r.deleted_at };
  } else throw new DiagnosticsError(400, "orchestrator (row id) or session (session id) is required");
  if (target.provider !== "vercel") throw new DiagnosticsError(400, `Only Vercel sandboxes are read here; this one is on ${target.provider}`);
  if (!target.live) throw new DiagnosticsError(410, `${target.name} was deleted: there is nothing left to read`);
  const c = o.client ?? vercelClient({ oidcToken: o.oidcToken });
  if ("not_configured" in c) throw new DiagnosticsError(503, `Vercel Sandbox is not configured on this deployment: ${c.not_configured}`);
  try {
    const r = await readOut(c, target.name, target.kind === "orchestrator" ? orchestratorScript(kb * 1024) : workerScript(kb * 1024));
    return { kind: target.kind, sandbox: target.name, kb, at: new Date().toISOString(), ...r };
  } catch (e) {
    const status = (e as { status?: number }).status;
    throw new DiagnosticsError(status === 404 || status === 410 ? 410 : status === 409 || status === 504 ? status : 502, redactSecrets((e as Error).message).slice(0, 400));
  }
}
