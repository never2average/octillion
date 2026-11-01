/**
 * Where orchestrators run: the provider-neutral interface the server's autoscaler (src/autoscaler.ts) drives, implemented
 * by vercelHost({client}) (deploy/vercel-orch.ts: a bash supervisor instead of systemd, snapshots, static limits). The
 * client is the API's REST client (src/vercel-sandbox.ts) with the function's OIDC token: only the API can launch
 * orchestrators, and the token never enters a sandbox.
 *
 * Vercel Sandbox is the only provider. Rows from before boat.dev's retirement (2026-11-01) keep provider 'boat': they stay
 * readable (labels, sandbox cost estimates) but nothing launches or calls there any more.
 */
import type { HostProvider } from "../core/host-guard.js";
import type * as lib from "./orch-lib.js";
import { vercelOrchCostUsd } from "./vercel-orch.js";

export type { HostProvider };
export { vercelHost, vercelOrchCostUsd, VERCEL_ORCH, vercelOrchPrefix, type VercelSandboxApi } from "./vercel-orch.js";
/** Display names, including the retired provider old rows still name. */
export const PROVIDER_LABEL: Record<string, string> = { vercel: "Vercel Sandbox", boat: "boat.dev (retired)" };
/** An older row without a provider ran on boat.dev (migration 0017 filled 'boat' in). */
export const providerLabel = (p: string | null | undefined): string => PROVIDER_LABEL[p ?? "boat"] ?? String(p);
/** boat.dev small machine, $/hour (docs.boat.dev/pricing, 2026-10): only to estimate the cost of orchestrator rows from before its retirement. */
export const RETIRED_BOAT_SMALL_PER_HOUR = 0.018;

/** One sandbox as the provider lists or gets it. `id` is what the provider addresses it by (the Vercel sandbox name). */
export interface HostSandbox {
  id: string; name?: string; state: string; live: boolean; createdAt?: string;
  /** When the provider stops it by itself (from our launch record). */
  expiresAt?: number | null;
  type?: string;
}

export interface HostLimits {
  activeSandboxes: number; startsPerMinute: number; startsPerHour: number; startsPerDay: number; activeNow: number;
  /** Configured, not read from the provider (Vercel has no limits API). */
  static?: boolean;
}

export interface HostLaunchOpts {
  image?: string | null; ttlSeconds?: number; requirePreflight?: boolean;
  /** Epoch ms the launch must be done by (a 300 s function); past it the launch fails and its sandbox is deleted. Vercel host only. */
  deadline?: number;
  onCreated?: (sandboxId: string, orchId: string, info?: { expiresAt?: Date | null }) => Promise<void> | void;
}
export interface HostLaunchResult extends lib.LaunchResult { expiresAt?: number | null }

export interface OrchestratorHost {
  provider: HostProvider;
  label: string;
  /** Names of our orchestrator sandboxes on this provider (the orphan reaper's prefix). */
  orchPrefix: string;
  orchIdOf(sandboxId: string): string;
  /** Is this listed sandbox a stale image builder of ours (deleted after 30 minutes without a build running)? */
  isImageBuilder(name: string | undefined): boolean;
  /** The provider's listing of our orchestrator (and image builder) sandboxes. */
  list(): Promise<HostSandbox[]>;
  /** Authoritative get by id: null when the provider says it does not exist. Throws when it could not tell. */
  get(id: string): Promise<HostSandbox | null>;
  delete(id: string): Promise<void>;
  limits(): Promise<HostLimits>;
  launch(ctx: lib.LaunchContext, opts?: HostLaunchOpts): Promise<HostLaunchResult>;
  /** Graceful stop (SIGTERM: the orchestrator kills its sessions and leaves the fleet). */
  stop(id: string): Promise<string>;
  logs(id: string, lines: number): Promise<string>;
  /** Machine size label, and the estimated sandbox cost of an orchestrator living `seconds`. */
  sandboxType: string;
  estCostUsd(seconds: number): number;
  /** Optional fast-start image (a Vercel snapshot) for the current code. */
  image?: {
    /** The handle to launch from (the snapshot id), or null when none is ready. */
    ready(hash: string): Promise<string | null>;
    build(ctx: Pick<lib.LaunchContext, "root" | "log">): Promise<{ name: string; ms: number }>;
  };
}

/** The estimated sandbox cost of an orchestrator row on its provider (the Compute and job pages; old boat rows included). */
export function orchSandboxCostUsd(provider: string | null | undefined, seconds: number): number {
  return provider === "vercel" ? vercelOrchCostUsd(seconds) : (Math.max(0, seconds) / 3600) * RETIRED_BOAT_SMALL_PER_HOUR;
}
