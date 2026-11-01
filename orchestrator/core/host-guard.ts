/**
 * Host guard: the orchestrator runs ONLY inside a provider sandbox launched for it (the "orchestrator sandbox": boat.dev
 * or Vercel Sandbox, orchestrator/deploy/orchestrator-host.ts). Its only production runners are `boat` and `vercel`
 * (worker sandboxes created from there, sandbox from sandbox, or through the API's broker). Nothing agent-related may run
 * on the main VM, which hosts only the server stack.
 *
 * A host passes when ALL of these hold for one provider:
 *  1. OCTILLION_HOST_ROLE is that provider's role ("boat-orchestrator" or "vercel-orchestrator"), written by the launcher
 *     into the orchestrator's 0600 env file
 *  2. the launcher's marker file (/etc/octillion/host-role, root-owned) names the same role
 *  3. the provider's own indicators:
 *     - boat (seen on live boat VMs, 2026-10-10): BOAT_ID or BOX_ID in the env, /etc/ascii and /home/user/.ascii present
 *       (boat's agent + CLI); when the marker records a sandbox id and BOAT_ID looks like one (bx_...), they match
 *     - vercel (docs: vercel.com/docs/sandbox/concepts, "Proxy CA certificates"; the node24 image): the per-sandbox proxy
 *       CA Vercel mounts in every sandbox (/etc/pki/ca-trust/source/anchors/vercel-proxy-ca.pem or
 *       /usr/local/share/ca-certificates/vercel-proxy-ca.pem) and the /vercel tree (/vercel/runtimes, /vercel/sandbox);
 *       OCTILLION_SANDBOX_ID (the env file) matches the marker's sandbox; and none of the hosting markers of a Vercel
 *       *function* (VERCEL_REGION, AWS_LAMBDA_FUNCTION_NAME): the API itself never runs agents
 * and RUNNER is `boat` or `vercel`.
 *
 * A machine of ours (the VM) has none of these files, so it is refused even if someone copies an env file onto it.
 * OCTILLION_DEV_ALLOW_LOCAL=1 bypasses all of it (tests and local development only) with a loud warning.
 */
import { existsSync, readFileSync } from "node:fs";

/** boat's role keeps its old name: running boat orchestrators and their markers stay valid. */
export const HOST_ROLE = "boat-orchestrator";
export const HOST_ROLES = { boat: "boat-orchestrator", vercel: "vercel-orchestrator" } as const;
export type HostProvider = keyof typeof HOST_ROLES;
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
  env.OCTILLION_HOST_ROLE === HOST_ROLES.vercel ? "vercel" : env.OCTILLION_HOST_ROLE === HOST_ROLES.boat ? "boat" : null;

export function checkHost(runner: string, probe: HostProbe = realProbe): GuardResult {
  const env = probe.env;
  if (env.OCTILLION_DEV_ALLOW_LOCAL === "1") {
    return {
      ok: true, dev: true, problems: [], provider: null,
      warning: [
        "#".repeat(78),
        "# OCTILLION_DEV_ALLOW_LOCAL=1: HOST GUARD DISABLED. Tests / local development ONLY.",
        `# This process may run coding agents on THIS machine (RUNNER=${runner}). Never set this in production:`,
        "# production orchestrators run only inside boat.dev or Vercel Sandbox orchestrator sandboxes (src/autoscaler.ts).",
        "#".repeat(78),
      ].join("\n"),
    };
  }
  const problems: string[] = [];
  // RUNNER picks the worker sandboxes (boat directly, or Vercel through the API broker); the host is checked below.
  if (runner !== "boat" && runner !== "vercel") problems.push(`RUNNER=${runner} is not allowed in production (only "boat" or "vercel"; pool/docker/local need OCTILLION_DEV_ALLOW_LOCAL=1, tests only)`);
  // The coding agent runs task text written by customers: never as boat's sudo-capable user (docs/security.md).
  if (env.BOAT_AGENT_USER === "user") problems.push("BOAT_AGENT_USER=user runs the coding agent with passwordless sudo; not allowed in production (the default agent user has none)");
  const provider = claimedProvider(env);
  const role = provider ? HOST_ROLES[provider] : HOST_ROLE;
  if (!provider) problems.push(`OCTILLION_HOST_ROLE is not "${HOST_ROLES.boat}" or "${HOST_ROLES.vercel}" (set by the launcher's env file)`);
  const markerRaw = probe.read(MARKER_PATH);
  let marker: { role?: string; sandbox_id?: string } | null = null;
  try { marker = markerRaw ? JSON.parse(markerRaw) : null; } catch { marker = null; }
  if (marker?.role !== role) problems.push(`launcher marker ${MARKER_PATH} is missing or not a ${role} marker`);
  if (provider === "vercel") {
    if (!VERCEL_PROXY_CA.some((p) => probe.exists(p))) problems.push("Vercel Sandbox proxy CA (vercel-proxy-ca.pem) not found (not a Vercel Sandbox VM?)");
    if (!VERCEL_TREE.some((p) => probe.exists(p))) problems.push("no /vercel/runtimes or /vercel/sandbox (not a Vercel Sandbox VM?)");
    if (env.VERCEL_REGION || env.AWS_LAMBDA_FUNCTION_NAME) problems.push("this is a Vercel function, not a Vercel Sandbox: the API never runs orchestrators");
    const sid = env.OCTILLION_SANDBOX_ID;
    if (!sid) problems.push("no OCTILLION_SANDBOX_ID in the environment (set by the launcher's env file)");
    else if (marker?.sandbox_id && sid !== marker.sandbox_id) problems.push(`OCTILLION_SANDBOX_ID ${sid} does not match the launcher marker's sandbox ${marker.sandbox_id}`);
  } else {
    // boat (also what an env file without a role is checked against): unchanged since 2026-10-10.
    const boatId = env.BOAT_ID ?? env.BOX_ID;
    if (!boatId) problems.push("no BOAT_ID/BOX_ID in the environment (not a boat.dev VM?)");
    if (!probe.exists("/etc/ascii") || !probe.exists("/home/user/.ascii")) problems.push("boat agent files (/etc/ascii, /home/user/.ascii) not found (not a boat.dev VM?)");
    if (marker?.sandbox_id && boatId && /^bx_/.test(boatId) && boatId !== marker.sandbox_id)
      problems.push(`BOAT_ID ${boatId} does not match the launcher marker's sandbox ${marker.sandbox_id}`);
  }
  return { ok: problems.length === 0, dev: false, problems, provider };
}

/** Throw unless this process may run as an orchestrator here. Prints the dev warning loudly when bypassed. */
let warned = false;
export function assertOrchestratorHost(runner: string, probe: HostProbe = realProbe): void {
  const r = checkHost(runner, probe);
  if (r.warning && !warned) { console.error(r.warning); warned = true; }
  if (!r.ok) {
    throw new Error(
      "Refusing to start: the Octillion orchestrator runs only inside a boat.dev or Vercel Sandbox orchestrator sandbox " +
      "(the server's autoscaler launches them; manually: `npm run boat-orchestrators -- up <n>` from orchestrator/).\n  - " + r.problems.join("\n  - "));
  }
}
