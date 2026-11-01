/**
 * Helpers the launcher runs INSIDE an orchestrator sandbox on Vercel Sandbox (never on the main VM):
 *   tsx deploy/in-sandbox.ts guard                      host-guard verdict as JSON (production rules, RUNNER from env)
 *   tsx deploy/in-sandbox.ts preflight                  can this sandbox reach $OCTILLION_URL/healthz over HTTPS?
 */
import { readFileSync } from "node:fs";
import { checkHost } from "../core/host-guard.js";

const [cmd] = process.argv.slice(2);

if (cmd === "guard") {
  const r = checkHost(process.env.RUNNER ?? "vercel");
  let marker: any = null;
  try { marker = JSON.parse(readFileSync("/etc/octillion/host-role", "utf8")); } catch { /* none */ }
  console.log(JSON.stringify({ ok: r.ok, dev: r.dev, problems: r.problems, provider: r.provider ?? null,
    sandbox_id_matches_marker: !!marker?.sandbox_id && process.env.OCTILLION_SANDBOX_ID === marker.sandbox_id }));
  process.exit(r.ok ? 0 : 3);
}

if (cmd === "preflight") {
  const url = (process.env.OCTILLION_URL ?? "").replace(/\/+$/, "");
  if (!/^https:\/\//.test(url)) {
    console.log(JSON.stringify({ ok: false, reason: `OCTILLION_URL must be the server's PUBLIC https URL (got ${url || "nothing"}); orchestrator and worker sandboxes reach it over the internet` }));
    process.exit(4);
  }
  try {
    const r = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(10_000) });
    const ok = r.status === 200;
    console.log(JSON.stringify({ ok, status: r.status, reason: ok ? "reachable" : `GET ${url}/healthz returned ${r.status}` }));
    process.exit(ok ? 0 : 4);
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message;
    console.log(JSON.stringify({ ok: false, reason: `cannot reach ${url}/healthz from this sandbox (${cause}). The server must be on a public HTTPS URL that sandbox VMs can reach.` }));
    process.exit(4);
  }
}

console.error("usage: tsx deploy/in-sandbox.ts guard | preflight");
process.exit(2);
