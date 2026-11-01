# Workers and orchestrators on Vercel Sandbox

Moving off boat.dev, in two phases. Nothing changes until `OCTILLION_SANDBOX_PROVIDER=vercel` is set on the API.

- **Phase 1:** the per-session **worker** sandboxes (where the coding agent runs) run on Vercel Sandbox, created through
  the API's broker.
- **Phase 2:** the **orchestrators** run on Vercel Sandbox too, launched by the autoscaler (see "Orchestrators on Vercel
  Sandbox" below). The same variable selects both; `OCTILLION_ORCHESTRATOR_PROVIDER` overrides it for orchestrators only.

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

**Names.** Worker sandboxes are named `<namespace>-vw-<environment>-…`. The environment is `prod`, `prev` or `dev` from `VERCEL_ENV`, or `OCTILLION_WORKER_SANDBOX_NAMESPACE`. Production and previews share one Vercel project, and this keeps one deployment's stray sweep away from another's sandboxes.

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

## Orchestrators on Vercel Sandbox

- **Code:** `orchestrator/deploy/orchestrator-host.ts` (the `OrchestratorHost` interface, `boatHost()`, provider selection,
  labels and prices) and `orchestrator/deploy/vercel-orch.ts` (`vercelHost()`: launch, the supervisor, get, list, delete,
  snapshots). The autoscaler (`src/autoscaler.ts`) and the boat CLI (`orchestrator/deploy/boat-orchestrators.ts`) drive
  the interface; boat's host is `deploy/boat-lib.ts`, unchanged.
- **Table:** `orchestrator_sandboxes.provider` (`boat` or `vercel`) and `expires_at` (migration `0017_orchestrator_host_provider.sql`)
- **Tests:** `orchestrator/test/per-job.ts` and `autoscaler.ts` (the autoscaler against a mock Vercel Sandbox,
  `orchestrator/test/vercel-orch-mock.ts`), `boat-fleet.ts` (the host guard), and the smoke test's
  `scripts/smoke-vercel-orchestrators.ts`

### Selection

| `OCTILLION_SANDBOX_PROVIDER` | `OCTILLION_ORCHESTRATOR_PROVIDER` | Orchestrators | Workers |
|---|---|---|---|
| unset or `boat` | unset | boat | boat |
| `vercel` | unset | Vercel | Vercel |
| `vercel` | `boat` | boat | Vercel (phase 1 alone) |
| unset or `boat` | `vercel` | Vercel | boat |

### Who launches them

Only the API, from the autoscaler (the 5-minute cron and event kicks on Vercel). It authenticates, in order, with:
1. a configured access token (`OCTILLION_VERCEL_SANDBOX_TOKEN` + `OCTILLION_VERCEL_TEAM_ID` + `OCTILLION_VERCEL_PROJECT_ID`), which wins over any token a request carries;
2. the function's OIDC token as the latest **cron** request carried it (`rememberCronOidcToken`, called only after
   `CRON_SECRET` was checked, kept in memory for at most 30 minutes);
3. `VERCEL_OIDC_TOKEN` in the process environment.

The token never enters a sandbox. The orchestrator gets its job's worker token in a 0600 env file, and asks the broker
(phase 1) for its worker sandboxes. The boat CLI cannot launch Vercel orchestrators and says so.

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

The steps keep boat's names, so failed launches classify the same way (`launch_step`):

| Step | What happens |
|---|---|
| create | `POST /v2/sandboxes`: named `<ns>-vo-<env>-v<10 hex>`, `runtime: node24`, `persistent: false`, `OCTILLION_VERCEL_ORCH_SIZE` (`small`: 1 vCPU, 2 GB), timeout `OCTILLION_VERCEL_ORCH_TIMEOUT_MINUTES`, tag `octillion: orchestrator`. From the snapshot image when there is one. The row records the name and `expires_at` at once |
| ready | the session is `running`; Node is found under `/vercel/runtimes/node*/bin` |
| code upload | the boat tarball (`tarball()`), 3.5 MB chunks through `fs/write`, assembled and unpacked as root under `/opt/octillion/app`, then `npm ci` |
| configure | the service user `octi` (`useradd -r`, no sudo); the env file at `/opt/octillion/orchestrator.env` (0600, owned by `octi`); `/opt/octillion/supervisor.sh` (root, 0755); the marker `/etc/octillion/host-role` (root, 0644) `{"role":"vercel-orchestrator","provider":"vercel","sandbox_id":…,"orchestrator_id":…}`. Optional network policy |
| preflight | as `octi`, with its env: `in-sandbox.ts guard` must pass (else the launch fails here, and the sandbox is deleted, instead of crash-looping), and `in-sandbox.ts preflight` must reach `OCTILLION_URL/healthz` |
| start | `sudo -u octi env -i PATH=… HOME=/var/lib/octi bash /opt/octillion/supervisor.sh` as a detached Vercel command, never waited on; then its pid file must point at a live process |

The env file holds `OCTILLION_URL`, `OCTILLION_WORKER_TOKEN`, `ORCHESTRATOR_ID`, `RUNNER=boat` (the server's
`sandbox_provider` then picks the workers, as on boat), `POD_CAPACITY`, `OCTILLION_HOST_ROLE=vercel-orchestrator`,
`OCTILLION_SANDBOX_ID` and the non-secret tuning knobs. Values are checked against a plain character set before they
are written, so sourcing the file runs nothing.

### The supervisor

Vercel Sandbox has no systemd. `supervisor.sh` is the boat unit's `Restart=on-failure` in bash:
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

Each row is reconciled against its own provider. A sandbox missing from the provider's listing (or listed as stopped) is
reaped only after the provider's get by id says so: 404 (`sandbox gone from …`) or a stopped status (`sandbox is …`). If
the get fails, the row is kept, and the boot, TTL and stale checks still apply to it; after 3 ticks in a row it is ended
without a delete call (`sandbox gone from …: not listed and its get failed 3 ticks in a row`). This applies to boat too,
whose listing has dropped live sandboxes before (docs/sandbox-probe.md).

Orphans (a live sandbox under our prefix with no row) are deleted per provider: on Vercel, `<ns>-vo-<env>-…` names and
image builders `<ns>-vimg-<env>-…` older than 30 minutes. Never `-vw-` worker sandboxes (the broker's reaper deletes
those once the orchestrator's token is revoked) and never another environment's names. An orchestrator sandbox under 2
minutes old is spared (on boat too): its launch records it right after the create call.

### Capacity and launch rate

Vercel has no limits API. The autoscaler uses static limits:
- `OCTILLION_VERCEL_MAX_CONCURRENT` (10,000, the Pro concurrency) replaces boat's plan concurrency in the per-job and shared-fleet budgets;
- `OCTILLION_VERCEL_ORCH_STARTS_PER_HOUR` (120) caps orchestrator launches per hour, counted from `orchestrator_sandboxes`,
  against a runaway launch loop. Vercel's own vCPU allocation rate (Pro: 150 vCPUs a minute at first, up to 5,000) is far above it.

With orchestrators on Vercel and workers on boat (`OCTILLION_ORCHESTRATOR_PROVIDER=vercel` alone), a run's pods also
have to fit boat's plan (from `/limits`, as before): every live orchestrator's pods and the boat-hosted orchestrators
count there, and a run that does not fit waits with `… waits for sandbox capacity on boat.dev (<n> free)`.

A job that does not fit waits with `<job> waits for sandbox capacity on Vercel Sandbox (<n> free)`; the rate cap reads
`launch rate cap: …`. Ticks from before this change read `waits for boat plan capacity`, and the Compute pages read both.

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
(the phase 1 call). Use it for runs without research.

### Host guard

The guard (`orchestrator/core/host-guard.ts`) accepts a Vercel orchestrator only when the env file says
`OCTILLION_HOST_ROLE=vercel-orchestrator`, the root-owned marker names the same role and the same `OCTILLION_SANDBOX_ID`,
and Vercel's own indicators are there: the per-sandbox proxy CA Vercel mounts in every sandbox
(`/etc/pki/ca-trust/source/anchors/vercel-proxy-ca.pem` or `/usr/local/share/ca-certificates/vercel-proxy-ca.pem`, from
Vercel's "Proxy CA certificates" docs) and the `/vercel` tree (`/vercel/runtimes` on the node24 image, `/vercel/sandbox`
the default working directory). A Vercel function's markers (`VERCEL_REGION`, `AWS_LAMBDA_FUNCTION_NAME`) make it refuse.
boat's checks are unchanged. Our VM has none of these files, so a copied env file and marker are still refused there.

### Draining on a switch

When `OCTILLION_SANDBOX_PROVIDER` changes, the next tick launches new orchestrators on the new provider. Live ones on the
old provider:
- a **per-job** orchestrator finishes its job where it is (it is not retired), then leaves and is deleted on its provider;
- a **shared** orchestrator (`OCTILLION_ORCH_PER_JOB=off`) is retired like an old-code one (`retired: orchestrators moved
  to …`): no new claims, a replacement on the new provider, deleted once idle.

The boat key stays needed while a boat orchestrator is live or workers are on boat. With everything on Vercel, the Compute
page stops flagging a missing boat key.

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

Orchestrators are priced by their provider (`orchSandboxCostUsd`): boat's `small` rate, or the same Vercel rates for
`OCTILLION_VERCEL_ORCH_SIZE` (1 vCPU / 2 GB by default: about $0.08 an hour at a 0.3 busy share). The Compute page labels
each orchestrator `boat.dev` or `Vercel Sandbox`, says where orchestrators and workers run (Environment), and counts boat
starts from boat orchestrators only. Session failure classes are provider-neutral: `sandbox_permission` and
`sandbox_capacity` (they were `boat_permission` and `boat_capacity`; old filter links still work).

## Switching and rolling back

1. Make sure the Vercel deployment can make sandboxes. Compute → Sandbox probes should show Vercel probes as configured and healthy. That proves the OIDC token works.
2. Set `OCTILLION_SANDBOX_PROVIDER=vercel` on the API (Vercel environment variables) and redeploy.
   - Orchestrators read it from their credentials when they **start**, so orchestrators launched after the change use Vercel workers.
   - Running ones keep boat until they exit. A per-job orchestrator exits when its run ends.
3. **Roll back:** remove the variable (or set it to `boat`) and redeploy. New orchestrators use boat again.
   - Sessions already on Vercel finish there, and the reaper cleans up what is left.
4. **For one orchestrator only** (testing): `OCTILLION_SANDBOX_PROVIDER=vercel` (or `RUNNER=vercel`) in its own env overrides the server's choice either way.

Without a Vercel token on the API, an orchestrator told to use Vercel refuses to start. It reports "Vercel Sandbox is not configured on the Octillion API" and does not silently fall back to boat.

**Orchestrators.** The same variable moves them (unless `OCTILLION_ORCHESTRATOR_PROVIDER` says otherwise): orchestrators
launched after the change start on Vercel, and the boat ones drain as described above. To roll back, unset it: new
orchestrators start on boat, and the Vercel ones finish their jobs (or are retired, for shared ones). To try Vercel
orchestrators alone, set `OCTILLION_ORCHESTRATOR_PROVIDER=vercel` and leave the workers on boat, or the reverse.

**Rolling back the code.** A release from before this change does not know the `provider` column: it would treat a
Vercel orchestrator's row as a boat sandbox that boat's listing lacks and end it, and it cannot delete it at Vercel. So:
1. switch the provider back to boat (unset `OCTILLION_SANDBOX_PROVIDER` and `OCTILLION_ORCHESTRATOR_PROVIDER`) and redeploy the same code;
2. let the Vercel orchestrators drain: Compute → Orchestrators, filter "Runs on" Vercel Sandbox, until none is live
   (each ends with its job, or at its timeout, at most `OCTILLION_VERCEL_ORCH_TIMEOUT_MINUTES`);
3. then roll back the code. Migration 0017's columns stay; older releases ignore them.

## What only a live run can confirm

The mocks follow the official SDK's REST calls, but these have not been seen live yet:

- The `fs/write` archive format and the owner of the files it writes. If extracted files are not readable by the commands' user, set `OCTILLION_VERCEL_WRITE_VIA=exec` (base64 chunks through commands).
- Whether the logs stream of a finished command still returns its whole output, and whether `GET …/cmd/{id}` reports `exitCode: null` while running.
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

1. In a test account, on a preview deployment with OIDC, set `OCTILLION_SANDBOX_PROVIDER=vercel` and `OCTILLION_MAX_JOB_ORCHESTRATORS=1`.
2. Run one small simulation: one task, `claude-code/sonnet`, one repeat.
3. Watch the orchestrator log for `runner=vercel` and `vercel sandbox broker OK`, then the session to completion. Check that `worker_sandboxes` has its row deleted by the orchestrator and that the session metadata has `sandbox_provider: vercel`.
4. Repeat with `OCTILLION_EGRESS=all` to see the network policy and its probe pass.
5. Repeat once per harness (codex, opencode, cline, kilo, pi, cursor) to record install times and failures.
6. Unset the variable afterwards; the next orchestrator is on boat again.

### Orchestrators

On a preview deployment (`VERCEL_ENV=preview`: names `<ns>-vo-prev-…`, apart from production's), never production first:
1. Leave `OCTILLION_SANDBOX_PROVIDER` unset and set `OCTILLION_VERCEL_TEAM_ID` and `OCTILLION_VERCEL_PROJECT_ID` (the OIDC scope), `OCTILLION_ORCHESTRATOR_PROVIDER=vercel`, `OCTILLION_MAX_JOB_ORCHESTRATORS=1`
   and `OCTILLION_VERCEL_ORCH_TIMEOUT_MINUTES=60` (a stray sandbox stops within the hour), and redeploy the preview.
2. Queue one small onboarding research or a one-session run in a test account and run a tick (Compute → Run a tick now).
3. Compute → Orchestrators: the row says `Vercel Sandbox` and goes `booting` → `running`. If it ends instead, its
   `launch_step` and error name what failed (a guard refusal lists the missing indicators).
4. In the Vercel dashboard (Observability → Sandboxes), the sandbox `<ns>-vo-prev-…` runs. Its log is
   `/var/lib/octi/orchestrator.log` (`sandbox exec <name> -- sudo tail -n 200 /var/lib/octi/orchestrator.log` with the Vercel CLI).
5. The job finishes, the orchestrator exits 0, and the next tick deletes the sandbox (`drained (job … over or idle)`).
6. Relaunch: set `OCTILLION_VERCEL_ORCH_TIMEOUT_MINUTES=20` and `OCTILLION_VERCEL_ORCH_RELAUNCH_MINUTES=10` with a run that
   lasts longer; after about 10 minutes a second orchestrator takes the job and the first is deleted (`retired: sandbox timeout near`).
7. Then the workers too: `OCTILLION_SANDBOX_PROVIDER=vercel` (phase 1's test plan), still on the preview.
8. Unset the variables; new orchestrators start on boat again.
