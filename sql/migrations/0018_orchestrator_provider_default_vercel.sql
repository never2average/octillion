-- boat.dev was retired on 2026-11-01: Vercel Sandbox is the only sandbox provider (orchestrator/deploy/orchestrator-host.ts).
-- A new orchestrator_sandboxes row defaults to provider 'vercel'.
--
-- The CHECK still allows 'boat': rows from before the retirement keep it and stay readable (the Compute and Spend pages
-- label them "boat.dev (retired)"). sandbox_probes keeps its CHECK for the same reason; it has no default.
--
-- Rollout-safe: only a column default changes. Every release inserts the provider explicitly, so neither the previous
-- release nor this one depends on the default.

ALTER TABLE orchestrator_sandboxes ALTER COLUMN provider SET DEFAULT 'vercel';
