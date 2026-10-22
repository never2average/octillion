-- Pricing experiments on the public /pricing page (src/experiments.ts): which variant each anonymous visitor was first
-- shown, keyed by a random first-party visitor id (the oct_vid cookie), never an address or an IP. When the visitor
-- later opens Billing as an account, the account takes the same variant, so a conversion is credited to what they
-- saw. Platform data: the tenant role has no access (src/rls.ts); accounts read it through the platform scope.
CREATE TABLE IF NOT EXISTS pricing_exposures (
  visitor_id    TEXT NOT NULL CHECK (visitor_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  experiment    TEXT NOT NULL,
  price_id      TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (visitor_id, experiment)
);
CREATE INDEX IF NOT EXISTS pricing_exposures_seen ON pricing_exposures (first_seen_at);
-- Which visitor an account's exposure came from (null: first shown in the app).
ALTER TABLE plan_exposures ADD COLUMN IF NOT EXISTS visitor_id TEXT;
