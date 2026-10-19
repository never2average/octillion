import { getDb } from "./db.js";

/**
 * Global platform settings (/admin/compute): knobs that used to be environment variables only. Each setting is keyed
 * by the variable it overrides; the value in force is
 *   platform_settings row (set on /admin)  ->  process.env[key]  ->  the code default below.
 * Readers stay synchronous: they read an in-process cache, loaded on the first request (and the first autoscaler
 * tick) and refreshed when older than 30s, so another replica's change (or a serverless instance's) lands within ~30s.
 * setSetting() updates this process's cache at once.
 */

export type SettingGroup = "models" | "runs" | "capacity" | "research" | "library";
export interface SettingDef {
  key: string; group: SettingGroup; label: string; help: string;
  kind: "text" | "int" | "number" | "choice";
  default: string | number;
  options?: string[]; min?: number; max?: number;
}

export const SETTING_GROUPS: { id: SettingGroup; label: string }[] = [
  { id: "models", label: "Models" },
  { id: "runs", label: "Runs" },
  { id: "capacity", label: "Capacity" },
  { id: "research", label: "Research" },
  { id: "library", label: "Library contributions" },
];

export const SETTINGS: SettingDef[] = [
  { key: "ORCHESTRATOR_MODEL", group: "models", label: "Orchestrator model", kind: "text", default: "gpt-6.1-sol",
    help: "The model each orchestrator thinks with (it plays the developer and drives the agents). Applies to orchestrators started after the change." },
  { key: "CLOUDFLARE_AI_MODEL", group: "models", label: "Research quick-pass model", kind: "text", default: "@cf/zai-org/glm-5.3-flash",
    help: "Cloudflare Workers AI model for the first, quick brief on an access request's company." },
  { key: "VERTEX_REGION", group: "models", label: "Vertex AI region", kind: "text", default: "us-east5",
    help: "Google Cloud region for Claude (and Gemini) on Vertex AI, e.g. us-east5, europe-west1, global. The project comes from the Vertex AI service-account key in Key vault." },
  { key: "OCTILLION_DEFAULT_SAMPLES", group: "runs", label: "Default samples per task", kind: "int", default: 10, min: 1, max: 1000,
    help: "Sessions per task when a run does not say how many." },
  { key: "OCTILLION_MAX_SAMPLES", group: "runs", label: "Most samples per task", kind: "int", default: 20, min: 1, max: 1000,
    help: "Adaptive sampling stops a task here even if its hit rate is still uncertain." },
  { key: "OCTILLION_MAX_SESSIONS_PER_RUN", group: "runs", label: "Most sessions per run", kind: "int", default: 100, min: 1, max: 100000,
    help: "A run that would start more sessions than this is refused." },
  { key: "OCTILLION_MAX_ORCHESTRATORS", group: "capacity", label: "Shared orchestrators", kind: "int", default: 4, min: 0, max: 1000,
    help: "Most shared orchestrators the autoscaler keeps running at once." },
  { key: "OCTILLION_MAX_JOB_ORCHESTRATORS", group: "capacity", label: "Per-job orchestrators", kind: "int", default: 12, min: 1, max: 1000,
    help: "Most one-job orchestrators (one per simulation or research job) running at once." },
  { key: "OCTILLION_JOB_POD_CAPACITY", group: "capacity", label: "Worker sandboxes per job", kind: "int", default: 40, min: 1, max: 50,
    help: "Worker sandboxes one per-job orchestrator runs at once." },
  { key: "BOAT_SANDBOX_SIZE", group: "capacity", label: "Sandbox size", kind: "choice", default: "default", options: ["small", "default", "large", "xlarge"],
    help: "boat.dev machine size for orchestrators started after the change and their worker sandboxes." },
  { key: "RESEARCH_MAX_COST_USD", group: "research", label: "Most spend per research job (USD)", kind: "number", default: 2, min: 0, max: 1000,
    help: "A deep research job stops once its model spend reaches this." },
  { key: "PROSPECT_DAILY_LIMIT", group: "research", label: "Deep research jobs a day from the landing form", kind: "int", default: 20, min: 0, max: 10000,
    help: "Access requests start at most this many deep research jobs a day. The Research button on a request is never capped." },
  { key: "PUBLISH_DISCOUNT_PERSONA_USD", group: "library", label: "Credit per accepted persona (USD)", kind: "number", default: 5, min: 0, max: 1000,
    help: "What an account earns, as a credit on its next Stripe invoice, when Octillion accepts a developer persona it published to the library. The reviewer can change it on Accept." },
  { key: "PUBLISH_DISCOUNT_TASK_USD", group: "library", label: "Credit per accepted task (USD)", kind: "number", default: 10, min: 0, max: 1000,
    help: "What an account earns, as a credit on its next Stripe invoice, when Octillion accepts a programming task it published to the library. The reviewer can change it on Accept." },
];
const DEFS = new Map(SETTINGS.map((d) => [d.key, d]));

const TTL_MS = 30_000;
let cache = new Map<string, { value: unknown; updated_at: string; updated_by: string | null }>();
let loadedAt = 0;
let loading: Promise<void> | null = null;

/** Reload the cache from Postgres (deduplicated). A failed load keeps the old values. */
export function refreshSettings(): Promise<void> {
  loading ??= (async () => {
    const rows = await (await getDb()).query<{ key: string; value: unknown; updated_at: Date; updated_by: string | null }>(
      "SELECT key, value, updated_at, updated_by FROM platform_settings");
    cache = new Map(rows.map((r) => [r.key, { value: r.value, updated_at: new Date(r.updated_at).toISOString(), updated_by: r.updated_by }]));
    loadedAt = Date.now();
  })().catch((e) => { console.error("settings: load failed:", (e as Error).message); }).finally(() => { loading = null; });
  return loading;
}

/** Resolve once the cache is at most 30s old (no-op when it is). Called per request and per autoscaler tick. */
export const freshSettings = (): Promise<void> => (Date.now() - loadedAt < TTL_MS ? Promise.resolve() : refreshSettings());

/** The value set on /admin, if any (from the cache). */
export const setting = (key: string): unknown => cache.get(key)?.value;

const envOf = (key: string) => { const v = process.env[key]; return v !== undefined && v.trim() !== "" ? v.trim() : undefined; };

/** The value in force: set here, else the environment, else the default. Numbers stay numbers. */
export function settingValue(key: string): string | number {
  const d = DEFS.get(key);
  if (!d) throw new Error(`Unknown setting ${key}`);
  const raw = setting(key) ?? envOf(key);
  if (raw === undefined) return d.default;
  if (d.kind === "int" || d.kind === "number") { const n = Number(raw); return Number.isFinite(n) ? n : d.default; }
  return String(raw);
}
export const settingNumber = (key: string) => Number(settingValue(key));
export const settingText = (key: string) => String(settingValue(key));

/** Checked and normalised, or an error message. */
function clean(d: SettingDef, v: unknown): { value: string | number } | { error: string } {
  if (d.kind === "int" || d.kind === "number") {
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : NaN;
    if (!Number.isFinite(n)) return { error: `${d.label} must be a number` };
    if (d.kind === "int" && !Number.isInteger(n)) return { error: `${d.label} must be a whole number` };
    if ((d.min !== undefined && n < d.min) || (d.max !== undefined && n > d.max)) return { error: `${d.label} must be between ${d.min} and ${d.max}` };
    return { value: n };
  }
  const s = typeof v === "string" ? v.trim() : "";
  if (d.kind === "choice") return d.options!.includes(s) ? { value: s } : { error: `${d.label} must be one of ${d.options!.join(", ")}` };
  // Model ids only: they go into orchestrator env files and provider requests.
  return /^[A-Za-z0-9@._\/:-]{1,100}$/.test(s) ? { value: s } : { error: `${d.label} must be a model id (letters, digits, @ . _ / : -)` };
}

export class SettingError extends Error { status = 400; }

/** Set (or, with null, reset to the environment / default) several settings at once. Returns what changed. */
export async function setSettings(actor: string, values: Record<string, unknown>) {
  const entries = Object.entries(values ?? {});
  if (!entries.length) throw new SettingError("Nothing to save");
  const changes: { key: string; from: unknown; to: unknown }[] = [];
  const checked: [SettingDef, string | number | null][] = [];
  for (const [key, v] of entries) {
    const d = DEFS.get(key);
    if (!d) throw new SettingError(`Unknown setting ${key}`);
    if (v === null) { checked.push([d, null]); continue; }
    const c = clean(d, v);
    if ("error" in c) throw new SettingError(c.error);
    checked.push([d, c.value]);
  }
  const db = await getDb();
  await db.transaction(async (tx) => {
    for (const [d, v] of checked) {
      const before = setting(d.key) ?? null;
      if (v === null) await tx.query("DELETE FROM platform_settings WHERE key = $1", [d.key]);
      else await tx.query(
        `INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
        [d.key, JSON.stringify(v), actor]);
      if (JSON.stringify(before) !== JSON.stringify(v)) changes.push({ key: d.key, from: before, to: v });
    }
  });
  await refreshSettings();
  return changes;
}

/** Every setting with the value in force and where it comes from (for /admin/compute). */
export async function listSettings() {
  await freshSettings();
  return SETTINGS.map((d) => {
    const row = cache.get(d.key), env = envOf(d.key);
    return {
      ...d, value: settingValue(d.key), source: row ? "set" as const : env !== undefined ? "env" as const : "default" as const,
      env: env ?? null, updated_at: row?.updated_at ?? null, updated_by: row?.updated_by ?? null,
    };
  });
}
