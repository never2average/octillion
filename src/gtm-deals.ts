/**
 * GTM › Deals (/admin/gtm/deals) and outbound in Attribution. A deal is an opportunity with a company, a prospect or
 * an Octillion account, on a pipeline of configurable stages (gtm_deal_stages: lead, qualified, demo, proposal, won,
 * lost by default; each open, won or lost). Board (drag between columns) and table views; one click from a reply or a
 * prospect makes one. Owners only to change; any admin reads.
 *
 *   revenue      a won deal linked to an account shows that account's Stripe revenue now (MRR, paying), from the
 *                same journeys Activation uses (src/gtm.ts); a deal's company or prospect linked to an account links
 *                the deal too when it is won
 *   attribution  outboundAttribution (GET /gtm/attribution/outbound): FIRST TOUCH. A prospect who later requests
 *                access or gets an account is credited to the outbound campaign that emailed them first (their
 *                earliest first_sent_at), and only when that email came before the conversion. Deals carry the
 *                campaign too (the reply's, else the prospect's first touch), so pipeline (open deals' value) and won
 *                value (won deals closed in the period) show per campaign and per prospect source (csv, apollo,
 *                manual). Channels: requests and accounts of the period split into outbound (credited as above) and
 *                inbound (everything else, by UTM on the Attribution table).
 */
import { getDb } from "./db.js";
import { AdminError, log, STAGES } from "./admin.js";
import { reportRange } from "./insights.js";
import { journeys } from "./gtm.js";
import { activity } from "./gtm-crm.js";

const fail = (msg: string, status = 400): never => { throw new AdminError(msg, status); };
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const idOf = (v: unknown, what: string) => { const n = Number(v); if (!Number.isSafeInteger(n) || n <= 0) fail(`Invalid ${what} id`); return n; };
const optId = (v: unknown, what: string) => (v == null || v === "" ? null : idOf(v, what));
const r2 = (x: number) => Math.round(x * 100) / 100;
export const ATTRIBUTION_MODEL = "first_touch";

export interface Stage { id: string; label: string; position: number; kind: "open" | "won" | "lost" }
export async function stages(): Promise<Stage[]> {
  return (await (await getDb()).query<Stage>("SELECT id, label, position, kind FROM gtm_deal_stages ORDER BY position, id")).map((s) => ({ ...s, position: Number(s.position) }));
}

/**
 * Replace the pipeline: the stages in order, each {id?, label, kind}. A stage with deals can be renamed or moved but
 * not removed (move its deals first). At least one open, one won and one lost stage.
 */
export async function setStages(actor: string, body: { stages?: unknown }) {
  const list = Array.isArray(body.stages) ? body.stages : fail("stages must be a list");
  if (list.length < 3 || list.length > 20) fail("3 to 20 stages");
  const want = list.map((x, i) => {
    const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const label = str(o.label, 60) || fail(`Stage ${i + 1} needs a name`);
    const id = str(o.id, 40) || label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || `stage_${i + 1}`;
    if (!/^[a-z0-9_]{1,40}$/.test(id)) fail(`Stage id ${id}: lowercase letters, digits and _`);
    const kind = ["open", "won", "lost"].includes(String(o.kind)) ? (o.kind as Stage["kind"]) : "open";
    return { id, label, kind, position: i + 1 };
  });
  if (new Set(want.map((s) => s.id)).size !== want.length) fail("Two stages have the same id");
  for (const k of ["open", "won", "lost"]) if (!want.some((s) => s.kind === k)) fail(`The pipeline needs a ${k} stage`);
  const db = await getDb();
  const used = await db.query<{ stage: string; n: number }>("SELECT stage, count(*)::int AS n FROM gtm_deals GROUP BY stage");
  const gone = used.filter((u) => !want.some((s) => s.id === u.stage));
  if (gone.length) fail(`Move the deals out of ${gone.map((g) => `${g.stage} (${g.n})`).join(", ")} before removing it`, 409);
  await db.transaction(async (tx) => {
    for (const s of want) await tx.query(
      "INSERT INTO gtm_deal_stages (id, label, position, kind) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET label = excluded.label, position = excluded.position, kind = excluded.kind",
      [s.id, s.label, s.position, s.kind]);
    await tx.query("DELETE FROM gtm_deal_stages WHERE NOT (id = ANY($1::text[]))", [want.map((s) => s.id)]);
  });
  log(actor, "gtm.deal_stages", null, { stages: want.map((s) => s.id) });
  return { stages: await stages() };
}

// ---------- deals ----------

const DCOLS = `d.id, d.name, d.stage, d.company_id, c.name AS company, c.domain AS company_domain, d.prospect_id,
  nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '') AS prospect, d.org_id, o.slug AS org_slug, o.name AS org_name,
  d.campaign_id, k.name AS campaign, d.reply_id, d.value::float8 AS value, d.currency, to_char(d.expected_close, 'YYYY-MM-DD') AS expected_close, d.owner, d.lost_reason,
  d.position, d.source, d.created_at, d.updated_at, d.closed_at`;
const DFROM = `gtm_deals d LEFT JOIN gtm_companies c ON c.id = d.company_id LEFT JOIN gtm_prospects p ON p.id = d.prospect_id
  LEFT JOIN organizations o ON o.id = d.org_id LEFT JOIN gtm_campaigns k ON k.id = d.campaign_id`;

/** Every deal with its stage, links and (won and linked to an account) that account's Stripe revenue now. */
export async function listDeals() {
  const db = await getDb();
  const [st, rows] = await Promise.all([stages(), db.query<Record<string, unknown> & { id: number; org_id: number | null; stage: string; value: number }>(
    `SELECT ${DCOLS} FROM ${DFROM} ORDER BY d.position, d.id`)]);
  const kind = new Map(st.map((s) => [s.id, s.kind]));
  // Stripe through the accounts' journeys, only when a deal is linked to one.
  const linked = rows.some((r) => r.org_id != null);
  const data = linked ? await journeys().catch(() => null) : null;
  const rev = new Map((data?.journeys ?? []).map((j) => [Number(j.org.id), { paying: j.paying, mrr_usd: j.mrr_usd, plan: j.plan }]));
  const deals = rows.map((r) => ({ ...r, id: Number(r.id), value: Number(r.value), kind: kind.get(r.stage) ?? "open",
    revenue: r.org_id != null ? rev.get(Number(r.org_id)) ?? null : null }));
  const sum = (k: string) => r2(deals.filter((d) => d.kind === k).reduce((t, d) => t + d.value, 0));
  return {
    stages: st, deals, stripe_error: data?.stripe_error ?? null,
    totals: { open: sum("open"), won: sum("won"), lost: sum("lost"), count: deals.length, won_mrr_usd: r2(deals.filter((d) => d.kind === "won").reduce((t, d) => t + (d.revenue?.mrr_usd ?? 0), 0)) },
  };
}

export async function dealDetail(id: number) {
  const [d] = await (await getDb()).query<Record<string, unknown>>(`SELECT ${DCOLS} FROM ${DFROM} WHERE d.id = $1`, [idOf(id, "deal")]);
  if (!d) fail(`No deal ${id}`, 404);
  return { deal: { ...d, id: Number(d.id) } };
}

interface DealInput { name?: unknown; stage?: unknown; company_id?: unknown; prospect_id?: unknown; org?: unknown; value?: unknown; currency?: unknown; expected_close?: unknown;
  owner?: unknown; lost_reason?: unknown; campaign_id?: unknown; source?: unknown; reply_id?: unknown; prospect?: unknown }

async function dealFields(b: DealInput, partial: boolean) {
  const out: Record<string, unknown> = {};
  const st = await stages();
  if (!partial || b.name !== undefined) out.name = str(b.name, 160) || fail("Give the deal a name");
  if (!partial || b.stage !== undefined) {
    const s = b.stage == null || b.stage === "" ? st.find((x) => x.kind === "open")!.id : String(b.stage);
    if (!st.some((x) => x.id === s)) fail(`Unknown stage ${s}: use ${st.map((x) => x.id).join(", ")}`);
    out.stage = s;
  }
  if (!partial || b.company_id !== undefined) out.company_id = optId(b.company_id, "company");
  if (!partial || b.prospect_id !== undefined) out.prospect_id = optId(b.prospect_id, "prospect");
  if (!partial || b.org !== undefined) {
    if (b.org == null || b.org === "") out.org_id = null;
    else {
      const [o] = await (await getDb()).query<{ id: number }>("SELECT id FROM organizations WHERE slug = $1 OR id::text = $1", [String(b.org)]);
      out.org_id = o ? Number(o.id) : fail(`No account ${String(b.org)}`);
    }
  }
  if (!partial || b.value !== undefined) {
    const v = b.value == null || b.value === "" ? 0 : Number(b.value);
    if (!Number.isFinite(v) || v < 0 || v > 1e12) fail("value is an amount, 0 or more");
    out.value = Math.round(v * 100) / 100;
  }
  if (!partial || b.currency !== undefined) {
    const c = (str(b.currency, 3) || "USD").toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) fail("currency is a three-letter code, e.g. USD");
    out.currency = c;
  }
  if (!partial || b.expected_close !== undefined) {
    const d = b.expected_close;
    if (d != null && d !== "" && (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d))) fail("expected_close is a date, YYYY-MM-DD");
    out.expected_close = d || null;
  }
  if (!partial || b.owner !== undefined) out.owner = str(b.owner, 120) || null;
  if (!partial || b.lost_reason !== undefined) out.lost_reason = str(b.lost_reason, 500) || null;
  if (!partial || b.campaign_id !== undefined) out.campaign_id = optId(b.campaign_id, "campaign");
  if (!partial || b.source !== undefined) out.source = str(b.source, 40) || null;
  return out;
}

/** The outbound campaign that emailed a prospect first (attribution), or null. */
async function firstTouch(prospectId: number | null | undefined): Promise<number | null> {
  if (prospectId == null) return null;
  const [r] = await (await getDb()).query<{ campaign_id: number }>(
    "SELECT campaign_id FROM gtm_campaign_recipients WHERE prospect_id = $1 AND first_sent_at IS NOT NULL ORDER BY first_sent_at, id LIMIT 1", [prospectId]);
  return r ? Number(r.campaign_id) : null;
}

/** On a won stage: closed now, and linked to the account its company or prospect became (when not set). */
async function closeWon(id: number) {
  await (await getDb()).query(
    `UPDATE gtm_deals d SET closed_at = coalesce(d.closed_at, now()),
            org_id = coalesce(d.org_id, (SELECT p.org_id FROM gtm_prospects p WHERE p.id = d.prospect_id), (SELECT c.org_id FROM gtm_companies c WHERE c.id = d.company_id))
      WHERE d.id = $1`, [id]);
}
async function afterStage(id: number, stage: string) {
  const kind = (await stages()).find((s) => s.id === stage)?.kind;
  if (kind === "won") await closeWon(id);
  else if (kind === "lost") await (await getDb()).query("UPDATE gtm_deals SET closed_at = coalesce(closed_at, now()) WHERE id = $1", [id]);
  else await (await getDb()).query("UPDATE gtm_deals SET closed_at = NULL WHERE id = $1", [id]);
}

/**
 * A new deal. from_reply: the reply's prospect, company and campaign, named after the company; from prospect_id
 * alone: theirs, with their first-touch campaign. One click from the Replies inbox or a prospect.
 */
export async function createDeal(actor: string, body: DealInput & { from_reply?: unknown }) {
  const db = await getDb();
  const b: DealInput = { ...body };
  if (body.from_reply != null) {
    const [y] = await db.query<{ id: number; campaign_id: number; prospect_id: number | null; org_id: number | null; first_name: string | null }>(
      `SELECT y.id, y.campaign_id, r.prospect_id, r.org_id, r.first_name FROM gtm_replies y JOIN gtm_campaign_recipients r ON r.id = y.recipient_id WHERE y.id = $1`, [idOf(body.from_reply, "reply")]);
    if (!y) fail(`No reply ${body.from_reply}`, 404);
    Object.assign(b, { reply_id: Number(y.id), prospect_id: b.prospect_id ?? y.prospect_id, campaign_id: b.campaign_id ?? Number(y.campaign_id),
      source: b.source ?? (y.prospect_id != null ? "outbound" : "lifecycle") });
    if (y.org_id != null && b.org == null) b.org = String(y.org_id);
  }
  const pid = b.prospect_id == null || b.prospect_id === "" ? null : idOf(b.prospect_id, "prospect");
  if (pid != null) {
    const [p] = await db.query<{ company_id: number | null; company: string | null; first_name: string | null; last_name: string | null; org_id: number | null }>(
      `SELECT p.company_id, c.name AS company, p.first_name, p.last_name, p.org_id FROM gtm_prospects p LEFT JOIN gtm_companies c ON c.id = p.company_id WHERE p.id = $1`, [pid]);
    if (!p) fail(`No prospect ${pid}`, 404);
    b.company_id ??= p.company_id;
    b.name ??= p.company ?? ([p.first_name, p.last_name].filter(Boolean).join(" ") || `Prospect ${pid}`);
    b.campaign_id ??= await firstTouch(pid);
    b.source ??= b.campaign_id ? "outbound" : "manual";
    if (p.org_id != null && b.org == null) b.org = String(p.org_id);
  }
  if (b.name == null && b.company_id != null) {
    const [c] = await db.query<{ name: string }>("SELECT name FROM gtm_companies WHERE id = $1", [idOf(b.company_id, "company")]);
    b.name = c?.name;
  }
  const f = await dealFields({ ...b, owner: b.owner ?? actor }, false);
  const [{ pos }] = await db.query<{ pos: number }>("SELECT coalesce(max(position), 0) + 1 AS pos FROM gtm_deals WHERE stage = $1", [f.stage]);
  const [r] = await db.query<{ id: number }>(
    `INSERT INTO gtm_deals (name, stage, company_id, prospect_id, org_id, campaign_id, reply_id, value, currency, expected_close, owner, lost_reason, source, position)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
    [f.name, f.stage, f.company_id, f.prospect_id, f.org_id, f.campaign_id, b.reply_id ?? null, f.value, f.currency, f.expected_close, f.owner, f.lost_reason, f.source, Number(pos)]);
  const id = Number(r.id);
  await afterStage(id, String(f.stage));
  if (f.prospect_id != null) await activity(Number(f.prospect_id), "deal", String(f.name), { deal_id: id, stage: f.stage, campaign_id: f.campaign_id }, actor);
  log(actor, "gtm.deal_create", null, { deal_id: id, stage: f.stage, from_reply: b.reply_id ?? null });
  return dealDetail(id);
}

export async function updateDeal(actor: string, id: number, body: DealInput) {
  const f = await dealFields(body, true);
  const keys = Object.keys(f);
  if (keys.length) {
    const r = await (await getDb()).query(`UPDATE gtm_deals SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1 RETURNING id`, [idOf(id, "deal"), ...keys.map((k) => f[k])]);
    if (!r.length) fail(`No deal ${id}`, 404);
    if (f.stage) await afterStage(id, String(f.stage));
  }
  log(actor, "gtm.deal_update", null, { deal_id: id, fields: keys });
  return dealDetail(id);
}

/** The board's drag: to a stage, before the deal `before` (or at the end of the column). */
export async function moveDeal(actor: string, id: number, body: { stage?: unknown; before?: unknown; lost_reason?: unknown }) {
  const db = await getDb();
  const st = await stages();
  const stage = String(body.stage ?? "");
  if (!st.some((s) => s.id === stage)) fail(`Unknown stage ${stage}`);
  const [cur] = await db.query<{ stage: string }>("SELECT stage FROM gtm_deals WHERE id = $1", [idOf(id, "deal")]);
  if (!cur) fail(`No deal ${id}`, 404);
  const col = await db.query<{ id: number; position: number }>("SELECT id, position FROM gtm_deals WHERE stage = $1 AND id <> $2 ORDER BY position, id", [stage, id]);
  const before = optId(body.before, "deal");
  const k = before == null ? -1 : col.findIndex((d) => Number(d.id) === before);
  // Between its neighbours (no renumbering): the midpoint, or one past the last.
  const pos = k < 0 ? (col.length ? Number(col[col.length - 1].position) + 1 : 1) : k === 0 ? Number(col[0].position) - 1 : (Number(col[k - 1].position) + Number(col[k].position)) / 2;
  await db.query("UPDATE gtm_deals SET stage = $2, position = $3, lost_reason = coalesce($4, lost_reason), updated_at = now() WHERE id = $1", [id, stage, pos, str(body.lost_reason, 500) || null]);
  if (cur.stage !== stage) {
    await afterStage(id, stage);
    const [d] = await db.query<{ prospect_id: number | null; name: string }>("SELECT prospect_id, name FROM gtm_deals WHERE id = $1", [id]);
    if (d?.prospect_id != null) await activity(Number(d.prospect_id), "deal", `${d.name}: ${st.find((s) => s.id === cur.stage)?.label ?? cur.stage} → ${st.find((s) => s.id === stage)!.label}`, { deal_id: id, stage }, actor);
  }
  log(actor, "gtm.deal_move", null, { deal_id: id, from: cur.stage, to: stage });
  return dealDetail(id);
}

export async function deleteDeal(actor: string, id: number) {
  const r = await (await getDb()).query("DELETE FROM gtm_deals WHERE id = $1 RETURNING id", [idOf(id, "deal")]);
  if (!r.length) fail(`No deal ${id}`, 404);
  log(actor, "gtm.deal_delete", null, { deal_id: id });
}

// ---------- outbound in Attribution ----------

/** GET /gtm/attribution/outbound: see the top of the file (first touch). */
export async function outboundAttribution(q: Record<string, unknown> = {}) {
  const range = reportRange(q);
  const db = await getDb();
  const inRange = (d: Date | string | null | undefined) => { if (!d) return false; const t = new Date(d).getTime(); return t >= range.start.getTime() && t < range.end.getTime(); };
  // Each prospect's first outbound email (the campaign credited), and what they did.
  const touches = await db.query<{ prospect_id: number; campaign_id: number; first_sent_at: Date; source: string; status: string; request_id: number | null; org_id: number | null;
    replied: boolean }>(
    `SELECT DISTINCT ON (r.prospect_id) r.prospect_id, r.campaign_id, r.first_sent_at, p.source, p.status, p.request_id, p.org_id,
            EXISTS (SELECT 1 FROM gtm_campaign_recipients x WHERE x.prospect_id = r.prospect_id AND x.replied_at IS NOT NULL) AS replied
       FROM gtm_campaign_recipients r JOIN gtm_prospects p ON p.id = r.prospect_id
      WHERE r.prospect_id IS NOT NULL AND r.first_sent_at IS NOT NULL ORDER BY r.prospect_id, r.first_sent_at, r.id`);
  const campaigns = new Map((await db.query<{ id: number; name: string; status: string }>("SELECT id, name, status FROM gtm_campaigns WHERE audience->>'include' = 'prospects' OR id = ANY($1::bigint[])",
    [[...new Set(touches.map((t) => Number(t.campaign_id)))]])).map((c) => [Number(c.id), c]));
  const reqs = new Map((await db.query<{ id: number; created_at: Date }>("SELECT id, created_at FROM access_requests WHERE id = ANY($1::int[])",
    [touches.flatMap((t) => (t.request_id != null ? [Number(t.request_id)] : []))])).map((r) => [Number(r.id), new Date(r.created_at)]));
  const data = await journeys().catch(() => null);
  const byOrg = new Map((data?.journeys ?? []).map((j) => [Number(j.org.id), j]));
  const [st, deals] = await Promise.all([stages(), db.query<{ campaign_id: number | null; prospect_id: number | null; value: number; stage: string; closed_at: Date | null; source: string | null; psource: string | null }>(
    `SELECT d.campaign_id, d.prospect_id, d.value::float8 AS value, d.stage, d.closed_at, d.source, p.source AS psource FROM gtm_deals d LEFT JOIN gtm_prospects p ON p.id = d.prospect_id`)]);
  const kind = new Map(st.map((s) => [s.id, s.kind]));
  const firstBy = new Map(touches.map((t) => [Number(t.prospect_id), Number(t.campaign_id)]));

  type Row = { key: string; label: string; touched: number; replied: number; interested: number; requests: number; accounts: Set<number>; pipeline: number; won: number; deals_won: number };
  const blank = (key: string, label: string): Row => ({ key, label, touched: 0, replied: 0, interested: 0, requests: 0, accounts: new Set(), pipeline: 0, won: 0, deals_won: 0 });
  const byCampaign = new Map<string, Row>(), bySource = new Map<string, Row>();
  const rowsFor = (campaignId: number | null, source: string | null) => {
    const ck = campaignId == null ? "none" : String(campaignId), sk = source || "manual";
    if (!byCampaign.has(ck)) byCampaign.set(ck, blank(ck, campaignId == null ? "No campaign" : campaigns.get(campaignId)?.name ?? `Campaign ${campaignId}`));
    if (!bySource.has(sk)) bySource.set(sk, blank(sk, sk));
    return [byCampaign.get(ck)!, bySource.get(sk)!];
  };
  const outboundRequests = new Set<number>(), outboundOrgs = new Set<number>();
  for (const t of touches) {
    const rows = rowsFor(Number(t.campaign_id), t.source);
    const first = new Date(t.first_sent_at).getTime();
    if (inRange(t.first_sent_at)) for (const r of rows) { r.touched++; if (t.replied) r.replied++; if (t.status === "interested") r.interested++; }
    // Credited only when the first email came before the conversion.
    const reqAt = t.request_id != null ? reqs.get(Number(t.request_id)) : undefined;
    if (reqAt && reqAt.getTime() >= first && inRange(reqAt)) { outboundRequests.add(Number(t.request_id)); for (const r of rows) r.requests++; }
    const j = t.org_id != null ? byOrg.get(Number(t.org_id)) : undefined;
    if (j && new Date(j.created_at).getTime() >= first && inRange(j.created_at)) { outboundOrgs.add(Number(j.org.id)); for (const r of rows) r.accounts.add(Number(j.org.id)); }
  }
  for (const d of deals) {
    const cid = d.campaign_id != null ? Number(d.campaign_id) : d.prospect_id != null ? firstBy.get(Number(d.prospect_id)) ?? null : null;
    if (cid == null && d.source !== "outbound") continue;
    const rows = rowsFor(cid, d.psource);
    const k = kind.get(d.stage);
    for (const r of rows) {
      if (k === "open") r.pipeline += Number(d.value);
      if (k === "won" && inRange(d.closed_at)) { r.won += Number(d.value); r.deals_won++; }
    }
  }
  const simulated = STAGES.findIndex((s) => s.id === "simulated"); // activated: reached a first simulation (as Attribution)
  const shape = (r: Row) => {
    const js = [...r.accounts].map((id) => byOrg.get(id)!).filter(Boolean);
    const paying = js.filter((j) => j.paying);
    return { key: r.key, label: r.label, touched: r.touched, replied: r.replied, interested: r.interested, requests: r.requests, accounts: js.length,
      activated: js.filter((j) => j.org.stage_index >= simulated).length, paying: paying.length, mrr_usd: r2(paying.reduce((t, j) => t + j.mrr_usd, 0)),
      pipeline: r2(r.pipeline), won: r2(r.won), deals_won: r.deals_won, account_list: js.map((j) => ({ slug: j.org.slug, name: j.org.name, paying: j.paying, mrr_usd: j.mrr_usd })) };
  };
  const sort = (xs: ReturnType<typeof shape>[]) => xs.sort((a, b) => b.won - a.won || b.pipeline - a.pipeline || b.accounts - a.accounts || b.touched - a.touched);
  // Channels: the period's requests and accounts, outbound (credited) or inbound (the rest).
  const allReqs = (data?.requests ?? []).filter((r) => inRange(r.created_at));
  const allOrgs = (data?.journeys ?? []).filter((j) => inRange(j.created_at));
  const channel = (name: string, label: string, reqIds: number[], orgs: typeof allOrgs) => {
    const paying = orgs.filter((j) => j.paying);
    return { channel: name, label, requests: reqIds.length, accounts: orgs.length, activated: orgs.filter((j) => j.org.stage_index >= simulated).length, paying: paying.length,
      mrr_usd: r2(paying.reduce((t, j) => t + j.mrr_usd, 0)) };
  };
  return {
    model: ATTRIBUTION_MODEL,
    model_text: "First touch: a prospect who requests access or gets an account is credited to the outbound campaign that emailed them first, when that email came before.",
    range: { from: range.from, to: range.to, days: range.days }, stripe_error: data?.stripe_error ?? null,
    channels: [
      channel("outbound", "Outbound", allReqs.filter((r) => outboundRequests.has(r.id)).map((r) => r.id), allOrgs.filter((j) => outboundOrgs.has(Number(j.org.id)))),
      channel("inbound", "Inbound (UTM / direct)", allReqs.filter((r) => !outboundRequests.has(r.id)).map((r) => r.id), allOrgs.filter((j) => !outboundOrgs.has(Number(j.org.id)))),
    ],
    campaigns: sort([...byCampaign.values()].map(shape)), sources: sort([...bySource.values()].map(shape)),
  };
}
