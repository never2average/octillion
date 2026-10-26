-- Questions research asks the customer (orchestrator/pi-octillion/architect.ts): when the architecture review is still
-- unsure after its rounds whether a tool competes with the product or is used with it, it does not guess. The tool is
-- kept off the scoring (product.competitors[].unconfirmed) and the customer picks the description that fits; the
-- answer updates the product and rescores its sessions (src/questions.ts).
CREATE TABLE IF NOT EXISTS product_questions (
  id           TEXT PRIMARY KEY,                       -- pq_<random>
  org_id       INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id   INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  research_id  TEXT,                                   -- the research job that asked
  kind         TEXT NOT NULL CHECK (kind IN ('competitor_relation')),
  subject      TEXT NOT NULL,                          -- the tool asked about (a competitor's name)
  question     TEXT NOT NULL,
  options      JSONB NOT NULL,                         -- [{id, label, relation}]
  context      JSONB,                                  -- the reviewer's reasoning and evidence, for the customer
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'dismissed')),
  answer       JSONB,                                  -- {option, note}
  answered_by  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS product_questions_open ON product_questions (product_id, status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS product_questions_one_open ON product_questions (product_id, kind, lower(subject)) WHERE status = 'open';

-- Tenant table (0003_row_level_security): an account reads and answers its own questions only; research (the worker
-- API, the app's own role) creates them.
DO $mig$
DECLARE r TEXT := octillion_tenant_role();
BEGIN
  ALTER TABLE product_questions ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON product_questions;
  EXECUTE format('CREATE POLICY tenant_isolation ON product_questions TO %I USING (org_id = octillion_tenant_org()) WITH CHECK (org_id = octillion_tenant_org())', r);
  EXECUTE format('GRANT SELECT, UPDATE ON product_questions TO %I', r);
END $mig$;


-- The architecture review investigates with its own search budget (src/websearch.ts SEARCH.architectMaxPerJob), so it
-- never uses up the research session's.
ALTER TABLE product_research ADD COLUMN IF NOT EXISTS architect_searches INT NOT NULL DEFAULT 0;
