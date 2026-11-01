import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { vercelAuth, VERCEL_REGION } from "./sandbox-probe.js";

/**
 * Vercel Sandbox v2 REST client for worker sandboxes (src/worker-sandboxes.ts). fetch only: no @vercel/sandbox in the API
 * bundle (ESM-only; Vercel's OpenTelemetry require hook crashed production on an ESM-only dependency before).
 * Endpoints as the official SDK's api-client calls them (vercel/sandbox packages/vercel-sandbox/src/api-client), on
 * https://vercel.com/api with ?teamId=; auth and team / project from src/sandbox-probe.ts vercelAuth (the function's OIDC
 * token, else an access token), region iad1 like the probe:
 *
 *   POST   /v2/sandboxes                                   create (named; runtime node24 = Amazon Linux 2023, user vercel-sandbox)
 *   GET    /v2/sandboxes/{name}?projectId=                 {sandbox:{status,currentSessionId}, session:{id,status}}
 *   DELETE /v2/sandboxes/{name}?projectId=                 stop + delete
 *   GET    /v2/sandboxes?project=&namePrefix=&cursor=      list
 *   POST   /v2/sandboxes/sessions/{sid}/cmd                {command,args,cwd?,env?,sudo?,wait:false} -> {command:{id}}
 *   GET    /v2/sandboxes/sessions/{sid}/cmd/{cmd}[?wait=true]   {command:{exitCode|null}}
 *   GET    /v2/sandboxes/sessions/{sid}/cmd/{cmd}/logs     ND-JSON {stream:"stdout"|"stderr"|"error", data}; ends with the command
 *   POST   /v2/sandboxes/sessions/{sid}/cmd/{cmd}/kill     {signal}
 *   POST   /v2/sandboxes/sessions/{sid}/fs/write           gzipped tar, x-cwd header
 *   POST   /v2/sandboxes/sessions/{sid}/network-policy     {allow:[domains], subnets:{deny:[cidrs]}} (applied live)
 *   POST   /v2/sandboxes/sessions/{sid}/snapshot           {expiration} -> {snapshot:{id,status}}; stops the session
 *   GET    /v2/sandboxes/snapshots?project=&name=          list (by source sandbox name); DELETE /v2/sandboxes/snapshots/{id}
 *
 * Orchestrator sandboxes (orchestrator/deploy/orchestrator-host.ts vercelHost) use the same client from the autoscaler.
 *
 * Every command runs as `bash -c <script>` as the image's default user (vercel-sandbox, which has sudo), like boat's.
 */

export class VercelSandboxError extends Error { constructor(public status: number, msg: string) { super(msg); } }
export const isGone = (e: unknown) => e instanceof VercelSandboxError && (e.status === 404 || e.status === 410);

/** Private, loopback, link-local (metadata) and CGNAT ranges: never reachable from a locked-down worker sandbox. */
export const DENY_SUBNETS = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "127.0.0.0/8", "0.0.0.0/8", "fc00::/7", "fe80::/10"];

export interface VercelClient {
  teamId: string; projectId: string; via: string; region: string;
  create(o: { name: string; vcpus: number; memoryMb: number; timeoutMs: number; tags?: Record<string, string>; snapshotId?: string | null }): Promise<{ name: string; session: string | null }>;
  get(name: string): Promise<{ status: string; session: string | null; sessionStatus: string }>;
  remove(name: string): Promise<void>;
  /** Pages until done, or until `deadline` (ms epoch) is near: then what was listed so far. */
  list(prefix: string, deadline?: number): Promise<{ name: string; createdAt: number | null; status: string }[]>;
  run(session: string, script: string): Promise<string>;
  status(session: string, cmd: string, wait?: boolean, timeoutMs?: number): Promise<{ exitCode: number | null }>;
  logs(session: string, cmd: string, signal: AbortSignal): AsyncGenerator<{ stream: string; data: string }>;
  kill(session: string, cmd: string, signal?: number): Promise<void>;
  writeFile(session: string, path: string, content: Buffer): Promise<void>;
  networkPolicy(session: string, allow: string[]): Promise<void>;
  /** Snapshot a running session (Vercel stops it afterwards); `expirationMs` 0 = never expires. */
  snapshot(session: string, expirationMs: number): Promise<{ id: string; status: string }>;
  /** Snapshots taken from sandboxes named `name` (newest first). */
  listSnapshots(name: string): Promise<{ id: string; status: string; createdAt: number | null }[]>;
  deleteSnapshot(id: string): Promise<void>;
}

/**
 * The function's OIDC token, as the latest request carried it (x-vercel-oidc-token; src/http.ts remembers it). The same
 * token for every request of this deployment; it lets work that is not tied to one request (the autoscaler's launches)
 * reach Vercel. Kept in memory only, for 30 minutes.
 */
let lastOidc: { token: string; at: number } | null = null;
export function rememberOidcToken(token: unknown): void { if (typeof token === "string" && token.length > 20) lastOidc = { token, at: Date.now() }; }
const rememberedOidc = () => (lastOidc && Date.now() - lastOidc.at < 30 * 60_000 ? lastOidc.token : null);

/** A Vercel client from the request's OIDC token (or the latest request's, or the env), or why there is none. */
export function vercelClient(o: { oidcToken?: string | null; baseUrl?: string } = {}): VercelClient | { not_configured: string } {
  const auth = vercelAuth(o.oidcToken || rememberedOidc());
  if ("not_configured" in auth) return auth;
  const base = (o.baseUrl ?? process.env.OCTILLION_VERCEL_SANDBOX_API_URL?.trim() ?? "https://vercel.com/api").replace(/\/+$/, "");
  const h = { authorization: `Bearer ${auth.token}` };
  const q = (extra: Record<string, string> = {}) => `?${new URLSearchParams({ teamId: auth.teamId, ...extra })}`;
  const one = (name: string) => `/v2/sandboxes/${encodeURIComponent(name)}`;
  const ses = (sid: string) => `/v2/sandboxes/sessions/${encodeURIComponent(sid)}`;
  const call = async (path: string, init: { method?: string; json?: unknown; body?: Buffer; headers?: Record<string, string>; timeoutMs: number; signal?: AbortSignal }, what: string) => {
    const headers: Record<string, string> = { ...h, ...(init.headers ?? {}), ...(init.json !== undefined ? { "content-type": "application/json" } : {}) };
    const signals = [AbortSignal.timeout(init.timeoutMs)];
    if (init.signal) signals.push(init.signal);
    const res = await fetch(`${base}${path}`, { method: init.method ?? "GET", headers, signal: AbortSignal.any(signals),
      body: init.json !== undefined ? JSON.stringify(init.json) : (init.body as unknown as BodyInit | undefined) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let msg = text.slice(0, 300);
      try { const d = JSON.parse(text); msg = String(d?.error?.message ?? d?.message ?? d?.error?.code ?? msg); } catch { /* not JSON */ }
      throw new VercelSandboxError(res.status, `vercel ${what} -> ${res.status}${msg ? `: ${msg.slice(0, 300)}` : ""}`);
    }
    return res;
  };
  const json = async (res: Response) => { const t = await res.text(); return t ? JSON.parse(t) : null; };
  const writeVia = (process.env.OCTILLION_VERCEL_WRITE_VIA ?? "fs").trim() === "exec" ? "exec" : "fs";

  const client: VercelClient = {
    teamId: auth.teamId, projectId: auth.projectId, via: auth.via, region: VERCEL_REGION,
    async create(c) {
      // No snapshot on stop (persistent: false); Vercel stops it at `timeout` whatever happens to us.
      const r = await json(await call(`/v2/sandboxes${q()}`, { method: "POST", timeoutMs: 90_000, json: {
        name: c.name, projectId: auth.projectId, ...(c.snapshotId ? { source: { type: "snapshot", snapshotId: c.snapshotId } } : { runtime: "node24" }),
        resources: { vcpus: c.vcpus, memory: c.memoryMb }, timeout: c.timeoutMs,
        persistent: false, region: VERCEL_REGION, tags: { octillion: "worker", ...(c.tags ?? {}) } } }, "POST /v2/sandboxes"));
      return { name: String(r?.sandbox?.name ?? c.name), session: r?.sandbox?.currentSessionId ?? r?.session?.id ?? null };
    },
    async get(name) {
      const r = await json(await call(`${one(name)}${q({ projectId: auth.projectId })}`, { timeoutMs: 20_000 }, "GET /v2/sandboxes/:name"));
      return { status: String(r?.sandbox?.status ?? ""), session: r?.sandbox?.currentSessionId ?? r?.session?.id ?? null, sessionStatus: String(r?.session?.status ?? "") };
    },
    async remove(name) {
      await call(`${one(name)}${q({ projectId: auth.projectId })}`, { method: "DELETE", timeoutMs: 30_000 }, "DELETE /v2/sandboxes/:name")
        .catch((e) => { if (!isGone(e)) throw e; });
    },
    async list(prefix, deadline) {
      const out: { name: string; createdAt: number | null; status: string }[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 20 && !(deadline && Date.now() > deadline - 15_000); i++) {
        // The list endpoint names the project `project`; get and delete take `projectId` (as the probe found).
        const r = await json(await call(`/v2/sandboxes${q({ project: auth.projectId, sortBy: "name", namePrefix: prefix, limit: "50", ...(cursor ? { cursor } : {}) })}`,
          { timeoutMs: 20_000 }, "GET /v2/sandboxes"));
        for (const s of r?.sandboxes ?? []) if (typeof s?.name === "string" && s.name.startsWith(prefix)) out.push({ name: s.name, createdAt: Number(s.createdAt) || null, status: String(s.status ?? "") });
        cursor = r?.pagination?.next ?? null;
        if (!cursor) break;
      }
      return out;
    },
    async run(session, script) {
      const r = await json(await call(`${ses(session)}/cmd${q()}`, { method: "POST", timeoutMs: 60_000, json: { command: "bash", args: ["-c", script], wait: false } }, "POST cmd"));
      const id = r?.command?.id ?? r?.cmdId ?? r?.id;
      if (!id) throw new VercelSandboxError(502, `vercel POST cmd returned no command id: ${JSON.stringify(r).slice(0, 200)}`);
      return String(id);
    },
    async status(session, cmd, wait = false, timeoutMs = 20_000) {
      const r = await json(await call(`${ses(session)}/cmd/${encodeURIComponent(cmd)}${q(wait ? { wait: "true" } : {})}`, { timeoutMs }, "GET cmd"));
      const c = r?.command ?? r;
      return { exitCode: c?.exitCode == null ? null : Number(c.exitCode) };
    },
    async *logs(session, cmd, signal) {
      const res = await call(`${ses(session)}/cmd/${encodeURIComponent(cmd)}/logs${q()}`, { timeoutMs: 3600_000, signal }, "GET cmd logs");
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const parse = (line: string) => {
        if (!line.trim()) return null;
        try { return JSON.parse(line); } catch { return null; }
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            const f = parse(buf.slice(0, i)); buf = buf.slice(i + 1);
            if (f) yield { stream: String(f.stream ?? ""), data: typeof f.data === "string" ? f.data : JSON.stringify(f.data ?? "") };
          }
        }
        const f = parse(buf + dec.decode());
        if (f) yield { stream: String(f.stream ?? ""), data: typeof f.data === "string" ? f.data : JSON.stringify(f.data ?? "") };
      } finally { reader.cancel().catch(() => {}); }
    },
    async kill(session, cmd, signal = 15) {
      await call(`${ses(session)}/cmd/${encodeURIComponent(cmd)}/kill${q()}`, { method: "POST", timeoutMs: 20_000, json: { signal } }, "POST cmd kill").catch(() => {});
    },
    async writeFile(session, path, content) {
      if (writeVia === "exec") return writeViaExec(client, session, path, content);
      // One file per archive, extracted relative to "/" (x-cwd), mode 0600 (env files carry gateway tokens).
      await call(`${ses(session)}/fs/write${q()}`, { method: "POST", timeoutMs: 60_000, body: gzipSync(tarOne(path.replace(/^\/+/, ""), content, 0o600)),
        headers: { "content-type": "application/gzip", "x-cwd": "/" } }, "POST fs/write");
    },
    async networkPolicy(session, allow) {
      await call(`${ses(session)}/network-policy${q()}`, { method: "POST", timeoutMs: 30_000, json: { allow, subnets: { deny: DENY_SUBNETS } } }, "POST network-policy");
    },
    async snapshot(session, expirationMs) {
      const r = await json(await call(`${ses(session)}/snapshot${q()}`, { method: "POST", timeoutMs: 120_000, json: { expiration: expirationMs } }, "POST snapshot"));
      if (!r?.snapshot?.id) throw new VercelSandboxError(502, `vercel POST snapshot returned no snapshot id: ${JSON.stringify(r).slice(0, 200)}`);
      return { id: String(r.snapshot.id), status: String(r.snapshot.status ?? "") };
    },
    async listSnapshots(name) {
      const r = await json(await call(`/v2/sandboxes/snapshots${q({ project: auth.projectId, name, limit: "50" })}`, { timeoutMs: 20_000 }, "GET /v2/sandboxes/snapshots"));
      return (r?.snapshots ?? []).filter((x: any) => typeof x?.id === "string")
        .map((x: any) => ({ id: String(x.id), status: String(x.status ?? ""), createdAt: Number(x.createdAt) || null }));
    },
    async deleteSnapshot(id) {
      await call(`/v2/sandboxes/snapshots/${encodeURIComponent(id)}${q()}`, { method: "DELETE", timeoutMs: 30_000 }, "DELETE /v2/sandboxes/snapshots/:id")
        .catch((e) => { if (!isGone(e)) throw e; });
    },
  };
  return client;
}

/**
 * OCTILLION_VERCEL_WRITE_VIA=exec: write a file with commands instead of fs/write (if a live check shows fs/write
 * extracts as another user than the one commands run as). Base64 chunks well under the 128 KiB argument limit.
 */
async function writeViaExec(c: VercelClient, session: string, path: string, content: Buffer): Promise<void> {
  const b64 = content.toString("base64");
  const tmp = `${path}.part-${randomBytes(4).toString("hex")}`;
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const step = async (script: string) => {
    const id = await c.run(session, script);
    const r = await c.status(session, id, true, 60_000);
    if (r.exitCode !== 0) throw new VercelSandboxError(502, `vercel file write (exec) failed with exit ${r.exitCode}`);
  };
  await step(`umask 077; mkdir -p "$(dirname ${q(path)})" && : > ${q(tmp)}`);
  for (let i = 0; i < b64.length || i === 0; i += 96_000) await step(`printf %s ${q(b64.slice(i, i + 96_000))} | base64 -d >> ${q(tmp)}`);
  await step(`mv -f ${q(tmp)} ${q(path)}`);
}

/** A one-entry ustar archive (no dependency: the API bundle stays fetch + node: built-ins). */
export function tarOne(name: string, content: Buffer, mode = 0o644): Buffer {
  const header = Buffer.alloc(512, 0);
  let prefix = "", base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`path too long for a tar entry: ${name.slice(0, 80)}…`);
    prefix = name.slice(0, cut); base = name.slice(cut + 1);
  }
  const put = (s: string, off: number, len: number) => header.write(s, off, len, "utf8");
  const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";
  put(base, 0, 100);
  put(oct(mode, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(content.length, 12), 124, 12);
  put(oct(Math.floor(Date.now() / 1000), 12), 136, 12);
  put("        ", 148, 8); // checksum placeholder (spaces) while summing
  put("0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const b of header) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  const pad = Buffer.alloc((512 - (content.length % 512)) % 512, 0);
  return Buffer.concat([header, content, pad, Buffer.alloc(1024, 0)]);
}
