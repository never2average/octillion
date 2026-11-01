// Sandbox reliability probe checks for scripts/smoke.ts (src/sandbox-probe.ts), against the mock boat.dev and Vercel
// Sandbox in scripts/lib/mock-providers.ts: a probe pair starts, execs are recorded, a sandbox the provider drops is
// "gone", probes are deleted after their lifetime, at most 2 live per provider, the off switch, strays deleted, Vercel
// not configured without a token, the autoscaler's orphan reaper leaves probe sandboxes alone, and the admin views.
import assert from "node:assert/strict";

type Db = { query: <T = any>(sql: string, params?: unknown[]) => Promise<T[]> };

export async function sandboxProbeChecks({ db, base, mockUrl, mockState, adm, json, stamp }: {
  db: Db; base: string; mockUrl: string; mockState: any; stamp: string;
  adm: (method: string, path: string, body?: unknown) => Promise<Response>; json: (r: Response | Promise<Response>) => Promise<any>;
}) {
  const probe = await import("../src/sandbox-probe.js");
  const { orphanKind } = await import("../src/autoscaler.js");
  const lib = await import("../orchestrator/deploy/boat-lib.js");
  const { classifySandboxNames } = await import("../src/compute.js");
  const { unmatchedSandboxes } = await import("../src/compute-records.js");
  const kv = await import("../src/keyvault.js");
  const mockPost = (path: string, body: unknown) => fetch(`${mockUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const saved = Object.fromEntries(["OCTILLION_SANDBOX_PROBE", "OCTILLION_SANDBOX_PROBE_EVERY_MINUTES", "OCTILLION_SANDBOX_PROBE_LIFETIME_MINUTES", "VERCEL_OIDC_TOKEN",
    "OCTILLION_VERCEL_SANDBOX_TOKEN", "OCTILLION_SANDBOX_PROBE_PROVIDERS"].map((k) => [k, process.env[k]]));
  for (const k of Object.keys(saved)) delete process.env[k];
  // An OIDC-shaped token (Vercel's API verifies it; the probe only reads its team and project claims).
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const oidc = `${b64({ alg: "RS256" })}.${b64({ owner_id: "team_smoke", project_id: "prj_smoke", iss: "https://oidc.vercel.com/smoke" })}.c2ln`;
  const urls = { boatUrl: `${mockUrl}/boat/api/v1`, vercelUrl: `${mockUrl}/vercel-sandbox` };
  const tick = (extra: Record<string, unknown> = {}) => probe.probeTick({ ...urls, oidcToken: oidc, budgetMs: 1500, gapMs: 50, roundMs: 300, ...extra });
  const rows = (provider?: string) => db.query<any>(`SELECT * FROM sandbox_probes ${provider ? "WHERE provider = $1" : ""} ORDER BY id`, provider ? [provider] : []);
  const backdate = (mins: number, where = "TRUE") => db.query(`UPDATE sandbox_probes SET started_at = started_at - make_interval(mins => $1) WHERE ${where}`, [mins]);
  await db.query("DELETE FROM sandbox_probes");
  let boatKey: { id: number } | null = null, boatKey2: { id: number } | null = null;
  const key1 = `boat_smoke_${stamp}_key`, key2 = `boat_smoke_${stamp}_key2`;
  try {
    // ---- names: never an autoscaler prefix, so its orphan reaper leaves probe sandboxes alone ----
    for (const p of [lib.ORCH_PREFIX, lib.WORKER_PREFIX, lib.IMAGE_PREFIX]) assert.ok(!probe.PROBE_PREFIX.startsWith(p), `${probe.PROBE_PREFIX} is not under ${p}`);
    assert.notEqual(probe.PROBE_PREFIX.slice(0, -1), lib.IMAGE_BUILDER_NAME);
    const old = new Date(Date.now() - 3600_000).toISOString();
    assert.equal(orphanKind({ name: `${probe.PROBE_PREFIX}abc`, createdAt: old }, Date.now(), false), null, "the orphan reaper ignores a probe sandbox, however old");
    assert.equal(orphanKind({ name: `${lib.ORCH_PREFIX}abc`, createdAt: old }, Date.now(), false), "orchestrator", "and still reaps an orchestrator name with no row");
    assert.equal(orphanKind({ name: lib.IMAGE_BUILDER_NAME, createdAt: old }, Date.now(), false), "image_builder");
    const cls = classifySandboxNames([{ id: "bx_p", name: `${lib.BOAT_NAMESPACE}-probe-x`, state: "ready" }], lib.BOAT_NAMESPACE);
    assert.equal(cls[0]!.kind, "probe", "the Compute page counts probe sandboxes as ours, not another deployment's");
    assert.deepEqual(unmatchedSandboxes(cls, []), [], "and never lists them as unmatched on boat");

    // ---- off switch: nothing runs, nothing is written; the cron route needs its secret ----
    process.env.OCTILLION_SANDBOX_PROBE = "off";
    assert.deepEqual([(await tick()).enabled, (await rows()).length], [false, 0], "OCTILLION_SANDBOX_PROBE=off: no probe");
    assert.equal((await fetch(`${base}/api/cron/sandbox-probe`)).status, 401, "the probe cron needs the cron secret");
    const offCron = await (await fetch(`${base}/api/cron/sandbox-probe`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } })).json();
    assert.equal(offCron.enabled, false, "the cron route answers, off");
    delete process.env.OCTILLION_SANDBOX_PROBE;

    // ---- not configured: no boat key, no Vercel token: a not_configured row each, nothing created ----
    const nc = await probe.probeTick({ ...urls, oidcToken: null, budgetMs: 500 });
    assert.ok(!nc.providers.vercel!.configured && /OIDC/.test(nc.providers.vercel!.reason!), `vercel not configured: ${JSON.stringify(nc.providers.vercel)}`);
    assert.ok(!nc.providers.boat!.configured && /boat key/.test(nc.providers.boat!.reason!), "boat not configured without a vault key");
    assert.deepEqual((await rows()).map((r) => [r.provider, r.state]), [["boat", "not_configured"], ["vercel", "not_configured"]]);
    assert.equal((await probe.probeTick({ ...urls, oidcToken: null, budgetMs: 500 })) && (await rows()).length, 2, "one not_configured row per start slot, not per tick");
    assert.ok("not_configured" in probe.vercelAuth("not-a-jwt"), "a token without team and project claims is not enough");
    await db.query("DELETE FROM sandbox_probes");

    // ---- a probe pair starts and records execs ----
    // Two boat keys (two accounts in the mock: a sandbox answers only the key that made it). The vault hands them out in
    // turn, so probes are made with both; every later call about a probe must use the key that made it.
    boatKey = await kv.addCredential("boat", key1);
    boatKey2 = await kv.addCredential("boat", key2);
    const t1 = await tick();
    assert.ok(t1.providers.boat!.swept && t1.providers.vercel!.swept, "the first tick sweeps for strays");
    assert.ok(t1.providers.boat!.configured && t1.providers.vercel!.configured && t1.rounds >= 1, `tick 1: ${JSON.stringify(t1)}`);
    const [b1] = await rows("boat"), [v1] = await rows("vercel");
    assert.ok(b1 && b1.state === "live" && b1.sandbox_id?.startsWith("bx_") && b1.create_ms != null && b1.ready_ms != null, `boat probe live: ${JSON.stringify(b1)}`);
    assert.ok(v1 && v1.state === "live" && v1.sandbox_id === v1.name && v1.region === "iad1" && v1.ready_ms != null, `vercel probe live: ${JSON.stringify(v1)}`);
    for (const r of [b1, v1]) assert.ok(r.name.startsWith(probe.PROBE_PREFIX) && r.execs_ok >= 1 && r.execs_failed === 0 && r.exec_p50_ms != null, `execs recorded: ${JSON.stringify(r)}`);
    assert.ok([boatKey.id, boatKey2.id].includes(b1.credential_id), "the boat probe records the key that made it");
    const bsb = mockState.boatSandboxes.get(b1.sandbox_id), vsb = mockState.vsbSandboxes.get(v1.name);
    const other = bsb.owner === key1 ? key2 : key1;
    assert.equal((await fetch(`${mockUrl}/boat/api/v1/sandboxes/${b1.sandbox_id}`, { headers: { authorization: `Bearer ${other}` } })).status, 404, "the other key does not see it");
    assert.deepEqual([bsb.name, bsb.type, bsb.ttlSeconds], [b1.name, "small", probe.PROBE_TTL_SECONDS], "boat: small, named, a 25-minute TTL");
    assert.deepEqual([vsb.vcpus, vsb.memory, vsb.persistent, vsb.timeout, vsb.projectId], [1, 2048, false, probe.PROBE_TTL_SECONDS * 1000, "prj_smoke"], "vercel: 1 vCPU / 2 GB, no snapshots, a 25-minute timeout");
    assert.ok(mockState.vsbRequests.length && mockState.boatRequests.some((r: string) => r === `POST /sandboxes/${b1.sandbox_id}/commands`), "both providers were exec'd");
    const ex = await db.query<any>("SELECT kind, ok, exit_code FROM sandbox_probe_execs WHERE probe_id = $1", [b1.id]);
    assert.ok(ex.some((e) => e.kind === "check" && e.ok) && ex.some((e) => e.kind === "exec" && e.ok && e.exit_code === 0), "a check and an exec per round");
    // A failing exec is recorded with its error, and does not make the probe gone.
    await mockPost("/_mock/boat/fail", { kind: "exec", n: 1 });
    const lists = () => mockState.boatRequests.filter((r: string) => r === "GET /sandboxes").length, listsBefore = lists();
    const t2 = await tick();
    assert.equal(t2.providers.boat!.started ?? null, null, "no second probe inside the 30-minute interval");
    assert.ok(!t2.providers.boat!.swept && lists() === listsBefore, "boat's listing is swept at most every 15 minutes, not every tick");
    const [b2] = await rows("boat");
    assert.ok(b2.state === "live" && b2.execs_failed === 1 && /502/.test(b2.last_error), `a failed exec: ${JSON.stringify(b2)}`);

    // ---- gone: the provider drops the sandbox before we delete it ----
    await mockPost("/_mock/boat/drop", { id: b1.sandbox_id });
    await mockPost("/_mock/vercel/drop", { name: v1.name });
    const t3 = await tick();
    assert.ok(t3.providers.boat!.gone === 1 && t3.providers.vercel!.gone === 1, `both gone: ${JSON.stringify(t3.providers)}`);
    const [b3] = await rows("boat"), [v3] = await rows("vercel");
    assert.ok(b3.state === "gone" && b3.gone_at && /not found/.test(b3.gone_reason), `boat gone: ${JSON.stringify(b3)}`);
    assert.ok(v3.state === "gone" && v3.gone_at && /stopped/.test(v3.gone_reason), `vercel gone (stopped early): ${JSON.stringify(v3)}`);
    await tick(); // the next tick cleans up what is left of a gone probe
    const [v4] = await rows("vercel");
    assert.ok(v4.state === "gone" && v4.delete_ms != null && !mockState.vsbSandboxes.has(v1.name), "a stopped Vercel probe is deleted, and stays 'gone'");

    // ---- delete after the lifetime; the next pair starts (after the 30-minute interval) ----
    await backdate(31);
    await tick();
    const live = (await rows()).filter((r) => r.state === "live");
    assert.equal(live.length, 2, "a new pair once the interval passed");
    await backdate(31, "state = 'live'");
    // A failed stray sweep (boat's listing answers 502) never skips the tick's ends and starts; a failed delete is retried.
    await db.query("DELETE FROM sandbox_probe_meta");
    await mockPost("/_mock/boat/fail", { kind: "list", n: 1 });
    await mockPost("/_mock/boat/fail", { kind: "delete", n: 1 });
    const te = await tick();
    assert.match(te.providers.boat!.sweep_error ?? "", /502/, "the sweep failed");
    const ended = await db.query<any>("SELECT * FROM sandbox_probes WHERE id = ANY($1) ORDER BY provider", [live.map((r) => r.id)]);
    const [eb, ev] = ended;
    assert.ok(ev.state === "deleted" && ev.deleted_at && ev.delete_ms != null && !ev.delete_error && !ev.gone_at && !mockState.vsbSandboxes.has(ev.name), `vercel deleted after 15 minutes: ${JSON.stringify(ev)}`);
    assert.ok(eb.state === "delete_failed" && !eb.deleted_at && /502/.test(eb.delete_error) && mockState.boatSandboxes.has(eb.sandbox_id), `a failed delete is not "deleted": ${JSON.stringify(eb)}`);
    assert.equal((await rows()).filter((r) => r.state === "live").length, 2, "and the next pair is live, sweep or no sweep");
    const survivedNow = (await json(adm("GET", "/compute/probes?hours=24"))).providers.find((p: any) => p.provider === "boat");
    assert.ok(survivedNow.delete_failed === 1 && survivedNow.survived === 0, `a probe whose delete failed does not count as survived: ${JSON.stringify(survivedNow)}`);
    await tick();
    const [eb2] = await db.query<any>("SELECT * FROM sandbox_probes WHERE id = $1", [eb.id]);
    assert.ok(eb2.state === "deleted" && eb2.deleted_at && !eb2.delete_error && !mockState.boatSandboxes.has(eb.sandbox_id), `retried on the next tick: ${JSON.stringify(eb2)}`);
    const delRows = await db.query<any>("SELECT ok FROM sandbox_probe_execs WHERE probe_id = $1 AND kind = 'delete' ORDER BY at", [eb.id]);
    assert.deepEqual(delRows.map((r) => r.ok), [false, true], "both delete attempts recorded");

    // ---- at most 2 live per provider ----
    process.env.OCTILLION_SANDBOX_PROBE_LIFETIME_MINUTES = "60";
    process.env.OCTILLION_SANDBOX_PROBE_PROVIDERS = "boat";
    const sb = (await import("node:crypto")).randomBytes(3).toString("hex");
    mockState.boatSandboxes.set(`bx_cap${sb}`, { id: `bx_cap${sb}`, name: `${probe.PROBE_PREFIX}cap${sb}`, state: "ready", owner: key1, createdAt: new Date().toISOString() });
    await db.query("INSERT INTO sandbox_probes (provider, sandbox_id, name, state, started_at, credential_id) VALUES ('boat', $1, $2, 'live', now() - interval '5 minutes', $3)",
      [`bx_cap${sb}`, `${probe.PROBE_PREFIX}cap${sb}`, boatKey.id]);
    await backdate(35, "provider = 'boat'");
    const before = (await rows("boat")).length;
    const tc = await tick();
    assert.equal(tc.providers.boat!.started ?? null, null, "a start is due, but 2 are live: none starts");
    assert.equal((await rows("boat")).length, before, "no new boat row");
    // ---- expiry is not an early drop: a probe found gone within 2 minutes of its 25-minute TTL (its end was missed) ----
    const nearTtl = (await rows("boat")).find((r) => r.state === "live" && r.sandbox_id !== `bx_cap${sb}`);
    await mockPost("/_mock/boat/drop", { id: nearTtl.sandbox_id });
    await tick();
    const [ex1] = await db.query<any>("SELECT * FROM sandbox_probes WHERE id = $1", [nearTtl.id]);
    assert.ok(ex1.state === "expired" && !ex1.gone_at && /expired/.test(ex1.last_error), `expired, not gone: ${JSON.stringify(ex1)}`);
    // ---- boat's daily start budget: no boat probe while fewer than 15% (at least 20) of the day's starts are left ----
    assert.equal(probe.startBudgetNote(200, 100), null);
    assert.match(probe.startBudgetNote(200, 171) ?? "", /171 of 200 starts in 24 h, keeping 30/);
    assert.match(probe.startBudgetNote(50, 31) ?? "", /keeping 20/, "at least 20 kept on a small plan");
    await db.query("UPDATE sandbox_probes SET state = 'deleted', deleted_at = now() WHERE sandbox_id = $1", [`bx_cap${sb}`]);
    mockState.boatSandboxes.delete(`bx_cap${sb}`);
    mockState.boatStartsPerDay = 21; // our boat starts today (the probes above) leave fewer than 20
    const nb = (await rows("boat")).length;
    const tb = await tick();
    assert.ok(tb.providers.boat!.started == null && /start budget nearly used/.test(tb.providers.boat!.skipped ?? ""), `skipped on budget: ${JSON.stringify(tb.providers.boat)}`);
    assert.equal((await rows("boat")).length, nb, "no boat probe row: the start was not taken");
    mockState.boatStartsPerDay = 200;
    delete process.env.OCTILLION_SANDBOX_PROBE_LIFETIME_MINUTES;
    delete process.env.OCTILLION_SANDBOX_PROBE_PROVIDERS;

    // ---- strays: a probe sandbox over 30 minutes old with no row is deleted; a failed create is recorded ----
    mockState.boatSandboxes.set("bx_stray1", { id: "bx_stray1", name: `${probe.PROBE_PREFIX}stray`, state: "ready", createdAt: new Date(Date.now() - 40 * 60_000).toISOString() });
    mockState.boatSandboxes.set("bx_young1", { id: "bx_young1", name: `${probe.PROBE_PREFIX}young`, state: "ready", owner: key2, createdAt: new Date().toISOString() });
    await backdate(31, "provider = 'vercel'");
    await db.query("DELETE FROM sandbox_probe_meta"); // the sweep is due again
    mockState.boatSandboxes.get("bx_stray1").owner = key1;
    await mockPost("/_mock/vercel/fail", { kind: "create", n: 1 });
    const ts = await tick();
    assert.ok(ts.providers.boat!.strays === 1 && !mockState.boatSandboxes.has("bx_stray1") && mockState.boatSandboxes.has("bx_young1"), `stray deleted, a young one kept: ${JSON.stringify(ts.providers.boat)}`);
    const vf = (await rows("vercel")).at(-1);
    assert.ok(vf.state === "failed" && /502/.test(vf.create_error), `a failed create: ${JSON.stringify(vf)}`);
    mockState.boatSandboxes.delete("bx_young1");

    // ---- what the admin sees: the summary, the table and a probe's peek; the admin MCP tool ----
    const list = await json(adm("GET", "/compute/probes?hours=24"));
    const bs = list.providers.find((p: any) => p.provider === "boat"), vs = list.providers.find((p: any) => p.provider === "vercel");
    assert.ok(bs.configured && bs.started >= 4 && bs.gone_early === 1 && bs.gone_median_age_s != null && bs.exec_ok_pct > 0 && bs.exec_ok_pct < 100
      && bs.delete_ok_pct > 0 && bs.delete_ok_pct < 100 && bs.delete_failed === 0 && bs.survived >= 1,
      `boat summary: ${JSON.stringify(bs)}`);
    assert.ok(vs.started >= 3 && vs.create_ok_pct < 100 && vs.survived >= 1 && vs.survived_pct > 0, `vercel summary: ${JSON.stringify(vs)}`);
    assert.ok(list.cost.probes_per_day === 48 && list.cost.boat_usd_day > 0 && list.cost.vercel_usd_day > 0, `cost: ${JSON.stringify(list.cost)}`);
    assert.ok(list.rows.length >= 7 && list.rows.every((r: any) => r.provider && r.state), "one row per probe");
    const peek = await json(adm("GET", `/compute/probes/${b1.id}`));
    assert.ok(peek.row.id === b1.id && peek.execs.length >= 4 && peek.errors.some((e: any) => e.step === "exec") && peek.errors.some((e: any) => e.step === "gone"), `peek: ${JSON.stringify(peek.errors)}`);
    assert.equal((await adm("GET", "/compute/probes/999999999")).status, 404);
    assert.equal((await adm("GET", "/compute/probes/abc")).status, 400, "a non-numeric id is a 400, not a 500");
    const creds = new Set((await rows("boat")).filter((r) => r.sandbox_id && r.credential_id != null).map((r) => r.credential_id));
    assert.ok(creds.size === 2, `probes were made with both boat keys, and each was followed with its own: ${[...creds]}`);
    // Without a boat key the Compute summary never calls boat (BOAT.apiUrl is the real one); its start counts are ours.
    for (const k of [boatKey!, boatKey2!]) await kv.deleteCredential(k.id);
    boatKey = boatKey2 = null;
    const sum = await json(adm("GET", "/compute/summary"));
    assert.ok(sum.limits.our_starts.day >= creds.size, `probe starts count in Compute's starts: ${JSON.stringify(sum.limits.our_starts)}`);

    // ---- retention: 14 days ----
    const [{ id: oldId }] = await db.query<any>("INSERT INTO sandbox_probes (provider, state, started_at) VALUES ('boat', 'deleted', now() - interval '15 days') RETURNING id");
    await db.query("INSERT INTO sandbox_probe_execs (probe_id, kind, ok, at) VALUES ($1, 'exec', true, now() - interval '15 days')", [oldId]);
    const pr = await probe.pruneProbes();
    assert.ok(pr.probes === 1 && pr.execs === 1, `pruned: ${JSON.stringify(pr)}`);
    console.log("✓ sandbox probe: pair start, execs, gone detection, delete after the lifetime, 2-live cap, off switch, strays (throttled, failure-isolated), failed deletes retried, expiry vs gone, per-probe boat key, not configured, orphan reaper ignores probes, summary and peek, retention");
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v == null) delete process.env[k]; else process.env[k] = v;
    for (const k of [boatKey, boatKey2]) if (k) await kv.deleteCredential(k.id).catch(() => {});
    await db.query("DELETE FROM sandbox_probes");
    await db.query("DELETE FROM sandbox_probe_meta");
  }
}
