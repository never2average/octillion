# Security: private customer data and agent execution

Octillion keeps two kinds of data:

- **Public data**, owned by Octillion and shared on purpose: the curated task library (`library_tasks`), the
  survey-based developer profiles (`developer_profiles` with `org_id IS NULL`) and the curated harnesses
  (`harnesses/registry.json`). Every organization's research and runs may use them.
- **Private data**, owned by one organization: the personas, task sets and harnesses it brings, the personas research
  picks for it, its products, runs, transcripts and reports. Private data is never visible to, searchable by, used
  for or inferable by another organization, and never flows into the public data.

Customer-supplied text (tasks, personas) and code (harnesses) are also **untrusted**: they steer agents that run with
broad permissions, so they must not reach credentials, other tenants or the scoring.

## Controls in place

| Control | Where | Since |
|---|---|---|
| Every MCP read path is scoped to the caller's organization | `src/queries.ts` resolvers and queries | before 2026-10 |
| Real vendor keys (direct-mode providers) are never stored or brokered unless `OCTILLION_DIRECT_KEYS=allow`, never to a session running a customer-written task, never orchestrator-only keys (`boat`) | `src/gateway.ts` `brokerSessionCredentials`, `src/keyvault.ts` `setCredential` | 2026-10-15 |
| A developer profile is shared exactly when it comes from the vault: `CHECK ((org_id IS NULL) = (source = 'vault'))`, no default source | `sql/schema.sql` | 2026-10-15 |
| Vault sync never overwrites an organization's persona, even on a slug clash | `src/vault.ts` | 2026-10-15 |
| Database errors reach callers as a generic message (a unique-key clash would otherwise reveal another org's slug) | `src/server.ts` `runTool` | 2026-10-15 |
| Customer inputs (URLs, prompts) are not written to orchestrator logs | `orchestrator/pi-octillion/research.ts` | 2026-10-15 |
| Per-job worker tokens (`owk_`): an autoscaled orchestrator can claim and act on its own job's sessions or research only, speak only as itself, and cannot read the global fleet plan; revoked with its sandbox | `src/workerauth.ts`, `src/http.ts`, `src/autoscaler.ts` | 2026-10-15 |
| Organization deletion revokes keys and tokens, stops work, purges ClickHouse transcripts and every R2 org prefix (verified empty), cascades Postgres, leaves a counts-only tombstone | `src/tenancy.ts`, `scripts/delete-org.ts` | 2026-10-15 |
| Private assets: personas (random `per_` slugs), task sets and harness specs are stored with their org and readable, usable and updatable by that org only; the same error whether or not an id exists elsewhere; never in the shared library or profile search | `src/private.ts`, `src/queries.ts` `runSimulation` | 2026-10-15 |
| Customer harness specs are declarative only: integrity-pinned packages, argv without a shell, gateway providers only (no real vendor keys) | `src/private.ts` `harnessSpecIssues` | 2026-10-15 |

## Plan

| Phase | What | Status |
|---|---|---|
| 0a | Direct-mode key lock, persona table fails closed, generic DB errors, no customer data in logs | done |
| 0b | Per-job worker tokens: an autoscaled orchestrator's token is bound to one job and organization, enforced on every worker route | done |
| 0c | Organization deletion purges Postgres, ClickHouse and R2 (`npm run org:delete`) | done |
| 1 | Private personas (`save_personas`), task sets (`import_tasks`, `run_simulation {task_set}`) and harness specs (`register_harness`), owner-only; per-org encryption of private text still to do | done (encryption: phase 4) |
| 2 | Private runs only on job-dedicated orchestrators with fresh VMs; default-deny egress; customer harness specs built in isolation, pinned by digest, approved before use | planned |
| 3 | Private harness mixes (populations): saved per org, labelled in reports, never blended with the default mix | planned |
| 4 | Two-org canary isolation test over every tool and route, CI check for org predicates, prompt-injection controls, staff access log | planned |

### Custom harness mixes

Customers may define their own harness distribution as a private, named population of public agents and their own
harnesses. The default market-weighted mix stays the canonical number for headlines, case studies and cross-product
comparisons; every run records its population, reports never blend populations, and a custom-mix figure always
carries its mix label.
