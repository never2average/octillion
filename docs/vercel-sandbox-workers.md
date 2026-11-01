# Worker sandboxes on Vercel Sandbox

Phase 1 of moving off boat.dev: the per-session **worker** sandboxes (where the coding agent runs) can run on Vercel
Sandbox. The orchestrators still run on boat. Nothing changes until `OCTILLION_SANDBOX_PROVIDER=vercel` is set on the API.

- **Orchestrator code:** `orchestrator/core/sandbox-provider.ts` (the `SandboxProvider` interface, the `boat` and
  `vercel` providers) and `orchestrator/core/runners.ts` (`vmRunner(provider)`; `boatRunner = vmRunner(boatProvider)`)
- **Server code:** `src/worker-sandboxes.ts` (the broker routes, ownership, the reaper) and `src/vercel-sandbox.ts` (the
  Vercel Sandbox REST client, fetch only)
- **Table:** `worker_sandboxes` (migration `0016_worker_sandboxes.sql`)
- **Tests:** `npx tsx orchestrator/test/vercel-workers.ts` (full sessions through `vmRunner(vercel)`, the broker and a
  mock Vercel Sandbox) and the smoke test's worker sandbox broker checks (`scripts/smoke-worker-sandboxes.ts`)

## Who creates worker sandboxes

Vercel Sandbox is authenticated with the project's OIDC token or a team access token. Either one can do anything to
every sandbox in the project, and Vercel has no token scoped to a single sandbox. The OIDC token exists only inside our
Vercel functions, so it stays there.

The orchestrator asks the API instead, with its job-scoped worker token, under `/api/worker/sandboxes`:

| Route | What it does |
|---|---|
| `GET /config` | Is Vercel Sandbox configured on this deployment (no secret in the answer) |
| `POST /` `{session_id, size, timeout_sec, name}` | Create one for a running session this token may act on. Answers `{id}` |
| `GET /:id` | `ready`, `starting`, `stopped` or `gone` |
| `POST /:id/exec` `{command, timeout_sec, stream?}` | Run `bash -c <command>`; JSON, or ND-JSON frames in boat's shape |
| `POST /:id/commands` `{command}`, `GET /:id/commands/:cid` | A detached command, and whether it is still running |
| `PUT /:id/files` `{path, content \| content_base64}` | Write a file (Vercel's `fs/write`, a one-entry tar.gz, mode 0600) |
| `POST /:id/network-policy` `{allow: [hosts]}` | The session's egress lockdown |
| `DELETE /:id`, `GET /?prefix=` | Delete; this caller's live sandboxes |

**Ownership.** Every sandbox gets a row recording its owner: `job:<sim_…>` for a per-job orchestrator's token, or
`fleet` for the shared orchestrators' token.
- Every route loads the row by id. Another owner gets 403, an unknown id 404, and a deleted sandbox 410.
- A create also needs `canActOnSession` (a job token: only its own simulation's sessions), and the session must exist and be `running`.
- At most 2 live sandboxes per session (`OCTILLION_WORKER_SANDBOX_MAX_PER_SESSION`) and 60 per owner (`…_MAX_PER_OWNER`).

**Function limits.** One broker call stays under the function's 300 s:
- An exec or a log stream is cut at `OCTILLION_WORKER_SANDBOX_EXEC_MAX_SECONDS` (280 s), and the command is killed.
- The orchestrator keeps its own calls at `OCTILLION_VERCEL_EXEC_MAX_SECONDS` (240 s).
- The harness follow loop reconnects every 200 s and resumes by line number.
- Setup scripts allowed up to 600 s (harness install, prepare, developer tools) run detached under `timeout`. The orchestrator polls them and reads their output back from files.

**Reaper.** The 5-minute autoscale cron deletes, at Vercel:
- sandboxes whose session ended;
- sandboxes past their timeout plus 10 minutes;
- listings with our prefix (`<namespace>-vw-`) and no live row, older than 30 minutes.

It makes no Vercel call when there are no rows. Vercel also stops every worker sandbox at its own timeout (`persistent: false`).

## The sandbox

Sandboxes are created with `runtime: node24` in `iad1`, the same as the probe. The image is Amazon Linux 2023, with
the default user `vercel-sandbox` (which has sudo), Node under `/vercel/runtimes`, git, and `dnf`.

Sizes (`OCTILLION_VERCEL_WORKER_SIZE`):

| Size | vCPUs | Memory |
|---|---|---|
| `small` | 1 | 2 GB |
| `default` | 2 | 4 GB |
| `large` | 4 | 8 GB |
| `xlarge` | 8 | 16 GB |

The timeout is `MAX_SESSION_MINUTES` plus a margin, capped at `OCTILLION_VERCEL_MAX_TIMEOUT_MINUTES` (300).

The boat scripts run unchanged:
- `prepare.sh` creates the unprivileged `agent` user.
- The harness is installed system-wide by `images/boat-setup/<harness>.sh`.
- `_common.sh` and the environment step find Node under nvm (boat) or `/vercel/runtimes` (Vercel), and use `apt-get` or `dnf`, whichever exists. A few Debian package names are mapped.

Vercel reports no pid for a detached command, so the launch script writes its own pid for the follower's `tail --pid`.

## Egress lockdown

Vercel Sandbox has a native network policy (an allow-list of domains, enforced outside the VM by SNI). For private runs
(`OCTILLION_EGRESS`), the runner applies the session's allow-list through `POST /:id/network-policy`. The allow-list
holds the gateway host, the package registries and the task's git host. Private, loopback, link-local (metadata) and
CGNAT subnets are denied.

A probe then runs as the agent. The gateway must answer a TLS handshake. An unlisted host, an IP literal, plain HTTP,
public DNS servers and the metadata IP must all fail. Any other result fails the open, so it fails closed, exactly as
boat's nftables lockdown does.

The policy covers the whole VM, not only the agent's uid. Everything that needs the network (harness, repo, tools) is
done before the policy is applied.

## Accounting

Session metadata gets provider-neutral keys:
- `sandbox_provider`;
- `sandbox_vm_id`;
- `sandbox_type`;
- `sandbox_seconds`;
- `sandbox_est_cost_usd`.

boat sessions also keep writing the old `boat_*` keys with the same values. The Compute and spend pages read
`sandbox_est_cost_usd` first and fall back to `boat_est_cost_usd`. The boat start counters ignore `vercel:` sessions.

The Vercel estimate uses Pro iad1 rates:
- **Active CPU:** $0.128 per vCPU-hour, multiplied by an assumed busy share (`OCTILLION_VERCEL_CPU_ACTIVE_SHARE`, 0.3).
- **Memory:** $0.0212 per GB-hour, with a 1-minute minimum.
- **Creations:** $0.60 per million.

## Switching and rolling back

1. Make sure the Vercel deployment can make sandboxes. Compute → Sandbox probes should show Vercel probes as configured and healthy. That proves the OIDC token works.
2. Set `OCTILLION_SANDBOX_PROVIDER=vercel` on the API (Vercel environment variables) and redeploy.
   - Orchestrators read it from their credentials when they **start**, so orchestrators launched after the change use Vercel workers.
   - Running ones keep boat until they exit. A per-job orchestrator exits when its run ends.
3. **Roll back:** remove the variable (or set it to `boat`) and redeploy. New orchestrators use boat again.
   - Sessions already on Vercel finish there, and the reaper cleans up what is left.
4. **For one orchestrator only** (testing): `OCTILLION_SANDBOX_PROVIDER=vercel` (or `RUNNER=vercel`) in its own env overrides the server's choice either way.

Without a Vercel token on the API, an orchestrator told to use Vercel refuses to start. It reports "Vercel Sandbox is not configured on the Octillion API" and does not silently fall back to boat.
