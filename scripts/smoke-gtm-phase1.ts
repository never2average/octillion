// GTM phase 1 checks (scripts/smoke-gtm.ts runs them after its own): replies stop a sequence, event-triggered campaigns,
// A/B variants, send windows in the recipient's time zone, marketing consent, the optional postal address, and batch
// sending under Resend's rate limit. Against the Resend mock only: no real email is ever sent.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";

type Db = { query: <T = any>(sql: string, params?: unknown[]) => Promise<T[]> };

export async function gtmPhase1Checks({ db, base, adm, json, mockUrl, mockPost, sentTo, stamp }: {
  db: Db; base: string; adm: (method: string, path: string, body?: unknown) => Promise<Response>; json: (r: Response | Promise<Response>) => Promise<any>;
  mockUrl: string; mockPost: (path: string, body?: unknown) => Promise<any>; sentTo: (to: string, kind?: string) => any[]; stamp: string;
}) {
  const mail = await import("../src/email.js"), camp = await import("../src/campaigns.js"), kvm = await import("../src/keyvault.js");
  const settings = await import("../src/settings.js"), sched = await import("../src/gtm-schedule.js"), consent = await import("../src/gtm-consent.js");
  const rep = await import("../src/gtm-replies.js"), ev = await import("../src/gtm-events.js");
  const S = `p1-${stamp}`;
  const tick = () => json(adm("POST", "/gtm/tick"));
  const waitFor = async (ok: () => boolean | Promise<boolean>, what: string) => { for (let i = 0; i < 400 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 25)); assert.ok(await ok(), what); };
  const step = (subject: string, body = "Hello {{first_name}}, about {{product}}.", delay_days = 0) => ({ subject, body, delay_days });
  // A requester (country from Vercel's IP header) under this run's UTM campaign tag.
  const request = async (email: string, campaign: string, country: string | null, extra: { status?: string; org_id?: number; ago?: string } = {}) => (await db.query<{ id: number }>(
    `INSERT INTO access_requests (email, company, name, status, org_id, source, created_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, now() - $7::interval) RETURNING id`,
    [email, `Co ${email.split("@")[0]}`, email.split(/[+@]/)[0], extra.status ?? "pending", extra.org_id ?? null,
     JSON.stringify({ utm_source: "p1", utm_campaign: campaign, ...(country ? { country } : {}) }), extra.ago ?? "1 minute"]))[0].id;
  const create = async (body: Record<string, unknown>) => (await json(adm("POST", "/gtm/campaigns", { conversion_days: 14, ...body }))).campaign.id as number;
  const launch = (id: number) => json(adm("POST", `/gtm/campaigns/${id}/launch`, {}));
  const detail = (id: number) => json(adm("GET", `/gtm/campaigns/${id}`));
  const tagged = (cid: number) => (e: any) => e.tags?.some((t: any) => t.name === "campaign" && t.value === String(cid));
  const created: number[] = [], requests: number[] = [], orgs: number[] = [], unPeople: string[] = [];
  process.env.CAMPAIGN_SEND_INTERVAL_MS = "0";

  // ---------- postal address: optional; in the footer only when set; never refuses a launch ----------
  assert.equal((await adm("PUT", "/compute/settings", { values: { EMAIL_POSTAL_ADDRESS: "<b>1 Main St</b>" } })).status, 400, "markup is refused in the postal address");
  await settings.setSettings("smoke", { EMAIL_POSTAL_ADDRESS: null });
  const list0 = await json(adm("GET", "/gtm/campaigns"));
  assert.ok(list0.setup.postal_address_set === false && /CAN-SPAM/.test(list0.setup.postal_hint), "no address: a hint, not an error");
  const pa = `pa+${stamp}@p1-a.dev`;
  requests.push(await request(pa, `${S}-pa`, "US"));
  const cPa = await create({ name: `Postal ${stamp}`, audience: { include: "requests", utm_campaign: `${S}-pa` }, steps: [step("Postal check")], requires_opt_in: false });
  created.push(cPa);
  const tPa = await json(adm("POST", `/gtm/campaigns/${cPa}/test`, { to: `t+${stamp}@p1-test.dev` }));
  assert.ok(tPa.status === "sent" && tPa.warnings.some((w: string) => /postal address/i.test(w)), "a test send warns that no postal address is set");
  assert.equal((await launch(cPa)).campaign.status, "running", "launching with no postal address is allowed");
  await tick();
  assert.ok(sentTo(pa, "campaign").length === 1 && !/\n[^\n]*Main St/.test(sentTo(pa, "campaign")[0].text), "sent, without an address line");
  const ADDRESS = "Octillion Test Co, 1 Example Way, Testville";
  await settings.setSettings("smoke", { EMAIL_POSTAL_ADDRESS: ADDRESS });
  const tPa2 = await json(adm("POST", `/gtm/campaigns/${cPa}/test`, { to: `t2+${stamp}@p1-test.dev` }));
  assert.ok(tPa2.warnings.length === 0 && sentTo(`t2+${stamp}@p1-test.dev`, "campaign_test")[0].text.endsWith(ADDRESS), "set: the footer ends with it");

  // ---------- consent: double opt-in from the form, the EU / unknown-country rule, requires opt-in, withdrawal ----------
  const optDe = `de+${stamp}@p1-c.dev`, noDe = `de2+${stamp}@p1-c.dev`, us = `us+${stamp}@p1-c.dev`, unk = `unk+${stamp}@p1-c.dev`;
  const form = (email: string, country: string, body: Record<string, unknown>) => fetch(`${base}/api/access-requests`, { method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, "x-vercel-ip-country": country },
    body: JSON.stringify({ email, company: `Consent ${stamp}`, source: { utm_source: "p1", utm_campaign: `${S}-c` }, ...body }) });
  const confirmations = (to: string) => sentTo(to, "marketing_confirm");
  assert.equal((await form(optDe, "DE", { marketing_opt_in: true, marketing_wording: consent.OPT_IN_VERSION })).status, 201);
  assert.equal((await form(noDe, "DE", {})).status, 201, "unticked (the default)");
  requests.push(...(await db.query<{ id: number }>("SELECT id FROM access_requests WHERE email = ANY($1::text[])", [[optDe, noDe]])).map((r) => r.id));
  requests.push(await request(us, `${S}-c`, "US"), await request(unk, `${S}-c`, null));
  assert.ok(!process.env.VERCEL && (await db.query<any>("SELECT source FROM access_requests WHERE email = $1", [optDe]))[0].source.country === undefined,
    "off Vercel, a client's x-vercel-ip-country is not trusted: the country is unknown");
  // The tick is pending, and one confirmation email goes out; it is not an opt-in yet.
  const [pend] = await db.query<any>("SELECT * FROM email_consents WHERE email_hash = $1", [mail.hashAddress(optDe)]);
  assert.ok(pend && pend.basis === "opt_in_pending" && pend.source === "access_request_form" && pend.wording_version === consent.OPT_IN_VERSION, `pending until confirmed: ${JSON.stringify(pend)}`);
  assert.equal((await db.query("SELECT 1 FROM email_consents WHERE email_hash = $1", [mail.hashAddress(noDe)])).length, 0, "an unticked box records nothing");
  await waitFor(() => confirmations(optDe).length === 1, "one confirmation email");
  assert.equal(confirmations(noDe).length, 0, "none without the tick");
  await waitFor(async () => (await db.query("SELECT 1 FROM gtm_events WHERE type = 'request_submitted' AND request_id = ANY($1::int[])", [requests.slice(-4, -2)])).length === 2,
    "submitting the form emits request_submitted");
  const audC = { include: "requests", utm_campaign: `${S}-c` };
  const pv0 = await json(adm("POST", "/gtm/audience/preview", { audience: audC }));
  assert.ok(pv0.sendable === 0 && pv0.sample.find((s: any) => s.email === optDe).consent === "needs_opt_in", "a pending opt-in is no opt-in");
  // A second tick within a day: still pending, no second email (one a day an address).
  assert.equal((await form(optDe, "DE", { marketing_opt_in: true, marketing_wording: consent.OPT_IN_VERSION })).status, 201);
  requests.push((await db.query<{ id: number }>("SELECT max(id) AS id FROM access_requests WHERE email = $1", [optDe]))[0].id);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(confirmations(optDe).length, 1, "rate-limited: one confirmation an address in 24 hours");
  // Two submissions at once: one email between them (the day's key is claimed atomically).
  const race = `race+${stamp}@p1-c.dev`;
  await Promise.all([1, 2].map(() => consent.recordFormOptIn(race, { opt_in: true, wording_version: consent.OPT_IN_VERSION, country: null, request_id: requests[0] })));
  await waitFor(() => confirmations(race).length >= 1, "a confirmation for the racing pair");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(confirmations(race).length, 1, "exactly one, however the two raced");
  // The link: GET asks (scanners confirm nothing), a forged token does nothing, POST confirms.
  const confirmLink = /confirm here: (\S+)/.exec(confirmations(optDe)[0].text)![1].replace(/^https?:\/\/[^/]+/, base);
  const askC = await fetch(confirmLink);
  assert.ok(askC.status === 200 && (await askC.text()).includes('<form method="post"'), "GET asks");
  assert.equal((await db.query<any>("SELECT basis FROM email_consents WHERE email_hash = $1", [mail.hashAddress(optDe)]))[0].basis, "opt_in_pending", "still pending after a GET");
  assert.equal((await fetch(confirmLink.replace(/\.[\w-]{32}$/, ".AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), { method: "POST" })).status, 400, "a forged link is refused");
  assert.equal((await fetch(confirmLink, { method: "POST" })).status, 200);
  const [row] = await db.query<any>("SELECT * FROM email_consents WHERE email_hash = $1", [mail.hashAddress(optDe)]);
  assert.ok(row.basis === "opt_in" && row.source === "access_request_form_confirmed" && row.wording_version === consent.OPT_IN_VERSION, `confirmed: ${JSON.stringify(row)}`);
  assert.deepEqual((await db.query<any>("SELECT basis FROM email_consent_ledger WHERE email_hash = $1 ORDER BY id", [mail.hashAddress(optDe)])).map((r: any) => r.basis),
    ["opt_in_pending", "opt_in_pending", "opt_in"], "the ledger keeps each tick and the confirmation");
  const pvC = await json(adm("POST", "/gtm/audience/preview", { audience: audC }));
  assert.ok(pvC.requires_opt_in === true && pvC.count === 4 && pvC.no_consent === 3 && pvC.sendable === 1, `requesters need an opt-in by default: ${JSON.stringify({ ...pvC, sample: undefined })}`);
  const pvC2 = await json(adm("POST", "/gtm/audience/preview", { audience: audC, requires_opt_in: false }));
  assert.ok(pvC2.no_consent === 2 && pvC2.sample.find((s: any) => s.email === us).consent === "opt_out" && pvC2.sample.find((s: any) => s.email === unk).consent === "needs_opt_in",
    "without the campaign rule, the EU one still holds, and an unknown country counts as needing an opt-in");
  const cC = await create({ name: `Consent ${stamp}`, audience: audC, steps: [step("Consent check")] });
  created.push(cC);
  await launch(cC);
  assert.deepEqual((await detail(cC)).recipients.map((r: any) => [r.email, r.consent_basis]), [[optDe, "opt_in"]], "only the confirmed opt-in is enrolled");
  const cC2 = await create({ name: `Consent off ${stamp}`, audience: audC, steps: [step("Consent off"), step("Consent off 2", "Again.", 1)], requires_opt_in: false, rolling: true });
  created.push(cC2);
  await launch(cC2);
  assert.deepEqual((await detail(cC2)).recipients.map((r: any) => r.email).sort(), [optDe, us].sort(), "opt-in off: the US requester too, never the EU or unknown ones");
  await tick();
  const link = /Unsubscribe: (\S+)/.exec(sentTo(optDe, "campaign").find(tagged(cC)).text)![1].replace(/^https?:\/\/[^/]+/, base);
  assert.equal((await fetch(link, { method: "POST" })).status, 200);
  const [w] = await db.query<any>("SELECT basis, source FROM email_consents WHERE email_hash = $1", [mail.hashAddress(optDe)]);
  assert.ok(w.basis === "withdrawn" && w.source === "unsubscribe", "unsubscribing withdraws consent");
  // Consent is checked again before each send: a withdrawal recorded since (here without a suppression) stops the next email.
  await consent.recordConsent(us, "withdrawn", { source: "admin" });
  const usSends = () => sentTo(us, "campaign").filter(tagged(cC2)).length;
  const before2 = usSends();
  await db.query("UPDATE gtm_campaign_recipients SET next_at = now() WHERE campaign_id = $1 AND status IN ('pending', 'active')", [cC2]);
  const t2 = await tick();
  const usRow = (await detail(cC2)).recipients.find((r: any) => r.email === us);
  assert.ok(before2 === 1 && usSends() === 1 && usRow.status === "no_consent" && t2.no_consent >= 1, `re-checked before the next send: ${JSON.stringify({ t2, status: usRow.status })}`);
  assert.equal(consent.mayEnrol({ email: optDe, source: "account", country: "US" }, false, { basis: "withdrawn" } as any).ok, false, "withdrawn beats legitimate interest");
  assert.equal(consent.mayEnrol({ email: "x@y.z", source: "account", country: "FR" }, false, undefined).ok, true, "an existing customer under legitimate interest");
  // The form again, unconfirmed: never over the withdrawal, never lifts the suppression.
  await consent.recordFormOptIn(optDe, { opt_in: true, wording_version: consent.OPT_IN_VERSION, country: null, request_id: requests[requests.length - 1] });
  assert.equal((await db.query<any>("SELECT basis FROM email_consents WHERE email_hash = $1", [mail.hashAddress(optDe)]))[0].basis, "withdrawn", "an unconfirmed tick never overrides a withdrawal");
  assert.equal((await db.query("SELECT 1 FROM email_suppressions WHERE email_hash = $1 AND reason = 'unsubscribed'", [mail.hashAddress(optDe)])).length, 1, "nor the suppression");
  // Confirming (a new link, as the person would get a day later): opted in again, and the unsubscribe lifted.
  const fresh = await consent.confirmToken(optDe, { wording_version: consent.OPT_IN_VERSION, country: null, request_id: requests[requests.length - 1] });
  assert.equal((await fetch(`${base}/api/email/confirm?t=${encodeURIComponent(fresh)}`, { method: "POST" })).status, 200);
  assert.equal((await db.query("SELECT 1 FROM email_suppressions WHERE email_hash = $1", [mail.hashAddress(optDe)])).length, 0, "a confirmed opt-in lifts an unsubscribe");
  // A complaint's suppression stays, even confirmed, and such an address gets no confirmation email at all.
  const comp = `comp+${stamp}@p1-c.dev`;
  await db.query("INSERT INTO email_suppressions (email_hash, reason) VALUES ($1, 'complained')", [mail.hashAddress(comp)]);
  assert.equal(await consent.recordFormOptIn(comp, { opt_in: true, wording_version: consent.OPT_IN_VERSION, country: null, request_id: requests[0] }), "blocked", "no confirmation to a complainer");
  await fetch(`${base}/api/email/confirm?t=${encodeURIComponent(await consent.confirmToken(comp, { wording_version: consent.OPT_IN_VERSION, country: null, request_id: requests[0] }))}`, { method: "POST" });
  assert.equal((await db.query("SELECT 1 FROM email_suppressions WHERE email_hash = $1 AND reason = 'complained'", [mail.hashAddress(comp)])).length, 1, "a complaint is never lifted");
  await json(adm("POST", `/gtm/campaigns/${cC2}/end`));
  // ---------- send windows and time zones ----------
  const sat = new Date("2026-10-31T12:00:00Z"); // a Saturday
  const wk = { days: [1, 2, 3, 4, 5], start_hour: 9, end_hour: 17, time_zone: "UTC" };
  const mon = sched.nextOpening(wk, sat, "Europe/Berlin");
  assert.equal(mon.toISOString(), "2026-11-02T08:00:00.000Z", "Saturday noon waits for Monday 09:00 in Berlin (UTC+1 after the clocks change)");
  assert.equal(sched.nextOpening(wk, new Date("2026-11-03T10:00:00Z"), "Europe/Berlin").toISOString(), "2026-11-03T10:00:00.000Z", "inside the window: now");
  assert.equal(sched.nextOpening(wk, new Date("2026-11-03T17:00:00Z"), "Europe/Berlin").toISOString(), "2026-11-04T08:00:00.000Z", "after hours: the next morning");
  assert.equal(sched.nextOpening(wk, new Date("2026-11-03T02:00:00Z"), "Asia/Kolkata").toISOString(), "2026-11-03T03:30:00.000Z", "a half-hour zone opens on its half hour");
  assert.equal(sched.nextOpening({ ...wk, days: [] }, sat, "UTC").getTime(), sat.getTime(), "no window: any time");
  assert.equal(sched.recipientZone("Asia/Tokyo", "US", "UTC"), "Asia/Tokyo", "a stored zone first");
  assert.equal(sched.recipientZone(null, "de", "UTC"), "Europe/Berlin", "else the request's country");
  assert.equal(sched.recipientZone("Not/AZone", null, "America/Chicago"), "America/Chicago", "else the campaign default");
  assert.equal((await adm("POST", "/gtm/campaigns", { name: "x", audience: audC, steps: [step("x")], send_window: { days: [1], start_hour: 18, end_hour: 9 } })).status, 400, "hours must make a window");
  assert.equal((await adm("POST", "/gtm/campaigns", { name: "x", audience: audC, steps: [step("x")], send_window: { days: [1], time_zone: "Mars/Base" } })).status, 400, "and a real time zone");
  const win = `win+${stamp}@p1-w.dev`;
  requests.push(await request(win, `${S}-w`, "US"));
  const nyNow = sched.localParts(new Date(), "America/New_York").day, tomorrow = nyNow === 7 ? 1 : nyNow + 1;
  const cW = await create({ name: `Window ${stamp}`, audience: { include: "requests", utm_campaign: `${S}-w` }, steps: [step("Window check")], requires_opt_in: false,
    send_window: { days: [tomorrow], start_hour: 9, end_hour: 17, time_zone: "UTC" } });
  created.push(cW);
  await launch(cW);
  const tw = await tick();
  const [rw] = (await detail(cW)).recipients;
  const opens = sched.localParts(new Date(rw.next_at), "America/New_York");
  assert.ok(tw.outside_window >= 1 && !sentTo(win, "campaign").length && rw.time_zone === "America/New_York" && opens.day === tomorrow && opens.hour === 9 && opens.minute === 0,
    `quiet hours: waits for 09:00 tomorrow in the recipient's zone (US: New York): ${JSON.stringify({ tw, rw })}`);
  await json(adm("POST", `/gtm/campaigns/${cW}/pause`));
  await json(adm("PUT", `/gtm/campaigns/${cW}`, { send_window: { days: [1, 2, 3, 4, 5, 6, 7], start_hour: 0, end_hour: 24, time_zone: "UTC" } }));
  await json(adm("POST", `/gtm/campaigns/${cW}/resume`));
  await db.query("UPDATE gtm_campaign_recipients SET next_at = now() WHERE campaign_id = $1", [cW]);
  await tick();
  assert.equal(sentTo(win, "campaign").length, 1, "inside the window: sent");

  // ---------- A/B variants and batch sending ----------
  const people = Array.from({ length: 14 }, (_, i) => `ab${i}+${stamp}@p1-ab.dev`);
  for (const p of people) requests.push(await request(p, `${S}-ab`, "US"));
  const variants = [{ subject: "Subject A {{first_name}}", body: "Body A", weight: 50 }, { subject: "Subject B {{first_name}}", body: "", weight: 50 }];
  assert.equal((await adm("POST", "/gtm/campaigns", { name: "x", audience: audC, steps: [{ subject: "s", body: "b", variants: [variants[0]] }] })).status, 400, "one variant is not a test");
  assert.equal((await adm("POST", "/gtm/campaigns", { name: "x", audience: audC, steps: [{ subject: "s", body: "b", variants: variants.map((v) => ({ ...v, weight: 0 })) }] })).status, 400, "weights cannot all be 0");
  const cAb = await create({ name: `AB ${stamp}`, audience: { include: "requests", utm_campaign: `${S}-ab` }, steps: [{ subject: "x", body: "x", delay_days: 0, variants }], requires_opt_in: false, rolling: true });
  created.push(cAb);
  const saved = (await detail(cAb)).campaign.steps[0];
  assert.ok(saved.variants.length === 2 && saved.variants[1].body === "Body A" && saved.subject === "Subject A {{first_name}}", "an empty variant body is variant A's");
  await launch(cAb);
  const batchesBefore = (await (await fetch(`${mockUrl}/_mock/resend/batches`)).json()).batches.length;
  process.env.CAMPAIGN_BATCH_SIZE = "5";
  // Resend rate-limits the first request: the tick waits its retry-after (1 s) and carries on in the same tick.
  await mockPost("/_mock/resend/ratelimit", { count: 1, retry_after: 1 });
  const tAb = await tick();
  const abSent = people.flatMap((p) => sentTo(p, "campaign").filter(tagged(cAb)));
  assert.ok(tAb.sent >= 14 && abSent.length === 14 && tAb.requests >= 4, `batches of 5, past a 429, in one tick: ${JSON.stringify(tAb)}`);
  const batches = (await (await fetch(`${mockUrl}/_mock/resend/batches`)).json()).batches.slice(batchesBefore);
  assert.ok(batches.length >= 3 && batches.every((b: any) => b.size <= 5 && /^batch:[0-9a-f]{48}$/.test(b.key)), `Resend's batch endpoint, one request key per batch: ${JSON.stringify(batches)}`);
  const sends = await db.query<any>("SELECT recipient_id, variant, batch_key, provider_id FROM gtm_campaign_sends WHERE campaign_id = $1", [cAb]);
  assert.ok(sends.length === 14 && sends.every((s: any) => ["A", "B"].includes(s.variant) && s.provider_id), "each send records its variant and Resend's id");
  assert.ok(new Set(sends.map((s: any) => s.variant)).size === 2, `both variants went out: ${sends.map((s: any) => s.variant).join("")}`);
  for (const s of sends) {
    const e = abSent.find((x: any) => x.idempotency_key === s.batch_key && x.subject.startsWith(`Subject ${s.variant}`));
    assert.ok(e, `recipient ${s.recipient_id} got the subject of variant ${s.variant}`);
    assert.equal(camp.pickVariant(saved, cAb, 0, Number(s.recipient_id)).letter, s.variant, "the assignment is deterministic");
  }
  assert.equal((await db.query("SELECT count(*)::int AS n FROM email_log WHERE kind = 'campaign' AND idempotency_key LIKE $1", [`campaign:${cAb}:%`]))[0].n, 14, "each email keeps its own log row and key");
  // The same batch again: every message is a duplicate by its own key, so nothing is sent twice.
  const againMs = [0, 1].map((n) => ({ kind: "campaign" as const, to: people[n], subject: "x", text: "x", idempotencyKey: `campaign:${cAb}:${sends[n].recipient_id}:0` }));
  const again = await mail.sendBatch(againMs, { key: mail.batchKeyOf(againMs.map((m) => m.idempotencyKey)) });
  assert.ok(again.results.every((r) => r.status === "duplicate") && again.request_key === null, "a batch retried after it went out sends nothing (no request at all)");
  // The cap: a tick sends at most CAMPAIGN_SENDS_PER_TICK.
  const capPeople = Array.from({ length: 6 }, (_, i) => `cap${i}+${stamp}@p1-cap.dev`);
  for (const p of capPeople) requests.push(await request(p, `${S}-cap`, "US"));
  const cCap = await create({ name: `Cap ${stamp}`, audience: { include: "requests", utm_campaign: `${S}-cap` }, steps: [step("Cap")], requires_opt_in: false });
  created.push(cCap);
  await launch(cCap);
  process.env.CAMPAIGN_SENDS_PER_TICK = "4";
  assert.equal((await tick()).sent, 4, "four a tick");
  delete process.env.CAMPAIGN_SENDS_PER_TICK;
  assert.equal((await tick()).sent, 2, "the rest on the next");
  delete process.env.CAMPAIGN_BATCH_SIZE;
  // Per-variant numbers: replies and conversions per variant, A as the control; small samples flagged.
  const z = camp.zTest({ x: 20, n: 400 }, { x: 45, n: 400 });
  assert.ok(z.significant && !z.small && z.p! < 0.01 && z.z! > 3, `a clear difference is significant: ${JSON.stringify(z)}`);
  const zs = camp.zTest({ x: 1, n: 7 }, { x: 3, n: 7 });
  assert.ok(zs.small && !zs.significant, "seven sends each: too small to read");
  assert.deepEqual(camp.zTest({ x: 0, n: 0 }, { x: 1, n: 5 }), { z: null, p: null, significant: false, small: true });
  const vd = (await detail(cAb)).steps[0].variant_stats;
  assert.ok(vd.length === 2 && vd[0].sent + vd[1].sent === 14 && vd[0].reply_test === null && vd[1].reply_test.small === true && "conversion_test" in vd[1], `variant stats: ${JSON.stringify(vd)}`);
  const won = await json(adm("POST", `/gtm/campaigns/${cAb}/steps/0/winner`, { variant: "B" }));
  assert.deepEqual(won.campaign.steps[0].variants.map((v: any) => v.weight), [0, 100], "pick winner: B at 100%");
  assert.ok(Array.from({ length: 30 }, (_, i) => camp.pickVariant(won.campaign.steps[0], cAb, 0, 9000 + i).letter).every((l) => l === "B"), "and everyone gets B from now on");
  assert.equal((await adm("POST", `/gtm/campaigns/${cAb}/steps/0/winner`, { variant: "D" })).status, 400, "only an existing variant");

  // ---------- replies stop the sequence ----------
  const INBOX = `replies@reply-${stamp}.octillion.test`;
  await settings.setSettings("smoke", { EMAIL_INBOUND_ADDRESS: INBOX });
  const whsec = `whsec_${randomBytes(24).toString("base64")}`;
  const hookCred = await kvm.setCredential("resend_webhook", whsec);
  const hook = (body: unknown) => {
    const raw = JSON.stringify(body), sid = `msg_${randomBytes(6).toString("hex")}`, ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", Buffer.from(whsec.replace(/^whsec_/, ""), "base64")).update(`${sid}.${ts}.${raw}`).digest("base64");
    return fetch(`${base}/api/webhooks/resend`, { method: "POST", headers: { "content-type": "application/json", "svix-id": sid, "svix-timestamp": ts, "svix-signature": `v1,${sig}` }, body: raw });
  };
  const [ra, rb, rc] = [`ra+${stamp}@p1-r.dev`, `rb+${stamp}@p1-r.dev`, `rc+${stamp}@p1-r.dev`];
  for (const p of [ra, rb, rc]) requests.push(await request(p, `${S}-r`, "US"));
  const cR = await create({ name: `Replies ${stamp}`, audience: { include: "requests", utm_campaign: `${S}-r` }, steps: [step("First"), step("Second", "Following up.", 2)], requires_opt_in: false, rolling: true });
  created.push(cR);
  await launch(cR);
  await tick();
  const first = (to: string) => sentTo(to, "campaign").find(tagged(cR));
  const replyTo = (to: string) => first(to).reply_to[0] as string;
  assert.ok([ra, rb, rc].every((p) => /^replies\+r\d+\.[0-9a-f]{16}@reply-/.test(replyTo(p))), `a per-recipient Reply-To on the replies domain: ${replyTo(ra)}`);
  const received = async (id: string, to: string, extra: { from?: string; subject?: string; text?: string; headers?: Record<string, string> } = {}) => {
    await mockPost("/_mock/resend/received", { id, to: [to], from: extra.from ?? "Person <someone@p1-r.dev>", subject: extra.subject ?? "Re: First", text: extra.text ?? "Sounds good, let's talk.\n\nOn Mon, Octillion wrote:\n> Hello", headers: extra.headers ?? {} });
    return hook({ type: "email.received", created_at: new Date().toISOString(), data: { email_id: id, from: extra.from ?? "someone@p1-r.dev", to: [to], subject: extra.subject ?? "Re: First" } });
  };
  // A person's reply: recorded (snippet without the quoted history), the sequence stopped.
  const rA = await json(received(`in_a_${stamp}`, replyTo(ra), { from: `Ra <${ra}>` }));
  assert.ok(rA.matched && rA.kind === "reply", `matched by the address it was sent to: ${JSON.stringify(rA)}`);
  assert.equal((await json(received(`in_a_${stamp}`, replyTo(ra), { from: `Ra <${ra}>` }))).duplicate, true, "the same inbound email twice is recorded once");
  // An out-of-office: recorded as automatic, the sequence goes on.
  const rB = await json(received(`in_b_${stamp}`, replyTo(rb), { subject: "Automatic reply: First", headers: { "Auto-Submitted": "auto-replied" } }));
  assert.equal(rB.kind, "auto_reply", "Auto-Submitted: an automatic answer");
  // A bounce report and a forged address are not replies at all.
  assert.ok(/delivery report/.test((await json(received(`in_dsn_${stamp}`, replyTo(rc), { from: "MAILER-DAEMON@mx.p1-r.dev", subject: "Undeliverable: First" }))).ignored), "a DSN is ignored here");
  assert.ok(/not addressed/.test((await json(received(`in_forged_${stamp}`, replyTo(rc).replace(/\.[0-9a-f]{16}@/, ".0000000000000000@")))).ignored), "a forged token matches nobody");
  const dR = await detail(cR);
  const byEmail = (e: string) => dR.recipients.find((r: any) => r.email === e);
  assert.ok(byEmail(ra).status === "replied" && byEmail(ra).replied_at && byEmail(ra).next_at === null, "the replier is stopped");
  assert.ok(byEmail(rb).status === "active" && byEmail(rc).status === "active", "an auto-reply and a bounce report stop nothing");
  const yA = dR.replies.replies.find((y: any) => y.email === ra);
  assert.ok(yA && yA.snippet === "Sounds good, let's talk." && yA.from_matches && yA.body.includes("> Hello") && yA.step === 0 && dR.campaign.metrics.replied === 1 && dR.campaign.metrics.replies_open === 1,
    `the reply in the campaign: ${JSON.stringify(yA)}`);
  await db.query("UPDATE gtm_campaign_recipients SET next_at = now() WHERE campaign_id = $1 AND status = 'active'", [cR]);
  await tick();
  assert.ok(sentTo(ra, "campaign").filter(tagged(cR)).length === 1 && sentTo(rb, "campaign").filter(tagged(cR)).length === 2, "step 2 to the auto-replier, never to the person who replied");
  // The inbox: every campaign's, open / handled / automatic, and mark handled.
  const inbox = await json(adm("GET", `/gtm/replies?campaign_id=${cR}&view=open`));
  assert.ok(inbox.inbox === INBOX && inbox.replies.length === 1 && inbox.counts.open === 1 && inbox.counts.auto === 1, `the open replies: ${JSON.stringify(inbox.counts)}`);
  await json(adm("POST", `/gtm/replies/${inbox.replies[0].id}/handled`, { handled: true }));
  const after = await json(adm("GET", `/gtm/replies?view=handled`));
  assert.ok(after.replies.some((y: any) => y.id === inbox.replies[0].id && y.handled_by === "token:smoke") && (await json(adm("GET", `/gtm/replies?campaign_id=${cR}&view=open`))).counts.open === 0, "handled");
  // Counting auto-replies, when the campaign says so.
  await json(adm("POST", `/gtm/campaigns/${cR}/pause`));
  await json(adm("PUT", `/gtm/campaigns/${cR}`, { count_auto_replies: true }));
  await json(adm("POST", `/gtm/campaigns/${cR}/resume`));
  assert.equal((await json(received(`in_c_${stamp}`, replyTo(rc), { subject: "Out of office" }))).kind, "reply", "count_auto_replies: an out-of-office counts");
  // Suppression only grows stronger: an unsubscribe, then a complaint, is a complaint; a confirmed opt-in lifts only
  // an unsubscribe, so it cannot undo the complaint; another unsubscribe never weakens it.
  const unsubRb = /Unsubscribe: (\S+)/.exec(first(rb).text)![1].replace(/^https?:\/\/[^/]+/, base);
  assert.equal((await fetch(unsubRb, { method: "POST" })).status, 200);
  const rbPid = (await db.query<{ provider_id: string }>("SELECT s.provider_id FROM gtm_campaign_sends s JOIN gtm_campaign_recipients r ON r.id = s.recipient_id WHERE r.email = $1 AND s.campaign_id = $2 AND s.step = 0", [rb, cR]))[0].provider_id;
  await json(hook({ type: "email.complained", data: { email_id: rbPid } }));
  const reasonOf = async (e: string) => (await db.query<{ reason: string }>("SELECT reason FROM email_suppressions WHERE email_hash = $1", [mail.hashAddress(e)]))[0]?.reason;
  assert.equal(await reasonOf(rb), "complained", "a complaint replaces the unsubscribe");
  await fetch(`${base}/api/email/confirm?t=${encodeURIComponent(await consent.confirmToken(rb, { wording_version: consent.OPT_IN_VERSION, country: null, request_id: requests[0] }))}`, { method: "POST" });
  await fetch(unsubRb, { method: "POST" });
  assert.equal(await reasonOf(rb), "complained", "neither a confirmed opt-in nor another unsubscribe undoes it");
  // Header and subject rules, and the snippet.
  assert.match(rep.autoReason({ "x-autoreply": "yes" }, "Hi") ?? "", /x-autoreply/);
  assert.match(rep.autoReason({ precedence: "auto_reply" }, "Hi") ?? "", /Precedence/);
  assert.match(rep.autoReason({}, "RE: Abwesenheitsnotiz") ?? "", /Subject/);
  assert.equal(rep.autoReason({ "auto-submitted": "no" }, "Re: First"), null, "Auto-Submitted: no is a person");
  assert.equal(rep.snippetOf("Yes please\n-----Original Message-----\nFrom: x"), "Yes please");

  // ---------- event-triggered campaigns ----------
  // request_submitted, no delay: the event kicks a tick at once (no cron), and the person is enrolled and sent.
  const cT = await create({ name: `Trigger ${stamp}`, audience: { include: "requests", utm_campaign: `${S}-t` }, steps: [step("Welcome, {{first_name}}")], requires_opt_in: false,
    trigger: { type: "request_submitted" } });
  created.push(cT);
  assert.equal((await launch(cT)).recipients.length, 0, "a triggered campaign enrols nobody at launch");
  const tp = `tp+${stamp}@p1-t.dev`;
  const tpReq = await request(tp, `${S}-t`, "US");
  requests.push(tpReq);
  assert.ok(await ev.emit("request_submitted", { request_id: tpReq, key: String(tpReq) }), "the event is recorded");
  assert.equal(await ev.emit("request_submitted", { request_id: tpReq, key: String(tpReq) }), null, "once: the same key is the same event");
  await waitFor(() => sentTo(tp, "campaign").filter(tagged(cT)).length === 1, "sent within moments of the event, by the kick");
  await tick();
  assert.equal(sentTo(tp, "campaign").filter(tagged(cT)).length, 1, "and never twice");
  // Re-entry: once ever (the default) ignores a second event for the same person.
  const tpReq2 = await request(tp, `${S}-t`, "US");
  requests.push(tpReq2);
  await ev.emit("request_submitted", { request_id: tpReq2, key: String(tpReq2) });
  await tick();
  const [en] = await db.query<any>("SELECT enrolled, note FROM gtm_event_enrolments ee JOIN gtm_events e ON e.id = ee.event_id WHERE ee.campaign_id = $1 AND e.request_id = $2", [cT, tpReq2]);
  assert.ok(en && en.enrolled === 0 && /re-entry/.test(en.note), `once ever: ${JSON.stringify(en)}`);
  // Every N days: after the window, a new round, with its own idempotency key.
  await json(adm("POST", `/gtm/campaigns/${cT}/pause`));
  await json(adm("PUT", `/gtm/campaigns/${cT}`, { trigger: { type: "request_submitted", reentry: "every", reentry_days: 1, delay_hours: 1 } }));
  await json(adm("POST", `/gtm/campaigns/${cT}/resume`));
  await db.query("UPDATE gtm_campaign_recipients SET entered_at = now() - interval '2 days' WHERE campaign_id = $1", [cT]);
  const tpReq3 = await request(tp, `${S}-t`, "US");
  requests.push(tpReq3);
  await ev.emit("request_submitted", { request_id: tpReq3, key: String(tpReq3) });
  await tick();
  const [q] = await db.query<any>("SELECT due_at > now() + interval '50 minutes' AS later, processed_at FROM gtm_event_enrolments ee JOIN gtm_events e ON e.id = ee.event_id WHERE ee.campaign_id = $1 AND e.request_id = $2", [cT, tpReq3]);
  assert.ok(q.later && !q.processed_at, "a delay: queued for an hour later, not enrolled yet");
  await db.query("UPDATE gtm_event_enrolments SET due_at = now() WHERE campaign_id = $1 AND processed_at IS NULL", [cT]);
  await tick();
  const tpRows = (await detail(cT)).recipients.filter((r: any) => r.email === tp);
  assert.ok(tpRows.length === 1 && tpRows[0].round === 1, "re-entered: round 2 on the same row");
  assert.ok(sentTo(tp, "campaign").filter(tagged(cT)).length === 2 && sentTo(tp, "campaign").filter(tagged(cT))[1].idempotency_key.endsWith(":1"), "its own email, its own key");
  // Someone who replied never re-enters, however long ago.
  await db.query("UPDATE gtm_campaign_recipients SET status = 'replied', replied_at = now(), entered_at = now() - interval '5 days' WHERE campaign_id = $1", [cT]);
  const tpReq4 = await request(tp, `${S}-t`, "US");
  requests.push(tpReq4);
  await ev.emit("request_submitted", { request_id: tpReq4, key: String(tpReq4) });
  await tick();
  await db.query("UPDATE gtm_event_enrolments SET due_at = now() WHERE campaign_id = $1 AND processed_at IS NULL", [cT]);
  await tick();
  assert.ok(sentTo(tp, "campaign").filter(tagged(cT)).length === 2 && (await detail(cT)).recipients.find((r: any) => r.email === tp).status === "replied", "a replier is not re-enrolled");

  // Account events from the detector: stage reached, stuck, attention; an account under two days old is news.
  const slug = `p1-acct-${stamp}`;
  const [{ id: orgId }] = await db.query<{ id: number }>("INSERT INTO organizations (slug, name, created_at) VALUES ($1, $1, now() - interval '1 day') RETURNING id", [slug]);
  orgs.push(orgId);
  const owner = `owner+${stamp}@p1-acct.dev`;
  requests.push(await request(owner, `${S}-acct`, "CA", { status: "approved", org_id: orgId, ago: "1 day" }));
  const audA = { include: "accounts", utm_campaign: `${S}-acct` };
  const cS = await create({ name: `Stage ${stamp}`, audience: audA, steps: [step("You onboarded {{product}}")], trigger: { type: "stage_reached", stage: "onboarded" } });
  created.push(cS);
  assert.equal((await adm("POST", "/gtm/campaigns", { name: "x", audience: audA, steps: [step("x")], trigger: { type: "stage_reached", stage: "nope" } })).status, 400, "a stage from the list");
  await launch(cS);
  // Onboarded after the launch: news for this campaign (a stage reached before it launched never is).
  await db.query("INSERT INTO products (org_id, slug, name) VALUES ($1, $2, 'Acct product')", [orgId, `p1-prod-${stamp}`]);
  const sn = await json(adm("POST", `/gtm/campaigns/${cS}/send-now`));
  const evs = await db.query<any>("SELECT type, data FROM gtm_events WHERE org_id = $1 ORDER BY id", [orgId]);
  assert.ok(evs.some((e: any) => e.type === "stage_reached" && e.data.stage === "onboarded") && evs.some((e: any) => e.type === "stage_reached" && e.data.stage === "created"),
    `stages passed are events: ${JSON.stringify(evs)}`);
  assert.ok(sn.sent === 1 && sentTo(owner, "campaign").filter(tagged(cS)).length === 1, `the account's requester (no Clerk) is enrolled and sent: ${JSON.stringify(sn)}`);
  // Detector unit checks on synthetic journeys: first payment, attention (numbers ignored), stuck.
  const j = (o: Partial<{ stage: string; stage_index: number; attention: string[]; paid_at: string | null; reached: Record<string, string | null> }>) => ({
    org: { id: orgId, slug, attention: o.attention ?? [], stage: o.stage ?? "onboarded", stage_index: o.stage_index ?? 5,
      reached: o.reached ?? { created: new Date(Date.now() - 9 * 86_400_000).toISOString(), invited: null, joined: null, connected: null, first_call: null,
        onboarded: new Date(Date.now() - 4 * 86_400_000).toISOString(), simulated: null, reported: null } },
    created_at: new Date(Date.now() - 86_400_000).toISOString(), paid_at: o.paid_at ?? null } as any);
  const n1 = await ev.detectSignals([j({ attention: ["Product onboarded, no simulation yet", "Created 3d ago, nobody invited"] })], { stuck: [{ stage: "onboarded", days: 3 }], payments: true });
  const n2 = await ev.detectSignals([j({ attention: ["Product onboarded, no simulation yet", "Created 4d ago, nobody invited"] })], { stuck: [{ stage: "onboarded", days: 3 }], payments: true });
  assert.ok(n1 >= 3 && n2 === 0, `new attention reasons and stuck once; a reason whose number changed is not new (${n1}, ${n2})`);
  assert.equal(await ev.detectSignals([j({ paid_at: new Date().toISOString() })], { stuck: [], payments: true }), 1, "a first payment");
  assert.equal(await ev.detectSignals([j({ paid_at: new Date().toISOString() })], { stuck: [], payments: true }), 0, "once");
  const types = (await db.query<any>("SELECT DISTINCT type FROM gtm_events WHERE org_id = $1", [orgId])).map((r: any) => r.type).sort();
  assert.deepEqual(types, ["attention", "first_payment", "stage_reached", "stuck"], `detected types: ${types}`);
  // A stuck trigger enrols from the stuck event (the queue matches type, stage and days).
  const cSt = await create({ name: `Stuck ${stamp}`, audience: audA, steps: [step("Still at onboarding?")], trigger: { type: "stuck", stage: "onboarded", days: 3 } });
  created.push(cSt);
  await launch(cSt);
  // It launched three days ago (the account entered the stage four days ago: within the two days before launch allowed).
  await db.query("UPDATE gtm_campaigns SET launched_at = now() - interval '3 days' WHERE id = $1", [cSt]);
  await db.query("UPDATE gtm_events SET at = now() WHERE org_id = $1 AND type = 'stuck'", [orgId]);
  await json(adm("POST", `/gtm/campaigns/${cSt}/send-now`));
  assert.equal(sentTo(owner, "campaign").filter(tagged(cSt)).length, 1, "stuck at a stage for N days: enrolled and sent");
  // Report opened, from the connector's own path (src/analytics.ts recordMcpEvent).
  (await import("../src/analytics.js")).recordMcpEvent({ orgId, slug, name: slug } as any, { method: "tools/call", name: "get_visibility_report", ok: true });
  await waitFor(async () => (await db.query("SELECT 1 FROM gtm_events WHERE org_id = $1 AND type = 'report_opened'", [orgId])).length === 1, "report_opened is emitted where the report is opened");
  // Approving a request (src/admin.ts) emits request_approved and account_created.
  const ap = `approve+${stamp}@p1-ap.dev`;
  const apReq = await request(ap, `${S}-ap`, "US");
  requests.push(apReq);
  const approved = await json(adm("POST", `/requests/${apReq}/approve`, { slug: `p1-ap-${stamp}` }));
  const [apOrg] = await db.query<{ id: number }>("SELECT id FROM organizations WHERE slug = $1", [approved.org.slug]);
  orgs.push(apOrg.id);
  await waitFor(async () => (await db.query("SELECT 1 FROM gtm_events WHERE (type = 'request_approved' AND request_id = $1) OR (type = 'account_created' AND org_id = $2)", [apReq, apOrg.id])).length === 2,
    "approving emits request_approved and account_created");

  // ---------- B3: events that predate a campaign never count for it ----------
  // The detector: a stuck account that entered the stage long before the campaign launched, or seen for the first time,
  // is no news; a stage the snapshot names that the list no longer has re-emits nothing.
  const oldSlug = `p1-old-${stamp}`;
  const [{ id: oldOrg }] = await db.query<{ id: number }>("INSERT INTO organizations (slug, name, created_at) VALUES ($1, $1, now() - interval '30 days') RETURNING id", [oldSlug]);
  orgs.push(oldOrg);
  const oj = (stage: string, idx: number, reachedDaysAgo: number) => ({ org: { id: oldOrg, slug: oldSlug, attention: [], stage, stage_index: idx,
    reached: { created: new Date(Date.now() - 30 * 86_400_000).toISOString(), invited: null, joined: null, connected: null, first_call: null,
      onboarded: new Date(Date.now() - reachedDaysAgo * 86_400_000).toISOString(), simulated: null, reported: null } },
    created_at: new Date(Date.now() - 30 * 86_400_000).toISOString(), paid_at: null } as any);
  assert.equal(await ev.detectSignals([oj("onboarded", 5, 10)], { stuck: [{ stage: "onboarded", days: 3 }], payments: false }), 0, "first sighting of an older account: recorded silently, stuck included");
  assert.equal(await ev.detectSignals([oj("onboarded", 5, 10)], { stuck: [{ stage: "onboarded", days: 3, since: Date.now() - 2 * 86_400_000 }], payments: false }), 0,
    "stuck only for accounts that entered the stage at most 2 days before the campaign launched");
  await db.query("UPDATE gtm_org_signals SET stage = 'retired_stage' WHERE org_id = $1", [oldOrg]);
  assert.equal(await ev.detectSignals([oj("onboarded", 5, 10)], { stuck: [], payments: false }), 0, "a stage missing from the list re-emits nothing");
  // A stale snapshot: the last look was 5 days ago; the stage reached since carries its own time, a reason its lower bound.
  await db.query("UPDATE gtm_org_signals SET seen_at = now() - interval '5 days', stage = 'onboarded', attention = '{}' WHERE org_id = $1", [oldOrg]);
  const simAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
  await ev.detectSignals([{ ...oj("simulated", 6, 10), org: { ...oj("simulated", 6, 10).org, attention: ["zz stale reason"], reached: { ...oj("simulated", 6, 10).org.reached, simulated: simAt } } }],
    { stuck: [], payments: false });
  const staleEvs = await db.query<any>("SELECT type, at, data FROM gtm_events WHERE org_id = $1 ORDER BY id", [oldOrg]);
  const simEv = staleEvs.find((e: any) => e.type === "stage_reached" && e.data.stage === "simulated"), attEv = staleEvs.find((e: any) => e.type === "attention");
  assert.ok(simEv && Math.abs(new Date(simEv.at).getTime() - Date.parse(simAt)) < 1000 && attEv && Date.parse(attEv.data.after) < Date.now() - 4 * 86_400_000,
    `a change seen late keeps when it happened: ${JSON.stringify(staleEvs)}`);
  // Matching: launched now, neither counts; a fresh one does; one first seen more than 24 hours late (paused) does not.
  const cB3 = await create({ name: `Stale ${stamp}`, audience: { include: "accounts", utm_campaign: `${S}-none` }, steps: [step("x")], trigger: { type: "attention" } });
  created.push(cB3);
  await launch(cB3);
  const fresh1 = await ev.emit("attention", { org_id: oldOrg, key: `fresh:${stamp}`, data: { reason: "fresh", after: new Date().toISOString() } });
  const late = await ev.emit("attention", { org_id: oldOrg, key: `late:${stamp}`, data: { reason: "late", after: new Date(Date.now() - 30 * 3600_000).toISOString() }, at: new Date(Date.now() - 30 * 3600_000) });
  await json(adm("POST", `/gtm/campaigns/${cB3}/pause`));
  await db.query("UPDATE gtm_campaigns SET launched_at = now() - interval '3 days' WHERE id = $1", [cB3]);
  await json(adm("POST", `/gtm/campaigns/${cB3}/resume`));
  await json(adm("POST", `/gtm/campaigns/${cB3}/send-now`));
  const matched = (await db.query<any>("SELECT event_id FROM gtm_event_enrolments WHERE campaign_id = $1", [cB3])).map((r: any) => Number(r.event_id));
  assert.ok(matched.includes(Number(fresh1)) && !matched.includes(Number(late)),
    `fresh counts; 30 hours late (paused) and before-launch do not: ${JSON.stringify({ matched, fresh1, late })}`);
  const [staleAtt] = await db.query<{ id: number }>("SELECT id FROM gtm_events WHERE org_id = $1 AND type = 'attention' AND data->>'reason' = 'zz stale reason'", [oldOrg]);
  assert.ok(!matched.includes(Number(staleAtt.id)), "a change that may predate the launch (seen after a 5-day gap) never counts");

  // ---------- B4: a requester enrolled for an account event stays a requester for consent ----------
  const b4Org = await (await fetch(`${mockUrl}/v1/organizations`, { method: "POST", headers: { authorization: "Bearer sk_test_mock", "content-type": "application/json" }, body: JSON.stringify({ name: `b4-${stamp}` }) })).json();
  const [{ id: b4Id }] = await db.query<{ id: number }>("INSERT INTO organizations (slug, name, clerk_org_id) VALUES ($1, $1, $2) RETURNING id", [`p1-b4-${stamp}`, b4Org.id]);
  orgs.push(b4Id);
  const b4 = `b4+${stamp}@p1-b4.dev`;
  requests.push(await request(b4, `${S}-b4`, null, { status: "approved", org_id: b4Id }));
  const cB4 = await create({ name: `B4 ${stamp}`, audience: { include: "accounts", utm_campaign: `${S}-b4` }, steps: [step("Welcome")], trigger: { type: "account_created" } });
  created.push(cB4);
  await launch(cB4);
  const b4Ev = await ev.emit("account_created", { org_id: b4Id, key: `b4:${b4Id}` });
  await json(adm("POST", `/gtm/campaigns/${cB4}/send-now`));
  const [b4En] = await db.query<any>("SELECT enrolled, note FROM gtm_event_enrolments WHERE campaign_id = $1 AND event_id = $2", [cB4, b4Ev]);
  assert.ok(b4En && b4En.enrolled === 0 && /consent/i.test(b4En.note) && !sentTo(b4, "campaign").length, `an unknown-country requester is not an existing customer: ${JSON.stringify(b4En)}`);
  assert.equal((await db.query("SELECT 1 FROM email_consent_ledger WHERE email_hash = $1", [mail.hashAddress(b4)])).length, 0, "and no legitimate interest is recorded for them");
  // A queued enrolment whose delay ran out more than 24 hours ago (paused, or no tick) is skipped, not enrolled late.
  const cQ = await create({ name: `Queue age ${stamp}`, audience: { include: "requests", utm_campaign: `${S}-q` }, steps: [step("Late")], requires_opt_in: false,
    trigger: { type: "request_submitted", delay_hours: 1 } });
  created.push(cQ);
  await launch(cQ);
  const qp = `queue+${stamp}@p1-q.dev`;
  unPeople.push(qp);
  const qReq = await request(qp, `${S}-q`, "US");
  requests.push(qReq);
  const qEv = await ev.emit("request_submitted", { request_id: qReq, key: String(qReq) });
  await tick();
  await db.query("UPDATE gtm_event_enrolments SET due_at = now() - interval '25 hours' WHERE campaign_id = $1 AND event_id = $2", [cQ, qEv]);
  await tick();
  const [qEn] = await db.query<any>("SELECT processed_at, enrolled, note FROM gtm_event_enrolments WHERE campaign_id = $1 AND event_id = $2", [cQ, qEv]);
  assert.ok(qEn.processed_at && qEn.enrolled === 0 && /Skipped/.test(qEn.note) && !sentTo(qp, "campaign").length, `stale in the queue: skipped: ${JSON.stringify(qEn)}`);

  // ---------- B1: an email whose outcome is uncertain never goes twice ----------
  process.env.CAMPAIGN_BATCH_SIZE = "3";
  unPeople.push(b4);
  const uncertainCampaign = async (tag: string, n: number, o: { rolling?: boolean } = {}) => {
    const ps = Array.from({ length: n }, (_, i) => `${tag}${i}+${stamp}@p1-un.dev`);
    unPeople.push(...ps);
    for (const p of ps) requests.push(await request(p, `${S}-${tag}`, "US"));
    const cid = await create({ name: `${tag} ${stamp}`, audience: { include: "requests", utm_campaign: `${S}-${tag}` }, steps: [step(`Uncertain ${tag}`)], requires_opt_in: false, rolling: o.rolling ?? true });
    created.push(cid);
    await launch(cid);
    return { cid, ps, count: () => ps.map((p) => sentTo(p, "campaign").filter(tagged(cid)).length) };
  };
  const sendsOf = (cid: number) => db.query<any>("SELECT status, batch_key, batch_pos, payload IS NOT NULL AS has_payload, replays FROM gtm_campaign_sends WHERE campaign_id = $1 ORDER BY recipient_id", [cid]);
  // Accepted, then the connection dropped: the immediate replay (same key, same body) is answered from Resend's record.
  const u1 = await uncertainCampaign("drop", 3);
  await mockPost("/_mock/resend/uncertain", { drop_after_accept: 1 });
  const td = await tick();
  assert.ok(td.sent >= 3 && u1.count().every((n) => n === 1) && (await sendsOf(u1.cid)).every((s: any) => s.status === "sent"), `accepted then no answer: each email once: ${JSON.stringify({ td, n: u1.count() })}`);
  // 409 concurrent_idempotent_requests twice (the request and its replay): uncertain, kept with its exact payload,
  // out of the queue; replayed 5 minutes later as that same request, its stored payload verbatim (an edit of the
  // step meanwhile changes nothing under that key), and it goes once.
  const ago = (cid: number, minutes: number) => db.query(`UPDATE gtm_campaign_sends SET uncertain_at = now() - make_interval(mins => $2), at = now() - make_interval(mins => $2)
    WHERE campaign_id = $1 AND status = 'uncertain'`, [cid, minutes]);
  const u2 = await uncertainCampaign("conc", 3);
  await mockPost("/_mock/resend/uncertain", { concurrent: 2 });
  const tc = await tick();
  const held2 = await sendsOf(u2.cid);
  assert.ok(tc.uncertain >= 3 && u2.count().every((n) => n === 0) && held2.every((s: any) => s.status === "uncertain" && s.has_payload && /^batch:/.test(s.batch_key))
    && new Set(held2.map((s: any) => s.batch_pos)).size === 3, `a 409 is uncertain, not failed: ${JSON.stringify({ tc, held2 })}`);
  assert.ok((await detail(u2.cid)).recipients.every((r: any) => r.next_at === null && r.status === "pending"), "out of the queue while uncertain");
  await tick();
  assert.ok(u2.count().every((n) => n === 0), "not replayed before its turn (5 minutes)");
  await json(adm("POST", `/gtm/campaigns/${u2.cid}/pause`));
  await json(adm("PUT", `/gtm/campaigns/${u2.cid}`, { steps: [step("Edited after the request")] }));
  await json(adm("POST", `/gtm/campaigns/${u2.cid}/resume`));
  await ago(u2.cid, 6);
  const tr = await tick();
  assert.ok(u2.count().every((n) => n === 1) && (await sendsOf(u2.cid)).every((s: any) => s.status === "sent" && !s.has_payload) && tr.sent >= 3, `replayed exactly, once each: ${JSON.stringify(tr)}`);
  assert.ok(u2.ps.every((p) => sentTo(p, "campaign").filter(tagged(u2.cid))[0].subject === "Uncertain conc"), "the stored payload, verbatim, never the edited step");
  // An outage (every request a 5xx): the first request and its immediate replay are uncertain and the wave stops
  // there; the next tick sends one email as a probe, no more; replays come at 5 min, 1 h, 6 h, 20 h, so nothing is
  // parked as unknown within the hour; once Resend is back, everything goes, once.
  const uo = await uncertainCampaign("outage", 6);
  await mockPost("/_mock/resend/outage", { down: true });
  const to1 = await tick();
  const so1 = await sendsOf(uo.cid);
  assert.ok(to1.requests === 2 && so1.length === 3 && so1.every((s: any) => s.status === "uncertain"), `the first uncertain request stops the wave: ${JSON.stringify({ to1, so1 })}`);
  const to2 = await tick();
  assert.ok((await sendsOf(uo.cid)).length === 4 && to2.requests === 2, `then one email a tick as a probe: ${JSON.stringify(to2)}`);
  await ago(uo.cid, 6);
  const to3 = await tick();
  const so3 = await sendsOf(uo.cid);
  assert.ok(so3.length === 4 && so3.every((s: any) => s.status === "uncertain") && so3.some((s: any) => Number(s.replays) === 1) && to3.unknown === 0,
    `a replay still uncertain: no new sends, nothing parked: ${JSON.stringify({ to3, so3 })}`);
  await ago(uo.cid, 10);
  await tick();
  assert.ok((await sendsOf(uo.cid)).every((s: any) => s.status === "uncertain" && Number(s.replays) <= 1), "the second replay waits an hour");
  await mockPost("/_mock/resend/outage", { down: false });
  await ago(uo.cid, 70);
  await tick();
  assert.ok(uo.count().every((n) => n === 1) && (await sendsOf(uo.cid)).every((s: any) => s.status === "sent"), `back up: everyone once: ${JSON.stringify(uo.count())}`);
  // A batch answer missing an email's id: that one is unknown (Resend may have it), never resent on its own. A
  // non-rolling campaign still finishes (the unknown one is not waiting), and the peek shows it. An owner's Resend
  // sends the stored email under a new key (the one deliberate duplicate risk).
  const u3 = await uncertainCampaign("omit", 2, { rolling: false });
  await mockPost("/_mock/resend/uncertain", { omit_id: 1 });
  const to = await tick();
  const s3 = await sendsOf(u3.cid);
  assert.ok(to.unknown >= 1 && s3.filter((s: any) => s.status === "unknown" && s.has_payload).length === 1 && s3.filter((s: any) => s.status === "sent").length === 1, `missing id: unknown: ${JSON.stringify(s3)}`);
  await tick();
  assert.deepEqual(u3.count().sort(), [1, 1], "not sent again by a later tick (Resend did take it)");
  const d3 = await detail(u3.cid);
  assert.ok(d3.campaign.status === "done" && d3.campaign.metrics.unknown === 1, `done, and the peek still shows the unknown one: ${JSON.stringify({ status: d3.campaign.status, m: d3.campaign.metrics })}`);
  const rs = await json(adm("POST", `/gtm/campaigns/${u3.cid}/resend-unknown`));
  assert.equal(rs.resent, 1, `resent: ${JSON.stringify(rs)}`);
  assert.deepEqual(u3.count().sort(), [1, 2], "resent only when an owner says so");
  const again3 = u3.ps.flatMap((p) => sentTo(p, "campaign").filter(tagged(u3.cid))).find((e: any) => /:resend:[0-9a-f]+$/.test(e.idempotency_key));
  assert.ok(again3 && again3.subject === "Uncertain omit", "under a new key, the stored email");
  // A tick killed mid-request: a claim with a request key stuck sending is uncertain when its payload was stored before
  // the request (replayed as that request), unknown without one; one stuck before its request (no key) is safe to send.
  const u4 = await uncertainCampaign("kill", 3);
  await json(adm("POST", `/gtm/campaigns/${u4.cid}/pause`));
  const r4 = (await detail(u4.cid)).recipients;
  const killedPayload = { kind: "campaign", idempotencyKey: `campaign:${u4.cid}:${r4[2].id}:0`, subject: "Killed mid-request", text: "Stored before the request.", tags: [{ name: "campaign", value: String(u4.cid) }] };
  await db.query(`INSERT INTO gtm_campaign_sends (campaign_id, recipient_id, step, round, status, batch_key, batch_pos, payload, at) VALUES
    ($1, $2, 0, 0, 'sending', 'batch:killed', NULL, NULL, now() - interval '11 minutes'),
    ($1, $3, 0, 0, 'sending', NULL, NULL, NULL, now() - interval '11 minutes'),
    ($1, $4, 0, 0, 'sending', $5, 0, $6::jsonb, now() - interval '11 minutes')`, [u4.cid, r4[0].id, r4[1].id, r4[2].id, killedPayload.idempotencyKey, JSON.stringify(killedPayload)]);
  await json(adm("POST", `/gtm/campaigns/${u4.cid}/resume`));
  await tick();
  const s4 = await sendsOf(u4.cid);
  assert.ok(s4[0].status === "unknown" && s4[1].status === "sent" && s4[2].status === "uncertain" && u4.count()[0] === 0 && u4.count()[1] === 1, `killed mid-request: ${JSON.stringify(s4)}`);
  await ago(u4.cid, 6);
  await tick();
  assert.ok((await sendsOf(u4.cid))[2].status === "sent" && sentTo(u4.ps[2], "campaign").filter(tagged(u4.cid))[0].subject === "Killed mid-request", "the killed request, replayed from its stored payload");
  // A replay re-checks each member: one who replied, one who withdrew consent are parked; the rest go as the same key.
  const u5 = await uncertainCampaign("park", 3);
  await mockPost("/_mock/resend/uncertain", { concurrent: 2 });
  await tick();
  const r5 = (await detail(u5.cid)).recipients;
  await db.query("UPDATE gtm_campaign_recipients SET status = 'replied' WHERE id = $1", [r5[0].id]);
  await consent.recordConsent(u5.ps[1], "withdrawn", { source: "admin" });
  await ago(u5.cid, 6);
  await tick();
  const s5 = await sendsOf(u5.cid);
  assert.ok(s5[0].status === "unknown" && s5[1].status === "unknown" && s5[2].status === "sent" && u5.count().join() === "0,0,1",
    `left out of the replay, the rest sent once: ${JSON.stringify({ s5, n: u5.count() })}`);
  delete process.env.CAMPAIGN_BATCH_SIZE;
  // ---------- replies are personal data: the campaigns permission only ----------
  const { createAdminToken } = await import("../src/admin-tokens.js");
  const viewer = (await createAdminToken({ label: "smoke-viewer", role: "viewer", days: 1, createdBy: "smoke" })).token;
  const asViewer = (path: string) => fetch(`${base}/api/admin/onboarding${path}`, { headers: { authorization: `Bearer ${viewer}`, "x-admin-actor": "smoke-viewer" } });
  assert.equal((await asViewer("/gtm/replies")).status, 403, "a viewer cannot read replies");
  const vd2 = await (await asViewer(`/gtm/campaigns/${cR}`)).json();
  assert.ok(vd2.replies.hidden === true && vd2.replies.replies.length === 0 && vd2.campaign, "nor in a campaign's peek");

  // ---------- CSV exports: no formula injection ----------
  const csvPath = "../web/src/lib/csv.ts";
  const csv = await import(csvPath);
  assert.deepEqual(["=1+1", "+x", "-x", "@x", "\tx", "  =1", " +x", "plain", -5].map((v) => csv.csvCell(v)), ["'=1+1", "'+x", "'-x", "'@x", "'\tx", "'  =1", "' +x", "plain", "-5"], "cells that read as formulas are made text");

  // ---------- privacy: addresses only in the recipients and replies tables ----------
  const everyone = [pa, optDe, noDe, us, unk, comp, race, win, ra, rb, rc, tp, owner, ...people, ...capPeople, ...unPeople];
  const elsewhere = JSON.stringify(await db.query("SELECT * FROM gtm_events")) + JSON.stringify(await db.query("SELECT * FROM gtm_event_enrolments"))
    + JSON.stringify(await db.query("SELECT * FROM email_consents")) + JSON.stringify(await db.query("SELECT * FROM email_consent_ledger"))
    + JSON.stringify(await db.query("SELECT * FROM gtm_org_signals")) + JSON.stringify(await db.query("SELECT * FROM gtm_campaign_sends"))
    + JSON.stringify(await db.query("SELECT * FROM email_log WHERE kind IN ('campaign', 'campaign_test')")) + JSON.stringify(await db.query("SELECT * FROM gtm_campaigns"));
  for (const a of everyone) assert.ok(!elsewhere.includes(a), `no address outside gtm_campaign_recipients and gtm_replies: ${a}`);

  // Clean up: campaigns (their recipients, sends, replies and event queue go with them), events, requests, accounts.
  for (const id of created) await db.query("DELETE FROM gtm_campaigns WHERE id = $1", [id]);
  await db.query("DELETE FROM gtm_events WHERE org_id = ANY($1::int[]) OR request_id = ANY($2::int[])", [orgs, requests]);
  await db.query("DELETE FROM email_consents WHERE email_hash = ANY($1::text[])", [everyone.map(mail.hashAddress)]);
  await db.query("DELETE FROM email_suppressions WHERE email_hash = ANY($1::text[])", [everyone.map(mail.hashAddress)]);
  await db.query("DELETE FROM access_requests WHERE id = ANY($1::int[])", [requests]);
  await db.query("DELETE FROM organizations WHERE id = ANY($1::int[])", [orgs]);
  await settings.setSettings("smoke", { EMAIL_INBOUND_ADDRESS: null, EMAIL_POSTAL_ADDRESS: null });
  await kvm.deleteCredential(hookCred.id);
  delete process.env.CAMPAIGN_SEND_INTERVAL_MS;
  console.log("✓ GTM phase 1: replies stop sequences (per-recipient Reply-To, auto-replies, inbox), triggers (events, kick, delay, re-entry, detector), A/B variants (deterministic, z-test, winner), send windows and time zones, consent (opt-in, EU rule, withdrawal), postal address, batch sends past a 429, per-tick cap");
}
