/**
 * The customer page (/app, web/app/app and web/components/portal): one place for an account's people to check their setup, learn the
 * workflow, see their team's usage, manage the team and the plan. Sign-in is Clerk (the same identity as the
 * connector's OAuth): the UI sends Clerk's session (the __session cookie on the same origin, or a Bearer session
 * token), and the account is the session's active Clerk organization.
 *
 * Nothing new is stored. Setup and usage come from the connector log Octillion already keeps (mcp_events, per user);
 * people from Clerk and the plan from Stripe, through src/admin.ts.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import * as admin from "./admin.js";
import { orgForClerk } from "./auth.js";
import { orgBudget } from "./billing.js";
import * as billing from "./billing.js";
import { getDb } from "./db.js";
import { getProduct, listProducts, orgMonthSpendUsd, saveProduct, saveScenarios } from "./queries.js";
import * as context from "./context.js";
import { capture, identifyPerson } from "./telemetry.js";
import * as journeys from "./journeys.js";
import * as limits from "./limits.js";
import * as clerk from "./clerk.js";
import { clerkSession } from "./session.js";

const publicUrl = () => (process.env.PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3333}`).replace(/\/$/, "");

/** Who is signed in, and for which account: a Clerk user acting in one Clerk organization. */
export interface Session { org: number; slug: string; user: string | null; email: string | null; role: "admin" | "member"; clerkOrgId: string | null }

const identified = new Set<string>();

class AppError extends Error { constructor(message: string, public status = 400) { super(message); } }

// ---------- what "set up" and "using it fully" mean ----------

/** Tool groups, in workflow order. A group nobody has used yet comes with the prompt that starts it. */
export const TOOL_GROUPS = [
  { id: "start", label: "Get started", tools: ["get_started"], prompt: "Get me started with Octillion." },
  { id: "onboard", label: "Onboard a product", tools: ["onboard_product", "get_onboarding", "save_product", "save_scenarios", "get_product", "list_products"],
    prompt: "Onboard my product: <name>, <website>, <docs link>. It is a <one-line description>." },
  { id: "run", label: "Run simulations", tools: ["run_simulation", "get_simulation", "list_simulations", "cancel_simulation"], prompt: "Run a simulation." },
  { id: "report", label: "Read the visibility report", tools: ["get_visibility_report"], prompt: "Show my visibility report." },
  { id: "evidence", label: "Check the evidence", tools: ["get_agent_session", "get_session_transcript", "search_transcripts"],
    prompt: "Why did agents pick <competitor> on <task>? Show me the transcript." },
  { id: "tune", label: "See who is tested", tools: ["list_agents", "list_developer_profiles", "browse_task_library"],
    prompt: "Which coding agents and developer personas do you test with?" },
] as const;

/** Plain-language fixes for errors people hit, matched on the tool's error text. */
const HINTS: [RegExp, string][] = [
  [/budget/i, "The account reached its monthly model budget. Results stay available; an admin can change the plan on the Billing tab."],
  [/no active Octillion plan/i, "The account has no active plan. An admin can choose one on the Billing tab."],
  [/no (product|products)/i, "Onboard a product first: \"Onboard my product: <name>, <website>, <docs link>.\""],
  [/research failed|403|fetch/i, "Octillion could not read your website or docs. Check that they are public, or paste a short description instead."],
];

async function setup(s: Session, since?: string) {
  const db = await getDb();
  // Per person (the Clerk user); per account for a session without a user.
  const who = s.user ? "org_id = $1 AND user_id = $2" : "org_id = $1 AND user_id IS NULL";
  const args = s.user ? [s.org, s.user] : [s.org];
  const [m] = await db.query<Record<string, any>>(
    `SELECT min(at) FILTER (WHERE method = 'initialize') AS connected,
            min(at) FILTER (WHERE method = 'tools/list') AS tools_listed,
            min(at) FILTER (WHERE method = 'resources/read' AND name LIKE 'ui://octillion/%') AS dashboard,
            min(at) FILTER (WHERE method = 'tools/call' AND ok) AS first_call,
            count(*) FILTER (WHERE method = 'tools/call') AS calls
       FROM mcp_events WHERE ${who}`, args);
  const clients = await db.query<{ client: string; last: Date }>(
    `SELECT client, max(at) AS last FROM mcp_events WHERE ${who} AND method = 'initialize' AND client IS NOT NULL GROUP BY client ORDER BY max(at) DESC LIMIT 5`, args);
  const used = new Set((await db.query<{ name: string }>(
    `SELECT DISTINCT name FROM mcp_events WHERE org_id = $1 AND method = 'tools/call' AND ok`, [s.org])).map((r) => r.name));
  const errors = await db.query<{ at: Date; name: string | null; error: string | null }>(
    `SELECT at, name, error FROM mcp_events WHERE ${who} AND NOT ok ORDER BY at DESC LIMIT 5`, args);
  const facts = await admin.accountFacts(s.slug);
  const textOnly = clients.length > 0 && clients.every((c) => !/claude-ai|claude\.ai|openai|chatgpt/i.test(c.client));
  const steps = [
    { id: "joined", label: "Join your team's account", done: true, at: null, help: "Done: you are signed in." },
    { id: "connected", label: "Add the Octillion connector to your AI client", done: Boolean(m.connected), at: m.connected,
      help: "Follow the guide for your client below, then press Test my connection." },
    { id: "tools", label: "Switch the Octillion tools on", done: Boolean(m.tools_listed), at: m.tools_listed,
      help: "Your client has not loaded the tools yet. In Cursor, switch the Octillion server on in the MCP settings; elsewhere, start a new chat." },
    { id: "dashboard", label: "See results as an interactive dashboard", done: Boolean(m.dashboard), at: m.dashboard, optional: true,
      help: textOnly ? "Your client shows text results. The dashboard appears in Claude and ChatGPT." : "Ask anything in Claude or ChatGPT; the dashboard renders under the answer." },
    { id: "first_call", label: "Ask Octillion something", done: Boolean(m.first_call), at: m.first_call, help: "Type: \"Get me started with Octillion.\"" },
    { id: "onboarded", label: "Onboard your product (team)", done: Boolean(facts.onboarded_at), at: facts.onboarded_at, help: TOOL_GROUPS[1].prompt },
    { id: "simulated", label: "Run a simulation (team)", done: Boolean(facts.first_sim_at), at: facts.first_sim_at, help: "Type: \"Run a simulation.\" It takes 20 to 60 minutes." },
    { id: "reported", label: "Read the visibility report (team)", done: Boolean(facts.first_report_at), at: facts.first_report_at, help: "Type: \"Show my visibility report.\"" },
  ];
  const groups = TOOL_GROUPS.map((g) => ({ id: g.id, label: g.label, prompt: g.prompt, used: g.tools.filter((t) => used.has(t)).length, total: g.tools.length }));
  let live = null;
  if (since) {
    const [r] = await db.query<{ at: Date; client: string | null }>(
      `SELECT at, client FROM mcp_events WHERE ${who} AND method IN ('initialize', 'tools/list', 'tools/call') AND at > $${args.length + 1} ORDER BY at DESC LIMIT 1`,
      [...args, new Date(since)]);
    live = r ?? null;
  }
  return {
    steps, done: steps.filter((x) => x.done && !("optional" in x && x.optional)).length, total: steps.filter((x) => !("optional" in x && x.optional)).length,
    clients, calls: Number(m.calls), groups, coverage: groups.filter((g) => g.used > 0).length / groups.length,
    next: groups.find((g) => g.used === 0) ?? null,
    errors: errors.map((e) => ({ ...e, hint: HINTS.find(([re]) => re.test(e.error ?? ""))?.[1] ?? null })),
    connect: admin.connectInfo(), live,
  };
}

/** Readable step titles for the journey recipes (src/journeys.ts RECIPES). */
const STEP_TITLES: Record<string, string> = {
  "connect/guide": "Connect your AI client",
  "first-report/onboard": "Onboard your product", "first-report/run": "Run a simulation", "first-report/report": "Read the visibility report",
  "evidence/why": "Check the evidence behind a result",
  "rerun/rerun": "Re-run after changing docs or SDK",
  "team/invite": "Invite a colleague",
  "win-back/nudge": "Run a fresh simulation",
};

/** What each journey gets you, in the customer's words (the recipes' `goal` is written for whoever builds the workflow). */
const JOURNEY_GOALS: Record<string, string> = {
  connect: "Octillion working in your AI client on day one",
  "first-report": "Your first visibility report within a week",
  evidence: "Understand why agents picked a competitor",
  rerun: "Prove a docs or SDK change moved agents' choices",
  team: "Get the people who own docs and DevRel on board",
  "win-back": "Check you are still being picked as models change",
};

/**
 * The journeys a person can follow on Setup: "Get set up" (the checklist) and the recommended journeys, each step
 * marked done from what the person and their account actually did. The same recipes drive PostHog Workflows'
 * nudges; here they are a guide the person can open any time.
 */
async function journeyGuide(s: Session) {
  const db = await getDb();
  const who = s.user ? "user_id = $2" : "user_id IS NULL";
  const args = s.user ? [s.org, s.user] : [s.org];
  const [me] = await db.query<{ connected: Date | null }>(`SELECT min(at) FILTER (WHERE method = 'initialize') AS connected FROM mcp_events WHERE org_id = $1 AND ${who}`, args);
  const tools = new Map((await db.query<{ name: string; first: Date; last: Date }>(
    `SELECT name, min(at) AS first, max(at) AS last FROM mcp_events WHERE org_id = $1 AND method = 'tools/call' AND ok GROUP BY name`, [s.org])).map((r) => [r.name, r]));
  const [sims] = await db.query<{ n: number; last: Date | null }>("SELECT count(*) AS n, max(created_at) AS last FROM simulations WHERE org_id = $1", [s.org]);
  const [recent] = await db.query<{ last: Date | null }>("SELECT max(at) AS last FROM mcp_events WHERE org_id = $1 AND method = 'tools/call'", [s.org]);
  const f = await admin.accountFacts(s.slug);
  const t = await admin.team(s.slug).catch(() => null);
  const firstOf = (...names: string[]) => names.map((n) => tools.get(n)?.first).filter(Boolean).sort()[0] ?? null;
  const reran = f.first_report_at && sims.last && new Date(sims.last) > new Date(f.first_report_at) ? sims.last : null;
  const active14 = recent.last && Date.now() - new Date(recent.last).getTime() < 14 * 86_400_000 ? recent.last : null;
  const doneAt: Record<string, Date | string | null> = {
    "connect/guide": me.connected,
    "first-report/onboard": f.onboarded_at, "first-report/run": f.first_sim_at, "first-report/report": f.first_report_at,
    "evidence/why": firstOf("get_agent_session", "get_session_transcript", "search_transcripts"),
    "rerun/rerun": reran,
    "team/invite": (t && (t.members.length > 1 || t.invitations.length > 0)) ? (t.invitations[0]?.created_at ?? t.members[1]?.created_at ?? null) : null,
    "win-back/nudge": active14,
  };
  return journeys.RECIPES.map((r) => {
    const steps = r.steps.map((x) => {
      const key = `${r.id}/${x.step}`;
      const at = doneAt[key] ?? null;
      return { id: x.step, title: STEP_TITLES[key] ?? x.step, message: x.message, prompt: "prompt" in x ? x.prompt : null,
               link: "link" in x ? x.link : null, done: Boolean(at), at };
    });
    return { id: r.id, name: r.name, goal: JOURNEY_GOALS[r.id] ?? r.goal, steps, done: steps.filter((x) => x.done).length, total: steps.length };
  });
}

async function usage(s: Session, daysIn: unknown) {
  const days = Math.min(90, Math.max(1, Number(daysIn) || 30));
  const db = await getDb();
  const [daily, tools, people, runs] = await Promise.all([
    db.query<{ day: string; calls: number; errors: number }>(
      `SELECT to_char(date_trunc('day', at), 'YYYY-MM-DD') AS day, count(*) AS calls, count(*) FILTER (WHERE NOT ok) AS errors
         FROM mcp_events WHERE org_id = $1 AND method = 'tools/call' AND at > now() - make_interval(days => $2) GROUP BY 1 ORDER BY 1`, [s.org, days]),
    db.query<{ name: string; calls: number; errors: number; avg_ms: number }>(
      `SELECT name, count(*) AS calls, count(*) FILTER (WHERE NOT ok) AS errors, round(avg(ms)) AS avg_ms
         FROM mcp_events WHERE org_id = $1 AND method = 'tools/call' AND at > now() - make_interval(days => $2) GROUP BY name ORDER BY count(*) DESC`, [s.org, days]),
    db.query<{ user_id: string | null; calls: number; last: Date; clients: string[] }>(
      `SELECT user_id, count(*) FILTER (WHERE method = 'tools/call') AS calls, max(at) AS last, array_remove(array_agg(DISTINCT client), NULL) AS clients
         FROM mcp_events WHERE org_id = $1 AND at > now() - make_interval(days => $2) GROUP BY user_id ORDER BY max(at) DESC`, [s.org, days]),
    db.query<{ simulations: number; sessions: number; completed: number }>(
      `SELECT (SELECT count(*) FROM simulations WHERE org_id = $1 AND created_at > now() - make_interval(days => $2)) AS simulations,
              count(*) AS sessions, count(*) FILTER (WHERE status = 'completed') AS completed
         FROM agent_sessions WHERE org_id = $1 AND queued_at > now() - make_interval(days => $2)`, [s.org, days]),
  ]);
  const t = await admin.team(s.slug);
  const emailOf = new Map(t.members.map((m) => [m.user_id, m.email]));
  const [{ budget }, spent] = await Promise.all([orgBudget(s.org).catch(() => ({ budget: 0 })), orgMonthSpendUsd(s.org)]);
  return {
    days, daily, tools, runs: runs[0],
    people: people.map((p) => ({ user_id: p.user_id, email: p.user_id ? emailOf.get(p.user_id) ?? "Former member" : "Connector key", calls: Number(p.calls), last: p.last, clients: p.clients })),
    spend: { month_usd: spent, budget_usd: budget },
  };
}

async function billingView(s: Session) {
  const f = await admin.accountFacts(s.slug);
  const { budget, subscription } = await orgBudget(s.org).catch(() => ({ budget: 0, subscription: null }));
  return {
    enabled: billing.stripeEnabled(), customer: Boolean(f.stripe_customer_id), subscription, budget_usd: budget,
    month_spend_usd: await orgMonthSpendUsd(s.org),
    plans: billing.stripeEnabled() ? (await billing.listPlans().catch(() => [])).map((p) => ({ price_id: p.price_id, name: p.name, amount: p.amount, currency: p.currency, interval: p.interval, monthly_budget_usd: p.monthly_budget_usd })) : [],
  };
}

// ---------- routes ----------

export function appRouter() {
  const r = express.Router();

  // The API behind the portal pages. Sign-in and sign-out happen in the UI, with Clerk.
  const api = express.Router();
  api.use(express.json({ limit: "16kb" }));
  api.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  api.use(async (req, res, next) => {
    if (!clerk.clerkEnabled()) return void res.status(503).json({ error: "Sign-in is not configured (CLERK_SECRET_KEY)" });
    const c = await clerkSession(req);
    if (!c) return void res.status(401).json({ error: "Sign in", sign_in_url: "/sign-in" });
    const ms = (await clerk.memberships.forUser(c.userId)).filter((m) => m.organization).sort((a, b) => a.created_at - b.created_at);
    // The session's active organization; without one, the person's oldest membership that is not suspended.
    const m = c.orgId ? ms.find((x) => x.organization!.id === c.orgId) : ms.find((x) => !clerk.isSuspended(x));
    if (!m) return void res.status(403).json({ error: "You are not in an Octillion account yet. Ask your admin to invite you.", code: "no_account" });
    if (clerk.isSuspended(m)) return void res.status(403).json({ error: "Your access to this account was suspended. Ask your account admin.", code: "suspended" });
    const org = await orgForClerk(m.organization!.id);
    if (!org) return void res.status(403).json({ error: "This account is not set up in Octillion yet.", code: "no_account" });
    const user = await clerk.users.get(c.userId);
    const s: Session = { org: org.orgId, slug: org.slug, user: c.userId, email: clerk.primaryEmail(user).email, role: clerk.roleOf(m.role), clerkOrgId: m.organization!.id };
    if (!identified.has(c.userId)) {
      identified.add(c.userId);
      identifyPerson(c.userId, { email: s.email ?? undefined, name: clerk.displayName(user) ?? undefined, account: org.slug, account_name: org.name, role: s.role });
      capture({ distinctId: c.userId, orgSlug: org.slug }, "app_signed_in", { method: "clerk" });
    }
    res.locals.session = s;
    res.locals.memberships = ms;
    next();
  });
  const S = (res: Response) => res.locals.session as Session;
  const adminOnly = (res: Response) => { if (S(res).role !== "admin") throw new AppError("Only an account admin can do this", 403); };
  const actor = (res: Response) => `customer:${S(res).email ?? S(res).slug}`;

  api.get("/me", async (_req, res) => {
    const s = S(res);
    const f = await admin.accountFacts(s.slug);
    const ms = res.locals.memberships as clerk.ClerkMembership[];
    res.json({ email: s.email, user_id: s.user, role: s.role, org_role: `org:${s.role}`, account: { name: f.name, slug: f.slug, clerk_org_id: s.clerkOrgId },
               via: "clerk", organizations: ms.map((m) => ({ clerk_org_id: m.organization!.id, name: m.organization!.name, role: clerk.roleOf(m.role), suspended: clerk.isSuspended(m) })),
               integrations: { clerk: true, stripe: billing.stripeEnabled() } });
  });
  api.get("/setup", async (req, res) => void res.json(await setup(S(res), typeof req.query.since === "string" ? req.query.since : undefined)));
  api.post("/setup/test", async (_req, res) => {
    capture({ distinctId: S(res).user ?? `org:${S(res).slug}`, orgSlug: S(res).slug }, "app_connection_test_started");
    res.json({ since: new Date().toISOString() });
  });
  api.get("/journeys", async (_req, res) => void res.json({ journeys: await journeyGuide(S(res)) }));
  api.get("/usage", async (req, res) => void res.json(await usage(S(res), req.query.days)));
  api.get("/team", async (_req, res) => void res.json({ ...(await admin.team(S(res).slug, true)), me: S(res).user, can_manage: S(res).role === "admin" }));
  api.post("/team/invitations", async (req, res) => {
    adminOnly(res);
    const role = req.body?.role === "admin" ? "admin" : "member";
    const r = await admin.invite(actor(res), S(res).slug, req.body?.email, role);
    res.status(201).json({ invitation: r.invitation, key: r.key, connector_url: r.connector_url });
  });
  api.post("/team/invitations/:id/resend", async (req, res) => { adminOnly(res); await admin.resendInvitation(actor(res), S(res).slug, String(req.params.id)); res.status(204).end(); });
  api.post("/team/invitations/:id/revoke", async (req, res) => { adminOnly(res); await admin.revokeInvitation(actor(res), S(res).slug, String(req.params.id)); res.status(204).end(); });
  for (const [verb, on] of [["deactivate", false], ["reactivate", true]] as const)
    api.post(`/team/members/:id/${verb}`, async (req, res) => {
      adminOnly(res);
      const t = await admin.team(S(res).slug, true);
      if (t.members.find((m) => m.id === req.params.id)?.user_id === S(res).user) throw new AppError("You cannot remove yourself");
      await admin.setMemberActive(actor(res), S(res).slug, String(req.params.id), on);
      res.status(204).end();
    });
  api.post("/team/members/:id/role", async (req, res) => {
    adminOnly(res);
    if (String(req.params.id) === S(res).user) throw new AppError("Ask another admin to change your own role");
    await admin.setMemberRole(actor(res), S(res).slug, String(req.params.id), req.body?.role);
    res.status(204).end();
  });
  // Usage limits (src/limits.ts): admins split the budget across teams and people, roll out running, cap throughput.
  // Everyone sees their own allowance; only admins see and change everyone's.
  api.get("/limits", async (_req, res) => {
    const s = S(res), o = await limits.overview({ orgId: s.org, slug: s.slug });
    if (s.role === "admin") return void res.json({ ...o, can_manage: true, me: s.user });
    res.json({ policy: { mode: o.policy.mode, max_concurrent_runs: o.policy.max_concurrent_runs, max_sessions_per_run: o.policy.max_sessions_per_run },
               budget_usd: o.budget_usd, clerk: o.clerk, can_manage: false, me: s.user,
               members: o.members.filter((m) => m.user_id === s.user), teams: o.teams.filter((t) => o.members.some((m) => m.user_id === s.user && m.team_id === t.id)) });
  });
  const limitsAdmin = (res: Response) => adminOnly(res);
  api.put("/limits/policy", async (req, res) => { limitsAdmin(res); await limits.setPolicy(S(res).org, actor(res), req.body ?? {}); res.status(204).end(); });
  api.post("/limits/teams", async (req, res) => { limitsAdmin(res); res.status(201).json(await limits.saveTeam(S(res).org, { ...req.body, id: undefined })); });
  api.put("/limits/teams/:id", async (req, res) => { limitsAdmin(res); res.json(await limits.saveTeam(S(res).org, { ...req.body, id: Number(req.params.id) })); });
  api.delete("/limits/teams/:id", async (req, res) => { limitsAdmin(res); await limits.deleteTeam(S(res).org, Number(req.params.id)); res.status(204).end(); });
  api.put("/limits/members/:userId", async (req, res) => {
    limitsAdmin(res);
    await limits.setMember({ orgId: S(res).org, slug: S(res).slug }, String(req.params.userId), req.body ?? {});
    res.status(204).end();
  });

  // Context (src/context.ts): the company's (admins edit), the person's own, and product profiles (admins edit).
  // Product reads and writes raise plain errors for user mistakes (an unknown product, a bad field): show them as 400s.
  const q = <T>(p: Promise<T>) => p.catch((e: Error) => { throw new AppError(e.message, /no product|not found|unknown/i.test(e.message) ? 404 : 400); });
  const orgOf = async (res: Response) => ({ orgId: S(res).org, slug: S(res).slug, name: (await admin.accountFacts(S(res).slug)).name, userId: S(res).user ?? undefined });
  api.get("/context", async (_req, res) => {
    const s = S(res), org = await orgOf(res);
    res.json({ company: await context.getCompany(s.org), person: s.user ? await context.getPerson(s.org, s.user) : null,
               products: ((await listProducts(org)) as any).products.map((p: any) => ({ slug: p.slug, name: p.name })), styles: context.ANSWER_STYLES,
               can_manage: s.role === "admin", preview: await context.contextForAI(org) });
  });
  api.put("/context/company", async (req, res) => { adminOnly(res); res.json(await context.saveCompany(S(res).org, actor(res), req.body ?? {})); });
  api.put("/context/me", async (req, res) => {
    res.json(await context.savePerson(S(res).org, S(res).user!, req.body ?? {}));
  });
  api.get("/context/products/:slug", async (req, res) => void res.json(await q(getProduct(await orgOf(res), String(req.params.slug)))));
  api.post("/context/products", async (req, res) => {
    adminOnly(res);
    const name = String(req.body?.name ?? "").trim();
    if (!name) throw new AppError("A product needs a name");
    res.status(201).json(await q(saveProduct(await orgOf(res), { name, description: req.body?.description || undefined, website_url: req.body?.website_url || undefined, docs_url: req.body?.docs_url || undefined })));
  });
  api.put("/context/products/:slug", async (req, res) => {
    adminOnly(res);
    const b = req.body ?? {}, org = await orgOf(res);
    await q(getProduct(org, String(req.params.slug))); // an unknown slug is a 404 here, not a new product
    res.json(await q(saveProduct(org, { product: String(req.params.slug), name: b.name, description: b.description, category: b.category,
      website_url: b.website_url, docs_url: b.docs_url, aliases: b.aliases, packages: b.packages, domains: b.domains, competitors: b.competitors })));
  });
  api.put("/context/products/:slug/scenarios/:id", async (req, res) => {
    adminOnly(res);
    await q(saveScenarios(await orgOf(res), String(req.params.slug), [{ id: Number(req.params.id), active: Boolean(req.body?.active) } as any]));
    res.status(204).end();
  });

  // Journey tips (src/journeys.ts): everything waiting for this person, dismiss one, or turn tips off.
  api.get("/nudges", async (_req, res) => void res.json(await journeys.nudgesForApp(S(res).org, S(res).user)));
  api.post("/nudges/:id/dismiss", async (req, res) => { await journeys.dismiss(S(res).org, S(res).slug, S(res).user, Number(req.params.id)); res.status(204).end(); });
  api.post("/nudges/mute", async (req, res) => { await journeys.setMuted(S(res).org, S(res).slug, S(res).user, req.body?.muted !== false); res.status(204).end(); });
  api.get("/billing", async (_req, res) => void res.json({ ...(await billingView(S(res))), can_manage: S(res).role === "admin" }));
  api.post("/billing/portal", async (_req, res) => { adminOnly(res); res.json(await admin.portalLink(actor(res), S(res).slug, `${publicUrl()}/app#billing`)); });
  api.post("/billing/checkout", async (req, res) => { adminOnly(res); res.json(await admin.checkoutLink(actor(res), S(res).slug, req.body?.price_id, `${publicUrl()}/app#billing`)); });
  api.use((err: Error & { status?: number }, _req: Request, res: Response, next: NextFunction) => {
    if (!(err instanceof AppError || err instanceof context.ContextError || err instanceof limits.LimitError || err instanceof journeys.JourneyError || err instanceof admin.AdminError || err instanceof clerk.ClerkError || err instanceof billing.StripeError)) return next(err);
    res.status(err.status ?? 400).json({ error: err.message });
  });
  r.use("/api/app", api);
  return r;
}
