# Worker images

There is one image per **enabled** harness in [`harnesses/registry.json`](../../harnesses/registry.json). The
registry (see [`harnesses/README.md`](../../harnesses/README.md)) says which agents exist, their pinned versions
and their usage weights. This directory turns those pins into two kinds of runnable sandbox:

- **Docker images** (`Dockerfile.<harness>`, `build.sh`), for the `docker` runner and the warm-pod fleet.
- **Setup scripts** (`setup/<harness>.sh`), which install the pinned harness in production Vercel Sandbox worker sandboxes.

| harness | CLI | install source | version |
|---|---|---|---|
| claude-code | `claude` | npm `@anthropic-ai/claude-code` | 2.1.296 |
| codex | `codex` | npm `@openai/codex` | 0.162.1 |
| copilot | `copilot` | npm `@github/copilot` | 1.0.95 |
| cursor | `cursor-agent` | `downloads.cursor.com/lab/<build>/linux/<arch>/agent-cli-package.tar.gz` (what `cursor.com/install` fetches) | 2026.10.01-e373342 |
| opencode | `opencode` | npm `opencode-ai` | 1.18.35 |
| antigravity | `agy` | `storage.googleapis.com/antigravity-public/antigravity-cli/<build>/...` + sha512 (what `antigravity.google/cli/install.sh` fetches) | 1.3.3 |
| gemini-cli | `gemini` | npm `@google/gemini-cli` | 0.63.0 |
| pi | `pi` | npm `@earendil-works/pi-coding-agent` (`--ignore-scripts`) | 1.1.0 |
| cline | `cline` | npm `cline` | 3.0.70 |
| kilo | `kilo` | npm `@kilocode/cli` | 7.8.8 |
| amp | `amp` | npm `@ampcode/cli` | 0.0.1791619249-g722a12 |
| droid | `droid` | npm `droid` (same binary as `app.factory.ai/cli`) | 0.238.0 |
| qwen-code | `qwen` | npm `@qwen-code/qwen-code` | 0.25.0 |

Package names and install URLs were checked against npm (`npm view`) and the vendors' own install scripts on
2026-10-10.

## Docker images

Every `Dockerfile.<harness>` follows the same contract, which `orchestrator/fleet` and the docker runner rely on:

- **Pinned:** `ARG HARNESS_VERSION=<registry harness_version>`. `build.sh` passes it explicitly from the registry.
- **Neutral base:** `node:22-bookworm` plus git, curl, jq, ripgrep, build-essential and python3 (pip, venv).
  It includes **no** dev-tool SDKs, no `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`/rules files, no MCP config and no
  harness config. Anything preinstalled could bias which tools the agent picks, and that is exactly what
  Octillion measures. The harness is the only extra.
- **Non-root:** user `agent`, `HOME=/home/agent`, and `WORKDIR /home/agent/work` owned by `agent`. The npm global
  prefix is in `$HOME`, so the agent can `npm i -g` without sudo. The harness CLI is installed system-wide
  (`/usr/local/bin`), so `docker exec -u agent <pod> <cli>` works.
- **Warm pod:** `CMD ["sleep", "infinity"]`. The worker runs each session with
  `docker exec -u agent -e <KEY> <pod> <cli> ...`. **No API keys are baked in.** Keys are passed at exec time
  (`requires_env` in the registry).
- **Healthcheck:** `<cli> --version`, so `docker inspect` shows the running version. It uses
  `--start-interval=5s`, which needs Docker 25+.
- **No auto-update:** `DISABLE_AUTOUPDATER=1` (Claude), `COPILOT_AUTO_UPDATE=false` and
  `OPENCODE_DISABLE_AUTOUPDATE=true`. Cursor and Antigravity binaries are pinned by build id.
- **Labels, not env:** `dev.octillion.harness` and `dev.octillion.harness_version` are image LABELs (also set by
  `build.sh`). They used to be env vars, which the agent could read; nothing Octillion-specific is in the env now.

### build.sh

```bash
orchestrator/images/build.sh                  # all enabled harnesses
orchestrator/images/build.sh codex cursor     # some
DRY_RUN=1 orchestrator/images/build.sh        # print docker commands
PLATFORM=linux/arm64 orchestrator/images/build.sh
NO_SMOKE=1 orchestrator/images/build.sh       # skip the warm-pod smoke test
```

`build.sh` reads `registry.json` with `node -e`. It builds each distinct (harness, version) once and tags it
exactly `image.docker` (`octillion/agent-<harness>:<harness_version>`), which is the tag `fleet/plan.ts` reads.
It then smoke-tests the image the way the fleet uses it:

```
docker run -d <tag>
docker exec -u agent <c> <cli> --version     # must contain the pinned version
docker rm -f <c>
```

It fails if two agents of one harness disagree on version or tag. It never pushes. Publishing to a registry is a
separate, deliberate step.

All 13 images built and passed the smoke test here on 2026-10-10. The images are 1.9–2.5 GB each (unpacked), mostly the
shared `node:22-bookworm` + apt layers, so a node pulling several of them pays for the base once.

## Setup scripts (production)

Production sessions run in a fresh Vercel Sandbox worker sandbox each (`orchestrator/core/runners.ts`, `vmRunner`). The
image is Amazon Linux 2023: default user `vercel-sandbox` with sudo, Node under `/vercel/runtimes/node*/bin`, and `dnf`.
No harness is preinstalled.

When the pinned version is missing, the VM runner uploads `setup/_common.sh` and `setup/<harness>.sh` into the sandbox
and runs the script (it must finish within 600 s). A CLI already there at the pinned version is kept.
`src/harness-setup.ts` lists the harnesses that have a script (`SETUP_HARNESSES`); a unit test keeps it equal to the
file names here.

`setup/<harness>.sh [version]` does the following:

- Installs the pinned version **system-wide**: npm `--prefix /usr/local --force`, or the vendor tarball under `/opt`
  symlinked into `/usr/local/bin`.
- Makes sure `/usr/local/bin/node` is at least Node 22, copied from `/vercel/runtimes` (or an nvm tree) if needed,
  because the npm CLIs use `#!/usr/bin/env node`.
- Verifies the install the way the worker runs it: as an unprivileged user, under `env -i` with
  `PATH=/usr/local/bin:/usr/bin:/bin`, checking `--version` against the pin.
- Writes `/etc/octillion/harnesses/<harness>.json` (harness, bin, path, version).
- Cleans the npm caches.

It writes no keys, config, rules or MCP servers.

## Adding a harness

1. Confirm it is runnable: Linux, non-interactive, auto-approve, env-var auth and a JSON event stream.
2. Add the agent(s) to `registry.json`, with `cli`, `headless`, `event_format` and `requires_env`.
3. Copy the closest `Dockerfile.<harness>` (npm-based, or tarball-based like cursor and antigravity) and change
   the install step, the `cli` in the healthcheck and the `dev.octillion.harness` LABEL.
4. Copy the closest `setup/<harness>.sh` and add the harness to `SETUP_HARNESSES` in `src/harness-setup.ts`.
5. Run `build.sh <harness>`, then `npx tsx orchestrator/fleet/plan.ts 10`.
6. Add the adapter in `orchestrator/harnesses/adapters.ts` and set `worker_adapter: "supported"`.
