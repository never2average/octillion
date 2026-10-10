# Octillion orchestrator worker (reference)

Claims queued agent sessions from the Octillion server, runs the coding-agent CLI headless in a
throwaway sandbox, streams its raw JSONL stdout to `/api/worker/sessions/:id/events` every ~2s,
heartbeats, enforces a max duration, and calls `/complete` with tokens/cost from the final event.

The default sandbox provider is **[boat.dev](https://docs.boat.dev)** (`RUNNER=boat`). It gives one fresh Ubuntu VM per session.
`docker` (local containers) and `local` (host CLI, dev only) remain available.

Files:
- `worker.ts` - the worker (Node built-ins only; run with `tsx`). Contains the `boat`, `docker` and `local` runners.
- `Dockerfile.sandbox` - image for `RUNNER=docker` only: node 22, git, python3, `@anthropic-ai/claude-code`, `@openai/codex`, non-root `agent` user.

## Harness commands (all runners)

The prompt is written to the CLI's **stdin**: exactly the scenario prompt, with nothing added.

| harness | command |
|---|---|
| `claude-code` | `claude -p --output-format stream-json --verbose --model <model> --dangerously-skip-permissions --no-session-persistence [--max-budget-usd N]` |
| `codex` | `codex exec --json --model <model> --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral --color never -C <workdir> -` |

If `repo_url` is set, it is cloned (`--depth 1`) into the workdir first. Usage comes from Claude's final
`{"type":"result"}` event (`usage`, `total_cost_usd`) or from summing Codex `turn.completed.usage`.
Codex reports no cost, so `cost_usd` is left empty; work it out on the server from a price table.
Non-JSON stdout lines are sent as `{"type":"raw_stdout"}`. The stderr tail is sent as `{"type":"worker_stderr"}`.

The boat runner also emits one synthetic event after the harness exits. Codex's stream has no edit contents, so this event carries them:
`{"type":"file_edit","name":"git diff","content":"<unified diff>"}`. The diff is taken against the cloned commit, so it includes
the agent's own commits and untracked files. With no repo, it is taken against an empty tree, using a git dir outside the
workdir, so the agent never sees a `.git` it didn't create. `node_modules/`, `.venv/`, `venv/` and `__pycache__/` are skipped
in that case. The diff is capped at `BOAT_DIFF_MAX_BYTES`. The event is sent even when the diff is empty, which means "no changes".

## boat.dev runner

### Per-session flow (REST API, `fetch` only, no SDK)

Base URL `https://boat.dev/api/v1`. Every request sends `Authorization: Bearer $BOAT_API_KEY`
([API v1](https://docs.boat.dev/api/v1)).

1. `POST /sandboxes` `{type: BOAT_SANDBOX_SIZE, ttlSeconds, noEnv: true, snapshots: false}` with an `Idempotency-Key`.
   Retrying after a lost response never creates a second billable VM. `noEnv` keeps every account secret,
   credential and dashboard key out of the VM. `snapshots: false` means nothing is ever captured.
   ([create](https://docs.boat.dev/api/reference/sandboxes/create-sandbox))
2. Poll `GET /sandboxes/{id}` until `sandbox.state` is `ready`, `idle` or `running`. Give up on `error` or `cancelled`, or after `BOAT_READY_TIMEOUT_SECONDS`.
3. `PUT /sandboxes/{id}/files` writes `prompt.txt`, a secrets env file and three small scripts into `/tmp/octi` (mode 700).
   The files API only writes under `/home/user` or `/tmp`.
4. `POST /sandboxes/{id}/commands` runs `prepare.sh` synchronously. It creates an unprivileged `agent` user, works out a
   PATH for the preinstalled `claude`/`codex`/node/git, installs the env file into `/home/agent` (mode 600) and clones the
   repo into `/home/agent/work`. Those are the same paths the docker runner uses.
5. `POST /commands {detached: true}` runs `launch.sh`, because synchronous commands cap at 600s
   ([long-running tasks](https://docs.boat.dev/long-running-tasks)). It runs the harness as `agent` under
   `env -i`, with `< prompt.txt > out.jsonl 2> err.log` and an inner `timeout` as a backstop.
6. Streaming: `POST /commands {stream: true}` with `timeout 540 tail -n +<N> -F --pid=<launcher pid> out.jsonl`. Boat answers
   `application/x-ndjson` frames: `{"type":"started"}`, `{"type":"stdout"|"stderr","data":"..."}`..., then `{"type":"exit",...}` or
   `{"type":"error",...}` ([exec](https://docs.boat.dev/api/reference/agent/execute-sandbox-command)). The worker re-splits
   `data` into lines and feeds them into the same pipeline as the other runners. It reconnects by **line number** every
   540s, or after a dropped stream. That avoids duplicate or lost lines, and a torn trailing line is re-read. `GET /commands/{processId}`
   ([status](https://docs.boat.dev/api/reference/agent/get-command-status)) tells it when the harness has exited. It then
   drains the rest, reads the exit code and the stderr tail, and collects the git diff.
7. `finally`: `DELETE /sandboxes/{id}` with `X-Ascii-Confirm-Delete: {id}`. This force-stops the VM and permanently deletes it
   ([FAQ: lifecycle](https://docs.boat.dev/faq), [delete](https://docs.boat.dev/api/reference/sandboxes/permanently-delete-sandbox-data)).
   If the delete fails, the worker falls back to `POST /stop {force: true}`. As a last resort, the TTL auto-stops the VM.
   The TTL is `MAX_SESSION_MINUTES + BOAT_TTL_MARGIN_MINUTES`. It counts from creation, and exec'd work does not extend it.
   Timeouts, server cancellation (404/409) and SIGINT/SIGTERM all go through the same delete.

`/complete` gets `sandbox_id: "boat:bx_..."` and, in `metadata`, `boat_sandbox_id`, `boat_sandbox_type`,
`boat_sandbox_seconds` and `boat_est_cost_usd` (list price × wall time). The exact meter is
`GET /sandboxes/{id}/usage`. The worker doesn't call it, because the VM is already deleted by then.

### Why exec our own CLI instead of `boat prompt` / `POST /prompt`

Boat's managed harness (`POST /sandboxes/{id}/prompt` + `GET /sandboxes/{id}/events`) is convenient, but it is the wrong tool here:

- **Blindness.** Per [Integrated agents](https://docs.boat.dev/integrated-agents), Boat adds *its own system prompt*
  (it tells the harness that it runs headless in a sandbox and that the `boat` CLI exists). It also adds a `boat` skill and a
  `computer` MCP server to every managed harness. The sandbox user's env also holds a per-sandbox Boat credential.
  Our scenarios must reach the agent verbatim and product-neutral. We run the stock CLI that Boat preinstalls
  ([machines](https://docs.boat.dev/machines)) as a separate user, with a fresh `$HOME` and `env -i`. That user sees none of the above.
- **Native format.** `GET /events` returns Boat's normalized events, not the native stream. Each event has
  `{id, type: "prompt"|"response"|..., timestamp, taskId, conversationId, data}`, with agent text in
  `data.content`, partial output flagged by `data.is_streaming`, and tool calls as `data.tools[] = {use: {id, name, input}, result: {tool_use_id, is_error, content}}`
  ([events](https://docs.boat.dev/api/reference/agent/list-sandbox-events)). There is no Claude `result` event with `usage` /
  `total_cost_usd`, and there are no Codex `turn.completed.usage` events. Our scorer and usage accounting expect the native
  Claude stream-json and Codex `exec --json` formats, so we keep them.
- **Same flags as the other runners.** Same model flag, `--max-budget-usd`, `--no-session-persistence` and stdin prompt.
  We can bring our own `ANTHROPIC_API_KEY` / `CODEX_API_KEY`. Managed prompts would need keys in the Boat dashboard,
  or per-sandbox `env` with `noEnv`.

The cost is a few extra API calls per session, and output arrives over a streamed exec rather than an event feed.

### boat.dev costs and limits ([pricing](https://docs.boat.dev/pricing), as of 2026-10)

| size | $/hour | vCPU / RAM / disk |
|---|---|---|
| `small` | 0.018 | 2 / 4 GB / 12 GB |
| `default` | 0.036 | 4 / 8 GB / 50 GB |
| `large` | 0.072 | 8 / 16 GB / 125 GB |
| `xlarge` | 0.200 | 16 / 32 GB / 251 GB (needs the $100 plan) |

- Billed per second, only while running. Stopped or deleted VMs cost nothing. Snapshots, IPs and egress (up to 2 TB per sandbox per month) are free.
  A 45-minute `default` session costs about **$0.03 of VM time**. Model tokens are far more expensive.
- Plans are prepaid time plus concurrency. $20/mo buys 100 concurrent VMs and 12/60/200 starts per minute/hour/day.
  $100/mo buys 300 concurrent and 30/210/840 starts. $500/mo buys 1,000 concurrent and 65/420/1,680 starts. Every create counts as a start.
  **Trial: 25 free hours, 2 sandboxes at once, `small`/`default` only, and the TTL is capped at 2h.**
- VMs run in the EU (Germany, Finland, France), with about 100-200 ms RTT from the US ([FAQ](https://docs.boat.dev/faq)).
  When capacity is short, a VM may land on a slower Hetzner fallback machine (about 3x slower on CPU-heavy work) at the same price.
- API limits that matter here: synchronous exec caps at 600s, and files written through the API cap at 5 MiB.
  A 429 (`rate_limited`, `limit_reached`) on create is retried with backoff, reusing the same idempotency key.

### API key

Use a scoped key with the `ci` preset. It can create sandboxes, exec, read and write files, and delete only the sandboxes it created
([API keys](https://docs.boat.dev/api-keys)):

```bash
boat api-key create octillion-worker --preset ci --ttl 90d
```

On startup, the worker checks the key with `GET /me`. That call costs nothing.

## Env vars

| var | default | notes |
|---|---|---|
| `OCTILLION_URL` | `http://localhost:3000` | server base URL |
| `OCTILLION_WORKER_TOKEN` | - (required) | Bearer token for `/api/worker/*` |
| `ANTHROPIC_API_KEY` | - | needed for `claude-code` jobs |
| `OPENAI_API_KEY` | - | needed for `codex` jobs (passed into the sandbox as `CODEX_API_KEY`) |
| `RUNNER` | `boat` | `boat` (boat.dev VM per session), `docker` (container per session), `local` (host CLI in a temp dir; dev only) |
| `WORKER_CONCURRENCY` | `2` | parallel sessions on this worker. On boat, keep it at or below your plan's concurrency (trial: 2) |
| `MAX_SESSION_MINUTES` | `45` | hard kill, then reported as `timeout` |
| `WORKER_ID` | `hostname-pid` | |
| `WORKER_MODELS` / `WORKER_HARNESS` | - | claim filters (comma-separated models; one harness) |
| `MAX_BUDGET_USD` | - | per-session spend cap (Claude Code only) |
| `POLL_INTERVAL_SECONDS` (5), `FLUSH_INTERVAL_MS` (2000), `HEARTBEAT_SECONDS` (60) | | |
| **boat** | | |
| `BOAT_API_KEY` | - (required for `RUNNER=boat`) | Bearer key (`ci` preset recommended) |
| `BOAT_API_URL` | `https://boat.dev/api/v1` | |
| `BOAT_SANDBOX_SIZE` | `default` | `small` / `default` / `large` / `xlarge` |
| `BOAT_TTL_MARGIN_MINUTES` | `15` | TTL = `MAX_SESSION_MINUTES` + this (auto-stop backstop if the worker dies) |
| `BOAT_READY_TIMEOUT_SECONDS` | `300` | max wait for a new VM to become ready |
| `BOAT_ORG` | - | bill an organization wallet (id or name) |
| `BOAT_AGENT_USER` | `agent` | `agent`: fresh unprivileged user (most blind, no sudo). `user`: Boat's default user with a fresh HOME (has passwordless sudo) |
| `BOAT_ON_FINISH` | `delete` | `delete` (permanent) or `stop` (archive; with snapshots off this also erases the disk) |
| `BOAT_DIFF_MAX_BYTES` | `2000000` | cap on the `git diff` event |
| **docker / local** | | |
| `SANDBOX_IMAGE` | `octillion-sandbox:latest` | |
| `DOCKER_NETWORK`, `DOCKER_CPUS` (2), `DOCKER_MEMORY` (4g) | | container limits |
| `CLAUDE_BIN`, `CODEX_BIN` | `claude`, `codex` | override the CLI path, local runner only |

## Run

```bash
export OCTILLION_URL=https://octillion.example.com OCTILLION_WORKER_TOKEN=...
export ANTHROPIC_API_KEY=... OPENAI_API_KEY=...

# boat.dev (default)
export BOAT_API_KEY=...
WORKER_CONCURRENCY=8 MAX_SESSION_MINUTES=45 npx tsx orchestrator/worker.ts

# docker: build the image first
docker build -f orchestrator/Dockerfile.sandbox -t octillion-sandbox:latest orchestrator
RUNNER=docker WORKER_CONCURRENCY=4 npx tsx orchestrator/worker.ts

# dev: no isolation, runs the CLIs installed on the host
RUNNER=local WORKER_CONCURRENCY=1 npx tsx orchestrator/worker.ts
```

To scale out, run more worker processes. Claims are atomic on the server. On boat, the worker host only does
HTTP, so one small machine can drive many VMs. SIGINT/SIGTERM kills (deletes) running sandboxes and reports them as `failed`.
A second signal exits immediately. Those VMs are then left to their TTL. If `/events` or `/heartbeat` returns 404 or 409
(session cancelled or timed out on the server), the sandbox is killed and `/complete` is skipped.

## Security notes

- **Blindness.** The sandbox receives only the prompt (on stdin), the optional repo, the model's API key and a few
  generic env vars. It never receives the session or simulation id, the Octillion URL or token, or the customer's
  name. On boat, the harness runs as a separate `agent` user under `env -i`, so it sees no `BOAT_*`/`ASCII_*`
  variables, no Boat credential and none of Boat's harness config (system prompt, `boat` skill, `computer` MCP). `noEnv`
  keeps the Boat account's own secrets off the VM. Staging files live in `/tmp/octi` (mode 700), which `agent` can't read,
  and the secrets file is deleted before the harness starts. In Docker, container names are random, the workdir is
  `/home/agent/work` and the image is product-neutral. Don't bake customer or competitor SDKs or config into it. The local runner points
  `HOME`/`CODEX_HOME` at an empty temp dir so your own `~/.claude`, CLAUDE.md, MCP servers and memories don't leak in.
- **No customer data in prompts.** Scenario prompts must read like a real developer's task. The worker
  sends them verbatim, so any hint in the prompt reaches the agent.
- **Network.** Agents need egress (package registries, docs, the model API). They run with
  `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`, which is safe only because the VM or container
  is the sandbox. A boat VM is a full VM with its own kernel and public egress, and it is deleted after the session.
  In Docker, containers run non-root with `--cap-drop ALL`, `no-new-privileges` and pids/cpu/memory limits.
  Never mount the Docker socket or host paths. On a shared Docker host, use a `DOCKER_NETWORK` that blocks
  169.254.169.254 and private ranges.
- **API keys.** The agent can read its own key (`env`). Use dedicated, scoped, spend-limited keys:
  an Anthropic workspace key with a spend cap and an OpenAI project key with a budget. Rotate them often and never
  reuse production keys. Each sandbox gets only the key for its own harness. Model keys reach boat only as a file inside the
  VM, never as Boat account secrets. Transcripts can contain anything the agent printed, so treat stored JSONL as sensitive.
- `RUNNER=local` gives **no isolation**. The agent runs as your user with full permissions. Use it in dev only.

## Verified vs unverified (boat runner)

Verified against a local mock of the documented API, backed by an Ubuntu 24.04 container. The mock ran create, ready-poll,
file writes, sync, detached and streamed exec, command status and delete. These worked:

- the prompt arrives byte-for-byte (quotes, `$HOME`, backticks, non-ASCII, no trailing newline)
- the agent user's env holds only the harness variables
- JSONL streams live and survives frames split mid-line
- the git diff works with and without a repo
- the timeout path deletes the VM and reports `timeout`
- a missing CLI fails cleanly and still deletes the VM
- `BOAT_AGENT_USER=user` works

**Not run against live boat.dev** (no key was available). These are unverified:

- the exact `GET /me` response shape (used only for a log line)
- whether `tail --pid` sees the detached launcher's pid (`pid` from the detached start). If it doesn't, the follower still ends via the status poll after each 540s tail.
- whether the preinstalled `claude`/`codex` live outside `/home/user`, so that the `agent` user can run them. The docs say `/usr/local` and `/opt`. If they don't, prepare fails with a clear message. Set `BOAT_AGENT_USER=user`.
- whether streamed `data` chunks can split a multi-byte UTF-8 character, which would corrupt one character in a line
- the real time from create to ready

## Open questions

1. **Plan.** On the trial, 2 concurrent VMs and a 2h TTL cap rule out running in parallel. The $20 plan (100 concurrent, 12 starts/min) is
   probably enough for early simulations. Larger batches hit the start rate (200/day on $20) before cost does.
2. **Template snapshot.** Should we pin harness versions? Boat refreshes its preinstalled CLIs, so results can drift between runs.
   We could pin by `npm i -g` into a named snapshot and create from it (`from: <name>`). That also speeds up start.
3. **Agent sudo.** The `agent` user has no sudo, the same as Docker, so the agent can't `apt-get install`. Use `BOAT_AGENT_USER=user` if scenarios need system packages.
4. **EU-only regions.** Is that acceptable for customer data, given that Boat is not yet SOC 2?
5. **Egress filtering.** Do we want it? Boat VMs have open internet. Firewall rules inside the VM are possible, but they aren't set up yet.
6. **Exact billing.** Should we call `GET /sandboxes/{id}/usage` before deleting, so that `/complete` reports Boat's exact metered cost instead of an estimate?
