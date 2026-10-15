/**
 * Private customer assets (docs/security.md, phase 1): the personas, task sets and harnesses an organization brings.
 * They belong to that organization alone: every query here is scoped to `org.orgId`, nothing here ever writes the
 * public data (library_tasks, shared developer_profiles), and nothing outside the org can list, use or detect them.
 *
 *  - personas: developer_profiles rows with source 'custom' and the org as owner (the table's CHECK enforces an owner);
 *    random `per_` slugs, so another org can neither guess nor collide with them.
 *  - task sets: org_task_sets, whose tasks become the product's scenarios (source 'custom', task_set_id).
 *  - harnesses: org_harnesses, a declarative spec plus a review status; nothing runs until a harness is approved and
 *    built in isolation (phase 2).
 */
import { randomBytes } from "node:crypto";
import { getDb } from "./db.js";
import type { Org } from "./auth.js";
import { resolveProduct, checkTemplate, checkPlatform } from "./queries.js";
import { platformOf } from "./platform.js";
import { environmentIssues, type PersonaEnvironment } from "../orchestrator/core/environment.js";

const rid = (prefix: string) => `${prefix}_${randomBytes(9).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
/** Strip control, bidi and zero-width characters (they can hide text from a reviewer) and trim. */
export const cleanText = (s: unknown, max: number, what: string): string => {
  const t = String(s ?? "").normalize("NFKC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, "").trim();
  if (t.length > max) throw new Error(`${what} is too long (${t.length} characters; at most ${max})`);
  return t;
};

// ---------- personas ----------

export interface PersonaInput {
  slug?: string; name: string; summary?: string; instructions?: string;
  attributes?: Record<string, unknown>; environment?: PersonaEnvironment | null; active?: boolean;
}

export async function savePersonas(org: Org, items: PersonaInput[]) {
  if (!Array.isArray(items) || !items.length || items.length > 20) throw new Error("Send 1-20 personas");
  const db = await getDb();
  const saved: string[] = [];
  await db.transaction(async (tx) => {
    for (const [i, x] of items.entries()) {
      const name = cleanText(x.name, 80, `personas[${i}].name`);
      if (!name) throw new Error(`personas[${i}].name is required`);
      const summary = cleanText(x.summary, 600, `personas[${i}].summary`);
      const instructions = cleanText(x.instructions, 1500, `personas[${i}].instructions`);
      const attributes = x.attributes && typeof x.attributes === "object" && !Array.isArray(x.attributes) ? x.attributes : {};
      if (JSON.stringify(attributes).length > 1500) throw new Error(`personas[${i}].attributes is too large (at most 1500 characters as JSON)`);
      const envIssues = x.environment ? environmentIssues(x.environment) : [];
      if (envIssues.length) throw new Error(`personas[${i}].environment: ${envIssues.join("; ")}`);
      const env = x.environment ? JSON.stringify({ editor: x.environment.editor, tools: x.environment.tools ?? [], skills: x.environment.skills ?? [],
                                                    agent_rules: x.environment.agent_rules ?? null }) : null;
      if (x.slug) {
        const [row] = await tx.query<{ slug: string }>(
          `UPDATE developer_profiles SET name = $3, summary = $4, instructions = $5, attributes = $6, environment = coalesce($7, environment),
                  active = coalesce($8, active), synced_at = now()
            WHERE slug = $1 AND org_id = $2 AND source = 'custom' RETURNING slug`,
          [x.slug, org.orgId, name, summary, instructions, JSON.stringify(attributes), env, x.active ?? null]);
        if (!row) throw new Error(`No persona ${x.slug}. See list_personas.`); // same message whether or not it exists elsewhere
        saved.push(row.slug);
      } else {
        const slug = rid("per");
        await tx.query(
          `INSERT INTO developer_profiles (slug, name, summary, instructions, attributes, environment, org_id, source, active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'custom', true)`,
          [slug, name, summary, instructions, JSON.stringify(attributes), env, org.orgId]);
        saved.push(slug);
      }
    }
  });
  return listPersonas(org, saved);
}

/** The organization's own personas: brought (custom) and picked or written for it by research. Never another org's. */
export async function listPersonas(org: Org, highlight: string[] = []) {
  const personas = await (await getDb()).query(
    `SELECT slug, name, summary, attributes, instructions, environment, source, active, product_id
       FROM developer_profiles WHERE org_id = $1 ORDER BY source, name`, [org.orgId]);
  return { view: "personas" as const, personas, saved: highlight };
}

// ---------- task sets ----------

export interface TaskInput {
  title?: string; prompt: string; language?: string; tags?: string[]; platform?: string; template?: string | null;
  repo_url?: string; expectation?: "recommend" | "avoid"; provenance?: string;
}

export async function importTasks(org: Org, input: { product?: string; task_set: string; description?: string; tasks: TaskInput[] }) {
  const p = await resolveProduct(org, input.product);
  const setName = cleanText(input.task_set, 120, "task_set");
  if (!setName) throw new Error("task_set (a name for this set, e.g. '2025 case studies') is required");
  if (!Array.isArray(input.tasks) || !input.tasks.length || input.tasks.length > 200) throw new Error("Send 1-200 tasks");
  const db = await getDb();
  let setId = 0;
  await db.transaction(async (tx) => {
    const [set] = await tx.query<{ id: number }>(
      `INSERT INTO org_task_sets (public_id, org_id, product_id, name, description) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id, product_id, name) DO UPDATE SET description = coalesce(excluded.description, org_task_sets.description)
       RETURNING id`,
      [rid("tset"), org.orgId, p.id, setName, input.description ? cleanText(input.description, 2000, "description") : null]);
    setId = set!.id;
    for (const [i, t] of input.tasks.entries()) {
      const prompt = cleanText(t.prompt, 6000, `tasks[${i}].prompt`);
      if (prompt.length < 20) throw new Error(`tasks[${i}].prompt must be at least 20 characters`);
      if (t.repo_url != null && !/^https:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}\/\S+$/.test(t.repo_url))
        throw new Error(`tasks[${i}].repo_url must be an https URL of a public git host`);
      const template = checkTemplate(t.template);
      const platform = checkPlatform(t.platform) ?? platformOf({ template, language: t.language, tags: t.tags, prompt });
      await tx.query(
        `INSERT INTO scenarios (product_id, title, prompt, repo_url, language, tags, expectation, active, source, rationale, template, platform, task_set_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, 'custom', $8, $9, $10, $11)`,
        [p.id, cleanText(t.title, 160, `tasks[${i}].title`) || prompt.slice(0, 80), prompt, t.repo_url ?? null,
         t.language ? cleanText(t.language, 40, `tasks[${i}].language`) : null, (t.tags ?? []).slice(0, 20).map((x) => cleanText(x, 40, "tag")),
         t.expectation === "avoid" ? "avoid" : "recommend", t.provenance ? cleanText(t.provenance, 500, `tasks[${i}].provenance`) : null,
         template ?? null, platform, setId]);
    }
  });
  return listTaskSets(org, p.slug);
}

export async function listTaskSets(org: Org, product?: string) {
  const db = await getDb();
  const params: unknown[] = [org.orgId];
  let where = "ts.org_id = $1";
  if (product) params.push((await resolveProduct(org, product)).id), (where += " AND ts.product_id = $2");
  const sets = await db.query(
    `SELECT ts.public_id AS id, ts.name, ts.description, p.slug AS product, ts.created_at,
            count(sc.id) FILTER (WHERE sc.active) AS active_tasks,
            jsonb_agg(jsonb_build_object('id', sc.id, 'title', sc.title, 'platform', sc.platform, 'expectation', sc.expectation, 'active', sc.active)
                      ORDER BY sc.id) FILTER (WHERE sc.id IS NOT NULL) AS tasks
       FROM org_task_sets ts JOIN products p ON p.id = ts.product_id AND p.org_id = ts.org_id
       LEFT JOIN scenarios sc ON sc.task_set_id = ts.id
      WHERE ${where} GROUP BY ts.id, p.slug ORDER BY ts.created_at DESC`, params);
  return { view: "task_sets" as const, task_sets: sets };
}

/** Scenario ids of an org's task set (by public id or name), for run_simulation {task_set}. */
export async function taskSetScenarioIds(org: Org, productId: number, ref: string): Promise<number[]> {
  const rows = await (await getDb()).query<{ id: number }>(
    `SELECT sc.id FROM scenarios sc JOIN org_task_sets ts ON ts.id = sc.task_set_id
      WHERE ts.org_id = $1 AND ts.product_id = $2 AND (ts.public_id = $3 OR ts.name = $3) AND sc.active ORDER BY sc.id`,
    [org.orgId, productId, ref]);
  if (!rows.length) throw new Error(`No task set ${ref} with active tasks. See list_task_sets.`);
  return rows.map((r) => r.id);
}

// ---------- harnesses ----------

export const HARNESS_EVENT_FORMATS = ["octillion-jsonl", "claude-stream-json", "codex-json", "acp"] as const;
const ARGV_PART = /^([A-Za-z0-9._/@:=+-]{1,200}|\{model\}|\{session_id\}|\{prompt_file\})$/;

export interface HarnessSpec {
  name: string; version: string;
  install: ({ npm: string; version: string; integrity: string } | { pip: string; hashes: string[] } | { tarball: string; sha256: string })[];
  allow_install_scripts?: boolean; bin: string; launch_argv: string[]; resume_argv?: string[];
  event_format: (typeof HARNESS_EVENT_FORMATS)[number]; providers: string[]; egress_hosts?: string[];
}

/** Validation of a customer harness spec: declarative only, pinned by integrity hashes, gateway providers only. */
export function harnessSpecIssues(s: any, gatewayProviders: string[]): string[] {
  const out: string[] = [];
  if (!s || typeof s !== "object") return ["spec must be an object"];
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(s.name ?? "")) out.push("name: 2-41 lowercase letters, digits and dashes");
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(s.version ?? "")) out.push("version: 1-40 characters [A-Za-z0-9._-]");
  if (!Array.isArray(s.install) || !s.install.length || s.install.length > 10) out.push("install: 1-10 items");
  for (const [i, it] of (Array.isArray(s.install) ? s.install : []).entries()) {
    if (it?.npm) { if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(it.npm) || !/^\d+\.\d+\.\d+/.test(it.version ?? "") || !/^sha512-[A-Za-z0-9+/=]{80,}$/.test(it.integrity ?? "")) out.push(`install[${i}]: npm needs a package name, an exact version and its sha512 integrity`); }
    else if (it?.pip) { if (!/^[A-Za-z0-9._-]+==[A-Za-z0-9.+-]+$/.test(it.pip) || !Array.isArray(it.hashes) || !it.hashes.length || it.hashes.some((h: unknown) => !/^sha256:[a-f0-9]{64}$/.test(String(h)))) out.push(`install[${i}]: pip needs name==version and sha256 hashes`); }
    else if (it?.tarball) { if (!/^https:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}\/\S+$/.test(it.tarball) || !/^[a-f0-9]{64}$/.test(it.sha256 ?? "")) out.push(`install[${i}]: tarball needs an https URL and its sha256`); }
    else out.push(`install[${i}]: one of npm, pip or tarball`);
  }
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(s.bin ?? "")) out.push("bin: the executable name");
  for (const k of ["launch_argv", "resume_argv"]) {
    const argv = s[k];
    if (argv == null && k === "resume_argv") continue;
    if (!Array.isArray(argv) || !argv.length || argv.length > 40 || argv.some((a: unknown) => typeof a !== "string" || !ARGV_PART.test(a)))
      out.push(`${k}: 1-40 arguments of [A-Za-z0-9._/@:=+-] or the placeholders {model}, {session_id}, {prompt_file}; no shell`);
  }
  if (!(HARNESS_EVENT_FORMATS as readonly string[]).includes(s.event_format)) out.push(`event_format: one of ${HARNESS_EVENT_FORMATS.join(", ")}`);
  if (!Array.isArray(s.providers) || !s.providers.length || s.providers.some((p: unknown) => !gatewayProviders.includes(String(p))))
    out.push(`providers: model providers it calls, through the Octillion gateway only: ${gatewayProviders.join(", ")} (real vendor keys are never given to customer harnesses)`);
  if (s.egress_hosts != null && (!Array.isArray(s.egress_hosts) || s.egress_hosts.length > 10 || s.egress_hosts.some((h: unknown) => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(String(h)))))
    out.push("egress_hosts: up to 10 hostnames (extra hosts need review)");
  return out;
}

export async function registerHarness(org: Org, spec: HarnessSpec) {
  const db = await getDb();
  const gateway = (await db.query<{ slug: string }>("SELECT slug FROM vault_providers WHERE mode = 'gateway' AND enabled ORDER BY slug")).map((r) => r.slug);
  const issues = harnessSpecIssues(spec, gateway);
  if (issues.length) throw new Error(`Invalid harness spec: ${issues.join("; ")}`);
  const needsReview = Boolean(spec.allow_install_scripts) || Boolean(spec.egress_hosts?.length);
  const [row] = await db.query<{ id: string }>(
    `INSERT INTO org_harnesses (id, org_id, name, version_label, spec, status, providers, event_format, egress_hosts, status_reason)
     VALUES ($1, $2, $3, $4, $5, 'submitted', $6, $7, $8, $9)
     ON CONFLICT (org_id, name, version_label) DO UPDATE SET spec = excluded.spec, status = 'submitted', providers = excluded.providers,
       event_format = excluded.event_format, egress_hosts = excluded.egress_hosts, status_reason = excluded.status_reason, updated_at = now()
     RETURNING id`,
    [rid("oh"), org.orgId, spec.name, spec.version, JSON.stringify(spec), spec.providers, spec.event_format, spec.egress_hosts ?? [],
     needsReview ? "needs review: install scripts or extra egress hosts" : "queued for an isolated build and scan"]);
  return listHarnesses(org, row!.id);
}

/** The organization's own harnesses (never another org's; artifact locations are internal and not returned). */
export async function listHarnesses(org: Org, highlight?: string) {
  const harnesses = await (await getDb()).query(
    `SELECT id, name, version_label AS version, status, status_reason, providers, event_format, egress_hosts, artifact_digest,
            scan_summary, created_at, updated_at
       FROM org_harnesses WHERE org_id = $1 ORDER BY name, created_at DESC`, [org.orgId]);
  return { view: "harnesses" as const, harnesses, saved: highlight ?? null };
}
