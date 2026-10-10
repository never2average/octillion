/**
 * Harness adapters: everything harness-specific lives here, keyed by the `harness` ids of the repo-root
 * `harnesses/registry.json` (maintained separately; this file never writes it).
 *
 * An adapter knows: the CLI binary, the API-key env it needs, the launch argv (prompt on stdin), the resume
 * argv (reply on stdin), how to find the conversation id in its JSONL, and how to digest a run's events into
 * "last assistant text + commands run + files touched" for the orchestrator brain.
 *
 * Verified against the locally installed CLIs (claude 2.1.296 `--help`, codex 0.162 `exec resume --help`).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ArgvOptions {
  model: string;
  /** Absolute workdir inside the sandbox (the process cwd is already set to it by the runner). */
  workdir: string;
  maxBudgetUsd?: string;
  /** Binary override (local runner only). */
  bin?: string;
}

export interface ApiKeys { anthropic: string; openai: string }

/** What the brain sees after each harness run. */
export interface TurnDigest {
  lastText: string;
  commands: string[];
  files: string[];
  /** Harness conversation id seen in this run (session_id / thread_id). */
  sessionId: string | null;
  /** The harness reported an error in-band (e.g. Claude `result.is_error`, Codex `turn.failed`). */
  error: string | null;
}

export interface HarnessAdapter {
  /** Registry id, e.g. "claude-code". */
  id: string;
  supported: true;
  bin: string;
  /** Env for the harness process only (API key + quiet flags). Nothing Octillion-specific. */
  env(keys: ApiKeys): Record<string, string>;
  /** Is the key this harness needs present? */
  hasKey(keys: ApiKeys): boolean;
  launchArgv(o: ArgvOptions): string[];
  resumeArgv(o: ArgvOptions & { sessionId: string }): string[];
  newDigest(): DigestBuilder;
}

export interface DigestBuilder {
  observe(ev: Record<string, any>): void;
  result(): TurnDigest;
}

const QUIET_ENV = { DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", NO_COLOR: "1", CI: "1" };
const MAX_ITEMS = 40;

function pushUnique(list: string[], v: unknown, max = MAX_ITEMS) {
  if (typeof v !== "string" || !v) return;
  const s = v.length > 300 ? v.slice(0, 300) + "…" : v;
  if (!list.includes(s)) list.push(s);
  if (list.length > max) list.shift();
}

// ---------------------------------------------------------------- Claude Code

const claudeCode: HarnessAdapter = {
  id: "claude-code",
  supported: true,
  bin: "claude",
  env: (k) => ({ ...QUIET_ENV, ANTHROPIC_API_KEY: k.anthropic }),
  hasKey: (k) => !!k.anthropic,
  // Session persistence stays ON (no --no-session-persistence): `--resume` needs the stored session.
  launchArgv: (o) => [
    o.bin ?? "claude", "-p",
    "--output-format", "stream-json", "--verbose",
    "--model", o.model,
    "--dangerously-skip-permissions",
    ...(o.maxBudgetUsd ? ["--max-budget-usd", o.maxBudgetUsd] : []),
  ],
  resumeArgv: (o) => [
    o.bin ?? "claude", "-p",
    "--resume", o.sessionId,
    "--output-format", "stream-json", "--verbose",
    "--model", o.model,
    "--dangerously-skip-permissions",
    ...(o.maxBudgetUsd ? ["--max-budget-usd", o.maxBudgetUsd] : []),
  ],
  newDigest() {
    const d: TurnDigest = { lastText: "", commands: [], files: [], sessionId: null, error: null };
    let resultText: string | null = null;
    return {
      observe(ev) {
        if (typeof ev.session_id === "string" && (ev.type === "system" || !d.sessionId)) d.sessionId = ev.session_id;
        if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
          const texts: string[] = [];
          for (const c of ev.message.content) {
            if (c?.type === "text" && typeof c.text === "string") texts.push(c.text);
            if (c?.type === "tool_use") {
              const inp = c.input ?? {};
              if (typeof inp.command === "string") pushUnique(d.commands, inp.command);
              for (const k of ["file_path", "path", "notebook_path"]) pushUnique(d.files, inp[k]);
            }
          }
          if (texts.length) d.lastText = texts.join("\n");
        }
        if (ev.type === "result") {
          if (typeof ev.result === "string" && ev.result.trim()) resultText = ev.result;
          if (ev.is_error) d.error = String(ev.result ?? ev.subtype ?? "claude error").slice(0, 1000);
        }
      },
      result: () => ({ ...d, lastText: resultText ?? d.lastText }),
    };
  },
};

// ---------------------------------------------------------------- Codex CLI

const codex: HarnessAdapter = {
  id: "codex",
  supported: true,
  bin: "codex",
  env: (k) => ({ ...QUIET_ENV, CODEX_API_KEY: k.openai }), // codex exec reads CODEX_API_KEY
  hasKey: (k) => !!k.openai,
  // No --ephemeral: it disables the rollout file that `exec resume` needs.
  launchArgv: (o) => [
    o.bin ?? "codex", "exec", "--json",
    "--model", o.model,
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "--color", "never",
    "-C", o.workdir,
    "-",
  ],
  // `exec resume` has no -C/--color; the runner already starts it in the workdir.
  resumeArgv: (o) => [
    o.bin ?? "codex", "exec", "resume", o.sessionId,
    "--json",
    "--model", o.model,
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "-",
  ],
  newDigest() {
    const d: TurnDigest = { lastText: "", commands: [], files: [], sessionId: null, error: null };
    return {
      observe(ev) {
        if (ev.type === "thread.started" && typeof ev.thread_id === "string") d.sessionId = ev.thread_id;
        const item = ev.item;
        if (ev.type === "item.completed" && item) {
          if ((item.type === "agent_message" || item.type === "assistant_message") && typeof item.text === "string") d.lastText = item.text;
          if (item.type === "command_execution") pushUnique(d.commands, item.command);
          if (item.type === "file_change" && Array.isArray(item.changes)) for (const c of item.changes) pushUnique(d.files, c?.path);
        }
        if (ev.type === "turn.failed") d.error = String(ev.error?.message ?? "codex turn failed").slice(0, 1000);
        if (ev.type === "error") d.error = String(ev.message ?? "codex error").slice(0, 1000);
      },
      result: () => ({ ...d }),
    };
  },
};

// ---------------------------------------------------------------- registry

const ADAPTERS: Record<string, HarnessAdapter> = { "claude-code": claudeCode, codex };

/** Ids we know exist in the harness registry but have no adapter yet. */
const KNOWN_UNSUPPORTED = ["cursor-agent", "gemini", "agy", "copilot", "opencode", "amp", "pi", "aider", "kimi", "goose", "cline"];

const ALIASES: Record<string, string> = {
  claude: "claude-code", claudecode: "claude-code", "claude-code-cli": "claude-code",
  "codex-cli": "codex", "openai-codex": "codex",
  cursor: "cursor-agent", "gemini-cli": "gemini", "github-copilot": "copilot", "copilot-cli": "copilot",
};

export function normalizeHarnessId(h: string): string {
  const k = h.trim().toLowerCase().replace(/[_\s]/g, "-");
  return ALIASES[k] ?? k;
}

export class UnsupportedHarnessError extends Error {}

/** Throws UnsupportedHarnessError for ids without an adapter ("not yet supported" stubs). */
export function getAdapter(harness: string): HarnessAdapter {
  const id = normalizeHarnessId(harness);
  const a = ADAPTERS[id];
  if (a) return a;
  const known = KNOWN_UNSUPPORTED.includes(id) || registryIds().includes(id);
  throw new UnsupportedHarnessError(`Harness "${harness}" is ${known ? "not yet supported by the orchestrator" : "unknown"}`);
}

export function supportedHarnesses(): string[] { return Object.keys(ADAPTERS); }

/** Harness ids from the repo-root registry, if present (read-only; tolerant of its exact shape). */
function registryIds(): string[] {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const data = JSON.parse(readFileSync(join(here, "..", "..", "harnesses", "registry.json"), "utf8"));
    const list: any[] = Array.isArray(data) ? data : Array.isArray(data?.harnesses) ? data.harnesses : Object.values(data ?? {});
    return list.map((h) => (typeof h === "string" ? h : h?.harness ?? h?.id)).filter((x): x is string => typeof x === "string").map(normalizeHarnessId);
  } catch { return []; }
}
