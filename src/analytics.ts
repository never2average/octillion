/**
 * Per-organization MCP activity: which connector methods and tools each org calls, whether they worked and how long
 * they took. Never stores tool arguments or results. Recording is best effort and never blocks or fails a request.
 */
import { getDb } from "./db.js";

export interface McpEvent { method: string; name?: string | null; client?: string | null; ok?: boolean; error?: string | null; ms?: number | null }

export function recordMcpEvent(orgId: number, e: McpEvent): void {
  getDb()
    .then((db) => db.query(
      "INSERT INTO mcp_events (org_id, method, name, client, ok, error, ms) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [orgId, e.method.slice(0, 80), e.name?.slice(0, 200) ?? null, e.client?.slice(0, 120) ?? null, e.ok ?? true,
       e.error?.slice(0, 500) ?? null, e.ms == null ? null : Math.round(e.ms)],
    ))
    .catch((err) => console.error("mcp event record failed:", (err as Error).message));
}

/** JSON-RPC messages in an MCP POST body, minus tools/call (runTool records those with their outcome). */
export function connectorEvents(body: unknown, userAgent: string | undefined): McpEvent[] {
  const msgs = (Array.isArray(body) ? body : [body]) as { method?: unknown; params?: Record<string, unknown> }[];
  return msgs
    .filter((m) => m && typeof m.method === "string" && m.method !== "tools/call" && !m.method.startsWith("notifications/"))
    .map((m) => {
      const p = m.params ?? {};
      const info = p.clientInfo as { name?: string; version?: string } | undefined;
      return {
        method: m.method as string,
        name: typeof p.name === "string" ? p.name : typeof p.uri === "string" ? p.uri : null,
        client: info?.name ? `${info.name}${info.version ? ` ${info.version}` : ""}` : userAgent ?? null,
      };
    });
}
