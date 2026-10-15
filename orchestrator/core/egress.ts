/**
 * Network egress lockdown for an agent sandbox (docs/security.md, phase 2). Used for private runs, where customer
 * text steers the agent: the coding agent (uid `agent`) may only reach an allowlist of hosts, through a small HTTPS
 * proxy running inside the VM as its own user.
 *
 *   agent ──► 127.0.0.1:3128 (proxy, user octiproxy) ──► gateway, package registries, the task's git host
 *   agent ──► anything else (internet, DNS, metadata IP, other machines): dropped by nftables/iptables (uid match)
 *
 * The proxy accepts CONNECT to port 443 only, refuses IP-literal targets and any host that resolves to a private,
 * loopback, link-local (metadata) or reserved address, and logs every decision. Loopback stays open for the agent
 * (dev servers, test databases). After the rules are in place a probe, run as the agent, must reach the gateway
 * through the proxy and must fail to reach the internet directly, an unlisted host through the proxy, the metadata
 * IP and a public DNS server; any other outcome fails the sandbox open (fail closed).
 */

export const EGRESS_PROXY_PORT = 3128;
export const EGRESS_DIR = "/opt/octi-egress";

/** Hosts agents need beyond the gateway: package registries (installing packages is part of the measured choice). */
export const REGISTRY_HOSTS = [
  "registry.npmjs.org", "registry.yarnpkg.com", "pypi.org", "files.pythonhosted.org", "proxy.golang.org", "sum.golang.org",
  "index.crates.io", "static.crates.io", "crates.io", "repo.maven.apache.org", "repo1.maven.org", "pub.dev", "storage.googleapis.com",
  "rubygems.org", "packagist.org", "repo.packagist.org", "api.nuget.org",
];

export interface EgressPolicy { hosts: string[]; gatewayHost: string; gatewayPort: number }

/** The allowlist for one session: the gateway's host(s), registries, and the task repository's git host. */
export function egressPolicy(opts: { gatewayUrls: string[]; repoUrl?: string | null }): EgressPolicy {
  const hosts = new Set<string>(REGISTRY_HOSTS);
  let gatewayHost = "", gatewayPort = 443;
  for (const u of opts.gatewayUrls) {
    try {
      const x = new URL(u);
      if (!gatewayHost) { gatewayHost = x.hostname.toLowerCase(); gatewayPort = x.port ? Number(x.port) : x.protocol === "https:" ? 443 : 80; }
      hosts.add(x.hostname.toLowerCase());
    } catch { /* ignore */ }
  }
  if (opts.repoUrl) {
    try {
      const h = new URL(opts.repoUrl).hostname.toLowerCase();
      if (!isIpLiteral(h)) { hosts.add(h); if (h === "github.com") hosts.add("codeload.github.com"); }
    } catch { /* ignore */ }
  }
  if (!gatewayHost) throw new Error("egress: no gateway URL to allow");
  if (gatewayPort !== 443) throw new Error(`egress: the gateway must be HTTPS on port 443 (got ${gatewayHost}:${gatewayPort})`);
  return { hosts: [...hosts].sort(), gatewayHost, gatewayPort };
}

const isIpLiteral = (h: string) => /^[\d.]+$/.test(h) || h.includes(":");

/** Environment for the agent's processes so HTTP clients use the proxy (Node needs NODE_USE_ENV_PROXY for fetch). */
export function proxyEnv(): Record<string, string> {
  const p = `http://127.0.0.1:${EGRESS_PROXY_PORT}`;
  return { HTTPS_PROXY: p, HTTP_PROXY: p, https_proxy: p, http_proxy: p, ALL_PROXY: p, all_proxy: p, NO_PROXY: "localhost,127.0.0.1,::1",
           no_proxy: "localhost,127.0.0.1,::1", NODE_USE_ENV_PROXY: "1", npm_config_proxy: p, npm_config_https_proxy: p };
}

/** The proxy program written into the VM (Node, no dependencies). Args: allowlist JSON path, log path. */
export function proxySource(): string {
  return `// Octillion egress proxy (orchestrator/core/egress.ts): CONNECT to allowlisted hosts on 443 only.
import http from "node:http"; import net from "node:net"; import dns from "node:dns/promises"; import fs from "node:fs";
const allow = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).hosts;
const logf = process.argv[3];
const log = (o) => { try { fs.appendFileSync(logf, JSON.stringify({ t: new Date().toISOString(), ...o }) + "\\n"); } catch {} };
function blocked(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    const m = /^::(?:ffff:)?(\\d+\\.\\d+\\.\\d+\\.\\d+)$/.exec(x);
    if (m) return blocked(m[1]);
    const h = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(x);
    if (h) { const a = parseInt(h[1], 16), b = parseInt(h[2], 16); return blocked((a >> 8) + "." + (a & 255) + "." + (b >> 8) + "." + (b & 255)); }
    return x === "::" || x === "::1" || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x) || x.startsWith("64:ff9b:") ||
      x.startsWith("2001:db8") || x.startsWith("2002:") || x.startsWith("2001:0:") || x.startsWith("2001::");
  }
  return true;
}
const listed = (h) => allow.some((b) => h === b || h.endsWith("." + b));
const srv = http.createServer((req, res) => { log({ deny: String(req.url).slice(0, 200), why: "plain http" }); res.writeHead(403); res.end("egress: HTTPS via CONNECT only\\n"); });
srv.on("connect", async (req, sock, head) => {
  const deny = (why) => { log({ deny: String(req.url).slice(0, 200), why }); sock.end("HTTP/1.1 403 Forbidden\\r\\n\\r\\n"); };
  const m = /^([A-Za-z0-9.-]+):(\\d+)$/.exec(req.url || "");
  if (!m) return deny("bad or IP-literal target");
  const host = m[1].toLowerCase(), port = Number(m[2]);
  if (port !== 443) return deny("port " + port);
  if (/^[\\d.]+$/.test(host)) return deny("IP literal");
  if (!listed(host)) return deny("host not allowed");
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch { return deny("dns"); }
  const good = addrs.filter((a) => !blocked(a.address));
  if (!good.length) return deny("private or reserved address");
  const up = net.connect(port, good[0].address, () => {
    sock.write("HTTP/1.1 200 Connection Established\\r\\n\\r\\n");
    if (head && head.length) up.write(head);
    up.pipe(sock); sock.pipe(up);
    log({ allow: host });
  });
  up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy());
});
srv.on("clientError", (e, s) => s.destroy());
srv.listen(${EGRESS_PROXY_PORT}, "127.0.0.1");
`;
}

/** Probe program run as the agent after lockdown; prints JSON results and exits 1 on any unexpected outcome. */
export function probeSource(gatewayHost: string): string {
  return `import net from "node:net";
const T = 6000;
const tcp = (host, port) => new Promise((r) => { const s = net.connect({ host, port, timeout: T }); s.on("connect", () => { s.destroy(); r(true); }); s.on("timeout", () => { s.destroy(); r(false); }); s.on("error", () => r(false)); });
const viaProxy = (target) => new Promise((r) => {
  const s = net.connect(${EGRESS_PROXY_PORT}, "127.0.0.1", () => s.write("CONNECT " + target + " HTTP/1.1\\r\\nHost: " + target + "\\r\\n\\r\\n"));
  let buf = ""; s.setTimeout(T); s.on("data", (d) => { buf += d; if (buf.includes("\\r\\n")) { s.destroy(); r(/^HTTP\\/1\\.1 200/.test(buf)); } });
  s.on("timeout", () => { s.destroy(); r(false); }); s.on("error", () => r(false));
});
const checks = [
  ["gateway through the proxy", true, () => viaProxy(${JSON.stringify(gatewayHost)} + ":443")],
  ["unlisted host through the proxy", false, () => viaProxy("example.com:443")],
  ["IP literal through the proxy", false, () => viaProxy("1.1.1.1:443")],
  ["internet directly", false, () => tcp("93.184.215.14", 443)],
  ["public DNS directly", false, () => tcp("1.1.1.1", 53)],
  ["metadata IP directly", false, () => tcp("169.254.169.254", 80)],
];
const out = []; let bad = 0;
for (const [name, want, f] of checks) { const got = await f(); out.push({ name, want, got }); if (got !== want) bad++; }
console.log(JSON.stringify({ ok: bad === 0, checks: out }));
process.exit(bad ? 1 : 0);
`;
}

/**
 * Root-side setup (runs as the boat user with sudo): proxy user and files, start the proxy, firewall rules for the
 * agent uid. Exits non-zero (fail closed) when node or a firewall tool is missing or the proxy does not come up.
 */
export function setupScript(dir: string): string {
  return `set -eu
D=${EGRESS_DIR}; O=${dir}
NODE="$(command -v node || true)"; [ -n "$NODE" ] || { echo "egress: node not found" >&2; exit 20; }
id octiproxy >/dev/null 2>&1 || sudo -n useradd -r -M -s /usr/sbin/nologin octiproxy
sudo -n install -d -m 755 -o root -g root "$D"
sudo -n install -m 644 -o root -g root "$O/egress-proxy.mjs" "$D/proxy.mjs"
sudo -n install -m 644 -o root -g root "$O/egress-allow.json" "$D/allow.json"
sudo -n install -m 644 -o root -g root "$O/egress-probe.mjs" "$D/probe.mjs"
sudo -n install -m 640 -o octiproxy -g root /dev/null /var/log/octi-egress.log
sudo -n -u octiproxy nohup "$NODE" "$D/proxy.mjs" "$D/allow.json" /var/log/octi-egress.log >/dev/null 2>&1 &
up=0; for i in $(seq 1 40); do (exec 3<>/dev/tcp/127.0.0.1/${EGRESS_PROXY_PORT}) 2>/dev/null && { up=1; break; }; sleep 0.25; done
[ "$up" = 1 ] || { echo "egress: proxy did not start" >&2; exit 22; }
AUID="$(id -u agent)"
if command -v nft >/dev/null 2>&1; then
  sudo -n nft -f - <<EOF
table inet octi_egress {
  chain out {
    type filter hook output priority 0; policy accept;
    meta skuid $AUID oifname "lo" accept
    meta skuid $AUID counter drop
  }
}
EOF
elif command -v iptables >/dev/null 2>&1; then
  sudo -n iptables -A OUTPUT -o lo -m owner --uid-owner "$AUID" -j ACCEPT
  sudo -n iptables -A OUTPUT -m owner --uid-owner "$AUID" -j DROP
  if command -v ip6tables >/dev/null 2>&1; then
    sudo -n ip6tables -A OUTPUT -o lo -m owner --uid-owner "$AUID" -j ACCEPT
    sudo -n ip6tables -A OUTPUT -m owner --uid-owner "$AUID" -j DROP
  fi
else
  echo "egress: neither nft nor iptables is available" >&2; exit 21
fi
echo "egress: locked down (agent uid $AUID; proxy on 127.0.0.1:${EGRESS_PROXY_PORT})"
`;
}
