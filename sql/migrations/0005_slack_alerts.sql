-- Operator health alerts to Slack (src/health-alerts.ts): the incoming-webhook URL is a secret, so it is a key vault
-- provider like Resend's key: server-only (no env_vars), never handed to an agent session. Add the URL on Key vault.
INSERT INTO vault_providers (slug, mode, upstream_url, env_vars) VALUES ('slack', 'direct', 'https://hooks.slack.com', '{}')
ON CONFLICT (slug) DO NOTHING;
