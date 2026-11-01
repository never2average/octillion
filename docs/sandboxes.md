# Sandboxes: orchestrators and workers on Vercel Sandbox

Vercel Sandbox runs both kinds of sandbox:
- the **orchestrators**, launched by the API's autoscaler (see "Orchestrators" below);
- the per-session **worker** sandboxes, where the coding agent runs, created through the API's broker.

There is no other provider. `OCTILLION_SANDBOX_PROVIDER` and `OCTILLION_ORCHESTRATOR_PROVIDER` may be unset or `vercel`;
any other value is a clear error (`sandboxConfigError` in `orchestrator/core/config.ts`): the orchestrator refuses to
start, the API logs a loud banner, the autoscaler tick fails with the message, and Compute shows a red `sandbox_config`
verdict.

- **Orchestrator code:** `orchestrator/core/sandbox-provider.ts` (the `SandboxProvider` interface and the `vercel`
  provider) and `orchestrator/core/runners.ts` (`vmRunner(provider)`; `vercelRunner = vmRunner(vercelProvider())`)
- **Server code:** `src/worker-sandboxes.ts` (the broker routes, ownership, the reaper) and `src/vercel-sandbox.ts` (the
  Vercel Sandbox REST client, fetch only)
- **Table:** `worker_sandboxes` (migration `0016_worker_sandboxes.sql`)
- **Tests:** `npx tsx orchestrator/test/vercel-workers.ts` (full sessions through `vmRunner(vercelProvider())`, the broker and a
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
| `POST /:id/exec` `{command, timeout_sec, stream?}` | Run `bash -c <command>`; JSON, or ND-JSON frames |
| `POST /:id/commands` `{command}`, `GET /:id/commands/:cid` | A detached command, and whether it is still running |
| `PUT /:id/files` `{path, content \| content_base64}` | Write a file (Vercel's `fs/write`, a one-entry tar.gz, mode 0600) |
| `POST /:id/network-policy` `{allow: [hosts]}` | The session's egress lockdown |
| `DELETE /:id`, `GET /?prefix=` | Delete; this caller's live sandboxes |

**Ownership.** Every sandbox gets a row recording its owner:
- `job:<sim_…>` for a per-job orchestrator's token;
- `fleet:<orchestrator id>` for the shared orchestrators' fleet token, which must name its orchestrator in `X-Octillion-Orchestrator`. The fleet token may act as any orchestrator anyway (`canActAsOrchestrator`), so this keeps the checks equivalent while giving each orchestrator its own cap.

Rules:
- Every route loads the row by id. Another owner gets 403, an unknown id 404, and a deleted sandbox 410. A gateway (`ogw_`) token gets 401.
- A create also needs `canActOnSession` (a job token: only its own simulation's sessions), and the session must exist and be `running`. A fleet orchestrator must have checked in within 5 minutes.
- Caps are counted and the row inserted in one transaction under an advisory lock on the owner, so they hold under concurrent creates:
  - at most 2 live sandboxes per session (`OCTILLION_WORKER_SANDBOX_MAX_PER_SESSION`);
  - per owner, its orchestrator's pod capacity plus `OCTILLION_WORKER_SANDBOX_CAP_MARGIN` (4), never more than `…_MAX_PER_OWNER` (60).
- Live sandboxes of the same session held by another orchestrator (the session was re-claimed) are deleted on create.

**Function limits.** One broker call stays under the function's 300 s:
- An exec or a log stream is cut at `OCTILLION_WORKER_SANDBOX_EXEC_MAX_SECONDS` (at most 250 s), and the command is killed. The exit-status wait gets only what is left of a 280 s budget.
- The orchestrator keeps its own calls at `OCTILLION_VERCEL_EXEC_MAX_SECONDS` (240 s).
- The harness follow loop reconnects every 200 s and resumes by line number.
- Setup scripts allowed up to 600 s (harness install, prepare, developer tools) run detached under `timeout`. The orchestrator polls them and reads their output back from files.
- Buffered output of a non-streamed exec, and the long-command read-back, is capped at 16 MiB per stream, with a truncation marker. Streams wait for the socket to drain.

**Names.** Worker sandboxes are named `<namespace>-vw-<environment>-…`. The namespace is `OCTILLION_SANDBOX_NAMESPACE`
(default `octv` on Vercel, `octi` elsewhere). The environment is `prod`, `prev` or `dev` from `VERCEL_ENV`, or `OCTILLION_WORKER_SANDBOX_NAMESPACE`. Production and previews share one Vercel project, and this keeps one deployment's stray sweep away from another's sandboxes.

**Reaper.** The 5-minute autoscale cron deletes, at Vercel, sandboxes:
- whose session ended;
- that are past their timeout plus 10 minutes;
- that a newer sandbox of the same session from another orchestrator replaced;
- whose orchestrator is gone: a fleet orchestrator with no check-in for 5 minutes, or a job with no live worker token.

It then deletes listings under this environment's prefix that have no live row and are older than 30 minutes. It checks
the cron's deadline between steps, list pages and deletes, and stops cleanly (`stopped: "deadline"`) when time runs out.
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

Setup:
- `prepare.sh` creates the unprivileged `agent` user. The coding agent always runs as `agent`.
- When the pinned harness version is missing, the VM runner uploads `orchestrator/images/setup/<harness>.sh` and runs it. It installs the harness system-wide.
- `_common.sh` and the environment step find Node under `/vercel/runtimes` (or nvm), and use `dnf` (or `apt-get`), whichever exists. A few Debian package names are mapped.

Vercel reports no pid for a detached command, so the launch script writes its own pid for the follower's `tail --pid`.

## Egress lockdown

Vercel Sandbox has a native network policy (an allow-list of domains, enforced outside the VM by SNI). For private runs
(`OCTILLION_EGRESS`), the runner applies the session's allow-list through `POST /:id/network-policy`. The allow-list
holds the gateway host, the package registries and the task's git host. Private, loopback, link-local (metadata) and
CGNAT subnets are denied.

A probe then runs as the agent. The gateway must answer a TLS handshake. An unlisted host, an IP literal, plain HTTP,
public DNS servers and the metadata IP must all fail. Any other result fails the open, so it fails closed.

The lockdown is opt-in: `OCTILLION_EGRESS=private` (private runs) or `=all` (every run); unset means no lockdown. The
in-VM proxy and nftables code in `orchestrator/core/egress.ts` is kept as a fallback for a provider without a native
network policy; Vercel does not use it.

The policy covers the whole VM, not only the agent's uid. Everything that needs the network (harness, repo, tools) is
done before the policy is applied.

## Orchestrators

- **Code:** `orchestrator/deploy/orchestrator-host.ts` (the `OrchestratorHost` interface, labels and prices),
  `orchestrator/deploy/vercel-orch.ts` (`vercelHost()`: launch, the supervisor, get, list, delete, snapshots) and
  `orchestrator/deploy/orch-lib.ts` (code files, the tarball, the code hash, tuning knobs, the launch budget,
  `SANDBOX_NAMESPACE`). The autoscaler (`src/autoscaler.ts`) drives the interface. There is no manual launcher.
- **Table:** `orchestrator_sandboxes.provider` (default `vercel`, migration `0018_orchestrator_provider_default_vercel.sql`)
  and `expires_at` (migration `0017_orchestrator_host_provider.sql`)
- **Tests:** `orchestrator/test/per-job.ts` and `autoscaler.ts` (the autoscaler against a mock Vercel Sandbox,
  `orchestrator/test/vercel-orch-mock.ts`), `fleet-guard.ts` (the host guard and fleet semantics through a mock worker
  sandbox broker), `budget.ts` (the launch budget, pure), and the smoke test's `scripts/smoke-vercel-orchestrators.ts`

### Who launches them

Only the API, from the autoscaler (the 5-minute cron and event kicks on Vercel). It authenticates, in order, with:
1. a configured access token (`OCTILLION_VERCEL_SANDBOX_TOKEN` + `OCTILLION_VERCEL_TEAM_ID` + `OCTILLION_VERCEL_PROJECT_ID`), which wins over any token a request carries;
2. the function's OIDC token as the latest **cron** request carried it (`rememberCronOidcToken`, called only after
   `CRON_SECRET` was checked, kept in memory for at most 30 minutes);
3. `VERCEL_OIDC_TOKEN` in the process environment.

The token never enters a sandbox. The orchestrator gets its job's worker token in a 0600 env file, and asks the broker
for its worker sandboxes.

### The OIDC scope (which team and project)

Any request can carry an `x-vercel-oidc-token` header, and the API does not verify a token's signature (Vercel does).
A token's `owner_id` / `project_id` claims decide which team and project a call goes to, so a planted token would send
our sandboxes, and the worker token in an orchestrator's env file, to someone else's project. So every OIDC token,
whoever passes it (the launch, the worker sandbox broker, the worker reaper, the probe), must match this deployment's
scope (`vercelScope` in `src/sandbox-probe.ts`), and a mismatch is refused (`refused a Vercel OIDC token for another team
or project`):
- **Configured:** `OCTILLION_VERCEL_TEAM_ID` and `OCTILLION_VERCEL_PROJECT_ID` (not secrets). **Required in production**
  (`VERCEL_ENV=production`): without them every OIDC token is refused there and the function logs a loud banner.
- **Otherwise pinned:** to the claims of the first token from a trusted source on that instance: a cron request that
  passed `CRON_SECRET`, or the process's own `VERCEL_OIDC_TOKEN`. Until then a request's token is refused (the broker
  answers "no trusted Vercel team/project yet"). Set the two variables on previews too, so a fresh instance needs no cron first.

No other request can remember a token: the old middleware that remembered every request's header is gone.

### The launch

A failed launch records the step that failed (`launch_step`):

| Step | What happens |
|---|---|
| create | `POST /v2/sandboxes`: named `<ns>-vo-<env>-v<10 hex>`, `runtime: node24`, `persistent: false`, `OCTILLION_VERCEL_ORCH_SIZE` (`small`: 1 vCPU, 2 GB), timeout `OCTILLION_VERCEL_ORCH_TIMEOUT_MINUTES`, tag `octillion: orchestrator`. From the snapshot image when there is one. The row records the name and `expires_at` at once |
| ready | the session is `running`; Node is found under `/vercel/runtimes/node*/bin` |
| code upload | the code tarball (`tarball()` in `orch-lib.ts`), 3.5 MB chunks through `fs/write`, assembled and unpacked as root under `/opt/octillion/app`, then `npm ci` |
| configure | the service user `octi` (`useradd -r`, no sudo); the env file at `/opt/octillion/orchestrator.env` (0600, owned by `octi`); `/opt/octillion/supervisor.sh` (root, 0755); the marker `/etc/octillion/host-role` (root, 0644) `{"role":"vercel-orchestrator","provider":"vercel","sandbox_id":…,"orchestrator_id":…}`. Optional network policy |
| preflight | as `octi`, with its env: `in-sandbox.ts guard` must pass (else the launch fails here, and the sandbox is deleted, instead of crash-looping), and `in-sandbox.ts preflight` must reach `OCTILLION_URL/healthz` |
| start | `sudo -u octi env -i PATH=… HOME=/var/lib/octi bash /opt/octillion/supervisor.sh` as a detached Vercel command, never waited on; then its pid file must point at a live process |

The env file holds `OCTILLION_URL`, `OCTILLION_WORKER_TOKEN`, `ORCHESTRATOR_ID`, `RUNNER=vercel`, `POD_CAPACITY`, `OCTILLION_HOST_ROLE=vercel-orchestrator`,
`OCTILLION_SANDBOX_ID` and the non-secret tuning knobs. Values are checked against a plain character set before they
are written, so sourcing the file runs nothing.

### The supervisor

Vercel Sandbox has no systemd. `supervisor.sh` is a `Restart=on-failure` in bash:
- each start reads the env file in a subshell and `exec`s `tsx orchestrator/pi-octillion/main.ts`, appending to `/var/lib/octi/orchestrator.log`;
- a non-zero exit restarts it after 10 s; more than five deaths in a row, each within a minute of its start, slow that to 60 s;
- exit 0 (idle, or the job is over) is final: the supervisor exits too, and the autoscaler deletes the sandbox once the orchestrator has left the fleet;
- SIGTERM (or INT, HUP) is forwarded to the orchestrator, and the supervisor waits for its graceful stop (it kills its sessions and leaves the fleet).

### Lifetime and relaunch

A Vercel session stops at its timeout: at most 24 hours on Pro and Enterprise, 45 minutes on Hobby
(vercel.com/docs/sandbox/pricing). The default timeout is 360 minutes (6 hours); longer jobs are handed to a fresh
orchestrator by the relaunch below. `OCTILLION_VERCEL_ORCH_TIMEOUT_MINUTES` sets it (10 to 1440).

**Launch time budget.** A launch from the cron (or an event kick, or Run a tick now) runs inside a 300 s function. It gets
a deadline (the function's end minus 45 s for the cron's other work), checked between launch steps and capping each
command's wait. Past it the launch fails (`launch deadline reached`) and its half-launched sandbox is deleted at once.
A kick waits out another instance's lease only when that still leaves a launch 150 s.

Per-job orchestrators usually end with their job long before that. For one that does not, the autoscaler acts on
`expires_at`:
- From `OCTILLION_VERCEL_ORCH_RELAUNCH_MINUTES` before it (default `MAX_SESSION_MINUTES` + 15, never more than half the
  timeout), `staleOrchestratorIds` (src/fleet.ts) lists it, as it does an orchestrator on old code. It gets an empty
  assignment and claims nothing new, the job counts as unserved so a fresh orchestrator is launched for it, and the
  old one is deleted (`retired: sandbox timeout near`) once it has checked in again with nothing running. Its sessions
  started before the retirement end within `MAX_SESSION_MINUTES`, before the timeout.
- 5 minutes before the timeout it is deleted regardless (`TTL about to expire (sandbox timeout)`).

### Reconciliation and reaping

Each row is reconciled against Vercel. A sandbox missing from the listing (or listed as stopped) is
reaped only after a get by id says so: 404 (`sandbox gone from …`) or a stopped status (`sandbox is …`). If
the get fails, the row is kept, and the boot, TTL and stale checks still apply to it; after 3 ticks in a row it is ended
without a delete call (`sandbox gone from …: not listed and its get failed 3 ticks in a row`).

An orchestrator that checked in before and whose fleet row is gone has left the fleet and exited. It is reaped as
`job over: orchestrator exited (job <id> is <status>)` when its job is done, else `orchestrator exited: left the fleet`.
Only one that never checked in is reaped as `stale: no fleet check-in for 5 min`.

Orphans (a live sandbox under our prefix with no row) are deleted: `<ns>-vo-<env>-…` names and
image builders `<ns>-vimg-<env>-…` older than 30 minutes. Never `-vw-` worker sandboxes (the broker's reaper deletes
those once the orchestrator's token is revoked) and never another environment's names. An orchestrator sandbox under 2
minutes old is spared: its launch records it right after the create call.

### Capacity and launch rate

Vercel has no limits API. The autoscaler uses static limits:
- `OCTILLION_VERCEL_MAX_CONCURRENT` (10,000, the Pro concurrency) bounds the per-job and shared-fleet budgets;
- `OCTILLION_VERCEL_ORCH_STARTS_PER_HOUR` (120) caps orchestrator launches per hour, counted from `orchestrator_sandboxes`,
  against a runaway launch loop. Vercel's own vCPU allocation rate (Pro: 150 vCPUs a minute at first, up to 5,000) is far above it.

A job that does not fit waits with `<job> waits for sandbox capacity on Vercel Sandbox (<n> free)`; the rate cap reads
`launch rate cap: …`.

### Snapshots (optional)

With `OCTILLION_ORCH_SNAPSHOT=on`, the autoscaler builds an image per code hash: a builder sandbox named
`<ns>-vimg-<env>-<hash>` gets the code and `npm ci` (no env file, no marker, no token), then
`POST /v2/sandboxes/sessions/{id}/snapshot` (Vercel stops it) with an expiration of `OCTILLION_VERCEL_ORCH_SNAPSHOT_DAYS`
(7) after last use, and the builder is deleted. Launches then create from `{source: {type: "snapshot", snapshotId}}` and
skip the code upload. Images are found with `GET /v2/sandboxes/snapshots?name=<builder name>`. Old images are not deleted;
they expire 7 days after their last use.

### Egress

An orchestrator reaches `OCTILLION_URL` (the API and its model gateway: one host), the npm registry during `npm ci`, and,
for research, any public site (product pages, docs, package registries through `core/safe-fetch.ts`, which already
refuses private addresses). A domain allow-list would break research, so no policy is applied by default.
`OCTILLION_VERCEL_ORCH_EGRESS=locked` applies one after `npm ci`: `OCTILLION_URL`'s host, `registry.npmjs.org` and
`OCTILLION_VERCEL_ORCH_EGRESS_HOSTS` (comma separated), with private, loopback, link-local and CGNAT subnets denied
(the same network policy call as for workers). Use it for runs without research.

### Host guard

The guard (`orchestrator/core/host-guard.ts`) accepts a Vercel orchestrator only when the env file says
`OCTILLION_HOST_ROLE=vercel-orchestrator`, the root-owned marker names the same role and the same `OCTILLION_SANDBOX_ID`,
and Vercel's own indicators are there: the per-sandbox proxy CA Vercel mounts in every sandbox
(`/etc/pki/ca-trust/source/anchors/vercel-proxy-ca.pem` or `/usr/local/share/ca-certificates/vercel-proxy-ca.pem`, from
Vercel's "Proxy CA certificates" docs) and the `/vercel` tree (`/vercel/runtimes` on the node24 image, `/vercel/sandbox`
the default working directory). A Vercel function's markers (`VERCEL_REGION`, `AWS_LAMBDA_FUNCTION_NAME`) make it refuse.
It accepts no other host. Our VM has none of these files, so a copied env file and marker are still refused there.

### Draining

Live orchestrators running other code than the server ships are retired (`retired: launched before this deploy (old
code)`), unless `OCTILLION_RECYCLE_ON_DEPLOY=off`: no new claims, a replacement is launched for their job, and they are
deleted once idle. A per-job orchestrator finishes its job, exits 0, and is deleted on the next tick.

## Accounting

Session metadata gets provider-neutral keys:
- `sandbox_provider`;
- `sandbox_vm_id`;
- `sandbox_type`;
- `sandbox_seconds`;
- `sandbox_est_cost_usd`.

The Vercel estimate uses Pro iad1 rates:
- **Active CPU:** $0.128 per vCPU-hour, multiplied by an assumed busy share (`OCTILLION_VERCEL_CPU_ACTIVE_SHARE`, 0.3).
- **Memory:** $0.0212 per GB-hour, with a 1-minute minimum.
- **Creations:** $0.60 per million.

Orchestrators are priced at the same Vercel rates for `OCTILLION_VERCEL_ORCH_SIZE` (`orchSandboxCostUsd`; 1 vCPU / 2 GB
by default: about $0.08 an hour at a 0.3 busy share). Session failure classes are provider-neutral: `sandbox_permission` and `sandbox_capacity`.

## Configuration check

Before a first run, make sure the Vercel deployment can make sandboxes: Compute → Sandbox probes should show Vercel
probes as configured and healthy. That proves the OIDC token works.

Without a Vercel token on the API, an orchestrator refuses to start. It reports "Vercel Sandbox is not configured on the
Octillion API".

## Command status: what the API returns

The first live run (`sim_r6OJKC3PFtUE`, 2026-11-01) created both worker sandboxes, but the sessions sat at zero events
for 52 minutes. The broker answered "running" to every 3-second poll of a detached command that had already exited.

What the Vercel Sandbox REST API returns, per the official SDK (`packages/vercel-sandbox/src/api-client`, `validators.ts`, `command.ts`):

| Call | Answer |
|---|---|
| `POST /v2/sandboxes/sessions/{sid}/cmd` with `wait: false` | `{command: {id, name, args, cwd, sessionId, exitCode: number \| null, startedAt, durationMs?}}` (`CommandResponse`) |
| `POST …/cmd` with `wait: true` | ND-JSON: `{command}` when it starts, then log lines `{stream: "stdout"\|"stderr", data}` or `{stream: "error", data: {code, message}}`, then `{command}` with `exitCode` set |
| `GET …/cmd/{id}` | `CommandResponse`: `exitCode` may be null |
| `GET …/cmd/{id}?wait=true` | Blocks until the command exits, then `CommandFinishedResponse`: the same command with `exitCode: number` |
| `GET …/cmd/{id}/logs` | ND-JSON log lines as above; the stream ends with the command |
| `POST …/cmd/{id}/kill` `{signal}` | `CommandResponse` |

There is no `status` field on a command. The id is `command.id`.

The SDK never polls a plain GET. `Command.wait()` asks with `?wait=true`, and nothing in the SDK refreshes a running
command's `exitCode` otherwise. In production, the plain GET kept answering `exitCode: null` after the command exited.

So the client no longer trusts it:
- `VercelClient.finished()` makes a plain GET first, which settles the answer when it does carry an exit code.
- It then makes a `?wait=true` GET bounded to 2.5 s. An answer with an `exitCode` means finished; still waiting at the bound means running.
- The worker runner does not rely on the provider's status alone:
  - A launch is over when its own exit file (`/tmp/octi/exit-N`) exists.
  - A long setup step is over when its rc file exists.
  - The provider's status is only a second opinion.

Every wait now has a deadline:
- A setup step still running 60 s after its timeout (600 s for setup) is killed, and the session fails with "setup step did not finish within 600s (+60s): <step>".
- A run that reports no exit within the harness's hard limit plus 5 minutes fails with "the run did not report its exit…".

The mock Vercel Sandbox reproduces the stale plain GET (`vsbPlainGetStale`, on by default), so the tests pass only through `?wait=true` and the files.

## Diagnostics: sandbox logs

Compute has a labelled button in the orchestrator peek ("Orchestrator log", Vercel orchestrators) and in the session peek
("Worker setup logs", open sessions and Vercel sessions). It reads the last 64 KB from inside the sandbox through
`GET /api/admin/onboarding/compute/sandbox-logs?orchestrator=<row id>|session=<session id>&kb=` (`src/sandbox-diagnostics.ts`).

- **Orchestrator:** `/var/lib/octi/orchestrator.log`, the supervisor pid, processes and disk.
- **Worker:** the setup log (`/tmp/.octi-x/setup.log`, the tail of every long setup step with its exit code), the harness error logs (`/tmp/octi/err-N.log`), the run files with their pid and exit values, and processes.
- **Limits:** platform admins only, and two fixed read-only scripts. The only input that reaches a script is the byte count, clamped to 1–256 KB.
- **Redaction:** token-shaped values are redacted before the answer leaves the API: `ogw_`, `owk_`, provider keys, bearer credentials, `*_KEY=`/`*_TOKEN=` values, JWTs and URL passwords.
- **Scope:** Vercel sandboxes only.

## What only a live run can confirm

The mocks follow the official SDK's REST calls, but these have not been seen live yet:

- The `fs/write` archive format and the owner of the files it writes. If extracted files are not readable by the commands' user, set `OCTILLION_VERCEL_WRITE_VIA=exec` (base64 chunks through commands).
- That the logs stream of a finished command still returns its whole output, and that `GET …/cmd/{id}?wait=true` answers within the 2.5 s bound for a finished command (the plain GET's stale `exitCode: null` was seen live).
- `sudo -n -u agent`, `useradd`, GNU `timeout` and `tail --pid` on the `node24` image.
- The network policy body (`allow` plus `subnets.deny`) being accepted, and the probe results under it.
- How long the harness installs take on Amazon Linux 2023.

For orchestrators:
- That a detached command keeps running for the session's life (the supervisor is one), and that `sudo -n -u octi env -i …` works for the default user.
- The guard's indicators: that the proxy CA file and `/vercel/runtimes` exist and are visible to `octi` (a launch whose guard refuses fails at `preflight` with the problems listed, and nothing is left running).
- `useradd -r` and `install -o` on the node24 image; files written by `fs/write` readable through `sudo cat`.
- How long the code upload and `npm ci` take from a cron function (the launch must finish within the function's 300 s; `OCTILLION_ORCH_SNAPSHOT=on` skips both).
- That the 360-minute timeout is accepted on the team's plan (Hobby: 45 minutes; set `OCTILLION_VERCEL_ORCH_TIMEOUT_MINUTES` lower if create answers 400).
- That the OIDC token's `owner_id` / `project_id` claims equal the team and project ids set in `OCTILLION_VERCEL_TEAM_ID` / `_PROJECT_ID` (the probe page shows "refused … another team or project" if not).
- The snapshot calls (`POST …/snapshot` with `expiration`, `GET /v2/sandboxes/snapshots?name=`, `source: {type: "snapshot"}`), taken from the REST reference, not seen yet.
- The network policy for an orchestrator, if `OCTILLION_VERCEL_ORCH_EGRESS=locked` is used.

## Live test plan

1. In a test account, on a preview deployment with OIDC, set `OCTILLION_MAX_JOB_ORCHESTRATORS=1`.
2. Run one small simulation: one task, `claude-code/sonnet`, one repeat.
3. Watch the orchestrator log for `runner=vercel` and `vercel sandbox broker OK`, then the session to completion. Check that `worker_sandboxes` has its row deleted by the orchestrator and that the session metadata has `sandbox_provider: vercel`.
4. Repeat with `OCTILLION_EGRESS=all` to see the network policy and its probe pass.
5. Repeat once per harness (codex, opencode, cline, kilo, pi, cursor) to record install times and failures.

### Orchestrators

On a preview deployment (`VERCEL_ENV=preview`: names `<ns>-vo-prev-…`, apart from production's), never production first:
1. Set `OCTILLION_VERCEL_TEAM_ID` and `OCTILLION_VERCEL_PROJECT_ID` (the OIDC scope), `OCTILLION_MAX_JOB_ORCHESTRATORS=1`
   and `OCTILLION_VERCEL_ORCH_TIMEOUT_MINUTES=60` (a stray sandbox stops within the hour), and redeploy the preview.
2. Queue one small onboarding research or a one-session run in a test account and run a tick (Compute → Run a tick now).
3. Compute → Orchestrators: the row says `Vercel Sandbox` and goes `booting` → `running`. If it ends instead, its
   `launch_step` and error name what failed (a guard refusal lists the missing indicators).
4. In the Vercel dashboard (Observability → Sandboxes), the sandbox `<ns>-vo-prev-…` runs. Its log is
   `/var/lib/octi/orchestrator.log` (`sandbox exec <name> -- sudo tail -n 200 /var/lib/octi/orchestrator.log` with the Vercel CLI).
5. The job finishes, the orchestrator exits 0 and leaves the fleet, and the next tick deletes the sandbox (`job over: orchestrator exited (job … is …)`).
6. Relaunch: set `OCTILLION_VERCEL_ORCH_TIMEOUT_MINUTES=20` and `OCTILLION_VERCEL_ORCH_RELAUNCH_MINUTES=10` with a run that
   lasts longer; after about 10 minutes a second orchestrator takes the job and the first is deleted (`retired: sandbox timeout near`).
7. Unset the test variables afterwards.

## History

boat.dev was retired on 2026-11-01. It hosted the orchestrators and worker sandboxes before Vercel Sandbox. Old
orchestrator rows (provider `boat`, closed without a provider call if still live) and sessions' `boat_*` metadata stay
readable, labelled "boat.dev (retired)" on Compute and Spend; old `boat_*` error-class links and tick notes still work.
`RUNNER=boat` and the `boat-orchestrator` host role are refused. An existing `boat` key is listed as retired in Key vault
and can be deleted there.
