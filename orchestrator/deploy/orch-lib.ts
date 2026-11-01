/**
 * Orchestrator code and launch types, shared by the Vercel Sandbox host (deploy/vercel-orch.ts) and the server's
 * autoscaler (src/autoscaler.ts). Nothing here calls a provider or runs agent code on the calling machine.
 *
 * Callers pass an explicit LaunchContext (public server URL, worker token, pod capacity, tuning). The worker token only
 * ever goes into the orchestrator sandbox's 0600 env file.
 */
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/**
 * Sandbox names start with a namespace so two deployments sharing one Vercel project never touch each other's sandboxes:
 * each reaper deletes "orphans" by name prefix. OCTILLION_SANDBOX_NAMESPACE, else "octv" on Vercel and "octi" elsewhere.
 * Orchestrators get it as a tuning var, so their worker sandbox name hints carry it too.
 */
export const SANDBOX_NAMESPACE = (process.env.OCTILLION_SANDBOX_NAMESPACE || (process.env.VERCEL ? "octv" : "octi")).toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 8) || "octi";
/** Non-secret tuning knobs that may go into an orchestrator's env file (nothing else is ever written). */
export const TUNING_VARS = ["ORCHESTRATOR_MODEL", "MAX_SESSION_MINUTES", "MAX_BUDGET_USD", "MAX_USER_TURNS", "ORCHESTRATOR_THINKING",
  "RESEARCH_MAX_COST_USD", "OCTILLION_ORCH_IDLE_MINUTES", "MAX_AGENT_TURNS", "GIVE_UP_RUNS", "ORCHESTRATOR_JOB", "OCTILLION_ZED_ACP", "OCTILLION_EGRESS", "OCTILLION_SANDBOX_NAMESPACE"] as const;

export interface LaunchContext {
  url: string;               // public HTTPS server URL
  workerToken: string;       // goes ONLY into the orchestrator sandbox's 0600 env file
  podCapacity: number;
  tuning?: Record<string, string>;
  root?: string;             // repo root holding orchestrator/ + harnesses/registry.json
  log?: (msg: string) => void;
  placeholderToken?: boolean; // selftest: never ship the real token
}

// ---------------------------------------------------------------- budget (pure; unit-tested)

/** A provider's sandbox limits (Vercel: configured, see VERCEL_ORCH; HostLimits has the same shape). */
export interface SandboxLimits { activeSandboxes: number; startsPerMinute: number; startsPerHour: number; startsPerDay: number; activeNow: number }
export interface Budget {
  plan: number; perOrchestrator: number; maxOrchestrators: number; requested: number; requestedSandboxes: number;
  otherActive: number; available: number; ok: boolean; startsPerDay: number; sessionsPerDayCeiling: number; reason?: string;
}

/** Each orchestrator = 1 sandbox + up to podCapacity worker sandboxes, all counted against the concurrency limit. */
export function computeBudget(limits: SandboxLimits, n: number, podCapacity: number, oursActive = 0): Budget {
  const perOrchestrator = 1 + podCapacity;
  const otherActive = Math.max(0, limits.activeNow - oursActive);
  const available = limits.activeSandboxes - otherActive;
  const requestedSandboxes = n * perOrchestrator;
  const maxOrchestrators = Math.max(0, Math.floor(available / perOrchestrator));
  const ok = n >= 0 && requestedSandboxes <= available;
  return {
    plan: limits.activeSandboxes, perOrchestrator, maxOrchestrators, requested: n, requestedSandboxes, otherActive, available, ok,
    startsPerDay: limits.startsPerDay, sessionsPerDayCeiling: Math.max(0, limits.startsPerDay - n),
    reason: ok ? undefined : `${n} orchestrators x (1 + ${podCapacity}) = ${requestedSandboxes} sandboxes > ${available} available (limit ${limits.activeSandboxes} - ${otherActive} other active); max ${maxOrchestrators}`,
  };
}

// ---------------------------------------------------------------- code: files, hash, tarball

const CODE_EXCLUDE = /(^|\/)(node_modules|\.pi-upstream|pi-upstream|test)(\/|$)|^orchestrator\/harnesses\/fixtures(\/|$)/;

/** The files an orchestrator needs: orchestrator/ (no node_modules, Pi clone, tests, fixtures) + the registry. */
export function codeFiles(root = REPO_ROOT): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (CODE_EXCLUDE.test(r)) continue;
      if (e.isDirectory()) walk(r); else if (e.isFile()) out.push(r);
    }
  };
  walk("orchestrator");
  if (statSync(path.join(root, "harnesses/registry.json"), { throwIfNoEntry: false })) out.push("harnesses/registry.json");
  return out.sort();
}

/** What every orchestrator needs besides its TypeScript: the agent install scripts, starter repos and the registry. */
export const REQUIRED_CODE = ["orchestrator/images/setup/_common.sh", "orchestrator/images/setup/claude-code.sh", "orchestrator/workspaces/", "harnesses/registry.json"];

/** Content hash of the orchestrator code: keys the snapshot image (and tells a fleet orchestrator its code is old). */
export function codeHash(root = REPO_ROOT): string {
  const h = createHash("sha256");
  for (const f of codeFiles(root)) { h.update(f + "\0"); h.update(readFileSync(path.join(root, f))); h.update("\0"); }
  return h.digest("hex").slice(0, 16);
}

/** A gzipped ustar archive of the code, built in-process: serverless hosts (Vercel) have no `tar` binary. File modes
 *  are kept (the setup scripts are executable); owners, times and order are fixed so the bytes depend on content only. */
export function tarball(root = REPO_ROOT): Buffer {
  const blocks: Buffer[] = [];
  const files = codeFiles(root);
  // An orchestrator without these can't install a pinned agent or seed a starter repo: every session it ran would
  // fail (seen 2026-10-18, when the Vercel bundle left orchestrator/images out). Refuse to launch one instead.
  const missing = REQUIRED_CODE.filter((r) => !files.some((f) => f.startsWith(r)));
  if (missing.length) throw new Error(`orchestrator code is incomplete (missing ${missing.join(", ")}): check vercel.json includeFiles`);
  for (const f of files) {
    const data = readFileSync(path.join(root, f));
    const mode = statSync(path.join(root, f)).mode & 0o777;
    blocks.push(tarHeader(f, data.length, mode), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function tarHeader(name: string, size: number, mode: number): Buffer {
  const h = Buffer.alloc(512);
  // Names over 100 bytes go into the ustar prefix field, split at a slash.
  let prefix = "", base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`path too long for tar: ${name}`);
    prefix = name.slice(0, cut); base = name.slice(cut + 1);
  }
  const put = (v: string, off: number, len: number) => h.write(v, off, len, "utf8");
  const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";
  put(base, 0, 100); put(oct(mode, 8), 100, 8); put(oct(0, 8), 108, 8); put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12); put(oct(0, 12), 136, 12); put("        ", 148, 8); put("0", 156, 1);
  put("ustar\0", 257, 6); put("00", 263, 2); put(prefix, 345, 155);
  let sum = 0; for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

// ---------------------------------------------------------------- launch

export interface LaunchResult { sandboxId: string; orchId: string; fromImage: boolean; timings: Record<string, number>; preflight: { ok: boolean; reason: string } }

/** What a host's launch throws: the message says "<step> (<n>s): <error>"; the parts are also kept apart. */
export interface LaunchError extends Error { launchStep: string; launchError: string }
export const launchError = (e: unknown, step: string, t0: number): LaunchError => {
  const err = e instanceof Error ? e : new Error(String(e));
  const raw = err.message;
  // Say which step failed and how long in (a bare provider error does not).
  return Object.assign(err, { message: `${step} (${Math.round((Date.now() - t0) / 1000)}s): ${raw}`, launchStep: step, launchError: raw });
};
