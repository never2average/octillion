'use client';
// GTM › Attribution: where accounts came from (src/gtm.ts attribution). One row per utm_source / utm_medium /
// utm_campaign of the access requests made in the period, plus direct/unknown, through to paying accounts and MRR from
// Stripe. A row opens its accounts. The period lives in the URL; the export is the table's CSV. Below it, outbound
// (src/gtm-deals.ts outboundAttribution, first touch): outbound vs inbound, and per outbound campaign and source.
import { Suspense } from 'react';
import Link from 'next/link';
import PageContainer from '@/components/layout/page-container';
import { DateRangePicker } from '@/components/layout/date-range-picker';
import { StatStrip } from '@/components/layout/section';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { Skeleton } from '@/components/ui/skeleton';
import { accountHref, useAdmin } from './lib';
import { DataList, ErrorBox, Notice, Section, StatusBadge, When } from './ui';
import { DIRECT, GtmTabs, usd0, useGtmParams } from './gtm-common';

interface Row {
  key: string; utm_source: string; utm_medium: string; utm_campaign: string;
  requests: number; approved: number; accounts: number; activated: number; paying: number; mrr_usd: number;
  account_list: { slug: string; name: string; stage_label: string; created_at: string; activated: boolean; paying: boolean; plan: string; mrr_usd: number }[];
}
interface Attribution {
  range: { from: string; to: string; days: number };
  stripe: { configured: boolean; error: string | null };
  rows: Row[];
  totals: { requests: number; approved: number; accounts: number; activated: number; paying: number; mrr_usd: number };
}

interface OutRow { key: string; label: string; touched: number; replied: number; interested: number; requests: number; accounts: number; activated: number; paying: number;
  mrr_usd: number; pipeline: number; won: number; deals_won: number }
interface Outbound {
  model: string; model_text: string; stripe_error: string | null;
  channels: { channel: string; label: string; requests: number; accounts: number; activated: number; paying: number; mrr_usd: number }[];
  campaigns: OutRow[]; sources: OutRow[];
}

/** Outbound as a channel, then per campaign and per prospect source: first touch, stated on the page. */
function OutboundSection({ query }: { query: string }) {
  const { data: o, error } = useAdmin<Outbound>(`/gtm/attribution/outbound?${query}`, { keep: true });
  const cols = (first: string) => [
    { label: first, render: (r: OutRow) => <span className='font-medium'>{r.label}</span> },
    { label: 'Touched', render: (r: OutRow) => n(r.touched) },
    { label: 'Replied', render: (r: OutRow) => <span className='tabular-nums'>{r.replied}<span className='text-muted-foreground text-xs'> · {rate(r.replied, r.touched)}</span></span> },
    { label: 'Interested', render: (r: OutRow) => n(r.interested) },
    { label: 'Requests', render: (r: OutRow) => n(r.requests) },
    { label: 'Accounts', render: (r: OutRow) => n(r.accounts) },
    { label: 'Paying', render: (r: OutRow) => n(r.paying) },
    { label: 'MRR', render: (r: OutRow) => <span className='tabular-nums'>{usd0(r.mrr_usd)}</span> },
    { label: 'Pipeline', render: (r: OutRow) => <span className='tabular-nums'>{usd0(r.pipeline)}</span> },
    { label: 'Won', render: (r: OutRow) => <span className='tabular-nums'>{usd0(r.won)}<span className='text-muted-foreground text-xs'> · {r.deals_won} deals</span></span> }
  ];
  return (
    <Section title='Outbound' description={o ? `Attribution model: ${o.model_text}` : 'Attribution model: first touch.'}>
      <div className='flex flex-col gap-4'>
        <ErrorBox error={error} />
        {o?.stripe_error && <Notice>Stripe: {o.stripe_error} (Paying and MRR may be short)</Notice>}
        <div className='border'>
          <DataList noun='channels' minWidth={560} rows={o?.channels} empty='Nothing in this period.' cols={[
            { label: 'Channel', render: (c) => <span className='font-medium'>{c.label}</span> },
            { label: 'Requests', render: (c) => n(c.requests) },
            { label: 'Accounts', render: (c) => n(c.accounts) },
            { label: 'Activated', render: (c) => n(c.activated) },
            { label: 'Paying', render: (c) => n(c.paying) },
            { label: 'MRR', render: (c) => <span className='tabular-nums'>{usd0(c.mrr_usd)}</span> }
          ]} />
        </div>
        <h3 className='text-sm font-medium'>By outbound campaign</h3>
        <div className='border'><DataList noun='campaigns' minWidth={960} rows={o?.campaigns} empty='No outbound email has gone out yet.' cols={cols('Campaign')} /></div>
        <h3 className='text-sm font-medium'>By prospect source</h3>
        <div className='border'><DataList noun='sources' minWidth={960} rows={o?.sources} empty='No outbound email has gone out yet.' cols={cols('Source')} /></div>
      </div>
    </Section>
  );
}

export function AdminAttribution() {
  return <Suspense fallback={<PageContainer><Skeleton className='h-72 rounded-lg' /></PageContainer>}><AttributionPage /></Suspense>;
}

const rate = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const muted = (s: string) => <span className='text-muted-foreground'>{s}</span>;
const n = (x: number) => <span className={x ? 'tabular-nums' : 'text-muted-foreground tabular-nums'}>{x}</span>;

function AttributionPage() {
  const p = useGtmParams();
  const { data: a, error, isLoading } = useAdmin<Attribution>(`/gtm/attribution?${p.rangeOnly}`, { keep: true });
  const t = a?.totals;
  const cols: RecordCol<Row>[] = [
    { key: 'utm_source', label: 'Source', name: 'utm_source', title: true, keep: true, type: 'text', className: 'min-w-40', value: (r) => r.utm_source,
      render: (r) => <span className={r.utm_source === DIRECT ? 'text-muted-foreground font-medium' : 'font-medium'}>{r.utm_source}</span> },
    { key: 'utm_medium', label: 'Medium', name: 'utm_medium', type: 'text', value: (r) => r.utm_medium, render: (r) => r.utm_medium || muted('—') },
    { key: 'utm_campaign', label: 'Campaign', name: 'utm_campaign', type: 'text', keep: true, value: (r) => r.utm_campaign, render: (r) => r.utm_campaign || muted('—') },
    { key: 'requests', label: 'Requests', type: 'number', value: (r) => r.requests, render: (r) => n(r.requests) },
    { key: 'approved', label: 'Approved', type: 'number', value: (r) => r.approved, render: (r) => n(r.approved) },
    { key: 'accounts', label: 'Accounts', type: 'number', value: (r) => r.accounts, render: (r) => n(r.accounts) },
    { key: 'activated', label: 'Activated', name: 'Activated (first simulation)', type: 'number', value: (r) => r.activated,
      render: (r) => <span className='tabular-nums'>{r.activated}<span className='text-muted-foreground text-xs'> · {rate(r.activated, r.accounts)}</span></span> },
    { key: 'paying', label: 'Paying', type: 'number', value: (r) => r.paying, render: (r) => n(r.paying) },
    { key: 'mrr_usd', label: 'MRR', name: 'MRR (USD)', type: 'number', value: (r) => r.mrr_usd, render: (r) => <span className='tabular-nums'>{usd0(r.mrr_usd)}</span> }
  ];
  return (
    <PageContainer>
      <div className='flex min-w-0 flex-col gap-4'>
        <GtmTabs right={<DateRangePicker value={p.range} onChange={p.setRange} />} />
        <ErrorBox error={error} />
        {a && !a.stripe.configured && <Notice tone='info'>Stripe is not connected: Paying and MRR are 0.</Notice>}
        {a?.stripe.error && <Notice>Stripe: {a.stripe.error} (Paying and MRR may be short)</Notice>}
        <RecordView<Row>
          id='gtm-attribution' noun='sources' exportName={`octillion-attribution-${p.range.from}_${p.range.to}`} compact stacked loading={isLoading}
          rows={a?.rows ?? []} rowKey={(r) => r.key} cols={cols}
          defaultSort={[{ key: 'mrr_usd', dir: 'desc' }]}
          searchText={(r) => `${r.utm_source} ${r.utm_medium} ${r.utm_campaign} ${r.account_list.map((x) => `${x.name} ${x.slug}`).join(' ')}`}
          searchPlaceholder='Search sources, campaigns or accounts'
          empty='No access requests or new accounts in this period.'
          summary={t && (
            <StatStrip items={[
              { label: 'Access requests', value: t.requests, hint: `${t.approved} approved` },
              { label: 'Accounts', value: t.accounts, hint: `${rate(t.accounts, t.requests)} of requests` },
              { label: 'Activated', value: t.activated, hint: `${rate(t.activated, t.accounts)} reached a simulation` },
              { label: 'Paying', value: t.paying, hint: `${rate(t.paying, t.accounts)} of accounts` },
              { label: 'MRR', value: usd0(t.mrr_usd), hint: 'from Stripe, now' }
            ]} />
          )}
          detailTitle={(r) => <span>{r.utm_source}{r.utm_medium ? ` / ${r.utm_medium}` : ''}{r.utm_campaign ? ` · ${r.utm_campaign}` : ''}</span>}
          detail={(r) => (
            <div className='flex flex-col gap-4'>
              <StatStrip items={[
                { label: 'Requests', value: r.requests, hint: `${r.approved} approved` },
                { label: 'Accounts', value: r.accounts },
                { label: 'Activated', value: r.activated },
                { label: 'MRR', value: usd0(r.mrr_usd), hint: `${r.paying} paying` }
              ]} />
              <div className='border'>
                <DataList
                  noun='accounts' minWidth={560}
                  rows={r.account_list}
                  empty='No accounts yet: the requests are still pending or were declined.'
                  cols={[
                    { label: 'Account', render: (x) => <Link className='font-medium hover:underline' href={accountHref(x.slug)}>{x.name}</Link> },
                    { label: 'Stage', render: (x) => <StatusBadge tone={x.activated ? 'ok' : 'neutral'}>{x.stage_label}</StatusBadge> },
                    { label: 'Plan', render: (x) => (x.paying ? <span>{x.plan} · <span className='tabular-nums'>{usd0(x.mrr_usd)}</span></span> : muted(x.plan === 'none' ? '—' : x.plan)) },
                    { label: 'Created', render: (x) => <When d={x.created_at} className='text-muted-foreground text-sm' /> }
                  ]}
                />
              </div>
            </div>
          )}
        />
        <OutboundSection query={p.rangeOnly} />
      </div>
    </PageContainer>
  );
}
