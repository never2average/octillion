// Key vault admin CLI. Secrets are read from stdin (or --from-env / --from-file), never from argv, so they stay
// out of shell history and process listings.
//   npm run keyvault -- gen-master-key
//   npm run keyvault -- providers
//   printf %s "$ANTHROPIC_KEY" | npm run keyvault -- add anthropic [--name "Team key"]   (always a new row)
//   printf %s "$NEW_KEY" | npm run keyvault -- replace <id>          (rotate: that row only; rotated_at set)
//   npm run keyvault -- ids anthropic                              (that type's credential ids, one per line)
//   `set` is gone (it used to replace the type's key): it refuses and lists the type's ids.
// Exit codes: 0 ok, 1 error, 3 the key is already in the vault (add / replace refused as a duplicate).
//   npm run keyvault -- add boat --from-file /secure/boat.env      (KEY=value files: the value is used)
//   npm run keyvault -- list | delete <id> | rekey | backfill-digests | usage
//   npm run keyvault -- provider <slug> --mode gateway --upstream https://... --header x-api-key --prefix "" --env FOO_API_KEY
//   npm run keyvault -- provider anthropic --backend vertex --vertex-project my-gcp-project [--vertex-region global]
//   npm run keyvault -- add vertex < service-account.json        (a Vertex AI key; several are used in turn)
//   npm run keyvault -- provider anthropic --backend direct                     (back to api.anthropic.com)
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { getDb } from "../src/db.js";
import * as kv from "../src/keyvault.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const readStdin = async () => { let s = ""; for await (const c of process.stdin) s += c; return s; };

async function secretInput(): Promise<string> {
  const env = flag("from-env");
  if (env) return process.env[env] ?? (() => { throw new Error(`${env} is not set`); })();
  const file = flag("from-file");
  if (file) {
    const text = readFileSync(file, "utf8").trim();
    const kvLine = text.split("\n").find((l) => /^[A-Z0-9_]+=/.test(l));
    return kvLine ? kvLine.slice(kvLine.indexOf("=") + 1).trim() : text;
  }
  if (process.stdin.isTTY) throw new Error("Pipe the secret on stdin, or use --from-env VAR / --from-file PATH");
  const text = (await readStdin()).trim();
  const kvLine = text.split("\n").find((l) => /^[A-Z0-9_]+=/.test(l));
  return kvLine ? kvLine.slice(kvLine.indexOf("=") + 1).trim() : text;
}

async function main() {
  switch (cmd) {
    case "gen-master-key":
      console.log(randomBytes(32).toString("base64"));
      console.error("Store this as OCTILLION_VAULT_KEY in your secret manager. Losing it makes the vault unreadable.");
      return;
    case "providers":
      console.table((await kv.listProviders()).map((p) => ({ ...p, env_vars: p.env_vars.join(",") })));
      return;
    case "provider": {
      const env = flag("env");
      if (rest.includes("--enable") || rest.includes("--disable")) throw new Error("Providers are not switched on or off: a provider is usable when it has a key");
      console.log(await kv.upsertProvider({
        slug: rest[0], mode: flag("mode") as "gateway" | "direct" | undefined, upstream_url: flag("upstream"),
        auth_header: flag("header"), auth_prefix: flag("prefix"), env_vars: env ? env.split(",") : undefined,
        backend: flag("backend") as "direct" | "vertex" | undefined,
        backend_config: flag("vertex-project") ? { project_id: flag("vertex-project"), region: flag("vertex-region") ?? "global" } : undefined,
      }));
      return;
    }
    case "set": {
      // It used to replace the type's one key; adding instead would silently grow a pool, so it refuses.
      const provider = rest[0] && !rest[0].startsWith("--") ? rest[0] : null;
      const ids = provider ? (await kv.listCredentials()).filter((c) => c.provider === provider).map((c) => `#${c.id} ${c.name} (${c.hint})`) : [];
      throw new Error("`keyvault set` is gone: use `add <provider>` for another key or `replace <id>` to rotate" +
        (provider ? (ids.length ? `. ${provider} keys: ${ids.join(", ")}` : `. ${provider} has no keys yet`) : ""));
    }
    case "ids": {
      if (!rest[0]) throw new Error("Usage: keyvault ids <provider>");
      for (const c of await kv.listCredentials()) if (c.provider === rest[0]) console.log(c.id);
      return;
    }
    case "add": {
      if (!rest[0] || rest[0].startsWith("--")) throw new Error("Usage: keyvault add <provider> [--name NAME] < secret   (always adds a new key; replace one with: keyvault replace <id>)");
      if (rest.includes("--priority")) throw new Error("--priority is gone: a type's keys are used least recently used first");
      const r = await kv.addCredential(rest[0], await secretInput(), { name: flag("name") ?? flag("label") });
      console.log(`Added ${r.name} (${r.provider}, ${r.hint}) as credential #${r.id}.`);
      return;
    }
    case "replace": {
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) throw new Error("Usage: keyvault replace <id> < secret   (ids from: keyvault list)");
      const r = await kv.replaceCredential(id, await secretInput());
      console.log(`Replaced the secret of ${r.name} (${r.provider}, credential #${r.id}); now ${r.hint}.`);
      return;
    }
    case "list":
      console.table((await kv.listCredentials()).map(({ key_id: _k, meta, ...c }) => ({ ...c, ...(meta?.client_email ? { client_email: meta.client_email, project_id: meta.project_id } : {}) })));
      return;
    case "delete": {
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) throw new Error("Usage: keyvault delete <id>   (ids from: keyvault list)");
      const gone = await kv.deleteCredential(id);
      console.log(`Credential #${id} (${gone.provider}, ${gone.hint}) deleted.`);
      return;
    }
    case "backfill-digests": {
      const r = await kv.backfillDigests();
      console.log(`Filled the duplicate-check digest of ${r.filled} key(s) stored before migration 0012.`);
      for (const s of r.skipped) console.error(`Skipped credential #${s.id} (${s.provider}): ${s.error}`);
      if (r.skipped.length) process.exitCode = 1;
      return;
    }
    case "rekey":
      console.log(`Re-encrypted ${await kv.rekey()} credentials with the current master key.`);
      return;
    case "usage":
      console.table(await (await getDb()).query(
        `SELECT provider, coalesce(session_id, orchestrator_id) AS consumer, requests, errors, input_tokens, output_tokens, last_at
           FROM gateway_usage ORDER BY last_at DESC LIMIT 50`));
      return;
    default:
      throw new Error("Commands: gen-master-key, providers, provider, add, replace, ids, list, delete, rekey, backfill-digests, usage");
  }
}

try { await main(); }
catch (e) {
  // The message only (vault errors never quote a key); 3 = already in the vault, so scripts can tell it apart.
  console.error((e as Error).message);
  process.exitCode = (e as { status?: number }).status === 409 ? 3 : 1;
}
finally { await (await getDb()).close(); }
