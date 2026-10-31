// GTM × pricing experiments for scripts/smoke-gtm.ts: Activation split by variant, Attribution's per-variant breakdown,
// the "Saw pricing variant" audience filter, the "Saw pricing, didn't check out within N days" trigger, and the deep
// links between FinOps › Experiments and GTM. Stripe is the mock (scripts/lib/mock-providers.ts): exposures are
// plan_exposures rows, purchases are mock subscriptions tagged octillion_experiment / octillion_variant, as checkout tags them.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

type Db = { query: <T = any>(sql: string, params?: unknown[]) => Promise<T[]> };

export async function gtmPricingChecks({ db, adm, json, mockPost, sentTo, stamp }: {
  db: Db; adm: (method: string, path: string, body?: unknown) => Promise<Response>; json: (r: Response | Promise<Response>) => Promise<any>;
  mockPost: (path: string, body?: unknown) => Promise<any>; sentTo: (to: string, kind?: string) => any[]; stamp: string;
}) {
  const billing = await import("../src/billing.js"), ev = await import("../src/gtm-events.js");
  const EXP = `gtm-px-${stamp}`.toLowerCase(), A = "price_mock_starter", B = "price_mock_growth";
  const CAMP = `px-${stamp}`, day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const range = `from=${day(7)}&to=${day(0)}`;
  const orgs: number[] = [], requests: number[] = [], campaigns: number[] = [];
  const org = async (slug: string, o: { ago?: string; customer?: string } = {}) => {
    const [{ id }] = await db.query<{ id: number }>("INSERT INTO organizations (slug, name, created_at, stripe_customer_id) VALUES ($1, $1, now() - $2::interval, $3) RETURNING id",
      [slug, o.ago ?? "5 days", o.customer ?? null]);
    orgs.push(id);
    return id;
  };
  const request = async (email: string, campaign: string, o: { org_id?: number | null; status?: string } = {}) => {
    const [{ id }] = await db.query<{ id: number }>(
      `INSERT INTO access_requests (email, company, name, status, org_id, source, created_at, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, now() - interval '6 days', CASE WHEN $4 = 'approved' THEN now() - interval '5 days' END) RETURNING id`,
      [email, `Co ${email.split("@")[0]}`, email.split(/[+@]/)[0], o.status ?? "approved", o.org_id ?? null,
       JSON.stringify({ utm_source: "pxsrc", utm_medium: "email", utm_campaign: campaign, country: "US" })]);
    requests.push(id);
    return id;
  };
  const expose = (orgId: number, price: string, name: string, ago: string) => db.query(
    "INSERT INTO plan_exposures (org_id, experiment, price_id, plan_name, first_seen_at) VALUES ($1, $2, $3, $4, now() - $5::interval)", [orgId, EXP, price, name, ago]);
  const tagged = (customer: string, variant: string, price: string) => mockPost("/_mock/subscriptions", { customer, price, start_date: Math.floor(Date.now() / 1000) - 2 * 86_400,
    invoice: false, metadata: { octillion_slug: "x", octillion_experiment: EXP, octillion_variant: variant } });
  // An untagged subscription (a plan outside any experiment, an admin checkout link, a subscriber from before).
  const untagged = (customer: string, daysAgo: number) => mockPost("/_mock/subscriptions", { customer, price: A, start_date: Math.floor(Date.now() / 1000) - daysAgo * 86_400, invoice: false });
  const fresh = () => { billing.invalidateSubscriptions(); billing.invalidateCheckouts(); };

  // X: shown A, never checks out. Y: shown A, reached a report and BOUGHT B (a tagged subscription). Z: never opened
  // Billing (no exposure). P: a pending request with no account. Q: shown B long ago, outside the period and the tag.
  const cusY = `cus_px_y_${stamp}`;
  const [oX, oY, oZ] = [await org(`px-x-${stamp}`), await org(`px-y-${stamp}`, { customer: cusY }), await org(`px-z-${stamp}`)];
  const oQ = await org(`px-q-${stamp}`, { ago: "40 days" });
  const ex = `px-x+${stamp}@px.dev`, ey = `px-y+${stamp}@px.dev`, ez = `px-z+${stamp}@px.dev`;
  await request(ex, CAMP, { org_id: oX }); await request(ey, CAMP, { org_id: oY }); await request(ez, CAMP, { org_id: oZ });
  await request(`px-p+${stamp}@px.dev`, CAMP, { status: "pending" });
  await expose(oX, A, "Px A", "4 days 2 hours"); await expose(oY, A, "Px A", "4 days 2 hours"); await expose(oQ, B, "Px B", "39 days");
  const [{ id: pY }] = await db.query<{ id: number }>("INSERT INTO products (org_id, slug, name, created_at) VALUES ($1, $2, 'Px product', now() - interval '4 days') RETURNING id", [oY, `px-py-${stamp}`]);
  await db.query(`INSERT INTO simulations (id, org_id, product_id, name, models, harness, repeats, status, created_at) VALUES ($1, $2, $3, 'px', '{m}', 'claude-code', 1, 'completed', now() - interval '3 days')`,
    [`sim_px_${randomBytes(4).toString("hex")}`, oY, pY]);
  await db.query("INSERT INTO mcp_events (org_id, method, name, ok, at) VALUES ($1, 'tools/call', 'get_visibility_report', true, now() - interval '60 hours')", [oY]);
  await tagged(cusY, B, B);
  fresh();

  // ---------- Activation: unchanged without an experiment; split by variant with one ----------
  const plain = await json(adm("GET", `/gtm/activation?${range}&utm_campaign=${CAMP}`));
  assert.ok(!("experiment" in plain) && plain.cohort.every((c: any) => !("variant" in c)), "default Activation: no experiment block, no variant on the cohort");
  assert.ok(plain.facets.experiments[EXP] === 3, `the experiment selector lists it with accounts shown: ${JSON.stringify(plain.facets.experiments)}`);
  assert.deepEqual(plain.steps.map((s: any) => s.reached), [4, 3, 1, 1, 1, 1], `the campaign's funnel: ${JSON.stringify(plain.steps.map((s: any) => s.reached))}`);
  const act = await json(adm("GET", `/gtm/activation?${range}&utm_campaign=${CAMP}&experiment=${EXP}`));
  assert.deepEqual(act.steps, plain.steps, "choosing an experiment leaves the main funnel as it was");
  const col = (k: string) => act.experiment.split.find((c: any) => c.key === k);
  const reached = (k: string) => col(k).steps.map((s: any) => s.reached);
  assert.equal(act.experiment.split.at(-1).key, "none", "Not shown pricing is the last column");
  assert.equal(col("none").name, "Not shown pricing");
  assert.deepEqual(reached(A), [2, 2, 1, 1, 1, 0], `shown A: X and Y (Y paid, but for B): ${JSON.stringify(reached(A))}`);
  assert.deepEqual(reached(B), [0, 0, 0, 0, 0, 1], `Paid counts under the variant bought (Y's subscription is tagged B): ${JSON.stringify(reached(B))}`);
  assert.deepEqual(reached("none"), [2, 1, 0, 0, 0, 0], `never shown pricing (Z, and the request with no account) is its own column: ${JSON.stringify(reached("none"))}`);
  for (const [i, s] of act.steps.entries())
    assert.equal(act.experiment.split.reduce((t: number, c: any) => t + c.steps[i].reached, 0), s.reached, `the columns add up to the funnel at ${s.id}`);
  assert.ok(/Not shown pricing/.test(act.experiment.rule) && /octillion_variant/.test(act.experiment.rule), "the rule is stated with the split");
  assert.equal(col(B).name, "Px B", "variant names from what accounts were shown");
  const cy = act.cohort.find((c: any) => c.slug === `px-y-${stamp}`), cz = act.cohort.find((c: any) => c.slug === `px-z-${stamp}`);
  assert.deepEqual([cy.variant, cy.paid_variant, cz.variant, cz.paid_variant], [A, B, "none", null], "each account's variant shown, and the one it paid for");
  const onlyNone = await json(adm("GET", `/gtm/activation?${range}&utm_campaign=${CAMP}&experiment=${EXP}&variant=none`));
  assert.deepEqual([onlyNone.steps.map((s: any) => s.reached), onlyNone.experiment.split.map((c: any) => c.key)], [[2, 1, 0, 0, 0, 0], ["none"]], "the Variant filter keeps those variants");
  assert.ok(onlyNone.attention.every((o: any) => ![`px-x-${stamp}`, `px-y-${stamp}`].includes(o.slug)), "and narrows Needs a person");
  const ignored = await json(adm("GET", `/gtm/activation?${range}&utm_campaign=${CAMP}&variant=none`));
  assert.deepEqual(ignored.steps, plain.steps, "a variant without an experiment changes nothing");

  // ---------- Attribution: a per-variant breakdown per row, only with an experiment ----------
  const attPlain = await json(adm("GET", `/gtm/attribution?${range}`));
  const rowPlain = attPlain.rows.find((r: any) => r.utm_campaign === CAMP);
  assert.ok(rowPlain && !("variants" in rowPlain) && !("not_shown" in rowPlain) && !("experiment" in attPlain) && !("variant" in rowPlain.account_list[0]), "default Attribution: rows as they were");
  assert.equal(attPlain.experiments[EXP], 3, "the selector's choices");
  const att = await json(adm("GET", `/gtm/attribution?${range}&experiment=${EXP}`));
  const row = att.rows.find((r: any) => r.utm_campaign === CAMP);
  const { variants: _v, not_shown: _n, account_list: al, ...rowRest } = row;
  const { account_list: alPlain, ...plainRest } = rowPlain;
  assert.deepEqual(rowRest, plainRest, "the row's own numbers do not move");
  assert.equal(al.length, alPlain.length);
  const cell = (k: string) => row.variants.find((c: any) => c.key === k);
  assert.deepEqual([cell(A).exposed, cell(A).converted, cell(A).paying, cell(A).mrr_usd], [2, 0, 0, 0], `A: shown to X and Y, bought by nobody: ${JSON.stringify(cell(A))}`);
  assert.deepEqual([cell(B).exposed, cell(B).converted, cell(B).paying, cell(B).mrr_usd], [0, 1, 1, 1499], `B: Y bought it and pays: ${JSON.stringify(cell(B))}`);
  assert.equal(row.not_shown, 1, "Z was never shown pricing");
  assert.deepEqual(al.find((x: any) => x.slug === `px-y-${stamp}`) && [al.find((x: any) => x.slug === `px-y-${stamp}`).variant, al.find((x: any) => x.slug === `px-y-${stamp}`).bought], [A, B], "each account: shown and bought");
  assert.ok(att.experiment.id === EXP && att.experiment.variants.some((v: any) => v.key === A) && att.experiment.totals.find((c: any) => c.key === B).converted >= 1, "the period's totals per variant");

  // ---------- the audience filter "Saw pricing variant": accounts by their first exposure ----------
  const pv = (pricing?: unknown, include = "accounts") => adm("POST", "/gtm/audience/preview", { audience: { include, utm_campaign: CAMP, ...(pricing ? { pricing } : {}) } });
  const emails = async (pricing?: unknown) => (await json(pv(pricing))).sample.map((s: any) => s.email).sort();
  assert.deepEqual(await emails(), [ex, ey, ez].sort(), "no pricing filter: the three accounts' requesters");
  assert.deepEqual(await emails({ experiment: EXP, variant: A }), [ex, ey].sort(), "shown variant A: X and Y");
  assert.deepEqual(await emails({ experiment: EXP, variant: "" }), [ex, ey].sort(), "any variant: every account shown the experiment");
  assert.deepEqual(await emails({ experiment: EXP, variant: B }), [], "shown B: nobody here (Y bought B but was shown A)");
  assert.equal((await pv({ experiment: EXP }, "both")).status, 400, "accounts only: requesters and visitors are not addressable by a variant");
  const saved = await json(adm("POST", "/gtm/campaigns", { name: `Px audience ${stamp}`, audience: { include: "accounts", utm_campaign: CAMP, pricing: { experiment: EXP, variant: A } },
    steps: [{ subject: "Pricing", body: "x", delay_days: 0 }], conversion_days: 14 }));
  campaigns.push(saved.campaign.id);
  assert.deepEqual(saved.campaign.audience.pricing, { experiment: EXP, variant: A }, "the filter is saved with the audience");
  const noPricing = await json(adm("POST", "/gtm/campaigns", { name: `Px none ${stamp}`, audience: { include: "accounts" }, steps: [{ subject: "x", body: "x", delay_days: 0 }], conversion_days: 14 }));
  campaigns.push(noPricing.campaign.id);
  assert.ok(!("pricing" in noPricing.campaign.audience), "an audience without it reads as before");
  const list = await json(adm("GET", "/gtm/campaigns"));
  assert.ok(list.trigger_types.includes("pricing_no_checkout") && list.experiments.find((x: any) => x.experiment === EXP)?.variants.some((v: any) => v.price_id === A && v.name === "Px A"),
    "the editor gets the trigger and the experiments with their variants");

  // ---------- the trigger "Saw pricing, didn't check out within N days" ----------
  const step = [{ subject: "Still deciding on a plan, {{first_name}}?", body: "Hi {{first_name}}, any questions about pricing for {{product}}?", delay_days: 0 }];
  assert.equal((await adm("POST", "/gtm/campaigns", { name: "x", audience: { include: "prospects" }, steps: step, trigger: { type: "pricing_no_checkout", experiment: EXP, days: 3 } })).status, 400,
    "never on an outbound (prospects) campaign");
  assert.equal((await adm("POST", "/gtm/campaigns", { name: "x", audience: { include: "accounts" }, steps: step, trigger: { type: "pricing_no_checkout", days: 91 } })).status, 400, "N is 1 to 90");
  // W: shown 3 days and an hour ago, no checkout. U: same, but holds a subscription tagged with the experiment.
  // T: shown a day ago (not N days yet). V: shown 7 days and an hour ago, before the 7-day campaign launched (less 2 days).
  const C3 = `px3-${stamp}`, C7 = `px7-${stamp}`, CD = `pxd-${stamp}`;
  const cusU = `cus_px_u_${stamp}`, cusW2 = `cus_px_w2_${stamp}`;
  const [oW, oU, oT, oV, oW2] = [await org(`px-w-${stamp}`, { ago: "4 days" }), await org(`px-u-${stamp}`, { ago: "4 days", customer: cusU }), await org(`px-t-${stamp}`, { ago: "4 days" }),
    await org(`px-v-${stamp}`, { ago: "9 days" }), await org(`px-w2-${stamp}`, { ago: "4 days", customer: cusW2 })];
  const ew = `px-w+${stamp}@px.dev`, eu = `px-u+${stamp}@px.dev`, et = `px-t+${stamp}@px.dev`, evv = `px-v+${stamp}@px.dev`, ew2 = `px-w2+${stamp}@px.dev`;
  await request(ew, C3, { org_id: oW }); await request(eu, C3, { org_id: oU }); await request(et, C3, { org_id: oT }); await request(evv, C7, { org_id: oV }); await request(ew2, CD, { org_id: oW2 });
  await expose(oW, A, "Px A", "3 days 1 hour"); await expose(oU, A, "Px A", "3 days 1 hour"); await expose(oT, B, "Px B", "1 day");
  await expose(oV, B, "Px B", "7 days 1 hour"); await expose(oW2, A, "Px A", "3 days 1 hour");
  await tagged(cusU, A, A);
  // Customers already, every way that is not "a checkout tagged with this experiment": S1 subscribed a month before
  // the experiment (untagged), S2 took an untagged plan after being shown it (an admin checkout link), S3 bought the
  // other variant, S4 checked out under another experiment. Each is shown A 3 days and an hour ago: never mailed.
  const sCus = [1, 2, 3, 4].map((i) => `cus_px_s${i}_${stamp}`);
  const sOrg: number[] = [], sMail: string[] = [];
  for (const [i, cus] of sCus.entries()) {
    const o = await org(`px-s${i + 1}-${stamp}`, { ago: "40 days", customer: cus });
    sOrg.push(o); sMail.push(`px-s${i + 1}+${stamp}@px.dev`);
    await request(sMail[i], C3, { org_id: o });
    await expose(o, A, "Px A", "3 days 1 hour");
  }
  await untagged(sCus[0], 30);
  await untagged(sCus[1], 1);
  await tagged(sCus[2], B, B);
  const s4 = await billing.createCustomer({ name: "S4", slug: `px-s4-${stamp}` });
  await db.query("UPDATE organizations SET stripe_customer_id = $2 WHERE id = $1", [sOrg[3], s4.id]);
  await billing.checkoutUrl(s4.id, A, "https://octillion.test/billing", { octillion_slug: `px-s4-${stamp}`, octillion_experiment: `other-${EXP}`, octillion_variant: A });
  const s4cs = (await billing.allCheckoutSessions(true)).find((x) => x.customer === s4.id)!;
  await mockPost(`/_mock/checkout/${s4cs.id}/complete`, {});
  // B2: M1 gets email 1, then subscribes: no email 2. M2 waits for the send window, subscribes meanwhile: no email 1.
  const CM = `pxm-${stamp}`, CW = `pxw-${stamp}`, cusM1 = `cus_px_m1_${stamp}`, cusM2 = `cus_px_m2_${stamp}`;
  const oM1 = await org(`px-m1-${stamp}`, { ago: "4 days", customer: cusM1 }), oM2 = await org(`px-m2-${stamp}`, { ago: "4 days", customer: cusM2 });
  const em1 = `px-m1+${stamp}@px.dev`, em2 = `px-m2+${stamp}@px.dev`;
  await request(em1, CM, { org_id: oM1 }); await request(em2, CW, { org_id: oM2 });
  await expose(oM1, A, "Px A", "3 days 1 hour"); await expose(oM2, A, "Px A", "3 days 1 hour");
  fresh();
  const create = async (name: string, campaign: string, trigger: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const id = (await json(adm("POST", "/gtm/campaigns", { name, audience: { include: "accounts", utm_campaign: campaign }, steps: step, conversion_days: 14, trigger, ...extra }))).campaign.id as number;
    campaigns.push(id);
    await json(adm("POST", `/gtm/campaigns/${id}/launch`, {}));
    // Launched three days ago: W's exposure (3 days 1 hour ago) is within the 2 days before launch allowed.
    await db.query("UPDATE gtm_campaigns SET launched_at = now() - interval '3 days' WHERE id = $1", [id]);
    return id;
  };
  const c3 = await create(`Px no checkout 3d ${stamp}`, C3, { type: "pricing_no_checkout", experiment: EXP, days: 3 });
  const c7 = await create(`Px no checkout 7d ${stamp}`, C7, { type: "pricing_no_checkout", experiment: EXP, days: 7 });
  const cd = await create(`Px no checkout delayed ${stamp}`, CD, { type: "pricing_no_checkout", days: 3, delay_hours: 24 });
  const camp = (id: number) => (e: any) => e.tags?.some((t: any) => t.name === "campaign" && t.value === String(id));
  await json(adm("POST", `/gtm/campaigns/${c3}/send-now`));
  assert.equal(sentTo(ew, "campaign").filter(camp(c3)).length, 1, "fires for an account shown pricing N days ago with no checkout");
  assert.equal(sentTo(eu, "campaign").filter(camp(c3)).length, 0, "never after a checkout (a subscription tagged with the experiment)");
  assert.equal(sentTo(et, "campaign").filter(camp(c3)).length, 0, "not before N days");
  await json(adm("POST", `/gtm/campaigns/${c3}/send-now`));
  assert.equal(sentTo(ew, "campaign").filter(camp(c3)).length, 1, "once");
  const evW = await db.query<any>("SELECT data, at FROM gtm_events WHERE org_id = $1 AND type = 'pricing_no_checkout'", [oW]);
  assert.ok(evW.length === 1 && evW[0].data.experiment === EXP && evW[0].data.variant === A && evW[0].data.days === 3 && !JSON.stringify(evW).includes("@"),
    `one event, idempotent, no address in it: ${JSON.stringify(evW)}`);
  assert.equal(await ev.detectPricingNoCheckout([{ experiment: EXP, days: 3, since: Date.now() - 5 * 86_400_000 }]), 0, "the detector again: nothing new (idempotent keys)");
  assert.equal((await db.query("SELECT 1 FROM gtm_events WHERE org_id = ANY($1::int[]) AND type = 'pricing_no_checkout'", [[oU, oT]])).length, 0, "no event for U (checked out) or T (too soon)");
  for (const [i, why] of ["a subscription from before the experiment (untagged)", "an untagged subscription after the exposure", "a purchase of the other variant", "a checkout under another experiment"].entries()) {
    assert.equal(sentTo(sMail[i], "campaign").length, 0, `never mailed: ${why}`);
    assert.equal((await db.query("SELECT 1 FROM gtm_events WHERE org_id = $1 AND type = 'pricing_no_checkout'", [sOrg[i]])).length, 0, `no event: ${why}`);
  }
  // V: shown before the 7-day campaign launched (less 2 days): never news, at the detector and at the queue.
  await json(adm("POST", `/gtm/campaigns/${c7}/send-now`));
  assert.equal(sentTo(evv, "campaign").length, 0, "an exposure from before the launch never fires");
  assert.equal(await ev.detectPricingNoCheckout([{ experiment: EXP, days: 7, since: Date.now() - 5 * 86_400_000 }]), 0, "the detector skips exposures before the launch");
  assert.equal(await ev.detectPricingNoCheckout([{ experiment: EXP, days: 7, since: -Infinity }]), 1, "(only the launch rule held it back)");
  await json(adm("POST", `/gtm/campaigns/${c7}/send-now`));
  assert.equal(sentTo(evv, "campaign").length, 0, "and the campaign's queue refuses an event about an exposure from before its launch");
  assert.equal(await ev.detectPricingNoCheckout([{ experiment: EXP, days: 3, since: -Infinity }], { now: Date.now() + 3 * 86_400_000 }), 0,
    "an exposure whose N days ran out more than 24 hours ago is not news");
  // A delay: queued, then the account checks out before it is due: checked again, not enrolled.
  await json(adm("POST", `/gtm/campaigns/${cd}/send-now`));
  const [q] = await db.query<any>("SELECT ee.processed_at FROM gtm_event_enrolments ee JOIN gtm_events e ON e.id = ee.event_id WHERE ee.campaign_id = $1 AND e.org_id = $2", [cd, oW2]);
  assert.ok(q && !q.processed_at, "queued for the trigger's delay");
  await tagged(cusW2, A, A);
  fresh();
  await db.query("UPDATE gtm_event_enrolments SET due_at = now() WHERE campaign_id = $1", [cd]);
  await json(adm("POST", `/gtm/campaigns/${cd}/send-now`));
  const [done] = await db.query<any>("SELECT ee.processed_at, ee.note, ee.enrolled FROM gtm_event_enrolments ee JOIN gtm_events e ON e.id = ee.event_id WHERE ee.campaign_id = $1 AND e.org_id = $2", [cd, oW2]);
  assert.ok(done.processed_at && /Checked out/.test(done.note) && done.enrolled === 0 && sentTo(ew2, "campaign").length === 0, `checked out during the delay: not enrolled: ${JSON.stringify(done)}`);

  // B2: before every email, a fresh purchase check. Bought after email 1: no email 2.
  const twoSteps = [step[0], { subject: "One more thing about plans", body: "Hi {{first_name}}, still here if you have questions.", delay_days: 1 }];
  const cm = await create(`Px two emails ${stamp}`, CM, { type: "pricing_no_checkout", experiment: EXP, days: 3 }, { steps: twoSteps });
  await json(adm("POST", `/gtm/campaigns/${cm}/send-now`));
  assert.equal(sentTo(em1, "campaign").filter(camp(cm)).length, 1, "email 1 goes");
  await untagged(cusM1, 0);
  await db.query("UPDATE gtm_campaign_recipients SET next_at = now() WHERE campaign_id = $1", [cm]);
  await json(adm("POST", `/gtm/campaigns/${cm}/send-now`));
  const [rm] = await db.query<any>("SELECT status, next_at FROM gtm_campaign_recipients WHERE campaign_id = $1", [cm]);
  const [nm] = await db.query<any>("SELECT ee.note FROM gtm_event_enrolments ee JOIN gtm_events e ON e.id = ee.event_id WHERE ee.campaign_id = $1 AND e.org_id = $2", [cm, oM1]);
  assert.ok(sentTo(em1, "campaign").filter(camp(cm)).length === 1 && rm.status === "done" && rm.next_at == null && /Checked out before email 2/.test(nm?.note ?? ""),
    `subscribed after email 1 (read fresh, not from the cache): no email 2: ${JSON.stringify({ rm, nm })}`);
  // Waiting for the send window when the account subscribes: no email 1. The window: one weekday three days from today (closed in every zone).
  const isoToday = ((new Date().getUTCDay() + 6) % 7) + 1, closed = ((isoToday + 2) % 7) + 1;
  const cw = await create(`Px window ${stamp}`, CW, { type: "pricing_no_checkout", experiment: EXP, days: 3 }, { send_window: { days: [closed], start_hour: 0, end_hour: 24, time_zone: "UTC" } });
  await json(adm("POST", `/gtm/campaigns/${cw}/send-now`));
  const [rw0] = await db.query<any>("SELECT status, next_at > now() + interval '1 hour' AS later FROM gtm_campaign_recipients WHERE campaign_id = $1", [cw]);
  assert.ok(rw0 && rw0.status === "pending" && rw0.later && sentTo(em2, "campaign").length === 0, `enrolled, waiting for the window: ${JSON.stringify(rw0)}`);
  await untagged(cusM2, 0);
  await db.query(`UPDATE gtm_campaigns SET send_window = '{"days":[],"start_hour":0,"end_hour":24,"time_zone":"UTC"}'::jsonb WHERE id = $1`, [cw]);
  await db.query("UPDATE gtm_campaign_recipients SET next_at = now() WHERE campaign_id = $1", [cw]);
  await json(adm("POST", `/gtm/campaigns/${cw}/send-now`));
  const [rw] = await db.query<any>("SELECT status FROM gtm_campaign_recipients WHERE campaign_id = $1", [cw]);
  assert.ok(rw.status === "done" && sentTo(em2, "campaign").length === 0, `subscribed while waiting for the window: no email 1: ${JSON.stringify(rw)}`);

  // Stripe lists cut at the cap are unknown: experimentOutcomes reports it, and the detector emits nothing (src/billing.ts LIST_CAP).
  assert.equal(billing.LIST_CAP, 5000);
  const E = await import("../src/experiments.js");
  assert.equal((await E.experimentOutcomes(Date.now(), { deadline: Date.now() - 1 })).error !== null || !billing.stripeEnabled(), true, "out of time: an error, nothing to act on");

  // ---------- deep links: FinOps › Experiments -> GTM, and GTM -> FinOps ----------
  const spend = readFileSync("web/src/features/admin/spend.tsx", "utf8"), common = readFileSync("web/src/features/admin/gtm-common.tsx", "utf8");
  assert.ok(spend.includes("`/admin/gtm/${tab}?experiment=${encodeURIComponent(experiment)}`") && /Open in GTM Activation/.test(spend) && /Open in GTM Attribution/.test(spend),
    "each experiment row and its peek link to GTM Activation and Attribution with the experiment chosen");
  assert.ok(/<GtmLinks experiment=\{v\.experiment\} \/>/.test(spend) && /key: 'gtm', label: 'GTM', hidden: true/.test(spend), "labelled buttons in the peek's card, the row's menu, and a GTM column (hidden by default)");
  assert.ok(/get\('experiment'\)/.test(spend), "FinOps › Experiments reads the experiment GTM links to");
  assert.ok(common.includes("`/admin/finops?section=experiments&experiment=${encodeURIComponent(experiment)}`") && /Open in FinOps/.test(common) && /p\.get\('experiment'\)/.test(common),
    "GTM keeps the experiment in the URL and links back to FinOps");
  for (const f of ["gtm-activation.tsx", "gtm-attribution.tsx"]) assert.ok(/<ExperimentPicker p=\{p\}/.test(readFileSync(`web/src/features/admin/${f}`, "utf8")), `${f}: the Pricing experiment selector`);

  for (const id of campaigns) await db.query("DELETE FROM gtm_campaigns WHERE id = $1", [id]);
  await db.query("DELETE FROM gtm_events WHERE org_id = ANY($1::int[])", [orgs]);
  await db.query("DELETE FROM access_requests WHERE id = ANY($1::int[])", [requests]);
  await db.query("DELETE FROM organizations WHERE id = ANY($1::int[])", [orgs]);
  fresh();
  console.log("✓ GTM × pricing experiments: Activation split by variant (not shown pricing column, Paid on the variant bought), Attribution per variant, Saw pricing variant audience, Saw pricing / no checkout trigger (N days, launch, max age, any purchase blocks it: untagged, pre-existing, other variant, other experiment; fresh re-check when due and before every email incl. after the window; idempotent), FinOps <-> GTM links, defaults unchanged");
}
