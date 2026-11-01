/**
 * Host guard: the orchestrator runs ONLY inside a Vercel Sandbox launched for it (the "orchestrator sandbox",
 * orchestrator/deploy/vercel-orch.ts). Its only production runner is `vercel` (worker sandboxes through the API's broker).
 * Nothing agent-related may run on the main VM, which hosts only the server stack.
 *
 * A host passes when ALL of these hold:
 *  1. OCTILLION_HOST_ROLE is "vercel-orchestrator", written by the launcher into the orchestrator's 0600 env file
 *  2. the launcher's marker file (/etc/octillion/host-role, root-owned) names the same role
 *  3. Vercel Sandbox's own indicators (docs: vercel.com/docs/sandbox/concepts, "Proxy CA certificates"; the node24 image):
 *     the per-sandbox proxy CA Vercel mounts in every sandbox (/etc/pki/ca-trust/source/anchors/vercel-proxy-ca.pem or
 *     /usr/local/share/ca-certificates/vercel-proxy-ca.pem) and the /vercel tree (/vercel/runtimes, /vercel/sandbox);
 *     OCTILLION_SANDBOX_ID (the env file) matches the marker's sandbox_id (required); and none of the hosting markers of a
 *     Vercel *function* (VERCEL_REGION, AWS_LAMBDA_FUNCTION_NAME): the API itself never runs agents
 * and RUNNER is `vercel`.
 *
 * A machine of ours (the VM) has none of these files, so it is refused even if someone copies an env file onto it. So is
 * a host claiming the retired boat.dev role ("boat-orchestrator"). OCTILLION_DEV_ALLOW_LOCAL=1 bypasses all of it (tests
 * and local development only) with a loud warning.
 */
import { existsSync, readFileSync } from "node:fs";
import { RETIRED_PROVIDERS } from "./config.js";

export const HOST_ROLE = "vercel-orchestrator";
export type HostProvider = "vercel";
export const MARKER_PATH = "/etc/octillion/host-role";
export const VERCEL_PROXY_CA = ["/etc/pki/ca-trust/source/anchors/vercel-proxy-ca.pem", "/usr/local/share/ca-certificates/vercel-proxy-ca.pem"];
export const VERCEL_TREE = ["/vercel/runtimes", "/vercel/sandbox"];

export interface HostProbe {
  env: Record<string, string | undefined>;
  exists(path: string): boolean;
  read(path: string): string | null;
}

export const realProbe: HostProbe = {
  env: process.env,
  exists: (p) => existsSync(p),
  read: (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
};

export interface GuardResult { ok: boolean; dev: boolean; problems: string[]; warning?: string; provider?: HostProvider | null }

/** Which provider this env file claims (null: none). */
export const claimedProvider = (env: Record<string, string | undefined>): HostProvider | null =>
  env.OCTILLION_HOST_ROLE === HOST_ROLE ? "vercel" : null;

export function checkHost(runner: string, probe: HostProbe = realProbe): GuardResult {
  const env = probe.env;
  if (env.OCTILLION_DEV_ALLOW_LOCAL === "1") {
    return {
      ok: true, dev: true, problems: [], provider: null,
      warning: [
        "#".repeat(78),
        "# OCTILLION_DEV_ALLOW_LOCAL=1: HOST GUARD DISABLED. Tests / local development ONLY.",
        `# This process may run coding agents on THIS machine (RUNNER=${runner}). Never set this in production:`,
        "# production orchestrators run only inside Vercel Sandbox orchestrator sandboxes (src/autoscaler.ts).",
        "#".repeat(78),
      ].join("\n"),
    };
  }
  const problems: string[] = [];
  // RUNNER picks the worker sandboxes (Vercel Sandbox through the API broker); the host is checked below.
  if (RETIRED_PROVIDERS[runner]) problems.push(`RUNNER=${runner} is retired (${RETIRED_PROVIDERS[runner]}); the only production runner is "vercel"`);
  else if (runner !== "vercel") problems.push(`RUNNER=${runner} is not allowed in production (only "vercel"; pool/docker/local need OCTILLION_DEV_ALLOW_LOCAL=1, tests only)`);
  const provider = claimedProvider(env);
  if (env.OCTILLION_HOST_ROLE === "boat-orchestrator") problems.push(`OCTILLION_HOST_ROLE=boat-orchestrator: ${RETIRED_PROVIDERS.boat}; orchestrators run only on Vercel Sandbox`);
  else if (!provider) problems.push(`OCTILLION_HOST_ROLE is not "${HOST_ROLE}" (set by the launcher's env file)`);
  const markerRaw = probe.read(MARKER_PATH);
  let marker: { role?: string; sandbox_id?: string } | null = null;
  try { marker = markerRaw ? JSON.parse(markerRaw) : null; } catch { marker = null; }
  if (marker?.role !== HOST_ROLE) problems.push(`launcher marker ${MARKER_PATH} is missing or not a ${HOST_ROLE} marker`);
  // Vercel Sandbox's own indicators: always checked, whatever the env claims.
  if (!VERCEL_PROXY_CA.some((p) => probe.exists(p))) problems.push("Vercel Sandbox proxy CA (vercel-proxy-ca.pem) not found (not a Vercel Sandbox VM?)");
  if (!VERCEL_TREE.some((p) => probe.exists(p))) problems.push("no /vercel/runtimes or /vercel/sandbox (not a Vercel Sandbox VM?)");
  if (env.VERCEL_REGION || env.AWS_LAMBDA_FUNCTION_NAME) problems.push("this is a Vercel function, not a Vercel Sandbox: the API never runs orchestrators");
  const sid = env.OCTILLION_SANDBOX_ID;
  if (!sid) problems.push("no OCTILLION_SANDBOX_ID in the environment (set by the launcher's env file)");
  else if (!marker?.sandbox_id) problems.push(`launcher marker ${MARKER_PATH} names no sandbox_id`);
  else if (sid !== marker.sandbox_id) problems.push(`OCTILLION_SANDBOX_ID ${sid} does not match the launcher marker's sandbox ${marker.sandbox_id}`);
  return { ok: problems.length === 0, dev: false, problems, provider };
}

/** Throw unless this process may run as an orchestrator here. Prints the dev warning loudly when bypassed. */
let warned = false;
export function assertOrchestratorHost(runner: string, probe: HostProbe = realProbe): void {
  const r = checkHost(runner, probe);
  if (r.warning && !warned) { console.error(r.warning); warned = true; }
  if (!r.ok) {
    throw new Error(
      "Refusing to start: the Octillion orchestrator runs only inside a Vercel Sandbox orchestrator sandbox " +
      "(the server's autoscaler launches them).\n  - " + r.problems.join("\n  - "));
  }
}
