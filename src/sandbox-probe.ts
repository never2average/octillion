import { randomBytes, randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import { credentialSecrets, useCredential } from "./keyvault.js";
import { BOAT, BOAT_PRICE_PER_HOUR } from "../orchestrator/core/config.js";
import * as lib from "../orchestrator/deploy/boat-lib.js";

/**
 * Sandbox reliability probe (docs/sandbox-probe.md, sql/migrations/0015_sandbox_probes.sql): boat.dev and Vercel Sandbox
 * side by side, measured from the deployment itself by its own cron (/api/cron/sandbox-probe, every 5 minutes; a VM
 * never runs it). One function call cannot wait 15 minutes, so each probe is a small state machine across ticks:
 *
 *   start    every OCTILLION_SANDBOX_PROBE_EVERY_MINUTES (30) per provider, at most MAX_LIVE (2) live at once: create the
 *            smallest sandbox (boat `small`, Vercel 1 vCPU / 2 GB) with a ~25-minute TTL, then wait for it to be ready.
 *            boat counts every create as a start against a daily limit shared with real orchestrators and workers:
 *            no boat probe starts while fewer than START_RESERVE of the day's starts are left (startBlocked)
 *   each tick  for every live probe, rounds GAP (30 s) apart within BUDGET (150 s) for all probes together: the provider's
 *            get API (does it still exist?) then `echo ok && uptime`. A probe the provider no longer has, or reports
 *            stopped, gets gone_at: that is the number this is for
 *   end      after OCTILLION_SANDBOX_PROBE_LIFETIME_MINUTES (15): delete it, recording how long that took and whether it worked
 *   hygiene  any probe sandbox in a provider's listing older than 30 minutes is deleted; rows stuck in 'starting' are failed
 *
 * Never in the autoscaler's way: its own route and its own key handling (the boat key is never written to the shared
 * BOAT config the autoscaler uses), no lease or lock shared with it, try/catch around every step, and a deadline.
 * Probe sandboxes are named `<namespace>-probe-…`, which matches none of the autoscaler's prefixes (orchestrators
 * `-orch-`, workers `-w-`, the image builder), so its orphan reaper never touches them.
 *
 * Vercel Sandbox is called over its REST API with fetch (no SDK in the API bundle): the function's OIDC token
 * (x-vercel-oidc-token header, else VERCEL_OIDC_TOKEN), whose owner_id / project_id claims name the team and project.
 * Without one, an access token in OCTILLION_VERCEL_SANDBOX_TOKEN with OCTILLION_VERCEL_TEAM_ID and
 * OCTILLION_VERCEL_PROJECT_ID. With neither, each start records a `not_configured` row and boat keeps being probed.
 */

export type ProbeProvider = "boat" | "vercel";
export const PROBE_PROVIDERS: readonly ProbeProvider[] = ["boat", "vercel"];
/** Never an orchestrator (`-orch-`), worker (`-w-`) or image (`-img-`) name: the autoscaler reaps only those. */
export const PROBE_PREFIX = `${lib.BOAT_NAMESPACE}-probe-`;
export const MAX_LIVE = 2;
/** A probe sandbox in a listing older than this is deleted whatever our rows say. */
export const STRAY_MINUTES = 30;
/** Probe sandboxes stop by themselves after this, even if every tick after the start failed. */
export const PROBE_TTL_SECONDS = 25 * 60;
/** A probe found gone this close to its TTL (or past it) expired: that is not an early drop. */
export const EXPIRY_MARGIN_MS = 2 * 60_000;
/** Each provider's listing is swept for strays at most this often (it is the heaviest call a tick makes). */
export const STRAY_SWEEP_MS = 15 * 60_000;
/** Failed deletes are retried on later ticks for this long after the start; then the stray sweep and the TTL take over. */
const RETRY_DELETE_MS = 2 * 3_600_000;
export const RETENTION_DAYS = 14;
/** boat: keep this share of the daily start limit (at least 20 starts) for real work; the probe waits below it. */
export const START_RESERVE = 0.15;
const COMMAND = "echo ok && uptime";
/** Ticks are 5 minutes apart and a step lands a few seconds into its tick: allow that much early. */
const SLACK_MS = 30_000;
/** Vercel Sandbox runs in iad1 by default, next to the functions (AWS us-east-1). */
export const VERCEL_REGION = "iad1";

const env = (k: string) => process.env[k]?.trim() || undefined;
const num = (k: string, d: number, min: number) => { const v = Number(env(k)); return Number.isFinite(v) && v >= min ? v : d; };
export const PROBE = {
  enabled: () => (env("OCTILLION_SANDBOX_PROBE") ?? "on").toLowerCase() !== "off",
  providers: (): ProbeProvider[] => {
    const want = (env("OCTILLION_SANDBOX_PROBE_PROVIDERS") ?? "boat,vercel").toLowerCase().split(/[\s,]+/);
    return PROBE_PROVIDERS.filter((p) => want.includes(p));
  },
  everyMs: () => num("OCTILLION_SANDBOX_PROBE_EVERY_MINUTES", 30, 5) * 60_000,
  lifetimeMs: () => num("OCTILLION_SANDBOX_PROBE_LIFETIME_MINUTES", 15, 1) * 60_000,
  budgetMs: () => num("OCTILLION_SANDBOX_PROBE_BUDGET_SECONDS", 150, 10) * 1000,
  gapMs: () => num("OCTILLION_SANDBOX_PROBE_GAP_SECONDS", 30, 1) * 1000,
};

const n = (v: unknown) => Number(v ?? 0) || 0;
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const clip = (s: string, max = 500) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
/** undici's "fetch failed" hides the reason (DNS, refused, TLS, timeout) in .cause. */
export function errText(e: unknown): string {
  const err = e as { message?: string; cause?: { code?: string; message?: string } };
  const cause = err?.cause ? ` (${[err.cause.code, err.cause.message].filter(Boolean).join(" ")})` : "";
  return clip(`${err?.message ?? String(e)}${cause}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

class ProbeHttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const isGoneStatus = (e: unknown) => e instanceof ProbeHttpError && (e.status === 404 || e.status === 410);

async function call(url: string, init: { method?: string; headers: Record<string, string>; json?: unknown; timeoutMs: number }, what: string): Promise<Response> {
  const headers = { ...init.headers, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) };
  const res = await fetch(url, { method: init.method ?? "GET", headers, body: init.json !== undefined ? JSON.stringify(init.json) : undefined, signal: AbortSignal.timeout(init.timeoutMs) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let msg = text.slice(0, 300);
    try { const d = JSON.parse(text); msg = String(d?.error?.message ?? d?.message ?? d?.error?.code ?? d?.code ?? msg); } catch { /* not JSON */ }
    throw new ProbeHttpError(res.status, `${what} -> ${res.status}${msg ? `: ${clip(msg, 300)}` : ""}`);
  }
  return res;
}
const jsonOf = async (res: Response) => { const t = await res.text(); return t ? JSON.parse(t) : null; };

// ---------------------------------------------------------------- providers

/**
 * A probe sandbox as a provider addresses it: `id` (boat: bx_…; Vercel: the name) and `cred`, the vault key that made
 * it (boat; null for Vercel). Every call about a sandbox uses the key that made it: with several boat keys (accounts),
 * another key would not see it and the probe would read "gone" when nothing was lost.
 */
export interface Ref { id: string; cred: number | null }
/** What the tick needs from a provider. */
export interface Driver {
  provider: ProbeProvider;
  region: string | null;
  create(name: string): Promise<Ref>;
  /** Resolves once the sandbox can run commands; throws if it fails or the deadline passes. */
  ready(ref: Ref, deadline: number): Promise<void>;
  /** gone: the provider no longer has it, or reports it stopped. Throws on a transient failure (that is not "gone"). */
  check(ref: Ref): Promise<{ gone: boolean; state: string; session?: string }>;
  exec(ref: Ref, session?: string): Promise<{ exitCode: number | null }>;
  remove(ref: Ref): Promise<void>;
  /** Probe sandboxes (our prefix) the provider lists, with their age (boat: under every key in the vault). */
  strays(): Promise<(Ref & { name: string; createdAt: number | null })[]>;
  /** Why a start must wait now (boat: the day's start budget is nearly used up), else null. */
  startBlocked?(): Promise<string | null>;
}

export interface DriverOptions { boatUrl?: string; vercelUrl?: string; oidcToken?: string | null }

/** boat.dev: its v1 REST API with the vault's boat key, kept to this module (never written to the shared BOAT config). */
export async function boatDriver(o: DriverOptions = {}): Promise<Driver | { not_configured: string }> {
  let current: { id: number; secret: string }, keys: { id: number; secret: string }[];
  try { current = await useCredential("boat"); keys = await credentialSecrets("boat"); }
  catch (e) { return { not_configured: `no boat key in the vault: ${errText(e)}` }; }
  if (!keys.some((k) => k.id === current.id)) keys.push(current);
  const base = (o.boatUrl ?? BOAT.apiUrl).replace(/\/+$/, "");
  // The key that made the sandbox; one deleted from the vault since falls back to the key in use now.
  const keyOf = (cred: number | null) => keys.find((k) => k.id === cred)?.secret ?? current.secret;
  const h = (cred: number | null, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${keyOf(cred)}`, ...extra });
  const path = (id: string) => `/sandboxes/${encodeURIComponent(id)}`;
  const get = async (r: Ref) => (await jsonOf(await call(base + path(r.id), { headers: h(r.cred), timeoutMs: 20_000 }, `boat GET ${path(r.id)}`)))?.sandbox ?? {};
  return {
    provider: "boat", region: null,
    async create(name) {
      const cred = current.id;
      // One attempt, no backoff: a failed create is what we measure. The idempotency key covers a lost answer.
      const c = await jsonOf(await call(`${base}/sandboxes`, { method: "POST", headers: h(cred, { "idempotency-key": randomUUID() }), timeoutMs: 60_000,
        json: { type: "small", ttlSeconds: PROBE_TTL_SECONDS, noEnv: true, snapshots: false } }, "boat POST /sandboxes"));
      const id = String(c?.sandbox?.id ?? "");
      if (!id) throw new Error("boat create answered without a sandbox id");
      // Named after the create, as orchestrators are; until then it has no name, which no reaper matches either.
      await call(base + path(id), { method: "PATCH", headers: h(cred), json: { name }, timeoutMs: 20_000 }, `boat PATCH ${path(id)}`).catch(() => {});
      return { id, cred };
    },
    async ready(ref, deadline) {
      for (;;) {
        const st = String((await get(ref)).state ?? "");
        if (["ready", "idle", "running"].includes(st)) return;
        if (["error", "cancelled", "archived", "deleted"].includes(st)) throw new Error(`sandbox is ${st}`);
        if (Date.now() + 2000 > deadline) throw new Error(`not ready before the tick's deadline (state ${st || "unknown"})`);
        await sleep(2000);
      }
    },
    async check(ref) {
      try {
        const sb = await get(ref);
        const state = String(sb.state ?? "unknown");
        return { gone: !lib.isLive({ id: ref.id, state }), state };
      } catch (e) {
        if (isGoneStatus(e)) return { gone: true, state: "not found" };
        throw e;
      }
    },
    async exec(ref) {
      const r = await jsonOf(await call(`${base}${path(ref.id)}/commands`, { method: "POST", headers: h(ref.cred), json: { command: COMMAND, timeoutSeconds: 30 }, timeoutMs: 45_000 }, `boat POST ${path(ref.id)}/commands`));
      return { exitCode: r?.exitCode ?? null };
    },
    async remove(ref) {
      await call(base + path(ref.id), { method: "DELETE", headers: h(ref.cred, { "x-ascii-confirm-delete": ref.id }), timeoutMs: 30_000 }, `boat DELETE ${path(ref.id)}`)
        .catch((e) => { if (!isGoneStatus(e)) throw e; });
    },
    async strays() {
      const out: (Ref & { name: string; createdAt: number | null })[] = [];
      for (const k of keys) {
        let cursor: string | null = null;
        for (let i = 0; i < 20; i++) {
          const r = await jsonOf(await call(`${base}/sandboxes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { headers: h(k.id), timeoutMs: 20_000 }, "boat GET /sandboxes"));
          for (const s of (r?.sandboxes ?? []) as lib.Sb[])
            if (s.name?.startsWith(PROBE_PREFIX) && lib.isLive(s)) out.push({ id: s.id, cred: k.id, name: s.name, createdAt: s.createdAt ? Date.parse(s.createdAt) : null });
          cursor = r?.pageInfo?.nextCursor ?? null;
          if (!cursor) break;
        }
      }
      return out;
    },
    async startBlocked() {
      // boat reports the daily limit, not the starts used: those are ours from the database (orchestrators, worker
      // sessions, probes) in the last 24 hours, as the Compute page's Limits counts them. Other deployments' are not seen.
      const l = await jsonOf(await call(`${base}/limits`, { headers: h(current.id), timeoutMs: 10_000 }, "boat GET /limits"));
      const perDay = Number(l?.startLimits?.perDay ?? 0);
      if (!perDay) return null;
      return startBudgetNote(perDay, await ourBoatStartsToday());
    },
  };
}

/** Pure: why the probe must not take one of boat's starts now (fewer than START_RESERVE of the day's left), else null. */
export function startBudgetNote(perDay: number, used: number): string | null {
  const reserve = Math.max(20, Math.ceil(perDay * START_RESERVE));
  return perDay - used < reserve ? `boat start budget nearly used: ${used} of ${perDay} starts in 24 h, keeping ${reserve} for orchestrators and workers` : null;
}

/** Our boat starts in the last 24 hours: orchestrator sandboxes, sessions given a worker sandbox, and probes. */
async function ourBoatStartsToday(): Promise<number> {
  const [r] = await (await getDb()).query<{ n: unknown }>(
    `/* tenant: internal: the sandbox probe counts boat starts across all orgs, ids only */
     SELECT (SELECT count(*) FROM orchestrator_sandboxes WHERE created_at > now() - interval '1 day')
          + (SELECT count(*) FROM agent_sessions WHERE sandbox_id IS NOT NULL AND started_at > now() - interval '1 day')
          + (SELECT count(*) FROM sandbox_probes WHERE provider = 'boat' AND sandbox_id IS NOT NULL AND started_at > now() - interval '1 day') AS n`);
  return n(r?.n);
}

/** The OIDC token's team and project (its owner_id and project_id claims). Not verified: Vercel's API verifies it. */
export function oidcClaims(token: string): { teamId: string; projectId: string } | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const p = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof p?.owner_id === "string" && typeof p?.project_id === "string" ? { teamId: p.owner_id, projectId: p.project_id } : null;
  } catch { return null; }
}

/** How Vercel Sandbox would be authenticated right now, without a secret in the answer. */
export function vercelAuth(oidcToken?: string | null): { token: string; teamId: string; projectId: string; via: "oidc" | "access_token" } | { not_configured: string } {
  const oidc = oidcToken || env("VERCEL_OIDC_TOKEN");
  if (oidc) {
    const c = oidcClaims(oidc);
    if (c) return { token: oidc, ...c, via: "oidc" };
  }
  const token = env("OCTILLION_VERCEL_SANDBOX_TOKEN"), teamId = env("OCTILLION_VERCEL_TEAM_ID"), projectId = env("OCTILLION_VERCEL_PROJECT_ID");
  if (token && teamId && projectId) return { token, teamId, projectId, via: "access_token" };
  return { not_configured: oidc
    ? "the Vercel OIDC token has no owner_id / project_id claims"
    : "no Vercel OIDC token (turn on OIDC Federation for the project) and no OCTILLION_VERCEL_SANDBOX_TOKEN + OCTILLION_VERCEL_TEAM_ID + OCTILLION_VERCEL_PROJECT_ID" };
}

/** Vercel Sandbox (Firecracker microVMs): its v2 REST API, named sandboxes, one session each. */
export function vercelDriver(o: DriverOptions = {}): Driver | { not_configured: string } {
  const auth = vercelAuth(o.oidcToken);
  if ("not_configured" in auth) return auth;
  const base = (o.vercelUrl ?? env("OCTILLION_VERCEL_SANDBOX_API_URL") ?? "https://vercel.com/api").replace(/\/+$/, "");
  const h = { authorization: `Bearer ${auth.token}` };
  const q = (extra: Record<string, string> = {}) => `?${new URLSearchParams({ teamId: auth.teamId, ...extra })}`;
  const one = (name: string) => `/v2/sandboxes/${encodeURIComponent(name)}`;
  const get = async (name: string) => jsonOf(await call(`${base}${one(name)}${q({ projectId: auth.projectId })}`, { headers: h, timeoutMs: 20_000 }, `vercel GET ${one(name)}`));
  return {
    provider: "vercel", region: VERCEL_REGION,
    async create(name) {
      // The smallest machine (1 vCPU, 2 GB), no snapshot on stop (persistent: false), stopped by Vercel after the TTL.
      const r = await jsonOf(await call(`${base}/v2/sandboxes${q()}`, { method: "POST", headers: h, timeoutMs: 60_000, json: {
        name, projectId: auth.projectId, runtime: "node24", resources: { vcpus: 1, memory: 2048 }, timeout: PROBE_TTL_SECONDS * 1000,
        persistent: false, region: VERCEL_REGION, tags: { octillion: "probe" } } }, "vercel POST /v2/sandboxes"));
      return { id: String(r?.sandbox?.name ?? name), cred: null };
    },
    async ready({ id }, deadline) {
      for (;;) {
        const r = await get(id);
        const st = String(r?.session?.status ?? r?.sandbox?.status ?? "");
        if (st === "running") return;
        if (["failed", "aborted", "stopped", "stopping"].includes(st)) throw new Error(`sandbox is ${st}`);
        if (Date.now() + 1000 > deadline) throw new Error(`not running before the tick's deadline (status ${st || "unknown"})`);
        await sleep(1000);
      }
    },
    async check({ id }) {
      try {
        const r = await get(id);
        const sb = String(r?.sandbox?.status ?? "unknown"), se = String(r?.session?.status ?? "");
        const gone = ["stopped", "stopping"].includes(sb) || ["failed", "aborted", "stopped", "stopping"].includes(se);
        return { gone, state: se && se !== sb ? `${sb} (session ${se})` : sb, session: r?.sandbox?.currentSessionId ?? r?.session?.id };
      } catch (e) {
        if (isGoneStatus(e)) return { gone: true, state: "not found" };
        throw e;
      }
    },
    async exec({ id }, session) {
      const sid = session ?? (await get(id))?.sandbox?.currentSessionId;
      if (!sid) throw new Error("no running session");
      const p = `/v2/sandboxes/sessions/${encodeURIComponent(sid)}/cmd`;
      // wait: true answers ND-JSON: the command when it starts, then again with its exit code when it finishes.
      const res = await call(`${base}${p}${q()}`, { method: "POST", headers: h, timeoutMs: 45_000,
        json: { command: "sh", args: ["-c", COMMAND], wait: true, timeout: 30_000 } }, `vercel POST ${p.replace(sid, ":session")}`);
      let exitCode: number | null = null;
      for (const line of (await res.text()).split("\n")) {
        if (!line.trim()) continue;
        let f: any;
        try { f = JSON.parse(line); } catch { continue; }
        if (f?.stream === "error") throw new Error(`vercel command stream: ${f?.data?.message ?? f?.data?.code ?? "error"}`);
        if (f?.command && f.command.exitCode != null) exitCode = Number(f.command.exitCode);
      }
      return { exitCode };
    },
    async remove({ id }) {
      await call(`${base}${one(id)}${q({ projectId: auth.projectId })}`, { method: "DELETE", headers: h, timeoutMs: 30_000 }, `vercel DELETE ${one(id)}`)
        .catch((e) => { if (!isGoneStatus(e)) throw e; });
    },
    async strays() {
      const out: (Ref & { name: string; createdAt: number | null })[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        // The list endpoint names the project `project`; get and delete take `projectId` (Vercel REST API v2 reference).
        const r = await jsonOf(await call(`${base}/v2/sandboxes${q({ project: auth.projectId, sortBy: "name", namePrefix: PROBE_PREFIX, limit: "50", ...(cursor ? { cursor } : {}) })}`,
          { headers: h, timeoutMs: 20_000 }, "vercel GET /v2/sandboxes"));
        for (const s of r?.sandboxes ?? [])
          if (typeof s?.name === "string" && s.name.startsWith(PROBE_PREFIX)) out.push({ id: s.name, cred: null, name: s.name, createdAt: Number(s.createdAt) || null });
        cursor = r?.pagination?.next ?? null;
        if (!cursor) break;
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------- the tick

interface ProbeRow {
  id: number; provider: ProbeProvider; sandbox_id: string | null; name: string | null; state: string; started_at: Date; region: string | null;
  gone_at: Date | null; deleted_at: Date | null; credential_id: number | null;
}
const refOf = (r: { sandbox_id: string | null; credential_id: number | null }): Ref => ({ id: r.sandbox_id!, cred: r.credential_id == null ? null : n(r.credential_id) });
export interface TickOptions extends DriverOptions {
  /** Wall-clock time the caller must be done by (the cron passes its start plus the function's 300 s). */
  deadline?: number;
  budgetMs?: number;
  gapMs?: number;
  /** How long a round may take (a check's 20 s plus an exec's 45 s, at worst): the next one starts only if it fits. */
  roundMs?: number;
}
export interface ProbeTick {
  enabled: boolean; at: string; providers: Record<string, { configured: boolean; reason?: string; started?: number | null; skipped?: string; ended: number; gone: number; strays: number;
    swept?: boolean; sweep_error?: string; error?: string }>;
  rounds: number; execs: number; pruned: { probes: number; execs: number } | { error: string } | null; error?: string;
}

const probeName = () => `${PROBE_PREFIX}${randomBytes(5).toString("hex")}`;

/** One cron tick. Never throws: every step is caught, and the answer says what went wrong. */
export async function probeTick(o: TickOptions = {}): Promise<ProbeTick> {
  const out: ProbeTick = { enabled: PROBE.enabled(), at: new Date().toISOString(), providers: {}, rounds: 0, execs: 0, pruned: null };
  if (!out.enabled) return out;
  const t0 = Date.now();
  // Leave 20 s of the function for the answer and for a delete that is under way.
  const deadline = Math.min(o.deadline ? o.deadline - 20_000 : Infinity, t0 + (o.budgetMs ?? PROBE.budgetMs()));
  try {
    const db = await getDb();
    out.pruned = await pruneProbes().catch((e) => ({ error: errText(e) }));
    const drivers: Driver[] = [];
    for (const p of PROBE.providers()) {
      const rep: ProbeTick["providers"][string] = out.providers[p] = { configured: false, ended: 0, gone: 0, strays: 0 };
      try {
        const d = p === "boat" ? await boatDriver(o) : vercelDriver(o);
        if ("not_configured" in d) {
          rep.reason = d.not_configured;
          // One row per start slot, so the page shows the provider as not configured and why.
          if (await startDue(p)) await db.query("INSERT INTO sandbox_probes (provider, state, create_error, last_error, region) VALUES ($1, 'not_configured', $2, $2, $3)",
            [p, clip(d.not_configured), p === "vercel" ? VERCEL_REGION : null]);
          continue;
        }
        rep.configured = true;
        drivers.push(d);
        // The stray sweep on its own: a failed listing (a 502) never skips this tick's ends, starts or execs.
        try { await hygiene(d, rep); } catch (e) { rep.sweep_error = errText(e); }
        await endDue(d, rep);
      } catch (e) { rep.error = errText(e); }
    }
    // Starts in parallel (a slow create on one provider does not delay the other), then the exec rounds.
    await Promise.all(drivers.map(async (d) => {
      const rep = out.providers[d.provider]!;
      try { rep.started = await startOne(d, deadline); }
      catch (e) { if ((e as { skipped?: boolean }).skipped) { rep.started = null; rep.skipped = errText(e); } else rep.error = errText(e); }
    }));
    const gap = o.gapMs ?? PROBE.gapMs(), roundMs = o.roundMs ?? 50_000;
    for (;;) {
      const live = await db.query<ProbeRow>("SELECT * FROM sandbox_probes WHERE state = 'live' AND provider = ANY($1) ORDER BY id", [drivers.map((d) => d.provider)]);
      if (!live.length || Date.now() + Math.min(5_000, roundMs) > deadline) break;
      out.rounds++;
      const results = await Promise.all(live.map((row) => probeOnce(drivers.find((d) => d.provider === row.provider)!, row, deadline)));
      out.execs += results.filter(Boolean).length;
      for (const row of live) if (results[live.indexOf(row)] === null) out.providers[row.provider]!.gone++;
      // The next round only if it can finish (an exec may take its 45 s timeout) before the deadline.
      if (Date.now() + gap + roundMs > deadline) break;
      await sleep(gap);
    }
  } catch (e) {
    out.error = errText(e);
    console.error(`sandbox probe tick: ${out.error}`);
  }
  return out;
}

/** No probe of this provider started in the last interval (a not_configured row counts, so it is written once per slot). */
async function startDue(p: ProbeProvider): Promise<boolean> {
  const [last] = await (await getDb()).query<{ started_at: Date }>("SELECT started_at FROM sandbox_probes WHERE provider = $1 ORDER BY started_at DESC LIMIT 1", [p]);
  return !last || Date.now() - new Date(last.started_at).getTime() >= PROBE.everyMs() - SLACK_MS;
}

/** Start one probe when due and under the cap. Returns the row id, or null when none was due. */
async function startOne(d: Driver, deadline: number): Promise<number | null> {
  const db = await getDb();
  if (!(await startDue(d.provider))) return null;
  const [{ live }] = await db.query<{ live: unknown }>("SELECT count(*) AS live FROM sandbox_probes WHERE provider = $1 AND state IN ('starting', 'live')", [d.provider]);
  if (n(live) >= MAX_LIVE) return null;
  // A budget that cannot be read does not stop the probe: boat still refuses a start over its limit, and we record that.
  const blocked = d.startBlocked ? await d.startBlocked().catch(() => null) : null;
  if (blocked) throw Object.assign(new Error(blocked), { skipped: true });
  const name = probeName();
  // The row first: a function frozen mid-create still leaves a trace (hygiene fails it later and deletes the sandbox).
  const [row] = await db.query<{ id: number }>("INSERT INTO sandbox_probes (provider, name, state, region) VALUES ($1, $2, 'starting', $3) RETURNING id", [d.provider, name, d.region]);
  const id = n(row!.id);
  const t0 = Date.now();
  let sandboxId: string | null = null, cred: number | null = null;
  try {
    const ref = await d.create(name);
    sandboxId = ref.id; cred = ref.cred;
    const createMs = Date.now() - t0;
    await db.query("UPDATE sandbox_probes SET sandbox_id = $2, credential_id = $3, create_ms = $4, updated_at = now() WHERE id = $1", [id, sandboxId, cred, createMs]);
    // Ready within the tick, but never more than 2 minutes of it.
    await d.ready(ref, Math.min(deadline, t0 + 120_000));
    await db.query("UPDATE sandbox_probes SET state = 'live', ready_ms = $2, updated_at = now() WHERE id = $1", [id, Date.now() - t0]);
  } catch (e) {
    const err = errText(e);
    await db.query("UPDATE sandbox_probes SET state = 'failed', create_error = $2, last_error = $2, create_ms = coalesce(create_ms, $3), updated_at = now() WHERE id = $1", [id, err, sandboxId ? null : Date.now() - t0]);
    if (sandboxId) await deleteProbe(d, id, { id: sandboxId, cred });
  }
  return id;
}

/**
 * Probes past their lifetime are deleted. Deletes that failed (delete_failed), and what is left of gone, expired and
 * failed probes, are retried for RETRY_DELETE_MS. Rows left in 'starting' by a frozen function are failed.
 */
async function endDue(d: Driver, rep: ProbeTick["providers"][string]) {
  const db = await getDb();
  const due = await db.query<ProbeRow>(
    `SELECT * FROM sandbox_probes WHERE provider = $1 AND deleted_at IS NULL AND sandbox_id IS NOT NULL
        AND ((state = 'live' AND started_at <= now() - make_interval(secs => $2))
          OR (state IN ('delete_failed', 'gone', 'expired', 'failed') AND started_at > now() - make_interval(secs => $3)))`,
    [d.provider, (PROBE.lifetimeMs() - SLACK_MS) / 1000, RETRY_DELETE_MS / 1000]);
  for (const row of due) { await deleteProbe(d, row.id, refOf(row)); rep.ended++; }
  const stuck = await db.query<ProbeRow>("SELECT * FROM sandbox_probes WHERE provider = $1 AND state = 'starting' AND started_at < now() - interval '10 minutes'", [d.provider]);
  for (const row of stuck) {
    await db.query("UPDATE sandbox_probes SET state = 'failed', create_error = coalesce(create_error, 'interrupted: the function stopped before the sandbox was ready'), updated_at = now() WHERE id = $1", [row.id]);
    if (row.sandbox_id) await deleteProbe(d, row.id, refOf(row));
  }
}

/**
 * Delete, and record the attempt (a 'delete' row: how long, whether it worked). On success a live or delete_failed
 * probe becomes 'deleted' (it lived its time); gone, expired and failed ones keep their state. A failed delete never
 * counts as deleted: a live probe becomes 'delete_failed', and endDue tries again on later ticks.
 */
async function deleteProbe(d: Driver, id: number, ref: Ref) {
  const db = await getDb();
  const t0 = Date.now();
  let error: string | null = null;
  try { await d.remove(ref); } catch (e) { error = errText(e); }
  const ms = Date.now() - t0;
  await db.query("INSERT INTO sandbox_probe_execs (probe_id, kind, ok, ms, error) VALUES ($1, 'delete', $2, $3, $4)", [id, error == null, ms, error]);
  await db.query(
    `UPDATE sandbox_probes SET deleted_at = CASE WHEN $3::text IS NULL THEN now() ELSE NULL END, delete_ms = $2, delete_error = $3,
            state = CASE WHEN $3::text IS NULL AND state IN ('live', 'delete_failed') THEN 'deleted'
                         WHEN $3::text IS NOT NULL AND state = 'live' THEN 'delete_failed' ELSE state END,
            last_error = coalesce($3, last_error), updated_at = now() WHERE id = $1`,
    [id, ms, error]);
}

/** Claim this provider's stray sweep: true at most once per STRAY_SWEEP_MS across every function instance. */
async function claimSweep(p: ProbeProvider): Promise<boolean> {
  const rows = await (await getDb()).query<{ key: string }>(
    `INSERT INTO sandbox_probe_meta (key, at) VALUES ($1, now())
     ON CONFLICT (key) DO UPDATE SET at = excluded.at WHERE sandbox_probe_meta.at <= now() - make_interval(secs => $2)
     RETURNING key`, [`strays:${p}`, (STRAY_SWEEP_MS - SLACK_MS) / 1000]);
  return rows.length > 0;
}

/** The safety net, at most every 15 minutes: any probe sandbox the provider lists older than STRAY_MINUTES is deleted. */
async function hygiene(d: Driver, rep: ProbeTick["providers"][string]) {
  if (!(await claimSweep(d.provider))) return;
  rep.swept = true;
  const db = await getDb();
  const cutoff = Date.now() - STRAY_MINUTES * 60_000;
  for (const s of await d.strays()) {
    if (s.createdAt == null || s.createdAt > cutoff) continue;
    const [row] = await db.query<{ id: number }>("SELECT id FROM sandbox_probes WHERE provider = $1 AND sandbox_id = $2 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1", [d.provider, s.id]);
    if (row) await deleteProbe(d, row.id, s);
    else await d.remove(s).catch(() => {});
    rep.strays++;
  }
}

/** One round for one probe: does it exist, then echo + uptime. Returns null when it turned out gone, else the exec's ok. */
async function probeOnce(d: Driver, row: ProbeRow, deadline: number): Promise<boolean | null> {
  const db = await getDb();
  const record = (kind: "exec" | "check", ok: boolean, ms: number, exitCode: number | null, error: string | null) =>
    db.query("INSERT INTO sandbox_probe_execs (probe_id, kind, ok, ms, exit_code, error) VALUES ($1, $2, $3, $4, $5, $6)", [row.id, kind, ok, ms, exitCode, error]);
  let session: string | undefined;
  let t = Date.now();
  const ref = refOf(row);
  try {
    const c = await d.check(ref);
    await record("check", true, Date.now() - t, null, null);
    if (c.gone) {
      // Near or past its TTL the provider stopping it is expiry (a missed end), not an early drop: no gone_at.
      if (Date.now() - new Date(row.started_at).getTime() >= PROBE_TTL_SECONDS * 1000 - EXPIRY_MARGIN_MS) {
        await db.query("UPDATE sandbox_probes SET state = 'expired', last_error = $2, updated_at = now() WHERE id = $1 AND state = 'live'",
          [row.id, `${d.provider} reports it ${c.state} at its TTL (expired, not lost)`]);
        return null;
      }
      await db.query("UPDATE sandbox_probes SET state = 'gone', gone_at = now(), gone_reason = $2, last_error = $2, updated_at = now() WHERE id = $1 AND state = 'live'",
        [row.id, `${d.provider} reports it ${c.state}`]);
      // Clean up what is left of it (a stopped Vercel sandbox, an archived boat one) now, while there is time.
      if (Date.now() + 30_000 < deadline) await deleteProbe(d, row.id, ref);
      return null;
    }
    session = c.session;
  } catch (e) {
    // The get API failing is not "gone": recorded, and the exec still runs.
    await record("check", false, Date.now() - t, null, errText(e));
  }
  t = Date.now();
  let ok = false;
  try {
    const r = await d.exec(ref, session);
    ok = r.exitCode === 0;
    await record("exec", ok, Date.now() - t, r.exitCode, ok ? null : `exit code ${r.exitCode ?? "unknown"}`);
  } catch (e) {
    await record("exec", false, Date.now() - t, null, errText(e));
  }
  await refreshStats(row.id);
  return ok;
}

const pctile = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]! : null);

/** The probe row's exec counters and latency percentiles, from its exec rows. */
async function refreshStats(id: number) {
  const db = await getDb();
  const rows = await db.query<{ ok: boolean; ms: number | null; error: string | null }>("SELECT ok, ms, error FROM sandbox_probe_execs WHERE probe_id = $1 AND kind = 'exec' ORDER BY at", [id]);
  const okMs = rows.filter((r) => r.ok && r.ms != null).map((r) => n(r.ms)).sort((a, b) => a - b);
  const lastErr = [...rows].reverse().find((r) => r.error)?.error ?? null;
  await db.query(
    `UPDATE sandbox_probes SET execs_ok = $2, execs_failed = $3, exec_p50_ms = $4, exec_p95_ms = $5, last_error = coalesce($6, last_error), updated_at = now() WHERE id = $1`,
    [id, rows.filter((r) => r.ok).length, rows.filter((r) => !r.ok).length, pctile(okMs, 0.5), pctile(okMs, 0.95), lastErr]);
}

/** 14 days, 5,000 rows a table per call. */
export async function pruneProbes(): Promise<{ probes: number; execs: number }> {
  const db = await getDb();
  const del = async (sql: string) => n((await db.query<{ n: unknown }>(sql, [RETENTION_DAYS]))[0]?.n);
  const execs = await del(`WITH d AS (DELETE FROM sandbox_probe_execs WHERE id IN (SELECT id FROM sandbox_probe_execs WHERE at < now() - make_interval(days => $1) LIMIT 5000) RETURNING 1) SELECT count(*) AS n FROM d`);
  const probes = await del(`WITH d AS (DELETE FROM sandbox_probes WHERE id IN (SELECT id FROM sandbox_probes WHERE started_at < now() - make_interval(days => $1) AND state NOT IN ('starting', 'live') LIMIT 5000) RETURNING 1) SELECT count(*) AS n FROM d`);
  return { probes, execs };
}

// ---------------------------------------------------------------- reading it: the Compute › Sandbox probes tab and the admin MCP

/**
 * What the probe costs a day at the smallest size, per provider: probes a day x minutes each.
 * boat: `small` at BOAT_PRICE_PER_HOUR. Vercel Sandbox (Pro, iad1): 2 GB provisioned memory at $0.0212/GB-hour, active
 * CPU at $0.128/hour assuming ~2% of one vCPU (the probe idles), $0.60 per million creations.
 */
export function probeCost(everyMs = PROBE.everyMs(), lifetimeMs = PROBE.lifetimeMs()) {
  const perDay = Math.round(86_400_000 / everyMs), hours = lifetimeMs / 3_600_000;
  const boat = (BOAT_PRICE_PER_HOUR.small ?? 0.018) * hours;
  const vercel = 2 * 0.0212 * hours + 0.02 * 0.128 * hours + 0.6 / 1e6;
  const r = (x: number) => Math.round(x * 100) / 100;
  return { probes_per_day: perDay, minutes_each: Math.round(lifetimeMs / 60_000), boat_usd_day: r(boat * perDay), vercel_usd_day: r(vercel * perDay),
    total_usd_day: r((boat + vercel) * perDay), boat_starts_per_day: perDay,
    note: `${perDay} probe sandboxes a provider a day at ~${Math.round(lifetimeMs / 60_000)} minutes each. boat small $${BOAT_PRICE_PER_HOUR.small}/h; Vercel Sandbox 1 vCPU / 2 GB (2 GB x $0.0212/GB-h, CPU mostly idle). Each boat probe is also one of the account's starts.` };
}

export interface ProviderSummary {
  provider: ProbeProvider; configured: boolean; not_configured_reason: string | null; started: number; created: number; create_ok_pct: number | null;
  ready_p50_ms: number | null; ready_p95_ms: number | null; finished: number; survived: number; survived_pct: number | null;
  gone_early: number; gone_median_age_s: number | null; execs: number; exec_ok_pct: number | null; exec_p50_ms: number | null; exec_p95_ms: number | null;
  checks: number; check_ok_pct: number | null; deletes: number; delete_ok_pct: number | null; delete_failed: number; live: number; last_started_at: string | null; last_error: string | null;
}
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
const int = (v: unknown) => (v == null ? null : Math.round(Number(v)));

/** Per provider over the last `hours`: the headline reliability numbers. */
export async function probeSummary(q: Record<string, unknown> = {}): Promise<{ hours: number; enabled: boolean; lifetime_minutes: number; every_minutes: number; providers: ProviderSummary[]; cost: ReturnType<typeof probeCost> }> {
  const hours = Number(q.hours) === 168 ? 168 : 24;
  const db = await getDb();
  const p = await db.query<any>(
    `SELECT provider,
            count(*) FILTER (WHERE state <> 'not_configured') AS started,
            count(*) FILTER (WHERE state NOT IN ('not_configured', 'failed', 'starting')) AS created,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY ready_ms) AS ready_p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY ready_ms) AS ready_p95,
            count(*) FILTER (WHERE state IN ('gone', 'deleted', 'delete_failed', 'expired')) AS finished,
            count(*) FILTER (WHERE state IN ('deleted', 'expired') AND gone_at IS NULL) AS survived,
            count(*) FILTER (WHERE gone_at IS NOT NULL) AS gone_early,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM gone_at - started_at)) AS gone_age,
            count(*) FILTER (WHERE state = 'delete_failed') AS delete_failed,
            count(*) FILTER (WHERE state IN ('starting', 'live')) AS live, count(*) FILTER (WHERE state = 'starting') AS starting, max(started_at) FILTER (WHERE state <> 'not_configured') AS last_started
       FROM sandbox_probes WHERE started_at > now() - make_interval(hours => $1) GROUP BY provider`, [hours]);
  const x = await db.query<any>(
    `SELECT s.provider, e.kind, count(*) AS n, count(*) FILTER (WHERE e.ok) AS ok,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY e.ms) FILTER (WHERE e.ok) AS p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY e.ms) FILTER (WHERE e.ok) AS p95
       FROM sandbox_probe_execs e JOIN sandbox_probes s ON s.id = e.probe_id
      WHERE e.at > now() - make_interval(hours => $1) GROUP BY s.provider, e.kind`, [hours]);
  // The newest row of each provider says whether it is configured now.
  const latest = await db.query<{ provider: string; state: string; last_error: string | null }>(
    "SELECT DISTINCT ON (provider) provider, state, last_error FROM sandbox_probes ORDER BY provider, started_at DESC, id DESC");
  const providers = PROBE_PROVIDERS.map((prov): ProviderSummary => {
    const r = p.find((y) => y.provider === prov) ?? {};
    const ex = x.find((y) => y.provider === prov && y.kind === "exec") ?? {}, ch = x.find((y) => y.provider === prov && y.kind === "check") ?? {};
    const de = x.find((y) => y.provider === prov && y.kind === "delete") ?? {};
    const last = latest.find((y) => y.provider === prov);
    const lastErr = last?.last_error ?? null;
    return {
      provider: prov, configured: last?.state !== "not_configured", not_configured_reason: last?.state === "not_configured" ? lastErr : null,
      started: n(r.started), created: n(r.created), create_ok_pct: pct(n(r.created), n(r.started) - n(r.starting)),
      ready_p50_ms: int(r.ready_p50), ready_p95_ms: int(r.ready_p95),
      finished: n(r.finished), survived: n(r.survived), survived_pct: pct(n(r.survived), n(r.finished)),
      gone_early: n(r.gone_early), gone_median_age_s: int(r.gone_age),
      execs: n(ex.n), exec_ok_pct: pct(n(ex.ok), n(ex.n)), exec_p50_ms: int(ex.p50), exec_p95_ms: int(ex.p95),
      checks: n(ch.n), check_ok_pct: pct(n(ch.ok), n(ch.n)),
      deletes: n(de.n), delete_ok_pct: pct(n(de.ok), n(de.n)), delete_failed: n(r.delete_failed), live: n(r.live), last_started_at: iso(r.last_started), last_error: lastErr,
    };
  });
  return { hours, enabled: PROBE.enabled(), lifetime_minutes: Math.round(PROBE.lifetimeMs() / 60_000), every_minutes: Math.round(PROBE.everyMs() / 60_000), providers, cost: probeCost() };
}

const probeOut = (r: any) => ({
  id: n(r.id), provider: r.provider as ProbeProvider, sandbox_id: r.sandbox_id ?? null, credential_id: r.credential_id == null ? null : n(r.credential_id), name: r.name ?? null, state: r.state as string, region: r.region ?? null,
  started_at: iso(r.started_at)!, create_ms: int(r.create_ms), ready_ms: int(r.ready_ms), create_error: r.create_error ?? null,
  gone_at: iso(r.gone_at), gone_reason: r.gone_reason ?? null, gone_age_s: r.gone_at ? Math.round((new Date(r.gone_at).getTime() - new Date(r.started_at).getTime()) / 1000) : null,
  deleted_at: iso(r.deleted_at), delete_ms: int(r.delete_ms), delete_error: r.delete_error ?? null,
  execs_ok: n(r.execs_ok), execs_failed: n(r.execs_failed), exec_p50_ms: int(r.exec_p50_ms), exec_p95_ms: int(r.exec_p95_ms), last_error: r.last_error ?? null,
});
export type ProbeOut = ReturnType<typeof probeOut>;

/** GET /compute/probes: the summary and one row per probe over the window, newest first. */
export async function listProbes(q: Record<string, unknown> = {}) {
  const summary = await probeSummary(q);
  const rows = await (await getDb()).query<any>("SELECT * FROM sandbox_probes WHERE started_at > now() - make_interval(hours => $1) ORDER BY started_at DESC, id DESC LIMIT 3000", [summary.hours]);
  return { ...summary, rows: rows.map(probeOut) };
}

/** GET /compute/probes/:id: the probe, its execs and checks, and every error it met. */
export async function probeDetail(id: number) {
  if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error("probe id must be a positive whole number"), { status: 400 });
  const db = await getDb();
  const [r] = await db.query<any>("SELECT * FROM sandbox_probes WHERE id = $1", [id]);
  if (!r) throw Object.assign(new Error("probe not found"), { status: 404 });
  const execs = (await db.query<any>("SELECT id, at, kind, ok, ms, exit_code, error FROM sandbox_probe_execs WHERE probe_id = $1 ORDER BY at, id", [id]))
    .map((e) => ({ id: n(e.id), at: iso(e.at)!, kind: e.kind as "exec" | "check" | "delete", ok: !!e.ok, ms: int(e.ms), exit_code: e.exit_code == null ? null : n(e.exit_code), error: e.error ?? null }));
  const row = probeOut(r);
  const errors = [
    ...(row.create_error ? [{ at: row.started_at, step: row.state === "not_configured" ? "configuration" : "create", error: row.create_error }] : []),
    ...execs.filter((e) => e.error).map((e) => ({ at: e.at, step: e.kind, error: e.error! })),
    ...(row.gone_reason ? [{ at: row.gone_at!, step: "gone", error: row.gone_reason }] : []),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return { row, execs, errors };
}
