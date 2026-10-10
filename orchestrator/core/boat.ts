/** Minimal boat.dev v1 REST client (https://docs.boat.dev/api/v1). fetch only. */
import { BOAT } from "./config.js";
import { HttpError, sleep } from "./util.js";

export class BoatError extends HttpError {
  constructor(status: number, public code: string, msg: string, public retryable?: boolean) { super(status, msg); }
}

export const boatSandboxPath = (id: string) => `/sandboxes/${encodeURIComponent(id)}`;

function boatHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${BOAT.apiKey}`, ...extra };
}

async function boatErrorFrom(res: Response, what: string): Promise<BoatError> {
  const text = await res.text().catch(() => "");
  let d: any = null;
  try { d = JSON.parse(text); } catch { /* not JSON */ }
  const code = String(d?.code ?? d?.error?.code ?? "");
  const msg = d?.message ?? d?.error?.message ?? text.slice(0, 300);
  return new BoatError(res.status, code, `boat ${what} -> ${res.status} ${code}: ${msg}`, d?.error?.details?.retryable);
}

export async function boatApi(path: string, init: { method?: string; json?: unknown; headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<any> {
  const method = init.method ?? "GET";
  const headers = boatHeaders(init.headers);
  let body: string | undefined;
  if (init.json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(init.json); }
  const signals = [AbortSignal.timeout(init.timeoutMs ?? 60_000)];
  if (init.signal) signals.push(init.signal);
  const res = await fetch(BOAT.apiUrl + path, { method, headers, body, signal: AbortSignal.any(signals) });
  if (!res.ok) throw await boatErrorFrom(res, `${method} ${path}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Retry a command call only when Boat says it provably did not run (still starting / restoring / rate limited). */
export async function boatCommandRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      const safe = e instanceof BoatError &&
        ((e.status === 409 && /starting/.test(e.code)) || (e.status === 502 && e.retryable === true) || e.status === 429);
      if (!safe || i >= 20) throw e;
      await sleep(3000);
    }
  }
}

/** Synchronous command (<= 600s). Boat may truncate long output. */
export async function boatExec(id: string, command: string, timeoutSeconds = 120): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const r = await boatCommandRetry(() => boatApi(`${boatSandboxPath(id)}/commands`, {
    method: "POST", json: { command, timeoutSeconds }, timeoutMs: (timeoutSeconds + 60) * 1000,
  }));
  return { exitCode: r?.exitCode ?? null, stdout: r?.stdout ?? "", stderr: r?.stderr ?? "" };
}

/**
 * Streamed command: POST /commands {stream:true} answers application/x-ndjson frames:
 * {"type":"started"}, {"type":"stdout"|"stderr","data":"..."}..., then {"type":"exit",exitCode,...} or {"type":"error",...}.
 */
export async function boatExecStream(
  id: string, command: string, timeoutSeconds: number,
  onStdout: (s: string) => void, onStderr: (s: string) => void, signal?: AbortSignal,
): Promise<{ exitCode: number | null }> {
  const signals = [AbortSignal.timeout((timeoutSeconds + 60) * 1000)];
  if (signal) signals.push(signal);
  const res = await boatCommandRetry(async () => {
    const r = await fetch(`${BOAT.apiUrl}${boatSandboxPath(id)}/commands`, {
      method: "POST",
      headers: boatHeaders({ "Content-Type": "application/json", Accept: "application/x-ndjson" }),
      body: JSON.stringify({ command, timeoutSeconds, stream: true }),
      signal: AbortSignal.any(signals),
    });
    if (!r.ok) throw await boatErrorFrom(r, "POST commands(stream)");
    return r;
  });
  if (!(res.headers.get("content-type") ?? "").includes("ndjson")) { // server answered with the sync JSON result
    const d: any = await res.json();
    onStdout(d?.stdout ?? ""); onStderr(d?.stderr ?? "");
    return { exitCode: d?.exitCode ?? null };
  }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let exitCode: number | null = null;
  const frame = (line: string) => {
    if (!line.trim()) return;
    let f: any;
    try { f = JSON.parse(line); } catch { return; }
    if (f.type === "stdout") onStdout(String(f.data ?? ""));
    else if (f.type === "stderr") onStderr(String(f.data ?? ""));
    else if (f.type === "exit") exitCode = f.exitCode ?? null;
    else if (f.type === "error") throw new BoatError(502, String(f.error ?? "stream_error"), `boat command stream error: ${f.message ?? f.error}`, f.retryable);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) { frame(buf.slice(0, i)); buf = buf.slice(i + 1); }
  }
  frame(buf + dec.decode());
  return { exitCode };
}
