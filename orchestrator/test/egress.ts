/**
 * Egress lockdown pieces (orchestrator/core/egress.ts), tested on this host: the generated proxy really runs, lets an
 * allowlisted host through and refuses everything else; the policy is built from the gateway and repo hosts; the
 * setup script fails closed. The firewall rules themselves are exercised by the in-VM probe on a real boat VM.
 *   npx tsx orchestrator/test/egress.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { EGRESS_PROXY_PORT, egressPolicy, probeSource, proxyEnv, proxySource, setupScript } from "../core/egress.js";

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok, detail }); console.log(`[egress] ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`); };

const pol = egressPolicy({ gatewayUrls: ["https://gw.octillion.example/gw/anthropic", "https://gw.octillion.example/gw/openai/v1"], repoUrl: "https://github.com/acme/app.git" });
check("policy: gateway, registries and the repo's git host", pol.gatewayHost === "gw.octillion.example" && pol.hosts.includes("registry.npmjs.org") &&
  pol.hosts.includes("github.com") && pol.hosts.includes("codeload.github.com") && !pol.hosts.includes("example.com"), pol.hosts.join(","));
let refused = false;
try { egressPolicy({ gatewayUrls: ["http://127.0.0.1:3000/gw/anthropic"] }); } catch { refused = true; }
check("policy: a non-HTTPS gateway is refused (strict mode is production only)", refused);
check("policy: a repo given as an IP literal is not allowlisted", !egressPolicy({ gatewayUrls: ["https://gw.x.example"], repoUrl: "https://10.0.0.5/app.git" }).hosts.includes("10.0.0.5"));
check("proxy env routes HTTP clients through the proxy", proxyEnv().HTTPS_PROXY === `http://127.0.0.1:${EGRESS_PROXY_PORT}` && proxyEnv().NODE_USE_ENV_PROXY === "1");
const setup = setupScript("/tmp/octi");
check("setup fails closed without node, a firewall tool or a running proxy", /exit 20/.test(setup) && /exit 21/.test(setup) && /exit 22/.test(setup) && /meta skuid \$AUID counter drop/.test(setup));
check("probe expects the gateway reachable and everything else blocked", /gateway through the proxy", true/.test(probeSource("gw.x.example")) && /metadata IP directly", false/.test(probeSource("gw.x.example")));

// Run the generated proxy on a free port (rewritten from 3128) with a small allowlist.
const dir = mkdtempSync(path.join(os.tmpdir(), "octi-egress-"));
const port = 31000 + Math.floor(Math.random() * 2000);
writeFileSync(path.join(dir, "proxy.mjs"), proxySource().replace(`srv.listen(${EGRESS_PROXY_PORT}`, `srv.listen(${port}`));
writeFileSync(path.join(dir, "allow.json"), JSON.stringify({ hosts: ["registry.npmjs.org"] }));
const proc = spawn(process.execPath, [path.join(dir, "proxy.mjs"), path.join(dir, "allow.json"), path.join(dir, "log.jsonl")], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const connect = (target: string) => new Promise<string>((resolve) => {
  const s = net.connect(port, "127.0.0.1", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
  let buf = ""; s.setTimeout(8000);
  s.on("data", (d) => { buf += d; if (buf.includes("\r\n")) { s.destroy(); resolve(buf.split("\r\n")[0]!); } });
  s.on("timeout", () => { s.destroy(); resolve("timeout"); }); s.on("error", (e) => resolve(`error ${e.message}`));
});
const plain = await new Promise<string>((resolve) => {
  const s = net.connect(port, "127.0.0.1", () => s.write("GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n"));
  let buf = ""; s.on("data", (d) => { buf += d; s.destroy(); resolve(buf.split("\r\n")[0]!); }); s.on("error", (e) => resolve(`error ${e.message}`));
});
try {
  const allowed = await connect("registry.npmjs.org:443");
  check("an allowlisted host connects through the proxy", /^HTTP\/1\.1 200/.test(allowed), allowed);
  for (const [target, why] of [["example.com:443", "unlisted host"], ["1.1.1.1:443", "IP literal"], ["registry.npmjs.org:80", "port other than 443"], ["[::1]:443", "IPv6 literal"]])
    check(`refused through the proxy: ${why}`, /^HTTP\/1\.1 403/.test(await connect(target!)), target);
  check("plain HTTP proxying is refused", /^HTTP\/1\.1 403/.test(plain), plain);
  const log = readFileSync(path.join(dir, "log.jsonl"), "utf8");
  check("decisions are logged", /"allow":"registry.npmjs.org"/.test(log) && /"why":"host not allowed"/.test(log), "");
} finally {
  proc.kill();
}
const failed = results.filter((r) => !r.ok);
console.log(`EGRESS TEST ${failed.length ? "FAIL" : "PASS"} (${results.length - failed.length}/${results.length} assertions)`);
process.exit(failed.length ? 1 : 0);
