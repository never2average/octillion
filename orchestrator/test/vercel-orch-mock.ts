/**
 * A mock Vercel Sandbox for orchestrator launches (orchestrator/deploy/vercel-orch.ts), shared by the autoscaler tests
 * (orchestrator/test/autoscaler.ts, per-job.ts). It is scripts/lib/mock-providers.ts (the REST API) with a scripted VM:
 *  - Node at /vercel/runtimes/node24/bin; `test -x …tsx` says yes only in a sandbox created from a snapshot
 *  - the marker the configure step writes (/etc/octillion/host-role) and the env file it installs are remembered, and
 *    `in-sandbox.ts guard` answers what the REAL host guard (core/host-guard.ts checkHost) says about that env file and
 *    marker on a VM with Vercel's indicators (the proxy CA, /vercel/runtimes). `vmLike` drops those indicators: the
 *    guard must then refuse, as it would on our own VM
 *  - the supervisor, started as a detached command, keeps running; its pid check answers `active`
 */
import { checkHost, MARKER_PATH, VERCEL_PROXY_CA, type GuardResult } from "../core/host-guard.js";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
export const MOCK_OIDC = `${b64({ alg: "RS256" })}.${b64({ owner_id: "team_vo", project_id: "prj_vo", iss: "https://oidc.vercel.com/vo" })}.c2ln`;

/** Script the mock's VM (state.vsbExec) as an orchestrator sandbox; `mock` is scripts/lib/mock-providers.ts's. */
export function installOrchestratorVm(mock: { url: string; state: any }) {
  const markers = new Map<string, string>();
  const guards = new Map<string, GuardResult>();
  const supervisors = new Set<string>();
  const scripts: { sandbox: string; script: string }[] = [];
  const o = { vmLike: false, slowNodeMs: 0 };
  const envOf = (files: Map<string, Buffer>) => Object.fromEntries((files.get("/tmp/octi-orchestrator.env.new")?.toString("utf8") ?? "")
    .split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  mock.state.vsbExec = ({ sandbox, script, files }: { sandbox: string; script: string; files: Map<string, Buffer> }) => {
    scripts.push({ sandbox, script });
    const m = /printf '%s' '([^']*)' \| sudo -n tee \/etc\/octillion\/host-role/.exec(script);
    if (m) markers.set(sandbox, m[1]!);
    if (/ls -d \/vercel\/runtimes\/node/.test(script)) return { stdout: "/vercel/runtimes/node24/bin\n", durationMs: o.slowNodeMs };
    if (/test -x .*node_modules\/\.bin\/tsx/.test(script)) return { stdout: mock.state.vsbSandboxes.get(sandbox)?.snapshotId ? "yes\n" : "no\n" };
    if (/in-sandbox\.ts guard/.test(script)) {
      const env = envOf(files);
      const vercelFiles = o.vmLike ? [] : [VERCEL_PROXY_CA[0]!, "/vercel/runtimes", "/vercel/sandbox"];
      const g = checkHost(env.RUNNER ?? "vercel", { env, exists: (p) => vercelFiles.includes(p), read: (p) => (p === MARKER_PATH ? markers.get(sandbox) ?? null : null) });
      guards.set(sandbox, g);
      return { stdout: JSON.stringify({ ok: g.ok, dev: g.dev, problems: g.problems, provider: g.provider }) + "\n", exitCode: g.ok ? 0 : 3 };
    }
    if (/in-sandbox\.ts preflight/.test(script)) return { stdout: '{"ok":true,"status":200,"reason":"reachable"}\n' };
    if (/^exec sudo -n -u octi env -i .* bash \/opt\/octillion\/supervisor\.sh/.test(script)) { supervisors.add(sandbox); return { durationMs: 3_600_000 }; }
    if (/supervisor\.pid/.test(script) && /kill -0/.test(script) && /echo active/.test(script)) return { stdout: supervisors.has(sandbox) ? "active\n" : "failed\n" };
    return {};
  };
  const drop = (name: string) => fetch(`${mock.url}/_mock/vercel/drop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
  return {
    state: mock.state, markers, guards, supervisors, scripts, opts: o, drop,
    env: { VERCEL_OIDC_TOKEN: MOCK_OIDC, OCTILLION_VERCEL_SANDBOX_API_URL: `${mock.url}/vercel-sandbox` },
    /** Every byte written into a sandbox and every script run there, to search for secrets. */
    everything: (name?: string) => [
      ...([...mock.state.vsbFiles.entries()] as [string, Map<string, Buffer>][]).filter(([n]) => !name || n === name).flatMap(([, f]) => [...f.values()].map((b) => b.toString("latin1"))),
      ...scripts.filter((s) => !name || s.sandbox === name).map((s) => s.script),
    ].join("\n"),
  };
}

/** The mock providers on their own port, with the orchestrator VM installed. */
export async function startVercelOrchMock() {
  const { startMockProviders } = await import("../../scripts/lib/mock-providers.js");
  const mock = await startMockProviders();
  return { ...installOrchestratorVm(mock), mock, close: () => mock.close() };
}
