// The Compute page's only two actions (/admin/compute, docs/compute-and-traces-spec.md §2 and step 7). Everything else
// on the page is read only. Both write an admin audit line (src/admin.ts log): who, what, and what came of it.
//
//   POST /compute/tick                 Run a tick now: one autoscaler tick at once (src/autoscaler.ts runTickNow).
//   POST /compute/sessions/:id/cancel  Cancel a queued or running session. Only the database changes here: a running
//                                      session's next heartbeat is refused (409), so its orchestrator kills the
//                                      sandbox and does not report it complete (orchestrator/core/session.ts).
import { AdminError, log } from "./admin.js";
import { getDb } from "./db.js";
import { runTickNow } from "./autoscaler.js";
import { finishSimulationIfDone } from "./worker.js";

/** What "Run a tick now" shows: the counts for its toast, the tick's note or error, and whether this server led it. */
export interface TickResult {
  at: string; leader: boolean; holder: string; launched: number; reaped: number; note: string | null; error: string | null;
  /** One plain-English line for the toast. */
  message: string;
}

export function tickMessage(st: { leader: boolean; launched?: string[]; reaped?: unknown[]; note?: string; error?: string }): string {
  if (st.error) return `The tick failed: ${st.error}`;
  if (!st.leader) return "Another server holds the autoscaler lease and ticks on its own; this one did nothing.";
  return `Tick ran: launched ${st.launched?.length ?? 0}, reaped ${st.reaped?.length ?? 0}.${st.note ? ` ${st.note}` : ""}`;
}

export async function runTick(actor: string): Promise<TickResult> {
  const st = await runTickNow();
  const r: TickResult = { at: st.at, leader: st.leader, holder: st.holder, launched: st.launched?.length ?? 0, reaped: st.reaped?.length ?? 0,
    note: st.note ?? null, error: st.error ?? null, message: tickMessage(st) };
  log(actor, "compute.tick", null, { leader: r.leader, launched: st.launched ?? [], reaped: r.reaped, note: r.note, error: r.error });
  return r;
}

/**
 * Cancel one session: queued or running becomes cancelled, its gateway tokens are revoked (no more model calls), and
 * who cancelled it is kept in its metadata. A queued session is simply never claimed. When it was the last open
 * session of its run, the run finishes as a session ending would finish it.
 */
export async function cancelSession(actor: string, id: string) {
  const db = await getDb();
  const was = await db.transaction(async (tx) => {
    const [s] = await tx.query<{ status: string }>(
      "/* tenant: internal: admin Compute page, one session by id (admin only) */ SELECT status FROM agent_sessions WHERE id = $1 FOR UPDATE", [id]);
    if (!s) throw new AdminError(`No session ${id}`, 404);
    if (!["queued", "running"].includes(s.status)) throw new AdminError(`Session ${id} has already ended (${s.status}).`, 409);
    await tx.query(
      `/* tenant: internal: admin Compute page, one session by id (admin only) */ UPDATE agent_sessions SET status = 'cancelled', ended_at = now(),
              metadata = metadata || jsonb_build_object('cancelled_by', $2::text, 'cancelled_at', now(), 'cancelled_from', $3::text)
        WHERE id = $1`, [id, actor, s.status]);
    await tx.query("/* tenant: internal: admin Compute page, one session by id (admin only) */ UPDATE gateway_tokens SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL", [id]);
    return s.status;
  });
  const [row] = await db.query<{ simulation_id: string; slug: string | null; sandbox_id: string | null; worker_id: string | null }>(
    `/* tenant: internal: admin Compute page, one session by id (admin only) */
     SELECT s.simulation_id, o.slug, s.sandbox_id, s.worker_id FROM agent_sessions s LEFT JOIN organizations o ON o.id = s.org_id WHERE s.id = $1`, [id]);
  await finishSimulationIfDone(row!.simulation_id);
  log(actor, "compute.session.cancel", row?.slug ?? null, { session_id: id, was, simulation_id: row!.simulation_id, worker_id: row?.worker_id ?? null, sandbox_id: row?.sandbox_id ?? null });
  return { id, status: "cancelled" as const, was,
    message: was === "running" ? "Session cancelled. Its sandbox stops when its orchestrator next heartbeats." : "Session cancelled. No orchestrator will claim it." };
}
