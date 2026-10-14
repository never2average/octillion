/**
 * Hermetic test of one orchestrator per job (src/autoscaler.ts per-job mode, src/fleet.ts jobFleetStatus, claim
 * filters, per-persona developer environments): real server modules on a temp PGlite + a mock boat API.
 *
 *   npx tsx orchestrator/test/per-job.ts
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "octillion-pjtest-"));
const BOAT_PORT = Number(process.env.PJTEST_BOAT_PORT ?? 3406);
let planLimit = 100;
const BOAT_KEY = `boat_mock_${randomBytes(6).toString("hex")}`;
Object.assign(process.env, {
  PGLITE_DIR: path.join(tmp, "pglite"), OCTILLION_VAULT_KEY: randomBytes(32).toString("base64"), OCTILLION_WORKER_TOKEN: `wt_${randomBytes(8).toString("hex")}`,
  PUBLIC_URL: "https://octi.example", BOAT_API_URL: `http://127.0.0.1:${BOAT_PORT}/api/v1`, OCTILLION_POD_CAPACITY: "3", OCTILLION_MAX_ORCHESTRATORS: "2",
  OCTILLION_AUTOSCALE_TICK_SECONDS: "15", OCTILLION_ORCH_IDLE_MINUTES: "10", BOAT_STARTS_PER_MINUTE: "100", OCTILLION_ORCH_SNAPSHOT: "off", OCTILLION_JOB_POD_CAPACITY: "4", OCTILLION_MAX_JOB_ORCHESTRATORS: "4", OCTILLION_ORCH_LAUNCHES_PER_TICK: "4",
});
delete process.env.DATABASE_URL; delete process.env.CLICKHOUSE_URL;

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (...a: unknown[]) => console.log(`[pjtest ${new Date().toISOString().slice(11, 19)}]`, ...a);
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok, detail }); log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`); };

// ---------------------------------------------------------------- mock boat
interface Sb { id: string; name: string; state: string; from?: string; createdAt: string; files: Map<string, string> }
const sbs = new Map<string, Sb>();
const snaps = new Map<string, { status: string; at: number }>();
let creates = 0, fromImageCreates = 0, deletes = 0;
const workerTokenInFiles: string[] = [];
const json = (res: http.ServerResponse, s: number, b: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
const boat = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.headers.authorization !== `Bearer ${BOAT_KEY}`) return json(res, 401, { ok: false, code: "unauthorized" });
    const b = raw ? JSON.parse(raw) : {};
    const u = String(req.url).replace(/^\/api\/v1/, "").split("?")[0]!;
    if (u === "/limits") return json(res, 200, { ok: true, currentLimits: { activeSandboxes: planLimit }, startLimits: { perMinute: 12, perHour: 60, perDay: 200 }, activeSandboxes: [...sbs.values()].filter((s) => s.state === "ready").length });
    if (u === "/sandboxes" && req.method === "GET") return json(res, 200, { ok: true, sandboxes: [...sbs.values()].map(({ files: _f, ...s }) => s), pageInfo: { nextCursor: null } });
    if (u === "/sandboxes" && req.method === "POST") {
      const id = `bx_${randomBytes(4).toString("hex")}`;
      creates++; if (b.from) fromImageCreates++;
      sbs.set(id, { id, name: "", state: "ready", from: b.from, createdAt: new Date().toISOString(), files: new Map() });
      return json(res, 202, { ok: true, sandbox: { id, state: "provisioning" } });
    }
    if (u === "/named-snapshots" && req.method === "POST") { snaps.set(b.name, { status: "saving", at: Date.now() }); return json(res, 202, { ok: true, snapshot: { name: b.name, status: "saving" } }); }
    if (u === "/named-snapshots" && req.method === "GET") return json(res, 200, { ok: true, snapshots: [...snaps.keys()].map((name) => ({ name })) });
    const ns = /^\/named-snapshots\/(.+)$/.exec(u);
    if (ns) {
      const s = snaps.get(decodeURIComponent(ns[1]!));
      if (req.method === "DELETE") { snaps.delete(decodeURIComponent(ns[1]!)); return json(res, 200, { ok: true }); }
      if (!s) return json(res, 404, { ok: false, code: "not_found" });
      if (Date.now() - s.at > 300) s.status = "ready";
      return json(res, 200, { ok: true, snapshot: { name: ns[1], status: s.status } });
    }
    const m = /^\/sandboxes\/(bx_\w+)(\/.*)?$/.exec(u);
    const sb = m ? sbs.get(m[1]!) : undefined;
    if (!sb) return json(res, 404, { ok: false, code: "not_found" });
    const rest = m![2] ?? "";
    if (req.method === "GET" && rest === "") return json(res, 200, { ok: true, sandbox: { id: sb.id, state: sb.state, name: sb.name } });
    if (req.method === "PATCH") { if (b.name) sb.name = b.name; return json(res, 200, { ok: true }); }
    if (req.method === "DELETE") { if (sb.state !== "deleted") deletes++; sbs.delete(sb.id); return json(res, 202, { ok: true, type: "sandbox.deleting" }); }
    if (req.method === "PUT" && rest === "/files") { sb.files.set(b.path, b.content); if (String(b.content).includes(process.env.OCTILLION_WORKER_TOKEN!)) workerTokenInFiles.push(`${sb.name || sb.id}:${b.path}`); return json(res, 200, { ok: true }); }
    if (req.method === "POST" && rest === "/commands") {
      const cmd = String(b.command);
      const stdout = /in-sandbox\.ts preflight/.test(cmd) ? '{"ok":true,"reason":"reachable"}'
        : /test -x .*tsx/.test(cmd) ? (sb.from ? "yes" : "no") : /systemctl (enable|is-active)/.test(cmd) ? "active" : "";
      return json(res, 200, { ok: true, exitCode: 0, stdout, stderr: "" });
    }
    json(res, 404, { ok: false, code: "not_found" });
  });
});
await new Promise<void>((r) => boat.listen(BOAT_PORT, "127.0.0.1", () => r()));


// ---------------------------------------------------------------- server modules (after env)
const { getDb } = await import("../../src/db.js");
const { createOrg } = await import("../../src/auth.js");
const q = await import("../../src/queries.js");
const kv = await import("../../src/keyvault.js");
const fleet = await import("../../src/fleet.js");
const worker = await import("../../src/worker.js");
const research = await import("../../src/research.js");
const { Autoscaler, AUTOSCALE } = await import("../../src/autoscaler.js");
const db = await getDb();
await kv.setCredential("boat", BOAT_KEY, { label: "test" });
const { org: O } = await createOrg("Per Job Test", "pjtest");
const { org: O2 } = await createOrg("Per Job Other", "pjother");
await q.saveProduct(O, { name: "Quillmail", packages: ["quillmail"], competitors: [{ name: "Postbox", packages: ["postbox-js"] }] });
await q.saveProduct(O2, { name: "left-pad", packages: ["left-pad"] });
const run = async (org: typeof O, product: string, tasks: number, repeats: number) => {
  await q.saveScenarios(org, product, Array.from({ length: tasks }, (_, i) => ({ title: `t${i}-${Math.random()}`, prompt: `Task number ${i}: send a password reset message from this small Node project when a user asks for one.` })));
  return (await q.runSimulation(org, { product, agents: ["codex/default"], repeats })).simulation.id as string;
};
const rows = async () => db.query<any>("SELECT * FROM orchestrator_sandboxes WHERE state <> 'deleted' ORDER BY id");
const envOf = (sandboxId: string) => sbs.get(sandboxId)?.files.get([...sbs.get(sandboxId)!.files.keys()].find((k) => /orchestrator\.env/.test(k)) ?? "") ?? "";
const quiet: string[] = [];
const a1 = new Autoscaler({ log: (m) => quiet.push(`a1 ${m}`) });
const tickSettle = async (a = a1) => { const st = await a.tick(); await a.settle(); return st; };

try {
  check("per-job mode is the default", AUTOSCALE.perJob() && AUTOSCALE.jobPodCapacity() === 4, "");
  check("splitPods: one each first, never above demand, proportional after",
    JSON.stringify(fleet.splitPods(4, [6, 1, 1])) === "[2,1,1]" && JSON.stringify(fleet.splitPods(10, [2, 3])) === "[2,3]" &&
    JSON.stringify(fleet.splitPods(5, [8, 2])) === "[4,1]", `${fleet.splitPods(4, [6, 1, 1])} ${fleet.splitPods(10, [2, 3])} ${fleet.splitPods(5, [8, 2])}`);

  // onboarding research -> its own orchestrator with one sandbox
  const [{ id: pid }] = await db.query<any>("SELECT id FROM products WHERE org_id = $1", [O.orgId]);
  await db.query("INSERT INTO product_research (id, org_id, product_id, input) VALUES ('rsh_pjA', $1, $2, '{}'), ('rsh_pjB', $1, $2, '{}')", [O.orgId, pid]);
  let st = await tickSettle();
  let r = await rows();
  const rA = r.find((x: any) => x.job_id === "rsh_pjA"), rB = r.find((x: any) => x.job_id === "rsh_pjB");
  check("each queued research gets its own orchestrator", r.length === 2 && !!rA && !!rB && rA.pods === 0, JSON.stringify(st.launched));
  check("...launched with ORCHESTRATOR_JOB and POD_CAPACITY=1", /ORCHESTRATOR_JOB=rsh_pjA\n/.test(envOf(rA.sandbox_id)) && /POD_CAPACITY=1\n/.test(envOf(rA.sandbox_id)),
    envOf(rA.sandbox_id).split("\n").filter((l) => /JOB|POD/.test(l)).join(" "));
  check("worker token only in orchestrator env files", workerTokenInFiles.every((f) => /orchestrator\.env/.test(f)), workerTokenInFiles.join(","));
  st = await tickSettle();
  check("a served job is not launched twice", (await rows()).length === 2 && st.launched?.length === 0, JSON.stringify(st.jobs));

  // research claim isolation
  const none = await research.claimResearch("w-rB", 5, "rsh_pjB");
  const other = await db.query<any>("SELECT status FROM product_research WHERE id = 'rsh_pjA'");
  check("research claim with research_id takes only that job", none.length === 1 && none[0]!.research_id === "rsh_pjB" && other[0].status === "queued", JSON.stringify(none.map((j) => j.research_id)));

  // research check-in: no pods, job.done once it ends -> leave -> reaped, not relaunched
  const ck = await fleet.fleetCheckin(rB.orchestrator_id, 1, { worker_id: "w-rB" }) as any;
  check("research orchestrator check-in: no pod groups, job not done", ck.job?.id === "rsh_pjB" && ck.job.done === false && ck.assignment.length === 0, JSON.stringify(ck));
  await db.query("UPDATE product_research SET status = 'completed', finished_at = now() WHERE id = 'rsh_pjB'");
  const ck2 = await fleet.fleetCheckin(rB.orchestrator_id, 1, { worker_id: "w-rB" }) as any;
  check("...job.done once the research completed", ck2.job?.done === true && ck2.job.status === "completed", JSON.stringify(ck2.job));
  await fleet.fleetLeave(rB.orchestrator_id);
  st = await tickSettle();
  check("...leaves, is reaped, and is not relaunched", !sbs.has(rB.sandbox_id) && !(await rows()).some((x: any) => x.job_id === "rsh_pjB"),
    JSON.stringify(st.reaped));
  await db.query("UPDATE product_research SET status = 'failed', finished_at = now() WHERE id = 'rsh_pjA'");
  await fleet.fleetLeave(rA.orchestrator_id);
  await tickSettle();

  // two simulations of two orgs -> two orchestrators, pods = min(JOB_POD_CAPACITY, sessions)
  const simA = await run(O, "quillmail", 3, 2);   // 6 sessions
  const simB = await run(O2, "left-pad", 1, 2);   // 2 sessions
  st = await tickSettle();
  r = await rows();
  const oA = r.find((x: any) => x.job_id === simA), oB = r.find((x: any) => x.job_id === simB);
  check("each simulation gets its own orchestrator", !!oA && !!oB && r.length === 2, JSON.stringify(st.jobs));
  check("...sized to its run: min(JOB_POD_CAPACITY=4, sessions)", oA?.pods === 4 && oB?.pods === 2 && /POD_CAPACITY=4\n/.test(envOf(oA.sandbox_id)),
    `A ${oA?.pods} B ${oB?.pods}`);
  const cA = await fleet.fleetCheckin(oA.orchestrator_id, 4, { worker_id: "w-A" }) as any;
  check("run orchestrator check-in: pod groups from its own sessions only", cA.job?.id === simA && !cA.job.done &&
    cA.assignment.length === 1 && cA.assignment[0].agent_id === "codex/default" && cA.assignment[0].pods === 4, JSON.stringify(cA.assignment));
  const g = await fleet.fleetStatus() as any;
  check("per-job orchestrators are not part of the shared fleet plan", g.orchestrators === 0 && g.total_pods === 0, `${g.orchestrators} / ${g.total_pods}`);
  const capped = await fleet.fleetCheckin(oA.orchestrator_id, 999, { worker_id: "w-A" }) as any;
  const [cap] = await db.query<any>("SELECT capacity FROM orchestrators WHERE id = $1", [oA.orchestrator_id]);
  check("check-in capacity is clamped to JOB_POD_CAPACITY", cap.capacity === 4 && capped.assignment[0].pods === 4, String(cap.capacity));

  // claim isolation: only this run's sessions, whatever the fair share across orgs
  const jobsA = await worker.claimJobs("w-A", { limit: 50, agent_ids: ["codex/default"], simulation_id: simA });
  const [left] = await db.query<any>("SELECT count(*) AS n FROM agent_sessions WHERE simulation_id = $1 AND status = 'queued'", [simB]);
  check("claim with simulation_id returns only that run", jobsA.length === 6 && jobsA.every((j) => j.simulation_id === simA) && Number(left.n) === 2,
    `${jobsA.length} claimed, ${left.n} of B still queued`);

  // developer environment: per persona (editor + CLI tools) + the editor's language servers for the task, blind
  await db.query("UPDATE agent_sessions SET status = 'queued', worker_id = NULL WHERE simulation_id = $1", [simA]);
  await db.query("UPDATE scenarios SET language = 'TypeScript' WHERE id IN (SELECT scenario_id FROM agent_sessions WHERE simulation_id = $1)", [simA]);
  await db.query(`UPDATE products SET competitors = competitors || '[{"name": "Stripe Mail"}]'::jsonb WHERE id = $1`, [pid]);
  const [prof] = await db.query<any>(
    `INSERT INTO developer_profiles (slug, name, summary, attributes, instructions, org_id, product_id, source, active, environment)
     VALUES ('pj-zed', 'Zed dev', '', '{}', '', $1, $2, 'generated', true, '{"editor": "zed", "tools": ["cli/psql", "cli/stripe", "cli/gh"]}') RETURNING id`, [O.orgId, pid]);
  const half = await db.query<any>("SELECT id FROM agent_sessions WHERE simulation_id = $1 ORDER BY id LIMIT 3", [simA]);
  await db.query("UPDATE agent_sessions SET profile_id = $2 WHERE id = ANY($1)", [half.map((h: any) => h.id), prof.id]);
  const jobs2 = await worker.claimJobs("w-A", { limit: 50, simulation_id: simA });
  const zed = jobs2.find((j) => half.some((h: any) => h.id === j.session_id))!.environment!;
  const plain = jobs2.find((j) => !half.some((h: any) => h.id === j.session_id))!.environment!;
  check("persona environment: Zed's TypeScript server + base CLIs + the persona's tools",
    zed.editor === "zed" && zed.language === "typescript" && ["lsp/vtsls", "cli/ripgrep", "cli/jq", "cli/psql", "cli/gh"].every((t) => zed.tools.includes(t)), JSON.stringify(zed));
  check("...a tool naming a competitor is dropped at claim (blindness)", !zed.tools.includes("cli/stripe") && zed.dropped?.includes("cli/stripe") === true, JSON.stringify(zed.dropped));
  check("no persona environment -> VS Code defaults for the task's language",
    plain.editor === "vscode" && plain.tools.includes("lsp/typescript-language-server") && !plain.tools.includes("cli/psql"), JSON.stringify(plain));
  await db.query("UPDATE agent_sessions SET status = 'queued', worker_id = NULL WHERE simulation_id = $1", [simA]);
  process.env.OCTILLION_DEV_ENV = "off";
  const jobs3 = await worker.claimJobs("w-A", { limit: 1, simulation_id: simA });
  delete process.env.OCTILLION_DEV_ENV;
  check("OCTILLION_DEV_ENV=off -> no environment", jobs3.length === 1 && jobs3[0]!.environment === null, "");
  const base = { product: { name: "Quillmail", packages: ["quillmail"], competitors: [{ name: "Postbox" }, { name: "Mailcrate" }, { name: "Vercel Mail" }] },
    scenarios: [1, 2, 3].map((i) => ({ prompt: `Task ${i}: we need password reset emails in this Express service, with templates.` })) };
  const v1 = research.validateResearch({ ...base, personas: [{ name: "Dev", environment: { editor: "zed", tools: ["cli/psql", "cli/teleporter"] } }] } as any);
  const v2 = research.validateResearch({ ...base, personas: [{ name: "Dev", environment: { editor: "emacs" as any, tools: ["cli/vercel"] } }] } as any);
  const v3 = research.validateResearch({ ...base, personas: [{ name: "Dev", environment: { editor: "intellij", tools: ["cli/gh", "cli/uv"] } }] } as any);
  check("research validation: unknown tools and editors are rejected, competitor tools too, a clean environment passes",
    v1.some((x) => /unknown environment tools: cli\/teleporter/.test(x)) && v2.some((x) => /editor must be one of/.test(x)) &&
    v3.length === 0, [v1, v2, v3].map((v) => v.join(" | ")).join(" || "));
  const v4 = research.validateResearch({ ...base, personas: [{ name: "Dev", environment: { editor: "zed", tools: ["cli/vercel"] } }] } as any);
  check("research validation: a tool that names a competitor is rejected", v4.some((x) => /cli\/vercel would reveal/.test(x)), v4.join(" | "));

  // worker-sandbox side: what gets installed and how each harness is wired
  const ei = await import("../core/env-install.js");
  const tsEnv = { editor: "vscode" as const, language: "typescript" as const, tools: ["lsp/typescript-language-server", "lsp/dart", "cli/jq"] };
  const cc = ei.harnessWiringScript("claude-code", ei.toolsFor("claude-code", tsEnv));
  const cx = ei.harnessWiringScript("codex", ei.toolsFor("codex", tsEnv));
  const oc = ei.harnessWiringScript("opencode", ei.toolsFor("opencode", tsEnv));
  check("Claude Code: official LSP plugin + local plugin for servers without one; no Serena",
    /claude plugin install typescript-lsp@claude-plugins-official/.test(cc.script) && /claude plugin install dart-lsp@local-lsp/.test(cc.script) &&
    !ei.toolsFor("claude-code", tsEnv).some((t) => t.id === "mcp/serena"), cc.summary);
  check("Codex: Serena over MCP appended to config.toml", ei.toolsFor("codex", tsEnv).some((t) => t.id === "mcp/serena") &&
    /config\.toml\.mcp" >> "\$HOME\/\.codex\/config\.toml"/.test(cx.script), cx.summary);
  const ocFile = /printf %s (\S+) \| base64 -d > "\$HOME\/\.config\/opencode\/opencode\.json"/.exec(oc.script);
  check("OpenCode: lsp entries in the user config", !!ocFile && JSON.parse(Buffer.from(ocFile[1]!, "base64").toString()).lsp["typescript-language-server"].command[0] === "typescript-language-server", oc.summary);
  const inst = ei.envInstallScript(ei.toolsFor("codex", tsEnv));
  check("install script: skips tools already present, one subshell per tool", (inst.match(/then r=present/g) ?? []).length === 4 && /ENV mcp\/serena/.test(inst), "");
  const parsed = ei.parseEnvLines("ENV cli/jq present 0\nENV lsp/dart ok 41\nENV mcp/serena fail 3\nWIRE lsp/dart serena\n");
  check("install result parsing", parsed.present[0] === "cli/jq" && parsed.installed[0] === "lsp/dart" && parsed.failed[0] === "mcp/serena" && parsed.wired["lsp/dart"] === "serena", JSON.stringify(parsed));
  check("nothing the agent can see names Octillion", ![cc.script, cx.script, oc.script].some((x) => /octi/i.test(x)), "");

  // run over -> job.done -> leave -> reaped; the other run's orchestrator is untouched
  await db.query("UPDATE agent_sessions SET status = 'completed' WHERE simulation_id = $1", [simA]);
  await db.query("UPDATE simulations SET status = 'completed', finished_at = now() WHERE id = $1", [simA]);
  const dA = await fleet.fleetCheckin(oA.orchestrator_id, 4, { worker_id: "w-A" }) as any;
  check("run orchestrator: job.done when the run completed, empty assignment", dA.job?.done === true && dA.assignment.length === 0, JSON.stringify(dA.job));
  await fleet.fleetLeave(oA.orchestrator_id);
  st = await tickSettle();
  check("...leaves and is reaped; the other run keeps its orchestrator", !sbs.has(oA.sandbox_id) && sbs.has(oB.sandbox_id) && (await rows()).length === 1, JSON.stringify(st.reaped));

  // backstop: a run that ended 3+ min ago whose orchestrator never left is deleted when idle
  await fleet.fleetCheckin(oB.orchestrator_id, 2, { worker_id: "w-B" });
  await db.query("UPDATE agent_sessions SET status = 'cancelled' WHERE simulation_id = $1", [simB]);
  await db.query("UPDATE simulations SET status = 'cancelled', finished_at = now() - interval '4 minutes' WHERE id = $1", [simB]);
  st = await tickSettle();
  check("backstop: an orchestrator whose job ended > 3 min ago is reaped", !sbs.has(oB.sandbox_id) && st.reaped?.some((x) => /is cancelled/.test(x.reason)) === true, JSON.stringify(st.reaped));

  // boat plan: launches fit what is free (1 + pods each); the rest wait
  planLimit = 8;
  await a1.release();
  const a2 = new Autoscaler({ log: (m) => quiet.push(`a2 ${m}`) });
  const s1 = await run(O, "quillmail", 3, 2), s2 = await run(O2, "left-pad", 3, 2), s3 = await run(O2, "left-pad", 1, 1);
  st = await tickSettle(a2);
  r = await rows();
  const pods = Object.fromEntries(r.map((x: any) => [x.job_id, x.pods]));
  check("boat plan: first run gets 4 pods, second the 2 left (1 + 4 + 1 + 2 = 8), third waits",
    pods[s1] === 4 && pods[s2] === 2 && !(s3 in pods) && /waits for boat plan capacity/.test(st.note ?? ""), `${JSON.stringify(pods)} note ${st.note}`);
  planLimit = 100;
  await a2.release();
  const a3 = new Autoscaler({ log: (m) => quiet.push(`a3 ${m}`) });
  st = await tickSettle(a3);
  check("...and launches once capacity frees up", (await rows()).some((x: any) => x.job_id === s3), JSON.stringify(st.jobs));

  // cooldown: a run's orchestrator idled out with sessions it could not claim -> no relaunch loop; fresh work relaunches
  const o3 = (await rows()).find((x: any) => x.job_id === s3);
  await fleet.fleetCheckin(o3.orchestrator_id, 1, { worker_id: "w-3" });
  await db.query("UPDATE agent_sessions SET queued_at = now() - interval '15 minutes' WHERE simulation_id = $1", [s3]);
  await fleet.fleetLeave(o3.orchestrator_id);
  await tickSettle(a3); st = await tickSettle(a3);
  check("cooldown: idled-out run with stuck sessions is not relaunched in a loop", !(await rows()).some((x: any) => x.job_id === s3) && /cooldown/.test(st.note ?? ""), st.note ?? "");

  // retiring (old code) per-job orchestrator: no pods, and a fresh one is launched for its job
  const o1 = (await rows()).find((x: any) => x.job_id === s1);
  await db.query("UPDATE orchestrator_sandboxes SET code_hash = 'old' WHERE id = $1", [o1.id]);
  const old = await fleet.fleetCheckin(o1.orchestrator_id, 4, { worker_id: "w-1" }) as any;
  st = await tickSettle(a3);
  check("old-code per-job orchestrator gets no pods; a fresh one takes its job", old.assignment.length === 0 &&
    (await rows()).filter((x: any) => x.job_id === s1).length === 2, `${JSON.stringify(old.assignment)} ${JSON.stringify(st.launched)}`);

  // max per-job orchestrators
  for (let i = 0; i < 4; i++) await run(O2, "left-pad", 1, 1);
  st = await tickSettle(a3); st = await tickSettle(a3);
  const live = (await rows()).filter((x: any) => !(x.code_hash === "old"));
  check("at most OCTILLION_MAX_JOB_ORCHESTRATORS (4) live", live.length === 4 && /MAX_JOB_ORCHESTRATORS/.test(st.note ?? ""), `${live.length} live, ${st.note}`);

  // shared mode still works when per-job is off
  process.env.OCTILLION_ORCH_PER_JOB = "off";
  check("OCTILLION_ORCH_PER_JOB=off -> shared fleet", !AUTOSCALE.perJob(), "");
  delete process.env.OCTILLION_ORCH_PER_JOB;

  await db.query("UPDATE agent_sessions SET status = 'cancelled' WHERE status IN ('queued', 'running')");
  await db.query("UPDATE simulations SET status = 'cancelled', finished_at = now() - interval '10 minutes' WHERE status IN ('queued', 'running')");
  for (const x of await rows()) await fleet.fleetLeave(x.orchestrator_id).catch(() => {});
  await tickSettle(a3);
  check("nothing of ours left on boat", ![...sbs.values()].some((s) => s.name.startsWith("octi-orch-")), [...sbs.values()].map((s) => s.name).join(","));
} catch (e) {
  check("no exception", false, String((e as Error).stack ?? e));
}
if (results.some((r) => !r.ok)) console.log(quiet.slice(-30).join("\n"));
boat.close();
await db.close();
rmSync(tmp, { recursive: true, force: true });
const pass = results.every((r) => r.ok);
console.log(`\n${pass ? "PER-JOB TEST PASS" : "PER-JOB TEST FAIL"} (${results.filter((r) => r.ok).length}/${results.length} assertions)`);
process.exit(pass ? 0 : 1);
