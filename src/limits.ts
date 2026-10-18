/**
 * Usage limits inside an account: how an account's admins split the plan's monthly model budget across teams and
 * people, who may launch simulations (rollout), and how much each person may run at once (throughput). Set on /app
 * (Billing, Budget rules) by the account's admins; enforced when a simulation starts and while an adaptive run samples
 * more. Spend is live: a session that is still running counts what the gateway has metered so far.
 *
 * The plan's budget comes from Stripe (src/billing.ts) and people from Clerk; this module only stores the policy
 * (Octillion is the one enforcing spend on its own gateway, so the policy has to live here). Limits apply to people
 * signed in with Clerk; connector keys draw from the account's pool.
 *
 * Allowance per person, per calendar month (UTC):
 *  - pool:   no per-person cap; everyone draws from the account (and their team's) budget;
 *  - even:   the budget, less a reserve, split evenly: a person in a team with a budget gets team budget / team size,
 *            everyone else (budget - reserve - team budgets) / the rest; plus or minus their own adjustment;
 *  - custom: each person's own cap, else the default cap, else no cap.
 * A team budget is also a hard cap on the team's combined spend in every mode.
 */
import type { Org } from "./auth.js";
import { orgBudget } from "./billing.js";
import { getDb } from "./db.js";
import { settingNumber } from "./settings.js";

/** Why a launch was refused, for /app to show beside the message; validation errors carry no code. */
export type LimitCode = "no_allowance" | "account_cap" | "budget_error" | "launch_access" | "person_limit" | "team_budget" | "runs_at_once" | "run_sessions";
export interface LimitInfo { code?: LimitCode; limit_usd?: number | null; left_usd?: number | null; set_by?: "you" | "team" | "account"; admins?: { name: string }[] }

export class LimitError extends Error {
  constructor(message: string, public status = 400, public info: LimitInfo = {}) { super(message); }
}

/** The calendar month's name and the date it resets (UTC), for refusal messages: "October", "November 1". */
export function monthWords(now = new Date()) {
  const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleDateString("en-US", { ...o, timeZone: "UTC" });
  return { month: fmt(now, { month: "long" }), reset: fmt(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)), { month: "long", day: "numeric" }) };
}

export type Mode = "pool" | "even" | "custom";

interface Policy { mode: Mode; reserve_usd: number; default_cap_usd: number | null; new_members_can_run: boolean;
  max_concurrent_runs: number | null; max_sessions_per_run: number | null; updated_at: Date | null; updated_by: string | null }
interface Team { id: number; name: string; budget_usd: number | null; max_concurrent_runs: number | null }
interface MemberRow { user_id: string; team_id: number | null; cap_usd: number | null; adjust_usd: number; can_run: boolean | null; max_concurrent_runs: number | null }

const DEFAULT_POLICY: Policy = { mode: "pool", reserve_usd: 0, default_cap_usd: null, new_members_can_run: true,
  max_concurrent_runs: null, max_sessions_per_run: null, updated_at: null, updated_by: null };
const num = (v: unknown) => (v == null ? null : Number(v));
const MONTH = `date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;

async function load(orgId: number) {
  const db = await getDb();
  const [p] = await db.query<Policy>("SELECT * FROM usage_policies WHERE org_id = $1", [orgId]);
  const teams = (await db.query<Team>("SELECT id, name, budget_usd, max_concurrent_runs FROM usage_teams WHERE org_id = $1 ORDER BY name", [orgId]))
    .map((t) => ({ ...t, id: Number(t.id), budget_usd: num(t.budget_usd), max_concurrent_runs: num(t.max_concurrent_runs) }));
  const rows = (await db.query<MemberRow>("SELECT user_id, team_id, cap_usd, adjust_usd, can_run, max_concurrent_runs FROM usage_members WHERE org_id = $1", [orgId]))
    .map((m) => ({ ...m, team_id: num(m.team_id), cap_usd: num(m.cap_usd), adjust_usd: Number(m.adjust_usd ?? 0), max_concurrent_runs: num(m.max_concurrent_runs) }));
  const policy: Policy = p ? { ...p, reserve_usd: Number(p.reserve_usd), default_cap_usd: num(p.default_cap_usd),
    max_concurrent_runs: num(p.max_concurrent_runs), max_sessions_per_run: num(p.max_sessions_per_run) } : DEFAULT_POLICY;
  return { policy, teams, rows: new Map(rows.map((m) => [m.user_id, m])) };
}

/**
 * This month's spend, tokens and open runs per person who launched simulations (simulations.created_by). Spend is live:
 * per session, its recorded cost or the gateway's running total while it runs (whichever is larger), the same figure as
 * the account's spend (orgMonthSpendUsd in src/queries.ts), so a person's limit counts the runs they have going now.
 * in_flight is the part of it from sessions still queued or running.
 */
async function usageByPerson(orgId: number) {
  const db = await getDb();
  const rows = await db.query<{ user_id: string; spent: number; in_flight: number; tokens_in: number; tokens_out: number; running: number }>(
    `WITH sims AS (SELECT id, created_by, status FROM simulations WHERE org_id = $1 AND created_by IS NOT NULL),
          live AS (SELECT s.created_by, a.status, a.tokens_in, a.tokens_out,
                          GREATEST(a.cost_usd, coalesce((SELECT sum(g.cost_usd) FROM gateway_usage g WHERE g.session_id = a.id), 0)) AS usd
                     FROM sims s JOIN agent_sessions a ON a.simulation_id = s.id WHERE a.queued_at >= ${MONTH}),
          used AS (SELECT created_by, sum(usd) AS spent, coalesce(sum(usd) FILTER (WHERE status IN ('queued', 'running')), 0) AS in_flight,
                          sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out
                     FROM live GROUP BY created_by),
          open AS (SELECT created_by, count(*) AS running FROM sims WHERE status IN ('queued', 'running') GROUP BY created_by)
     SELECT p.created_by AS user_id, coalesce(u.spent, 0) AS spent, coalesce(u.in_flight, 0) AS in_flight, coalesce(u.tokens_in, 0) AS tokens_in,
            coalesce(u.tokens_out, 0) AS tokens_out, coalesce(o.running, 0) AS running
       FROM (SELECT DISTINCT created_by FROM sims) p LEFT JOIN used u ON u.created_by = p.created_by LEFT JOIN open o ON o.created_by = p.created_by`,
    [orgId]);
  return new Map(rows.map((r) => [r.user_id, { spent: Number(r.spent), in_flight_usd: Number(r.in_flight), tokens_in: Number(r.tokens_in),
    tokens_out: Number(r.tokens_out), running: Number(r.running) }]));
}

/** The most agent sessions one run may have: the server's limit, or the account's own if it is lower. */
export async function sessionsLimit(orgId: number): Promise<number> {
  const server = settingNumber("OCTILLION_MAX_SESSIONS_PER_RUN");
  const [p] = await (await getDb()).query<{ n: number | null }>("SELECT max_sessions_per_run AS n FROM usage_policies WHERE org_id = $1", [orgId]);
  return p?.n == null ? server : Math.min(server, Number(p.n));
}

/** The full picture for /app Limits: policy, teams, every active member's allowance and usage. */
export async function overview(org: { orgId: number; slug: string }) {
  const { team } = await import("./admin.js");
  const [{ policy, teams, rows }, people, usage, { budget, subscription, budget_error }] = await Promise.all([
    load(org.orgId), team(org.slug), usageByPerson(org.orgId),
    // A failed lookup is not "no allowance": it is flagged, and launches refuse until it works again (fail closed).
    orgBudget(org.orgId).then((b) => ({ ...b, budget_error: false }), () => ({ budget: 0, subscription: null, budget_error: true })),
  ]);
  const members = people.members.filter((m) => m.status === "active");
  const teamOf = (uid: string) => rows.get(uid)?.team_id ?? null;
  const budgetedTeams = teams.filter((t) => t.budget_usd != null);
  const teamBudgets = budgetedTeams.reduce((s, t) => s + (t.budget_usd ?? 0), 0);
  const restPool = Math.max(0, budget - policy.reserve_usd - teamBudgets);
  const inBudgetedTeam = (uid: string) => budgetedTeams.some((t) => t.id === teamOf(uid));
  const restCount = members.filter((m) => !inBudgetedTeam(m.user_id)).length;

  const allowanceOf = (uid: string): number | null => {
    const r = rows.get(uid);
    if (policy.mode === "custom") return r?.cap_usd ?? policy.default_cap_usd ?? null;
    if (policy.mode === "even") {
      const t = budgetedTeams.find((x) => x.id === teamOf(uid));
      const size = t ? members.filter((m) => teamOf(m.user_id) === t.id).length : restCount;
      const share = t ? (t.budget_usd ?? 0) / Math.max(1, size) : budget > 0 ? restPool / Math.max(1, size) : null;
      return share == null ? null : Math.max(0, Math.round((share + (r?.adjust_usd ?? 0)) * 100) / 100);
    }
    return null;
  };
  const shaped = members.map((m) => {
    const r = rows.get(m.user_id), u = usage.get(m.user_id) ?? { spent: 0, in_flight_usd: 0, tokens_in: 0, tokens_out: 0, running: 0 };
    const allowance = allowanceOf(m.user_id);
    return { user_id: m.user_id, email: m.email, name: m.name, role: m.role, team_id: teamOf(m.user_id),
      can_run: r?.can_run ?? policy.new_members_can_run, own_can_run: r?.can_run ?? null, adjust_usd: r?.adjust_usd ?? 0, cap_usd: r?.cap_usd ?? null,
      max_concurrent_runs: r?.max_concurrent_runs ?? null, allowance_usd: allowance, ...u,
      remaining_usd: allowance == null ? null : Math.max(0, Math.round((allowance - u.spent) * 100) / 100) };
  });
  const teamsShaped = teams.map((t) => {
    const ms = shaped.filter((m) => m.team_id === t.id);
    return { ...t, members: ms.length, spent: ms.reduce((s, m) => s + m.spent, 0) };
  });
  const allocated = policy.mode === "pool" ? teamBudgets : shaped.reduce((s, m) => s + (m.allowance_usd ?? 0), 0);
  const admins = members.filter((m) => m.role === "admin").map((m) => ({ name: m.name || m.email || "an admin" }));
  return { policy, budget_usd: budget, budget_error, plan: subscription?.plan ?? null, clerk: people.clerk, teams: teamsShaped, members: shaped, admins,
    allocated_usd: Math.round(allocated * 100) / 100, unallocated_usd: budget > 0 ? Math.round((budget - allocated) * 100) / 100 : null,
    spent_usd: shaped.reduce((s, m) => s + m.spent, 0) };
}

/** The end of every refusal: who can change it, and (for money) when the month starts over. */
export function askAdmins(admins: { name: string }[], untilReset: boolean) {
  const names = admins.map((a) => a.name);
  const who = !names.length ? "your account admin" : names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
  return `Ask ${who} to change Budget rules on the Billing page${untilReset ? `, or wait until ${monthWords().reset}` : ""}.`;
}

/**
 * Before a simulation starts: may this person run, within their allowance, their team's budget and their concurrency
 * limit? Returns the most sessions this run may have (null = the server default) and the admins to name if a later
 * check refuses. Connector-key callers are not limited here. A refusal is a LimitError with a code (launch_access, person_limit, team_budget, runs_at_once), what the limit
 * is and what is left, who set it, and the admins to ask. When the account's allowance could not be looked up, nothing
 * starts (budget_error): a lookup failure must not read as "no limit".
 */
export async function checkRun(org: Org): Promise<{ maxSessions: number | null; admins: { name: string }[] }> {
  if (!org.userId) return { maxSessions: null, admins: [] };
  const o = await overview(org);
  if (o.budget_error)
    throw new LimitError("We couldn't check your account's allowance. Try again in a minute.", 503, { code: "budget_error", admins: o.admins });
  const me = o.members.find((m) => m.user_id === org.userId);
  if (!me) return { maxSessions: o.policy.max_sessions_per_run, admins: o.admins };
  const { month } = monthWords();
  const info = (code: LimitCode, set_by: LimitInfo["set_by"], limit_usd: number | null = null, spent = 0) =>
    ({ code, set_by, admins: o.admins, limit_usd, left_usd: limit_usd == null ? null : Math.max(0, Math.round((limit_usd - spent) * 100) / 100) });
  if (!me.can_run)
    throw new LimitError(`You haven't been allowed to launch simulations yet. Reports and transcripts stay available. ${askAdmins(o.admins, false)}`, 403,
      info("launch_access", me.own_can_run != null ? "you" : "account"));
  if (me.allowance_usd != null && me.spent >= me.allowance_usd)
    throw new LimitError(`You've used your $${me.allowance_usd.toFixed(2)} for ${month} ($${me.spent.toFixed(2)} spent). ${askAdmins(o.admins, true)}`, 403,
      info("person_limit", me.cap_usd != null ? "you" : "account", me.allowance_usd, me.spent));
  const t = o.teams.find((x) => x.id === me.team_id);
  if (t?.budget_usd != null && t.spent >= t.budget_usd)
    throw new LimitError(`The ${t.name} team has used its $${t.budget_usd.toFixed(2)} for ${month}. ${askAdmins(o.admins, true)}`, 403,
      info("team_budget", "team", t.budget_usd, t.spent));
  const maxRuns = me.max_concurrent_runs ?? t?.max_concurrent_runs ?? o.policy.max_concurrent_runs;
  const runsSetBy = me.max_concurrent_runs != null ? "you" : t?.max_concurrent_runs != null ? "team" : "account";
  if (maxRuns != null && me.running >= maxRuns)
    throw new LimitError(`You have ${me.running} simulation${me.running === 1 ? "" : "s"} running; you can have ${maxRuns} at once ` +
      `(set for ${runsSetBy === "you" ? "you" : runsSetBy === "team" ? "your team" : "the account"}). Wait for one to finish. ${askAdmins(o.admins, false)}`, 429,
      info("runs_at_once", runsSetBy));
  return { maxSessions: o.policy.max_sessions_per_run, admins: o.admins };
}

/**
 * While an adaptive run samples more: has its launcher (or their team) run out? Then the run stops early. Fails closed:
 * when the allowance or the limits can't be read, the run stops adding sessions (the ones running still finish).
 */
export async function launcherOverLimit(orgId: number, slug: string, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const o = await overview({ orgId, slug }).catch(() => null);
  if (!o || o.budget_error) return true;
  const me = o.members.find((m) => m.user_id === userId);
  if (!me) return false;
  const t = o.teams.find((x) => x.id === me.team_id);
  return (me.allowance_usd != null && me.spent >= me.allowance_usd) || (t?.budget_usd != null && t.spent >= t.budget_usd);
}

// ---------- changes from /app (account admins) ----------

const money = (v: unknown, field: string, allowNegative = false) => {
  if (v === null || v === "" || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || (!allowNegative && n < 0) || Math.abs(n) > 1e7) throw new LimitError(`${field} must be a number of dollars`);
  return Math.round(n * 100) / 100;
};
// Counts are 1 or more, or empty for no limit. 0 used to block every launch silently; "can launch" is the way to stop launches.
const count = (v: unknown, field: string, max = 10000) => {
  if (v === null || v === "" || v === undefined) return null;
  const n = Number(v);
  if (Number.isInteger(n) && n === 0) throw new LimitError(`${field} can't be 0. Leave it empty for no limit, or use "can launch" to stop launches.`);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new LimitError(`${field} must be a whole number from 1 to ${max}`);
  return n;
};
const RUNS = "Runs at once";
const sessions = (v: unknown) => count(v, "Agent sessions per run", settingNumber("OCTILLION_MAX_SESSIONS_PER_RUN"));

export async function setPolicy(orgId: number, actor: string, p: Partial<Record<keyof Policy, unknown>>) {
  const cur = (await load(orgId)).policy;
  const mode = p.mode === undefined ? cur.mode : String(p.mode);
  if (!["pool", "even", "custom"].includes(mode)) throw new LimitError("mode must be pool, even or custom");
  const next = {
    mode, reserve_usd: p.reserve_usd === undefined ? cur.reserve_usd : money(p.reserve_usd, "reserve_usd") ?? 0,
    default_cap_usd: p.default_cap_usd === undefined ? cur.default_cap_usd : money(p.default_cap_usd, "default_cap_usd"),
    new_members_can_run: p.new_members_can_run === undefined ? cur.new_members_can_run : Boolean(p.new_members_can_run),
    max_concurrent_runs: p.max_concurrent_runs === undefined ? cur.max_concurrent_runs : count(p.max_concurrent_runs, RUNS),
    max_sessions_per_run: p.max_sessions_per_run === undefined ? cur.max_sessions_per_run : sessions(p.max_sessions_per_run),
  };
  await (await getDb()).query(
    `INSERT INTO usage_policies (org_id, mode, reserve_usd, default_cap_usd, new_members_can_run, max_concurrent_runs, max_sessions_per_run, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)
     ON CONFLICT (org_id) DO UPDATE SET mode = $2, reserve_usd = $3, default_cap_usd = $4, new_members_can_run = $5,
       max_concurrent_runs = $6, max_sessions_per_run = $7, updated_at = now(), updated_by = $8`,
    [orgId, next.mode, next.reserve_usd, next.default_cap_usd, next.new_members_can_run, next.max_concurrent_runs, next.max_sessions_per_run, actor]);
}

/**
 * Add a team, or change one. A change is partial: only the fields sent change (a rename no longer clears the team's
 * budget or runs at once); send null to clear one.
 */
export async function saveTeam(orgId: number, t: { id?: unknown; name?: unknown; budget_usd?: unknown; max_concurrent_runs?: unknown }) {
  const has = (k: keyof typeof t) => t[k] !== undefined;
  const name = String(t.name ?? "").trim().slice(0, 60);
  if ((!t.id || has("name")) && !name) throw new LimitError("A team needs a name");
  const db = await getDb();
  try {
    if (t.id) {
      const sets: string[] = [], vals: unknown[] = [orgId, Number(t.id)];
      const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
      if (has("name")) set("name", name);
      if (has("budget_usd")) set("budget_usd", money(t.budget_usd, "Team budget"));
      if (has("max_concurrent_runs")) set("max_concurrent_runs", count(t.max_concurrent_runs, RUNS));
      const r = sets.length
        ? await db.query(`UPDATE usage_teams SET ${sets.join(", ")} WHERE org_id = $1 AND id = $2 RETURNING id`, vals)
        : await db.query("SELECT id FROM usage_teams WHERE org_id = $1 AND id = $2", vals);
      if (!r.length) throw new LimitError("No such team", 404);
      return { id: Number(t.id) };
    }
    const vals = [orgId, name, money(t.budget_usd, "Team budget"), count(t.max_concurrent_runs, RUNS)];
    const [r] = await db.query<{ id: number }>("INSERT INTO usage_teams (org_id, name, budget_usd, max_concurrent_runs) VALUES ($1, $2, $3, $4) RETURNING id", vals);
    return { id: Number(r.id) };
  } catch (e) {
    if (/unique|duplicate/i.test((e as Error).message)) throw new LimitError(`There is already a team called ${name}`, 409);
    throw e;
  }
}

export async function deleteTeam(orgId: number, id: number) {
  const r = await (await getDb()).query("DELETE FROM usage_teams WHERE org_id = $1 AND id = $2 RETURNING id", [orgId, id]);
  if (!r.length) throw new LimitError("No such team", 404);
}

/** One person's settings; only the fields sent change. The person must be an active member of the account. */
export async function setMember(org: { orgId: number; slug: string }, userId: string, m: Record<string, unknown>) {
  const { team } = await import("./admin.js");
  if (!(await team(org.slug)).members.some((x) => x.user_id === userId && x.status === "active")) throw new LimitError("Not an active member of this account", 404);
  const db = await getDb();
  if (m.team_id != null && m.team_id !== "" && !(await db.query("SELECT 1 FROM usage_teams WHERE org_id = $1 AND id = $2", [org.orgId, Number(m.team_id)])).length)
    throw new LimitError("No such team", 404);
  const cur = (await load(org.orgId)).rows.get(userId);
  const pick = <T>(k: string, parse: () => T, fallback: T) => (k in m ? parse() : fallback);
  const next = {
    team_id: pick("team_id", () => (m.team_id == null || m.team_id === "" ? null : Number(m.team_id)), cur?.team_id ?? null),
    cap_usd: pick("cap_usd", () => money(m.cap_usd, "cap_usd"), cur?.cap_usd ?? null),
    adjust_usd: pick("adjust_usd", () => money(m.adjust_usd, "adjust_usd", true) ?? 0, cur?.adjust_usd ?? 0),
    can_run: pick("can_run", () => (m.can_run == null ? null : Boolean(m.can_run)), cur?.can_run ?? null),
    max_concurrent_runs: pick("max_concurrent_runs", () => count(m.max_concurrent_runs, RUNS), cur?.max_concurrent_runs ?? null),
  };
  await db.query(
    `INSERT INTO usage_members (org_id, user_id, team_id, cap_usd, adjust_usd, can_run, max_concurrent_runs) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (org_id, user_id) DO UPDATE SET team_id = $3, cap_usd = $4, adjust_usd = $5, can_run = $6, max_concurrent_runs = $7`,
    [org.orgId, userId, next.team_id, next.cap_usd, next.adjust_usd, next.can_run, next.max_concurrent_runs]);
}
