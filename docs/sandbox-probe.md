# Sandbox reliability probe: boat.dev and Vercel Sandbox side by side

boat.dev runs our orchestrator and worker sandboxes, and it has been dropping them. In one production job, 18
orchestrator sandboxes each checked in once, about 37 s after they were created, then disappeared from boat's own
listing. We also saw 502s from boat's command API, and connection timeouts from Vercel (AWS us-east-1) to boat's host.

Vercel Sandbox is the candidate replacement: Firecracker microVMs in `iad1`, the same region as our functions. Before
any migration, the probe measures both providers the same way, from the same place, and puts the numbers side by side.

- **Code:** `src/sandbox-probe.ts`
- **Cron:** `/api/cron/sandbox-probe`, every 5 minutes (`vercel.json`). It is separate from the autoscaler's cron.
- **Tables:** `sandbox_probes` and `sandbox_probe_execs` (migration `0015_sandbox_probes.sql`)
- **Admin page:** Operations → Compute → **Sandbox probes**
- **Admin MCP:** the `sandbox_probe_summary` tool

The probe runs only on the Vercel deployment's cron. Nothing runs on a VM.

## What it does

A function call can't wait 15 minutes, so each probe is a small state machine that moves forward on every tick.

| Step | When | What is recorded |
|---|---|---|
| Start | Every 15 minutes per provider (`OCTILLION_SANDBOX_PROBE_EVERY_MINUTES`), with at most 2 live probes per provider | Create-call latency, time from the create call to ready, and the create error if there is one |
| Each tick | For every live probe, a round every 30 s within 150 s per tick (for all probes together), stopping early near the deadline | The provider's get API (does the sandbox still exist?), then `echo ok && uptime`: latency, exit code and error for each |
| Gone | The get API answers 404, or reports the sandbox stopped or archived, before we delete it | `gone_at` and the provider's state. This is the key number |
| End | After 15 minutes (`OCTILLION_SANDBOX_PROBE_LIFETIME_MINUTES`) | Delete latency and result |
| Hygiene | Every tick | Any probe sandbox in a provider's listing that is older than 30 minutes is deleted. Rows left in `starting` for more than 10 minutes are marked failed |

A failed get call (a timeout or a 502) is recorded as a failed check. It does not count as "gone"; only the provider
saying the sandbox no longer exists, or has stopped, counts.

**Sizes and limits:**
- boat uses `small` with a 25-minute TTL, and no environment or snapshots.
- Vercel Sandbox uses 1 vCPU and 2 GB, a 25-minute timeout, `persistent: false` (no snapshot on stop) and `iad1`.
- A probe that every later tick fails to delete still stops on its own after 25 minutes.

**Names:** probe sandboxes are named `<namespace>-probe-<random>` (for example `octv-probe-1a2b3c4d5e`).
- The autoscaler's orphan reaper deletes only `<namespace>-orch-…` names and a stale image builder (`orphanKind` in `src/autoscaler.ts`), so it never touches a probe.
- The Compute page counts probe sandboxes as ours, as "reliability probes" on the boat plan row, not as another deployment's.
- Probes do hold boat plan capacity, so the capacity math subtracts them from what orchestrators can use.

**Never in the autoscaler's way:**
- It has its own route and cron, with no lease or lock shared with the autoscaler or the campaign tick.
- Every step is wrapped in try/catch, the tick has a deadline, and a failed tick never throws.
- The boat key is read from the key vault for the probe alone. The probe never writes it into the shared `BOAT` config the autoscaler uses.
- boat creates are one attempt with no backoff, because a failed create is what the probe is measuring.

## The numbers (Compute → Sandbox probes)

Per provider, over the last 24 hours or 7 days:
- probes started and create success %;
- median and p95 ready time;
- the share of ended probes that survived 15 minutes (deleted by us, never gone first);
- the gone-early count, with the median age at disappearance;
- exec success %, with p50 and p95 exec latency;
- get API success %;
- delete success %.

Under the summary there is one row per probe. Its peek shows a card with the probe's facts, then two tabs, **Execs**
(every exec and check) and **Errors**.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `OCTILLION_SANDBOX_PROBE` | on | `off` stops it: no new probes start (existing ones stop at their TTL) |
| `OCTILLION_SANDBOX_PROBE_PROVIDERS` | `boat,vercel` | Which providers to probe |
| `OCTILLION_SANDBOX_PROBE_EVERY_MINUTES` | 15 | Start interval per provider (minimum 5) |
| `OCTILLION_SANDBOX_PROBE_LIFETIME_MINUTES` | 15 | How long a probe lives before we delete it |
| `OCTILLION_SANDBOX_PROBE_BUDGET_SECONDS` | 150 | Time per tick for all exec rounds |
| `OCTILLION_SANDBOX_PROBE_GAP_SECONDS` | 30 | Time between rounds |

**boat** uses the `boat` key in the key vault, the same one the autoscaler uses.

**Vercel Sandbox** is called over its REST API (`https://vercel.com/api/v2/sandboxes…`) with plain `fetch`. There is
no SDK in the API bundle, so the ESM-only `@vercel/sandbox` package is never `require()`d. Authentication is tried in
this order:

1. **The function's OIDC token (recommended).** Vercel sends it on every invocation in the `x-vercel-oidc-token` header (with `VERCEL_OIDC_TOKEN` as a fallback). Its `owner_id` and `project_id` claims name the team and the project the sandboxes belong to.
   - Needs OIDC Federation ("Secure backend access with OIDC federation") turned on in the project's settings. It is on by default for new projects.
   - Needs Vercel Sandbox available to the team. Sandboxes are billed to that project.
2. **An access token.** Set `OCTILLION_VERCEL_SANDBOX_TOKEN` (a Vercel access token with access to the team), plus `OCTILLION_VERCEL_TEAM_ID` and `OCTILLION_VERCEL_PROJECT_ID`.

If neither is available, every start slot records a `not_configured` row, the page says what is missing, and boat is
still probed.

## Cost

There are about 96 probe sandboxes per provider per day (one every 15 minutes), each living about 15 minutes, at the
smallest size.

| Provider | Per probe | Per day |
|---|---|---|
| boat.dev `small` ($0.018/h) | 0.25 h × $0.018 ≈ $0.0045 | ≈ $0.43 |
| Vercel Sandbox, 1 vCPU / 2 GB (Pro, iad1) | 2 GB × 0.25 h × $0.0212 ≈ $0.0106 of memory, plus under $0.001 of active CPU (the sandbox is idle) and creations at $0.60 per million | ≈ $1.08 |
| **Total** | | **≈ $1.51 a day** (about $45 a month) |

Each boat probe is also one of the account's starts, so 96 starts a day go against boat's daily start limit (200 a day
on the $20 plan, shared with real orchestrators and workers). To halve that, raise
`OCTILLION_SANDBOX_PROBE_EVERY_MINUTES` to 30.

On Vercel Pro, this usage comes out of the $20 monthly credit first. The page shows the estimate under the comparison
(`probeCost()` in `src/sandbox-probe.ts`).

## Retention

Rows are kept for 14 days. The probe's cron prunes older ones, 5,000 rows per table per tick.
