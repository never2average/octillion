/**
 * Harness credential mapping (docs/credentials.md).
 *
 * The broker (`POST /api/worker/sessions/:id/credentials`) returns `providers`:
 *   gateway: {mode:"gateway", base_url: "{PUBLIC_URL}/gw/<provider>[/v1]", api_key: "ogw_…"}   (anthropic, openai, google, dashscope)
 *   direct:  {mode:"direct", api_key: "<real key>"}                                            (github_copilot, cursor, amp, factory)
 * Each harness maps them to its own env vars, plus a NON-SECRET setup snippet (config files holding base URLs) that
 * runs right before the CLI. Secrets only ever travel as env values injected at exec time (`env -i`), never in argv,
 * files written by the setup snippet, images or container env.
 *
 * Every base-URL override below was checked against the pinned CLI in its image (orchestrator/images) by a real run
 * through a stand-in gateway that requires the ogw_ token (see README "Credentials").
 */
import type { HarnessAdapter } from "./adapters.js";

export interface ProviderCred { mode: "gateway" | "direct"; base_url?: string | null; api_key: string }
export type Providers = Record<string, ProviderCred>;
export interface HarnessCreds {
  env: Record<string, string>;
  setup: string;
  /** Optional argv rewrite for gateway mode (applied by the session; the adapter's own argv stays unchanged). */
  argv?: (argv: string[]) => string[];
}

interface CredSpec {
  /** Broker provider ids this harness needs. */
  providers: string[];
  /** gateway: base URL override supported (and verified); direct: vendor-hosted, real key brokered. */
  mode: "gateway" | "direct";
  /** How the override works, for docs. */
  how: string;
  map(p: Providers, o: { model: string }): HarnessCreds;
}

export class MissingCredentialsError extends Error {}

function need(p: Providers, id: string): ProviderCred {
  const c = p[id];
  if (!c?.api_key) throw new MissingCredentialsError(`no "${id}" credentials for this session (broker providers: ${Object.keys(p).join(", ") || "none"})`);
  return c;
}
const trim = (u: string) => u.replace(/\/+$/, "");
/** Append `suffix` unless the URL already ends with it. */
const withSuffix = (u: string, suffix: string) => (trim(u).endsWith(suffix) ? trim(u) : trim(u) + suffix);

/** Shell snippet: write a config file under $HOME once. Content must be non-secret and contain no single quote. */
function writeOnce(relPath: string, content: string): string {
  if (content.includes("'")) throw new Error("config content must not contain single quotes");
  return `f="$HOME/${relPath}"; [ -s "$f" ] || { mkdir -p "$(dirname "$f")" && printf '%s' '${content}' > "$f"; }; `;
}

const anthropicEnv = (p: Providers) => {
  const c = need(p, "anthropic");
  return { c, env: { ANTHROPIC_API_KEY: c.api_key } as Record<string, string> };
};

export const CRED_SPECS: Record<string, CredSpec> = {
  "claude-code": {
    providers: ["anthropic"], mode: "gateway", how: "ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY (sent as x-api-key)",
    map(p) {
      const { c, env } = anthropicEnv(p);
      if (c.base_url) {
        env.ANTHROPIC_BASE_URL = trim(c.base_url);
        // The gateway's Claude upstream is Vertex, which rejects Claude Code 2.1.296's beta body params
        // ("400 context_management: Extra inputs are not permitted", seen live 2026-10-10). This flag drops them
        // (verified: the request body then has no context_management). Native Anthropic would accept them.
        env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
      }
      return { env, setup: "" };
    },
  },
  codex: {
    providers: ["openai"], mode: "gateway",
    how: "$CODEX_HOME/config.toml `openai_base_url` (<base>/v1) + CODEX_API_KEY. Codex 0.162 IGNORES the OPENAI_BASE_URL env (it called api.openai.com); a custom model_provider loses the built-in model metadata (no tools sent for gpt-6.1-sol)",
    map(p) {
      const c = need(p, "openai");
      const env: Record<string, string> = { CODEX_API_KEY: c.api_key };
      if (!c.base_url) return { env, setup: "" };
      // Built-in openai provider + openai_base_url keeps codex's model catalog (tools, reasoning) and only moves the host.
      const url = withSuffix(c.base_url, "/v1");
      if (/["\\'%]/.test(url)) throw new Error("unsafe openai base URL");
      return { env, setup: `d="\${CODEX_HOME:-$HOME/.codex}"; mkdir -p "$d"; [ -s "$d/config.toml" ] || printf 'openai_base_url = "%s"\\n' '${url}' > "$d/config.toml"; ` };
    },
  },
  copilot: {
    providers: ["github_copilot"], mode: "direct", how: "COPILOT_GITHUB_TOKEN (GitHub-hosted models; BYOK COPILOT_PROVIDER_BASE_URL would change the product)",
    map: (p) => ({ env: { COPILOT_GITHUB_TOKEN: need(p, "github_copilot").api_key }, setup: "" }),
  },
  cursor: {
    providers: ["cursor"], mode: "direct", how: "CURSOR_API_KEY (Cursor-hosted backend, no base URL override)",
    map: (p) => ({ env: { CURSOR_API_KEY: need(p, "cursor").api_key }, setup: "" }),
  },
  opencode: {
    providers: ["anthropic"], mode: "gateway",
    how: "OPENCODE_CONFIG_CONTENT provider.anthropic.options.baseURL (<base>/v1) + ANTHROPIC_API_KEY; models `cloudflare/@cf/...` use a custom " +
         "OpenAI-compatible provider (Cloudflare Workers AI) at <gateway>/cloudflare/v1 with the token in CLOUDFLARE_API_TOKEN ({env:} in config)",
    map(p, o) {
      // Open models on Cloudflare Workers AI: OpenCode custom provider "cloudflare" (@ai-sdk/openai-compatible) pointed
      // at the gateway; the config only references the env var, the ogw_ token itself travels in env at exec time.
      if (o.model.startsWith("cloudflare/")) {
        const c = need(p, "cloudflare");
        const modelId = o.model.slice("cloudflare/".length);
        if (!c.base_url) return { env: { CLOUDFLARE_API_TOKEN: c.api_key }, setup: "" };
        const config = {
          provider: {
            cloudflare: {
              npm: "@ai-sdk/openai-compatible", name: "Cloudflare Workers AI",
              options: { baseURL: withSuffix(c.base_url, "/v1"), apiKey: "{env:CLOUDFLARE_API_TOKEN}" },
              models: { [modelId]: { name: modelId, tool_call: true } },
            },
          },
        };
        return { env: { CLOUDFLARE_API_TOKEN: c.api_key, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }, setup: "" };
      }
      const { c, env } = anthropicEnv(p);
      if (c.base_url) env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ provider: { anthropic: { options: { baseURL: withSuffix(c.base_url, "/v1") } } } });
      return { env, setup: "" };
    },
  },
  kilo: {
    providers: ["anthropic"], mode: "gateway", how: "KILO_CONFIG_CONTENT provider.anthropic.options.baseURL (<base>/v1) + ANTHROPIC_API_KEY",
    map(p) {
      const { c, env } = anthropicEnv(p);
      if (c.base_url) env.KILO_CONFIG_CONTENT = JSON.stringify({ provider: { anthropic: { options: { baseURL: withSuffix(c.base_url, "/v1") } } } });
      return { env, setup: "" };
    },
  },
  "gemini-cli": {
    providers: ["google"], mode: "gateway", how: "GOOGLE_GEMINI_BASE_URL + GEMINI_API_KEY (x-goog-api-key); ~/.gemini/settings.json security.auth.selectedType=gemini-api-key",
    map(p) {
      const c = need(p, "google");
      const env: Record<string, string> = { GEMINI_API_KEY: c.api_key };
      if (!c.base_url) return { env, setup: "" };
      env.GOOGLE_GEMINI_BASE_URL = trim(c.base_url);
      return { env, setup: writeOnce(".gemini/settings.json", '{"security":{"auth":{"selectedType":"gemini-api-key"}}}') };
    },
  },
  antigravity: {
    providers: ["google"], mode: "gateway", how: "GOOGLE_GEMINI_BASE_URL + GEMINI_API_KEY (modelProvider gemini, set by the adapter)",
    map(p) {
      const c = need(p, "google");
      const env: Record<string, string> = { GEMINI_API_KEY: c.api_key };
      if (c.base_url) env.GOOGLE_GEMINI_BASE_URL = trim(c.base_url);
      return { env, setup: "" };
    },
  },
  "qwen-code": {
    providers: ["dashscope"], mode: "gateway", how: "OPENAI_BASE_URL (<base>/compatible-mode/v1) + OPENAI_API_KEY, --auth-type openai",
    map(p) {
      const c = need(p, "dashscope");
      const base = c.base_url ? (/\/v1$/.test(trim(c.base_url)) ? trim(c.base_url) : trim(c.base_url) + "/compatible-mode/v1")
        : "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
      return { env: { OPENAI_API_KEY: c.api_key, OPENAI_BASE_URL: base }, setup: "" };
    },
  },
  pi: {
    providers: ["anthropic"], mode: "gateway", how: "~/.pi/agent/models.json providers.anthropic.baseUrl + ANTHROPIC_API_KEY",
    map(p) {
      const { c, env } = anthropicEnv(p);
      const setup = c.base_url ? writeOnce(".pi/agent/models.json", JSON.stringify({ providers: { anthropic: { baseUrl: trim(c.base_url) } } })) : "";
      return { env, setup };
    },
  },
  cline: {
    providers: ["anthropic"], mode: "gateway",
    how: "cline 3.0.70's anthropic provider ignores any base URL (`-b` is refused for it; ANTHROPIC_BASE_URL and a providers.json baseUrl are ignored). Gateway mode uses its OpenAI-compatible provider instead: `cline auth -p openai -b <base>/v1` + `-P openai`, which reaches Anthropic's OpenAI-compatible /v1/chat/completions behind the gateway",
    map(p, o) {
      const { c, env } = anthropicEnv(p);
      if (!c.base_url) return { env, setup: "" };
      if (/['"$`\\]/.test(o.model) || /['"$`\\]/.test(c.base_url)) throw new Error("unsafe model or base URL for cline setup");
      // The key is referenced from the env ("$ANTHROPIC_API_KEY"), never written into argv by us. </dev/null: stdin is the prompt.
      const setup = `cline auth -p openai -k "$ANTHROPIC_API_KEY" -b "${withSuffix(c.base_url, "/v1")}" -m "${o.model}" </dev/null >/dev/null 2>&1 || true; `;
      const argv = (a: string[]) => a.map((x, i) => (x === "anthropic" && a[i - 1] === "-P" ? "openai" : x));
      return { env, setup, argv };
    },
  },
  amp: {
    providers: ["amp"], mode: "direct", how: "AMP_API_KEY (Amp-hosted backend, no base URL override)",
    map: (p) => ({ env: { AMP_API_KEY: need(p, "amp").api_key }, setup: "" }),
  },
  droid: {
    providers: ["factory"], mode: "direct", how: "FACTORY_API_KEY (Factory-hosted models; BYOK customModels would change the model)",
    map: (p) => ({ env: { FACTORY_API_KEY: need(p, "factory").api_key }, setup: "" }),
  },
};

const SECRETISH = /(KEY|TOKEN|SECRET|PASSWORD)$/i;

/**
 * The full exec-time env + setup for one harness run: the adapter's neutral flags (with anything credential-like
 * removed, so a stray worker env var can never leak) + the mapped provider credentials.
 */
export function harnessCredentials(adapter: HarnessAdapter, providers: Providers, model: string): HarnessCreds {
  const spec = CRED_SPECS[adapter.id];
  if (!spec) throw new MissingCredentialsError(`no credential mapping for harness ${adapter.id}`);
  const neutral = Object.fromEntries(Object.entries(adapter.env({ anthropic: "", openai: "" }))
    .filter(([k, v]) => v !== "" && !SECRETISH.test(k) && !/_BASE_URL$/.test(k)));
  const mapped = spec.map(providers, { model });
  return { env: { ...neutral, ...mapped.env }, setup: mapped.setup, argv: mapped.argv };
}

/** Providers a harness needs (for docs / pre-checks). */
export function harnessProviders(id: string): string[] { return CRED_SPECS[id]?.providers ?? []; }

/** CREDENTIALS_MODE=env (dev fallback): build providers from the worker's own env vars. */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): Providers {
  const p: Providers = {};
  const add = (id: string, key: string | undefined, base?: string) => { if (key) p[id] = { mode: base ? "gateway" : "direct", api_key: key, base_url: base || null }; };
  add("anthropic", env.ANTHROPIC_API_KEY, env.ANTHROPIC_BASE_URL);
  add("openai", env.OPENAI_API_KEY ?? env.CODEX_API_KEY, env.OPENAI_BASE_URL);
  add("google", env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY, env.GOOGLE_GEMINI_BASE_URL);
  add("dashscope", env.DASHSCOPE_API_KEY, env.DASHSCOPE_BASE_URL);
  add("github_copilot", env.COPILOT_GITHUB_TOKEN ?? env.GH_TOKEN ?? env.GITHUB_TOKEN);
  add("cursor", env.CURSOR_API_KEY);
  add("amp", env.AMP_API_KEY);
  add("factory", env.FACTORY_API_KEY);
  return p;
}

/** Apply the credential argv rewrite, then wrap so `setup` (config writes, no secret values) runs first in the same exec. */
export function withCredentialSetup(argv: string[], setup: string, rewrite?: (a: string[]) => string[]): string[] {
  const a = rewrite ? rewrite(argv) : argv;
  return setup ? ["bash", "-c", `${setup}exec "$@"`, "octi", ...a] : a;
}
