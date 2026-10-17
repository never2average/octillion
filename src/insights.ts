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
import * as clerk from "./clerk.js";
import { getDb } from "./db.js";

const DAY = 86_400_000;
const isoDay = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? new Date(`${v}T00:00:00Z`) : null);

/**
 * The period a report covers: from/to as YYYY-MM-DD (UTC, both days included), else the last `days` days (default 30),
 * at most 366 days. The previous period is the same length just before it, for the change figures.
 */
export function reportRange(q: { from?: unknown; to?: unknown; days?: unknown }) {
  const today = new Date(Math.floor(Date.now() / DAY) * DAY);
  let from = isoDay(q.from), to = isoDay(q.to);
  if (!from || !to || to < from) {
    const days = Math.min(366, Math.max(1, Number(q.days) || 30));
    to = today; from = new Date(today.getTime() - (days - 1) * DAY);
  }
  if ((to.getTime() - from.getTime()) / DAY > 365) from = new Date(to.getTime() - 365 * DAY);
  const end = new Date(to.getTime() + DAY); // exclusive
  const days = Math.round((end.getTime() - from.getTime()) / DAY);
  const prevFrom = new Date(from.getTime() - days * DAY);
  const lit = (d: Date) => `'${d.toISOString()}'::timestamptz`;
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), days,
    start: from, end, sql: { F: lit(from), T: lit(end), PF: lit(prevFrom) } };
}

// ---------- filters ----------
// Every filter becomes a literal SQL fragment (validated ints, quoted text), never a bind param, so the many subqueries
// below share one shape and no query needs its own parameter list.
const lit = (s: string) => `'${s.replace(/\0/g, "").replace(/'/g, "''")}'`;
const texts = (xs: string[]) => `ARRAY[${xs.map(lit).join(",")}]::text[]`;
const ints = (xs: number[]) => `'{${xs.filter(Number.isInteger).join(",")}}'::int[]`;
const list = (v: unknown): string[] =>
  [...new Set((Array.isArray(v) ? v : v == null ? [] : [v]).flatMap((x) => String(x).split(",")).map((x) => x.trim()).filter(Boolean))].slice(0, 200);
const flag = (v: unknown) => v === "1" || v === "true" || v === true;
const intIn = (v: unknown, def: number, max: number) => { const n = Number(v); return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : def; };
const intersect = (a: number[] | null, b: number[] | null) => (a == null ? b : b == null ? a : a.filter((x) => b.includes(x)));

type Orgs = Awaited<ReturnType<(typeof import("./admin.js"))["listOrgs"]>>;
// admin.ts imports this file, so it is loaded on demand (a static import would be a cycle).
const loadOrgs = async (): Promise<Orgs> => (await import("./admin.js")).listOrgs(false);

export type AnalyticsQuery = Record<string, unknown>;

/** Normalise the filter params and resolve the ones about accounts (slug, product, plan, billing, stage, at risk) to org ids. */
export async function parseFilters(q: AnalyticsQuery, range: ReturnType<typeof reportRange>, orgsOnce: () => Promise<Orgs>) {
  const db = await getDb();
  const { F, T, PF } = range.sql;
  const filters = {
    account: list(q.account), product: list(q.product), tool: list(q.tool), client: list(q.client),
    plan: list(q.plan), sub_status: list(q.sub_status), stage: list(q.stage), user: list(q.user),
    errors: flag(q.errors), at_risk: flag(q.at_risk), limit: intIn(q.limit, 200, 5000) || 200,
  };
  let orgIds: number[] | null = null, productIds: number[] | null = null;
  const ids = (rows: { id: number }[]) => rows.map((r) => Number(r.id));
  if (filters.account.length)
    orgIds = intersect(orgIds, ids(await db.query<{ id: number }>(`SELECT id FROM organizations WHERE slug = ANY(${texts(filters.account)})`)));
  if (filters.product.length) {
    const ps = await db.query<{ id: number; org_id: number }>(`SELECT id, org_id FROM products WHERE lower(name) = ANY(${texts(filters.product.map((x) => x.toLowerCase()))})`);
    productIds = ps.map((p) => Number(p.id));
    orgIds = intersect(orgIds, [...new Set(ps.map((p) => Number(p.org_id)))]);
  }
  if (filters.plan.length || filters.sub_status.length || filters.stage.length) {
    const { orgs } = await orgsOnce();
    orgIds = intersect(orgIds, orgs.filter((o) =>
      (!filters.plan.length || filters.plan.includes(o.subscription?.plan ?? "none")) &&
      (!filters.sub_status.length || filters.sub_status.includes(o.subscription?.status ?? "none")) &&
      (!filters.stage.length || filters.stage.includes(o.stage))).map((o) => Number(o.id)));
  }
  if (filters.at_risk) // the same rule as accounts[].at_risk: at least 5 calls before, and at most half as many now
    orgIds = intersect(orgIds, ids(await db.query<{ id: number }>(
      `SELECT org_id AS id FROM mcp_events WHERE method = 'tools/call' AND at >= ${PF} AND at < ${T} GROUP BY org_id
        HAVING count(*) FILTER (WHERE at < ${F}) >= 5 AND count(*) FILTER (WHERE at >= ${F}) <= count(*) FILTER (WHERE at < ${F}) / 2.0`)));
  const O = orgIds && ints(orgIds), P = productIds && ints(productIds);
  // Tool calls carry no client (only the handshake does), so a client filter also keeps the calls of accounts that
  // connected with that client in this or the previous period (the prev totals and the accounts' trend scan PF..T,
  // so an account that stopped using the client still shows up as at risk).
  const C = filters.client.length ? texts(filters.client) : null;
  const clientOnly = (a: string) => (C ? ` AND split_part(${a}client, ' ', 1) = ANY(${C})` : "");
  const clientOf = (a: string) => (C ? ` AND (split_part(${a}client, ' ', 1) = ANY(${C}) OR (${a}client IS NULL AND ${a}org_id IN
      (SELECT org_id FROM mcp_events WHERE method = 'initialize' AND split_part(client, ' ', 1) = ANY(${C}) AND at >= ${PF} AND at < ${T})))` : "");
  const orgOf = (a: string) => (O ? ` AND ${a}org_id = ANY(${O})` : "");
  // People (Clerk user ids): their own tool calls, and the runs they launched. A future per-person view pins this to the
  // signed-in user server-side, so hiding the picker never widens what someone can see.
  const U = filters.user.length ? texts(filters.user) : null;
  const userOf = (a: string) => (U ? ` AND ${a}user_id = ANY(${U})` : "");
  const byUser = (a: string, kind: "" | "sim" | "session" | "research") => !U ? ""
    : kind === "sim" ? ` AND ${a}created_by = ANY(${U})`
    : kind === "session" ? ` AND ${a}simulation_id IN (SELECT id FROM simulations WHERE created_by = ANY(${U}))`
    : kind === "research" ? ` AND ${a}org_id IN (SELECT DISTINCT org_id FROM mcp_events WHERE user_id = ANY(${U}))` : "";
  const sql = {
    /** On every mcp_events query; `a` is the table alias with its dot ("e."), or "". */
    EV: (a = "") => orgOf(a) + userOf(a) + clientOf(a) + (filters.tool.length ? ` AND ${a}method = 'tools/call' AND ${a}name = ANY(${texts(filters.tool)})` : "") + (filters.errors ? ` AND NOT ${a}ok` : ""),
    /** The clients query: only the account and client parts apply. */
    CL: (a = "") => orgOf(a) + userOf(a) + clientOnly(a),
    /** Simulations, sessions and research. */
    ORG: (a = "", kind: "" | "sim" | "session" | "research" = "") => orgOf(a) + (P ? ` AND ${a}product_id = ANY(${P})` : "") + byUser(a, kind),
    O, P, scoped: Boolean(O || P || U),
  };
  return { filters, orgIds, productIds, sql };
}

const memo = <T>(f: () => Promise<T>) => { let p: Promise<T> | null = null; return () => (p ??= f()); };

/** What the filter lists offer, for the period but not narrowed by the filters themselves. */
async function facets(range: ReturnType<typeof reportRange>, orgsOnce: () => Promise<Orgs>) {
  const db = await getDb();
  const { F, T } = range.sql;
  const [accounts, products, tools, clients, people] = await Promise.all([
    db.query<{ slug: string; name: string }>(`SELECT slug, name FROM organizations ORDER BY lower(name)`),
    db.query<{ name: string }>(`SELECT DISTINCT name FROM products ORDER BY 1`),
    db.query<{ name: string }>(`SELECT DISTINCT name FROM mcp_events WHERE method = 'tools/call' AND name IS NOT NULL AND at >= ${F} AND at < ${T} ORDER BY 1`),
    db.query<{ client: string }>(`SELECT DISTINCT split_part(client, ' ', 1) AS client FROM mcp_events WHERE method = 'initialize' AND client IS NOT NULL AND at >= ${F} AND at < ${T} ORDER BY 1`),
    db.query<{ user_id: string; account: string }>(
      `SELECT e.user_id, min(o.name) AS account FROM mcp_events e JOIN organizations o ON o.id = e.org_id
        WHERE e.user_id IS NOT NULL AND e.at >= ${F} AND e.at < ${T} GROUP BY e.user_id ORDER BY count(*) DESC LIMIT 300`),
  ]);
  // Emails from Clerk (cached a minute per user); without Clerk, or on a lookup error, the id stands in.
  const users = await Promise.all(people.map(async (u) => {
    let email: string | null = null, name: string | null = null;
    if (clerk.clerkEnabled()) try { const cu = await clerk.users.get(u.user_id); email = clerk.primaryEmail(cu).email; name = clerk.displayName(cu); } catch { /* keep the id */ }
    return { id: u.user_id, email, name, account: u.account };
  }));
  let plans: string[] = [], subStatuses = ["active", "trialing", "past_due", "canceled", "none"], stages: { id: string; label: string }[] = [];
  try {
    const { orgs, stages: st } = await orgsOnce();
    plans = [...new Set(orgs.map((o) => o.subscription?.plan ?? "none"))].sort();
    subStatuses = [...new Set([...subStatuses, ...orgs.map((o) => o.subscription?.status ?? "none")])];
    stages = st.map((s) => ({ id: s.id, label: s.label }));
  } catch { /* Stripe or WorkOS down: the lists stay empty, the report still loads */ }
  return { accounts, users, products: products.map((p) => p.name), tools: tools.map((t) => t.name), clients: clients.map((c) => c.client).filter(Boolean),
    plans, sub_statuses: subStatuses, stages };
}

/**
 * The Analytics and Health report. Filters (comma-separated lists): account (slugs), product (names), tool, client,
 * plan, sub_status, stage, errors=1, at_risk=1; limit caps the accounts rows (default 200, at most 5000).
 */
export async function platformAnalytics(q: AnalyticsQuery) {
  const range = reportRange(q);
  const { days } = range, { F, T, PF } = range.sql;
  const db = await getDb();
  const orgsOnce = memo(loadOrgs);
  const [{ filters, sql: { EV, CL, ORG, O, scoped } }, facetLists] = await Promise.all([parseFilters(q, range, orgsOnce), facets(range, orgsOnce)]);
  const GW = scoped ? `gateway_usage g JOIN agent_sessions s ON s.id = g.session_id WHERE g.last_at >= ${F} AND g.last_at < ${T}${ORG("s.", "session")}`
    : `gateway_usage g WHERE g.last_at >= ${F} AND g.last_at < ${T}`;
  // In the period, and in the period just before it.
  const inW = (c: string) => `${c} >= ${F} AND ${c} < ${T}`, inP = (c: string) => `${c} >= ${PF} AND ${c} < ${F}`;
  const calls = "method = 'tools/call'";
  const person = "coalesce(user_id, 'org:' || org_id)";

  const [totals, prev, daily, tools, clients, accounts, retention, ops, errors, newAccounts, errorsTotal, newDaily] = await Promise.all([
    db.query<Record<string, number>>(
      `SELECT count(DISTINCT org_id) FILTER (WHERE ${calls}) AS active_accounts, count(DISTINCT ${person}) FILTER (WHERE ${calls}) AS active_people,
              count(*) FILTER (WHERE ${calls}) AS calls, count(*) FILTER (WHERE ${calls} AND NOT ok) AS errors,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) FILTER (WHERE ${calls}) AS p50_ms,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) FILTER (WHERE ${calls}) AS p95_ms
         FROM mcp_events WHERE ${inW("at")}${EV()}`),
    db.query<Record<string, number>>(
      `SELECT count(DISTINCT org_id) FILTER (WHERE ${calls}) AS active_accounts, count(DISTINCT ${person}) FILTER (WHERE ${calls}) AS active_people,
              count(*) FILTER (WHERE ${calls}) AS calls
         FROM mcp_events WHERE ${inP("at")}${EV()}`),
    db.query(
      `SELECT to_char(date_trunc('day', at), 'YYYY-MM-DD') AS day, count(DISTINCT org_id) AS accounts, count(DISTINCT ${person}) AS people,
              count(*) AS calls, count(*) FILTER (WHERE NOT ok) AS errors, round(percentile_cont(0.95) WITHIN GROUP (ORDER BY ms)) AS p95_ms
         FROM mcp_events WHERE ${calls} AND ${inW("at")}${EV()} GROUP BY 1 ORDER BY 1`),
    db.query(
      `SELECT name, count(DISTINCT org_id) AS accounts, count(DISTINCT ${person}) AS people, count(*) AS calls,
              round(100.0 * count(*) FILTER (WHERE NOT ok) / count(*), 1) AS error_pct,
              round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ms)) AS p50_ms, round(percentile_cont(0.95) WITHIN GROUP (ORDER BY ms)) AS p95_ms
         FROM mcp_events WHERE ${calls} AND ${inW("at")}${EV()} GROUP BY name ORDER BY count(DISTINCT org_id) DESC, count(*) DESC`),
    // Client families from the connection handshake: "claude-ai 0.1.0" -> claude-ai.
    db.query(
      `SELECT split_part(client, ' ', 1) AS client, count(DISTINCT org_id) AS accounts, count(DISTINCT ${person}) AS people, count(*) AS connections
         FROM mcp_events WHERE method = 'initialize' AND client IS NOT NULL AND ${inW("at")}${CL()} GROUP BY 1 ORDER BY 2 DESC, 4 DESC LIMIT 12`),
    db.query(
      `SELECT o.slug, o.name, (SELECT string_agg(p.name, ', ' ORDER BY p.name) FROM products p WHERE p.org_id = o.id) AS products, count(*) FILTER (WHERE ${inW("e.at")}) AS calls, count(*) FILTER (WHERE ${inP("e.at")}) AS prev_calls,
              count(*) FILTER (WHERE ${inW("e.at")} AND NOT e.ok) AS errors, count(DISTINCT ${person.replace(/user_id|org_id/g, (c) => `e.${c}`)}) FILTER (WHERE ${inW("e.at")}) AS people,
              max(e.at) AS last_seen, count(*) OVER () AS total
         FROM mcp_events e JOIN organizations o ON o.id = e.org_id
        WHERE e.${calls} AND e.at >= ${PF} AND e.at < ${T}${EV("e.")} GROUP BY o.id, o.slug, o.name
        ORDER BY count(*) FILTER (WHERE ${inW("e.at")}) DESC, o.name LIMIT ${filters.limit}`),
    // Weekly retention by account: the week of an account's first tool call, then the share active in each later week.
    db.query<{ cohort: string; size: number; week: number; active: number }>(
      `WITH firsts AS (SELECT org_id, date_trunc('week', min(at)) AS cohort FROM mcp_events WHERE ${calls}${EV()} GROUP BY org_id),
            act AS (SELECT DISTINCT org_id, date_trunc('week', at) AS wk FROM mcp_events WHERE ${calls}${EV()})
       SELECT to_char(f.cohort, 'YYYY-MM-DD') AS cohort, (SELECT count(*) FROM firsts f2 WHERE f2.cohort = f.cohort) AS size,
              (extract(epoch FROM a.wk - f.cohort) / 604800)::int AS week, count(DISTINCT a.org_id) AS active
         FROM firsts f JOIN act a ON a.org_id = f.org_id
        WHERE f.cohort >= date_trunc('week', now()) - interval '7 weeks'
        GROUP BY f.cohort, a.wk ORDER BY f.cohort, week`),
    db.query<Record<string, number>>(
      `SELECT (SELECT count(*) FROM simulations WHERE ${inW("created_at")}${ORG("", "sim")}) AS sims,
              (SELECT count(*) FROM simulations WHERE ${inW("created_at")} AND status = 'completed'${ORG("", "sim")}) AS sims_completed,
              (SELECT count(*) FROM simulations WHERE status IN ('queued', 'running')${ORG("", "sim")}) AS sims_open,
              (SELECT count(*) FROM agent_sessions WHERE ${inW("queued_at")}${ORG("", "session")}) AS sessions,
              (SELECT count(*) FROM agent_sessions WHERE ${inW("queued_at")} AND status = 'completed'${ORG("", "session")}) AS sessions_completed,
              (SELECT count(*) FROM agent_sessions WHERE ${inW("queued_at")} AND status IN ('failed', 'timeout')${ORG("", "session")}) AS sessions_failed,
              (SELECT count(*) FROM agent_sessions WHERE status = 'queued'${ORG("", "session")}) AS sessions_queued,
              (SELECT coalesce(sum(cost_usd), 0) FROM agent_sessions WHERE ${inW("queued_at")}${ORG("", "session")}) AS model_cost_usd,
              (SELECT count(*) FROM product_research WHERE ${inW("created_at")}${ORG("", "research")}) AS onboardings,
              (SELECT count(*) FROM product_research WHERE ${inW("created_at")} AND status = 'failed'${ORG("", "research")}) AS onboardings_failed,
              (SELECT coalesce(sum(g.errors), 0) FROM ${GW}) AS gateway_errors,
              (SELECT coalesce(sum(g.requests), 0) FROM ${GW}) AS gateway_requests`),
    db.query(
      `SELECT e.at, o.name AS account, o.slug, e.method, e.name, e.client, e.error, e.ms
         FROM mcp_events e JOIN organizations o ON o.id = e.org_id WHERE NOT e.ok AND ${inW("e.at")}${EV("e.")} ORDER BY e.at DESC LIMIT 15`),
    db.query<{ n: number }>(`SELECT count(*) AS n FROM organizations WHERE ${inW("created_at")}${O ? ` AND id = ANY(${O})` : ""}`),
    db.query<{ n: number }>(`SELECT count(*) AS n FROM mcp_events WHERE NOT ok AND ${inW("at")}${EV()}`),
    // accounts created per day, for the New accounts sparkline
    db.query<{ day: string; n: number }>(`SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*) AS n FROM organizations WHERE ${inW("created_at")}${O ? ` AND id = ANY(${O})` : ""} GROUP BY 1 ORDER BY 1`),
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
    days, range: { from: range.from, to: range.to, days },
    links: { posthog: process.env.POSTHOG_PROJECT_URL || null, new_relic: process.env.NEW_RELIC_DASHBOARD_URL || null,
             posthog_events: Boolean(process.env.POSTHOG_API_KEY), tracing: Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT) },
    totals: {
      active_accounts: Number(t.active_accounts ?? 0), active_people: Number(t.active_people ?? 0), calls: Number(t.calls ?? 0),
      error_pct: Number(t.calls) ? Math.round((Number(t.errors) / Number(t.calls)) * 1000) / 10 : 0,
      p50_ms: t.p50_ms == null ? null : Math.round(Number(t.p50_ms)), p95_ms: t.p95_ms == null ? null : Math.round(Number(t.p95_ms)),
      new_accounts: Number(newAccounts[0]?.n ?? 0),
      change: { active_accounts: change(t.active_accounts, p.active_accounts), active_people: change(t.active_people, p.active_people), calls: change(t.calls, p.calls) },
    },
    daily, new_daily: newDaily.map((r) => ({ day: r.day, n: Number(r.n) })), tools, clients,
    accounts: accounts.map(({ total: _t, ...a }: any) => ({ ...a, calls: Number(a.calls), prev_calls: Number(a.prev_calls),
      trend: change(a.calls, a.prev_calls), at_risk: Number(a.prev_calls) >= 5 && Number(a.calls) <= Number(a.prev_calls) / 2 })),
    retention: [...cohorts.values()].map((c) => ({ ...c, weeks: Array.from({ length: 8 }, (_, i) => c.weeks[i] ?? null) })),
    ops: Object.fromEntries(Object.entries(ops[0] ?? {}).map(([k, v]) => [k, Number(v)])),
    errors, errors_total: Number(errorsTotal[0]?.n ?? 0),
    accounts_total: Number((accounts[0] as any)?.total ?? 0),
    filters, facets: facetLists,
  };
}

const ERROR_KINDS = ["tool", "session", "onboarding"] as const;
/** Every failure in the period, newest first, one page at a time: tool calls, agent sessions, or onboarding research. */
export async function platformErrors(q: AnalyticsQuery) {
  const range = reportRange(q);
  const { F, T } = range.sql;
  const { sql: { EV, ORG } } = await parseFilters(q, range, memo(loadOrgs));
  const kind = ERROR_KINDS.find((k) => k === q.kind) ?? "tool";
  const offset = intIn(q.offset, 0, 1_000_000), limit = intIn(q.limit, 50, 1000) || 50;
  const inW = (c: string) => `${c} >= ${F} AND ${c} < ${T}`;
  const [select, from] = {
    tool: [`e.at, o.name AS account, o.slug, e.method, e.name, split_part(e.client, ' ', 1) AS client, e.error, e.ms`,
      `mcp_events e JOIN organizations o ON o.id = e.org_id WHERE NOT e.ok AND ${inW("e.at")}${EV("e.")}`],
    session: [`coalesce(s.ended_at, s.queued_at) AS at, o.name AS account, o.slug, p.name AS product, s.simulation_id, s.model, s.harness, s.status,
        s.error_message AS error, s.cost_usd`,
      `agent_sessions s JOIN organizations o ON o.id = s.org_id JOIN products p ON p.id = s.product_id
        WHERE s.status IN ('failed', 'timeout') AND ${inW("s.queued_at")}${ORG("s.", "session")}`],
    onboarding: [`coalesce(r.finished_at, r.created_at) AS at, o.name AS account, o.slug, p.name AS product, r.stage, r.error`,
      `product_research r JOIN organizations o ON o.id = r.org_id JOIN products p ON p.id = r.product_id
        WHERE r.status = 'failed' AND ${inW("r.created_at")}${ORG("r.", "research")}`],
  }[kind];
  const db = await getDb();
  const [rows, total] = await Promise.all([
    db.query(`SELECT ${select} FROM ${from} ORDER BY 1 DESC LIMIT ${limit} OFFSET ${offset}`),
    db.query<{ n: number }>(`SELECT count(*) AS n FROM ${from}`),
  ]);
  return { kind, rows: kind === "session" ? rows.map((r: any) => ({ ...r, cost_usd: Number(r.cost_usd) })) : rows,
    total: Number(total[0]?.n ?? 0), offset, limit, range: { from: range.from, to: range.to, days: range.days } };
}
