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
 * Per calendar month (UTC), in every mode: the buffer (reserve_usd) and each team's budget are set aside; everyone
 * outside a budgeted team shares the rest; a person's own limit (cap_usd) applies. Inside each budget, people:
 *  - pool:   share it freely (no personal limit beyond their own);
 *  - even:   get an equal share of it, less own limits, split between those who can launch, plus their adjustment;
 *  - custom: can each spend up to the default cap.
 * allocate() below is the one place this is worked out; the page, checkRun and adaptive runs all use it.
 */
import type { Org } from "./auth.js";
import { orgBudget } from "./billing.js";
import { getDb } from "./db.js";
import { settingNumber } from "./settings.js";

/** Why a launch was refused, for /app to show beside the message; validation errors carry no code. */
export type LimitCode = "no_allowance" | "account_cap" | "budget_error" | "launch_access" | "person_limit" | "team_budget" | "rest_pot" | "buffer" |
  "runs_at_once" | "run_sessions";
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

export interface Usage { spent: number; in_flight_usd: number; tokens_in: number; tokens_out: number; running: number }
const NO_USAGE: Usage = { spent: 0, in_flight_usd: 0, tokens_in: 0, tokens_out: 0, running: 0 };
type Member = Omit<MemberRow, "user_id">;
const NO_ROW: Member = { team_id: null, cap_usd: null, adjust_usd: 0, can_run: null, max_concurrent_runs: null };

/** What allocate() works from: a policy (saved, or a draft), the teams, the account's active members and their own
 *  settings (no row: all defaults), live usage per person, the account's allowance and its live spend (connector keys included). */
export interface AllocInput {
  policy: Pick<Policy, "mode" | "reserve_usd" | "default_cap_usd" | "new_members_can_run" | "max_concurrent_runs">;
  teams: Team[];
  members: ({ user_id: string } & Partial<Member>)[];
  usage: Map<string, Usage>;
  cap: number;
  account_spent_usd: number;
}

const cents = (v: number) => Math.round(v * 100) / 100;
const leftOf = (limit: number, spent: number) => Math.max(0, cents(limit - spent));

/**
 * Who gets what, and who is blocked: one pure function, so the page, launches and adaptive runs can't disagree.
 *
 * Pots: the buffer (reserve_usd, which nobody can launch into), each team with a budget (a $0 budget is a real $0), and
 * everyone else, who share R = cap - buffer - team budgets (never below 0). These are set aside in every mode.
 * A person's limit: their own (cap_usd) in every mode; else per mode: pool, none (they draw on their pot); custom, the
 * default cap; even, what is left of their pot after own limits, split between the people in it who can launch and
 * have no own limit, plus their adjustment. With a $0 allowance every limit is $0.
 * A launch is checked in this order, and the first that fails is the reason (`blocked`): the account's allowance,
 * launch access, the person's limit, their pot (team budget or Everyone else), the buffer (the account's spend has
 * reached cap - buffer). `limited_by` is the first of those at 90% or more of its limit.
 */
export function allocate({ policy, teams, members, usage, cap, account_spent_usd }: AllocInput) {
  const zero = cap <= 0;
  const budgeted = new Map(teams.filter((t) => t.budget_usd != null).map((t) => [t.id, t]));
  const buffer_usd = cents(policy.reserve_usd);
  const team_budgets_usd = cents([...budgeted.values()].reduce((s, t) => s + (t.budget_usd ?? 0), 0));
  const rest_usd = Math.max(0, cents(cap - buffer_usd - team_budgets_usd));
  const launchable_usd = Math.max(0, cents(cap - buffer_usd));
  const people = members.map((m) => {
    const r: Member = { ...NO_ROW, ...Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)) };
    const team_id = r.team_id != null && teams.some((t) => t.id === r.team_id) ? r.team_id : null;
    return { user_id: m.user_id, ...r, team_id, pot: team_id != null && budgeted.has(team_id) ? team_id : null,
      own_can_run: r.can_run, can_run: r.can_run ?? policy.new_members_can_run, u: usage.get(m.user_id) ?? NO_USAGE };
  });
  const potBudget = (pot: number | null) => (pot == null ? rest_usd : budgeted.get(pot)!.budget_usd ?? 0);
  const potSpent = (pot: number | null) => people.filter((p) => p.pot === pot).reduce((s, p) => s + p.u.spent, 0);
  // Even split, per pot: the pot less its people's own limits, between those who can launch and have none.
  const shareOf = (pot: number | null) => {
    const inPot = people.filter((p) => p.pot === pot);
    const splitters = inPot.filter((p) => p.can_run && p.cap_usd == null).length;
    const own = inPot.reduce((s, p) => s + (p.cap_usd ?? 0), 0);
    return splitters ? Math.max(0, potBudget(pot) - own) / splitters : 0;
  };

  const account = {
    cap_usd: cap, spent_usd: cents(account_spent_usd), launchable_usd, left_usd: leftOf(launchable_usd, account_spent_usd),
    blocked: (zero ? "no_allowance" : account_spent_usd >= cap ? "account_cap" : account_spent_usd >= launchable_usd ? "buffer" : null) as LimitCode | null,
  };
  const out = people.map((p) => {
    const limit_source: "own" | "share" | "default" | "pool" = p.cap_usd != null ? "own" : policy.mode === "even" ? "share" : policy.mode === "custom" ? "default" : "pool";
    let limit: number | null =
      limit_source === "own" ? p.cap_usd
      : limit_source === "default" ? policy.default_cap_usd
      : limit_source === "share" ? (p.can_run ? Math.max(0, shareOf(p.pot) + p.adjust_usd) : 0)
      : null;
    if (zero) limit = 0;
    if (limit != null) limit = cents(limit);
    const pot = potBudget(p.pot), spent = p.u.spent;
    // Each check: [code, limit, spent against it]; can't launch and no allowance always fail.
    const checks: [LimitCode, number | null, number][] = [
      ["no_allowance", zero ? 0 : null, 0],
      ["account_cap", zero ? null : cap, account_spent_usd],
      ["launch_access", p.can_run ? null : 0, 0],
      ["person_limit", limit, spent],
      // Everyone else's pot only counts once a team has a budget; until then it is the buffer check below.
      [p.pot == null ? "rest_pot" : "team_budget", p.pot == null && !budgeted.size ? null : pot, potSpent(p.pot)],
      ["buffer", zero || buffer_usd <= 0 ? null : launchable_usd, account_spent_usd],
    ];
    const blocked = checks.find(([, l, s]) => l != null && s >= l)?.[0] ?? null;
    const limited_by = blocked ?? checks.find(([, l, s]) => l != null && l > 0 && s >= 0.9 * l)?.[0] ?? null;
    const left = Math.min(...checks.slice(1).filter(([c, l]) => l != null && c !== "launch_access").map(([, l, s]) => leftOf(l!, s)));
    const team = teams.find((t) => t.id === p.team_id);
    const effective_max_concurrent = p.max_concurrent_runs ?? team?.max_concurrent_runs ?? policy.max_concurrent_runs;
    const concurrent_source: "you" | "team" | "account" = p.max_concurrent_runs != null ? "you" : team?.max_concurrent_runs != null ? "team" : "account";
    return { user_id: p.user_id, team_id: p.team_id, pot: p.pot, can_run: p.can_run, own_can_run: p.own_can_run,
      cap_usd: p.cap_usd, adjust_usd: p.adjust_usd, max_concurrent_runs: p.max_concurrent_runs, effective_max_concurrent, concurrent_source,
      limit_usd: limit, limit_source, ...p.u, left_usd: blocked ? 0 : left, blocked, limited_by };
  });
  const teamsOut = teams.map((t) => {
    const ms = out.filter((x) => x.team_id === t.id), spent = ms.reduce((s, x) => s + x.spent, 0);
    return { ...t, members: ms.length, spent, left_usd: t.budget_usd == null ? null : leftOf(t.budget_usd, spent) };
  });
  const restSpent = potSpent(null);
  return {
    account, buffer_usd, team_budgets_usd, set_aside_usd: cents(buffer_usd + team_budgets_usd),
    over_by_usd: Math.max(0, cents(buffer_usd + team_budgets_usd - cap)),
    rest: { budget_usd: rest_usd, members: out.filter((x) => x.pot == null).length, spent: restSpent, left_usd: leftOf(rest_usd, restSpent) },
    teams: teamsOut, members: out,
  };
}
export type Allocation = ReturnType<typeof allocate>;

/** The account's live spend this month, connector keys included (the same figure as Billing's header). */
async function accountSpent(orgId: number) {
  const { orgMonthSpendUsd } = await import("./queries.js");
  return orgMonthSpendUsd(orgId);
}

/** The full picture for /app Billing, Budget rules: policy, teams, every active member's limit, usage and what blocks them. */
export async function overview(org: { orgId: number; slug: string }) {
  const { team } = await import("./admin.js");
  const [{ policy, teams, rows }, people, usage, account_spent, { budget, subscription, budget_error }] = await Promise.all([
    load(org.orgId), team(org.slug), usageByPerson(org.orgId), accountSpent(org.orgId),
    // A failed lookup is not "no allowance": it is flagged, and launches refuse until it works again (fail closed).
    orgBudget(org.orgId).then((b) => ({ ...b, budget_error: false }), () => ({ budget: 0, subscription: null, budget_error: true })),
  ]);
  const active = people.members.filter((m) => m.status === "active");
  const a = allocate({ policy, teams, usage, cap: budget, account_spent_usd: account_spent,
    members: active.map((m) => ({ user_id: m.user_id, ...rows.get(m.user_id) })) });
  const byId = new Map(a.members.map((x) => [x.user_id, x]));
  const members = active.map((m) => {
    const x = byId.get(m.user_id)!;
    // allowance_usd and remaining_usd are the old names, for the current tab.
    return { email: m.email, name: m.name, role: m.role, ...x,
      allowance_usd: x.limit_usd, remaining_usd: x.limit_usd == null ? null : leftOf(x.limit_usd, x.spent) };
  });
  const allocated = a.set_aside_usd + (policy.mode === "pool" ? 0 : members.filter((m) => m.pot == null).reduce((s, m) => s + (m.limit_usd ?? 0), 0));
  const admins = members.filter((m) => m.role === "admin").map((m) => ({ name: m.name || m.email || "an admin" }));
  return { policy, budget_usd: budget, budget_error, plan: subscription?.plan ?? null, clerk: people.clerk, admins,
    account: a.account, buffer_usd: a.buffer_usd, set_aside_usd: a.set_aside_usd, over_by_usd: a.over_by_usd, rest: a.rest,
    teams: a.teams, members, allocated_usd: cents(allocated), unallocated_usd: budget > 0 ? cents(budget - allocated) : null,
    spent_usd: members.reduce((s, m) => s + m.spent, 0) };
}

/** The end of every refusal: who can change it, and (for money) when the month starts over. */
export function askAdmins(admins: { name: string }[], untilReset: boolean) {
  const names = admins.map((a) => a.name);
  const who = !names.length ? "your account admin" : names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
  return `Ask ${who} to change Budget rules on the Billing page${untilReset ? `, or wait until ${monthWords().reset}` : ""}.`;
}

/** The refusal for a money or access check that allocate() says fails, worded for the person launching. */
function refusal(o: Awaited<ReturnType<typeof overview>>, code: LimitCode, me?: Awaited<ReturnType<typeof overview>>["members"][number]): LimitError {
  const { month, reset } = monthWords();
  const info = (set_by: LimitInfo["set_by"], limit_usd: number | null = null, spent = 0) =>
    ({ code, set_by, admins: o.admins, limit_usd, left_usd: limit_usd == null ? null : leftOf(limit_usd, spent) });
  const $ = (v: number) => `$${v.toFixed(2)}`;
  const acc = o.account, t = o.teams.find((x) => x.id === me?.pot);
  switch (code) {
    case "no_allowance":
      return new LimitError("Your account has no prepaid allowance this month, so simulations can't run. Contact Octillion.", 403, info("account", 0));
    case "account_cap":
      return new LimitError(`Your account has used its ${$(acc.cap_usd)} for ${month} (${$(acc.spent_usd)} spent). ` +
        `Results so far stay available; reply to your Octillion contact to raise the allowance, or wait until ${reset}.`, 403, info("account", acc.cap_usd, acc.spent_usd));
    case "launch_access":
      return new LimitError(`You haven't been allowed to launch simulations yet. Reports and transcripts stay available. ${askAdmins(o.admins, false)}`, 403,
        info(me?.own_can_run != null ? "you" : "account"));
    case "person_limit":
      return new LimitError(`You've used your ${$(me!.limit_usd!)} for ${month} (${$(me!.spent)} spent). ${askAdmins(o.admins, true)}`, 403,
        info(me!.cap_usd != null ? "you" : "account", me!.limit_usd, me!.spent));
    case "team_budget":
      return new LimitError(`The ${t!.name} team has used its ${$(t!.budget_usd!)} for ${month}. ${askAdmins(o.admins, true)}`, 403, info("team", t!.budget_usd, t!.spent));
    case "rest_pot":
      return new LimitError(`The shared ${$(o.rest.budget_usd)} for people outside a team budget is used up for ${month}. ${askAdmins(o.admins, true)}`, 403,
        info("account", o.rest.budget_usd, o.rest.spent));
    default: // buffer
      return new LimitError(`Your account has reached the part of its allowance available for launches (${$(acc.launchable_usd)} of ${$(acc.cap_usd)}). ` +
        `The rest is held back for runs that go over. ${askAdmins(o.admins, true)}`, 403, info("account", acc.launchable_usd, acc.spent_usd));
  }
}

/**
 * Before a simulation starts: may this person run, within their limit, their pot (team budget or Everyone else), the
 * buffer and their runs at once? Returns the most sessions this run may have (null = the server default) and the admins
 * to name if a later check refuses. Connector-key callers are not limited here. A refusal is a LimitError with a code,
 * what the limit is and what is left, who set it, and the admins to ask. When the account's allowance could not be
 * looked up, nothing starts (budget_error): a lookup failure must not read as "no limit". Someone not among the active
 * members (say Clerk is unavailable) still meets the account's checks, the buffer among them.
 */
export async function checkRun(org: Org): Promise<{ maxSessions: number | null; admins: { name: string }[] }> {
  if (!org.userId) return { maxSessions: null, admins: [] };
  const o = await overview(org);
  if (o.budget_error)
    throw new LimitError("We couldn't check your account's allowance. Try again in a minute.", 503, { code: "budget_error", admins: o.admins });
  const me = o.members.find((m) => m.user_id === org.userId);
  const blocked = me ? me.blocked : o.account.blocked;
  if (blocked) throw refusal(o, blocked, me);
  if (!me) return { maxSessions: o.policy.max_sessions_per_run, admins: o.admins };
  const maxRuns = me.effective_max_concurrent, runsSetBy = me.concurrent_source;
  if (maxRuns != null && me.running >= maxRuns)
    throw new LimitError(`You have ${me.running} simulation${me.running === 1 ? "" : "s"} running; you can have ${maxRuns} at once ` +
      `(set for ${runsSetBy === "you" ? "you" : runsSetBy === "team" ? "your team" : "the account"}). Wait for one to finish. ${askAdmins(o.admins, false)}`, 429,
      { code: "runs_at_once", set_by: runsSetBy, admins: o.admins, limit_usd: null, left_usd: null });
  return { maxSessions: o.policy.max_sessions_per_run, admins: o.admins };
}

/**
 * While an adaptive run samples more: has its launcher run out (their limit, their pot, the buffer or the account)?
 * Then the run stops early. Launch access is not rechecked: it governs starting runs, not finishing them. Fails closed:
 * when the allowance or the limits can't be read, the run stops adding sessions (the ones running still finish).
 */
export async function launcherOverLimit(orgId: number, slug: string, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const o = await overview({ orgId, slug }).catch(() => null);
  if (!o || o.budget_error) return true;
  const me = o.members.find((m) => m.user_id === userId);
  const blocked = me ? me.blocked : o.account.blocked;
  return blocked != null && blocked !== "launch_access";
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
  // Own limits apply in every mode, so custom with no default would just be the shared pool under another name.
  if (next.mode === "custom" && next.default_cap_usd == null)
    throw new LimitError("Custom caps need a default monthly cap for everyone. Enter an amount, or share the budget freely instead.");
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
