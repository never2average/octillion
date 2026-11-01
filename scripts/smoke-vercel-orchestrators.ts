// Orchestrators on Vercel Sandbox, for scripts/smoke.ts (orchestrator/deploy/orchestrator-host.ts, vercel-orch.ts), against
// the mock Vercel Sandbox in scripts/lib/mock-providers.ts scripted as an orchestrator VM (orchestrator/test/vercel-orch-mock.ts):
// which provider is selected; a launch with the supervisor that the real host guard accepts inside the sandbox, with no
// Vercel credential in it; get by id (live, then gone) and the listing; the orphan rules per provider (never a worker or a
// probe); the capacity note old and new; accounting labels and prices. The autoscaler around it: orchestrator/test/per-job.ts.
import assert from "node:assert/strict";

type Db = { query: <T = any>(sql: string, params?: unknown[]) => Promise<T[]> };

export async function vercelOrchestratorChecks({ mockUrl, mockState }: { db: Db; mockUrl: string; mockState: any }) {
  const host = await import("../orchestrator/deploy/orchestrator-host.js");
  const { vercelClient } = await import("../src/vercel-sandbox.js");
  const { orphanKind, capacityNote, CAPACITY_NOTE } = await import("../src/autoscaler.js");
  const { installOrchestratorVm, MOCK_OIDC } = await import("../orchestrator/test/vercel-orch-mock.js");
  const { BOAT_PRICE_PER_HOUR, vercelEstCostUsd } = await import("../orchestrator/core/config.js");
  const savedExec = mockState.vsbExec;
  try {
    // ---- selection: one switch, an orchestrator-only override, boat by default ----
    assert.equal(host.orchestratorProvider({}), "boat");
    assert.equal(host.orchestratorProvider({ OCTILLION_SANDBOX_PROVIDER: "vercel" }), "vercel");
    assert.equal(host.orchestratorProvider({ OCTILLION_SANDBOX_PROVIDER: "vercel", OCTILLION_ORCHESTRATOR_PROVIDER: "boat" }), "boat");
    assert.equal(host.orchestratorProvider({ OCTILLION_ORCHESTRATOR_PROVIDER: "vercel" }), "vercel");
    assert.equal(host.workerProvider({ OCTILLION_ORCHESTRATOR_PROVIDER: "vercel" }), "boat", "the override moves orchestrators only");

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
    assert.ok(r.expiresAt && Math.abs(r.expiresAt - Date.now() - 1440 * 60_000) < 60_000, "expires at the 24 h timeout");
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

    // ---- orphans per provider: our orchestrators and stale image builders only ----
    const old = new Date(Date.now() - 31 * 60_000).toISOString();
    assert.equal(orphanKind({ name: "octs-vo-smoke-v0123456789" }, Date.now(), false, h), "orchestrator");
    assert.equal(orphanKind({ name: "octs-vw-smoke-sess-1" }, Date.now(), false, h), null, "a Vercel worker belongs to the broker's reaper");
    assert.equal(orphanKind({ name: "octs-vo-prod-v0123456789" }, Date.now(), false, h), null, "another environment's orchestrator is not ours");
    assert.equal(orphanKind({ name: "octs-vimg-smoke-0123456789abcdef", createdAt: old }, Date.now(), false, h), "image_builder");
    assert.equal(orphanKind({ name: "octs-vimg-smoke-0123456789abcdef", createdAt: old }, Date.now(), true, h), null, "not while a build runs");

    // ---- the capacity note, old boat wording and new ----
    const note = capacityNote("sim_a", "vercel", -2);
    assert.equal(note, "sim_a waits for sandbox capacity on Vercel Sandbox (0 free)");
    assert.deepEqual([...(CAPACITY_NOTE.exec(note) ?? [])].slice(1), ["sim_a", "Vercel Sandbox", "0"]);
    assert.deepEqual([...(CAPACITY_NOTE.exec("rsh_b waits for boat plan capacity (3 free)") ?? [])].slice(1), ["rsh_b", undefined, "3"]);

    // ---- accounting labels and prices ----
    assert.equal(host.providerLabel("vercel"), "Vercel Sandbox");
    assert.equal(host.providerLabel("boat"), "boat.dev");
    assert.equal(host.providerLabel(null), "boat.dev", "rows from before migration 0017 are boat");
    assert.equal(host.orchSandboxCostUsd("boat", 3600), BOAT_PRICE_PER_HOUR.small);
    assert.equal(host.orchSandboxCostUsd("vercel", 3600), vercelEstCostUsd("small", 3600));
    assert.ok(host.orchSandboxCostUsd("vercel", 3600) > 0.02 && host.orchSandboxCostUsd("vercel", 3600) < 0.2, "1 vCPU / 2 GB for an hour: memory plus a share of active CPU");
    console.log("smoke: vercel orchestrators OK (selection, launch + supervisor + guard, get/list/delete, guard refusal, orphans, notes, accounting)");
  } finally {
    mockState.vsbExec = savedExec;
  }
}
