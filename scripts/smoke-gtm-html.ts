// HTML campaign emails (scripts/smoke-gtm.ts runs these after phase 2's): a step with format "html" is sanitized on
// save and at render, sent with a generated text part and the footer inside the HTML; variables cannot inject markup;
// text steps are unchanged; outbound (prospects) refuses HTML; the preview endpoint needs the campaigns permission.
// Against the Resend mock: no real email is ever sent.
import assert from "node:assert/strict";

type Db = { query: <T = any>(sql: string, params?: unknown[]) => Promise<T[]> };

export async function gtmHtmlChecks({ db, base, adm, json, mockPost, sentTo, stamp }: {
  db: Db; base: string; adm: (method: string, path: string, body?: unknown) => Promise<Response>; json: (r: Response | Promise<Response>) => Promise<any>;
  mockUrl: string; mockPost: (path: string, body?: unknown) => Promise<any>; sentTo: (to: string, kind?: string) => any[]; stamp: string;
}) {
  const camp = await import("../src/campaigns.js");
  const { createAdminToken } = await import("../src/admin-tokens.js");
  const errOf = async (r: Response | Promise<Response>) => { const x = await r; return { status: x.status, error: String(((await x.json().catch(() => ({}))) as any).error ?? "") }; };
  const H = `html-${stamp}`, hana = `hana+${stamp}@gtm-h.dev`, ivo = `ivo+${stamp}@gtm-i.dev`;
  const src = JSON.stringify({ utm_source: "newsletter", utm_medium: "email", utm_campaign: H, country: "US" });
  const reqIds = [] as number[];
  for (const [email, name] of [[hana, "Hana Example"], [ivo, "Ivo Example"]])
    reqIds.push((await db.query<{ id: number }>("INSERT INTO access_requests (email, company, name, source) VALUES ($1, 'Html Co', $2, $3::jsonb) RETURNING id", [email, name, src]))[0].id);
  process.env.CAMPAIGN_SEND_INTERVAL_MS = "0";

  const EVIL = `<!doctype html><html><head><title>t</title><style>p{color:red}</style></head><body style="background:#f3f4f6" onload="steal()">
<script>alert(1)</script><iframe src="https://evil.example/"></iframe><form action="https://evil.example/"><input name="q"></form>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td bgcolor="#ffffff" style="padding:24px;background:url(javascript:alert(1));width:expression(alert(1));color:#111827">
<h1>Hi {{first_name}}</h1><p>Your {{product}} is ready.</p>
<img src="x" onerror="alert(1)" alt="broken"><img src="data:image/png;base64,AAAA" alt="inline"><img src="https://cdn.octillion.test/logo.png" alt="Octillion" width="120">
<a href="javascript:alert(1)">bad link</a> <a href="JaVaScRiPt:alert(2)">bad 2</a>
<a href="https://octillion.test/app?utm_source=email" target="_top" style="background:#2563eb;color:#ffffff;padding:10px 18px">Run a simulation</a>
</td></tr></table></body></html>`;
  const STRIPPED = /<script|<iframe|<form|<input|<style|onerror|onload|javascript:|expression\(|data:image|steal\(\)/i;

  // ---------- save: format validated, the HTML sanitized, what was stripped reported ----------
  const bad = await errOf(adm("POST", "/gtm/campaigns", { name: `Html bad ${stamp}`, audience: { include: "requests", utm_campaign: H }, steps: [{ subject: "x", body: "<p>x</p>", format: "markdown" }] }));
  assert.ok(bad.status === 400 && /format is text or html/.test(bad.error), `an unknown format is refused: ${JSON.stringify(bad)}`);
  const huge = await errOf(adm("POST", "/gtm/campaigns", { name: `Html huge ${stamp}`, audience: { include: "requests", utm_campaign: H }, steps: [{ subject: "x", body: `<p>${"x".repeat(100_001)}</p>`, format: "html" }] }));
  assert.ok(huge.status === 400 && /over 100 KB/.test(huge.error), `HTML over 100 KB is refused, not cut: ${JSON.stringify(huge)}`);
  const empty = await errOf(adm("POST", "/gtm/campaigns", { name: `Html empty ${stamp}`, audience: { include: "requests", utm_campaign: H }, steps: [{ subject: "x", body: "<script>alert(1)</script>", format: "html" }] }));
  assert.ok(empty.status === 400 && /nothing left/.test(empty.error), `HTML that is all script is refused: ${JSON.stringify(empty)}`);

  const made = await json(adm("POST", "/gtm/campaigns", { name: `Html ${stamp}`, audience: { include: "requests", utm_campaign: H }, requires_opt_in: false,
    steps: [{ subject: "Hello {{first_name}}", body: EVIL, format: "html", delay_days: 0 }] }));
  const id = made.campaign.id as number;
  const stored = made.campaign.steps[0];
  assert.ok(stored.format === "html" && !STRIPPED.test(stored.body) && stored.body.includes('href="https://octillion.test/app?utm_source=email"') && stored.body.includes("{{first_name}}"),
    `stored sanitized, variables kept: ${stored.body}`);
  assert.ok(Array.isArray(made.html_warnings) && ["<script>", "<iframe>", "onerror", "onload", "javascript:alert(1)", "data:", "expression", "<style>"].every((w) => made.html_warnings.some((x: string) => x.includes(w))),
    `the save says what was stripped: ${JSON.stringify(made.html_warnings)}`);

  // ---------- send: sanitized HTML part, a generated text part, the footer and unsubscribe in both, headers ----------
  await json(adm("POST", `/gtm/campaigns/${id}/launch`, {}));
  const t = await json(adm("POST", "/gtm/tick"));
  assert.ok(!t.error, `tick: ${JSON.stringify(t)}`);
  const ofCampaign = (to: string) => sentTo(to, "campaign").filter((e: any) => e.tags?.some((x: any) => x.name === "campaign" && x.value === String(id)));
  const [e] = ofCampaign(hana);
  assert.ok(e, "the HTML email went out");
  assert.ok(e.html && !STRIPPED.test(e.html) && /^<!doctype html>/i.test(e.html) && e.html.includes("<h1>Hi Hana</h1>") && e.html.includes('target="_blank"') && e.html.includes('rel="noopener noreferrer"')
    && e.html.includes('src="https://cdn.octillion.test/logo.png"'), `a sanitized HTML document: ${e.html}`);
  const foot = e.html.lastIndexOf("/api/email/unsubscribe?t="), close = e.html.lastIndexOf("</body>");
  assert.ok(foot > 0 && foot < close && /asked for access to Octillion/.test(e.html) && /font-size:12px/.test(e.html), "the footer and unsubscribe link sit inside the HTML, before </body>, small and muted");
  assert.ok(e.text.includes("Hi Hana") && e.text.includes("Run a simulation (https://octillion.test/app?utm_source=email)") && !/<[a-z]/i.test(e.text.split("\n--\n")[0])
    && /Unsubscribe: \S+\/api\/email\/unsubscribe\?t=/.test(e.text), `a generated text part, links as text (url), the footer after: ${e.text}`);
  assert.ok(e.headers?.["List-Unsubscribe"]?.includes("/api/email/unsubscribe?t=") && e.headers?.["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click" && e.subject === "Hello Hana",
    "List-Unsubscribe headers and the subject's variables, as for text");
  // The stored replay payload carries the same HTML (an uncertain send repeats the very same request).
  const [send] = await db.query<{ payload: any }>("SELECT payload FROM gtm_campaign_sends WHERE campaign_id = $1 AND payload IS NOT NULL LIMIT 1", [id]).catch(() => [] as any[]);
  if (send?.payload) assert.ok(JSON.stringify(send.payload).includes("Run a simulation") && !STRIPPED.test(JSON.stringify(send.payload)), "the replay payload is the sanitized email");

  // ---------- variables are escaped text: no markup, no links, whatever the value ----------
  const inj = camp.composeEmail({ subject: "Hi {{first_name}}", body: '<p>Hi {{first_name}}, about {{product}}</p><a href="https://octillion.test/?p={{product}}">go</a>', format: "html" },
    { first_name: "<img src=x onerror=alert(1)>", product: '"><script>alert(1)</script> evil.example' }, "\n\n--\nUnsubscribe: https://octillion.test/u", true);
  assert.ok(inj.html && !/<script|<img|onerror/i.test(inj.html) && inj.html.includes("&lt;script&gt;") && inj.html.includes("Hi there,") && inj.html.includes("evil.‌example")
    && !/href="[^"]*"><script/.test(inj.html), `a variable cannot inject HTML (escaped, the name falls back, a dot never auto-links): ${inj.html}`);

  // ---------- text steps are unchanged ----------
  const footerText = "\n\n--\nUnsubscribe: https://octillion.test/u";
  const plain = camp.composeEmail({ subject: "Hi {{first_name}}", body: "Hi {{first_name}},\n\nSee https://octillion.test/app" }, { first_name: "Hana" }, footerText, true);
  assert.ok(plain.html === camp.renderHtml("Hi {{first_name}},\n\nSee https://octillion.test/app" + footerText, { first_name: "Hana" }) && plain.text === "Hi Hana,\n\nSee https://octillion.test/app" + footerText,
    "a text step renders exactly as before");
  assert.ok(camp.composeEmail({ subject: "s", body: "b" }, {}, footerText, false).textOnly === true, "and text only where it was (outbound without open tracking)");
  const textCamp = await json(adm("POST", "/gtm/campaigns", { name: `Html text ${stamp}`, audience: { include: "requests", utm_campaign: H }, steps: [{ subject: "s", body: "b" }] }));
  assert.ok(!("format" in textCamp.campaign.steps[0]) && !("html_warnings" in textCamp), "a text step is stored as it always was (no format key)");
  const ab = camp.parseSteps([{ subject: "s", variants: [{ subject: "A", body: "<p>A {{first_name}}</p>", format: "html", weight: 50 }, { subject: "B", body: "plain B", format: "text", weight: 50 }] }]);
  assert.ok(ab[0].format === "html" && ab[0].variants![0].format === "html" && !("format" in ab[0].variants![1]), `A/B variants carry their own format: ${JSON.stringify(ab)}`);

  // ---------- outbound (prospects) stays plain text ----------
  const ob = await errOf(adm("POST", "/gtm/campaigns", { name: `Html outbound ${stamp}`, audience: { include: "prospects", prospects: { tags: [H] } }, steps: [{ subject: "x", body: "<p>x</p>", format: "html" }] }));
  assert.ok(ob.status === 400 && /outbound campaign \(prospects\) stays plain text/.test(ob.error), `an HTML step on a prospects audience is refused: ${JSON.stringify(ob)}`);
  const sw = await errOf(adm("PUT", `/gtm/campaigns/${textCamp.campaign.id}`, { audience: { include: "prospects", prospects: { tags: [H] } }, steps: [{ subject: "x", body: "<p>x</p>", format: "html" }] }));
  assert.ok(sw.status === 400 && /stays plain text/.test(sw.error), `and on an edit that makes it outbound: ${JSON.stringify(sw)}`);
  const pvOb = await errOf(adm("POST", "/gtm/campaigns/preview", { body: "<p>x</p>", format: "html", audience: { include: "prospects" } }));
  assert.equal(pvOb.status, 400, "the preview refuses HTML for a prospects audience too");

  // ---------- the preview: sanitized, sample variables, the footer; the campaigns permission's ----------
  const pv = await json(adm("POST", "/gtm/campaigns/preview", { subject: "Hi {{first_name}}", body: EVIL, format: "html", vars: { first_name: "Zoe", product: "Widget" } }));
  assert.ok(pv.subject === "Hi Zoe" && pv.html.includes("<h1>Hi Zoe</h1>") && pv.html.includes("Your Widget is ready") && !STRIPPED.test(pv.html) && pv.html.includes("/api/email/unsubscribe?t=test")
    && pv.text.includes("Run a simulation (https://octillion.test/app?utm_source=email)") && pv.warnings.some((w: string) => w.includes("<script>")) && !pv.warnings.some((w: string) => w.startsWith("Step")),
    `preview: ${JSON.stringify({ ...pv, html: pv.html.slice(0, 200) })}`);
  const pvText = await json(adm("POST", "/gtm/campaigns/preview", { subject: "s", body: "Hi {{first_name}}" }));
  assert.ok(pvText.text.startsWith("Hi Ada") && pvText.html.includes("<p") && pvText.warnings.length === 0, "a text body previews as before");
  const viewer = (await createAdminToken({ label: `html-viewer-${stamp}`, role: "viewer", days: 1, createdBy: "smoke" })).token;
  const asViewer = await fetch(`${base}/api/admin/onboarding/gtm/campaigns/preview`, { method: "POST", headers: { authorization: `Bearer ${viewer}`, "content-type": "application/json" },
    body: JSON.stringify({ body: "<p>x</p>", format: "html" }) });
  assert.equal(asViewer.status, 403, "the preview needs the campaigns permission");
  await asViewer.text();

  // ---------- a test send of unsaved HTML: the same rendering, marked [Test] ----------
  const ts = await json(adm("POST", `/gtm/campaigns/${id}/test`, { to: `tester+${stamp}@gtm-h.dev`, subject: "Draft {{first_name}}", body: "<p>Draft <b>bold</b></p><script>x()</script>", format: "html" }));
  const [te] = sentTo(`tester+${stamp}@gtm-h.dev`, "campaign_test");
  assert.ok(ts.status === "sent" && te?.subject.startsWith("[Test] Draft") && te.html.includes("<b>bold</b>") && !/<script/.test(te.html) && te.text.includes("Draft bold")
    && ts.warnings.some((w: string) => w.includes("<script>")), `test send of unsaved HTML: ${JSON.stringify(ts)}`);

  // ---------- an uncertain HTML send is replayed as the very same request ----------
  const r2 = await json(adm("POST", "/gtm/campaigns", { name: `Html replay ${stamp}`, audience: { include: "requests", utm_campaign: H }, requires_opt_in: false,
    steps: [{ subject: "Replay", body: '<p>Replay <a href="https://octillion.test/r">here</a></p>', format: "html" }] }));
  await json(adm("POST", `/gtm/campaigns/${r2.campaign.id}/launch`, {}));
  await mockPost("/_mock/resend/outage", { down: true });
  const down = await json(adm("POST", `/gtm/campaigns/${r2.campaign.id}/send-now`));
  await mockPost("/_mock/resend/outage", { down: false });
  assert.ok(down.uncertain >= 1, `a 5xx leaves the HTML email uncertain: ${JSON.stringify(down)}`);
  await db.query("UPDATE gtm_campaign_sends SET uncertain_at = now() - interval '6 minutes', at = now() - interval '6 minutes' WHERE campaign_id = $1", [r2.campaign.id]);
  await json(adm("POST", "/gtm/tick"));
  const replayed = sentTo(hana, "campaign").filter((x: any) => x.subject === "Replay");
  assert.ok(replayed.length === 1 && replayed[0].html.includes('href="https://octillion.test/r"') && replayed[0].text.includes("here (https://octillion.test/r)"), "replayed once, with its HTML and text parts");

  await db.query("DELETE FROM gtm_campaigns WHERE id = ANY($1::bigint[])", [[id, textCamp.campaign.id, r2.campaign.id]]);
  await db.query("DELETE FROM access_requests WHERE id = ANY($1::int[])", [reqIds]);
  delete process.env.CAMPAIGN_SEND_INTERVAL_MS;
  console.log("✓ GTM HTML emails: sanitized on save and send (scripts, handlers, javascript:/data: URLs, CSS expressions stripped), generated text part, footer and unsubscribe inside, escaped variables, text unchanged, outbound refused, preview gated, test send, replay");
}
