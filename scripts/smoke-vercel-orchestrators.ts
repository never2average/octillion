// Orchestrators on Vercel Sandbox, for scripts/smoke.ts (orchestrator/deploy/orchestrator-host.ts, vercel-orch.ts), against
// the mock Vercel Sandbox in scripts/lib/mock-providers.ts scripted as an orchestrator VM (orchestrator/test/vercel-orch-mock.ts):
// a retired provider is a clear config error; a launch with the supervisor that the real host guard accepts inside the sandbox, with no
// Vercel credential in it; get by id (live, then gone) and the listing; the orphan rules per provider (never a worker or a
// probe); the capacity note old and new; accounting labels and prices. The autoscaler around it: orchestrator/test/per-job.ts.
// Then the OIDC scope: a request from outside cannot plant its token, and a token of another team or project is refused
// by the launch path, the worker sandbox broker, the worker reaper's client and the probe.
import assert from "node:assert/strict";

type Db = { query: <T = any>(sql: string, params?: unknown[]) => Promise<T[]> };

export async function vercelOrchestratorChecks({ base, mockUrl, mockState, workerToken }: { db: Db; base: string; mockUrl: string; mockState: any; workerToken: string }) {
  const host = await import("../orchestrator/deploy/orchestrator-host.js");
  const { vercelClient } = await import("../src/vercel-sandbox.js");
  const { orphanKind, capacityNote, CAPACITY_NOTE } = await import("../src/autoscaler.js");
  const { installOrchestratorVm } = await import("../orchestrator/test/vercel-orch-mock.js");
  const probe = await import("../src/sandbox-probe.js");
  const vs = await import("../src/vercel-sandbox.js");
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const tokenFor = (team: string, project: string) => `${b64({ alg: "RS256" })}.${b64({ owner_id: team, project_id: project, iss: "https://oidc.vercel.com/x" })}.c2ln`;
  const MOCK_OIDC = tokenFor("team_smoke", "prj_smoke"); // this deployment's team and project (smoke.ts sets them)
  const EVIL = tokenFor("team_attacker", "prj_attacker");
  const { sandboxConfigError, vercelEstCostUsd } = await import("../orchestrator/core/config.js");
  const savedExec = mockState.vsbExec;
  try {
    // ---- selection: Vercel Sandbox only; the retired boat.dev is a clear config error, not a silent fallback ----
    assert.equal(sandboxConfigError({}), null, "nothing to set: Vercel Sandbox is the default");
    assert.equal(sandboxConfigError({ OCTILLION_SANDBOX_PROVIDER: "vercel", OCTILLION_ORCHESTRATOR_PROVIDER: "vercel" }), null);
    assert.match(sandboxConfigError({ OCTILLION_SANDBOX_PROVIDER: "boat" }) ?? "", /^OCTILLION_SANDBOX_PROVIDER=boat: boat\.dev was retired on 2026-11-01/);
    assert.match(sandboxConfigError({ OCTILLION_ORCHESTRATOR_PROVIDER: "boat" }) ?? "", /OCTILLION_ORCHESTRATOR_PROVIDER=boat: boat\.dev was retired/);
    assert.match(sandboxConfigError({ OCTILLION_SANDBOX_PROVIDER: "modal" }) ?? "", /unknown sandbox provider/);
    assert.match(sandboxConfigError({ RUNNER: "boat" }) ?? "", /RUNNER=boat: boat\.dev was retired/);

    // ---- a launch through the host, on the mock ----
    const vm = installOrchestratorVm({ url: mockUrl, state: mockState });
    const client = vercelClient({ oidcToken: MOCK_OIDC, baseUrl: `${mockUrl}/vercel-sandbox` });
    assert.ok(!("not_configured" in client), "the mock OIDC token configures the client");
    const h = host.vercelHost({ client: client as any, namespace: "octs", envTag: "smoke" });
    const created: { id?: string; orch?: string; exp?: Date | null } = {};
    const r = await h.launch({ url: "https://octi.example", workerToken: "wt_smoke_job_token_1234567890", podCapacity: 2, tuning: { ORCHESTRATOR_JOB: "sim_smoke1", MAX_SESSION_MINUTES: "30" } },
      { onCreated: (id, orch, info) => { Object.assign(created, { id, orch, exp: info?.expiresAt }); } });
    assert.match(r.sandboxId, /^octs-vo-smoke-v[0-9a-f]{10}$/);
    assert.equal(r.orchId, h.orchIdOf(r.sandboxId));
    assert.deepEqual({ id: created.id, orch: created.orch }, { id: r.sandboxId, orch: r.orchId }, "onCreated records the sandbox before anything else can fail");
    assert.ok(r.expiresAt && Math.abs(r.expiresAt - Date.now() - 360 * 60_000) < 60_000, "expires at the default 6 h timeout");
    assert.ok(vm.supervisors.has(r.sandboxId), "the supervisor runs");
    assert.equal(vm.guards.get(r.sandboxId)?.ok, true, `the host guard passes inside: ${JSON.stringify(vm.guards.get(r.sandboxId))}`);
    const env = mockState.vsbFiles.get(r.sandboxId)?.get("/tmp/octi-orchestrator.env.new")?.toString() ?? "";
    assert.match(env, /^ORCHESTRATOR_JOB=sim_smoke1$/m);
    assert.match(env, /^OCTILLION_HOST_ROLE=vercel-orchestrator$/m);
    assert.ok(!vm.everything(r.sandboxId).includes(MOCK_OIDC), "no Vercel credential enters the sandbox");

    // ---- get by id, the listing, delete ----
    assert.equal((await h.get(r.sandboxId))?.live, true);
    assert.ok((await h.list()).some((s) => s.id === r.sandboxId && s.live));
    mockState.vsbHideFromList.add(r.sandboxId);
    assert.ok(!(await h.list()).some((s) => s.id === r.sandboxId) && (await h.get(r.sandboxId))?.live === true, "listing lag: get still finds it");
    mockState.vsbHideFromList.delete(r.sandboxId);
    await h.delete(r.sandboxId);
    assert.equal(await h.get(r.sandboxId), null, "gone by get after delete");

    // ---- the launch fails cleanly when the guard refuses (not a Vercel Sandbox VM) ----
    vm.opts.vmLike = true;
    const failed = await h.launch({ url: "https://octi.example", workerToken: "wt_smoke_job_token_1234567890", podCapacity: 1 }).then(() => null, (e) => e);
    vm.opts.vmLike = false;
    assert.equal(failed?.launchStep, "preflight");
    assert.match(failed?.launchError ?? "", /host guard refused this sandbox/);
    assert.ok(![...mockState.vsbSandboxes.keys()].some((n: string) => n.startsWith("octs-vo-smoke-")), "the refused sandbox is deleted");

    // ---- the launch's deadline (a 300 s function): past it, the half-launched sandbox is deleted ----
    vm.opts.slowNodeMs = 4000;
    const late = await h.launch({ url: "https://octi.example", workerToken: "wt_smoke_job_token_1234567890", podCapacity: 1 }, { deadline: Date.now() + 8000 }).then(() => null, (e) => e);
    vm.opts.slowNodeMs = 0;
    assert.match(late?.launchError ?? "", /launch deadline reached/, `deadline: ${late?.message}`);
    assert.ok(![...mockState.vsbSandboxes.keys()].some((n: string) => n.startsWith("octs-vo-smoke-")), "the half-launched sandbox is deleted at once");

    // ---- orphans per provider: our orchestrators and stale image builders only ----
    const old = new Date(Date.now() - 31 * 60_000).toISOString();
    assert.equal(orphanKind({ name: "octs-vo-smoke-v0123456789" }, Date.now(), false, h), "orchestrator");
    assert.equal(orphanKind({ name: "octs-vo-smoke-v0123456789", createdAt: new Date(Date.now() - 60_000).toISOString() }, Date.now(), false, h), null, "spared while under 2 minutes old");
    assert.equal(orphanKind({ name: "octs-vo-smoke-v0123456789", createdAt: new Date(Date.now() - 3 * 60_000).toISOString() }, Date.now(), false, h), "orchestrator");
    assert.equal(orphanKind({ name: "octs-vw-smoke-sess-1" }, Date.now(), false, h), null, "a Vercel worker belongs to the broker's reaper");
    assert.equal(orphanKind({ name: "octs-vo-prod-v0123456789" }, Date.now(), false, h), null, "another environment's orchestrator is not ours");
    assert.equal(orphanKind({ name: "octs-vimg-smoke-0123456789abcdef", createdAt: old }, Date.now(), false, h), "image_builder");
    assert.equal(orphanKind({ name: "octs-vimg-smoke-0123456789abcdef", createdAt: old }, Date.now(), true, h), null, "not while a build runs");

    // ---- the capacity note, the older wording (boat's plan) and the current one ----
    const note = capacityNote("sim_a", "vercel", -2);
    assert.equal(note, "sim_a waits for sandbox capacity on Vercel Sandbox (0 free)");
    assert.deepEqual([...(CAPACITY_NOTE.exec(note) ?? [])].slice(1), ["sim_a", "Vercel Sandbox", "0"]);
    assert.deepEqual([...(CAPACITY_NOTE.exec("rsh_b waits for boat plan capacity (3 free)") ?? [])].slice(1), ["rsh_b", undefined, "3"]);

    // ---- accounting labels and prices ----
    assert.equal(host.providerLabel("vercel"), "Vercel Sandbox");
    assert.equal(host.providerLabel("boat"), "boat.dev (retired)", "rows from before the retirement stay readable");
    assert.equal(host.providerLabel(null), "boat.dev (retired)", "rows from before migration 0017 ran on boat.dev");
    assert.equal(host.orchSandboxCostUsd("boat", 3600), host.RETIRED_BOAT_SMALL_PER_HOUR, "old boat rows keep their estimate");
    assert.equal(host.orchSandboxCostUsd("vercel", 3600), vercelEstCostUsd("small", 3600));
    assert.ok(host.orchSandboxCostUsd("vercel", 3600) > 0.02 && host.orchSandboxCostUsd("vercel", 3600) < 0.2, "1 vCPU / 2 GB for an hour: memory plus a share of active CPU");
    // ---- OIDC scope: configured (OCTILLION_VERCEL_TEAM_ID / _PROJECT_ID) ----
    assert.ok("not_configured" in probe.vercelAuth(EVIL) && /another team or project/.test((probe.vercelAuth(EVIL) as any).not_configured), "configured scope: another project's token refused");
    assert.equal((probe.vercelAuth(MOCK_OIDC) as any).teamId, "team_smoke");
    vs.rememberCronOidcToken(EVIL);
    assert.ok("not_configured" in vs.vercelClient(), "even a cron cannot remember another project's token");

    // ---- OIDC scope: not configured, pinned by the first authenticated cron request ----
    const savedScope = { t: process.env.OCTILLION_VERCEL_TEAM_ID, p: process.env.OCTILLION_VERCEL_PROJECT_ID, o: process.env.VERCEL_OIDC_TOKEN, e: process.env.VERCEL_ENV,
      u: process.env.OCTILLION_VERCEL_SANDBOX_API_URL };
    delete process.env.OCTILLION_VERCEL_TEAM_ID; delete process.env.OCTILLION_VERCEL_PROJECT_ID; delete process.env.VERCEL_OIDC_TOKEN;
    process.env.OCTILLION_VERCEL_SANDBOX_API_URL = `${mockUrl}/vercel-sandbox`;
    probe.resetVercelScopeForTests(); vs.forgetOidcTokenForTests();
    try {
      // An outside request (no CRON_SECRET) carrying its own token: nothing remembered, nothing pinned.
      await fetch(`${base}/healthz`, { headers: { "x-vercel-oidc-token": EVIL } });
      const outside = await fetch(`${base}/api/cron/autoscale`, { headers: { "x-vercel-oidc-token": EVIL } });
      assert.equal(outside.status, 401, "the cron refuses a request without CRON_SECRET");
      assert.equal(probe.vercelScope(), null, "an outside request pins nothing");
      assert.ok("not_configured" in vs.vercelClient(), "an outside request's token is never remembered for launches");
      assert.ok("not_configured" in probe.vercelAuth(EVIL) && /no trusted Vercel team/.test((probe.vercelAuth(EVIL) as any).not_configured), "a request token alone is not trusted");
      // The cron (CRON_SECRET) pins this deployment's scope and remembers its token.
      const cron = await fetch(`${base}/api/cron/autoscale`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}`, "x-vercel-oidc-token": MOCK_OIDC } });
      assert.equal(cron.status, 200, `cron ${cron.status}`);
      assert.deepEqual(probe.vercelScope(), { teamId: "team_smoke", projectId: "prj_smoke", source: "pinned" });
      const remembered = vs.vercelClient();
      assert.ok(!("not_configured" in remembered) && remembered.teamId === "team_smoke", "the cron's token is remembered for launches");
      // Later outside requests cannot replace it, and another project's token is refused everywhere.
      await fetch(`${base}/healthz`, { headers: { "x-vercel-oidc-token": EVIL } });
      const after = vs.vercelClient();
      assert.ok(!("not_configured" in after) && after.teamId === "team_smoke", "an outside request cannot change the remembered token");
      assert.ok("not_configured" in vs.vercelClient({ oidcToken: EVIL }), "launch / reaper client: another project's token refused");
      assert.ok("not_configured" in probe.vercelDriver({ oidcToken: EVIL }), "probe: another project's token refused");
      const cfg = await (await fetch(`${base}/api/worker/sandboxes/config`, { headers: { authorization: `Bearer ${workerToken}`, "x-vercel-oidc-token": EVIL } })).json();
      assert.ok(cfg.configured === false && /another team or project/.test(cfg.reason), `broker: another project's token refused: ${JSON.stringify(cfg)}`);
      const before = mockState.vsbRequests.length;
      const reaped = await (await import("../src/worker-sandboxes.js")).reapWorkerSandboxes({ oidcToken: EVIL });
      assert.equal(mockState.vsbRequests.length, before, `reaper: no Vercel call with another project's token (${JSON.stringify(reaped)})`);
      process.env.VERCEL_OIDC_TOKEN = EVIL; vs.forgetOidcTokenForTests();
      const { Autoscaler } = await import("../src/autoscaler.js");
      assert.throws(() => new Autoscaler().host("vercel"), /another team or project/, "launch: the autoscaler refuses another project's token");
      delete process.env.VERCEL_OIDC_TOKEN;
      // A configured access token wins over any request token.
      Object.assign(process.env, { OCTILLION_VERCEL_SANDBOX_TOKEN: "vt_smoke_access", OCTILLION_VERCEL_TEAM_ID: "team_cfg", OCTILLION_VERCEL_PROJECT_ID: "prj_cfg" });
      const at = probe.vercelAuth(MOCK_OIDC) as any;
      assert.ok(at.via === "access_token" && at.teamId === "team_cfg", "a configured access token takes precedence");
      delete process.env.OCTILLION_VERCEL_SANDBOX_TOKEN; delete process.env.OCTILLION_VERCEL_TEAM_ID; delete process.env.OCTILLION_VERCEL_PROJECT_ID;
      // Production requires the configured scope.
      process.env.VERCEL_ENV = "production";
      const realError = console.error; console.error = () => {};
      try { assert.ok("not_configured" in probe.vercelAuth(MOCK_OIDC) && /production needs/.test((probe.vercelAuth(MOCK_OIDC) as any).not_configured)); }
      finally { console.error = realError; }
    } finally {
      for (const [k, v] of [["OCTILLION_VERCEL_TEAM_ID", savedScope.t], ["OCTILLION_VERCEL_PROJECT_ID", savedScope.p], ["VERCEL_OIDC_TOKEN", savedScope.o], ["VERCEL_ENV", savedScope.e],
        ["OCTILLION_VERCEL_SANDBOX_API_URL", savedScope.u]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      probe.resetVercelScopeForTests(); vs.forgetOidcTokenForTests();
    }
    console.log("smoke: vercel orchestrators OK (selection, launch + supervisor + guard, get/list/delete, guard refusal, orphans, notes, accounting, OIDC scope)");
  } finally {
    mockState.vsbExec = savedExec;
  }
}
