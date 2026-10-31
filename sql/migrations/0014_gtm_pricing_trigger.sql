-- GTM × pricing experiments (src/gtm-events.ts detectPricingNoCheckout, src/campaigns.ts): the detected event
-- "Saw pricing, didn't check out within N days" is a gtm_events row of type pricing_no_checkout. No new table and no
-- new column: plan_exposures and Stripe are its state, gtm_events its record, and the audience filter "Saw pricing
-- variant" reads plan_exposures. Only the type list allows the new value.
--
-- Rollout-safe: the previous release never writes the new type and ignores rows of it. A campaign saved with the new
-- trigger reads, on the previous release, as having no trigger it knows, so do not launch or resume such a campaign
-- while a rollback is in place (pause it first).
ALTER TABLE gtm_events DROP CONSTRAINT IF EXISTS gtm_events_type_check;
ALTER TABLE gtm_events ADD CONSTRAINT gtm_events_type_check CHECK (type IN ('account_created', 'request_submitted', 'request_approved', 'stage_reached', 'stuck',
  'report_opened', 'first_payment', 'attention', 'prospect_converted', 'pricing_no_checkout'));
