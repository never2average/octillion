/**
 * The last 24 hours, hour by hour, for the sparklines on Health › Jobs and Health › Sessions (GET /compute/trends).
 * Queue, running and orchestrators are the autoscaler's samples averaged per hour (autoscaler_ticks); the rest are
 * counted from the records by the hour they happened: sessions by when they ended (failed, the day's top failure class,
 * model spend) or started (wait), orchestrator launches and jobs by when they were created. Admin only, across orgs.
 */
import { getDb } from "./db.js";
import { classifySession } from "./error-classes.js";

const HOURS = 24;
type Series = Record<string, number[]>;

export async function computeTrends() {
  const db = await getDb();
  const end = Math.floor(Date.now() / 3_600_000) + 1, start = end - HOURS;
  const from = new Date(start * 3_600_000);
  const hour = (c: string) => `floor(extract(epoch FROM ${c}) / 3600)::bigint`;
  const s: Series = {};
  const put = (k: string, rows: { h: unknown; v: unknown }[], round = false) => {
    const out = Array.from({ length: HOURS }, () => 0);
    for (const r of rows) {
      const i = Number(r.h) - start;
      if (i >= 0 && i < HOURS) out[i] = round ? Math.round(Number(r.v ?? 0) * 100) / 100 : Number(r.v ?? 0);
    }
    s[k] = out;
  };

  const [ticks, ended, waits, launches, jobs, failed] = await Promise.all([
    db.query<{ h: unknown; queued: unknown; running: unknown; research: unknown; orchestrators: unknown; unclaimable: unknown }>(
      `SELECT ${hour("at")} AS h, avg(queued) AS queued, avg(running) AS running, avg(research) AS research, avg(orchestrators) AS orchestrators,
              avg(unclaimable) AS unclaimable FROM autoscaler_ticks WHERE at >= $1 GROUP BY 1`, [from]),
    db.query<{ h: unknown; ended: unknown; failed: unknown; usd: unknown }>(
      `/* tenant: internal: admin Health trends across all orgs */
       SELECT ${hour("ended_at")} AS h, count(*) AS ended, count(*) FILTER (WHERE status IN ('failed', 'timeout')) AS failed, coalesce(sum(cost_usd), 0) AS usd
         FROM agent_sessions WHERE ended_at >= $1 GROUP BY 1`, [from]),
    db.query<{ h: unknown; v: unknown }>(
      `/* tenant: internal: admin Health trends across all orgs */
       SELECT ${hour("started_at")} AS h, percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM started_at - queued_at)) AS v
         FROM agent_sessions WHERE started_at >= $1 GROUP BY 1`, [from]),
    db.query<{ h: unknown; v: unknown }>(
      `SELECT ${hour("created_at")} AS h, count(*) AS v FROM orchestrator_sandboxes WHERE launch_step IS NOT NULL AND created_at >= $1 GROUP BY 1`, [from]),
    db.query<{ h: unknown; jobs: unknown; failed: unknown }>(
      `/* tenant: internal: admin Health trends across all orgs */
       SELECT h, sum(jobs) AS jobs, sum(failed) AS failed FROM (
         SELECT ${hour("s.created_at")} AS h, count(*) AS jobs,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM agent_sessions a WHERE a.simulation_id = s.id AND a.status IN ('failed', 'timeout'))) AS failed
           FROM simulations s WHERE s.created_at >= $1 GROUP BY 1
         UNION ALL
         SELECT ${hour("created_at")} AS h, count(*) AS jobs, count(*) FILTER (WHERE status = 'failed') AS failed
           FROM product_research WHERE created_at >= $1 GROUP BY 1) x GROUP BY h`, [from]),
    db.query<{ h: unknown; status: string; agent_id: string | null; error_message: string | null; completed_reason: string | null; infra_error: string | null }>(
      `/* tenant: internal: admin Health trends, classified into counts across all orgs */
       SELECT ${hour("ended_at")} AS h, status, agent_id, error_message, completed_reason, metadata->>'infra_error' AS infra_error
         FROM agent_sessions WHERE status IN ('failed', 'timeout') AND ended_at >= $1 ORDER BY ended_at DESC LIMIT 5000`, [from]),
  ]);

  for (const k of ["queued", "running", "research", "orchestrators", "unclaimable"] as const)
    put(k, ticks.map((r) => ({ h: r.h, v: r[k] })), true);
  put("ended", ended.map((r) => ({ h: r.h, v: r.ended })));
  put("failed", ended.map((r) => ({ h: r.h, v: r.failed })));
  put("spend", ended.map((r) => ({ h: r.h, v: r.usd })), true);
  put("wait_p50", waits, true);
  put("launches_failed", launches);
  put("jobs", jobs.map((r) => ({ h: r.h, v: r.jobs })));
  put("jobs_failed", jobs.map((r) => ({ h: r.h, v: r.failed })));
  // The day's most common failure class, hour by hour.
  const classed = failed.map((f) => ({ h: Number(f.h), key: classifySession({ ...f, metadata: { infra_error: f.infra_error } })?.key ?? null }));
  const tally = new Map<string, number>();
  for (const c of classed) if (c.key) tally.set(c.key, (tally.get(c.key) ?? 0) + 1);
  const top = [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const byHour = new Map<number, number>();
  for (const c of classed) if (top && c.key === top) byHour.set(c.h, (byHour.get(c.h) ?? 0) + 1);
  put("top_failure", [...byHour].map(([h, v]) => ({ h, v })));
  return { from: from.toISOString(), hours: HOURS, series: s };
}
