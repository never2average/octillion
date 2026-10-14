# Object storage (Cloudflare R2)

One private R2 bucket (`R2_BUCKET`, today `octillion-backup`) holds everything that must survive the machine and the
managed services. There is one prefix per kind of data, and `src/storage.ts` is the only code that builds keys.

| Prefix | What | Written by | Kept |
|---|---|---|---|
| `postgres/` | daily `pg_dump` of the database, copied hourly | `pg-backup-offsite` service (rclone) | newest 10 (`OFFSITE_KEEP`; the volume keeps `BACKUP_KEEP`, 10) |
| `transcripts/org-<id>/<yyyy-mm>/<session>.jsonl.gz` | every finished session's full trace | `src/archive.ts` sweeper | indefinitely |
| `research/org-<id>/<research_id>.json` | every finished onboarding research result (product, personas, problems, sources) | `src/archive.ts` sweeper | indefinitely |
| `reports/org-<id>/<simulation>/<stamp>.pdf` and `.html` | run reports | reports (planned: `export_report`) | until deleted |
| `diffs/org-<id>/<simulation>/<session>.diff.gz` | workspace diffs | reserved | — |
| `exports/org-<id>/…` | customer data exports | reserved | — |
| `ops/…` | internal one-offs | by hand | — |

Customer data always sits under its org's prefix (`org-<id>`, the id, because slugs can be renamed), so access can be
scoped per org by construction. Links handed out are signed, path-style and expire in at most 7 days.

## Trace archive

A session's archive is gzipped JSONL. The first line is a header, `{"_session": {...}}`, with org, product,
simulation, scenario, persona, agent, harness, model, status, completed reason, verdict, winner, cost and tokens. Every
following line is one stored event, exactly as the transcript store returns it (`seq`, `ts`, `type`, `text`, `raw`).

- **When:** the server's archive sweeper runs every `OCTILLION_ARCHIVE_INTERVAL_SECONDS` (300). It claims unarchived
  finished sessions (2+ minutes after they end) and finished research with `FOR UPDATE SKIP LOCKED`, so several
  replicas never double-write; a failed upload is retried after 15 minutes. The first sweeps after a deploy backfill
  everything recorded before archiving existed.
- **Tracking:** `agent_sessions.archive_key`, `archived_at`, `archive_events`; `product_research.archive_key`,
  `archived_at`. An infrastructure retry that wipes a transcript also clears its archive key, so the retry is
  archived afresh.
- **Off switch:** `OCTILLION_ARCHIVE=off`, or leave `R2_BUCKET` unset.

## If ClickHouse goes away

ClickHouse Cloud is on a trial. When it lapses:

1. Remove `CLICKHOUSE_URL` (and its credentials) from `deploy.env` and deploy. The server falls back to the Postgres
   transcript store.
2. Nothing breaks in the meantime: transcript reads read through to the R2 archive when the live store has no events
   for a session or cannot be reached, so reports, `get_session_transcript` and evidence links keep working.
   Transcript **search** only covers the live store.
3. To make old traces searchable again, load them into the new store from inside the server container:
   `npx tsx scripts/restore-transcripts.ts [--org <id>] [--dry-run]`. Sessions the store already has are skipped, so
   it is safe to re-run. The same command fills a new ClickHouse service.

## Restoring the database

`rclone copy r2:<bucket>/postgres/<file> . && pg_restore -d octillion <file>` (see the `pg-backup-offsite` service).

## Tests

`npx tsx orchestrator/test/archive.ts`: PGlite plus a mock S3 API. It covers archiving, the layout, read-through with
paging, org scoping, restore (and re-running it), signed links and key safety.
