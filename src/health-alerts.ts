import { getDb } from "./db.js";
import { settingNumber, settingText, freshSettings } from "./settings.js";
import { classifySession } from "./error-classes.js";
import { adminRecipients, each, keyFor, lines, SIGN, siteUrl } from "./email.js";

/**
 * Operator health alerts, checked by the 5-minute cron (src/http.ts /api/cron/autoscale):
 *
 *   failure rate   of the agent sessions that finished in the last hour (completed, failed, timeout; cancelled ones
 *                  left out), the share that failed or timed out, when at least MIN_FINISHED finished and the share is
 *                  at or over ALERT_FAILURE_RATE (%). The alert groups them by error class (src/error-classes.ts) and
 *                  lists agents that ran on another CLI version than their pin (metadata.harness_drift).
 *   stuck queue    the oldest queued session has waited ALERT_QUEUE_MINUTES or more: no orchestrator is taking work.
 *
 * Email to the operators (EMAIL_ADMIN_TO, else the platform owners) through src/email.ts, plus a Slack message when
 * ALERT_SLACK_WEBHOOK_URL is set (env only: a webhook URL is a secret). One alert per problem per UTC hour: the email
 * idempotency key carries the hour. ALERTS_ENABLED off: checked and returned, nothing sent. Never throws.
 */
export const MIN_FINISHED = 5;

export interface HealthFacts {
  finished: number; failed: number; rate: number | null;
  classes: { label: string; sessions: number }[];
  drift: { harness: string; found: string; pinned: string; sessions: number }[];
  oldest_queued_min: number | null; queued: number;
}
export interface HealthAlert { kind: "failure_rate" | "stuck_queue"; subject: string; text: string }

export async function healthFacts(now = new Date()): Promise<HealthFacts> {
  const db = await getDb();
  const rows = await db.query<{ status: string; harness: string; error_message: string | null; completed_reason: string | null; metadata: Record<string, unknown> | null; agent_id: string | null }>(
    `/* tenant: platform health across every account (operator alert) */ SELECT status, harness, error_message, completed_reason, metadata, agent_id FROM agent_sessions
      WHERE ended_at >= $1::timestamptz - interval '1 hour' AND ended_at < $1::timestamptz AND status IN ('completed', 'failed', 'timeout')`, [now.toISOString()]);
  const bad = rows.filter((r) => r.status === "failed" || r.status === "timeout");
  const classes = new Map<string, number>();
  for (const r of bad) { const c = classifySession(r)?.label ?? "Other"; classes.set(c, (classes.get(c) ?? 0) + 1); }
  const drift = new Map<string, { harness: string; found: string; pinned: string; sessions: number }>();
  for (const r of rows) {
    const d = r.metadata?.harness_drift as { found?: string; pinned?: string } | undefined;
    if (!d?.found) continue;
    const k = `${r.harness}|${d.found}|${d.pinned}`;
    const x = drift.get(k) ?? { harness: r.harness, found: String(d.found), pinned: String(d.pinned ?? "?"), sessions: 0 };
    x.sessions++; drift.set(k, x);
  }
  const [q] = await db.query<{ n: number; oldest: Date | null }>(
    `/* tenant: platform health across every account (operator alert) */ SELECT count(*)::int AS n, min(queued_at) AS oldest FROM agent_sessions WHERE status = 'queued'`);
  return {
    finished: rows.length, failed: bad.length, rate: rows.length ? bad.length / rows.length : null,
    classes: [...classes].map(([label, sessions]) => ({ label, sessions })).sort((a, b) => b.sessions - a.sessions),
    drift: [...drift.values()].sort((a, b) => b.sessions - a.sessions),
    oldest_queued_min: q?.oldest ? Math.floor((now.getTime() - new Date(q.oldest).getTime()) / 60_000) : null,
    queued: Number(q?.n ?? 0),
  };
}

/** The alerts these facts raise (pure; smoke-tested). */
export function healthAlerts(f: HealthFacts, limits: { rate: number; queueMinutes: number }): HealthAlert[] {
  const out: HealthAlert[] = [];
  if (f.finished >= MIN_FINISHED && f.rate != null && f.rate * 100 >= limits.rate) {
    const pct = Math.round(f.rate * 100);
    out.push({ kind: "failure_rate", subject: `Octillion: ${pct}% of agent sessions failed in the last hour`,
      text: lines(`${f.failed} of the ${f.finished} agent sessions that finished in the last hour failed or timed out (${pct}%, alert at ${limits.rate}%).`,
        f.classes.length ? `Why:\n${f.classes.map((c) => `- ${c.label}: ${c.sessions}`).join("\n")}` : null,
        f.drift.length ? `Ran on another CLI version than pinned:\n${f.drift.map((d) => `- ${d.harness} ${d.found} (pinned ${d.pinned}): ${d.sessions}`).join("\n")}` : null,
        `Details and fixes: ${siteUrl()}/admin/compute`) });
  }
  if (f.oldest_queued_min != null && f.oldest_queued_min >= limits.queueMinutes)
    out.push({ kind: "stuck_queue", subject: `Octillion: agent sessions waiting ${f.oldest_queued_min} minutes`,
      text: lines(`${f.queued} agent session${f.queued === 1 ? " is" : "s are"} queued, the oldest for ${f.oldest_queued_min} minutes (alert at ${limits.queueMinutes}). No orchestrator is taking work.`,
        `Check the autoscaler and orchestrators: ${siteUrl()}/admin/compute`) });
  return out;
}

async function slack(text: string): Promise<boolean> {
  const url = process.env.ALERT_SLACK_WEBHOOK_URL;
  if (!url) return false;
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10_000) });
    return r.ok;
  } catch (e) { console.error("health alert: Slack post failed:", (e as Error).message); return false; }
}

/** Check, and alert the operators. Returns what it found and sent. Never throws. */
export async function checkHealth(now = new Date()): Promise<{ facts: HealthFacts | null; alerts: string[]; emailed: number; slack: boolean; error?: string }> {
  try {
    await freshSettings();
    const facts = await healthFacts(now);
    const alerts = healthAlerts(facts, { rate: settingNumber("ALERT_FAILURE_RATE"), queueMinutes: settingNumber("ALERT_QUEUE_MINUTES") });
    if (!alerts.length || settingText("ALERTS_ENABLED") !== "on") return { facts, alerts: alerts.map((a) => a.kind), emailed: 0, slack: false };
    const hour = now.toISOString().slice(0, 13);
    const db = await getDb();
    let emailed = 0, posted = false;
    for (const a of alerts) {
      const purpose = `health:${a.kind}:${hour}`;
      // Already alerted this hour (to anyone): the email log's key carries the hour; Slack follows the same rule.
      if ((await db.query("SELECT 1 FROM email_log WHERE idempotency_key LIKE $1 AND status IN ('sent', 'sending', 'skipped') LIMIT 1", [`${purpose}:%`])).length) continue;
      const to = await adminRecipients();
      const sent = await each(to, (t) => ({ kind: "health_alert", to: t, idempotencyKey: keyFor(purpose, t), subject: a.subject, text: lines(a.text, SIGN),
        meta: { alert: a.kind, hour, finished: facts.finished, failed: facts.failed, queued: facts.queued } }));
      emailed += sent.filter((r) => r.status === "sent").length;
      posted = (await slack(`*${a.subject}*\n${a.text}`)) || posted;
      if (!to.length) console.error(`health alert ${a.kind}: no operator email address (EMAIL_ADMIN_TO or platform owners)`);
    }
    return { facts, alerts: alerts.map((a) => a.kind), emailed, slack: posted };
  } catch (e) {
    console.error("health check failed:", (e as Error).message);
    return { facts: null, alerts: [], emailed: 0, slack: false, error: (e as Error).message };
  }
}
