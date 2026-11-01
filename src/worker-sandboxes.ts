import express, { type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { getDb } from "./db.js";
import { canActOnSession, type WorkerAuth } from "./workerauth.js";
import { isGone, vercelClient, type VercelClient } from "./vercel-sandbox.js";
import * as lib from "../orchestrator/deploy/boat-lib.js";
import { VERCEL_SIZES } from "../orchestrator/core/config.js";

/**
 * Worker sandbox broker (docs/vercel-sandbox-workers.md, sql/migrations/0016_worker_sandboxes.sql). With
 * OCTILLION_SANDBOX_PROVIDER=vercel, orchestrators (still on boat) get their per-session worker sandboxes on Vercel
 * Sandbox through these routes, under /api/worker/sandboxes with their worker token:
 *
 *   GET    /config                       is Vercel Sandbox configured here (no secret in the answer)
 *   GET    /?prefix=                     this caller's live sandboxes (orphan cleanup)
 *   POST   /                             {session_id, size, timeout_sec, name} -> {id}
 *   GET    /:id                          {state: ready|starting|stopped|gone}
 *   POST   /:id/exec                     {command, timeout_sec, stream?} -> {exitCode, stdout, stderr} | ND-JSON frames
 *   POST   /:id/commands                 {command} -> {command_id} (detached)
 *   GET    /:id/commands/:cid            {running, exit_code}
 *   PUT    /:id/files                    {path, content | content_base64}
 *   POST   /:id/network-policy           {allow: [hosts]} (the session's egress lockdown)
 *   DELETE /:id
 *
 * Why a broker and not a token for the orchestrator: Vercel Sandbox is authenticated with the project's OIDC token or a
 * team access token, both of which can do anything to every sandbox (and more) in the project; it has no token scoped to
 * one sandbox. The OIDC token exists only inside our functions. So it stays here, and every call is checked:
 *
 *  - ownership: a sandbox is usable only by the owner recorded when it was made: the same job token ('job:<sim_...>'),
 *    or the fleet token for Octillion's shared orchestrators ('fleet'). Anything else is 403; an unknown id is 404, a
 *    deleted one 410.
 *  - create: the session must be one this token may act on (canActOnSession), exist and be running; at most
 *    MAX_PER_SESSION live sandboxes per session and MAX_PER_OWNER per owner.
 *  - one call stays under the function's 300 s (maxDuration): execs and log streams are cut at EXEC_MAX_SECONDS and the
 *    client reconnects (the follow loop resumes by line number); long scripts run detached and are polled.
 *  - reaper (cron): rows whose session ended or whose timeout passed are deleted at Vercel; Vercel also stops every
 *    sandbox at its own timeout (persistent: false).
 */

const env = (k: string) => process.env[k]?.trim() || undefined;
const num = (k: string, d: number, min: number, max: number) => { const v = Number(env(k)); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d; };
export const WORKER_SANDBOX = {
  execMaxSeconds: () => num("OCTILLION_WORKER_SANDBOX_EXEC_MAX_SECONDS", 280, 10, 285),
  maxTimeoutSec: () => num("OCTILLION_VERCEL_MAX_TIMEOUT_MINUTES", 300, 10, 24 * 60) * 60,
  maxPerSession: () => num("OCTILLION_WORKER_SANDBOX_MAX_PER_SESSION", 2, 1, 10),
  maxPerOwner: () => num("OCTILLION_WORKER_SANDBOX_MAX_PER_OWNER", 60, 1, 1000),
};
/** Worker sandbox names on Vercel: never a boat prefix nor the probe's, so neither reaper touches them. */
export const VERCEL_WORKER_PREFIX = `${lib.BOAT_NAMESPACE}-vw-`;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const HOST_RE = /^(?=.{1,253}$)(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export const ownerOf = (a: WorkerAuth) => (a.kind === "job" ? `job:${a.jobId}` : "fleet");

interface Row {
  id: number; sandbox_id: string; vm_session: string | null; owner: string; session_id: string; job_id: string | null;
  vcpus: number; memory_mb: number; timeout_sec: number; created_at: Date; deleted_at: Date | null;
}

type ClientOf = (req: Request) => VercelClient | { not_configured: string };
const defaultClient: ClientOf = (req) => {
  const t = req.headers["x-vercel-oidc-token"];
  return vercelClient({ oidcToken: typeof t === "string" ? t : null });
};

const T = "/* tenant: internal: worker sandbox broker, by the caller's worker token (owner) */";
const vmState = (status: string, sessionStatus = ""): "ready" | "starting" | "stopped" => {
  const s = sessionStatus || status;
  if (s === "running") return "ready";
  if (["stopped", "stopping", "failed", "aborted", "snapshotting"].includes(s) || ["stopped", "stopping", "failed"].includes(status)) return "stopped";
  return "starting";
};

/** The broker's routes; `authOf` reads the worker auth the caller's router put in res.locals (src/http.ts). */
export function workerSandboxRouter(authOf: (res: Response) => WorkerAuth, opts: { client?: ClientOf } = {}): express.Router {
  const r = express.Router();
  const clientOf = opts.client ?? defaultClient;
  const err = (res: Response, status: number, error: string, code?: string) => void res.status(status).json({ error, ...(code ? { code } : {}) });
  const client = (req: Request, res: Response): VercelClient | null => {
    const c = clientOf(req);
    if ("not_configured" in c) { err(res, 503, `Vercel Sandbox is not configured on this deployment: ${c.not_configured}`, "not_configured"); return null; }
    return c;
  };
  /** The row behind :id when this caller owns it; otherwise answers 404 / 403 / 410 and returns null. */
  const own = async (req: Request, res: Response, allowDeleted = false): Promise<Row | null> => {
    const [row] = await (await getDb()).query<Row>(`${T} SELECT * FROM worker_sandboxes WHERE sandbox_id = $1`, [String(req.params.id)]);
    if (!row) { err(res, 404, "No such worker sandbox", "not_found"); return null; }
    if (row.owner !== ownerOf(authOf(res))) { err(res, 403, "This worker sandbox belongs to another job", "not_owner"); return null; }
    if (row.deleted_at && !allowDeleted) { err(res, 410, "This worker sandbox was deleted", "deleted"); return null; }
    return row;
  };
  /** Vercel's session id for a row (fetched once, then cached on the row). */
  const sessionOf = async (c: VercelClient, row: Row): Promise<string> => {
    if (row.vm_session) return row.vm_session;
    const g = await c.get(row.sandbox_id);
    if (!g.session) throw Object.assign(new Error("the sandbox has no running session yet"), { status: 409 });
    await (await getDb()).query(`${T} UPDATE worker_sandboxes SET vm_session = $2 WHERE id = $1`, [row.id, g.session]);
    return (row.vm_session = g.session);
  };
  const touch = (row: Row) => void getDb().then((db) => db.query(`${T} UPDATE worker_sandboxes SET last_used_at = now() WHERE id = $1`, [row.id])).catch(() => {});
  /** Vercel errors as answers: its 404/410 = the sandbox is gone (410), its 4xx = 502 for us (not the caller's fault). */
  const fail = (res: Response, e: unknown) => {
    if (res.headersSent) { res.end(); return; }
    const status = (e as { status?: number }).status;
    if (isGone(e)) return err(res, 410, "The sandbox is gone at Vercel", "gone");
    if (status === 409) return err(res, 409, (e as Error).message, "not_ready");
    if (status === 429) return err(res, 429, (e as Error).message, "rate_limited");
    err(res, 502, (e as Error).message.slice(0, 400), "vercel_error");
  };

  r.get("/config", (req, res) => {
    const c = clientOf(req);
    res.json("not_configured" in c ? { configured: false, reason: c.not_configured } : { configured: true, via: c.via, region: c.region });
  });

  r.get("/", async (req, res) => {
    const prefix = String(req.query.prefix ?? "");
    const rows = await (await getDb()).query<Row>(
      `${T} SELECT * FROM worker_sandboxes WHERE owner = $1 AND deleted_at IS NULL AND starts_with(sandbox_id, $2) ORDER BY id LIMIT 500`, [ownerOf(authOf(res)), prefix]);
    res.json({ sandboxes: rows.map((x) => ({ id: x.sandbox_id, name: x.sandbox_id, session_id: x.session_id, created_at: x.created_at })) });
  });

  r.post("/", async (req, res) => {
    const auth = authOf(res);
    const { session_id, size, timeout_sec, name } = req.body ?? {};
    if (typeof session_id !== "string" || !session_id) return err(res, 400, "session_id is required");
    if (!(await canActOnSession(auth, session_id))) return err(res, 403, "This worker token is bound to another job", "not_owner");
    const db = await getDb();
    const [s] = await db.query<{ status: string; simulation_id: string }>(
      "/* tenant: session checked against the job token above (canActOnSession) */ SELECT status, simulation_id FROM agent_sessions WHERE id = $1", [session_id]);
    if (!s) return err(res, 404, "No such session", "no_session");
    if (s.status !== "running") return err(res, 409, `The session is ${s.status}, not running`, "session_not_running");
    const owner = ownerOf(auth);
    const [counts] = await db.query<{ per_session: number; per_owner: number }>(
      `${T} SELECT count(*) FILTER (WHERE session_id = $1)::int AS per_session, count(*)::int AS per_owner FROM worker_sandboxes WHERE deleted_at IS NULL AND owner = $2`, [session_id, owner]);
    if ((counts?.per_session ?? 0) >= WORKER_SANDBOX.maxPerSession()) return err(res, 409, "This session already has its worker sandboxes", "too_many");
    if ((counts?.per_owner ?? 0) >= WORKER_SANDBOX.maxPerOwner()) return err(res, 429, "Too many live worker sandboxes for this orchestrator's job", "too_many");
    const c = client(req, res);
    if (!c) return;
    const sz = VERCEL_SIZES[typeof size === "string" ? size : "default"] ?? VERCEL_SIZES.default!;
    const timeoutSec = Math.round(Math.min(WORKER_SANDBOX.maxTimeoutSec(), Math.max(600, Number(timeout_sec) || 3600)));
    const hint = (typeof name === "string" ? name : "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36);
    const sandboxName = `${VERCEL_WORKER_PREFIX}${randomBytes(5).toString("hex")}${hint ? `-${hint}` : ""}`.replace(/-+$/, "");
    const orch = String(req.headers["x-octillion-orchestrator"] ?? "").replace(/[^\w.:-]/g, "").slice(0, 80) || null;
    // The row first: a create whose answer is lost is still ours, and the reaper finds it.
    const [row] = await db.query<Row>(
      `${T} INSERT INTO worker_sandboxes (sandbox_id, owner, session_id, job_id, orchestrator_id, vcpus, memory_mb, timeout_sec)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`, [sandboxName, owner, session_id, s.simulation_id, orch, sz.vcpus, sz.memoryMb, timeoutSec]);
    try {
      const made = await c.create({ name: sandboxName, vcpus: sz.vcpus, memoryMb: sz.memoryMb, timeoutMs: timeoutSec * 1000 });
      await db.query(`${T} UPDATE worker_sandboxes SET vm_session = $2 WHERE id = $1`, [row!.id, made.session]);
      res.status(201).json({ id: sandboxName, provider: "vercel", vcpus: sz.vcpus, memory_mb: sz.memoryMb, timeout_sec: timeoutSec, region: c.region });
    } catch (e) {
      await db.query(`${T} UPDATE worker_sandboxes SET deleted_at = now(), delete_reason = $2 WHERE id = $1`, [row!.id, `create failed: ${(e as Error).message.slice(0, 300)}`]);
      c.remove(sandboxName).catch(() => {});
      fail(res, e);
    }
  });

  r.get("/:id", async (req, res) => {
    const row = await own(req, res, true);
    if (!row) return;
    if (row.deleted_at) return void res.json({ id: row.sandbox_id, state: "gone" });
    const c = client(req, res);
    if (!c) return;
    try {
      const g = await c.get(row.sandbox_id);
      const state = vmState(g.status, g.sessionStatus);
      const db = await getDb();
      if (g.session && g.session !== row.vm_session) await db.query(`${T} UPDATE worker_sandboxes SET vm_session = $2 WHERE id = $1`, [row.id, g.session]);
      if (state === "ready") await db.query(`${T} UPDATE worker_sandboxes SET ready_at = coalesce(ready_at, now()) WHERE id = $1`, [row.id]);
      res.json({ id: row.sandbox_id, state, detail: g.sessionStatus || g.status });
    } catch (e) {
      if (isGone(e)) return void res.json({ id: row.sandbox_id, state: "gone" });
      fail(res, e);
    }
  });

  r.post("/:id/exec", async (req, res) => {
    const { command, timeout_sec, stream } = req.body ?? {};
    if (typeof command !== "string" || !command) return err(res, 400, "command is required");
    const row = await own(req, res);
    if (!row) return;
    const c = client(req, res);
    if (!c) return;
    touch(row);
    const t = Math.min(WORKER_SANDBOX.execMaxSeconds(), Math.max(1, Number(timeout_sec) || 120));
    let sid = "", cmd = "";
    const cut = new AbortController();
    const timer = setTimeout(() => cut.abort(), t * 1000);
    // The caller gave up (its own timeout, or the runner stopped following): stop this command too.
    res.on("close", () => { if (!res.writableFinished) cut.abort(); });
    try {
      sid = await sessionOf(c, row);
      cmd = await c.run(sid, command);
      if (stream) {
        res.status(200).setHeader("content-type", "application/x-ndjson");
        res.write(JSON.stringify({ type: "started" }) + "\n");
      }
      let stdout = "", stderr = "";
      try {
        for await (const f of c.logs(sid, cmd, cut.signal)) {
          if (f.stream === "error") throw new Error(`command stream: ${f.data}`);
          if (stream) res.write(JSON.stringify({ type: f.stream === "stderr" ? "stderr" : "stdout", data: f.data }) + "\n");
          else if (f.stream === "stderr") stderr += f.data; else stdout += f.data;
        }
      } catch (e) {
        if (!cut.signal.aborted) throw e;
      }
      let exitCode: number | null = null;
      if (cut.signal.aborted) await c.kill(sid, cmd, 15); // cut at the time limit (or the caller left)
      else exitCode = (await c.status(sid, cmd, true, 30_000)).exitCode;
      if (stream) res.end(JSON.stringify({ type: "exit", exitCode, ...(cut.signal.aborted ? { cut: true } : {}) }) + "\n");
      else res.json({ exitCode, stdout, stderr });
    } catch (e) {
      if (cmd && sid) c.kill(sid, cmd, 9).catch(() => {});
      if (stream && res.headersSent) return void res.end(JSON.stringify({ type: "error", error: "stream_error", message: (e as Error).message.slice(0, 300) }) + "\n");
      fail(res, e);
    } finally { clearTimeout(timer); }
  });

  r.post("/:id/commands", async (req, res) => {
    const { command } = req.body ?? {};
    if (typeof command !== "string" || !command) return err(res, 400, "command is required");
    const row = await own(req, res);
    if (!row) return;
    const c = client(req, res);
    if (!c) return;
    touch(row);
    try { res.status(201).json({ command_id: await c.run(await sessionOf(c, row), command) }); }
    catch (e) { fail(res, e); }
  });

  r.get("/:id/commands/:cid", async (req, res) => {
    const row = await own(req, res);
    if (!row) return;
    const c = client(req, res);
    if (!c) return;
    try {
      const s = await c.status(await sessionOf(c, row), String(req.params.cid));
      res.json({ running: s.exitCode == null, exit_code: s.exitCode });
    } catch (e) { fail(res, e); }
  });

  r.put("/:id/files", async (req, res) => {
    const { path, content, content_base64 } = req.body ?? {};
    if (typeof path !== "string" || !/^\/[^\0]{1,4095}$/.test(path) || path.split("/").includes("..")) return err(res, 400, "path must be an absolute path without '..'");
    if (typeof content !== "string" && typeof content_base64 !== "string") return err(res, 400, "content or content_base64 is required");
    const buf = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content_base64, "base64");
    if (buf.length > MAX_FILE_BYTES) return err(res, 413, `file larger than ${MAX_FILE_BYTES} bytes`);
    const row = await own(req, res);
    if (!row) return;
    const c = client(req, res);
    if (!c) return;
    touch(row);
    try {
      await c.writeFile(await sessionOf(c, row), path, buf);
      res.json({ ok: true, bytes: buf.length });
    } catch (e) { fail(res, e); }
  });

  r.post("/:id/network-policy", async (req, res) => {
    const allow = req.body?.allow;
    if (!Array.isArray(allow) || !allow.length || allow.length > 200 || !allow.every((h) => typeof h === "string" && HOST_RE.test(h)))
      return err(res, 400, "allow must be 1 to 200 host names");
    const row = await own(req, res);
    if (!row) return;
    const c = client(req, res);
    if (!c) return;
    try {
      const hosts = [...new Set(allow.map((h: string) => h.toLowerCase()))].sort();
      await c.networkPolicy(await sessionOf(c, row), hosts);
      await (await getDb()).query(`${T} UPDATE worker_sandboxes SET network_policy = $2 WHERE id = $1`, [row.id, JSON.stringify({ allow: hosts })]);
      res.json({ ok: true, hosts: hosts.length });
    } catch (e) { fail(res, e); }
  });

  r.delete("/:id", async (req, res) => {
    const row = await own(req, res, true);
    if (!row) return;
    if (row.deleted_at) return void res.status(204).end();
    const c = client(req, res);
    if (!c) return;
    try {
      await c.remove(row.sandbox_id);
      await (await getDb()).query(`${T} UPDATE worker_sandboxes SET deleted_at = now(), delete_reason = 'orchestrator', delete_error = NULL WHERE id = $1`, [row.id]);
      res.status(204).end();
    } catch (e) {
      await (await getDb()).query(`${T} UPDATE worker_sandboxes SET delete_error = $2 WHERE id = $1`, [row.id, (e as Error).message.slice(0, 300)]);
      fail(res, e);
    }
  });

  r.use((e: unknown, _req: Request, res: Response, _next: express.NextFunction) => fail(res, e));
  return r;
}

/**
 * Cron (src/http.ts /api/cron/autoscale): delete worker sandboxes whose session is over or whose timeout has passed,
 * Vercel listings with our worker prefix that have no live row (older than 30 minutes), and prune rows deleted more than
 * 14 days ago. Never throws; a deployment without Vercel Sandbox configured does nothing.
 */
export async function reapWorkerSandboxes(o: { oidcToken?: string | null; client?: VercelClient | { not_configured: string }; deadline?: number } = {}) {
  const out = { reaped: 0, strays: 0, pruned: 0, errors: [] as string[] };
  try {
    const db = await getDb();
    const pruned = await db.query<{ n: number }>(
      `${T} WITH d AS (DELETE FROM worker_sandboxes WHERE id IN (SELECT id FROM worker_sandboxes WHERE deleted_at < now() - interval '14 days' LIMIT 5000) RETURNING 1) SELECT count(*)::int AS n FROM d`);
    out.pruned = Number(pruned[0]?.n ?? 0);
    const due = await db.query<Row & { reason: string }>(
      `/* tenant: internal: worker sandbox reaper, sessions by id */
       SELECT w.*, CASE WHEN s.id IS NULL THEN 'session gone' WHEN s.status <> 'running' THEN 'session ' || s.status ELSE 'timeout passed' END AS reason
         FROM worker_sandboxes w LEFT JOIN agent_sessions s ON s.id = w.session_id
        WHERE w.deleted_at IS NULL AND w.created_at < now() - interval '2 minutes'
          AND (s.id IS NULL OR s.status <> 'running' OR w.created_at + make_interval(secs => w.timeout_sec + 600) < now())
        ORDER BY w.id LIMIT 100`);
    const live = await db.query<{ n: number }>(`${T} SELECT count(*)::int AS n FROM worker_sandboxes WHERE deleted_at IS NULL OR deleted_at > now() - interval '1 hour'`);
    if (!due.length && !Number(live[0]?.n ?? 0)) return out; // nothing of ours anywhere: no Vercel call at all
    const c = o.client ?? vercelClient({ oidcToken: o.oidcToken });
    if ("not_configured" in c) return out;
    for (const row of due) {
      if (o.deadline && Date.now() > o.deadline - 10_000) break;
      try {
        await c.remove(row.sandbox_id);
        await db.query(`${T} UPDATE worker_sandboxes SET deleted_at = now(), delete_reason = $2 WHERE id = $1`, [row.id, `reaped: ${row.reason}`]);
        out.reaped++;
      } catch (e) {
        out.errors.push(`${row.sandbox_id}: ${(e as Error).message.slice(0, 200)}`);
        await db.query(`${T} UPDATE worker_sandboxes SET delete_error = $2 WHERE id = $1`, [row.id, (e as Error).message.slice(0, 300)]);
      }
    }
    const listed = await c.list(VERCEL_WORKER_PREFIX);
    const known = new Set((await db.query<{ sandbox_id: string }>(`${T} SELECT sandbox_id FROM worker_sandboxes WHERE deleted_at IS NULL`)).map((x) => x.sandbox_id));
    for (const s of listed) {
      if (known.has(s.name) || ["stopped", "failed"].includes(s.status) || !s.createdAt || Date.now() - s.createdAt < 30 * 60_000) continue;
      if (o.deadline && Date.now() > o.deadline - 10_000) break;
      try { await c.remove(s.name); out.strays++; } catch (e) { out.errors.push(`${s.name}: ${(e as Error).message.slice(0, 200)}`); }
    }
  } catch (e) {
    out.errors.push((e as Error).message.slice(0, 300));
  }
  return out;
}
