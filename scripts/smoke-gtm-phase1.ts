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
  const created: number[] = [], requests: number[] = [], orgs: number[] = [];
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

  // ---------- consent: the form's checkbox, the EU / unknown-country rule, requires opt-in, withdrawal ----------
  const optDe = `de+${stamp}@p1-c.dev`, noDe = `de2+${stamp}@p1-c.dev`, us = `us+${stamp}@p1-c.dev`, unk = `unk+${stamp}@p1-c.dev`;
  const form = (email: string, country: string, body: Record<string, unknown>) => fetch(`${base}/api/access-requests`, { method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, "x-vercel-ip-country": country },
    body: JSON.stringify({ email, company: `Consent ${stamp}`, source: { utm_source: "p1", utm_campaign: `${S}-c` }, ...body }) });
  assert.equal((await form(optDe, "DE", { marketing_opt_in: true, marketing_wording: consent.OPT_IN_VERSION })).status, 201);
  assert.equal((await form(noDe, "DE", {})).status, 201, "unticked (the default)");
  requests.push(...(await db.query<{ id: number }>("SELECT id FROM access_requests WHERE email = ANY($1::text[])", [[optDe, noDe]])).map((r) => r.id));
  requests.push(await request(us, `${S}-c`, "US"), await request(unk, `${S}-c`, null));
  const [row] = await db.query<any>("SELECT * FROM email_consents WHERE email_hash = $1", [mail.hashAddress(optDe)]);
  assert.ok(row && row.basis === "opt_in" && row.source === "access_request_form" && row.wording_version === consent.OPT_IN_VERSION && row.country === "DE", `the opt-in is recorded: ${JSON.stringify(row)}`);
  assert.equal((await db.query("SELECT 1 FROM email_consents WHERE email_hash = $1", [mail.hashAddress(noDe)])).length, 0, "an unticked box records nothing");
  assert.equal((await db.query("SELECT 1 FROM email_consent_ledger WHERE email_hash = $1 AND basis = 'opt_in'", [mail.hashAddress(optDe)])).length, 1, "and the ledger has it");
  await waitFor(async () => (await db.query("SELECT 1 FROM gtm_events WHERE type = 'request_submitted' AND request_id = ANY($1::int[])", [requests.slice(-4, -2)])).length === 2,
    "submitting the form emits request_submitted");
  const audC = { include: "requests", utm_campaign: `${S}-c` };
  const pvC = await json(adm("POST", "/gtm/audience/preview", { audience: audC }));
  assert.ok(pvC.requires_opt_in === true && pvC.count === 4 && pvC.no_consent === 3 && pvC.sendable === 1, `requesters need an opt-in by default: ${JSON.stringify({ ...pvC, sample: undefined })}`);
  const pvC2 = await json(adm("POST", "/gtm/audience/preview", { audience: audC, requires_opt_in: false }));
  assert.ok(pvC2.no_consent === 2 && pvC2.sample.find((s: any) => s.email === us).consent === "opt_out" && pvC2.sample.find((s: any) => s.email === unk).consent === "needs_opt_in",
    "without the campaign rule, the EU one still holds, and an unknown country counts as needing an opt-in");
  const cC = await create({ name: `Consent ${stamp}`, audience: audC, steps: [step("Consent check")] });
  created.push(cC);
  await launch(cC);
  assert.deepEqual((await detail(cC)).recipients.map((r: any) => [r.email, r.consent_basis]), [[optDe, "opt_in"]], "only the recorded opt-in is enrolled");
  const cC2 = await create({ name: `Consent off ${stamp}`, audience: audC, steps: [step("Consent off")], requires_opt_in: false });
  created.push(cC2);
  await launch(cC2);
  assert.deepEqual((await detail(cC2)).recipients.map((r: any) => r.email).sort(), [optDe, us].sort(), "opt-in off: the US requester too, never the EU or unknown ones");
  await tick();
  const link = /Unsubscribe: (\S+)/.exec(sentTo(optDe, "campaign").find(tagged(cC)).text)![1].replace(/^https?:\/\/[^/]+/, base);
  assert.equal((await fetch(link, { method: "POST" })).status, 200);
  const [w] = await db.query<any>("SELECT basis, source FROM email_consents WHERE email_hash = $1", [mail.hashAddress(optDe)]);
  assert.ok(w.basis === "withdrawn" && w.source === "unsubscribe", "unsubscribing withdraws consent");
  assert.deepEqual((await db.query<any>("SELECT basis FROM email_consent_ledger WHERE email_hash = $1 ORDER BY id", [mail.hashAddress(optDe)])).map((r: any) => r.basis), ["opt_in", "withdrawn"], "the ledger keeps both");
  assert.equal(consent.mayEnrol({ email: optDe, source: "account", country: "US" }, false, { basis: "withdrawn" } as any).ok, false, "withdrawn beats legitimate interest");
  assert.equal(consent.mayEnrol({ email: "x@y.z", source: "account", country: "FR" }, false, undefined).ok, true, "an existing customer under legitimate interest");
  // Ticking the box again later: an opt-in again, and the unsubscribe suppression lifted (never a bounce's).
  await consent.recordFormOptIn(optDe, { opt_in: true, wording_version: consent.OPT_IN_VERSION, country: "DE", request_id: requests[requests.length - 4] });
  assert.equal((await db.query("SELECT 1 FROM email_suppressions WHERE email_hash = $1", [mail.hashAddress(optDe)])).length, 0, "a fresh opt-in lifts an unsubscribe");

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
  const again = await mail.sendBatch([0, 1].map((n) => ({ kind: "campaign" as const, to: people[n], subject: "x", text: "x",
    idempotencyKey: `campaign:${cAb}:${sends.find((s: any) => s.recipient_id === sends[n].recipient_id).recipient_id}:0` })));
  assert.ok(again.results.every((r) => r.status === "duplicate"), "a batch retried after it went out sends nothing");
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

  // Account events from the detector: stage reached, stuck, attention; an account under two days old is news.
  const slug = `p1-acct-${stamp}`;
  const [{ id: orgId }] = await db.query<{ id: number }>("INSERT INTO organizations (slug, name, created_at) VALUES ($1, $1, now() - interval '1 day') RETURNING id", [slug]);
  orgs.push(orgId);
  const owner = `owner+${stamp}@p1-acct.dev`;
  requests.push(await request(owner, `${S}-acct`, "CA", { status: "approved", org_id: orgId, ago: "1 day" }));
  await db.query("INSERT INTO products (org_id, slug, name, created_at) VALUES ($1, $2, 'Acct product', now() - interval '20 hours')", [orgId, `p1-prod-${stamp}`]);
  const audA = { include: "accounts", utm_campaign: `${S}-acct` };
  const cS = await create({ name: `Stage ${stamp}`, audience: audA, steps: [step("You onboarded {{product}}")], trigger: { type: "stage_reached", stage: "onboarded" } });
  created.push(cS);
  assert.equal((await adm("POST", "/gtm/campaigns", { name: "x", audience: audA, steps: [step("x")], trigger: { type: "stage_reached", stage: "nope" } })).status, 400, "a stage from the list");
  await launch(cS);
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

  // ---------- privacy: addresses only in the recipients and replies tables ----------
  const everyone = [pa, optDe, noDe, us, unk, win, ra, rb, rc, tp, owner, ...people, ...capPeople];
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
