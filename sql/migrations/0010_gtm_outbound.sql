-- GTM phase 2 (src/gtm-crm.ts, src/gtm-apollo.ts, src/gtm-outbound.ts, src/gtm-deals.ts): outbound prospecting and a
-- light CRM. Companies and prospects (CSV import, Apollo search and enrichment), outbound sequences from a sender
-- identity on an outreach subdomain with a warm-up cap, deals on a pipeline, and outbound in Attribution.
--
-- Where email addresses live (the rule from 0008 / 0009, one addition): a prospect's address is stored in
-- gtm_prospects only, and, once a campaign writes to them, in gtm_campaign_recipients (and gtm_replies when they
-- answer). Nothing else holds one: gtm_companies keeps a domain, gtm_prospect_activities, gtm_deals, gtm_deal_stages
-- and gtm_apollo_usage hold none, and gtm_apollo_cache keeps Apollo's search answers with any address scrubbed (its
-- people search never returns one). A suppressed address is checked by its hash (email_suppressions), and the lawful
-- basis recorded at import goes to the consent ledger by hash too (src/gtm-consent.ts).
--
-- Platform (staff) tables, like 0008's and 0009's: the tenant role is granted nothing on them and src/rls.ts lists them
-- as NO_ACCESS. The ones that point at an account (org_id) have row-level security on with no tenant policy.

-- ---------- companies ----------
CREATE TABLE IF NOT EXISTS gtm_companies (
  id                 BIGSERIAL PRIMARY KEY,
  domain             TEXT NOT NULL UNIQUE CHECK (domain = lower(domain) AND domain <> ''),   -- the dedupe key: example.com, no www.
  name               TEXT NOT NULL,
  industry           TEXT,
  size               TEXT,                                -- a band: 1-10, 11-50, 51-200, 201-500, 501-1000, 1001-5000, 5001+
  employees          INT,                                 -- Apollo's estimate, when enriched
  country            TEXT,                                -- ISO 3166 alpha-2
  source             TEXT NOT NULL DEFAULT 'manual',      -- csv, apollo, manual, signup
  owner              TEXT,                                -- the admin who owns it
  org_id             INT REFERENCES organizations(id) ON DELETE SET NULL,   -- the Octillion account it became
  linked_at          TIMESTAMPTZ,
  apollo_id          TEXT,
  enrichment         JSONB,                               -- the latest Apollo organization record (no addresses in it)
  enriched_at        TIMESTAMPTZ,
  enrichment_source  TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gtm_companies_org ON gtm_companies (org_id) WHERE org_id IS NOT NULL;

-- ---------- prospects ----------
-- status: new -> contacted (first outbound email) -> replied -> interested | not_interested; customer (signed up, or
-- their account is linked); bad_email (a hard bounce, or Apollo says the address is invalid).
-- lawful_basis: required at import (rows without one are refused). legitimate_interest (B2B outreach about something
-- relevant to their role), consent (they agreed), contract. Someone in the EU, EEA, UK or Switzerland (or with no
-- country) is only ever written to by a campaign that allows them (allow_restricted), with a basis recorded.
CREATE TABLE IF NOT EXISTS gtm_prospects (
  id                 BIGSERIAL PRIMARY KEY,
  company_id         BIGINT REFERENCES gtm_companies(id) ON DELETE SET NULL,
  first_name         TEXT,
  last_name          TEXT,
  title              TEXT,
  seniority          TEXT,
  email              TEXT CHECK (email IS NULL OR email = lower(email)),
  email_status       TEXT NOT NULL DEFAULT 'unknown' CHECK (email_status IN ('verified', 'unverified', 'likely_to_engage', 'extrapolated', 'unavailable', 'invalid', 'unknown')),
  linkedin_url       TEXT,                                -- a plain field: nothing ever visits it
  country            TEXT,
  time_zone          TEXT,                                -- IANA
  status             TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'replied', 'interested', 'not_interested', 'customer', 'bad_email')),
  owner              TEXT,
  tags               TEXT[] NOT NULL DEFAULT '{}',
  source             TEXT NOT NULL DEFAULT 'manual',      -- csv, apollo, manual
  lawful_basis       TEXT NOT NULL CHECK (lawful_basis IN ('legitimate_interest', 'consent', 'contract')),
  basis_note         TEXT,                                -- e.g. "B2B: CTO of a developer-tools company"
  basis_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  org_id             INT REFERENCES organizations(id) ON DELETE SET NULL,   -- linked when they (or their domain) sign up
  request_id         INT REFERENCES access_requests(id) ON DELETE SET NULL, -- their access request, when they made one
  linked_at          TIMESTAMPTZ,
  apollo_id          TEXT,
  enrichment         JSONB,                               -- the latest Apollo person record, its address removed (it is in email)
  enriched_at        TIMESTAMPTZ,
  enrichment_source  TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gtm_prospects_email ON gtm_prospects (email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS gtm_prospects_apollo ON gtm_prospects (apollo_id) WHERE apollo_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gtm_prospects_company ON gtm_prospects (company_id);
CREATE INDEX IF NOT EXISTS gtm_prospects_status ON gtm_prospects (status);

-- The timeline's own entries (emails sent, opened and replied come from the campaign tables): notes, stage changes,
-- imports, enrichment, links to an account, deals. Never an address.
CREATE TABLE IF NOT EXISTS gtm_prospect_activities (
  id           BIGSERIAL PRIMARY KEY,
  prospect_id  BIGINT NOT NULL REFERENCES gtm_prospects(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('note', 'status', 'imported', 'enriched', 'linked', 'deal', 'unsubscribed', 'bounced')),
  body         TEXT,
  data         JSONB NOT NULL DEFAULT '{}',
  actor        TEXT,
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gtm_prospect_activities_prospect ON gtm_prospect_activities (prospect_id, at DESC);

-- ---------- outbound sender identities ----------
-- Cold email goes from its own subdomain (e.g. outreach.example.com, verified in Resend), never the product's sender
-- domain: a reputation problem there never reaches sign-in or billing email. daily_cap is the most a day once warm;
-- from warmup_start the cap ramps from warmup_from (20) to daily_cap over warmup_days (28), across every campaign
-- using the identity (src/gtm-outbound.ts warmupCap).
CREATE TABLE IF NOT EXISTS gtm_sender_identities (
  id            BIGSERIAL PRIMARY KEY,
  from_name     TEXT NOT NULL,
  from_address  TEXT NOT NULL UNIQUE CHECK (from_address = lower(from_address)),
  domain        TEXT NOT NULL CHECK (domain = lower(domain)),
  daily_cap     INT NOT NULL DEFAULT 200 CHECK (daily_cap BETWEEN 1 AND 10000),
  warmup_start  DATE,                                     -- null: no ramp (the full cap from day one)
  warmup_from   INT NOT NULL DEFAULT 20 CHECK (warmup_from BETWEEN 1 AND 10000),
  warmup_days   INT NOT NULL DEFAULT 28 CHECK (warmup_days BETWEEN 1 AND 365),
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- campaigns: outbound ----------
-- sender_identity_id: required (and on another domain than EMAIL_FROM's) when the audience is prospects.
-- track_opens: null = the default (off for outbound: a text-only email, no pixel; lifecycle keeps its HTML part).
-- allow_restricted: write to prospects in the EU, EEA, UK or Switzerland (or with no country) who have a lawful basis.
ALTER TABLE gtm_campaigns ADD COLUMN IF NOT EXISTS sender_identity_id BIGINT REFERENCES gtm_sender_identities(id) ON DELETE SET NULL;
ALTER TABLE gtm_campaigns ADD COLUMN IF NOT EXISTS track_opens BOOLEAN;
ALTER TABLE gtm_campaigns ADD COLUMN IF NOT EXISTS allow_restricted BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE gtm_campaign_recipients DROP CONSTRAINT IF EXISTS gtm_campaign_recipients_source_check;
ALTER TABLE gtm_campaign_recipients ADD CONSTRAINT gtm_campaign_recipients_source_check CHECK (source IN ('account', 'request', 'prospect'));
ALTER TABLE gtm_campaign_recipients ADD COLUMN IF NOT EXISTS prospect_id BIGINT REFERENCES gtm_prospects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS gtm_campaign_recipients_prospect ON gtm_campaign_recipients (prospect_id) WHERE prospect_id IS NOT NULL;
-- The identity each email went from: the warm-up cap counts a day's sends per identity, whatever campaign sent them.
ALTER TABLE gtm_campaign_sends ADD COLUMN IF NOT EXISTS identity_id BIGINT;
CREATE INDEX IF NOT EXISTS gtm_campaign_sends_identity ON gtm_campaign_sends (identity_id, at) WHERE identity_id IS NOT NULL;

-- A prospect becoming an account or a requester is a GTM event too (attribution, triggers later).
ALTER TABLE gtm_events DROP CONSTRAINT IF EXISTS gtm_events_type_check;
ALTER TABLE gtm_events ADD CONSTRAINT gtm_events_type_check CHECK (type IN ('account_created', 'request_submitted', 'request_approved', 'stage_reached', 'stuck',
  'report_opened', 'first_payment', 'attention', 'prospect_converted'));

-- ---------- deals ----------
CREATE TABLE IF NOT EXISTS gtm_deal_stages (
  id        TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9_]{1,40}$'),
  label     TEXT NOT NULL,
  position  INT NOT NULL,
  kind      TEXT NOT NULL DEFAULT 'open' CHECK (kind IN ('open', 'won', 'lost'))
);
INSERT INTO gtm_deal_stages (id, label, position, kind) VALUES
  ('lead', 'Lead', 1, 'open'), ('qualified', 'Qualified', 2, 'open'), ('demo', 'Demo', 3, 'open'), ('proposal', 'Proposal', 4, 'open'),
  ('won', 'Won', 5, 'won'), ('lost', 'Lost', 6, 'lost')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS gtm_deals (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  stage           TEXT NOT NULL REFERENCES gtm_deal_stages(id) ON UPDATE CASCADE,
  company_id      BIGINT REFERENCES gtm_companies(id) ON DELETE SET NULL,
  prospect_id     BIGINT REFERENCES gtm_prospects(id) ON DELETE SET NULL,
  org_id          INT REFERENCES organizations(id) ON DELETE SET NULL,
  campaign_id     BIGINT REFERENCES gtm_campaigns(id) ON DELETE SET NULL,   -- the outbound campaign it came from (attribution)
  reply_id        BIGINT REFERENCES gtm_replies(id) ON DELETE SET NULL,     -- made from this reply
  value           NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (value >= 0),
  currency        TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  expected_close  DATE,
  owner           TEXT,
  lost_reason     TEXT,
  position        DOUBLE PRECISION NOT NULL DEFAULT 0,                      -- order within its column on the board
  source          TEXT,                                                     -- outbound, inbound, referral, manual
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS gtm_deals_stage ON gtm_deals (stage, position);

-- ---------- Apollo (src/gtm-apollo.ts) ----------
-- Search answers, by a hash of the query, for a day (no addresses: Apollo's people search returns none, and any that
-- appeared would be scrubbed). Credits and requests per day and endpoint, for the "credits used" line.
CREATE TABLE IF NOT EXISTS gtm_apollo_cache (
  key       TEXT PRIMARY KEY,
  kind      TEXT NOT NULL,
  response  JSONB NOT NULL,
  at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gtm_apollo_usage (
  day       DATE NOT NULL,
  endpoint  TEXT NOT NULL,
  requests  INT NOT NULL DEFAULT 0,
  credits   NUMERIC(12, 2) NOT NULL DEFAULT 0,
  limited   INT NOT NULL DEFAULT 0,                   -- 429s
  PRIMARY KEY (day, endpoint)
);

-- One-off GTM jobs that must run once per database (the first tick runs them): customer_links links prospects and
-- companies to the accounts and Clerk members that exist already (src/gtm-crm.ts backfillCustomerLinks).
CREATE TABLE IF NOT EXISTS gtm_jobs (
  name     TEXT PRIMARY KEY,
  done_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  result   JSONB NOT NULL DEFAULT '{}'
);

-- The consent ledger also records the lawful basis a prospect was first written to under (source prospect): consent
-- and contract besides legitimate interest. Only the ledger: email_consents keeps the marketing-consent bases.
ALTER TABLE email_consent_ledger DROP CONSTRAINT IF EXISTS email_consent_ledger_basis_check;
ALTER TABLE email_consent_ledger ADD CONSTRAINT email_consent_ledger_basis_check
  CHECK (basis IN ('opt_in', 'opt_in_pending', 'legitimate_interest', 'withdrawn', 'consent', 'contract'));

-- Apollo's API key is a key vault provider: server-only (no env_vars), never handed to an agent. Add it on Key vault.
INSERT INTO vault_providers (slug, mode, upstream_url, env_vars) VALUES ('apollo', 'direct', 'https://api.apollo.io', '{}')
ON CONFLICT (slug) DO NOTHING;

DO $mig$
DECLARE r TEXT := octillion_tenant_role();
BEGIN
  ALTER TABLE gtm_companies ENABLE ROW LEVEL SECURITY;
  ALTER TABLE gtm_prospects ENABLE ROW LEVEL SECURITY;
  ALTER TABLE gtm_prospect_activities ENABLE ROW LEVEL SECURITY;
  ALTER TABLE gtm_sender_identities ENABLE ROW LEVEL SECURITY;
  ALTER TABLE gtm_deal_stages ENABLE ROW LEVEL SECURITY;
  ALTER TABLE gtm_deals ENABLE ROW LEVEL SECURITY;
  ALTER TABLE gtm_apollo_cache ENABLE ROW LEVEL SECURITY;
  ALTER TABLE gtm_apollo_usage ENABLE ROW LEVEL SECURITY;
  ALTER TABLE gtm_jobs ENABLE ROW LEVEL SECURITY;
  EXECUTE format('REVOKE ALL ON gtm_companies, gtm_prospects, gtm_prospect_activities, gtm_sender_identities, gtm_deal_stages, gtm_deals, gtm_apollo_cache, gtm_apollo_usage, gtm_jobs FROM %I', r);
END $mig$;
