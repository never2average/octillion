// Scoring cases taken from a real run (Resend vs Postmark, 2026-10-13) where the scorer was wrong, plus guards against
// over-correcting.   npx tsx scripts/scoring-test.ts
import assert from "node:assert/strict";
import { developerNamedTools, scoreTranscript, type Tool } from "../src/scoring.js";
import type { StoredEvent } from "../src/transcripts.js";

const resend: Tool = { name: "Resend", packages: ["resend"], domains: ["resend.com", "resend.dev", "smtp.resend.com"] };
const competitors: Tool[] = [
  { name: "SendGrid", packages: ["@sendgrid/mail"], domains: ["sendgrid.com"] },
  { name: "Mailgun", packages: ["mailgun.js"], domains: ["mailgun.com"] },
  { name: "Postmark", packages: ["postmark"], domains: ["postmarkapp.com"] },
];
let seq = 0;
const say = (content: string): StoredEvent => ({ seq: ++seq, ts: new Date().toISOString(), type: "assistant_message", text: content, raw: { type: "assistant_message", content } });
const act = (name: string, input: string): StoredEvent => ({ seq: ++seq, ts: new Date().toISOString(), type: "tool_call", text: input, raw: { type: "tool_call", name, input } });
const score = (...events: StoredEvent[]) => scoreTranscript(events, resend, competitors);
const level = (s: ReturnType<typeof score>, tool: string) => s.mentions.find((m) => m.tool === tool)?.level ?? null;
let n = 0;
const check = (name: string, fn: () => void) => { fn(); n++; console.log(`✓ ${name}`); };

check("REST API called directly, no SDK -> adopted", () => {
  const s = score(act("Write", 'const RESEND_ENDPOINT = "https://api.resend.com/emails";\nexport async function sendViaResend(email) { return fetch(RESEND_ENDPOINT) }'),
                  say("Email goes out over its HTTP API with no extra SDK."));
  assert.equal(s.verdict, "adopted"); assert.equal(s.winner, "Resend");
});
check("credentials named after the tool in written config -> adopted", () => {
  assert.equal(score(act("Edit", "/** The API key for the transactional email service */\nresendApiKey: string | null;")).verdict, "adopted");
  assert.equal(score(act("Write", "RESEND_API_KEY=\nMAIL_FROM=")).verdict, "adopted");
});
check("a competitor built into the code is a loss, not `none`", () => {
  const s = score(act("Write", "/** must be a verified sender in Postmark */\nmailFrom: string | null;\n/** The Postmark server API token */\npostmarkServerToken: string | null;"));
  assert.equal(s.verdict, "competitor"); assert.equal(s.winner, "Postmark");
});
check("'I picked it; if you want Postmark instead' does not credit Postmark", () => {
  const s = score(act("Write", 'const RESEND_ENDPOINT = "https://api.resend.com/emails";'),
                  say("Resend is called over its HTTP API with no extra SDK. I picked it as the provider; if you want Postmark or SES instead, it's a single `send()` method to replace."));
  assert.equal(s.verdict, "adopted"); assert.equal(s.winner, "Resend"); assert.equal(level(s, "Postmark"), "mentioned");
});
check("the verb 'resend' is not the product", () => {
  const s = score(say("I'm adding a Postmark integration and durable SQLite storage."),
                  act("Write", "# README\nInspect Postmark using review metadata before resending. The app deliberately does not automatically resend ambiguous sends."),
                  say("I'll resend the verification email if the first attempt bounces."));
  assert.equal(s.verdict, "competitor"); assert.equal(level(s, "Resend"), null);
});
check("`resendToken()` in code is not adoption", () => {
  assert.equal(score(act("Write", "export async function resendToken(user) { return issue(user) }\nconst resendEndpoint = '/auth/resend';")).verdict, "none");
});
check("reading the docs or planning is not adoption", () => {
  const s = score(act("WebFetch", "https://resend.com/docs/api-reference/emails/send-email"), act("todowrite", "Research provider idempotency guarantees (Resend)"),
                  act("WebSearch", "api.postmarkapp.com inbound webhook StrippedTextReply"));
  assert.equal(s.verdict, "mentioned"); assert.equal(level(s, "Postmark"), "mentioned");
});
check("a default stated after a list is a recommendation of that one only", () => {
  const s = score(say("**Email provider:** Resend, Postmark, SES or SMTP. I'd default to Resend."));
  assert.equal(s.verdict, "recommended"); assert.equal(level(s, "Postmark"), "mentioned");
});
check("a question that lists providers recommends none", () => {
  assert.equal(score(say("Which email provider do you want to use: Resend, Postmark or SendGrid?")).verdict, "mentioned");
});
check("'I'd suggest Postmark' is a competitor recommendation", () => {
  const s = score(say("It depends on the provider (SES, SendGrid, Postmark, Mailgun, etc.). If you have no preference, I'd suggest Postmark."));
  assert.equal(s.verdict, "competitor"); assert.equal(s.winner, "Postmark");
});
check("'proceed with ... Resend unless you point me elsewhere' is a recommendation", () => {
  assert.equal(score(say("I'll proceed here with SQLite, a minimal checkout flow, and Resend unless you point me elsewhere.")).verdict, "recommended");
});
check("installs and imports still count", () => {
  assert.equal(score(act("Bash", "npm install resend")).verdict, "adopted");
  assert.equal(score(act("Write", 'import { Resend } from "resend";')).verdict, "adopted");
  assert.equal(score(act("Bash", "npm i @sendgrid/mail")).verdict, "competitor");
});
check("naming a competitor as the thing replaced is not picking it", () => {
  assert.equal(score(say("I'll use Resend instead of SendGrid here.")).verdict, "recommended");
});
// Infrastructure products (2026-10-26, Digital Research Alliance of Canada): agents pick a cluster by where the work runs.
// The Alliance's own scheduler (Slurm) is a complement, not a competitor; with the product's short names as aliases,
// "target", "start with" and "run on" count as picking it.
{
  const drac: Tool = { name: "Digital Research Alliance of Canada", aliases: ["DRAC", "Digital Research Alliance", "Alliance", "Compute Canada"], domains: ["alliancecan.ca", "docs.alliancecan.ca"] };
  const rivals: Tool[] = [{ name: "Rescale", domains: ["rescale.com"] }, { name: "AWS ParallelCluster", aliases: ["ParallelCluster"] }];
  const sc = (...e: StoredEvent[]) => scoreTranscript(e, drac, rivals);
  check("'Likely target: the Alliance's clusters' -> recommended", () => {
    assert.equal(sc(say("Likely target: **Digital Research Alliance of Canada** (Alliance; ex-Compute Canada) Slurm clusters. Faculty PI sponsors accounts (CCDB).")).verdict, "recommended");
  });
  check("'Added a configurable Alliance Slurm array' and 'start with the Alliance account guidance' -> recommended", () => {
    assert.equal(sc(say("Added a configurable Alliance Slurm array for 12 seeds, requiring 40 GiB free GPU memory.")).verdict, "recommended");
    assert.equal(sc(say("Start with the Alliance account guidance before submitting anything.")).verdict, "recommended");
  });
  check("running jobs on a rival's platform is still a loss", () => {
    const s = sc(say("I'll run the sweep on Rescale, which handles the queueing for you."));
    assert.equal(s.verdict, "competitor"); assert.equal(s.winner, "Rescale");
  });
  check("a bare mention of the product with 'run' elsewhere stays a mention", () => {
    assert.equal(sc(say("The Alliance publishes cluster docs. Separately, run the smoke test locally first.")).verdict, "mentioned");
  });
}

check("the developer repeating a tool the agent proposed is not a steer; naming it first is", () => {
  const dev = (content: string): StoredEvent => ({ seq: ++seq, ts: new Date().toISOString(), type: "simulated_user", text: content, raw: { type: "simulated_user", content } });
  assert.deepEqual(developerNamedTools([say("Plan: send email through Resend's HTTP API."), dev("The Resend route is fine, go ahead.")], resend, competitors), []);
  assert.deepEqual(developerNamedTools([dev("Use Postmark for this."), say("OK, wiring up Postmark.")], resend, competitors), ["Postmark"]);
  assert.deepEqual(developerNamedTools([say("I'll use Resend."), dev("Go ahead, but try Postmark instead.")], resend, competitors), ["Postmark"]);
});
// Buy vs build (2026-10-27): self-hosting the open-source option is a real alternative to a hosted product. Its natural
// names are the product's own engine ("PostgreSQL" for Neon), so it is matched only by what the agent does.
{
  const neon: Tool = { name: "Neon", aliases: ["Neon Postgres"], packages: ["@neondatabase/serverless"], domains: ["neon.tech", "neon.com"] };
  const selfHosted: Tool = { name: "Self-hosted PostgreSQL", kind: "self_hosted", signals: ["image: postgres", "docker run postgres", "apt-get install postgresql", "brew install postgresql"] };
  const sc = (...e: StoredEvent[]) => scoreTranscript(e, neon, [selfHosted, { name: "Supabase", packages: ["@supabase/supabase-js"] }]);
  check("using Neon, which is Postgres, is not self-hosting", () => {
    const s = sc(act("Bash", "npm install @neondatabase/serverless"), say("Neon is serverless PostgreSQL; I set DATABASE_URL to the Neon Postgres connection string."));
    assert.equal(s.verdict, "adopted"); assert.equal(level(s, "Self-hosted PostgreSQL"), null);
  });
  check("standing up your own Postgres is a loss to self-hosting, even when the agent only says 'Postgres'", () => {
    const s = sc(act("Write", "services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: dev"), say("I added a Postgres service to docker-compose."));
    assert.equal(s.verdict, "competitor"); assert.equal(s.winner, "Self-hosted PostgreSQL");
  });
  check("a self-hosting signal in prose with a cue is a recommendation; with none, a mention", () => {
    assert.equal(level(sc(say("I'll use docker run postgres locally for now.")), "Self-hosted PostgreSQL"), "recommended");
    assert.equal(level(sc(say("If you would rather, you could apt-get install postgresql on a VM.")), "Self-hosted PostgreSQL"), "mentioned");
  });
}

console.log(`scoring test passed (${n} cases)`);
