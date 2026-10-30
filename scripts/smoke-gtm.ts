// GTM checks for scripts/smoke.ts (Activation, Attribution, Campaigns), kept out of its main body (TypeScript's
// control-flow limit). Runs against the Clerk / Stripe / Resend mock: no real email is ever sent.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";

type Db = { query: <T = any>(sql: string, params?: unknown[]) => Promise<T[]> };

export async function gtmChecks({ db, base, adm, json, mockUrl, mockPost, sentTo, stamp }: {
  db: Db; base: string; adm: (method: string, path: string, body?: unknown) => Promise<Response>; json: (r: Response | Promise<Response>) => Promise<any>;
  mockUrl: string; mockPost: (path: string, body?: unknown) => Promise<any>; sentTo: (to: string, kind?: string) => any[]; stamp: string;
}) {
  const billing = await import("../src/billing.js"), kvm = await import("../src/keyvault.js"), mail = await import("../src/email.js");
  const CAMP = `gtm-${stamp}`, day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const range = `from=${day(7)}&to=${day(0)}`;
  const ann = `ann+${stamp}@gtm-a.dev`, bob = `bob+${stamp}@gtm-b.dev`, cara = `cara+${stamp}@gtm-c.dev`, dana = `dana+${stamp}@gtm-d.dev`;
  // US requesters (Vercel's IP country): outside the countries that need a recorded opt-in, so a campaign that does not require one may write to them.
  const src = (campaign: string) => JSON.stringify({ utm_source: "newsletter", utm_medium: "email", utm_campaign: campaign, country: "US" });
  const req = async (email: string, name: string, company: string, status: string) => (await db.query<{ id: number }>(
    `INSERT INTO access_requests (email, company, name, status, source, created_at, decided_at) VALUES ($1, $2, $3, $4, $5::jsonb, now() - interval '6 days', CASE WHEN $4 = 'approved' THEN now() - interval '5 days' END) RETURNING id`,
    [email, company, name, status, src(CAMP)]))[0].id;
  const org = async (slug: string, extra: { clerk?: string | null; customer?: string | null } = {}) => (await db.query<{ id: number }>(
    "INSERT INTO organizations (slug, name, created_at, clerk_org_id, stripe_customer_id) VALUES ($1, $1, now() - interval '5 days', $2, $3) RETURNING id",
    [slug, extra.clerk ?? null, extra.customer ?? null]))[0].id;
  // A: onboarded 4 days ago, no simulation (needs a person). B: simulated and paying. C: made by hand (no request), with a Clerk member.
  const slugA = `gtm-a-${stamp}`, slugB = `gtm-b-${stamp}`, slugC = `gtm-c-${stamp}`, cusB = `cus_gtm_${stamp}`;
  const clerkOrg = await (await fetch(`${mockUrl}/v1/organizations`, { method: "POST", headers: { authorization: "Bearer sk_test_mock", "content-type": "application/json" },
    body: JSON.stringify({ name: slugC }) })).json();
  const dUser = await mockPost("/_mock/clerk/users", { email: dana, first_name: "Dana" });
  await mockPost("/_mock/clerk/memberships", { org_id: clerkOrg.id, user_id: dUser.id, role: "org:admin" });
  const [oA, oB, oC] = [await org(slugA), await org(slugB, { customer: cusB }), await org(slugC, { clerk: clerkOrg.id })];
  const [rA, rB, rC] = [await req(ann, "Ann Example", "Acme A", "approved"), await req(bob, "Bob Example", "Acme B", "approved"), await req(cara, "Cara Example", "Acme C", "pending")];
  await db.query("UPDATE access_requests SET org_id = $2 WHERE id = $1", [rA, oA]);
  await db.query("UPDATE access_requests SET org_id = $2 WHERE id = $1", [rB, oB]);
  const product = async (o: number, slug: string) => (await db.query<{ id: number }>(
    "INSERT INTO products (org_id, slug, name, created_at) VALUES ($1, $2, $3, now() - interval '4 days') RETURNING id", [o, slug, `Prod ${slug}`]))[0].id;
  const pA = await product(oA, `gtm-pa-${stamp}`), pB = await product(oB, `gtm-pb-${stamp}`);
  const sim = (o: number, p: number, ago: string) => db.query(
    `INSERT INTO simulations (id, org_id, product_id, name, models, harness, repeats, status, created_at) VALUES ($1, $2, $3, 'gtm', '{m}', 'claude-code', 1, 'completed', now() - $4::interval)`,
    [`sim_gtm_${o}_${randomBytes(4).toString("hex")}`, o, p, ago]);
  await sim(oB, pB, "3 days");
  // B opened its report half a day after the simulation, and pays from half a day after that.
  await db.query("INSERT INTO mcp_events (org_id, method, name, ok, at) VALUES ($1, 'tools/call', 'get_visibility_report', true, now() - interval '60 hours')", [oB]);
  await mockPost("/_mock/subscriptions", { customer: cusB, price: "price_mock_starter", start_date: Math.floor(Date.now() / 1000) - 2 * 86_400, invoice: false });
  billing.invalidateSubscriptions();

  // ---------- Activation: one funnel, filters, medians, the people who need a person ----------
  const act = await json(adm("GET", `/gtm/activation?${range}&utm_campaign=${CAMP}`));
  const step = (id: string) => act.steps.find((s: any) => s.id === id);
  assert.deepEqual(act.steps.map((s: any) => s.id), ["requested", "created", "onboarded", "simulated", "reported", "paid"], "the canonical steps, in order");
  assert.deepEqual(act.steps.map((s: any) => s.reached), [3, 2, 2, 1, 1, 1], `counts for the campaign's cohort: ${JSON.stringify(act.steps.map((s: any) => s.reached))}`);
  assert.ok(act.steps.every((s: any, i: number) => i < 2 || s.reached <= act.steps[i - 1].reached) && act.paid_any === 1, "nested: each step a subset of the one before");
  assert.equal(step("reported").median_hours, 12, "half a day from simulation to report");
  assert.equal(step("paid").median_hours, 12, "and from report to payment");
  assert.equal(step("created").pct_of_previous, 66.7, "conversion from the step before");
  assert.equal(step("simulated").pct_of_first, 33.3, "and from the first");
  assert.equal(step("created").median_hours, 24, "a day from request to account");
  assert.equal(step("onboarded").median_hours, 24, "a day from account to product");
  assert.equal(step("simulated").median_hours, 24, "a day from product to simulation");
  assert.ok(act.cohort.every((c: any) => c.utm.campaign === CAMP) && act.cohort.length === 2, "the UTM filter narrows the cohort");
  const stuck = act.attention.find((o: any) => o.slug === slugA);
  assert.ok(stuck && stuck.attention.includes("Product onboarded, no simulation yet") && stuck.reached && "stage_index" in stuck, "needs a person: admin's own reasons, full account rows for the peek");
  assert.ok(act.attention.every((o: any) => o.utm.campaign === CAMP), "attention follows the UTM filter");
  assert.ok(act.facets.utm_campaigns[CAMP] === 3 && act.facets.utm_sources.newsletter >= 3, "facets count requests per tag");
  const planNone = await json(adm("GET", `/gtm/activation?${range}&utm_campaign=${CAMP}&plan=none`));
  assert.ok(!planNone.cohort.some((c: any) => c.slug === slugB) && planNone.cohort.some((c: any) => c.slug === slugA), "the plan filter (B pays, so it is not on 'none')");
  // Same cohort rule as the Overview funnel (admin.funnelOf), unfiltered.
  const [all, ov] = await Promise.all([json(adm("GET", `/gtm/activation?${range}`)), json(adm("GET", `/overview?${range}`))]);
  for (const id of ["created", "onboarded", "simulated", "reported"])
    assert.equal(all.steps.find((s: any) => s.id === id).reached, ov.funnel.find((f: any) => f.id === id).reached, `${id} matches the Overview funnel`);
  const an = await json(adm("GET", `/analytics?${range}`));
  assert.ok(!("funnel" in an.growth), "Analytics no longer has its own activation funnel");

  // ---------- Attribution: by UTM, to MRR; direct/unknown; rows carry their accounts ----------
  const att = await json(adm("GET", `/gtm/attribution?${range}`));
  const row = att.rows.find((r: any) => r.utm_campaign === CAMP);
  assert.ok(row && row.utm_source === "newsletter" && row.utm_medium === "email", "one row per source / medium / campaign");
  assert.deepEqual([row.requests, row.approved, row.accounts, row.activated, row.paying, row.mrr_usd], [3, 2, 2, 1, 1, 499], `the row: ${JSON.stringify(row)}`);
  assert.deepEqual(row.account_list.map((a: any) => a.slug).sort(), [slugA, slugB].sort(), "a click opens these accounts");
  const direct = att.rows.find((r: any) => r.utm_source === "direct/unknown" && r.account_list.some((a: any) => a.slug === slugC));
  assert.ok(direct, "an account made by hand lands in direct/unknown");
  assert.ok(att.totals.mrr_usd >= 499 && att.totals.requests >= 3, "totals");

  // ---------- Campaigns ----------
  process.env.CAMPAIGN_SEND_INTERVAL_MS = "0";
  const audience = { include: "both", utm_campaign: CAMP };
  const steps = [{ subject: "Hi {{first_name}}", body: "Run your first simulation on {{product}}: https://octillion.test/app", delay_days: 0 },
    { subject: "Still there, {{first_name}}?", body: "One more nudge about {{product}}.", delay_days: 2 }];
  assert.equal((await adm("POST", "/gtm/campaigns", { name: "x", audience, steps: [{ subject: "Hi {{nickname}}", body: "x" }] })).status, 400, "unknown variables are refused");
  assert.equal((await adm("POST", "/gtm/campaigns", { name: "x", audience: { stages: ["nope"] }, steps })).status, 400, "unknown stages are refused");
  const pv = await json(adm("POST", "/gtm/audience/preview", { audience }));
  assert.equal(pv.count, 3, `accounts' requesters (no Clerk people) and the pending requester, once each: ${JSON.stringify(pv.sample)}`);
  const pvStage = await json(adm("POST", "/gtm/audience/preview", { audience: { include: "accounts", stages: ["onboarded"], utm_campaign: CAMP } }));
  assert.deepEqual(pvStage.sample.map((s: any) => [s.email, s.first_name, s.product]), [[ann, "Ann", `Prod gtm-pa-${stamp}`]], "a stage audience");
  const pvClerk = await json(adm("POST", "/gtm/audience/preview", { audience: { include: "accounts", accounts: [slugC] } }));
  assert.deepEqual(pvClerk.sample.map((s: any) => [s.email, s.first_name, s.source]), [[dana, "Dana", "account"]], "an account's active Clerk members");
  // Bob is on the suppression list already: never sent, whatever the campaign.
  await db.query("INSERT INTO email_suppressions (email_hash, reason) VALUES ($1, 'manual')", [mail.hashAddress(bob)]);
  assert.equal((await json(adm("POST", "/gtm/audience/preview", { audience }))).suppressed, 1, "the preview counts the suppressed");

  const created = await json(adm("POST", "/gtm/campaigns", { name: `Activation nudge ${stamp}`, audience, steps, conversion_days: 14, requires_opt_in: false }));
  const id = created.campaign.id;
  assert.ok(created.campaign.status === "draft" && created.campaign.owner === "token:smoke", "a draft, owned by whoever made it");
  // Test send to an address typed in: rendered for a real match, marked as a test, with the unsubscribe headers.
  const tester = `gtm-test+${stamp}@gtm-test.dev`;
  assert.equal((await adm("POST", `/gtm/campaigns/${id}/test`, { to: "nope" })).status, 400);
  const t = await json(adm("POST", `/gtm/campaigns/${id}/test`, { to: tester, step: 0 }));
  assert.equal(t.status, "sent");
  const te = sentTo(tester, "campaign_test")[0];
  assert.ok(te && te.subject.startsWith("[Test] Hi ") && te.headers?.["List-Unsubscribe"]?.includes("/api/email/unsubscribe?t=test") && te.headers?.["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click",
    `test email: ${JSON.stringify(te)}`);
  assert.equal(await (await fetch(`${base}/api/email/unsubscribe?t=test`)).status, 200, "the test link says it was a test");

  // Launch: enrolled now; one send per tick when the rate limit says so; never twice.
  process.env.CAMPAIGN_SENDS_PER_TICK = "1";
  const launched = await json(adm("POST", `/gtm/campaigns/${id}/launch`, {}));
  assert.equal(launched.campaign.status, "running");
  assert.equal((await adm("PUT", `/gtm/campaigns/${id}`, { name: "x" })).status, 409, "a running campaign is paused before editing");
  const recips = async () => (await json(adm("GET", `/gtm/campaigns/${id}`))).recipients as any[];
  const r0 = await recips();
  assert.deepEqual(r0.map((r: any) => [r.email, r.status]).sort(), [[ann, "pending"], [bob, "suppressed"], [cara, "pending"]].sort(), "enrolled; the suppressed one is recorded, not queued");
  const tick1 = await json(adm("POST", "/gtm/tick"));
  assert.equal(tick1.sent, 1, `rate-limited to one: ${JSON.stringify(tick1)}`);
  process.env.CAMPAIGN_SENDS_PER_TICK = "100";
  await json(adm("POST", "/gtm/tick"));
  await json(adm("POST", "/gtm/tick"));
  assert.ok(sentTo(ann, "campaign").length === 1 && sentTo(cara, "campaign").length === 1 && sentTo(bob, "campaign").length === 0, "one each, none to the suppressed");
  const ea = sentTo(ann, "campaign")[0];
  assert.ok(ea.subject === "Hi Ann" && ea.text.includes(`Prod gtm-pa-${stamp}`) && /Unsubscribe: http\S+\/api\/email\/unsubscribe\?t=\d+\.[\w-]{32}/.test(ea.text), `rendered with the footer: ${ea.text}`);
  assert.ok(ea.headers["List-Unsubscribe"].startsWith("<") && ea.headers["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click", "List-Unsubscribe headers");
  assert.ok(ea.idempotency_key.startsWith(`campaign:${id}:`), "Resend gets an idempotency key naming the campaign, person and step");
  // A tick that died after sending but before moving on: the next one sees the send and only moves on.
  const annRow = (await recips()).find((r: any) => r.email === ann);
  await db.query("UPDATE gtm_campaign_recipients SET next_step = 0, status = 'pending', next_at = now() WHERE id = $1", [annRow.id]);
  await json(adm("POST", "/gtm/tick"));
  assert.equal(sentTo(ann, "campaign").length, 1, "no double send");
  assert.equal((await recips()).find((r: any) => r.email === ann).next_step, 1, "moved on to step 2");

  // Unsubscribe: GET asks, POST (one-click too) does it; a forged token does nothing.
  const link = /Unsubscribe: (\S+)/.exec(sentTo(cara, "campaign")[0].text)![1].replace(/^https?:\/\/[^/]+/, base);
  const ask = await fetch(link);
  assert.ok(ask.status === 200 && (await ask.text()).includes("<form method=\"post\""), "GET shows a confirm button (link scanners unsubscribe nobody)");
  assert.equal((await recips()).find((r: any) => r.email === cara).status, "active", "still subscribed after a GET");
  assert.equal((await fetch(link.replace(/\.[\w-]{32}$/, ".AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), { method: "POST" })).status, 400, "a forged token is refused");
  const oneClick = await fetch(link, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
  assert.ok(oneClick.status === 200 && (await oneClick.text()).includes("unsubscribed"), "RFC 8058 one-click");
  assert.equal((await recips()).find((r: any) => r.email === cara).status, "unsubscribed");
  assert.equal((await db.query("SELECT 1 FROM email_suppressions WHERE email_hash = $1 AND reason = 'unsubscribed'", [mail.hashAddress(cara)])).length, 1, "and suppressed for every campaign");

  // Step 2 when its delay is up; then the campaign is done.
  await db.query("UPDATE gtm_campaign_recipients SET next_at = now() - interval '1 second' WHERE campaign_id = $1 AND status = 'active'", [id]);
  await json(adm("POST", "/gtm/tick"));
  assert.ok(sentTo(ann, "campaign").length === 2 && sentTo(ann, "campaign")[1].subject === "Still there, Ann?" && sentTo(cara, "campaign").length === 1, "step 2 to Ann; nothing to the unsubscribed");
  assert.equal((await json(adm("GET", `/gtm/campaigns/${id}`))).campaign.status, "done", "everyone done: the campaign is done");

  // Resend webhooks: Svix-signed with the vault's secret; delivered and opened recorded, a hard bounce suppresses.
  const hook = (body: unknown, secret: string, opts: { ts?: number } = {}) => {
    const raw = JSON.stringify(body), sid = `msg_${randomBytes(6).toString("hex")}`, ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64")).update(`${sid}.${ts}.${raw}`).digest("base64");
    return fetch(`${base}/api/webhooks/resend`, { method: "POST", headers: { "content-type": "application/json", "svix-id": sid, "svix-timestamp": ts, "svix-signature": `v1,${sig}` }, body: raw });
  };
  const whsec = `whsec_${randomBytes(24).toString("base64")}`;
  const annPid = (await db.query<{ provider_id: string }>("SELECT s.provider_id FROM gtm_campaign_sends s JOIN gtm_campaign_recipients r ON r.id = s.recipient_id WHERE r.email = $1 AND s.step = 0", [ann]))[0].provider_id;
  assert.ok(annPid, "the send keeps Resend's id");
  assert.equal((await hook({ type: "email.delivered", data: { email_id: annPid } }, whsec)).status, 503, "no secret in the vault: not set up");
  const cred = await kvm.setCredential("resend_webhook", whsec);
  assert.equal((await hook({ type: "email.delivered", data: { email_id: annPid } }, `whsec_${randomBytes(24).toString("base64")}`)).status, 401, "a wrong signature is refused");
  assert.equal((await hook({ type: "email.delivered", data: { email_id: annPid } }, whsec, { ts: Math.floor(Date.now() / 1000) - 3600 })).status, 401, "an old timestamp is refused");
  assert.equal((await json(hook({ type: "email.delivered", created_at: new Date().toISOString(), data: { email_id: annPid } }, whsec))).matched, true);
  await json(hook({ type: "email.opened", data: { email_id: annPid } }, whsec));
  await json(hook({ type: "email.clicked", data: { email_id: annPid } }, whsec));
  assert.equal((await json(hook({ type: "email.delivered", data: { email_id: "not-ours" } }, whsec))).matched, false, "other emails are acknowledged, not recorded");

  // Conversions within conversion_days of the first email: Ann's account runs its first simulation now (activated).
  await sim(oA, pA, "0 seconds");
  const d = await json(adm("GET", `/gtm/campaigns/${id}`));
  const m = d.campaign.metrics;
  assert.deepEqual([m.recipients, m.suppressed, m.unsubscribed, m.sent, m.delivered, m.opened, m.clicked], [3, 1, 1, 3, 1, 1, 1], `metrics: ${JSON.stringify(m)}`);
  assert.ok(d.conversions.activated === 1 && d.conversions.days === 14 && d.recipients.find((r: any) => r.email === ann).activated, `conversions: ${JSON.stringify(d.conversions)}`);
  assert.ok(d.steps[0].sent === 2 && d.steps[1].sent === 1, "per-step sends");
  const list = await json(adm("GET", "/gtm/campaigns"));
  assert.ok(list.campaigns.some((c: any) => c.id === id && c.metrics.sent === 3 && c.conversions.activated === 1) && list.variables.includes("first_name"), "the list carries the metrics");
  // An Undetermined bounce is recorded but does not suppress (once); a Permanent one does.
  await json(hook({ type: "email.bounced", data: { email_id: annPid, bounce: { type: "Undetermined" } } }, whsec));
  assert.equal((await db.query("SELECT 1 FROM email_suppressions WHERE email_hash = $1", [mail.hashAddress(ann)])).length, 0, "one undetermined bounce: not suppressed");
  await json(hook({ type: "email.bounced", data: { email_id: annPid, bounce: { type: "Permanent" } } }, whsec));
  assert.equal((await db.query("SELECT 1 FROM email_suppressions WHERE email_hash = $1 AND reason = 'bounced'", [mail.hashAddress(ann)])).length, 1, "bounced: suppressed");
  await kvm.deleteCredential(cred.id);

  // Variables are plain text: never a link, capped, a first name is one word.
  const camp = await import("../src/campaigns.js");
  const html = camp.renderHtml("Hi {{first_name}}, about {{product}}: https://octillion.test/app", { first_name: "<b>Eve</b> x", product: "https://evil.example/" + "x".repeat(200) });
  assert.ok(html.includes("Hi there,") && !html.includes("evil.example/x") && html.includes("https:/&#8204;") === false && !/href="https:\/\/evil/.test(html) && html.includes('href="https://octillion.test/app"'),
    `variables are escaped text, never linked: ${html}`);
  assert.equal(camp.safeVars({ first_name: "Zoë-Ann Smith", product: "Line\nbreak" }).first_name, "Zoë-Ann");
  assert.equal(camp.safeVars({ product: "p".repeat(200) }).product.length, 80);
  assert.ok((await db.query("SELECT 1 FROM vault_credentials WHERE provider = 'email_unsubscribe' AND label = 'generated'")).length === 1, "the unsubscribe key is its own vault secret");

  // Pause or delete mid-batch: nothing more goes out. Sends are spaced so the change lands between two.
  const CB = `${CAMP}-b`, eve = `eve+${stamp}@gtm-e.dev`, fay = `fay+${stamp}@gtm-f.dev`;
  const rE = (await db.query<{ id: number }>("INSERT INTO access_requests (email, company, name, source) VALUES ($1, 'Eve Co', 'Eve', $2::jsonb) RETURNING id", [eve, src(CB)]))[0].id;
  const rF = (await db.query<{ id: number }>("INSERT INTO access_requests (email, company, name, source) VALUES ($1, 'Fay Co', 'Fay', $2::jsonb) RETURNING id", [fay, src(CB)]))[0].id;
  const sentFor = (cid: number) => [eve, fay].flatMap((e) => sentTo(e, "campaign")).filter((e: any) => e.tags?.some((t: any) => t.name === "campaign" && t.value === String(cid))).length;
  const waitFor = async (ok: () => boolean, what: string) => { for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(ok(), what); };
  const mk = async (name: string) => {
    const cidN = (await json(adm("POST", "/gtm/campaigns", { name, audience: { include: "requests", utm_campaign: CB }, steps: [steps[0]], requires_opt_in: false }))).campaign.id;
    await json(adm("POST", `/gtm/campaigns/${cidN}/launch`, {}));
    return cidN as number;
  };
  // One email per Resend request here, so a pause between two requests lands between two people.
  process.env.CAMPAIGN_SEND_INTERVAL_MS = "1500"; process.env.CAMPAIGN_BATCH_SIZE = "1";
  const p1 = await mk(`Pause ${stamp}`);
  const batch1 = json(adm("POST", "/gtm/tick"));
  await waitFor(() => sentFor(p1) === 1, "the first email of the batch went out");
  await json(adm("POST", `/gtm/campaigns/${p1}/pause`));
  const t1 = await batch1;
  assert.ok(sentFor(p1) === 1 && t1.deferred >= 1 && !t1.error, `paused mid-batch: nothing more sent (${JSON.stringify(t1)})`);
  assert.equal((await adm("POST", "/gtm/tick")).status, 200, "the lease was given back");
  assert.equal(sentFor(p1), 1, "still nothing while paused");
  await json(adm("POST", `/gtm/campaigns/${p1}/resume`));
  process.env.CAMPAIGN_SEND_INTERVAL_MS = "0";
  await json(adm("POST", "/gtm/tick"));
  assert.equal(sentFor(p1), 2, "resumed: the one held back goes out");
  process.env.CAMPAIGN_SEND_INTERVAL_MS = "1500";
  const p2 = await mk(`Deleted ${stamp}`);
  const batch2 = json(adm("POST", "/gtm/tick"));
  await waitFor(() => sentFor(p2) === 1, "the first email of the second batch went out");
  await db.query("DELETE FROM gtm_campaigns WHERE id = $1", [p2]);
  const t2 = await batch2;
  assert.ok(sentFor(p2) === 1 && !t2.error, `deleted mid-batch: the tick carries on without error (${JSON.stringify(t2)})`);
  process.env.CAMPAIGN_SEND_INTERVAL_MS = "0";
  assert.ok(!(await json(adm("POST", "/gtm/tick"))).busy, "and gives its lease back");
  delete process.env.CAMPAIGN_BATCH_SIZE;

  // Send now (the Activation nudge): this campaign's own result. A Clerk member of C gets it.
  const p3 = (await json(adm("POST", "/gtm/campaigns", { name: `Nudge ${stamp}`, audience: { include: "accounts", accounts: [slugC] }, steps: [steps[0]] }))).campaign.id;
  await json(adm("POST", `/gtm/campaigns/${p3}/launch`, {}));
  const sn = await json(adm("POST", `/gtm/campaigns/${p3}/send-now`));
  assert.ok(sn.sent === 1 && sn.sent_now === 1 && sn.waiting === 0 && sentTo(dana, "campaign").length === 1, `send now reports its own campaign: ${JSON.stringify(sn)}`);
  // Resend down (a 5xx): Resend may have failed after sending, so the email is uncertain: replayed later as the very
  // same request (its own idempotency key), never as a new one, and never counted as a failure.
  const p4 = (await json(adm("POST", "/gtm/campaigns", { name: `Outage ${stamp}`, audience: { include: "accounts", accounts: [slugC] }, steps: [steps[0]] }))).campaign.id;
  await json(adm("POST", `/gtm/campaigns/${p4}/launch`, {}));
  await mockPost("/_mock/resend/outage", { down: true });
  const down = await json(adm("POST", `/gtm/campaigns/${p4}/send-now`));
  await mockPost("/_mock/resend/outage", { down: false });
  const [held] = await db.query<{ attempts: number; status: string }>("SELECT s.attempts, s.status FROM gtm_campaign_sends s WHERE s.campaign_id = $1", [p4]);
  assert.ok(down.sent === 0 && down.waiting === 1 && down.failed === 0 && down.uncertain === 1 && held.status === "uncertain", `a 5xx is uncertain and waits: ${JSON.stringify({ down, held })}`);
  await db.query("UPDATE gtm_campaign_recipients SET next_at = now() WHERE campaign_id = $1", [p4]);
  assert.equal((await json(adm("POST", `/gtm/campaigns/${p4}/send-now`))).sent, 1, "and goes out once Resend is back");
  // OCTILLION_CAMPAIGNS=off stops the tick everywhere (the Vercel cron calls the same function).
  process.env.OCTILLION_CAMPAIGNS = "off";
  assert.match((await json(adm("POST", "/gtm/tick"))).skipped, /OCTILLION_CAMPAIGNS=off/);
  delete process.env.OCTILLION_CAMPAIGNS;

  // Lifecycle: pause / edit / resume / end / delete.
  const second = (await json(adm("POST", "/gtm/campaigns", { name: `Later ${stamp}`, audience: { include: "requests", request_status: ["pending"], utm_campaign: CAMP }, steps }))).campaign.id;
  const sched = await json(adm("POST", `/gtm/campaigns/${second}/launch`, { at: new Date(Date.now() + 86_400_000).toISOString() }));
  assert.equal(sched.campaign.status, "scheduled", "a future start is scheduled, not enrolled");
  assert.equal((await json(adm("POST", `/gtm/campaigns/${second}/pause`))).campaign.status, "paused");
  assert.equal((await json(adm("PUT", `/gtm/campaigns/${second}`, { name: `Later ${stamp} v2` }))).campaign.name, `Later ${stamp} v2`, "a paused one can be edited");
  assert.equal((await adm("DELETE", `/gtm/campaigns/${second}`)).status, 409, "end it before deleting");
  const resumed = await json(adm("POST", `/gtm/campaigns/${second}/resume`));
  assert.ok(resumed.campaign.status === "running" && resumed.recipients.every((r: any) => r.email !== cara || r.status === "suppressed"), "resumed; the unsubscribed requester is suppressed here too");
  assert.equal((await json(adm("POST", `/gtm/campaigns/${second}/end`))).campaign.status, "done");
  assert.equal((await adm("DELETE", `/gtm/campaigns/${second}`)).status, 204);

  // Addresses live only in gtm_campaign_recipients: email_log has the domain, suppressions a hash.
  const elsewhere = JSON.stringify(await db.query("SELECT * FROM email_log WHERE kind IN ('campaign', 'campaign_test')"))
    + JSON.stringify(await db.query("SELECT * FROM email_suppressions")) + JSON.stringify(await db.query("SELECT * FROM gtm_campaign_sends")) + JSON.stringify(await db.query("SELECT * FROM gtm_campaigns"));
  for (const a of [ann, bob, cara, tester, eve, fay, dana]) assert.ok(!elsewhere.includes(a), `no address outside the recipients table: ${a}`);
  assert.ok((await db.query("SELECT 1 FROM email_log WHERE kind = 'campaign' AND to_domain = 'gtm-a.dev'")).length >= 2, "the email log keeps the domain");

  await adm("POST", `/gtm/campaigns/${id}/end`).catch(() => {});
  await db.query("DELETE FROM gtm_campaigns WHERE id = ANY($1::bigint[])", [[id, p1, p3, p4]]);
  await db.query("DELETE FROM email_suppressions WHERE email_hash = ANY($1::text[])", [[ann, bob, cara].map(mail.hashAddress)]);
  await db.query("DELETE FROM access_requests WHERE id = ANY($1::int[])", [[rA, rB, rC, rE, rF]]);
  await db.query("DELETE FROM organizations WHERE id = ANY($1::int[])", [[oA, oB, oC]]);
  delete process.env.CAMPAIGN_SEND_INTERVAL_MS;
  delete process.env.CAMPAIGN_SENDS_PER_TICK;
  console.log("✓ GTM: Activation funnel (filters, medians, attention), Attribution by UTM to MRR, Campaigns (audience, test send, rate-limited idempotent sends, pause or delete mid-batch, transient retries, send now, unsubscribe, suppression, Resend webhooks, conversions)");
  // Phase 1: replies, triggers, A/B variants, send windows, consent, the postal address, batch sending (scripts/smoke-gtm-phase1.ts).
  await (await import("./smoke-gtm-phase1.js")).gtmPhase1Checks({ db, base, adm, json, mockUrl, mockPost, sentTo, stamp });
}
