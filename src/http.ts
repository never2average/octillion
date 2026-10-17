import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, runTool, TOOL_NAMES, WIDGET_HTML, type ToolName } from "./server.js";
import { connectorEvents, recordMcpEvent } from "./analytics.js";
import { bearer, isWorkerToken, resolveKey, type Org } from "./auth.js";
import { getDb } from "./db.js";
import { parseJsonl, transcripts, type RawEvent } from "./transcripts.js";
import { appendEvents, claimJobs, completeSession, heartbeat } from "./worker.js";
import { fleetCheckin, fleetLeave, fleetStatus } from "./fleet.js";
import { autoscalerStatus, startAutoscaler, stopAutoscaler } from "./autoscaler.js";
import { startArchiver, stopArchiver } from "./archive.js";
import { storageEnabled } from "./storage.js";
import { brokerOrchestratorCredentials, brokerSessionCredentials, gatewayHandler } from "./gateway.js";
import * as research from "./research.js";
import { usageReport } from "./usage.js";
import * as kv from "./keyvault.js";
import * as populations from "./populations.js";
import * as onboarding from "./admin.js";
import { createHash, timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT ?? 3333);
const HOST = process.env.HOST ?? "127.0.0.1";
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://${HOST}:${PORT}`).replace(/\/$/, "");
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

/** Set on SIGTERM/SIGINT: the process is finishing in-flight requests and will exit. */
let draining = false;

export function createApp() {
  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  app.get("/healthz", async (_req, res) => {
    if (draining) return void res.status(503).json({ ok: false, draining: true }); // rolling deploy: stop routing here
    await (await getDb()).query("SELECT 1");
    res.json({ ok: true, transcripts: transcripts().kind });
  });

  // ---------- inference gateway: /gw/<provider>/... (ogw_ session tokens, real keys from the vault) ----------
  // Mounted before any body parser: requests and responses stream straight through.
  app.use("/gw/:provider", (req, res, next) => void gatewayHandler(req, res).catch(next));

  // ---------- landing page + access requests ----------
  app.use(express.static(PUBLIC_DIR, { extensions: ["html"], maxAge: "5m" }));

  const recent = new Map<string, number[]>();
  app.post("/api/access-requests", express.json({ limit: "16kb" }), async (req, res) => {
    const ip = req.ip ?? "?";
    const now = Date.now();
    const hits = (recent.get(ip) ?? []).filter((t) => now - t < 60 * 60_000);
    if (hits.length >= 5) return void res.status(429).json({ error: "Too many requests, try again later." });
    recent.set(ip, [...hits, now]);

    const s = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const email = s(req.body?.email, 200), company = s(req.body?.company, 200);
    const productUrl = s(req.body?.product_url, 500), message = s(req.body?.message, 4000);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return void res.status(400).json({ error: "Please enter a valid email." });
    if (!company) return void res.status(400).json({ error: "Please tell us your company." });
    await (await getDb()).query(
      "INSERT INTO access_requests (email, company, product_url, message) VALUES ($1, $2, $3, $4)",
      [email, company, productUrl || null, message || null],
    );
    const hook = process.env.ACCESS_REQUEST_WEBHOOK_URL; // e.g. a Slack incoming webhook
    if (hook)
      fetch(hook, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `New Octillion access request: ${company} <${email}> ${productUrl}\n${message}` }),
        signal: AbortSignal.timeout(5000),
      }).catch((err) => console.error("access-request webhook failed:", err.message));
    res.status(201).json({ ok: true });
  });

  // ---------- MCP (per-organization API key) ----------
  // Keys arrive as `Authorization: Bearer oct_...` or in the connector URL, /mcp/oct_..., for hosts that
  // only take a URL. Stateless: a fresh server per request, bound to the caller's org.
  // One access-log line per connector request (also the ones analytics never sees: bad keys, GET/DELETE probes,
  // rejected Accept headers), so "connected but nothing happened" can be diagnosed. The key is never logged.
  app.use("/mcp", (req, res, next) => {
    const t0 = Date.now();
    res.on("finish", () => {
      const msgs = Array.isArray(req.body) ? req.body : req.body ? [req.body] : [];
      const rpc = msgs.map((m: any) => (m?.method === "tools/call" ? `tools/call:${m?.params?.name}` : m?.method)).filter(Boolean).join(",");
      console.error(`mcp ${req.method} ${res.statusCode} org=${res.locals.org ?? "-"} rpc=${rpc || "-"} ${Date.now() - t0}ms ua="${String(req.get("user-agent") ?? "").slice(0, 80)}"`);
    });
    next();
  });
  const mcp = async (req: Request, res: Response, org: Org) => {
    res.locals.org = org.slug;
    transcripts().warm(); // a user is here: have transcript search awake by the time they ask for evidence
    for (const e of connectorEvents(req.body, req.get("user-agent"))) recordMcpEvent(org.orgId, e);
    const server = createServer(org);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
  const unauthorized = (res: Response) =>
    res.status(401).set("WWW-Authenticate", 'Bearer realm="octillion"').json({
      jsonrpc: "2.0", id: null,
      error: { code: -32001, message: `Missing or invalid Octillion API key. Request access at ${PUBLIC_URL}` },
    });
  const methodNotAllowed = (_req: Request, res: Response) =>
    void res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });

  app.post("/mcp", express.json({ limit: "4mb" }), async (req, res) => {
    const org = await resolveKey(bearer(req.headers.authorization));
    org ? await mcp(req, res, org) : unauthorized(res);
  });
  app.post("/mcp/:key", express.json({ limit: "4mb" }), async (req, res) => {
    const org = await resolveKey(String(req.params.key));
    org ? await mcp(req, res, org) : unauthorized(res);
  });
  app.all(["/mcp", "/mcp/:key"], methodNotAllowed);

  // ---------- orchestrator worker API (shared OCTILLION_WORKER_TOKEN) ----------
  const worker = express.Router();
  worker.use((req, res, next) => (isWorkerToken(bearer(req.headers.authorization)) ? next() : void res.status(401).json({ error: "Invalid worker token" })));
  worker.use(express.json({ limit: "32mb" }));
  worker.use(express.text({ type: ["application/x-ndjson", "application/jsonl", "text/plain"], limit: "32mb" }));

  worker.post("/claim", async (req, res) => {
    const { worker_id, limit, models, harness, agent_ids, simulation_id } = req.body ?? {};
    if (typeof worker_id !== "string" || !worker_id) return void res.status(400).json({ error: "worker_id is required" });
    res.json({ jobs: await claimJobs(worker_id, { limit, models, harness, agent_ids, simulation_id: typeof simulation_id === "string" && simulation_id ? simulation_id : undefined }) });
  });
  worker.post("/sessions/:id/events", async (req, res) => {
    const events: RawEvent[] = typeof req.body === "string" ? parseJsonl(req.body) : req.body?.events;
    if (!Array.isArray(events)) return void res.status(400).json({ error: "Send JSONL (application/x-ndjson) or {events: [...]}" });
    res.json(await appendEvents(String(req.params.id), events));
  });
  worker.post("/sessions/:id/heartbeat", async (req, res) => {
    await heartbeat(String(req.params.id));
    res.status(204).end();
  });
  worker.post("/sessions/:id/complete", async (req, res) => {
    const status = req.body?.status ?? "completed";
    if (!["completed", "failed", "timeout"].includes(status)) return void res.status(400).json({ error: "status must be completed, failed or timeout" });
    res.json((await completeSession(String(req.params.id), { ...req.body, status })) ?? { verdict: null });
  });
  // Fleet: orchestrators check in every ~30s and get their share of the global, usage-proportional pod plan.
  worker.post("/fleet", async (req, res) => {
    const { orchestrator_id, capacity, meta } = req.body ?? {};
    if (typeof orchestrator_id !== "string" || !orchestrator_id) return void res.status(400).json({ error: "orchestrator_id is required" });
    res.json(await fleetCheckin(orchestrator_id, capacity, meta));
  });
  worker.delete("/fleet/:id", async (req, res) => {
    await fleetLeave(String(req.params.id));
    res.status(204).end();
  });
  worker.get("/fleet", async (_req, res) => void res.json(await fleetStatus()));
  // Product onboarding research (docs/onboarding.md).
  worker.post("/research/claim", async (req, res) => {
    const { worker_id, limit, research_id } = req.body ?? {};
    if (typeof worker_id !== "string" || !worker_id) return void res.status(400).json({ error: "worker_id is required" });
    res.json({ jobs: await research.claimResearch(worker_id, limit, typeof research_id === "string" && research_id ? research_id : undefined) });
  });
  worker.post("/research/:id/progress", async (req, res) => {
    await research.researchProgress(String(req.params.id), String(req.body?.stage ?? "working"), req.body?.note);
    res.status(204).end();
  });
  worker.post("/research/:id/validate", async (req, res) => void res.json(await research.validateResearchJob(String(req.params.id), req.body?.result)));
  worker.post("/research/:id/complete", async (req, res) => {
    try { res.json(await research.completeResearch(String(req.params.id), req.body ?? {})); }
    catch (e) {
      const err = e as Error & { status?: number; issues?: string[] };
      if (err.status === 422) return void res.status(422).json({ error: err.message, issues: err.issues });
      throw e;
    }
  });
  worker.get("/library/tasks", async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    res.json(await research.libraryTasks({ query: q.query, category: q.category, language: q.language, limit: q.limit ? Number(q.limit) : undefined }));
  });

  // Credential broker: the orchestrator holds no provider keys; it asks per orchestrator and per session.
  worker.post("/orchestrator/credentials", async (req, res) => {
    const id = req.body?.orchestrator_id;
    if (typeof id !== "string" || !id) return void res.status(400).json({ error: "orchestrator_id is required" });
    res.json(await brokerOrchestratorCredentials(id));
  });
  worker.post("/sessions/:id/credentials", async (req, res) => void res.json(await brokerSessionCredentials(String(req.params.id))));
  app.use("/api/worker", worker);

  // ---------- key vault admin API (OCTILLION_ADMIN_TOKEN) ----------
  const admin = express.Router();
  const adminOk = (t: string | null) => {
    const want = process.env.OCTILLION_ADMIN_TOKEN;
    if (!want || !t) return false;
    const h = (x: string) => createHash("sha256").update(x).digest();
    return timingSafeEqual(h(t), h(want));
  };
  admin.use((req, res, next) => (adminOk(bearer(req.headers.authorization)) ? next() : void res.status(401).json({ error: "Invalid admin token" })));
  admin.use(express.json({ limit: "64kb" }));
  admin.get("/keyvault/providers", async (_req, res) => void res.json({ providers: await kv.listProviders() }));
  admin.put("/keyvault/providers/:slug", async (req, res) => void res.json(await kv.upsertProvider({ ...req.body, slug: String(req.params.slug) })));
  admin.get("/keyvault/credentials", async (_req, res) => void res.json({ credentials: await kv.listCredentials() }));
  admin.post("/keyvault/credentials", async (req, res) => {
    const { provider, secret, label, priority } = req.body ?? {};
    if (typeof provider !== "string" || typeof secret !== "string") return void res.status(400).json({ error: "provider and secret are required" });
    res.status(201).json(await kv.setCredential(provider, secret, { label, priority }));
  });
  admin.patch("/keyvault/credentials/:id", async (req, res) => {
    await kv.setCredentialEnabled(Number(req.params.id), Boolean(req.body?.enabled));
    res.status(204).end();
  });
  admin.delete("/keyvault/credentials/:id", async (req, res) => {
    await kv.deleteCredential(Number(req.params.id));
    res.status(204).end();
  });
  admin.get("/usage/models", async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    res.json(await usageReport({ days: q.days ? Number(q.days) : undefined, model: q.model }));
  });
  admin.get("/gateway/usage", async (_req, res) => {
    const rows = await (await getDb()).query(
      `SELECT provider, coalesce(session_id, orchestrator_id) AS consumer, requests, errors, input_tokens, output_tokens, bytes, last_at
         FROM gateway_usage ORDER BY last_at DESC LIMIT 500`);
    res.json({ usage: rows });
  });
  // Developer populations: the coding-agent mix per population (shares, pauses, sandbox unit).
  admin.get("/populations", async (_req, res) => void res.json({ populations: await populations.listPopulations() }));
  admin.get("/populations/:slug", async (req, res) => void res.json(await populations.getPopulation(String(req.params.slug))));
  admin.post("/populations", async (req, res) => {
    const { slug, name, from, description } = req.body ?? {};
    if (typeof slug !== "string" || typeof name !== "string") return void res.status(400).json({ error: "slug and name are required" });
    res.status(201).json(await populations.createPopulation(slug, name, { from, description }));
  });
  admin.patch("/populations/:slug", async (req, res) => void res.json(await populations.updatePopulation(String(req.params.slug), req.body ?? {})));
  admin.put("/populations/:slug/agents/:agent", async (req, res) => {
    const slug = String(req.params.slug), agent = decodeURIComponent(String(req.params.agent));
    const { market_share, paused, paused_reason, notes } = req.body ?? {};
    if (market_share !== undefined) await populations.setShare(slug, agent, Number(market_share), notes);
    if (paused !== undefined) await populations.setPaused(slug, agent, Boolean(paused), paused_reason);
    res.json(await populations.getPopulation(slug));
  });
  admin.post("/populations/:slug/default", async (req, res) => void res.json(await populations.setDefaultPopulation(String(req.params.slug))));
  admin.get("/autoscaler", async (_req, res) => void res.json(await autoscalerStatus()));
  // Onboarding console (public/admin.html, src/admin.ts): requests, organizations, keys, funnel, audit.
  // X-Admin-Actor names the person for the audit log; the token is shared, so it is a label, not an identity.
  const actor = (req: Request) => String(req.get("x-admin-actor") ?? "admin").trim() || "admin";
  const ob = express.Router();
  ob.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); }); // responses can carry a new key
  ob.get("/overview", async (_req, res) => void res.json(await onboarding.overview()));
  ob.get("/requests", async (req, res) => void res.json({ requests: await onboarding.listRequests(req.query.status ? String(req.query.status) : undefined) }));
  ob.post("/requests/:id/approve", async (req, res) => void res.status(201).json(await onboarding.approveRequest(actor(req), Number(req.params.id), req.body ?? {})));
  ob.post("/requests/:id/decline", async (req, res) => {
    await onboarding.declineRequest(actor(req), Number(req.params.id), req.body?.note);
    res.status(204).end();
  });
  ob.post("/requests/:id/reopen", async (req, res) => {
    await onboarding.reopenRequest(actor(req), Number(req.params.id));
    res.status(204).end();
  });
  ob.get("/orgs", async (_req, res) => void res.json({ stages: onboarding.STAGES, orgs: await onboarding.listOrgs() }));
  ob.post("/orgs", async (req, res) => void res.status(201).json(await onboarding.createOrgManually(actor(req), req.body ?? {})));
  ob.get("/orgs/:slug", async (req, res) => void res.json(await onboarding.orgDetail(String(req.params.slug))));
  ob.patch("/orgs/:slug", async (req, res) => void res.json(await onboarding.updateOrg(actor(req), String(req.params.slug), req.body ?? {})));
  ob.post("/orgs/:slug/invited", async (req, res) => void res.json(await onboarding.markInvited(actor(req), String(req.params.slug), req.body?.invited !== false)));
  ob.post("/orgs/:slug/keys", async (req, res) => void res.status(201).json(await onboarding.issueKey(actor(req), String(req.params.slug), req.body?.label)));
  ob.post("/orgs/:slug/keys/:id/revoke", async (req, res) => {
    await onboarding.revokeKey(actor(req), String(req.params.slug), Number(req.params.id));
    res.status(204).end();
  });
  ob.post("/orgs/:slug/keys/:id/rotate", async (req, res) => void res.status(201).json(await onboarding.rotateKey(actor(req), String(req.params.slug), Number(req.params.id))));
  ob.get("/audit", async (req, res) => void res.json({ audit: await onboarding.auditLog(req.query.limit ? Number(req.query.limit) : undefined) }));
  admin.use("/onboarding", ob);
  app.use("/api/admin", admin);

  // ---------- local preview of the widget (development only) ----------
  if (process.env.OCTILLION_PREVIEW === "1") {
    const isTool = (n: string): n is ToolName => (TOOL_NAMES as string[]).includes(n);
    const keyOf = (req: Request) => String(req.query.key ?? req.body?.key ?? "");
    app.post("/preview/api/tool", express.json(), async (req, res) => {
      const org = await resolveKey(keyOf(req));
      const { name, arguments: args = {} } = req.body ?? {};
      if (!org) return void res.status(401).json({ isError: true, content: [{ type: "text", text: "Invalid key" }] });
      if (!isTool(name)) return void res.status(404).json({ isError: true, content: [{ type: "text", text: `Unknown tool ${name}` }] });
      res.json(await runTool(org, name, args));
    });
    app.get("/preview/:tool", async (req, res) => {
      const org = await resolveKey(keyOf(req));
      const name = req.params.tool;
      if (!org) return void res.status(401).send("Pass ?key=<org API key>");
      if (!isTool(name)) return void res.status(404).send(`Unknown tool ${name}`);
      const { key: _key, ...args } = req.query as Record<string, unknown>;
      for (const k of ["days", "offset", "limit", "repeats"]) if (args[k] !== undefined) args[k] = Number(args[k]);
      const result = await runTool(org, name, args);
      const boot = JSON.stringify({ toolEndpoint: "/preview/api/tool", key: keyOf(req), data: result.structuredContent ?? null, error: result.isError ? result.content : null })
        .replace(/</g, "\\u003c");
      res.type("html").send(WIDGET_HTML.replace("<script>", `<script>window.__OCTILLION_PREVIEW__ = ${boot};</script>\n<script>`));
    });
  }

  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? "Internal error" : err.message });
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = await getDb();
  const server = createApp().listen(PORT, HOST, () => {
    console.error(`octillion (${db.kind}, transcripts in ${transcripts().kind}) listening on http://${HOST}:${PORT}`);
    console.error(`  landing page  ${PUBLIC_URL}/`);
    console.error(`  MCP endpoint  ${PUBLIC_URL}/mcp/<api key>   (or /mcp with Authorization: Bearer <api key>)`);
    console.error(`  worker API    ${PUBLIC_URL}/api/worker/*${process.env.OCTILLION_WORKER_TOKEN ? "" : "   (disabled: set OCTILLION_WORKER_TOKEN)"}`);
    // On-demand orchestrators (boat sandboxes launched/reaped by the server). Needs the public https URL the
    // sandboxes reach us on, the worker token and a boat key in the vault. OCTILLION_AUTOSCALE=off disables it.
    const autoscale = (process.env.OCTILLION_AUTOSCALE ?? "on").toLowerCase() !== "off";
    if (autoscale && /^https:\/\//.test(PUBLIC_URL) && process.env.OCTILLION_WORKER_TOKEN) {
      startAutoscaler();
      console.error("  autoscaler    on (orchestrators on demand; OCTILLION_AUTOSCALE=off to disable)");
    } else console.error(`  autoscaler    off (${autoscale ? "needs an https PUBLIC_URL and OCTILLION_WORKER_TOKEN" : "OCTILLION_AUTOSCALE=off"})`);
    // Off-machine archive of traces and research to R2 (src/archive.ts): backfills, then keeps up every 5 minutes.
    startArchiver();
    console.error(`  archive       ${storageEnabled() ? "on (traces + research to R2)" : "off (R2_* not set)"}`);
  });
  // Graceful drain (deploys, restarts): stop accepting connections, let in-flight requests finish (gateway streams
  // are sandboxed agents' model calls; cutting them fails the sessions), then exit. A rolling deploy starts the new
  // replica first, so new requests land there while this one drains (deploy/rolling-deploy.sh).
  const shutdown = (signal: string) => {
    if (draining) return;
    draining = true;
    const limit = Math.max(0, Number(process.env.OCTILLION_DRAIN_SECONDS ?? 300));
    console.error(`${signal}: draining, in-flight requests get up to ${limit}s`);
    void stopAutoscaler();
    stopArchiver();
    server.close(() => { console.error("drained, exiting"); process.exit(0); });
    server.closeIdleConnections();
    setInterval(() => server.closeIdleConnections(), 1000).unref(); // keep-alive sockets as they go idle
    setTimeout(() => { console.error("drain deadline reached, exiting"); process.exit(0); }, limit * 1000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
