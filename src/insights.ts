/**
 * Platform analytics and health for /admin (Analytics): product usage across every account and the state of the
 * machinery behind it, in one view for Octillion staff. Customers see only their own team's usage (/app Usage).
 *
 * PostHog stays the system of record for product analytics and New Relic for traces. This view replicates the
 * numbers an admin checks daily from the records Octillion already keeps (the connector log mcp_events, accounts,
 * simulations, sessions, onboarding research), so it works before either is connected and never disagrees with
 * the account pages. Deeper questions go to PostHog and New Relic (links when configured).
 *
 *   POSTHOG_PROJECT_URL      e.g. https://us.posthog.com/project/12345   (link only)
 *   NEW_RELIC_DASHBOARD_URL  e.g. https://one.newrelic.com/...            (link only)
 */
import { getDb } from "./db.js";

const span = (days: number) => `now() - make_interval(days => ${days})`;

export async function platformAnalytics(daysIn: unknown) {
  const days = Math.min(90, Math.max(1, Number(daysIn) || 30));
  const db = await getDb();
  const W = span(days), PREV = span(days * 2);
  const calls = "method = 'tools/call'";
  const person = "coalesce(user_id, 'org:' || org_id)";

  const [totals, prev, daily, tools, clients, accounts, retention, ops, errors, newAccounts] = await Promise.all([
    db.query<Record<string, number>>(
      `SELECT count(DISTINCT org_id) FILTER (WHERE ${calls}) AS active_accounts, count(DISTINCT ${person}) FILTER (WHERE ${calls}) AS active_people,
              count(*) FILTER (WHERE ${calls}) AS calls, count(*) FILTER (WHERE ${calls} AND NOT ok) AS errors,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) FILTER (WHERE ${calls}) AS p50_ms,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) FILTER (WHERE ${calls}) AS p95_ms
         FROM mcp_events WHERE at > ${W}`),
    db.query<Record<string, number>>(
      `SELECT count(DISTINCT org_id) FILTER (WHERE ${calls}) AS active_accounts, count(DISTINCT ${person}) FILTER (WHERE ${calls}) AS active_people,
              count(*) FILTER (WHERE ${calls}) AS calls
         FROM mcp_events WHERE at > ${PREV} AND at <= ${W}`),
    db.query(
      `SELECT to_char(date_trunc('day', at), 'YYYY-MM-DD') AS day, count(DISTINCT org_id) AS accounts, count(DISTINCT ${person}) AS people,
              count(*) AS calls, count(*) FILTER (WHERE NOT ok) AS errors
         FROM mcp_events WHERE ${calls} AND at > ${W} GROUP BY 1 ORDER BY 1`),
    db.query(
      `SELECT name, count(DISTINCT org_id) AS accounts, count(DISTINCT ${person}) AS people, count(*) AS calls,
              round(100.0 * count(*) FILTER (WHERE NOT ok) / count(*), 1) AS error_pct,
              round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ms)) AS p50_ms, round(percentile_cont(0.95) WITHIN GROUP (ORDER BY ms)) AS p95_ms
         FROM mcp_events WHERE ${calls} AND at > ${W} GROUP BY name ORDER BY count(DISTINCT org_id) DESC, count(*) DESC`),
    // Client families from the connection handshake: "claude-ai 0.1.0" -> claude-ai.
    db.query(
      `SELECT split_part(client, ' ', 1) AS client, count(DISTINCT org_id) AS accounts, count(DISTINCT ${person}) AS people, count(*) AS connections
         FROM mcp_events WHERE method = 'initialize' AND client IS NOT NULL AND at > ${W} GROUP BY 1 ORDER BY 2 DESC, 4 DESC LIMIT 12`),
    db.query(
      `SELECT o.slug, o.name, count(*) FILTER (WHERE e.at > ${W}) AS calls, count(*) FILTER (WHERE e.at <= ${W}) AS prev_calls,
              count(*) FILTER (WHERE e.at > ${W} AND NOT e.ok) AS errors, count(DISTINCT ${person.replace(/user_id|org_id/g, (c) => `e.${c}`)}) FILTER (WHERE e.at > ${W}) AS people,
              max(e.at) AS last_seen
         FROM mcp_events e JOIN organizations o ON o.id = e.org_id
        WHERE e.${calls} AND e.at > ${PREV} GROUP BY o.slug, o.name ORDER BY count(*) FILTER (WHERE e.at > ${W}) DESC LIMIT 50`),
    // Weekly retention by account: the week of an account's first tool call, then the share active in each later week.
    db.query<{ cohort: string; size: number; week: number; active: number }>(
      `WITH firsts AS (SELECT org_id, date_trunc('week', min(at)) AS cohort FROM mcp_events WHERE ${calls} GROUP BY org_id),
            act AS (SELECT DISTINCT org_id, date_trunc('week', at) AS wk FROM mcp_events WHERE ${calls})
       SELECT to_char(f.cohort, 'YYYY-MM-DD') AS cohort, (SELECT count(*) FROM firsts f2 WHERE f2.cohort = f.cohort) AS size,
              (extract(epoch FROM a.wk - f.cohort) / 604800)::int AS week, count(DISTINCT a.org_id) AS active
         FROM firsts f JOIN act a ON a.org_id = f.org_id
        WHERE f.cohort >= date_trunc('week', now()) - interval '7 weeks'
        GROUP BY f.cohort, a.wk ORDER BY f.cohort, week`),
    db.query<Record<string, number>>(
      `SELECT (SELECT count(*) FROM simulations WHERE created_at > ${W}) AS sims,
              (SELECT count(*) FROM simulations WHERE created_at > ${W} AND status = 'completed') AS sims_completed,
              (SELECT count(*) FROM simulations WHERE status IN ('queued', 'running')) AS sims_open,
              (SELECT count(*) FROM agent_sessions WHERE queued_at > ${W}) AS sessions,
              (SELECT count(*) FROM agent_sessions WHERE queued_at > ${W} AND status = 'completed') AS sessions_completed,
              (SELECT count(*) FROM agent_sessions WHERE queued_at > ${W} AND status IN ('failed', 'timeout')) AS sessions_failed,
              (SELECT count(*) FROM agent_sessions WHERE status = 'queued') AS sessions_queued,
              (SELECT coalesce(sum(cost_usd), 0) FROM agent_sessions WHERE queued_at > ${W}) AS model_cost_usd,
              (SELECT count(*) FROM product_research WHERE created_at > ${W}) AS onboardings,
              (SELECT count(*) FROM product_research WHERE created_at > ${W} AND status = 'failed') AS onboardings_failed,
              (SELECT coalesce(sum(errors), 0) FROM gateway_usage WHERE last_at > ${W}) AS gateway_errors,
              (SELECT coalesce(sum(requests), 0) FROM gateway_usage WHERE last_at > ${W}) AS gateway_requests`),
    db.query(
      `SELECT e.at, o.name AS account, o.slug, e.method, e.name, e.client, e.error
         FROM mcp_events e JOIN organizations o ON o.id = e.org_id WHERE NOT e.ok ORDER BY e.at DESC LIMIT 15`),
    db.query<{ n: number }>(`SELECT count(*) AS n FROM organizations WHERE created_at > ${W}`),
  ]);

  const t = totals[0] ?? {}, p = prev[0] ?? {};
  const change = (now: number, before: number) => (Number(before) ? Math.round(((Number(now) - Number(before)) / Number(before)) * 100) : null);
  const cohorts = new Map<string, { cohort: string; size: number; weeks: number[] }>();
  for (const r of retention) {
    const c = cohorts.get(r.cohort) ?? { cohort: r.cohort, size: Number(r.size), weeks: [] };
    c.weeks[Number(r.week)] = Math.round((Number(r.active) / Math.max(1, Number(r.size))) * 100);
    cohorts.set(r.cohort, c);
  }
  return {
    days,
    links: { posthog: process.env.POSTHOG_PROJECT_URL || null, new_relic: process.env.NEW_RELIC_DASHBOARD_URL || null,
             posthog_events: Boolean(process.env.POSTHOG_API_KEY), tracing: Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT) },
    totals: {
      active_accounts: Number(t.active_accounts ?? 0), active_people: Number(t.active_people ?? 0), calls: Number(t.calls ?? 0),
      error_pct: Number(t.calls) ? Math.round((Number(t.errors) / Number(t.calls)) * 1000) / 10 : 0,
      p50_ms: t.p50_ms == null ? null : Math.round(Number(t.p50_ms)), p95_ms: t.p95_ms == null ? null : Math.round(Number(t.p95_ms)),
      new_accounts: Number(newAccounts[0]?.n ?? 0),
      change: { active_accounts: change(t.active_accounts, p.active_accounts), active_people: change(t.active_people, p.active_people), calls: change(t.calls, p.calls) },
    },
    daily, tools, clients,
    accounts: accounts.map((a: any) => ({ ...a, calls: Number(a.calls), prev_calls: Number(a.prev_calls),
      trend: change(a.calls, a.prev_calls), at_risk: Number(a.prev_calls) >= 5 && Number(a.calls) <= Number(a.prev_calls) / 2 })),
    retention: [...cohorts.values()].map((c) => ({ ...c, weeks: Array.from({ length: 8 }, (_, i) => c.weeks[i] ?? null) })),
    ops: Object.fromEntries(Object.entries(ops[0] ?? {}).map(([k, v]) => [k, Number(v)])),
    errors,
  };
}
