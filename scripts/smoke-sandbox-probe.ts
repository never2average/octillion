// Sandbox reliability probe checks for scripts/smoke.ts (src/sandbox-probe.ts), against the mock Vercel Sandbox in
// scripts/lib/mock-providers.ts: a probe starts, execs are recorded, a sandbox the provider drops or stops is "gone",
// probes are deleted after their lifetime, at most 2 live, the off switch, strays deleted, not configured without a
// token, the autoscaler's orphan reaper leaves probe sandboxes alone, old boat.dev rows are kept but not shown, and the
// admin views.
import assert from "node:assert/strict";

type Db = { query: <T = any>(sql: string, params?: unknown[]) => Promise<T[]> };

export async function sandboxProbeChecks({ db, base, mockUrl, mockState, adm, json }: {
  db: Db; base: string; mockUrl: string; mockState: any; stamp: string;
  adm: (method: string, path: string, body?: unknown) => Promise<Response>; json: (r: Response | Promise<Response>) => Promise<any>;
}) {
  const probe = await import("../src/sandbox-probe.js");
  const { orphanKind } = await import("../src/autoscaler.js");
  const { vercelHost } = await import("../orchestrator/deploy/orchestrator-host.js");
  const lib = await import("../orchestrator/deploy/orch-lib.js");
  const { workerPrefix, environmentTag } = await import("../src/worker-sandboxes.js");
  const mockPost = (path: string, body: unknown) => fetch(`${mockUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const saved = Object.fromEntries(["OCTILLION_SANDBOX_PROBE", "OCTILLION_SANDBOX_PROBE_EVERY_MINUTES", "OCTILLION_SANDBOX_PROBE_LIFETIME_MINUTES", "VERCEL_OIDC_TOKEN",
    "OCTILLION_VERCEL_SANDBOX_TOKEN", "OCTILLION_SANDBOX_PROBE_PROVIDERS"].map((k) => [k, process.env[k]]));
  for (const k of Object.keys(saved)) delete process.env[k];
  // An OIDC-shaped token (Vercel's API verifies it; the probe only reads its team and project claims).
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const oidc = `${b64({ alg: "RS256" })}.${b64({ owner_id: "team_smoke", project_id: "prj_smoke", iss: "https://oidc.vercel.com/smoke" })}.c2ln`;
  const urls = { vercelUrl: `${mockUrl}/vercel-sandbox` };
  const tick = (extra: Record<string, unknown> = {}) => probe.probeTick({ ...urls, oidcToken: oidc, budgetMs: 1500, gapMs: 50, roundMs: 300, ...extra });
  const rows = (provider = "vercel") => db.query<any>("SELECT * FROM sandbox_probes WHERE provider = $1 ORDER BY id", [provider]);
  const backdate = (mins: number, where = "TRUE") => db.query(`UPDATE sandbox_probes SET started_at = started_at - make_interval(mins => $1) WHERE ${where}`, [mins]);
  await db.query("DELETE FROM sandbox_probes");
  try {
    // ---- names: never an orchestrator, worker or image prefix, so no other reaper touches probe sandboxes ----
    const host = vercelHost({ client: {} as any, namespace: lib.SANDBOX_NAMESPACE, envTag: environmentTag() });
    for (const p of [host.orchPrefix, workerPrefix()]) assert.ok(!probe.PROBE_PREFIX.startsWith(p), `${probe.PROBE_PREFIX} is not under ${p}`);
    assert.ok(probe.PROBE_PREFIX.startsWith(`${lib.SANDBOX_NAMESPACE}-probe-`));
    const old = new Date(Date.now() - 3600_000).toISOString();
    assert.equal(orphanKind({ name: `${probe.PROBE_PREFIX}abc`, createdAt: old }, Date.now(), false, host), null, "the orphan reaper ignores a probe sandbox, however old");
    assert.equal(orphanKind({ name: `${host.orchPrefix}vabc`, createdAt: old }, Date.now(), false, host), "orchestrator", "and still reaps an orchestrator name with no row");

    // ---- off switch: nothing runs, nothing is written; the cron route needs its secret ----
    process.env.OCTILLION_SANDBOX_PROBE = "off";
    assert.deepEqual([(await tick()).enabled, (await rows()).length], [false, 0], "OCTILLION_SANDBOX_PROBE=off: no probe");
    assert.equal((await fetch(`${base}/api/cron/sandbox-probe`)).status, 401, "the probe cron needs the cron secret");
    const offCron = await (await fetch(`${base}/api/cron/sandbox-probe`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } })).json();
    assert.equal(offCron.enabled, false, "the cron route answers, off");
    delete process.env.OCTILLION_SANDBOX_PROBE;

    // ---- not configured: no Vercel token: a not_configured row, nothing created; Vercel Sandbox is the only provider ----
    const nc = await probe.probeTick({ ...urls, oidcToken: null, budgetMs: 500 });
    assert.deepEqual(Object.keys(nc.providers), ["vercel"], "only Vercel Sandbox is probed");
    assert.ok(!nc.providers.vercel!.configured && /OIDC/.test(nc.providers.vercel!.reason!), `vercel not configured: ${JSON.stringify(nc.providers.vercel)}`);
    assert.deepEqual((await rows()).map((r) => r.state), ["not_configured"]);
    assert.equal((await probe.probeTick({ ...urls, oidcToken: null, budgetMs: 500 })) && (await rows()).length, 1, "one not_configured row per start slot, not per tick");
    assert.ok("not_configured" in probe.vercelAuth("not-a-jwt"), "a token without team and project claims is not enough");
    process.env.OCTILLION_SANDBOX_PROBE_PROVIDERS = "boat,vercel";
    assert.deepEqual(probe.PROBE.providers(), ["vercel"], "an old provider list naming boat probes Vercel only");
    delete process.env.OCTILLION_SANDBOX_PROBE_PROVIDERS;
    await db.query("DELETE FROM sandbox_probes");

    // ---- a probe starts and records execs ----
    const t1 = await tick();
    assert.ok(t1.providers.vercel!.swept && t1.providers.vercel!.configured && t1.rounds >= 1, `tick 1: ${JSON.stringify(t1)}`);
    const [v1] = await rows();
    assert.ok(v1 && v1.state === "live" && v1.sandbox_id === v1.name && v1.region === "iad1" && v1.ready_ms != null, `vercel probe live: ${JSON.stringify(v1)}`);
    assert.ok(v1.name.startsWith(probe.PROBE_PREFIX) && v1.execs_ok >= 1 && v1.execs_failed === 0 && v1.exec_p50_ms != null, `execs recorded: ${JSON.stringify(v1)}`);
    const vsb = mockState.vsbSandboxes.get(v1.name);
    assert.deepEqual([vsb.vcpus, vsb.memory, vsb.persistent, vsb.timeout, vsb.projectId], [1, 2048, false, probe.PROBE_TTL_SECONDS * 1000, "prj_smoke"], "1 vCPU / 2 GB, no snapshots, a 25-minute timeout");
    const ex = await db.query<any>("SELECT kind, ok, exit_code FROM sandbox_probe_execs WHERE probe_id = $1", [v1.id]);
    assert.ok(ex.some((e) => e.kind === "check" && e.ok) && ex.some((e) => e.kind === "exec" && e.ok && e.exit_code === 0), "a check and an exec per round");
    // A failing exec is recorded with its error, and does not make the probe gone; the listing is not swept every tick.
    await mockPost("/_mock/vercel/fail", { kind: "exec", n: 1 });
    const lists = () => mockState.vsbRequests.filter((r: string) => r === "GET /v2/sandboxes").length, listsBefore = lists();
    const t2 = await tick();
    assert.equal(t2.providers.vercel!.started ?? null, null, "no second probe inside the 30-minute interval");
    assert.ok(!t2.providers.vercel!.swept && lists() === listsBefore, "the listing is swept at most every 15 minutes, not every tick");
    const [v2] = await rows();
    assert.ok(v2.state === "live" && v2.execs_failed === 1 && /502/.test(v2.last_error), `a failed exec: ${JSON.stringify(v2)}`);

    // ---- gone: the provider stops the sandbox before we delete it ----
    await mockPost("/_mock/vercel/drop", { name: v1.name });
    const t3 = await tick();
    assert.equal(t3.providers.vercel!.gone, 1, `gone: ${JSON.stringify(t3.providers)}`);
    const [v3] = await rows();
    assert.ok(v3.state === "gone" && v3.gone_at && /stopped/.test(v3.gone_reason), `gone (stopped early): ${JSON.stringify(v3)}`);
    await tick(); // the next tick cleans up what is left of a gone probe
    const [v4] = await rows();
    assert.ok(v4.state === "gone" && v4.delete_ms != null && !mockState.vsbSandboxes.has(v1.name), "a stopped probe is deleted, and stays 'gone'");

    // ---- delete after the lifetime; the next one starts (after the 30-minute interval) ----
    await backdate(31);
    await tick();
    const live = (await rows()).filter((r) => r.state === "live");
    assert.equal(live.length, 1, "a new probe once the interval passed");
    await backdate(31, "state = 'live'");
    // A failed stray sweep (the listing answers 502) never skips the tick's ends and starts; a failed delete is retried.
    await db.query("DELETE FROM sandbox_probe_meta");
    await mockPost("/_mock/vercel/fail", { kind: "list", n: 1 });
    await mockPost("/_mock/vercel/fail", { kind: "delete", n: 1 });
    const te = await tick();
    assert.match(te.providers.vercel!.sweep_error ?? "", /502/, "the sweep failed");
    const [eb] = await db.query<any>("SELECT * FROM sandbox_probes WHERE id = $1", [live[0]!.id]);
    assert.ok(eb.state === "delete_failed" && !eb.deleted_at && /502/.test(eb.delete_error) && mockState.vsbSandboxes.has(eb.name), `a failed delete is not "deleted": ${JSON.stringify(eb)}`);
    assert.equal((await rows()).filter((r) => r.state === "live").length, 1, "and the next probe is live, sweep or no sweep");
    const failedNow = (await json(adm("GET", "/compute/probes?hours=24"))).providers.find((p: any) => p.provider === "vercel");
    assert.ok(failedNow.delete_failed === 1 && failedNow.survived === 0, `a probe whose delete failed does not count as survived: ${JSON.stringify(failedNow)}`);
    await tick();
    const [eb2] = await db.query<any>("SELECT * FROM sandbox_probes WHERE id = $1", [eb.id]);
    assert.ok(eb2.state === "deleted" && eb2.deleted_at && !eb2.delete_error && !mockState.vsbSandboxes.has(eb.name), `retried on the next tick: ${JSON.stringify(eb2)}`);
    const delRows = await db.query<any>("SELECT ok FROM sandbox_probe_execs WHERE probe_id = $1 AND kind = 'delete' ORDER BY at", [eb.id]);
    assert.deepEqual(delRows.map((r) => r.ok), [false, true], "both delete attempts recorded");

    // ---- at most 2 live ----
    process.env.OCTILLION_SANDBOX_PROBE_LIFETIME_MINUTES = "60";
    const cap = `${probe.PROBE_PREFIX}cap${(await import("node:crypto")).randomBytes(3).toString("hex")}`;
    mockState.vsbSandboxes.set(cap, { name: cap, status: "running", session: `sbx_${cap}`, createdAt: Date.now(), region: "iad1", projectId: "prj_smoke" });
    await db.query("INSERT INTO sandbox_probes (provider, sandbox_id, name, state, region, started_at) VALUES ('vercel', $1, $1, 'live', 'iad1', now() - interval '5 minutes')", [cap]);
    await backdate(35);
    const before = (await rows()).length;
    const tc = await tick();
    assert.equal(tc.providers.vercel!.started ?? null, null, "a start is due, but 2 are live: none starts");
    assert.equal((await rows()).length, before, "no new row");
    // ---- expiry is not an early drop: a probe found gone within 2 minutes of its 25-minute TTL (its end was missed) ----
    const nearTtl = (await rows()).find((r) => r.state === "live" && r.sandbox_id !== cap);
    mockState.vsbSandboxes.delete(nearTtl.sandbox_id);
    await tick();
    const [ex1] = await db.query<any>("SELECT * FROM sandbox_probes WHERE id = $1", [nearTtl.id]);
    assert.ok(ex1.state === "expired" && !ex1.gone_at && /expired/.test(ex1.last_error), `expired, not gone: ${JSON.stringify(ex1)}`);
    await db.query("UPDATE sandbox_probes SET state = 'deleted', deleted_at = now() WHERE sandbox_id = $1", [cap]);
    mockState.vsbSandboxes.delete(cap);
    delete process.env.OCTILLION_SANDBOX_PROBE_LIFETIME_MINUTES;

    // ---- strays: a probe sandbox over 30 minutes old with no row is deleted; a young one is kept; a failed create is recorded ----
    const stray = `${probe.PROBE_PREFIX}stray`, young = `${probe.PROBE_PREFIX}young`;
    mockState.vsbSandboxes.set(stray, { name: stray, status: "running", session: "sbx_stray", createdAt: Date.now() - 40 * 60_000, region: "iad1", projectId: "prj_smoke" });
    mockState.vsbSandboxes.set(young, { name: young, status: "running", session: "sbx_young", createdAt: Date.now(), region: "iad1", projectId: "prj_smoke" });
    await backdate(31);
    await db.query("DELETE FROM sandbox_probe_meta"); // the sweep is due again
    await mockPost("/_mock/vercel/fail", { kind: "create", n: 1 });
    const ts = await tick();
    assert.ok(ts.providers.vercel!.strays === 1 && !mockState.vsbSandboxes.has(stray) && mockState.vsbSandboxes.has(young), `stray deleted, a young one kept: ${JSON.stringify(ts.providers.vercel)}`);
    const vf = (await rows()).at(-1);
    assert.ok(vf.state === "failed" && /502/.test(vf.create_error), `a failed create: ${JSON.stringify(vf)}`);
    mockState.vsbSandboxes.delete(young);

    // ---- history: rows of the retired boat.dev stay in the table but are not shown ----
    const [{ id: boatId }] = await db.query<any>("INSERT INTO sandbox_probes (provider, sandbox_id, name, state, started_at) VALUES ('boat', 'bx_old', 'octi-probe-old', 'deleted', now() - interval '2 hours') RETURNING id");
    // One still open when the deploy came: closed as expired (never called again, it stopped at its TTL), so it can be pruned.
    const [{ id: openId }] = await db.query<any>("INSERT INTO sandbox_probes (provider, sandbox_id, name, state, started_at) VALUES ('boat', 'bx_open', 'octi-probe-open', 'live', now() - interval '10 minutes') RETURNING id");
    await tick();
    const [openRow] = await db.query<any>("SELECT state, last_error FROM sandbox_probes WHERE id = $1", [openId]);
    assert.ok(openRow.state === "expired" && /provider retired/.test(openRow.last_error), `an open boat probe is closed: ${JSON.stringify(openRow)}`);

    // ---- what the admin sees: the summary, the table and a probe's peek ----
    const list = await json(adm("GET", "/compute/probes?hours=24"));
    assert.deepEqual(list.providers.map((p: any) => p.provider), ["vercel"], "the summary is Vercel Sandbox only");
    const vs = list.providers[0];
    assert.ok(vs.configured && vs.started >= 4 && vs.gone_early === 1 && vs.gone_median_age_s != null && vs.exec_ok_pct > 0 && vs.exec_ok_pct < 100
      && vs.create_ok_pct < 100 && vs.delete_ok_pct > 0 && vs.delete_ok_pct < 100 && vs.survived >= 1, `vercel summary: ${JSON.stringify(vs)}`);
    assert.ok(list.cost.probes_per_day === 48 && list.cost.vercel_usd_day > 0 && list.cost.total_usd_day === list.cost.vercel_usd_day && !("boat_usd_day" in list.cost), `cost: ${JSON.stringify(list.cost)}`);
    assert.ok(list.rows.length >= 5 && list.rows.every((r: any) => r.provider === "vercel" && r.state), "one row per probe, Vercel's only");
    assert.ok(!list.rows.some((r: any) => r.id === boatId), "an old boat row is not listed");
    assert.equal((await json(adm("GET", `/compute/probes/${boatId}`))).row.provider, "boat", "but stays readable by its id");
    const peek = await json(adm("GET", `/compute/probes/${v1.id}`));
    assert.ok(peek.row.id === v1.id && peek.execs.length >= 4 && peek.errors.some((e: any) => e.step === "exec") && peek.errors.some((e: any) => e.step === "gone"), `peek: ${JSON.stringify(peek.errors)}`);
    assert.equal((await adm("GET", "/compute/probes/999999999")).status, 404);
    assert.equal((await adm("GET", "/compute/probes/abc")).status, 400, "a non-numeric id is a 400, not a 500");
    const sum = await json(adm("GET", "/compute/summary"));
    assert.ok(sum.limits.our_starts.day >= 4, `probe starts count in Compute's starts: ${JSON.stringify(sum.limits.our_starts)}`);

    // ---- retention: 14 days ----
    const [{ id: oldId }] = await db.query<any>("INSERT INTO sandbox_probes (provider, state, started_at) VALUES ('vercel', 'deleted', now() - interval '15 days') RETURNING id");
    await db.query("INSERT INTO sandbox_probe_execs (probe_id, kind, ok, at) VALUES ($1, 'exec', true, now() - interval '15 days')", [oldId]);
    const pr = await probe.pruneProbes();
    assert.ok(pr.probes === 1 && pr.execs === 1, `pruned: ${JSON.stringify(pr)}`);
    console.log("✓ sandbox probe (Vercel Sandbox): start, execs, gone detection, delete after the lifetime, 2-live cap, off switch, strays (throttled, failure-isolated), failed deletes retried, expiry vs gone, not configured, orphan reaper ignores probes, old boat rows hidden, summary and peek, retention");
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v == null) delete process.env[k]; else process.env[k] = v;
    await db.query("DELETE FROM sandbox_probes");
    await db.query("DELETE FROM sandbox_probe_meta");
  }
}
