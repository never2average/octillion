-- Orchestrators on Vercel Sandbox (src/autoscaler.ts, orchestrator/deploy/orchestrator-host.ts): which provider hosts
-- each orchestrator sandbox, and when that sandbox's own timeout stops it.
--
-- provider:   'boat' (boat.dev, every row before this migration) or 'vercel' (Vercel Sandbox). The autoscaler reconciles,
--             reaps and prices each row against its own provider, so boat orchestrators launched before a switch
--             finish their jobs while new ones start on Vercel.
-- expires_at: when the provider stops the sandbox by itself (Vercel's session timeout, at most 24 h on Pro). The
--             autoscaler retires an orchestrator before then and launches a fresh one for its job. NULL for boat (its
--             TTL comes from boat's own listing, as before).
--
-- Rollout-safe: two columns with defaults. The previous release never reads them; its inserts get provider 'boat'.

ALTER TABLE orchestrator_sandboxes ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'boat' CHECK (provider IN ('boat', 'vercel'));
ALTER TABLE orchestrator_sandboxes ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
