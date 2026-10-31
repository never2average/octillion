// The GTM checks on their own (scripts/smoke-gtm.ts), for a quick loop while working on GTM: a fresh embedded
// database, the server, and the Clerk / Stripe / Resend mock, without the rest of scripts/smoke.ts (which runs the
// same checks as part of the whole). No real email is ever sent.
//   PGLITE_DIR=$(mktemp -d) npx tsx scripts/smoke-gtm-run.ts
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

process.env.OCTILLION_VAULT_KEY ??= randomBytes(32).toString("base64");
process.env.OCTILLION_WORKER_TOKEN ??= "smoke-worker-token";
process.env.REASONS_ENABLED ??= "off";
process.env.OCTILLION_ORG_MONTHLY_BUDGET_USD ??= "1000";
const { startMockProviders } = await import("./lib/mock-providers.js");
const mock = await startMockProviders();
const { pem } = await (await fetch(`${mock.url}/_mock/public-key`)).json();
Object.assign(process.env, { CLERK_SECRET_KEY: "sk_test_mock", CLERK_API_URL: mock.url, CLERK_FRONTEND_API_URL: mock.url, CLERK_JWT_KEY: pem,
  STRIPE_SECRET_KEY: "sk_test_mock", STRIPE_API_URL: mock.url, STRIPE_SPEND_METER: "octillion_model_spend", RESEND_API_URL: mock.url });
const { getDb } = await import("../src/db.js");
const { createApp } = await import("../src/http.js");
const db = await getDb();
const server = await new Promise<import("node:http").Server>((resolve) => { const s = createApp().listen(0, "127.0.0.1", () => resolve(s)); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const stamp = Date.now().toString(36);
const { createAdminToken } = await import("../src/admin-tokens.js");
const token = (await createAdminToken({ label: "smoke", role: "owner", days: 1, createdBy: "smoke" })).token;
const adm = (method: string, path: string, body?: unknown) => fetch(`${base}/api/admin/onboarding${path}`, {
  method, headers: { authorization: `Bearer ${token}`, "x-admin-actor": "smoke", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const json = async (r: Response | Promise<Response>) => { const x = await r; const j = await x.json(); assert.ok(x.ok, `${x.status} ${JSON.stringify(j)}`); return j; };
await (await import("../src/keyvault.js")).addCredential("resend", `re_smoke_${stamp}_secret`);
await (await import("../src/settings.js")).setSettings("smoke", { EMAIL_ADMIN_TO: `ops+${stamp}@octillion.test` });
const sentTo = (to: string, kind?: string) => mock.state.emails.filter((e: any) => e.to.includes(to.toLowerCase()) && (!kind || e.tags?.[0]?.value === kind));
const mockPost = async (path: string, body: unknown = {}) => (await fetch(`${mock.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
await (await import("./smoke-gtm.js")).gtmChecks({ db, base, adm, json, mockUrl: mock.url, mockPost, sentTo, stamp });
console.log("✓ GTM checks on their own");
server.close();
await mock.close?.();
process.exit(0);
