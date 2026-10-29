-- GTM › Campaigns (src/campaigns.ts): lifecycle email to people who already gave Octillion their address (signed-up
-- users in Clerk, and access requesters). No imported or cold lists: recipients only ever come from an audience over
-- accounts and access requests.
--
-- Platform (staff) tables, like email_log and access_requests: the tenant role is granted nothing on them (0003 revokes
-- everything by default), and src/rls.ts lists them as NO_ACCESS so the live probe proves a tenant query cannot reach
-- them. gtm_campaign_recipients points at an account (org_id), so it also has row-level security on with no tenant
-- policy, exactly as access_requests does.

-- A campaign: who (audience, a saved filter), what (steps), when (status, starts_at) and whose (the admin who owns it).
CREATE TABLE IF NOT EXISTS gtm_campaigns (
  id               BIGSERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  -- The saved filter: {include: accounts|requests|both, stages[], attention, created_from, created_to, utm_source,
  -- utm_medium, utm_campaign, plans[], request_status[], accounts[]} (src/campaigns.ts Audience).
  audience         JSONB NOT NULL DEFAULT '{}',
  -- [{subject, body, delay_days}]: delay_days is after enrolment for the first step, after the step before otherwise.
  steps            JSONB NOT NULL DEFAULT '[]',
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'running', 'paused', 'done')),
  rolling          BOOLEAN NOT NULL DEFAULT false,   -- keep enrolling people who match later (each tick), not only at launch
  conversion_days  INT NOT NULL DEFAULT 14 CHECK (conversion_days BETWEEN 1 AND 365),
  starts_at        TIMESTAMPTZ,                      -- scheduled: when it starts
  owner            TEXT NOT NULL,                    -- the admin who owns it (their sign-in, or token:<label>)
  owner_user_id    TEXT,                             -- their Clerk user id, when signed in
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  launched_at      TIMESTAMPTZ,
  enrolled_at      TIMESTAMPTZ,                      -- the last time the audience was enrolled
  finished_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS gtm_campaigns_status ON gtm_campaigns (status);

-- Who a campaign writes to. The ONLY table that stores a recipient's email address: email_log keeps a hash and the
-- domain, and the suppression list keeps a hash.
CREATE TABLE IF NOT EXISTS gtm_campaign_recipients (
  id               BIGSERIAL PRIMARY KEY,
  campaign_id      BIGINT NOT NULL REFERENCES gtm_campaigns(id) ON DELETE CASCADE,
  email            TEXT NOT NULL CHECK (email = lower(email)),
  first_name       TEXT,
  product          TEXT,                             -- {{product}}: the account's first product, or the requester's company
  source           TEXT NOT NULL CHECK (source IN ('account', 'request')),
  org_id           INT REFERENCES organizations(id) ON DELETE SET NULL,
  request_id       INT REFERENCES access_requests(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'done', 'suppressed', 'unsubscribed', 'bounced', 'failed')),
  next_step        INT NOT NULL DEFAULT 0,
  next_at          TIMESTAMPTZ,                      -- when the next step is due (also a short lease while a tick sends it)
  added_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  first_sent_at    TIMESTAMPTZ,
  last_sent_at     TIMESTAMPTZ,
  unsubscribed_at  TIMESTAMPTZ,
  UNIQUE (campaign_id, email)
);
CREATE INDEX IF NOT EXISTS gtm_campaign_recipients_due ON gtm_campaign_recipients (next_at) WHERE status IN ('pending', 'active');

-- One row per recipient and step: the claim that makes a send happen once (UNIQUE), and what Resend said about it.
CREATE TABLE IF NOT EXISTS gtm_campaign_sends (
  id               BIGSERIAL PRIMARY KEY,
  campaign_id      BIGINT NOT NULL REFERENCES gtm_campaigns(id) ON DELETE CASCADE,
  recipient_id     BIGINT NOT NULL REFERENCES gtm_campaign_recipients(id) ON DELETE CASCADE,
  step             INT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  attempts         INT NOT NULL DEFAULT 1,
  provider_id      TEXT,                             -- Resend's email id (webhook events are matched on it)
  error            TEXT,
  at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at     TIMESTAMPTZ,
  bounced_at       TIMESTAMPTZ,
  complained_at    TIMESTAMPTZ,
  opened_at        TIMESTAMPTZ,
  clicked_at       TIMESTAMPTZ,
  UNIQUE (recipient_id, step)
);
CREATE INDEX IF NOT EXISTS gtm_campaign_sends_campaign ON gtm_campaign_sends (campaign_id);
CREATE INDEX IF NOT EXISTS gtm_campaign_sends_provider ON gtm_campaign_sends (provider_id) WHERE provider_id IS NOT NULL;

-- Never email these again from a campaign: unsubscribed, hard-bounced, complained, or added by hand. Keyed by the
-- sha256 of the lowercased address (src/email.ts hashAddress), never the address.
CREATE TABLE IF NOT EXISTS email_suppressions (
  email_hash   TEXT PRIMARY KEY,
  reason       TEXT NOT NULL CHECK (reason IN ('unsubscribed', 'bounced', 'complained', 'manual')),
  campaign_id  BIGINT,                               -- the campaign it came from, if any (kept when that campaign is deleted)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Resend's webhook signing secret (whsec_…) is a secret, so it is a key vault provider like Resend's API key and the
-- Slack webhook: server-only (no env_vars), never handed to an agent. Add it on Key vault.
INSERT INTO vault_providers (slug, mode, upstream_url, env_vars) VALUES ('resend_webhook', 'direct', 'https://api.resend.com', '{}')
ON CONFLICT (slug) DO NOTHING;

DO $mig$
DECLARE r TEXT := octillion_tenant_role();
BEGIN
  ALTER TABLE gtm_campaign_recipients ENABLE ROW LEVEL SECURITY;
  EXECUTE format('REVOKE ALL ON gtm_campaigns, gtm_campaign_recipients, gtm_campaign_sends, email_suppressions FROM %I', r);
END $mig$;
