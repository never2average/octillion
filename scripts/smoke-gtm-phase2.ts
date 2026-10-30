// GTM phase 2 checks (scripts/smoke-gtm.ts runs them after phase 1's): the light CRM (companies, prospects, dedupe,
// CSV import with a dry run and a required lawful basis, suppression by hash), Apollo search and enrichment against the
// mock (no key: disabled; cache; freshness; credits; a 429), outbound sequences (sender identities off the product's
// domain, the warm-up cap across campaigns, the cold-email rules, text only, replies, bounces, quick actions), auto-
// linking a prospect who signs up, deals, outbound attribution (first touch) and where addresses live. Against the
// Resend and Apollo mocks only: no real email, no real Apollo call.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";

type Db = { query: <T = any>(sql: string, params?: unknown[]) => Promise<T[]> };

export async function gtmPhase2Checks({ db, base, adm, json, mockUrl, mockPost, sentTo, stamp }: {
  db: Db; base: string; adm: (method: string, path: string, body?: unknown) => Promise<Response>; json: (r: Response | Promise<Response>) => Promise<any>;
  mockUrl: string; mockPost: (path: string, body?: unknown) => Promise<any>; sentTo: (to: string, kind?: string) => any[]; stamp: string;
}) {
  const mail = await import("../src/email.js"), kvm = await import("../src/keyvault.js"), settings = await import("../src/settings.js");
  const outbound = await import("../src/gtm-outbound.js"), crm = await import("../src/gtm-crm.js");
  const { createAdminToken } = await import("../src/admin-tokens.js");
  const tick = () => json(adm("POST", "/gtm/tick"));
  const waitFor = async (ok: () => boolean | Promise<boolean>, what: string) => { for (let i = 0; i < 400 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 25)); assert.ok(await ok(), what); };
  const status = async (r: Response | Promise<Response>) => { const x = await r; await x.text(); return x.status; };
  const errOf = async (r: Response | Promise<Response>) => { const x = await r; return { status: x.status, error: ((await x.json().catch(() => ({}))) as any).error as string }; };
  const prospectBy = async (email: string) => (await db.query<any>("SELECT * FROM gtm_prospects WHERE email = $1", [email]))[0];
  const D = `p2${stamp}`;
  const created = { campaigns: [] as number[], orgs: [] as number[], requests: [] as number[] };
  process.env.CAMPAIGN_SEND_INTERVAL_MS = "0";

  // ---------- reads for any admin; writes need the campaigns permission (a DB role, never an allow-list) ----------
  const viewer = (await createAdminToken({ label: `p2-viewer-${stamp}`, role: "viewer", days: 1, createdBy: "smoke" })).token;
  const asViewer = (method: string, path: string, body?: unknown) => fetch(`${base}/api/admin/onboarding${path}`, {
    method, headers: { authorization: `Bearer ${viewer}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  assert.equal(await status(asViewer("GET", "/gtm/prospects")), 200, "a viewer reads prospects");
  for (const [m, p] of [["POST", "/gtm/prospects/import"], ["POST", "/gtm/companies"], ["POST", "/gtm/deals"], ["POST", "/gtm/identities"], ["POST", "/gtm/apollo/search"], ["PUT", "/gtm/deal-stages"]])
    assert.equal(await status(asViewer(m, p, {})), 403, `${m} ${p} needs the campaigns permission`);

  // ---------- companies: one per domain ----------
  const acme = `acme-${D}.dev`;
  const co = await json(adm("POST", "/gtm/companies", { domain: `https://www.ACME-${D}.dev/about`, name: "Acme", industry: "Developer tools", size: "51-200" }));
  assert.ok(co.company.domain === acme && co.company.name === "Acme", "the domain is normalised (no scheme, www or path)");
  assert.equal(await status(adm("POST", "/gtm/companies", { domain: acme })), 409, "a domain is one company");
  assert.equal(await status(adm("POST", "/gtm/companies", { domain: "not a domain" })), 400, "a domain is required");

  // ---------- CSV import: dry run, lawful basis, suppression by hash, EU rule, dedupe ----------
  const P = (k: string, dom = `p2-${D}.dev`) => `${k}+${stamp}@${dom}`;
  const [pa, pb, pc, pd, pe, pf, pg, ph] = ["pa", "pb", "pc", "pd", "pe", "pf", "pg", "ph"].map((k) => P(k));
  const gmailP = `gm.${stamp}@gmail.com`;
  await db.query("INSERT INTO email_suppressions (email_hash, reason) VALUES ($1, 'unsubscribed') ON CONFLICT DO NOTHING", [mail.hashAddress(pc)]);
  const existing = await json(adm("POST", "/gtm/prospects", { email: ph, first_name: "Hana", lawful_basis: "legitimate_interest", country: "US", title: "CTO" }));
  assert.ok(existing.prospect.id && existing.timeline.some((t: any) => t.type === "imported"), "a prospect added by hand, with its timeline");
  assert.equal(await status(adm("POST", "/gtm/prospects", { email: P("nobasis"), first_name: "No" })), 400, "a prospect needs a lawful basis");
  const rows = [
    { email: pa, first_name: "Ann", last_name: "Lee", title: "VP Engineering", company: "P2 Co", country: "US", lawful_basis: "Legitimate interest (B2B)", tags: "cold, devtools" },
    { email: pb, name: "Bo Diaz", title: "CTO", country: "US" },                                   // no basis of its own: refused without one for the import
    { email: pc, first_name: "Cy", country: "US", lawful_basis: "legitimate_interest" },           // on the suppression list
    { email: pd, first_name: "Di", country: "DE" },                                                // EU, no explicit basis
    { email: pa.toUpperCase(), first_name: "Ann again", lawful_basis: "legitimate_interest" },     // the same address again
    { email: "not-an-address", first_name: "Bad", lawful_basis: "legitimate_interest" },
    { email: pg, first_name: "Gus", country: "DE", lawful_basis: "consent" },                      // EU with its own basis
    { email: ph, title: "Chief Technology Officer", linkedin_url: "https://www.linkedin.com/in/hana", lawful_basis: "legitimate_interest" }, // exists
    { email: gmailP, first_name: "Gem", country: "US", lawful_basis: "legitimate_interest" },      // a free-mail address: no company
  ];
  const dry = await json(adm("POST", "/gtm/prospects/import", { rows, dry_run: true }));
  const act = (i: number) => dry.rows[i];
  assert.deepEqual(dry.rows.map((r: any) => r.action), ["create", "refuse", "refuse", "refuse", "skip", "refuse", "create", "update", "create"], `dry run actions: ${JSON.stringify(dry.rows.map((r: any) => [r.action, r.reason]))}`);
  assert.ok(/lawful basis/i.test(act(1).reason) && act(2).suppressed && /suppression/i.test(act(2).reason) && /Duplicate/.test(act(4).reason), "each refusal says why");
  const dryEu = await json(adm("POST", "/gtm/prospects/import", { rows, dry_run: true, lawful_basis: "legitimate_interest" }));
  assert.ok(dryEu.rows[1].action === "create" && dryEu.rows[3].action === "refuse" && /EU/.test(dryEu.rows[3].reason) && dryEu.rows[6].action === "create",
    "the import's basis covers the rest, but someone in the EU needs their own (or the import's, ticked to cover them)");
  assert.ok(dry.summary.create === 3 && dry.summary.refuse === 4 && dry.summary.suppressed === 1 && dry.summary.companies_new === 0, `summary: ${JSON.stringify(dry.summary)}`);
  assert.equal(await prospectBy(pa), undefined, "a dry run writes nothing");
  // With a basis for the import (and ticked to cover the EU), the rest go in; the suppressed address never does.
  const run = await json(adm("POST", "/gtm/prospects/import", { rows, dry_run: false, lawful_basis: "legitimate_interest", basis_note: "B2B: engineering leaders at dev-tools companies", explicit_restricted: true, tags: "batch1" }));
  assert.ok(run.summary.create === 5 && run.summary.update === 1 && run.summary.refuse === 2, `import: ${JSON.stringify(run.summary)}`);
  const A = await prospectBy(pa), H = await prospectBy(ph), G = await prospectBy(gmailP);
  assert.ok(A && A.lawful_basis === "legitimate_interest" && A.tags.includes("cold") && A.tags.includes("batch1") && A.first_name === "Ann", "imported with its basis and tags");
  assert.ok(H.title === "CTO" && H.linkedin_url === "https://www.linkedin.com/in/hana", "an existing prospect is filled in, never overwritten (title kept), the LinkedIn URL stored as text");
  assert.ok(!(await prospectBy(pc)), "the suppressed address is never a prospect");
  assert.ok(G && G.company_id == null, "a free-mail address makes no company");
  const [p2co] = await db.query<any>("SELECT * FROM gtm_companies WHERE domain = $1", [`p2-${D}.dev`]);
  assert.ok(p2co && p2co.name === "P2 Co" && A.company_id === p2co.id, "a company per domain, from the address");
  const again = await json(adm("POST", "/gtm/prospects/import", { rows: [rows[0]], dry_run: false }));
  assert.ok(again.summary.update === 1 && again.summary.create === 0, "importing the same person again updates, never duplicates");
  const list = await json(adm("GET", "/gtm/prospects"));
  assert.ok(list.prospects.some((p: any) => p.email === pg && p.restricted) && list.prospects.some((p: any) => p.email === pa && !p.restricted && !p.suppressed), "the list flags EU / unknown-country people");
  // Companies import: deduped by domain, dry run first.
  const cdry = await json(adm("POST", "/gtm/companies/import", { rows: [{ domain: `beta-${D}.dev`, name: "Beta" }, { website: `https://beta-${D}.dev`, name: "Beta again" }, { name: "No domain" }, { domain: acme }], dry_run: true }));
  assert.deepEqual(cdry.rows.map((r: any) => r.action), ["create", "skip", "refuse", "update"], "companies import: create, duplicate, refused, update");
  await json(adm("POST", "/gtm/companies/import", { rows: [{ domain: `beta-${D}.dev`, name: "Beta", industry: "Fintech" }], dry_run: false }));

  // ---------- Apollo: disabled without a key; search (no credits, cached), import, enrich (credits, fresh), 429 ----------
  const st0 = await json(adm("GET", "/gtm/apollo"));
  assert.ok(!st0.connected && /Key vault/.test(st0.message), "no key: Apollo is off, and the page says what to set up");
  const off = await errOf(adm("POST", "/gtm/apollo/search", { titles: ["CTO"] }));
  assert.ok(off.status === 409 && /Apollo is not connected/.test(off.error), "searching without a key explains itself");
  process.env.APOLLO_API_URL = mockUrl; process.env.APOLLO_MIN_GAP_MS = "0";
  const apolloCred = await kvm.setCredential("apollo", `apollo_smoke_${stamp}_secret`);
  const zed = `zed+${stamp}@zeta-${D}.dev`, yan = `yan+${stamp}@zeta-${D}.dev`, xia = `xia+${stamp}@zeta-${D}.dev`;
  await mockPost("/_mock/apollo/people", { people: [
    { id: `ap_z_${stamp}`, first_name: "Zed", last_name: "Zimmer", title: "CTO", seniority: "c_suite", email: zed, email_status: "verified", country_name: "United States", company: "Zeta", domain: `zeta-${D}.dev`, industry: "Computer Software", employees: 120 },
    { id: `ap_y_${stamp}`, first_name: "Yan", last_name: "Young", title: "VP Engineering", seniority: "vp", email: yan, email_status: "verified", country_name: "Germany", company: "Zeta", domain: `zeta-${D}.dev`, industry: "Computer Software", employees: 120 },
    { id: `ap_x_${stamp}`, first_name: "Xia", last_name: "Xu", title: "Engineering Manager", seniority: "manager", email: xia, email_status: "unverified", country_name: "United States", company: "Zeta", domain: `zeta-${D}.dev`, industry: "Computer Software", employees: 120 },
  ] });
  const reqsBefore = (await (await fetch(`${mockUrl}/_mock/apollo/requests`)).json()).requests.length;
  assert.equal(await status(adm("POST", "/gtm/apollo/search", {})), 400, "a search needs a filter");
  const q = { domains: [`zeta-${D}.dev`], titles: ["CTO", "VP", "Manager"] };
  const found = await json(adm("POST", "/gtm/apollo/search", q));
  assert.ok(found.total === 3 && !found.cached && found.people.every((p: any) => !("email" in p) && p.apollo_id) && !JSON.stringify(found).includes(zed), "people search: no addresses");
  const reqLog = async () => (await (await fetch(`${mockUrl}/_mock/apollo/requests`)).json()).requests;
  const sr = (await reqLog()).at(-1);
  assert.ok(sr.path === "/api/v1/mixed_people/api_search" && sr.query["person_titles[]"]?.includes("CTO") && sr.query["q_organization_domains_list[]"] === `zeta-${D}.dev`, `the documented parameters: ${JSON.stringify(sr.query)}`);
  assert.ok((await json(adm("POST", "/gtm/apollo/search", q))).cached && (await reqLog()).length === reqsBefore + 1, "the same search again is answered from the cache");
  const imp = await json(adm("POST", "/gtm/apollo/import", { query: q, apollo_ids: [`ap_z_${stamp}`, `ap_y_${stamp}`, `ap_x_${stamp}`], lawful_basis: "legitimate_interest", explicit_restricted: true, tags: "apollo" }));
  assert.equal(imp.summary.create, 3, "found people imported as prospects");
  const zRow = (await db.query<any>("SELECT * FROM gtm_prospects WHERE apollo_id = $1", [`ap_z_${stamp}`]))[0];
  assert.ok(zRow && zRow.email == null && zRow.source === "apollo" && zRow.lawful_basis === "legitimate_interest", "imported without an address (search has none)");
  const ids = (await db.query<{ id: number }>("SELECT id FROM gtm_prospects WHERE apollo_id = ANY($1::text[])", [[`ap_z_${stamp}`, `ap_y_${stamp}`, `ap_x_${stamp}`]])).map((r) => Number(r.id));
  const en = await json(adm("POST", "/gtm/apollo/enrich/prospects", { ids }));
  assert.ok(en.enriched === 3 && en.matched === 3 && en.credits === 3, `enriched, credits counted: ${JSON.stringify(en)}`);
  const Z = await prospectBy(zed), Y = await prospectBy(yan), X = await prospectBy(xia);
  assert.ok(Z.email_status === "verified" && Z.last_name === "Zimmer" && Z.enrichment_source === "apollo" && Z.enriched_at && Z.country === "US", "enrichment fills the address, its status, the name and the country");
  assert.ok(Y.country === "DE" && X.email_status === "unverified", "country names become codes; unverified stays unverified");
  assert.ok(!JSON.stringify(Z.enrichment).includes(zed), "the stored Apollo record has no address");
  const [zeta] = await db.query<any>("SELECT * FROM gtm_companies WHERE domain = $1", [`zeta-${D}.dev`]);
  assert.ok(zeta && zeta.name === "Zeta" && zeta.employees === 120 && zeta.size === "51-200", "the company from the enrichment");
  assert.equal((await json(adm("POST", "/gtm/apollo/enrich/prospects", { ids }))).skipped_fresh, 3, "never re-enriched within N days");
  assert.equal((await json(adm("POST", "/gtm/apollo/enrich/prospects", { ids: [ids[0]], force: true }))).enriched, 1, "unless forced");
  const ce = await json(adm("POST", "/gtm/apollo/enrich/companies", { ids: [Number(zeta.id)], force: true }));
  assert.ok(ce.found === 1 && ce.credits === 1, "companies enriched by domain, a credit each");
  const st1 = await json(adm("GET", "/gtm/apollo"));
  assert.ok(st1.connected && st1.credits_today >= 5 && st1.rate_limits["minute-requests-left"] === 199, `credits used and rate limits shown: ${JSON.stringify(st1)}`);
  await mockPost("/_mock/apollo/ratelimit", { count: 1, retry_after: 1 });
  assert.ok((await json(adm("POST", "/gtm/apollo/search", { ...q, force: true }))).total === 3, "a 429 with a short retry-after is waited out once");
  await mockPost("/_mock/apollo/ratelimit", { count: 2, retry_after: 30 });
  const lim = await errOf(adm("POST", "/gtm/apollo/search", { ...q, force: true }));
  assert.ok(lim.status === 429 && /rate limit/i.test(lim.error), "a long one stops and says when to try again");
  await mockPost("/_mock/apollo/ratelimit", { count: 0 });
  assert.ok((await reqLog()).every((r: any) => r.path.startsWith("/api/v1/")) && process.env.APOLLO_API_URL === mockUrl, "every Apollo call went to the mock");

  // ---------- sender identities: never the product's domain; warm-up ----------
  const product = await outbound.productDomain();
  const bad = await errOf(adm("POST", "/gtm/identities", { from_name: "Sales", from_address: `sales@${product}`, daily_cap: 50 }));
  assert.ok(bad.status === 400 && /product's sender domain/.test(bad.error), "an identity on the product's sender domain is refused");
  // B3: a proper subdomain of its own organisational root (public-suffix aware), never EMAIL_FROM's domain or a parent of
  // it, ASCII only; nothing passes when the product's domain cannot be read.
  const dp = outbound.domainProblem;
  assert.ok(dp("outreach.example.co.uk", "example.co.uk") === null && /not a subdomain/.test(dp("example.co.uk", "mail.other.com")!) && /not a subdomain/.test(dp(`ob-${D}.dev`, product)!),
    "outreach.example.co.uk is a subdomain; example.co.uk (a co.uk root) is not");
  assert.ok(/parent/.test(dp("b.example.com", "a.b.example.com")!) && /product's sender domain/.test(dp("a.b.example.com", "a.b.example.com")!) && /cannot be read/.test(dp("outreach.example.com", null)!),
    "never the product's domain or a parent of it; fail closed without it");
  const root = await errOf(adm("POST", "/gtm/identities", { from_name: "Sales", from_address: `sales@ob-${D}.dev`, daily_cap: 50 }));
  assert.ok(root.status === 400 && /not a subdomain/.test(root.error), "an identity on a bare registrable domain is refused");
  assert.equal(await status(adm("POST", "/gtm/identities", { from_name: "Sales", from_address: `sales@outreach.bücher-${stamp}.de` })), 400, "a unicode domain is a 400 (punycode, please), not a 500");
  const atName = await errOf(adm("POST", "/gtm/identities", { from_name: "sales@evil.example", from_address: `x@outreach.ob-${D}.dev` }));
  assert.ok(atName.status === 400 && /@/.test(atName.error), "a display name with an @ is refused");
  const OUT = `outreach.ob-${D}.dev`;
  const today = new Date().toISOString().slice(0, 10);
  const ids0 = await json(adm("POST", "/gtm/identities", { from_name: 'Priya at Octillion, "Sales";\n', from_address: `priya@${OUT}`, daily_cap: 10, warmup_start: today, warmup_from: 2, warmup_days: 28 }));
  const ident = ids0.identities.find((i: any) => i.from_address === `priya@${OUT}`);
  assert.ok(ident && ident.from_name === "Priya at Octillion Sales" && ident.subdomain === false && ident.problem === null, `the name is cleaned: ${JSON.stringify(ident)}`);
  assert.ok(ident && ident.cap_today === 2 && ident.sent_today === 0 && !ident.on_product_domain && ident.plan.length === 35 && ident.plan[28].cap === 10, "warm-up: 2 today, the full 10 after 28 days");
  const curve = { daily_cap: 200, warmup_from: 20, warmup_days: 28, warmup_start: "2026-01-01" };
  assert.deepEqual([outbound.warmupCap(curve, new Date("2025-12-31T12:00:00Z")), outbound.warmupCap(curve, new Date("2026-01-01T12:00:00Z")), outbound.warmupCap(curve, new Date("2026-01-15T12:00:00Z")),
    outbound.warmupCap(curve, new Date("2026-01-29T12:00:00Z")), outbound.warmupCap({ ...curve, warmup_start: null }, new Date())], [0, 20, 110, 200, 200], "the ramp: nothing before, 20 rising linearly to the cap");

  // ---------- an outbound campaign: identity required, the cold-email rules, the cap, text only ----------
  // Prospects for it: A (US), Z (US, Apollo), Y (DE), X (unverified), H (US, CTO), a customer, and one in another sequence.
  const cust = P("cust", `custco-${D}.dev`), busy = P("busy");
  const custOrg = (await db.query<{ id: number }>("INSERT INTO organizations (slug, name) VALUES ($1, $1) RETURNING id", [`p2-cust-${stamp}`]))[0].id;
  created.orgs.push(custOrg);
  created.requests.push((await db.query<{ id: number }>("INSERT INTO access_requests (email, company, status, org_id) VALUES ($1, 'Cust', 'approved', $2) RETURNING id", [cust, custOrg]))[0].id);
  for (const e of [cust, busy]) await json(adm("POST", "/gtm/prospects", { email: e, first_name: "Q", lawful_basis: "legitimate_interest", country: "US" }));
  await db.query("UPDATE gtm_prospects SET email_status = 'verified' WHERE email = ANY($1::text[])", [[pa, ph, cust, busy]]);
  await db.query("UPDATE gtm_prospects SET tags = array_append(tags, $2) WHERE email = ANY($1::text[])", [[pa, ph, cust, busy, zed, yan, xia], D]);
  // busy is in a running (lifecycle) campaign already.
  const other = (await json(adm("POST", "/gtm/campaigns", { name: `Other ${stamp}`, audience: { include: "accounts", accounts: [`nobody-${stamp}`] }, steps: [{ subject: "x", body: "y" }] }))).campaign.id;
  created.campaigns.push(other);
  await db.query("UPDATE gtm_campaigns SET status = 'running', launched_at = now(), enrolled_at = now() WHERE id = $1", [other]);
  await db.query("INSERT INTO gtm_campaign_recipients (campaign_id, email, source, status, next_at) VALUES ($1, $2, 'request', 'active', now() + interval '30 days')", [other, busy]);

  const audience = { include: "prospects", prospects: { tags: [D] } };
  const steps = [{ subject: "Quick question, {{first_name}}", body: "Hi {{first_name}},\n\nDo coding agents recommend {{product}}? https://octillion.test/check", delay_days: 0 },
    { subject: "Following up", body: "Any thoughts, {{first_name}}?", delay_days: 3 }];
  const trig = await errOf(adm("POST", "/gtm/campaigns", { name: "x", audience, steps, trigger: { type: "account_created" } }));
  assert.ok(trig.status === 400 && /not triggered/.test(trig.error), "an outbound campaign is never event-triggered");
  const cO = (await json(adm("POST", "/gtm/campaigns", { name: `Outbound ${stamp}`, audience, steps }))).campaign.id;
  created.campaigns.push(cO);
  const noId = await errOf(adm("POST", `/gtm/campaigns/${cO}/launch`, {}));
  assert.ok(noId.status === 409 && /sender identity/.test(noId.error), "a prospects campaign cannot launch without an outbound identity");
  const prodIdent = (await db.query<{ id: number }>("INSERT INTO gtm_sender_identities (from_name, from_address, domain) VALUES ('Bad', $1, $2) RETURNING id", [`x-${stamp}@${product}`, product]))[0].id;
  assert.equal(await status(adm("PUT", `/gtm/campaigns/${cO}`, { sender_identity_id: prodIdent })), 400, "nor with one on the product's domain");
  await db.query("DELETE FROM gtm_sender_identities WHERE id = $1", [prodIdent]);
  const pv = await json(adm("POST", "/gtm/audience/preview", { audience, campaign_id: cO }));
  // The customer was linked to their account when added (status customer): never a candidate at all.
  assert.equal((await prospectBy(cust)).status, "customer", "a prospect whose address has an account is a customer");
  // Matches: A, H, Z, Y, busy (verified); X is unverified (left out by default).
  assert.ok(pv.count === 5 && pv.by_source.prospect === 5 && pv.sendable === 3 && pv.blocked.in_sequence === 1 && pv.blocked.restricted === 1,
    `preview: ${JSON.stringify({ count: pv.count, sendable: pv.sendable, blocked: pv.blocked })}`);
  assert.ok(!pv.sample.some((s: any) => s.email === xia), "verified addresses only, by default");
  await json(adm("PUT", `/gtm/campaigns/${cO}`, { sender_identity_id: ident.id }));
  const launched = await json(adm("POST", `/gtm/campaigns/${cO}/launch`, {}));
  assert.ok(launched.campaign.outbound && launched.campaign.track_opens_effective === false, "launched; outbound tracks no opens by default");
  const enrolled = launched.recipients.map((r: any) => r.email).sort();
  assert.deepEqual(enrolled, [pa, ph, zed].sort(), "enrolled: not the customer, not the one in another sequence, not the EU prospect, not the unverified one");
  assert.ok(launched.recipients.every((r: any) => r.prospect_id && r.consent_basis === "legitimate_interest" && r.source === "prospect"), "each recipient knows its prospect and basis");
  const t1 = await tick();
  const outMails = () => mail && [pa, ph, zed].flatMap((e) => sentTo(e, "outbound"));
  assert.ok(t1.sent === 2 && t1.capped === 1, `the warm-up cap (2 today) holds: ${JSON.stringify(t1)}`);
  const m0 = outMails()[0];
  assert.ok(m0.from === `"Priya at Octillion Sales" <priya@${OUT}>` && !m0.html && /Unsubscribe: http/.test(m0.text) && /because of your role/.test(m0.text) && m0.headers?.["List-Unsubscribe"], "from the identity, plain text only (no pixel), with the unsubscribe link");
  assert.ok((await db.query("SELECT 1 FROM email_log WHERE kind = 'outbound' AND to_domain = $1", [`p2-${D}.dev`])).length + (await db.query("SELECT 1 FROM email_log WHERE kind = 'outbound' AND to_domain = $1", [`zeta-${D}.dev`])).length === 2, "logged as outbound, by domain");
  const contacted = (await db.query<any>("SELECT email, status FROM gtm_prospects WHERE email = ANY($1::text[])", [[pa, ph, zed]])).filter((p: any) => p.status === "contacted");
  assert.equal(contacted.length, 2, "a first email moves new -> contacted");
  // A second campaign on the same identity shares the day's cap: nothing more today.
  const cO2 = (await json(adm("POST", "/gtm/campaigns", { name: `Outbound EU ${stamp}`, audience: { include: "prospects", prospects: { tags: [D], statuses: ["new"] } }, steps, sender_identity_id: ident.id, allow_restricted: true }))).campaign.id;
  created.campaigns.push(cO2);
  const l2 = await json(adm("POST", `/gtm/campaigns/${cO2}/launch`, {}));
  assert.ok(l2.recipients.some((r: any) => r.email === yan) && !l2.recipients.some((r: any) => [pa, ph, zed].includes(r.email)), "allowing EU / EEA / UK / CH prospects enrols the one with a basis; people in another sequence are left out");
  const t2 = await tick();
  assert.ok(t2.sent === 0 && t2.capped === 1, `the cap is per identity, across campaigns: ${JSON.stringify(t2)}`);
  // Warmed up: the rest go (capped people are looked at again hourly: an hour passes).
  await json(adm("PUT", `/gtm/identities/${ident.id}`, { warmup_start: "" }));
  await db.query("UPDATE gtm_campaign_recipients SET next_at = now() WHERE campaign_id = ANY($1::bigint[]) AND status = 'pending'", [[cO, cO2]]);
  const t3 = await tick();
  assert.equal(t3.sent, 2, "after the warm-up, the waiting ones go out");
  assert.equal((await json(adm("GET", "/gtm/identities"))).identities.find((i: any) => i.id === ident.id).sent_today, 4, "sent today counts every campaign's emails from it");
  assert.equal(await status(adm("DELETE", `/gtm/identities/${ident.id}`)), 409, "an identity a running campaign uses cannot be deleted");

  // ---------- replies, quick actions, bounces ----------
  const INBOX = `replies@reply-${D}.octillion.test`;
  await settings.setSettings("smoke", { EMAIL_INBOUND_ADDRESS: INBOX });
  const whsec = `whsec_${randomBytes(24).toString("base64")}`;
  const hookCred = await kvm.setCredential("resend_webhook", whsec);
  const hook = (body: unknown) => {
    const raw = JSON.stringify(body), sid = `msg_${randomBytes(6).toString("hex")}`, ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", Buffer.from(whsec.replace(/^whsec_/, ""), "base64")).update(`${sid}.${ts}.${raw}`).digest("base64");
    return fetch(`${base}/api/webhooks/resend`, { method: "POST", headers: { "content-type": "application/json", "svix-id": sid, "svix-timestamp": ts, "svix-signature": `v1,${sig}` }, body: raw });
  };
  const rid = async (email: string, cid = cO) => Number((await db.query<{ id: number }>("SELECT id FROM gtm_campaign_recipients WHERE campaign_id = $1 AND email = $2", [cid, email]))[0].id);
  const { replyAddress, inbox } = await import("../src/gtm-replies.js"), { unsubscribeKey } = await import("../src/campaigns.js");
  const reply = async (email: string, id: string, text = "Interesting, tell me more.") => {
    const to = await replyAddress(await rid(email), await unsubscribeKey(), (await inbox())!);
    await mockPost("/_mock/resend/received", { id, to: [to], from: `P <${email}>`, subject: "Re: Quick question", text, headers: {} });
    return json(hook({ type: "email.received", created_at: new Date().toISOString(), data: { email_id: id, from: email, to: [to], subject: "Re: Quick question" } }));
  };
  assert.equal((await reply(pa, `p2_in_a_${stamp}`)).kind, "reply");
  assert.equal((await prospectBy(pa)).status, "replied", "a reply moves the prospect to replied");
  const recA = (await db.query<any>("SELECT status, next_at FROM gtm_campaign_recipients WHERE id = $1", [await rid(pa)]))[0];
  assert.ok(recA.status === "replied" && recA.next_at == null, "and stops their sequence");
  const [yA] = await db.query<{ id: number }>("SELECT id FROM gtm_replies WHERE provider_id = $1", [`p2_in_a_${stamp}`]);
  assert.equal(await status(adm("POST", `/gtm/replies/${yA.id}/action`, { action: "maybe" })), 400, "quick actions: interested, not_interested, unsubscribe");
  const qa = await json(adm("POST", `/gtm/replies/${yA.id}/action`, { action: "interested" }));
  assert.ok(qa.prospect_id && (await prospectBy(pa)).status === "interested" && (await db.query<any>("SELECT handled_at FROM gtm_replies WHERE id = $1", [yA.id]))[0].handled_at, "interested: the status, and the reply handled");
  await reply(ph, `p2_in_h_${stamp}`, "Please remove me.");
  const [yH] = await db.query<{ id: number }>("SELECT id FROM gtm_replies WHERE provider_id = $1", [`p2_in_h_${stamp}`]);
  await json(adm("POST", `/gtm/replies/${yH.id}/action`, { action: "unsubscribe" }));
  assert.ok((await db.query("SELECT 1 FROM email_suppressions WHERE email_hash = $1", [mail.hashAddress(ph)])).length && (await prospectBy(ph)).status === "not_interested", "unsubscribe from the inbox: suppressed (by hash), not interested");
  // A hard bounce: bad_email.
  const [zSend] = await db.query<{ provider_id: string }>("SELECT s.provider_id FROM gtm_campaign_sends s JOIN gtm_campaign_recipients r ON r.id = s.recipient_id WHERE r.email = $1 AND s.status = 'sent'", [zed]);
  await json(hook({ type: "email.bounced", created_at: new Date().toISOString(), data: { email_id: zSend.provider_id, bounce: { type: "Permanent" } } }));
  const zAfter = await prospectBy(zed);
  assert.ok(zAfter.status === "bad_email" && zAfter.email_status === "invalid", "a hard bounce sets bad_email");
  // Open tracking, when a campaign turns it on: an HTML part again.
  const tp = P("track");
  await json(adm("POST", "/gtm/prospects", { email: tp, first_name: "Tia", lawful_basis: "legitimate_interest", country: "US", tags: `${D}-track` }));
  await db.query("UPDATE gtm_prospects SET email_status = 'verified' WHERE email = $1", [tp]);
  const cT = (await json(adm("POST", "/gtm/campaigns", { name: `Tracked ${stamp}`, audience: { include: "prospects", prospects: { tags: [`${D}-track`] } }, steps, sender_identity_id: ident.id, track_opens: true }))).campaign.id;
  created.campaigns.push(cT);
  await json(adm("POST", `/gtm/campaigns/${cT}/launch`, {}));
  await tick();
  assert.ok(sentTo(tp, "outbound")[0]?.html, "track_opens on: an HTML part");
  const test = await json(adm("POST", `/gtm/campaigns/${cO}/test`, { to: `t+${stamp}@p2-test.dev` }));
  const sentBefore = (await json(adm("GET", "/gtm/identities"))).identities.find((i: any) => i.id === ident.id).sent_today;
  assert.ok(test.status === "sent" && sentTo(`t+${stamp}@p2-test.dev`, "outbound_test")[0].from === `"Priya at Octillion Sales" <priya@${OUT}>`, "a test send goes from the identity too");
  await json(adm("POST", `/gtm/campaigns/${cO}/test`, { to: `t2+${stamp}@p2-test.dev` }));
  assert.equal((await json(adm("GET", "/gtm/identities"))).identities.find((i: any) => i.id === ident.id).sent_today, sentBefore + 1, "a test send counts toward the identity's daily cap");
  assert.ok((await json(adm("GET", `/gtm/campaigns/${cO}`))).setup.outbound_postal_warning === outbound.POSTAL_WARNING, "no postal address: a warning on outbound campaigns, never a block");

  // B1: once anyone is enrolled, a campaign never switches between prospects and accounts; and a prospect is always
  // cold email, from a valid identity, whatever the campaign row says.
  await json(adm("POST", `/gtm/campaigns/${cT}/pause`));
  const sw = await errOf(adm("PUT", `/gtm/campaigns/${cT}`, { audience: { include: "accounts" } }));
  assert.ok(sw.status === 409 && /switch/.test(sw.error), "switching a paused outbound campaign to accounts is refused");
  await json(adm("POST", `/gtm/campaigns/${cT}/resume`));
  const b1 = P("b1");
  await json(adm("POST", "/gtm/prospects", { email: b1, first_name: "Bea", lawful_basis: "legitimate_interest", country: "US", tags: `${D}-b1` }));
  await db.query("UPDATE gtm_prospects SET email_status = 'verified' WHERE email = $1", [b1]);
  const cB1 = (await json(adm("POST", "/gtm/campaigns", { name: `B1 ${stamp}`, audience: { include: "prospects", prospects: { tags: [`${D}-b1`] } }, steps, sender_identity_id: ident.id }))).campaign.id;
  created.campaigns.push(cB1);
  assert.equal((await json(adm("POST", `/gtm/campaigns/${cB1}/launch`, {}))).recipients.length, 1);
  // Forced into a lifecycle shape behind the API's back: the prospect still never gets an email from the product domain.
  await db.query(`UPDATE gtm_campaigns SET audience = '{"include":"accounts"}'::jsonb, sender_identity_id = NULL WHERE id = $1`, [cB1]);
  await tick();
  assert.ok(!sentTo(b1).length, "a prospect without a valid identity gets nothing (never EMAIL_FROM)");
  await db.query("UPDATE gtm_campaigns SET sender_identity_id = $2 WHERE id = $1", [cB1, ident.id]);
  await db.query("UPDATE gtm_campaign_recipients SET next_at = now() WHERE campaign_id = $1", [cB1]);
  await tick();
  assert.ok(sentTo(b1, "outbound")[0]?.from === `"Priya at Octillion Sales" <priya@${OUT}>` && !sentTo(b1, "campaign").length, "with one, the prospect's email goes from the identity, as outbound");

  // B2: account members are customers, by address hash (Clerk), at enrolment, before each send and by the relink action.
  const memCo = `memco-${D}.dev`, mem = P("member", memCo), colleague = `col+${stamp}@${memCo}`;
  await json(adm("POST", "/gtm/prospects", { email: mem, first_name: "Mo", lawful_basis: "legitimate_interest", country: "US", tags: `${D}-b2` }));
  await json(adm("POST", "/gtm/prospects", { email: colleague, first_name: "Col", lawful_basis: "legitimate_interest", country: "US", tags: `${D}-b2` }));
  await db.query("UPDATE gtm_prospects SET email_status = 'verified' WHERE email = ANY($1::text[])", [[mem, colleague]]);
  const cB2 = (await json(adm("POST", "/gtm/campaigns", { name: `B2 ${stamp}`, audience: { include: "prospects", prospects: { tags: [`${D}-b2`] } }, steps, sender_identity_id: ident.id }))).campaign.id;
  created.campaigns.push(cB2);
  assert.equal((await json(adm("POST", `/gtm/campaigns/${cB2}/launch`, {}))).recipients.length, 2, "both enrolled while nobody knows them");
  // Then each joins an existing account in Clerk (an accepted invitation): the next tick must not email them.
  const clerkOrg = await (await fetch(`${mockUrl}/v1/organizations`, { method: "POST", headers: { authorization: "Bearer sk_test_mock", "content-type": "application/json" }, body: JSON.stringify({ name: `memorg-${stamp}` }) })).json();
  const memOrg = (await db.query<{ id: number }>("INSERT INTO organizations (slug, name, clerk_org_id) VALUES ($1, $1, $2) RETURNING id", [`memorg-${stamp}`, clerkOrg.id]))[0].id;
  created.orgs.push(memOrg);
  for (const e of [mem, `boss+${stamp}@${memCo}`]) {
    const u = await mockPost("/_mock/clerk/users", { email: e, first_name: "M" });
    await mockPost("/_mock/clerk/memberships", { org_id: clerkOrg.id, user_id: u.id, role: "org:member" });
  }
  const tB2 = await tick();
  assert.ok(!sentTo(mem).length && !sentTo(colleague).length && tB2.blocked >= 2, `a new member (and a colleague at their domain) is never cold-emailed: ${JSON.stringify(tB2)}`);
  const rel = await json(adm("POST", "/gtm/prospects/relink"));
  assert.ok(rel.prospects >= 1 && rel.companies >= 1 && (await prospectBy(mem)).status === "customer" && Number((await prospectBy(mem)).org_id) === Number(memOrg), `relink: ${JSON.stringify(rel)}`);
  assert.equal(Number((await db.query<any>("SELECT org_id FROM gtm_companies WHERE domain = $1", [memCo]))[0].org_id), Number(memOrg), "their company is linked by domain");
  assert.ok((await db.query("SELECT 1 FROM gtm_jobs WHERE name = 'customer_links'")).length, "the backfill ran once (first tick) and is recorded");
  // A linked company keeps its domain and cannot be deleted (its people stay recognised).
  const memCoId = Number((await db.query<any>("SELECT id FROM gtm_companies WHERE domain = $1", [memCo]))[0].id);
  assert.equal(await status(adm("DELETE", `/gtm/companies/${memCoId}`)), 409, "a company linked to an account cannot be deleted");
  assert.equal(await status(adm("PUT", `/gtm/companies/${memCoId}`, { domain: `other-${memCo}` })), 409, "nor change its domain");
  // Clerk not answering: no cold email this pass (fail closed), and the relink action says so.
  const fc = P("failclosed");
  await json(adm("POST", "/gtm/prospects", { email: fc, first_name: "Fay", lawful_basis: "legitimate_interest", country: "US", tags: `${D}-fc` }));
  await db.query("UPDATE gtm_prospects SET email_status = 'verified' WHERE email = $1", [fc]);
  const cFc = (await json(adm("POST", "/gtm/campaigns", { name: `FC ${stamp}`, audience: { include: "prospects", prospects: { tags: [`${D}-fc`] } }, steps, sender_identity_id: ident.id }))).campaign.id;
  created.campaigns.push(cFc);
  assert.equal((await json(adm("POST", `/gtm/campaigns/${cFc}/launch`, {}))).recipients.length, 1);
  const deadClerk = await (await fetch(`${mockUrl}/v1/organizations`, { method: "POST", headers: { authorization: "Bearer sk_test_mock", "content-type": "application/json" }, body: JSON.stringify({ name: `dead-${stamp}` }) })).json();
  const deadOrg = (await db.query<{ id: number }>("INSERT INTO organizations (slug, name, clerk_org_id) VALUES ($1, $1, $2) RETURNING id", [`dead-${stamp}`, deadClerk.id]))[0].id;
  created.orgs.push(deadOrg);
  await mockPost("/_mock/clerk/members-outage", { down: true });
  const tFc = await tick();
  assert.ok(!sentTo(fc).length && tFc.deferred >= 1, `Clerk down: the prospect waits (${JSON.stringify(tFc)})`);
  assert.equal((await db.query<any>("SELECT status FROM gtm_campaign_recipients WHERE campaign_id = $1", [cFc]))[0].status, "pending", "still waiting, not dropped");
  assert.equal(await status(adm("POST", "/gtm/prospects/relink")), 503, "relink refuses to half-link without Clerk");
  await mockPost("/_mock/clerk/members-outage", { down: false });
  await db.query("UPDATE gtm_campaign_recipients SET next_at = now() WHERE campaign_id = $1", [cFc]);
  await tick();
  assert.equal(sentTo(fc, "outbound").length, 1, "Clerk back: it goes");
  // Uncertain sends (phase 1's rules) apply to outbound: a 409 twice holds the batch as uncertain, counted toward the
  // identity's cap; the next tick replays it exactly, still from the identity and text only, once each.
  const [un1, un2] = [P("unc1"), P("unc2")];
  for (const e of [un1, un2]) await json(adm("POST", "/gtm/prospects", { email: e, first_name: "Una", lawful_basis: "legitimate_interest", country: "US", tags: `${D}-unc` }));
  await db.query("UPDATE gtm_prospects SET email_status = 'verified' WHERE email = ANY($1::text[])", [[un1, un2]]);
  const cUn = (await json(adm("POST", "/gtm/campaigns", { name: `Unc ${stamp}`, audience: { include: "prospects", prospects: { tags: [`${D}-unc`] } }, steps, sender_identity_id: ident.id }))).campaign.id;
  created.campaigns.push(cUn);
  await json(adm("POST", `/gtm/campaigns/${cUn}/launch`, {}));
  await json(adm("PUT", `/gtm/identities/${ident.id}`, { daily_cap: 100 }));
  const sentPre = (await json(adm("GET", "/gtm/identities"))).identities.find((i: any) => i.id === ident.id).sent_today;
  await mockPost("/_mock/resend/uncertain", { concurrent: 2 });
  const tu = await tick();
  const held = await db.query<any>("SELECT status, identity_id, payload FROM gtm_campaign_sends WHERE campaign_id = $1", [cUn]);
  assert.ok(tu.uncertain >= 2 && held.length === 2 && held.every((h: any) => h.status === "uncertain" && Number(h.identity_id) === ident.id && h.payload.from === `"Priya at Octillion Sales" <priya@${OUT}>` && h.payload.textOnly === true),
    `outbound uncertain: held with the identity's From: ${JSON.stringify({ tu, held: held.map((h: any) => [h.status, h.identity_id]) })}`);
  assert.equal((await json(adm("GET", "/gtm/identities"))).identities.find((i: any) => i.id === ident.id).sent_today, sentPre + 2, "uncertain sends count toward the cap");
  await tick();
  for (const e of [un1, un2]) {
    const got = sentTo(e);
    assert.ok(got.length === 1 && got[0].from === `"Priya at Octillion Sales" <priya@${OUT}>` && !got[0].html && got[0].tags?.[0]?.value === "outbound", `the replay keeps the identity's From, text only, once: ${e}`);
  }

  // Minor: another outbound campaign's recent email keeps a prospect out of a new one (cool-off), the ledger records
  // the prospect's basis, an import needs an explicit basis for someone with no country, and an unknown company id
  // is a row error.
  const cCool = (await json(adm("POST", "/gtm/campaigns", { name: `Cool ${stamp}`, audience: { include: "prospects", prospects: { tags: [`${D}-fc`] } }, steps, sender_identity_id: ident.id }))).campaign.id;
  created.campaigns.push(cCool);
  await json(adm("POST", `/gtm/campaigns/${cFc}/end`));
  const pvCool = await json(adm("POST", "/gtm/audience/preview", { audience: { include: "prospects", prospects: { tags: [`${D}-fc`], statuses: ["new", "contacted"] } }, campaign_id: cCool }));
  assert.ok(pvCool.blocked.cooling_off === 1 && pvCool.sendable === 0, `cool-off after another outbound campaign: ${JSON.stringify(pvCool.blocked)}`);
  const ledger = await db.query<any>("SELECT basis, source FROM email_consent_ledger WHERE email_hash = $1", [mail.hashAddress(fc)]);
  assert.ok(ledger.some((l: any) => l.source === "prospect" && l.basis === "legitimate_interest") && !ledger.some((l: any) => l.source === "account"), "the ledger records the prospect's basis (source prospect)");
  const noC = await json(adm("POST", "/gtm/prospects/import", { rows: [{ email: P("nocountry"), first_name: "N" }, { first_name: "Co", last_name: "Id", company_id: 999999999, lawful_basis: "consent", country: "US" }], lawful_basis: "legitimate_interest", dry_run: true }));
  assert.ok(noC.rows[0].action === "refuse" && /No country/.test(noC.rows[0].reason) && noC.rows[1].action === "refuse", `no country needs an explicit basis; an unknown company id is a row error: ${JSON.stringify(noC.rows)}`);
  const chunked = await json(adm("POST", "/gtm/prospects/import", { rows: Array.from({ length: 205 }, (_, k) => ({ email: P(`bulk${k}`), first_name: "B", country: "US" })), lawful_basis: "legitimate_interest", dry_run: false }));
  assert.ok(chunked.applied.length === 205 && chunked.summary.create === 205 && !chunked.error, "a large import is written in chunks, every row reported applied");
  // Apollo's email status is only kept for Apollo's own address.
  await db.query("INSERT INTO gtm_prospects (email, first_name, apollo_id, lawful_basis, country) VALUES ($1, 'Wes', $2, 'legitimate_interest', 'US')", [P("wes"), `ap_w_${stamp}`]);
  await mockPost("/_mock/apollo/people", { people: [{ id: `ap_w_${stamp}`, first_name: "Wes", last_name: "West", title: "CTO", seniority: "c_suite", email: `other+${stamp}@zeta-${D}.dev`, email_status: "verified", country_name: "United States", company: "Zeta", domain: `zeta-${D}.dev`, industry: "Computer Software", employees: 120 }] });
  const wId = Number((await prospectBy(P("wes"))).id);
  await json(adm("POST", "/gtm/apollo/enrich/prospects", { ids: [wId], force: true }));
  const W = await prospectBy(P("wes"));
  assert.ok(W.email === P("wes") && W.email_status === "unknown", "a different Apollo address's status is never put on the prospect's own");

  // ---------- a prospect who signs up: linked, a gtm event, attribution ----------
  const form = await fetch(`${base}/api/access-requests`, { method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, "x-vercel-ip-country": "US" },
    body: JSON.stringify({ email: pa, company: "P2 Co" }) });
  assert.equal(form.status, 201);
  const [reqA] = await db.query<{ id: number }>("SELECT id FROM access_requests WHERE lower(email) = $1", [pa]);
  created.requests.push(Number(reqA.id));
  await waitFor(async () => (await prospectBy(pa)).request_id === Number(reqA.id), "an access request with the prospect's address links them");
  const evs = await db.query<any>("SELECT * FROM gtm_events WHERE type = 'prospect_converted' AND (data->>'prospect_id')::bigint = $1", [A.id]);
  assert.ok(evs.length === 1 && Number(evs[0].data.campaign_id) === cO && evs[0].data.via === "request", "a prospect_converted event, crediting the first campaign");
  const approved = await json(adm("POST", `/requests/${reqA.id}/approve`, { slug: `p2-acc-${stamp}` }));
  const [accOrg] = await db.query<{ id: number }>("SELECT id FROM organizations WHERE slug = $1", [approved.org.slug]);
  created.orgs.push(Number(accOrg.id));
  await waitFor(async () => (await prospectBy(pa)).status === "customer", "their account makes them a customer");
  await waitFor(async () => Number((await db.query<any>("SELECT org_id FROM gtm_companies WHERE domain = $1", [`p2-${D}.dev`]))[0].org_id) === Number(accOrg.id), "and links their company by domain");
  const pdA = await json(adm("GET", `/gtm/prospects/${A.id}`));
  const types = new Set(pdA.timeline.map((t: any) => t.type));
  for (const t of ["imported", "email_sent", "replied", "status", "linked"]) assert.ok(types.has(t), `the timeline has ${t}: ${[...types]}`);
  assert.ok(pdA.prospect.org_slug === approved.org.slug, "the prospect shows its account");
  // A colleague at a customer's company is never cold-emailed now.
  const blk = await outbound.outboundBlocks([{ email: pb }], { id: 0, allow_restricted: false });
  assert.equal(blk.get(pb), "customer", "someone at a linked company counts as a customer");

  // ---------- deals: from a reply in one click, the board, stages, revenue ----------
  const d1 = await json(adm("POST", "/gtm/deals", { from_reply: yA.id, value: 12000 }));
  assert.ok(d1.deal.prospect_id === Number(A.id) && Number(d1.deal.campaign_id) === cO && d1.deal.company === "P2 Co" && d1.deal.stage === "lead" && d1.deal.source === "outbound", `a deal from a reply: ${JSON.stringify(d1.deal)}`);
  const d2 = await json(adm("POST", "/gtm/deals", { prospect_id: Number(Y.id), value: 5000, currency: "eur" }));
  assert.ok(d2.deal.currency === "EUR" && d2.deal.company === "Zeta", "a deal from a prospect, in one click");
  assert.equal(await status(adm("POST", "/gtm/deals", { name: "x", stage: "nope" })), 400, "only known stages");
  const moved = await json(adm("POST", `/gtm/deals/${d1.deal.id}/move`, { stage: "won" }));
  assert.ok(moved.deal.stage === "won" && moved.deal.closed_at && moved.deal.org_slug === approved.org.slug, "won: closed, linked to the account the prospect became");
  await json(adm("POST", `/gtm/deals/${d2.deal.id}/move`, { stage: "demo" }));
  const d3 = await json(adm("POST", "/gtm/deals", { name: `Third ${stamp}`, stage: "demo", value: 1 }));
  await json(adm("POST", `/gtm/deals/${d3.deal.id}/move`, { stage: "demo", before: d2.deal.id }));
  const dl = await json(adm("GET", "/gtm/deals"));
  const demo = dl.deals.filter((d: any) => d.stage === "demo").map((d: any) => d.id);
  assert.ok(demo.indexOf(d3.deal.id) < demo.indexOf(d2.deal.id), "dragging before another card orders the column");
  const wonDeal = dl.deals.find((d: any) => d.id === d1.deal.id);
  assert.ok(wonDeal.kind === "won" && wonDeal.revenue && typeof wonDeal.revenue.mrr_usd === "number" && dl.totals.won >= 12000, "won deals show the account's Stripe revenue");
  const st = dl.stages.map((s: any) => ({ id: s.id, label: s.label, kind: s.kind }));
  // A stage that becomes won closes its deals; back to open, they reopen.
  await json(adm("PUT", "/gtm/deal-stages", { stages: st.map((s: any) => (s.id === "demo" ? { ...s, kind: "won" } : s)) }));
  assert.ok((await json(adm("GET", `/gtm/deals/${d2.deal.id}`))).deal.closed_at, "a stage turned won closes its deals");
  await json(adm("PUT", "/gtm/deal-stages", { stages: st }));
  assert.equal((await json(adm("GET", `/gtm/deals/${d2.deal.id}`))).deal.closed_at, null, "and reopens them when it is open again");
  // A lifecycle campaign's reply is never outbound pipeline.
  const busyRid = Number((await db.query<{ id: number }>("SELECT id FROM gtm_campaign_recipients WHERE campaign_id = $1 AND email = $2", [other, busy]))[0].id);
  const [lr] = await db.query<{ id: number }>("INSERT INTO gtm_replies (campaign_id, recipient_id, provider_id, kind, snippet) VALUES ($1, $2, $3, 'reply', 'hi') RETURNING id", [other, busyRid, `p2_life_${stamp}`]);
  const dL = await json(adm("POST", "/gtm/deals", { from_reply: lr.id, name: `Life ${stamp}` }));
  assert.ok(dL.deal.campaign_id == null && dL.deal.source === "lifecycle", "a deal from a lifecycle reply is not credited to outbound");
  await db.query("DELETE FROM gtm_deals WHERE id = $1", [dL.deal.id]);
  assert.equal(await status(adm("PUT", "/gtm/deal-stages", { stages: st.filter((s: any) => s.id !== "demo") })), 409, "a stage with deals cannot be removed");
  const renamed = await json(adm("PUT", "/gtm/deal-stages", { stages: [...st.slice(0, 3), { label: "Security review", kind: "open" }, ...st.slice(3)].map((s: any) => (s.id === "demo" ? { ...s, label: "Demo booked" } : s)) }));
  assert.ok(renamed.stages.some((s: any) => s.id === "security_review") && renamed.stages.find((s: any) => s.id === "demo").label === "Demo booked", "stages are configurable");
  assert.equal(await status(adm("PUT", "/gtm/deal-stages", { stages: st.filter((s: any) => s.kind !== "lost") })), 400, "the pipeline keeps a lost stage");
  await json(adm("PUT", "/gtm/deal-stages", { stages: st }));

  // ---------- attribution: outbound as a channel, first touch, pipeline and won per campaign ----------
  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const oa = await json(adm("GET", `/gtm/attribution/outbound?from=${day(2)}&to=${day(0)}`));
  assert.ok(oa.model === "first_touch" && /first/i.test(oa.model_text), "the model is stated");
  const ch = oa.channels.find((c: any) => c.channel === "outbound");
  assert.ok(ch.requests >= 1 && ch.accounts >= 1, `outbound shows as a channel: ${JSON.stringify(oa.channels)}`);
  const row = oa.campaigns.find((c: any) => c.key === String(cO));
  assert.ok(row && row.touched === 3 && row.replied === 2 && row.requests === 1 && row.accounts === 1 && row.won === 12000, `per campaign: ${JSON.stringify(row)}`);
  const src = oa.sources.find((s: any) => s.key === "csv");
  assert.ok(src && src.won === 12000, "and per prospect source");
  const yRow = oa.campaigns.find((c: any) => c.key === String(cO2));
  assert.ok(yRow && yRow.pipeline === 5000, "open deals count as that campaign's pipeline");

  // ---------- where addresses live: gtm_prospects, recipients, replies; nowhere else ----------
  const everyone = [pa, pb, pd, pg, ph, gmailP, zed, yan, xia, cust, busy, tp, b1, mem, colleague, fc, P("wes"), un1, un2];
  const elsewhere = JSON.stringify(await db.query("SELECT * FROM gtm_companies")) + JSON.stringify(await db.query("SELECT * FROM gtm_prospect_activities"))
    + JSON.stringify(await db.query("SELECT * FROM gtm_deals")) + JSON.stringify(await db.query("SELECT * FROM gtm_deal_stages")) + JSON.stringify(await db.query("SELECT * FROM gtm_apollo_cache"))
    + JSON.stringify(await db.query("SELECT * FROM gtm_apollo_usage")) + JSON.stringify(await db.query("SELECT * FROM gtm_sender_identities")) + JSON.stringify(await db.query("SELECT * FROM gtm_events"))
    + JSON.stringify(await db.query("SELECT * FROM gtm_campaign_sends")) + JSON.stringify(await db.query("SELECT * FROM gtm_campaigns")) + JSON.stringify(await db.query("SELECT * FROM email_suppressions"))
    + JSON.stringify(await db.query("SELECT * FROM email_consents")) + JSON.stringify(await db.query("SELECT * FROM email_consent_ledger"))
    + JSON.stringify(await db.query("SELECT * FROM email_log WHERE kind IN ('outbound', 'outbound_test')")) + JSON.stringify(await db.query("SELECT enrichment FROM gtm_prospects"));
  for (const a of everyone) assert.ok(!elsewhere.includes(a), `no prospect address outside gtm_prospects, gtm_campaign_recipients and gtm_replies: ${a}`);
  assert.ok(crm.FREEMAIL.has("gmail.com"));

  // Clean up.
  for (const id of created.campaigns) { await adm("POST", `/gtm/campaigns/${id}/end`).catch(() => {}); await db.query("DELETE FROM gtm_campaigns WHERE id = $1", [id]); }
  await db.query("DELETE FROM gtm_deals WHERE id = ANY($1::bigint[])", [[d1.deal.id, d2.deal.id, d3.deal.id]]);
  await db.query("DELETE FROM gtm_prospects WHERE email = ANY($1::text[]) OR apollo_id LIKE $2 OR email LIKE $3", [everyone, `ap_%_${stamp}`, `bulk%+${stamp}@%`]);
  await db.query("DELETE FROM gtm_companies WHERE domain LIKE $1", [`%${D}.dev`]);
  await db.query("DELETE FROM gtm_sender_identities WHERE domain = $1", [OUT]);
  await db.query("DELETE FROM email_consent_ledger WHERE email_hash = ANY($1::text[])", [everyone.map(mail.hashAddress)]);
  await db.query("DELETE FROM gtm_events WHERE type = 'prospect_converted' AND (data->>'prospect_id')::bigint = $1", [A.id]);
  await db.query("DELETE FROM email_suppressions WHERE email_hash = ANY($1::text[])", [[...everyone, pc].map(mail.hashAddress)]);
  await db.query("DELETE FROM email_consents WHERE email_hash = ANY($1::text[])", [[...everyone, pc].map(mail.hashAddress)]);
  await db.query("DELETE FROM access_requests WHERE id = ANY($1::int[])", [created.requests]);
  await db.query("DELETE FROM organizations WHERE id = ANY($1::int[])", [created.orgs]);
  await settings.setSettings("smoke", { EMAIL_INBOUND_ADDRESS: null });
  await kvm.deleteCredential(hookCred.id);
  await kvm.deleteCredential(apolloCred.id);
  delete process.env.APOLLO_API_URL; delete process.env.APOLLO_MIN_GAP_MS; delete process.env.CAMPAIGN_SEND_INTERVAL_MS;
  console.log("✓ GTM phase 2: companies and prospects (dedupe, CSV import with dry run, lawful basis, suppression, EU rule), Apollo (disabled without a key, search, cache, enrich, freshness, credits, 429), sender identities off the product domain, warm-up cap across campaigns, cold-email rules, text only, replies and quick actions, bounces, auto-linking sign-ups, deals (board, stages, revenue), outbound attribution (first touch), addresses only in their tables");
}
