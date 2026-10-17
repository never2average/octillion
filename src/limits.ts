/**
 * Usage limits inside an account: how an account's admins split the plan's monthly model budget across teams and
 * people, who may launch simulations (rollout), and how much each person may run at once (throughput). Set on /app
 * (Limits) by the account's admins; enforced when a simulation starts and while an adaptive run samples more.
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

export class LimitError extends Error {
  constructor(message: string, public status = 400) { super(message); }
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

/** This month's spend, tokens and open runs per person who launched simulations (simulations.created_by). */
async function usageByPerson(orgId: number) {
  const db = await getDb();
  // agent_sessions.cost_usd is the larger of what the worker reported and what the gateway metered (src/worker.ts).
  const rows = await db.query<{ user_id: string; spent: number; tokens_in: number; tokens_out: number; running: number }>(
    `WITH sims AS (SELECT id, created_by, status FROM simulations WHERE org_id = $1 AND created_by IS NOT NULL),
          used AS (SELECT s.created_by, sum(a.cost_usd) AS spent, sum(a.tokens_in) AS tokens_in, sum(a.tokens_out) AS tokens_out
                     FROM sims s JOIN agent_sessions a ON a.simulation_id = s.id WHERE a.queued_at >= ${MONTH} GROUP BY s.created_by),
          open AS (SELECT created_by, count(*) AS running FROM sims WHERE status IN ('queued', 'running') GROUP BY created_by)
     SELECT p.created_by AS user_id, coalesce(u.spent, 0) AS spent, coalesce(u.tokens_in, 0) AS tokens_in,
            coalesce(u.tokens_out, 0) AS tokens_out, coalesce(o.running, 0) AS running
       FROM (SELECT DISTINCT created_by FROM sims) p LEFT JOIN used u ON u.created_by = p.created_by LEFT JOIN open o ON o.created_by = p.created_by`,
    [orgId]);
  return new Map(rows.map((r) => [r.user_id, { spent: Number(r.spent), tokens_in: Number(r.tokens_in), tokens_out: Number(r.tokens_out), running: Number(r.running) }]));
}

/** The full picture for /app Limits: policy, teams, every active member's allowance and usage. */
export async function overview(org: { orgId: number; slug: string }) {
  const { team } = await import("./admin.js");
  const [{ policy, teams, rows }, people, usage, { budget, subscription }] = await Promise.all([
    load(org.orgId), team(org.slug), usageByPerson(org.orgId), orgBudget(org.orgId).catch(() => ({ budget: 0, subscription: null })),
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
    const r = rows.get(m.user_id), u = usage.get(m.user_id) ?? { spent: 0, tokens_in: 0, tokens_out: 0, running: 0 };
    const allowance = allowanceOf(m.user_id);
    return { user_id: m.user_id, email: m.email, name: m.name, role: m.role, team_id: teamOf(m.user_id),
      can_run: r?.can_run ?? policy.new_members_can_run, adjust_usd: r?.adjust_usd ?? 0, cap_usd: r?.cap_usd ?? null,
      max_concurrent_runs: r?.max_concurrent_runs ?? null, allowance_usd: allowance, ...u,
      remaining_usd: allowance == null ? null : Math.max(0, Math.round((allowance - u.spent) * 100) / 100) };
  });
  const teamsShaped = teams.map((t) => {
    const ms = shaped.filter((m) => m.team_id === t.id);
    return { ...t, members: ms.length, spent: ms.reduce((s, m) => s + m.spent, 0) };
  });
  const allocated = policy.mode === "pool" ? teamBudgets : shaped.reduce((s, m) => s + (m.allowance_usd ?? 0), 0);
  return { policy, budget_usd: budget, plan: subscription?.plan ?? null, clerk: people.clerk, teams: teamsShaped, members: shaped,
    allocated_usd: Math.round(allocated * 100) / 100, unallocated_usd: budget > 0 ? Math.round((budget - allocated) * 100) / 100 : null,
    spent_usd: shaped.reduce((s, m) => s + m.spent, 0) };
}

/**
 * Before a simulation starts: may this person run, within their allowance, their team's budget and their concurrency
 * limit? Returns the most sessions this run may have (null = the server default). Connector-key callers are not limited here.
 */
export async function checkRun(org: Org): Promise<{ maxSessions: number | null }> {
  if (!org.userId) return { maxSessions: null };
  const o = await overview(org);
  const me = o.members.find((m) => m.user_id === org.userId);
  const where = "Your account admin can change this on the Limits tab of the Octillion account page (/app#limits).";
  if (!me) return { maxSessions: o.policy.max_sessions_per_run };
  if (!me.can_run) throw new LimitError(`Running simulations is not switched on for you in ${org.name}. Reports and transcripts stay available. ${where}`, 403);
  if (me.allowance_usd != null && me.spent >= me.allowance_usd)
    throw new LimitError(`You have used your $${me.allowance_usd.toFixed(2)} model allowance for this month ($${me.spent.toFixed(2)} spent). ${where}`, 403);
  const t = o.teams.find((x) => x.id === me.team_id);
  if (t?.budget_usd != null && t.spent >= t.budget_usd)
    throw new LimitError(`Team ${t.name} has used its $${t.budget_usd.toFixed(2)} budget for this month. ${where}`, 403);
  const maxRuns = me.max_concurrent_runs ?? t?.max_concurrent_runs ?? o.policy.max_concurrent_runs;
  if (maxRuns != null && me.running >= maxRuns)
    throw new LimitError(`You already have ${me.running} simulation${me.running === 1 ? "" : "s"} running (your limit is ${maxRuns}). Wait for one to finish or cancel it. ${where}`, 429);
  return { maxSessions: o.policy.max_sessions_per_run };
}

/** While an adaptive run samples more: has its launcher (or their team) run out? Then the run stops early. */
export async function launcherOverLimit(orgId: number, slug: string, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const o = await overview({ orgId, slug }).catch(() => null);
  const me = o?.members.find((m) => m.user_id === userId);
  if (!o || !me) return false;
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
const count = (v: unknown, field: string) => {
  if (v === null || v === "" || v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 10000) throw new LimitError(`${field} must be a whole number`);
  return n;
};

export async function setPolicy(orgId: number, actor: string, p: Partial<Record<keyof Policy, unknown>>) {
  const cur = (await load(orgId)).policy;
  const mode = p.mode === undefined ? cur.mode : String(p.mode);
  if (!["pool", "even", "custom"].includes(mode)) throw new LimitError("mode must be pool, even or custom");
  const next = {
    mode, reserve_usd: p.reserve_usd === undefined ? cur.reserve_usd : money(p.reserve_usd, "reserve_usd") ?? 0,
    default_cap_usd: p.default_cap_usd === undefined ? cur.default_cap_usd : money(p.default_cap_usd, "default_cap_usd"),
    new_members_can_run: p.new_members_can_run === undefined ? cur.new_members_can_run : Boolean(p.new_members_can_run),
    max_concurrent_runs: p.max_concurrent_runs === undefined ? cur.max_concurrent_runs : count(p.max_concurrent_runs, "max_concurrent_runs"),
    max_sessions_per_run: p.max_sessions_per_run === undefined ? cur.max_sessions_per_run : count(p.max_sessions_per_run, "max_sessions_per_run"),
  };
  await (await getDb()).query(
    `INSERT INTO usage_policies (org_id, mode, reserve_usd, default_cap_usd, new_members_can_run, max_concurrent_runs, max_sessions_per_run, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)
     ON CONFLICT (org_id) DO UPDATE SET mode = $2, reserve_usd = $3, default_cap_usd = $4, new_members_can_run = $5,
       max_concurrent_runs = $6, max_sessions_per_run = $7, updated_at = now(), updated_by = $8`,
    [orgId, next.mode, next.reserve_usd, next.default_cap_usd, next.new_members_can_run, next.max_concurrent_runs, next.max_sessions_per_run, actor]);
}

export async function saveTeam(orgId: number, t: { id?: unknown; name?: unknown; budget_usd?: unknown; max_concurrent_runs?: unknown }) {
  const name = String(t.name ?? "").trim().slice(0, 60);
  if (!name) throw new LimitError("A team needs a name");
  const db = await getDb();
  const vals = [orgId, name, money(t.budget_usd, "budget_usd"), count(t.max_concurrent_runs, "max_concurrent_runs")];
  try {
    if (t.id) {
      const r = await db.query("UPDATE usage_teams SET name = $2, budget_usd = $3, max_concurrent_runs = $4 WHERE org_id = $1 AND id = $5 RETURNING id", [...vals, Number(t.id)]);
      if (!r.length) throw new LimitError("No such team", 404);
      return { id: Number(t.id) };
    }
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
    max_concurrent_runs: pick("max_concurrent_runs", () => count(m.max_concurrent_runs, "max_concurrent_runs"), cur?.max_concurrent_runs ?? null),
  };
  await db.query(
    `INSERT INTO usage_members (org_id, user_id, team_id, cap_usd, adjust_usd, can_run, max_concurrent_runs) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (org_id, user_id) DO UPDATE SET team_id = $3, cap_usd = $4, adjust_usd = $5, can_run = $6, max_concurrent_runs = $7`,
    [org.orgId, userId, next.team_id, next.cap_usd, next.adjust_usd, next.can_run, next.max_concurrent_runs]);
}
