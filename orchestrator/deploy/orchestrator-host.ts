/**
 * Where orchestrators run: the provider-neutral interface the server's autoscaler (src/autoscaler.ts) and the CLI
 * launcher (deploy/boat-orchestrators.ts) drive, with one implementation per sandbox provider:
 *
 *   boatHost()            boat.dev, exactly as before (deploy/boat-lib.ts: systemd unit, named snapshot images, /limits)
 *   vercelHost({client})  Vercel Sandbox (deploy/vercel-orch.ts: a bash supervisor instead of systemd, snapshots, static
 *                         limits). The client is the API's REST client (src/vercel-sandbox.ts) with the function's OIDC
 *                         token: only the API can launch Vercel orchestrators, and the token never enters a sandbox.
 *
 * Selection (orchestratorProvider): OCTILLION_ORCHESTRATOR_PROVIDER, else OCTILLION_SANDBOX_PROVIDER (the switch that
 * already moves the worker sandboxes), else boat. API calls only: nothing here runs agent code on the calling machine.
 */
import { BOAT_PRICE_PER_HOUR } from "../core/config.js";
import { boatApi, BoatError } from "../core/boat.js";
import type { HostProvider } from "../core/host-guard.js";
import * as lib from "./boat-lib.js";
import { vercelOrchCostUsd } from "./vercel-orch.js";

export type { HostProvider };
export { vercelHost, vercelOrchCostUsd, VERCEL_ORCH, vercelOrchPrefix, type VercelSandboxApi } from "./vercel-orch.js";
export const PROVIDER_LABEL: Record<HostProvider, string> = { boat: "boat.dev", vercel: "Vercel Sandbox" };
export const providerLabel = (p: string | null | undefined): string => PROVIDER_LABEL[(p === "vercel" ? "vercel" : "boat") as HostProvider];

const pick = (v: string | undefined): HostProvider | null => {
  const s = (v ?? "").trim().toLowerCase();
  return s === "vercel" ? "vercel" : s === "boat" ? "boat" : null;
};
/** Which provider new orchestrators start on: one switch (OCTILLION_SANDBOX_PROVIDER) with an orchestrator-only override. */
export function orchestratorProvider(env: Record<string, string | undefined> = process.env): HostProvider {
  return pick(env.OCTILLION_ORCHESTRATOR_PROVIDER) ?? pick(env.OCTILLION_SANDBOX_PROVIDER) ?? "boat";
}
/** Which provider worker sandboxes use (what the orchestrator credentials answer `sandbox_provider`). */
export function workerProvider(env: Record<string, string | undefined> = process.env): HostProvider {
  return pick(env.OCTILLION_SANDBOX_PROVIDER) ?? "boat";
}

/** One sandbox as a provider lists or gets it. `id` is what the provider addresses it by (boat bx_ id, Vercel name). */
export interface HostSandbox {
  id: string; name?: string; state: string; live: boolean; createdAt?: string;
  /** When the provider stops it by itself (boat archiveAfter; Vercel: from our launch record). */
  expiresAt?: number | null;
  /** boat's raw field, kept for the Compute page's TTL. */
  archiveAfter?: string | null; type?: string;
}

export interface HostLimits {
  activeSandboxes: number; startsPerMinute: number; startsPerHour: number; startsPerDay: number; activeNow: number;
  /** Configured, not read from the provider (Vercel has no limits API). */
  static?: boolean;
}

export interface HostLaunchOpts {
  image?: string | null; ttlSeconds?: number; requirePreflight?: boolean;
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
  /** The provider's listing of our orchestrator (and image builder) sandboxes; boat: the whole account (budget, workers). */
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
  /** Optional fast-start image (boat named snapshot, Vercel snapshot) for the current code. */
  image?: {
    /** The handle to launch from (boat: the snapshot name; Vercel: the snapshot id), or null when none is ready. */
    ready(hash: string): Promise<string | null>;
    build(ctx: Pick<lib.LaunchContext, "root" | "log">): Promise<{ name: string; ms: number }>;
  };
}

// ---------------------------------------------------------------- boat.dev

const fromBoat = (s: lib.Sb): HostSandbox => ({ ...s, live: lib.isLive(s), expiresAt: s.archiveAfter ? Date.parse(s.archiveAfter) : null });

/** boat.dev: deploy/boat-lib.ts unchanged (BOAT.apiKey set by the caller). */
export function boatHost(): OrchestratorHost {
  return {
    provider: "boat", label: PROVIDER_LABEL.boat, orchPrefix: lib.ORCH_PREFIX, orchIdOf: lib.orchIdOf,
    isImageBuilder: (name) => name === lib.IMAGE_BUILDER_NAME,
    list: async () => (await lib.listSandboxes()).map(fromBoat),
    async get(id) {
      try { const r = await boatApi(`/sandboxes/${encodeURIComponent(id)}`); return r?.sandbox ? fromBoat({ id, ...r.sandbox }) : null; }
      catch (e) { if (e instanceof BoatError && e.status === 404) return null; throw e; }
    },
    delete: lib.deleteSandbox,
    limits: lib.boatLimits,
    launch: (ctx, opts) => lib.launchOrchestrator(ctx, opts),
    stop: lib.stopService,
    logs: async (id, lines) => { const r = await lib.run(id, `journalctl -u ${lib.UNIT} -n ${lines} --no-pager 2>&1 | tail -n ${lines}`, 60); return r.stdout || r.stderr; },
    sandboxType: lib.ORCH_SANDBOX_TYPE,
    estCostUsd: (seconds) => (Math.max(0, seconds) / 3600) * (BOAT_PRICE_PER_HOUR[lib.ORCH_SANDBOX_TYPE] ?? 0),
    image: {
      async ready(hash) { const name = lib.imageName(hash); return (await lib.imageStatus(name).catch(() => "missing")) === "ready" ? name : null; },
      build: (ctx) => lib.buildImage(ctx),
    },
  };
}

/** The estimated sandbox cost of an orchestrator row on its provider (the Compute and job pages). */
export function orchSandboxCostUsd(provider: string | null | undefined, seconds: number): number {
  return provider === "vercel" ? vercelOrchCostUsd(seconds) : (Math.max(0, seconds) / 3600) * (BOAT_PRICE_PER_HOUR[lib.ORCH_SANDBOX_TYPE] ?? 0);
}
