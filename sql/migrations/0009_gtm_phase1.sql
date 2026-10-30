-- GTM phase 1 (src/campaigns.ts, src/gtm-events.ts, src/gtm-consent.ts): replies stop a sequence, event-triggered
-- campaigns, A/B variants, send windows in the recipient's time zone, marketing consent, and batch sending.
--
-- Where email addresses live (unchanged rule, one addition): gtm_campaign_recipients, and now gtm_replies (the reply's
-- From address and body, which are what the inbox shows). Every other GTM table keeps a hash (email_suppressions,
-- email_consents, email_consent_ledger), a domain (email_log) or no address at all (gtm_events, gtm_org_signals,
-- gtm_event_enrolments, gtm_campaign_sends).
--
-- Platform (staff) tables, like 0008's: the tenant role is granted nothing on them and src/rls.ts lists them as
-- NO_ACCESS. The ones that point at an account (org_id) have row-level security on with no tenant policy.

-- ---------- campaigns: trigger, send window, consent, replies ----------
-- trigger: null = scheduled / launched by hand (as before); else {type, stage?, days?, attention?, delay_hours,
--   reentry: once | every, reentry_days} (src/campaigns.ts parseTrigger).
-- send_window: {} = any time; else {days: [1..7] (ISO, 1 = Monday), start_hour, end_hour, time_zone (the default when a
--   recipient's own is unknown)}.
-- requires_opt_in: null = the default (on when the audience includes access requesters); true / false as set.
-- count_auto_replies: an out-of-office counts as a reply (and stops the sequence) only when this is on.
ALTER TABLE gtm_campaigns ADD COLUMN IF NOT EXISTS trigger JSONB;
ALTER TABLE gtm_campaigns ADD COLUMN IF NOT EXISTS send_window JSONB NOT NULL DEFAULT '{}';
ALTER TABLE gtm_campaigns ADD COLUMN IF NOT EXISTS requires_opt_in BOOLEAN;
-- Campaigns that existed before consent rules: off, so a rolling one keeps writing to whom it wrote to before (only new
-- campaigns get the default). The EU / EEA / UK / CH rule for requesters (src/gtm-consent.ts) applies to every campaign.
UPDATE gtm_campaigns SET requires_opt_in = false WHERE requires_opt_in IS NULL;
ALTER TABLE gtm_campaigns ADD COLUMN IF NOT EXISTS count_auto_replies BOOLEAN NOT NULL DEFAULT false;

-- ---------- recipients: replied, re-entry rounds, time zone and country ----------
ALTER TABLE gtm_campaign_recipients DROP CONSTRAINT IF EXISTS gtm_campaign_recipients_status_check;
ALTER TABLE gtm_campaign_recipients ADD CONSTRAINT gtm_campaign_recipients_status_check
  CHECK (status IN ('pending', 'active', 'done', 'suppressed', 'unsubscribed', 'bounced', 'failed', 'replied', 'no_consent'));
ALTER TABLE gtm_campaign_recipients ADD COLUMN IF NOT EXISTS round INT NOT NULL DEFAULT 0;        -- re-entries: 0 the first time
ALTER TABLE gtm_campaign_recipients ADD COLUMN IF NOT EXISTS entered_at TIMESTAMPTZ;              -- the latest (re-)entry
ALTER TABLE gtm_campaign_recipients ADD COLUMN IF NOT EXISTS event_id BIGINT;                     -- the event that enrolled it (triggered)
ALTER TABLE gtm_campaign_recipients ADD COLUMN IF NOT EXISTS time_zone TEXT;                      -- IANA; stored or inferred from country
ALTER TABLE gtm_campaign_recipients ADD COLUMN IF NOT EXISTS country TEXT;                        -- ISO 3166 alpha-2, from the request
ALTER TABLE gtm_campaign_recipients ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ;
ALTER TABLE gtm_campaign_recipients ADD COLUMN IF NOT EXISTS consent_basis TEXT;                  -- opt_in | legitimate_interest, at enrolment

-- ---------- sends: one per recipient, round and step; the variant it got ----------
ALTER TABLE gtm_campaign_sends ADD COLUMN IF NOT EXISTS round INT NOT NULL DEFAULT 0;
ALTER TABLE gtm_campaign_sends ADD COLUMN IF NOT EXISTS variant TEXT;                             -- 'A'..'D' (null: a step without variants)
ALTER TABLE gtm_campaign_sends ADD COLUMN IF NOT EXISTS batch_key TEXT;                           -- the Resend request it went in, set before it is made
-- uncertain: Resend may have accepted it (no answer, 5xx, 409, a function killed mid-request); it is only ever sent
-- again as the very same request (batch_key, batch_pos, payload: replayed byte for byte, so Resend's idempotency key
-- answers it). unknown: that was not possible (expired, replayed too often, the set changed): never resent unless an
-- owner says so (Resend on the campaign).
ALTER TABLE gtm_campaign_sends DROP CONSTRAINT IF EXISTS gtm_campaign_sends_status_check;
ALTER TABLE gtm_campaign_sends ADD CONSTRAINT gtm_campaign_sends_status_check CHECK (status IN ('sending', 'sent', 'failed', 'uncertain', 'unknown'));
ALTER TABLE gtm_campaign_sends ADD COLUMN IF NOT EXISTS batch_pos INT;                            -- its place in that request
ALTER TABLE gtm_campaign_sends ADD COLUMN IF NOT EXISTS payload JSONB;                             -- while uncertain: the email as sent, without the address
ALTER TABLE gtm_campaign_sends ADD COLUMN IF NOT EXISTS uncertain_at TIMESTAMPTZ;
ALTER TABLE gtm_campaign_sends ADD COLUMN IF NOT EXISTS replays INT NOT NULL DEFAULT 0;
ALTER TABLE gtm_campaign_sends DROP CONSTRAINT IF EXISTS gtm_campaign_sends_recipient_id_step_key;
CREATE UNIQUE INDEX IF NOT EXISTS gtm_campaign_sends_once ON gtm_campaign_sends (recipient_id, round, step);

-- ---------- replies (POST /api/webhooks/resend, email.received) ----------
-- One row per inbound email matched to a recipient by the signed token in its Reply-To address. Holds the sender's
-- address and the body (capped), so it is, with gtm_campaign_recipients, the only place an address is stored.
CREATE TABLE IF NOT EXISTS gtm_replies (
  id               BIGSERIAL PRIMARY KEY,
  campaign_id      BIGINT NOT NULL REFERENCES gtm_campaigns(id) ON DELETE CASCADE,
  recipient_id     BIGINT NOT NULL REFERENCES gtm_campaign_recipients(id) ON DELETE CASCADE,
  send_id          BIGINT REFERENCES gtm_campaign_sends(id) ON DELETE SET NULL,  -- the email it answers (the latest sent)
  provider_id      TEXT NOT NULL UNIQUE,                                         -- Resend's received-email id: a retry records nothing twice
  kind             TEXT NOT NULL CHECK (kind IN ('reply', 'auto_reply')),
  auto_reason      TEXT,                                                         -- why it looked automatic (a header, a subject pattern)
  from_email       TEXT,
  from_matches     BOOLEAN NOT NULL DEFAULT false,                               -- From is the recipient's own address
  subject          TEXT,
  snippet          TEXT,                                                         -- the first lines, quoted history cut
  body             TEXT,                                                         -- the text, at most 20,000 characters
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  handled_at       TIMESTAMPTZ,
  handled_by       TEXT
);
CREATE INDEX IF NOT EXISTS gtm_replies_campaign ON gtm_replies (campaign_id, received_at DESC);
CREATE INDEX IF NOT EXISTS gtm_replies_open ON gtm_replies (received_at DESC) WHERE handled_at IS NULL;

-- ---------- events that trigger campaigns ----------
-- Emitted where they happen (src/gtm-events.ts emit: account created, access request submitted / approved, report
-- opened) or by the tick's detector over the accounts' journeys (stage reached, stuck at a stage, attention reason,
-- first payment). dedupe_key names the fact, so emitting it twice records it once.
CREATE TABLE IF NOT EXISTS gtm_events (
  id          BIGSERIAL PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('account_created', 'request_submitted', 'request_approved', 'stage_reached', 'stuck', 'report_opened', 'first_payment', 'attention')),
  org_id      INT REFERENCES organizations(id) ON DELETE CASCADE,
  request_id  INT REFERENCES access_requests(id) ON DELETE CASCADE,
  data        JSONB NOT NULL DEFAULT '{}',                    -- {stage}, {stage, days}, {reason}: never an address
  dedupe_key  TEXT NOT NULL UNIQUE,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gtm_events_type_at ON gtm_events (type, at);

-- A triggered campaign's match of one event: due when the trigger's delay is up, then enrolled once (UNIQUE).
CREATE TABLE IF NOT EXISTS gtm_event_enrolments (
  campaign_id   BIGINT NOT NULL REFERENCES gtm_campaigns(id) ON DELETE CASCADE,
  event_id      BIGINT NOT NULL REFERENCES gtm_events(id) ON DELETE CASCADE,
  due_at        TIMESTAMPTZ NOT NULL,
  processed_at  TIMESTAMPTZ,
  enrolled      INT NOT NULL DEFAULT 0,
  note          TEXT,                                          -- why nobody was enrolled (no consent, re-entry rule, nobody to write to)
  PRIMARY KEY (campaign_id, event_id)
);
CREATE INDEX IF NOT EXISTS gtm_event_enrolments_due ON gtm_event_enrolments (due_at) WHERE processed_at IS NULL;

-- The detector's last look at each account: what changed since is an event.
CREATE TABLE IF NOT EXISTS gtm_org_signals (
  org_id     INT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  stage      TEXT NOT NULL,
  attention  TEXT[] NOT NULL DEFAULT '{}',                    -- normalised reasons (digits as #)
  paid       BOOLEAN NOT NULL DEFAULT false,
  seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- marketing consent (src/gtm-consent.ts) ----------
-- The basis in force for an address, keyed by its hash, and every change to it. opt_in_pending: the person ticked the
-- box and has not confirmed yet (double opt-in); opt_in: they clicked the confirmation link (source, wording version,
-- when); legitimate_interest: an existing customer; withdrawn: unsubscribed or complained.
CREATE TABLE IF NOT EXISTS email_consents (
  email_hash       TEXT PRIMARY KEY,
  basis            TEXT NOT NULL CHECK (basis IN ('opt_in', 'opt_in_pending', 'legitimate_interest', 'withdrawn')),
  source           TEXT NOT NULL,                              -- access_request_form, account, unsubscribe, admin
  wording_version  TEXT,
  country          TEXT,
  at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS email_consent_ledger (
  id               BIGSERIAL PRIMARY KEY,
  email_hash       TEXT NOT NULL,
  basis            TEXT NOT NULL CHECK (basis IN ('opt_in', 'opt_in_pending', 'legitimate_interest', 'withdrawn')),
  source           TEXT NOT NULL,
  wording_version  TEXT,
  country          TEXT,
  request_id       INT,
  campaign_id      BIGINT,
  at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_consent_ledger_hash ON email_consent_ledger (email_hash, at);

DO $mig$
DECLARE r TEXT := octillion_tenant_role();
BEGIN
  ALTER TABLE gtm_events ENABLE ROW LEVEL SECURITY;
  ALTER TABLE gtm_org_signals ENABLE ROW LEVEL SECURITY;
  ALTER TABLE gtm_replies ENABLE ROW LEVEL SECURITY;
  ALTER TABLE gtm_event_enrolments ENABLE ROW LEVEL SECURITY;
  ALTER TABLE email_consents ENABLE ROW LEVEL SECURITY;
  ALTER TABLE email_consent_ledger ENABLE ROW LEVEL SECURITY;
  EXECUTE format('REVOKE ALL ON gtm_replies, gtm_events, gtm_event_enrolments, gtm_org_signals, email_consents, email_consent_ledger FROM %I', r);
END $mig$;
