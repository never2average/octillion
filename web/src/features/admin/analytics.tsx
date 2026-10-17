'use client';
// Platform analytics and health across every account (src/insights.ts). PostHog and New Relic hold the full record;
// this replicates what staff check daily, from the records Octillion already keeps.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import PageContainer from '@/components/layout/page-container';
import { buttonVariants } from '@/components/ui/button';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Icons } from '@/components/icons';
import { num, usd } from '@/lib/octillion-format';
import { accountHref, useAdmin } from './lib';
import { Rule, StatStrip } from '@/components/layout/section';
import { DataList, ErrorBox, LoadingCards, Mono, Section, StatusBadge, Trend, When } from './ui';

interface Analytics {
  days: number;
  links: { posthog: string | null; new_relic: string | null; posthog_events: boolean; tracing: boolean };
  totals: {
    active_accounts: number;
    active_people: number;
    calls: number;
    error_pct: number;
    p50_ms: number | null;
    p95_ms: number | null;
    new_accounts: number;
    change: { active_accounts: number | null; active_people: number | null; calls: number | null };
  };
  daily: { day: string; accounts: number; people: number; calls: number; errors: number }[];
  tools: { name: string; accounts: number; people: number; calls: number; error_pct: number; p50_ms: number | null; p95_ms: number | null }[];
  clients: { client: string; accounts: number; people: number; connections: number }[];
  accounts: { slug: string; name: string; calls: number; prev_calls: number; errors: number; people: number; last_seen: string | null; trend: number | null; at_risk: boolean }[];
  retention: { cohort: string; size: number; weeks: (number | null)[] }[];
  ops: Record<string, number>;
  errors: { at: string; account: string; slug: string; method: string; name: string | null; client: string | null; error: string | null }[];
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const ms = (v: number | null | undefined) => (v == null ? '—' : `${num(v)} ms`);

const callsConfig = { calls: { label: 'Tool calls', color: 'var(--chart-1)' }, errors: { label: 'Errors', color: 'var(--destructive)' } } satisfies ChartConfig;
const activeConfig = { accounts: { label: 'Accounts', color: 'var(--chart-2)' }, people: { label: 'People', color: 'var(--chart-4)' } } satisfies ChartConfig;

/** Every day of the period, zero-filled, oldest first. */
function fillDays(rows: Analytics['daily'], days: number) {
  const by = new Map(rows.map((r) => [r.day, r]));
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(Date.now() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    const r = by.get(day);
    return { day, calls: Number(r?.calls ?? 0), errors: Number(r?.errors ?? 0), accounts: Number(r?.accounts ?? 0), people: Number(r?.people ?? 0) };
  });
}
const shortDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function AdminAnalytics() {
  const router = useRouter();
  const [days, setDays] = useState(30);
  const { data: a, error, isLoading } = useAdmin<Analytics>(`/analytics?days=${days}`);
  const series = useMemo(() => (a ? fillDays(a.daily, a.days) : []), [a]);

  return (
    <PageContainer
      pageTitle='Analytics & health'
      pageDescription="Product usage across every account, and the health of the machinery behind it. Customers see only their own team's usage."
      pageHeaderAction={
        <div className='flex flex-wrap items-center justify-end gap-2'>
          <NativeSelect value={String(days)} onChange={(e) => setDays(Number(e.target.value))} aria-label='Period'>
            <NativeSelectOption value='7'>Last 7 days</NativeSelectOption>
            <NativeSelectOption value='30'>Last 30 days</NativeSelectOption>
            <NativeSelectOption value='90'>Last 90 days</NativeSelectOption>
          </NativeSelect>
          {a?.links.posthog && (
            <a className={buttonVariants({ variant: 'outline' })} href={a.links.posthog} target='_blank' rel='noopener noreferrer'>
              PostHog <Icons.externalLink className='size-3.5' />
            </a>
          )}
          {a?.links.new_relic && (
            <a className={buttonVariants({ variant: 'outline' })} href={a.links.new_relic} target='_blank' rel='noopener noreferrer'>
              New Relic <Icons.externalLink className='size-3.5' />
            </a>
          )}
        </div>
      }
    >
      <ErrorBox error={error} />
      {a && (!a.links.posthog || !a.links.new_relic) && (
        <p className='text-muted-foreground mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs'>
          PostHog events <StatusBadge tone={a.links.posthog_events ? 'ok' : 'neutral'}>{a.links.posthog_events ? 'on' : 'off'}</StatusBadge>
          · tracing to New Relic <StatusBadge tone={a.links.tracing ? 'ok' : 'neutral'}>{a.links.tracing ? 'on' : 'off'}</StatusBadge>
          {!a.links.posthog && <span>· set <Mono>POSTHOG_PROJECT_URL</Mono> for a PostHog link</span>}
          {!a.links.new_relic && <span>· set <Mono>NEW_RELIC_DASHBOARD_URL</Mono> for a New Relic link</span>}
        </p>
      )}
      {isLoading || !a ? (
        <div className='grid gap-4'>
          <LoadingCards count={4} />
          <div className='grid gap-8 lg:grid-cols-2 lg:gap-12'>
            <Skeleton className='h-72 rounded-xl' />
            <Skeleton className='h-72 rounded-xl' />
          </div>
        </div>
      ) : (
        <div className='flex max-w-6xl flex-col gap-10'>
          <section className='flex flex-col gap-8'>
            <h3 className='text-lg font-semibold tracking-tight'>Product analytics</h3>
            <StatStrip
              items={[
                { label: 'Active accounts', value: num(a.totals.active_accounts), hint: <><Trend pct={a.totals.change.active_accounts} /> vs previous {a.days} days</> },
                { label: 'Active people', value: num(a.totals.active_people), hint: <><Trend pct={a.totals.change.active_people} /> vs previous {a.days} days</> },
                { label: 'Tool calls', value: num(a.totals.calls), hint: <><Trend pct={a.totals.change.calls} /> vs previous {a.days} days</> },
                { label: 'New accounts', value: num(a.totals.new_accounts), hint: `in the last ${a.days} days` }
              ]}
            />

            <div className='grid gap-8 lg:grid-cols-2 lg:gap-12'>
              <Section title='Tool calls per day' description='Errors in red.'>
                {a.totals.calls ? (
                  <ChartContainer config={callsConfig} className='aspect-auto h-[240px] w-full'>
                    <AreaChart data={series} margin={{ left: 0, right: 8, top: 8 }}>
                      <defs>
                        <linearGradient id='fillCalls' x1='0' y1='0' x2='0' y2='1'>
                          <stop offset='5%' stopColor='var(--color-calls)' stopOpacity={0.6} />
                          <stop offset='95%' stopColor='var(--color-calls)' stopOpacity={0.05} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey='day' tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} tickFormatter={shortDay} />
                      <YAxis width={32} tickLine={false} axisLine={false} allowDecimals={false} />
                      <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(v) => shortDay(String(v))} indicator='dot' />} />
                      <Area dataKey='calls' type='monotone' fill='url(#fillCalls)' stroke='var(--color-calls)' strokeWidth={2} />
                      <Area dataKey='errors' type='monotone' fill='var(--color-errors)' fillOpacity={0.25} stroke='var(--color-errors)' strokeWidth={1.5} />
                      <ChartLegend content={<ChartLegendContent />} />
                    </AreaChart>
                  </ChartContainer>
                ) : (
                  <p className='text-muted-foreground py-16 text-center text-sm'>No tool calls in this period.</p>
                )}
              </Section>
              <Section title='Active accounts and people per day'>
                {a.totals.calls ? (
                  <ChartContainer config={activeConfig} className='aspect-auto h-[240px] w-full'>
                    <BarChart data={series} margin={{ left: 0, right: 8, top: 8 }}>
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey='day' tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} tickFormatter={shortDay} />
                      <YAxis width={32} tickLine={false} axisLine={false} allowDecimals={false} />
                      <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(v) => shortDay(String(v))} indicator='dashed' />} />
                      <Bar dataKey='accounts' fill='var(--color-accounts)' radius={3} />
                      <Bar dataKey='people' fill='var(--color-people)' radius={3} />
                      <ChartLegend content={<ChartLegendContent />} />
                    </BarChart>
                  </ChartContainer>
                ) : (
                  <p className='text-muted-foreground py-16 text-center text-sm'>No activity in this period.</p>
                )}
              </Section>
            </div>

            <Section title='Weekly retention' description='Accounts by the week of their first tool call, and the share active in each week after.'>
              {a.retention.length ? (
                <div className='-mx-4 overflow-x-auto px-4'>
                  <table className='w-full min-w-[640px] border-separate border-spacing-1 text-sm'>
                    <thead>
                      <tr className='text-muted-foreground text-xs'>
                        <th className='text-left font-medium'>Cohort</th>
                        <th className='font-medium'>Accounts</th>
                        {Array.from({ length: 8 }, (_, i) => (
                          <th key={i} className='font-medium'>
                            W{i}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {a.retention.map((c) => (
                        <tr key={c.cohort}>
                          <td className='pr-2 whitespace-nowrap'>{shortDay(c.cohort)}</td>
                          <td className='text-center tabular-nums'>{c.size}</td>
                          {c.weeks.map((w, i) => (
                            <td
                              key={i}
                              className='h-9 rounded-md text-center text-xs tabular-nums'
                              style={
                                w == null
                                  ? { background: 'var(--muted)', opacity: 0.35 }
                                  : { background: `color-mix(in oklch, var(--primary) ${Math.max(8, w)}%, transparent)`, color: w > 55 ? 'var(--primary-foreground)' : undefined }
                              }
                            >
                              {w == null ? '' : `${w}%`}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className='text-muted-foreground py-6 text-center text-sm'>No cohorts in the last 8 weeks.</p>
              )}
            </Section>

            <div className='grid gap-8 xl:grid-cols-5 xl:gap-12'>
              <Section title='Tool adoption' className='xl:col-span-3'>
                <DataList
                  rows={a.tools}
                  empty='No tool calls in this period.'
                  minWidth={560}
                  cols={[
                    { label: 'Tool', render: (t) => <Mono>{t.name}</Mono> },
                    { label: 'Accounts', render: (t) => t.accounts },
                    { label: 'People', render: (t) => t.people },
                    { label: 'Calls', render: (t) => num(t.calls) },
                    { label: 'Errors', render: (t) => (Number(t.error_pct) ? <StatusBadge tone={Number(t.error_pct) >= 5 ? 'bad' : 'warn'}>{t.error_pct}%</StatusBadge> : '0%') },
                    { label: 'p50 / p95', render: (t) => <span className='text-xs whitespace-nowrap'>{ms(t.p50_ms)} / {ms(t.p95_ms)}</span> }
                  ]}
                />
              </Section>
              <Section title='Clients' description='AI clients that connected.' className='xl:col-span-2'>
                {a.clients.length ? (
                  <ul className='grid gap-3'>
                    {a.clients.map((c) => {
                      const max = Math.max(...a.clients.map((x) => x.accounts), 1);
                      return (
                        <li key={c.client} className='grid gap-1'>
                          <div className='flex items-center justify-between gap-2 text-sm'>
                            <Mono>{c.client}</Mono>
                            <span className='text-muted-foreground text-xs'>
                              {c.accounts} accounts · {c.people} people · {num(c.connections)} connections
                            </span>
                          </div>
                          <div className='bg-muted h-2 overflow-hidden rounded-full'>
                            <div className='h-full rounded-full' style={{ width: `${(c.accounts / max) * 100}%`, background: 'var(--chart-3)' }} />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className='text-muted-foreground py-6 text-center text-sm'>No connections in this period.</p>
                )}
              </Section>
            </div>

            <Section title='Accounts' description='Activity per account; "at risk" means calls halved vs the previous period.'>
              <DataList
                rows={a.accounts}
                empty='No account activity.'
                onRow={(r) => router.push(accountHref(r.slug))}
                cols={[
                  {
                    label: 'Account',
                    render: (r) => (
                      <span className='inline-flex flex-wrap items-center gap-1.5 font-medium'>
                        {r.name}
                        {r.at_risk && <StatusBadge tone='warn'>at risk</StatusBadge>}
                      </span>
                    )
                  },
                  { label: 'Calls', render: (r) => num(r.calls) },
                  { label: 'Trend', render: (r) => <Trend pct={r.trend} /> },
                  { label: 'People', render: (r) => r.people },
                  { label: 'Errors', render: (r) => (Number(r.errors) ? <StatusBadge tone='bad'>{r.errors}</StatusBadge> : '0') },
                  { label: 'Last seen', render: (r) => <When d={r.last_seen} /> }
                ]}
              />
            </Section>
          </section>

          <Rule />

          <section className='flex flex-col gap-8'>
            <h3 className='text-lg font-semibold tracking-tight'>Health</h3>
            <StatStrip
              items={[
                { label: 'Tool error rate', value: `${a.totals.error_pct}%`, hint: `p50 ${ms(a.totals.p50_ms)}` },
                { label: 'Tool latency, p95', value: ms(a.totals.p95_ms) },
                { label: 'Simulations completed', value: `${num(a.ops.sims_completed)} / ${num(a.ops.sims)}`, hint: `${num(a.ops.sims_open)} open now` },
                { label: 'Agent sessions failed', value: pct(a.ops.sessions_failed, a.ops.sessions), hint: `${num(a.ops.sessions_failed)} of ${num(a.ops.sessions)}` }
              ]}
            />
            <StatStrip
              className='-mt-4 border-t-0'
              items={[
                { label: 'Sessions queued now', value: num(a.ops.sessions_queued) },
                { label: 'Onboarding research failed', value: `${num(a.ops.onboardings_failed)} / ${num(a.ops.onboardings)}` },
                { label: 'Gateway error rate', value: pct(a.ops.gateway_errors, a.ops.gateway_requests), hint: `${num(a.ops.gateway_errors)} of ${num(a.ops.gateway_requests)} requests` },
                { label: 'Model cost', value: usd(a.ops.model_cost_usd), hint: `in the last ${a.days} days` }
              ]}
            />
            <Section title='Recent errors'>
              <DataList
                rows={a.errors}
                empty='No errors.'
                minWidth={720}
                cols={[
                  { label: 'When', render: (e) => <When d={e.at} /> },
                  {
                    label: 'Account',
                    render: (e) => (
                      <Link className='text-primary underline-offset-4 hover:underline' href={accountHref(e.slug)}>
                        {e.account}
                      </Link>
                    )
                  },
                  { label: 'Call', render: (e) => <Mono>{e.name || e.method}</Mono> },
                  { label: 'Client', render: (e) => <span className='text-muted-foreground text-xs'>{e.client ?? ''}</span> },
                  { label: 'Error', render: (e) => <span className='text-sm'>{e.error}</span> }
                ]}
              />
            </Section>
          </section>
        </div>
      )}
    </PageContainer>
  );
}
