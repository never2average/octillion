'use client';
// Overview: a compact onboarding funnel for accounts created in a period, and the first few accounts that need a person.
// The full picture (the canonical funnel with time between steps, filters, every account to act on) is GTM › Activation.
import { useState } from 'react';
import Link from 'next/link';
import { DateRangePicker, last30, rangeQuery, type DateRange } from '@/components/layout/date-range-picker';
import PageContainer from '@/components/layout/page-container';
import { Icons } from '@/components/icons';
import { accountHref, useAdmin } from './lib';
import { StatStrip } from '@/components/layout/section';
import { ErrorBox, LoadingCards, Notice, Section, StatusBadge, When } from './ui';

interface Overview {
  public_url: string;
  stripe_error?: string;
  requests: { pending: number; approved: number; declined: number; oldest_pending: string | null };
  funnel: { id: string; label: string; reached: number }[];
  attention: { slug: string; name: string; stage_label: string; attention: string[]; contact: string | null; last_seen: string | null }[];
  active_7d: number;
  paying: number;
  trialing: number;
  orgs: number;
  /** One point per day of the period: each card's figure as it stood at the end of that day. */
  daily: { days: string[]; pending: number[]; accounts: number[]; active_7d: number[]; paying: number[]; reported: number[] };
}

export function AdminOverview() {
  const [range, setRange] = useState<DateRange>(last30);
  const { data: o, error, isLoading } = useAdmin<Overview>(`/overview?${rangeQuery(range)}`);
  const activation = `/admin/gtm/activation?${rangeQuery(range)}`;
  const toActivation = (label: string) => (
    <Link href={activation} className='text-primary inline-flex items-center gap-1.5 text-sm font-medium hover:underline'>{label} <Icons.arrowRight className='size-4' /></Link>
  );
  const reported = o ? o.funnel[o.funnel.length - 1]?.reached ?? 0 : 0;
  const max = o ? Math.max(1, o.funnel[0]?.reached ?? 1) : 1;
  return (
    <PageContainer pageTitle='Onboarding' pageDescription='From access request to first report, across every account.'>
      <ErrorBox error={error} />
      {isLoading || !o ? (
        <LoadingCards count={5} />
      ) : (
        <div className='flex w-full flex-col gap-8'>
          {o.stripe_error && <Notice>Stripe: {o.stripe_error}</Notice>}
          <StatStrip
            items={[
              { label: 'Pending requests', value: o.requests.pending, href: '/admin/requests', spark: o.daily.pending,
                hint: o.requests.oldest_pending ? <>oldest <When d={o.requests.oldest_pending} /></> : 'inbox clear' },
              { label: 'Accounts', value: o.orgs, spark: o.daily.accounts, hint: `${o.requests.approved} approved, ${o.requests.declined} declined` },
              { label: 'Active in 7 days', value: o.active_7d, spark: o.daily.active_7d, hint: 'called a tool' },
              { label: 'Paying', value: o.paying, spark: o.daily.paying, hint: `${o.trialing || 0} trialing` },
              { label: 'Reached a report', value: reported, spark: o.daily.reported, hint: o.orgs ? `${Math.round((reported / o.orgs) * 100)}% of accounts` : '' }
            ]}
          />

          <Section title='Funnel' description='Accounts created in the period, by the furthest step they reached. Time between steps, payment and filters are on Activation.'
            action={<div className='flex flex-wrap items-center gap-3'>{toActivation('Open Activation')}<DateRangePicker value={range} onChange={setRange} /></div>}>
            <ol className='grid gap-2.5'>
              {o.funnel.map((f, idx) => {
                const prev = idx ? o.funnel[idx - 1].reached : f.reached;
                const drop = idx && prev ? Math.round(((prev - f.reached) / prev) * 100) : 0;
                return (
                  <li key={f.id} className='grid grid-cols-[minmax(0,11rem)_1fr_3rem_3.5rem] items-center gap-3 text-sm leading-none'>
                    <span className='truncate'>{f.label}</span>
                    <div className='bg-muted h-6 overflow-hidden rounded-md'>
                      <div className='bg-primary/85 h-full rounded-md transition-all' style={{ width: `${(f.reached / max) * 100}%` }} />
                    </div>
                    <span className='text-right tabular-nums'>{f.reached}</span>
                    <span className='text-muted-foreground text-right text-xs tabular-nums'>{drop > 0 ? `−${drop}%` : ''}</span>
                  </li>
                );
              })}
            </ol>
          </Section>

          <Section title='Needs attention' description={`${o.attention.length} account${o.attention.length === 1 ? '' : 's'} where a person should step in. Act on them from Activation (tips, nudges, the account peek).`}
            action={toActivation(`All ${o.attention.length} in Activation`)}>
            {o.attention.length ? (
              <ul className='divide-y border-y'>
                {o.attention.slice(0, 5).map((a) => (
                  <li key={a.slug} className='grid grid-cols-[minmax(0,12rem)_10rem_1fr_6rem] items-center gap-3 py-2.5 text-sm max-md:grid-cols-[1fr_auto]'>
                    <Link href={accountHref(a.slug)} className='truncate font-medium hover:underline'>{a.name}</Link>
                    <span className='max-md:hidden'><StatusBadge>{a.stage_label}</StatusBadge></span>
                    <span className='truncate text-amber-600 dark:text-amber-400 max-md:hidden' title={a.attention.join('\n')}>{a.attention.join(' · ')}</span>
                    <When d={a.last_seen} className='text-muted-foreground text-right text-xs' />
                  </li>
                ))}
              </ul>
            ) : <p className='text-muted-foreground py-6 text-center text-sm'>Nobody is stuck.</p>}
          </Section>
        </div>
      )}
    </PageContainer>
  );
}
