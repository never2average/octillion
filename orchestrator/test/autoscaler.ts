/**
 * Hermetic test of the server's on-demand orchestrator autoscaler (src/autoscaler.ts): real server modules on a
 * temp PGlite + a mock Vercel Sandbox scripted as an orchestrator VM (vercel-orch-mock.ts). Covers: kill switch; no
 * demand -> nothing; queued work -> exactly one launch even with two autoscaler instances (lease); the snapshot image
 * built once, then used for launches; the cap; idle -> drain -> sandbox deleted (+ cooldown, no relaunch loop); stale,
 * exited and stuck-booting orchestrators reaped with the right reason; orphans deleted; recycle on deploy; a leftover
 * row of the retired boat.dev closed without a provider call; a setting naming boat is a clear tick error.
 *
 *   npx tsx orchestrator/test/autoscaler.ts
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "octillion-astest-"));
Object.assign(process.env, {
  PGLITE_DIR: path.join(tmp, "pglite"), OCTILLION_VAULT_KEY: randomBytes(32).toString("base64"), OCTILLION_WORKER_TOKEN: `wt_${randomBytes(8).toString("hex")}`,
  PUBLIC_URL: "https://octi.example", OCTILLION_POD_CAPACITY: "3", OCTILLION_MAX_ORCHESTRATORS: "2",
  OCTILLION_AUTOSCALE_TICK_SECONDS: "15", OCTILLION_ORCH_IDLE_MINUTES: "10", OCTILLION_ORCH_SNAPSHOT: "on",
  OCTILLION_ORCH_PER_JOB: "off", // the shared fleet; one orchestrator per job is orchestrator/test/per-job.ts
  OCTILLION_ORG_MONTHLY_BUDGET_USD: "1000", // accounts without a plan get $0 (prepaid, invite-only)
});
delete process.env.DATABASE_URL; delete process.env.CLICKHOUSE_URL; delete process.env.OCTILLION_SANDBOX_PROVIDER; delete process.env.VERCEL;
delete process.env.VERCEL_ENV; delete process.env.OCTILLION_SANDBOX_NAMESPACE; delete process.env.OCTILLION_WORKER_SANDBOX_NAMESPACE;

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (...a: unknown[]) => console.log(`[atest ${new Date().toISOString().slice(11, 19)}]`, ...a);
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok, detail }); log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`); };

// ---------------------------------------------------------------- mock Vercel Sandbox (an orchestrator VM)
const { startVercelOrchMock } = await import("./vercel-orch-mock.js");
const vo = await startVercelOrchMock();
Object.assign(process.env, vo.env);
const state = vo.state;
const PREFIX = "octi-vo-local-"; // namespace "octi" (not on Vercel), environment "local"
let failPreflight = false;
const scripted = state.vsbExec;
state.vsbExec = (ctx: { sandbox: string; script: string; files: Map<string, Buffer> }) =>
  failPreflight && /in-sandbox\.ts preflight/.test(ctx.script) ? { stdout: '{"ok":false,"reason":"API unreachable"}\n', exitCode: 4 } : scripted(ctx);
const ours = () => [...state.vsbSandboxes.keys()].filter((n: string) => n.startsWith(PREFIX));
const has = (name: string) => state.vsbSandboxes.has(name);
const deletesOf = (name: string) => state.vsbRequests.filter((r: string) => r === `DELETE /v2/sandboxes/${name}`).length;
/** A sandbox in the mock with our name, as if launched earlier (or by an interrupted launch). */
const mk = (suffix: string, ageMs = 0) => {
  const name = `${PREFIX}${suffix}`;
  state.vsbSandboxes.set(name, { name, status: "running", session: `sbx_${randomBytes(6).toString("hex")}`, createdAt: Date.now() - ageMs, region: "iad1", projectId: "prj_vo", tags: {} });
  return name;
};

// ---------------------------------------------------------------- server modules (after env)
const { getDb } = await import("../../src/db.js");
const { createOrg } = await import("../../src/auth.js");
const q = await import("../../src/queries.js");
const kv = await import("../../src/keyvault.js");
const fleet = await import("../../src/fleet.js");
const { Autoscaler, AUTOSCALE } = await import("../../src/autoscaler.js");
const db = await getDb();
await kv.addCredential("openai", `sk-mock-${randomBytes(8).toString("hex")}`); // runs of codex/default need a vault key for their agent
const { org } = await createOrg("Autoscale Test", "astest");
const O = org;
await q.saveProduct(O, { name: "left-pad", packages: ["left-pad"] });
const queue = async (n: number) => {
  await q.saveScenarios(O, "left-pad", Array.from({ length: n }, (_, i) => ({ title: `t${i}-${Math.random()}`, prompt: `Task number ${i}: add zero padding to the invoice numbers in this small Node project.` })));
  // Shared-pool mode serves only non-private runs: these tasks stand in for library tasks (customer-written ones are private).
  await db.query("UPDATE scenarios SET source = 'library' WHERE product_id = (SELECT id FROM products WHERE slug = 'left-pad' AND org_id = $1)", [O.orgId]);
  return q.runSimulation(O, { product: "left-pad", agents: ["codex/default"], repeats: 1 });
};
const rows = async () => db.query<any>("SELECT * FROM orchestrator_sandboxes WHERE state <> 'deleted' ORDER BY id");
const quiet: string[] = [];
const a1 = new Autoscaler({ log: (m) => quiet.push(`a1 ${m}`) });
const a2 = new Autoscaler({ log: (m) => quiet.push(`a2 ${m}`) });

try {
  // kill switch
  process.env.OCTILLION_AUTOSCALE = "off";
  const off = await a1.tick();
  check("kill switch: OCTILLION_AUTOSCALE=off does nothing", !off.enabled && ours().length === 0, off.note ?? "");
  delete process.env.OCTILLION_AUTOSCALE;

  // no demand
  const idle = await a1.tick();
  check("no demand -> desired 0, nothing launched", idle.leader && idle.desired === 0 && ours().length === 0 && idle.provider === "vercel", `desired ${idle.desired}`);

  // queue work -> exactly one launch, even with two instances racing
  await queue(2);
  const [t1, t2] = await Promise.all([a1.tick(), a2.tick()]);
  await Promise.all([a1.tick(), a2.tick()]);
  await a1.settle(); await a2.settle();
  const r1 = await rows();
  check("queued work -> one orchestrator launched on Vercel Sandbox; second instance is not the leader (no double launch)",
    (t1.leader !== t2.leader) && r1.length === 1 && r1[0].state === "running" && r1[0].provider === "vercel" && ours().length === 1 && vo.supervisors.has(r1[0].sandbox_id),
    `leaders ${t1.leader}/${t2.leader}, rows ${r1.map((r: any) => `${r.sandbox_id}:${r.state}:${r.provider}`)}, sandboxes ${ours()}`);
  const env = state.vsbFiles.get(r1[0].sandbox_id)?.get("/tmp/octi-orchestrator.env.new")?.toString() ?? "";
  check("the env file says RUNNER=vercel and the sandbox namespace; no boat setting", /^RUNNER=vercel$/m.test(env) && /^OCTILLION_SANDBOX_NAMESPACE=octi$/m.test(env) && !/BOAT/.test(env),
    env.split("\n").filter((l) => !/TOKEN/.test(l)).join(" "));
  const tokenFiles = ([...state.vsbFiles.entries()] as [string, Map<string, Buffer>][]).flatMap(([n, f]) => [...f.entries()]
    .filter(([, b]) => b.toString("latin1").includes(process.env.OCTILLION_WORKER_TOKEN!)).map(([p]) => `${n}:${p}`));
  check("worker token only in the orchestrator sandbox env file", tokenFiles.length === 1 && tokenFiles[0] === `${r1[0].sandbox_id}:/tmp/octi-orchestrator.env.new`, tokenFiles.join(","));
  await a1.settle();
  const snaps = [...state.vsbSnapshots.values()];
  check("snapshot image built for the current code (cold-start path)", snaps.length === 1 && /^octi-vimg-local-[0-9a-f]{16}$/.test(snaps[0]!.name), JSON.stringify(snaps));

  // cap: lots of work -> at most OCTILLION_MAX_ORCHESTRATORS (2), next launch comes from the image
  await queue(20);
  for (let i = 0; i < 3; i++) { await a1.tick(); await a1.settle(); }
  const r2 = await rows();
  const st = a1.last!;
  check("cap respected: desired clamps to OCTILLION_MAX_ORCHESTRATORS=2 (demand needs 8)", r2.length === 2 && st.cap === 2 && st.desired === 2,
    `demand ${st.demand?.sessions} sessions, cap ${st.cap}, rows ${r2.length}`);
  check("later launches boot from the snapshot image", r2.some((r: any) => r.from_image && state.vsbSandboxes.get(r.sandbox_id)?.snapshotId), JSON.stringify(r2.map((r: any) => r.from_image)));

  // check-ins, then idle -> drain -> deleted, and no relaunch loop while the remaining queue is not claimable
  for (const r of r2) await fleet.fleetCheckin(r.orchestrator_id, 3);
  await db.query("UPDATE agent_sessions SET status = 'cancelled' WHERE status = 'queued' AND id NOT IN (SELECT id FROM agent_sessions WHERE status = 'queued' LIMIT 1)");
  // The one left is "stuck": it sat queued for a while next to live orchestrators that never claimed it.
  await db.query("UPDATE agent_sessions SET queued_at = now() - interval '15 minutes' WHERE status = 'queued'");
  const victim = r2[0];
  await fleet.fleetLeave(victim.orchestrator_id);
  await a1.tick();
  const r3 = await rows();
  check("idle exit -> fleet leave -> draining -> sandbox deleted", !has(victim.sandbox_id) && !r3.some((r: any) => r.id === victim.id),
    `reaped: ${JSON.stringify(a1.last?.reaped)}`);
  await fleet.fleetLeave(r2[1].orchestrator_id);
  await a1.tick(); await a1.tick(); await a1.settle();
  check("cooldown: queued-but-unclaimed work does not relaunch in a loop", (await rows()).length === 0 && /cooldown/.test(a1.last?.note ?? ""), a1.last?.note ?? "");
  // ...but a session queued now (a user clicking Run right after an idle exit) launches at once, not after the cooldown.
  await queue(1);
  await a1.tick(); await a1.settle();
  check("cooldown: freshly queued work launches immediately", (await rows()).length >= 1 && !/cooldown/.test(a1.last?.note ?? ""),
    `rows ${(await rows()).length}, note ${a1.last?.note ?? "-"}, fresh ${a1.last?.demand?.fresh_queued_sessions}`);
  for (const r of await rows()) { await fleet.fleetCheckin(r.orchestrator_id, 3).catch(() => {}); }
  await db.query("UPDATE agent_sessions SET status = 'cancelled' WHERE status IN ('queued', 'running')");
  for (const r of await rows()) await fleet.fleetLeave(r.orchestrator_id).catch(() => {});
  await a1.tick();

  // stale + exited + stuck booting + orphan
  await db.query("UPDATE agent_sessions SET status = 'cancelled' WHERE status IN ('queued', 'running')");
  const stale = mk("vstale1"), gone = mk("vexit1"), stuck = mk("vstuck1"), orphan = mk("vorphan1", 5 * 60_000);
  const youngOrphan = mk("vyoung1"); // created moments ago: its launch may not have recorded it yet
  // The sandbox reliability probe's sandboxes (src/sandbox-probe.ts) have no row either: the reaper never lists them.
  const probe = "octi-probe-0a1b2c3d4e";
  state.vsbSandboxes.set(probe, { name: probe, status: "running", session: "sbx_probe", createdAt: Date.now() - 3600_000, region: "iad1", projectId: "prj_vo" });
  await db.query("INSERT INTO orchestrator_sandboxes (sandbox_id, orchestrator_id, state, ready_at) VALUES ($1, 'orch-vstale1', 'running', now() - interval '20 minutes')", [stale]);
  await db.query("INSERT INTO orchestrators (id, capacity, last_seen) VALUES ('orch-vstale1', 3, now() - interval '6 minutes')");
  // It checked in (last_seen on its row), then its fleet row went away: it left and exited, it is not merely quiet.
  await db.query("INSERT INTO orchestrator_sandboxes (sandbox_id, orchestrator_id, state, ready_at, last_seen) VALUES ($1, 'orch-vexit1', 'running', now() - interval '20 minutes', now() - interval '6 minutes')", [gone]);
  await db.query("INSERT INTO orchestrator_sandboxes (sandbox_id, orchestrator_id, state, created_at) VALUES ($1, 'orch-vstuck1', 'booting', now() - interval '11 minutes')", [stuck]);
  await a1.tick();
  const reasons = Object.fromEntries((a1.last?.reaped ?? []).map((r) => [r.sandbox_id, r.reason]));
  check("stale (no fleet check-in 5 min) reaped", !has(stale) && /^stale: no fleet check-in/.test(reasons[stale] ?? ""), reasons[stale] ?? "");
  check("an orchestrator that left the fleet and exited is reaped as exited, not stale", !has(gone) && reasons[gone] === "orchestrator exited: left the fleet", reasons[gone] ?? "");
  check("stuck booting (> 10 min) reaped", !has(stuck) && /stuck booting/.test(reasons[stuck] ?? ""), reasons[stuck] ?? "");
  check("orphan orchestrator sandbox (no row) deleted", !has(orphan) && /orphan/.test(reasons[orphan] ?? ""), reasons[orphan] ?? "");
  check("an orchestrator sandbox under 2 minutes old with no row is spared", has(youngOrphan) && !reasons[youngOrphan], reasons[youngOrphan] ?? "");
  state.vsbSandboxes.delete(youngOrphan);
  check("probe sandbox (octi-probe-…) left alone by the orphan reaper", has(probe) && !reasons[probe], reasons[probe] ?? "");
  state.vsbSandboxes.delete(probe);
  // The reap reason has its own column, and every delete is in compute_events (orphans have no row).
  const ended = Object.fromEntries((await db.query<any>("SELECT sandbox_id, reap_reason, launch_step FROM orchestrator_sandboxes WHERE sandbox_id = ANY($1)", [[stale, stuck, gone]])).map((r) => [r.sandbox_id, r]));
  check("reap reason recorded apart from launch errors", /^stale/.test(ended[stale]?.reap_reason ?? "") && /^stuck booting/.test(ended[stuck]?.reap_reason ?? "") && /^orchestrator exited/.test(ended[gone]?.reap_reason ?? "") && !ended[stale]?.launch_step, JSON.stringify(ended));
  const evs = Object.fromEntries((await db.query<any>("SELECT kind, sandbox_id, orchestrator_id FROM compute_events WHERE sandbox_id = ANY($1)", [[stale, stuck, orphan]])).map((e) => [e.sandbox_id, e]));
  check("compute events: reaped, orphan deleted", evs[stale]?.kind === "reaped" && evs[stuck]?.kind === "reaped" && evs[orphan]?.kind === "orphan_deleted", JSON.stringify(evs));

  // A failed launch records its step and error apart (and as before in `error`), and a launch_failed event.
  failPreflight = true;
  await queue(1);
  const before = Number((await db.query<any>("SELECT max(id) AS id FROM orchestrator_sandboxes"))[0]?.id ?? 0);
  await a1.tick(); await a1.settle();
  failPreflight = false;
  const [bad] = await db.query<any>("SELECT * FROM orchestrator_sandboxes WHERE id > $1 ORDER BY id LIMIT 1", [before]);
  const [badEv] = await db.query<any>("SELECT * FROM compute_events WHERE kind = 'launch_failed' AND sandbox_id = $1", [bad?.sandbox_id ?? ""]);
  check("failed launch: step and error in their own columns, and a launch_failed event",
    bad?.state === "deleted" && bad.launch_step === "preflight" && /^preflight failed: API unreachable/.test(bad.launch_error ?? "") && /^preflight \(\d+s\): preflight failed/.test(bad.error ?? "") && !bad.reap_reason &&
    badEv?.step === "preflight" && badEv.orchestrator_id === bad.orchestrator_id && !has(bad.sandbox_id),
    JSON.stringify({ bad: bad && { state: bad.state, step: bad.launch_step, err: bad.launch_error, error: bad.error }, ev: badEv?.step }));
  await db.query("UPDATE agent_sessions SET status = 'cancelled' WHERE status IN ('queued', 'running')");

  // recycle on deploy: an orchestrator launched before this server process runs old code. It gets no pods, is not
  // deleted while a session of its is running, and is retired right after (no idle-timeout wait).
  const old = mk("vold1");
  await db.query("INSERT INTO orchestrator_sandboxes (sandbox_id, orchestrator_id, state, created_at, ready_at) VALUES ($1, 'orch-vold1', 'running', now() - interval '1 hour', now() - interval '1 hour')", [old]);
  const first = await fleet.fleetCheckin("orch-vold1", 3, { worker_id: "w-old1", running: {} }) as any;
  check("pre-deploy orchestrator is handed an empty assignment", Array.isArray(first.assignment) && first.assignment.length === 0, JSON.stringify(first.assignment));
  await queue(1);
  await db.query("UPDATE agent_sessions SET status = 'running', worker_id = 'w-old1' WHERE id = (SELECT id FROM agent_sessions WHERE status = 'queued' LIMIT 1)");
  await db.query("UPDATE agent_sessions SET status = 'cancelled' WHERE status = 'queued'");
  await new Promise((r) => setTimeout(r, 20));
  await fleet.fleetCheckin("orch-vold1", 3, { worker_id: "w-old1", running: {} });
  await a1.tick(); await a1.settle();
  check("...and is kept while one of its sessions is still running", has(old), (a1.last?.reaped ?? []).map((r) => r.reason).join(","));
  await db.query("UPDATE agent_sessions SET status = 'completed' WHERE worker_id = 'w-old1'");
  await a1.tick(); await a1.settle();
  const retired = (a1.last?.reaped ?? []).find((r) => r.sandbox_id === old);
  check("...then retired at once when idle (no 10-minute idle wait)", !has(old) && /retired/.test(retired?.reason ?? ""), retired?.reason ?? "not reaped");
  // Same code, older launch (a plain server restart, or another replica launched it): not retired.
  const same = mk("vsame1");
  await db.query("INSERT INTO orchestrator_sandboxes (sandbox_id, orchestrator_id, state, created_at, ready_at, code_hash) VALUES ($1, 'orch-vsame1', 'running', now() - interval '1 hour', now() - interval '1 hour', $2)", [same, fleet.currentCodeHash()]);
  await fleet.fleetCheckin("orch-vsame1", 3, { worker_id: "w-same1", running: {} });
  await new Promise((r) => setTimeout(r, 20));
  await fleet.fleetCheckin("orch-vsame1", 3, { worker_id: "w-same1", running: {} });
  await a1.tick(); await a1.settle();
  check("an orchestrator on the current code is kept (restart or other replica), whatever its age",
    has(same) && !(await fleet.staleOrchestratorIds()).has("orch-vsame1"), (a1.last?.reaped ?? []).map((r) => r.reason).join(","));

  // boat.dev was retired: a row still live on it is closed without any provider call, and a shared one gets no pods.
  await db.query("INSERT INTO orchestrator_sandboxes (sandbox_id, orchestrator_id, state, created_at, ready_at, code_hash, provider) VALUES ('bx_left1', 'orch-left1', 'running', now() - interval '1 hour', now() - interval '1 hour', $1, 'boat')", [fleet.currentCodeHash()]);
  const leftAssign = await fleet.fleetCheckin("orch-left1", 3, { worker_id: "w-left1", running: {} }) as any;
  check("a leftover boat.dev orchestrator is handed an empty assignment", Array.isArray(leftAssign.assignment) && leftAssign.assignment.length === 0, JSON.stringify(leftAssign.assignment));
  const reqsBefore = state.vsbRequests.length;
  await a1.tick();
  const left = (a1.last?.reaped ?? []).find((r) => r.sandbox_id === "bx_left1");
  const [leftRow] = await db.query<any>("SELECT state, reap_reason FROM orchestrator_sandboxes WHERE sandbox_id = 'bx_left1'");
  check("...and its row is closed without a provider call", leftRow?.state === "deleted" && /^boat\.dev \(retired\): row closed without a provider call/.test(left?.reason ?? "") &&
    !state.vsbRequests.slice(reqsBefore).some((r: string) => r.includes("bx_left1")), JSON.stringify({ left, leftRow }));

  // A setting that still names boat is a clear tick error, never a silent fallback.
  process.env.OCTILLION_SANDBOX_PROVIDER = "boat";
  const boatTick = await a1.tick();
  delete process.env.OCTILLION_SANDBOX_PROVIDER;
  check("OCTILLION_SANDBOX_PROVIDER=boat: the tick fails with a clear error", /^OCTILLION_SANDBOX_PROVIDER=boat: boat\.dev was retired on 2026-11-01/.test(boatTick.error ?? ""), boatTick.error ?? "no error");

  for (const r of await rows()) { await fleet.fleetLeave(r.orchestrator_id).catch(() => {}); }
  await a1.tick();
  check("nothing of ours left at Vercel", ours().length === 0, ours().join(","));
  check("knobs reported", AUTOSCALE.podCapacity() === 3 && AUTOSCALE.maxOrchestrators() === 2, "");
} catch (e) {
  check("no exception", false, String((e as Error).stack ?? e));
}
if (results.some((r) => !r.ok)) console.log(quiet.slice(-30).join("\n"));
await vo.close();
await db.close();
rmSync(tmp, { recursive: true, force: true });
const pass = results.every((r) => r.ok);
console.log(`\n${pass ? "AUTOSCALER TEST PASS" : "AUTOSCALER TEST FAIL"} (${results.filter((r) => r.ok).length}/${results.length} assertions)`);
process.exit(pass ? 0 : 1);
