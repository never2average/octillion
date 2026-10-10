import type { RawEvent, StoredEvent } from "./transcripts.js";

/**
 * Decide, from a sub-agent's transcript, whether it picked the customer's product.
 *
 * Only what the agent itself produced counts (assistant text and its tool calls / commands / file edits),
 * never the task prompt or tool output. Per tracked tool (the product and each competitor) we find the
 * strongest signal:
 *   adopted      an agent action installs or imports one of its packages
 *   recommended  assistant text names it in a sentence with a choice cue ("I'll use", "recommend", "go with")
 *   mentioned    it is named anywhere else in agent output
 * The session verdict is then adopted / recommended for the product, `competitor` when a competitor was
 * recommended or adopted instead (or adopted over a mere recommendation), else mentioned / none.
 */

export type Level = "mentioned" | "recommended" | "adopted";
export type Verdict = "adopted" | "recommended" | "mentioned" | "competitor" | "none";
const RANK: Record<Level, number> = { mentioned: 1, recommended: 2, adopted: 3 };

export interface Tool { name: string; aliases?: string[]; packages?: string[]; domains?: string[] }
export interface Evidence { seq: number; kind: "message" | "action"; level: Level; snippet: string }
export interface Mention { tool: string; target: boolean; level: Level; first_seq: number; evidence: Evidence[] }
export interface Score { verdict: Verdict; winner: string | null; mentions: Mention[] }

/** Agent-authored pieces of an event, labelled as prose (`message`) or an action (tool call, command, edit). */
export function segments(raw: RawEvent): { kind: "message" | "action"; text: string }[] {
  const type = String(raw.type ?? "");
  const out: { kind: "message" | "action"; text: string }[] = [];
  // Tool inputs are flattened to their string values, one per line, so file contents keep real line starts
  // (for `from x import` / `"pkg": "^1"` matching) instead of JSON-escaped "\n".
  const str = (v: unknown): string =>
    typeof v === "string" ? v : v == null || typeof v !== "object" ? String(v ?? "")
    : (Array.isArray(v) ? v : Object.values(v)).map(str).filter(Boolean).join("\n");
  const msg = raw.message as { role?: string; content?: unknown } | undefined;
  const item = raw.item as { type?: string; text?: string; command?: string; changes?: unknown } | undefined;

  // Partial / in-progress events repeat what the final event says; counting them would double up.
  if (type === "stream_event" || type === "item.started" || type === "item.updated") return out;
  if (type === "tool_call" && raw.subtype === "completed") return out; // Cursor repeats the call on completion

  // Claude Code / Amp / Cursor stream-json, Anthropic message shape: content blocks of text and tool_use.
  if (msg?.role === "assistant" || (type === "assistant" && msg)) {
    const content = msg?.content;
    if (typeof content === "string") out.push({ kind: "message", text: content });
    else if (Array.isArray(content))
      for (const b of content as { type?: string; text?: string; name?: string; input?: unknown }[]) {
        if (b?.type === "text") out.push({ kind: "message", text: b.text ?? "" });
        else if (b?.type === "tool_use") out.push({ kind: "action", text: `${b.name ?? ""}\n${str(b.input)}` });
      }
    return out;
  }
  // Codex exec --json: item.* events wrapping agent messages, commands and file changes.
  if (item?.type) {
    if (item.type === "agent_message" || item.type === "assistant_message") return [{ kind: "message", text: item.text ?? "" }];
    if (/command|file_change|tool_call|patch/.test(item.type)) {
      const it = item as Record<string, unknown>;
      return [{ kind: "action", text: str(it.command ?? (it.tool ? `${it.tool}\n${str(it.arguments)}` : it.changes ?? it)) }];
    }
    return [];
  }
  // Cursor tool calls: {tool_call: {shellToolCall: {args: {...}}}} or {tool_call: {function: {name, arguments}}}.
  if (type === "tool_call" && raw.tool_call && typeof raw.tool_call === "object")
    return Object.entries(raw.tool_call as Record<string, any>).map(([k, v]) => ({ kind: "action" as const, text: `${v?.name ?? k}\n${str(v?.args ?? v?.arguments ?? v)}` }));
  // OpenCode run --format json: {type: "text" | "tool_use", part: {text} | {tool, state: {input}}}.
  const part = raw.part as { text?: string; tool?: string; state?: { input?: unknown } } | undefined;
  if (part && (type === "text" || type === "tool_use")) {
    if (type === "text") return [{ kind: "message", text: part.text ?? "" }];
    return [{ kind: "action", text: `${part.tool ?? ""}\n${str(part.state?.input)}` }];
  }
  // Gemini CLI stream-json: {type: "message", role: "assistant", content} and {type: "tool_use", tool_name, parameters}.
  if (type === "tool_use" && "tool_name" in raw) return [{ kind: "action", text: `${str(raw.tool_name)}\n${str(raw.parameters)}` }];
  if (type === "message") return raw.role === "assistant" ? [{ kind: "message", text: str(raw.content) }] : [];
  // Octillion's own format (also what an orchestrator should use for e.g. a post-run `git diff`: type file_edit).
  if (type === "assistant_message" || raw.role === "assistant") return [{ kind: "message", text: str(raw.content ?? raw.text) }];
  if (/^(tool_call|tool_use|function_call|command|exec|file_edit|file_write)$/.test(type))
    return [{ kind: "action", text: `${str(raw.name)}\n${str(raw.input ?? raw.command ?? raw.arguments ?? raw.content)}` }];
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const token = (s: string) => `(?<![\\w@/.-])${escapeRe(s)}(?![\\w-])`;

const INSTALL = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)|npx|bunx|pip3?\s+install|uv\s+(?:add|pip\s+install)|poetry\s+add|pipenv\s+install|cargo\s+add|go\s+get|gem\s+install|bundle\s+add|composer\s+require|dotnet\s+add\s+package|brew\s+install)\b[^\n;&|]*/gi;
const CUE = /\b(recommend\w*|suggest\w*|i'?ll\s+use|i\s+will\s+use|let'?s\s+use|we'?ll\s+use|we\s+will\s+use|go(?:ing)?\s+with|opt(?:ing)?\s+for|choos\w+|chose|pick\w*|prefer\w*|best\s+(?:choice|option|fit)|switch(?:ing)?\s+to|set(?:ting)?\s+up|install\w*|use|using)\b/i;
const NEGATION = /\b(instead\s+of|rather\s+than|avoid\w*|don'?t\s+use|do\s+not\s+use|not\s+recommended|without)\b/i;

function matchers(t: Tool) {
  const names = [t.name, ...(t.aliases ?? [])].filter(Boolean);
  const pkgs = (t.packages ?? []).filter(Boolean);
  const any = [...names, ...pkgs].map(token);
  for (const d of t.domains ?? []) if (d) any.push(escapeRe(d));
  const mention = any.length ? new RegExp(any.join("|"), "i") : null;
  const pkgRe = pkgs.length ? new RegExp(pkgs.map(token).join("|"), "i") : null;
  const imports = pkgs.length
    ? new RegExp(pkgs.map((p) => {
        const e = escapeRe(p);
        return `(?:from\\s+['"]${e}(?:/[^'"]*)?['"]|require\\(\\s*['"]${e}(?:/[^'"]*)?['"]|import\\s+['"]${e}(?:/[^'"]*)?['"]|^\\s*(?:from|import)\\s+${e}\\b|"${e}"\\s*:\\s*"[~^]?[\\d*])`;
      }).join("|"), "im")
    : null;
  return { mention, pkgRe, imports };
}

function snippetAround(text: string, idx: number, width = 220) {
  const start = Math.max(0, idx - width / 2);
  return `${start > 0 ? "…" : ""}${text.slice(start, start + width).replace(/\s+/g, " ").trim()}${start + width < text.length ? "…" : ""}`;
}

/** The strongest signal a single agent-authored segment gives for one tool, if any. */
function levelIn(kind: "message" | "action", text: string, m: ReturnType<typeof matchers>): { level: Level; index: number } | null {
  if (!m.mention) return null;
  if (kind === "action") {
    if (m.pkgRe) for (const cmd of text.matchAll(INSTALL)) {
      const hit = cmd[0].match(m.pkgRe);
      if (hit) return { level: "adopted", index: (cmd.index ?? 0) + (hit.index ?? 0) };
    }
    const imp = m.imports && text.match(m.imports);
    if (imp) return { level: "adopted", index: imp.index ?? 0 };
    const hit = text.match(m.mention);
    return hit ? { level: "mentioned", index: hit.index ?? 0 } : null;
  }
  let best: { level: Level; index: number } | null = null;
  let offset = 0;
  for (const sentence of text.split(/(?<=[.!?\n])\s+/)) {
    const hit = sentence.match(m.mention);
    if (hit) {
      const before = sentence.slice(0, hit.index);
      const recommended = CUE.test(sentence) && !NEGATION.test(before);
      const cand = { level: (recommended ? "recommended" : "mentioned") as Level, index: offset + (hit.index ?? 0) };
      if (!best || RANK[cand.level] > RANK[best.level]) best = cand;
      if (best.level === "recommended") break;
    }
    offset += sentence.length + 1;
  }
  return best;
}

export function scoreTranscript(events: StoredEvent[], target: Tool, competitors: Tool[]): Score {
  const tools = [{ tool: target, target: true }, ...competitors.map((tool) => ({ tool, target: false }))]
    .map((t) => ({ ...t, m: matchers(t.tool) }));
  const found = new Map<string, Mention>();

  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    for (const seg of segments(e.raw)) {
      if (!seg.text) continue;
      for (const t of tools) {
        const hit = levelIn(seg.kind, seg.text, t.m);
        if (!hit) continue;
        const cur = found.get(t.tool.name) ?? { tool: t.tool.name, target: t.target, level: hit.level, first_seq: e.seq, evidence: [] };
        if (RANK[hit.level] > RANK[cur.level]) cur.level = hit.level;
        // Keep the first piece of evidence at each level, strongest first.
        if (!cur.evidence.some((ev) => ev.level === hit.level))
          cur.evidence.push({ seq: e.seq, kind: seg.kind, level: hit.level, snippet: snippetAround(seg.text, hit.index) });
        cur.evidence.sort((a, b) => RANK[b.level] - RANK[a.level]);
        found.set(t.tool.name, cur);
      }
    }
  }

  const mentions = [...found.values()].sort((a, b) => RANK[b.level] - RANK[a.level] || a.first_seq - b.first_seq);
  const firstAt = (mn: Mention, level: Level) => mn.evidence.find((ev) => ev.level === level)?.seq ?? Infinity;
  const winnerAt = (level: Level) =>
    mentions.filter((mn) => mn.level === level).sort((a, b) => firstAt(a, level) - firstAt(b, level))[0] ?? null;
  const winner = winnerAt("adopted") ?? winnerAt("recommended");

  const mine = mentions.find((mn) => mn.target);
  let verdict: Verdict;
  if (mine?.level === "adopted") verdict = "adopted";
  else if (winner && !winner.target && (winner.level === "adopted" || !mine || mine.level !== "recommended")) verdict = "competitor";
  else if (mine?.level === "recommended") verdict = "recommended";
  else if (mine) verdict = "mentioned";
  else verdict = "none";

  return { verdict, winner: winner?.tool ?? null, mentions };
}

/** Whether a verdict counts as a success for a scenario's expectation. */
export const isHit = (verdict: Verdict | null, expectation: "recommend" | "avoid") =>
  verdict == null ? null : expectation === "recommend" ? verdict === "adopted" || verdict === "recommended"
                                                       : verdict !== "adopted" && verdict !== "recommended";
