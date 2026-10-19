'use client';
// /app Usage: the team's activity across every AI client, and model spend against the plan, for everyone or for the
// people picked in the People filter (server-side, so a per-person view can later pin it to the signed-in user).
import { PagedTable } from '@/components/layout/table-pager';
import { useEffect, useMemo, useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import PageContainer from '@/components/layout/page-container';
import { Badge } from '@/components/ui/badge';
import { Rule, Section, StatStrip } from '@/components/layout/section';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { appApi } from '@/lib/api-client';
import { num, usd } from '@/lib/octillion-format';
import { DateRangePicker, last30, rangeQuery, type DateRange } from '@/components/layout/date-range-picker';
import { MultiSelectFilter, type FilterOption } from '@/components/layout/multi-select-filter';
import { Icons } from '@/components/icons';
import { ErrorState, LoadingCards, SpendMeter, useOrgLoad } from './shared';

interface Usage {
  days: number; range?: { from: string; to: string }; daily: { day: string; calls: number; errors: number }[];
  tools: { name: string; calls: number; errors: number; avg_ms: number | null }[];
  runs: { simulations: number; sessions: number; completed: number };
  people: { user_id: string; email: string; me: boolean; calls: number }[];
  active_people: number;
  use_cases?: { id: string; name: string; own: boolean; calls?: number }[];
  spend: { month_usd: number; budget_usd: number; filtered?: boolean };
  /** The cards' sparklines: people, simulations and finished sessions per day of the period; model spend per day this month. */
  series?: { days: string[]; people: number[]; simulations: number[]; completed: number[]; month_days: string[]; spend: number[] };
}

const callsConfig = { calls: { label: 'Tool calls', color: 'var(--chart-1)' }, errors: { label: 'Errors', color: 'var(--destructive)' } } satisfies ChartConfig;

export function UsagePage() {
  const [range, setRange] = useState<DateRange>(last30);
  const [users, setUsers] = useState<string[]>([]);
  const [useCases, setUseCases] = useState<string[]>([]);
  const userQ = (users.length ? `&user=${encodeURIComponent(users.join(','))}` : '') + (useCases.length ? `&use_case=${encodeURIComponent(useCases.join(','))}` : '');
  const { data: u, error } = useOrgLoad(() => appApi<Usage>('GET', `/usage?${rangeQuery(range)}${userQ}`), [range.from, range.to, userQ]);
  const [ucOpts, setUcOpts] = useState<FilterOption[]>([]);
  useEffect(() => { if (u?.use_cases) setUcOpts(u.use_cases.map((x) => ({ value: x.id, label: x.name, hint: x.own ? 'yours' : undefined, count: x.calls }))); }, [u?.use_cases]);
  // keep the people list from the last load, so the picker does not empty while a new selection loads
  const [peopleOpts, setPeopleOpts] = useState<FilterOption[]>([]);
  useEffect(() => {
    if (u?.people) setPeopleOpts(u.people.map((p) => ({ value: p.user_id, label: p.me ? `${p.email} (you)` : p.email, count: p.calls })));
  }, [u?.people]);
  const days = u?.days ?? 30;
  // Every day of the period, zero-filled, so the charts have a continuous axis.
  const series = useMemo(() => {
    if (!u) return [];
    const by = new Map(u.daily.map((d) => [d.day, d]));
    const start = u.range ? Date.parse(`${u.range.from}T00:00:00Z`) : Date.now() - (days - 1) * 86_400_000;
    return Array.from({ length: days }, (_, i) => {
      const k = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
      const d = by.get(k);
      return { day: k, calls: Number(d?.calls ?? 0), errors: Number(d?.errors ?? 0) };
    });
  }, [u, days]);
  const calls = series.reduce((s, d) => s + d.calls, 0), errs = series.reduce((s, d) => s + d.errors, 0);
  return (
    <PageContainer
      pageTitle='Usage'
      pageDescription={users.length ? `${users.length === 1 ? 'One person' : `${users.length} people`} on your team, across every AI client.` : 'Your whole team, across every AI client.'}
      pageHeaderAction={
        <div className='flex flex-wrap items-center gap-2'>
          <MultiSelectFilter noun='use cases' icon={<Icons.route />} options={ucOpts} value={useCases} onChange={setUseCases} />
          <MultiSelectFilter noun='people' icon={<Icons.teams />} options={peopleOpts} value={users} onChange={setUsers} />
          <DateRangePicker value={range} onChange={setRange} />
        </div>
      }
    >
      {error ? <ErrorState error={error} /> : !u ? <LoadingCards count={4} /> : (
        <div className='flex w-full flex-col gap-8'>
          <div className='flex flex-col gap-3'>
            <StatStrip items={[
              { label: 'Tool calls', value: num(calls), spark: series.map((d) => d.calls), hint: errs ? `${num(errs)} errors` : 'no errors' },
              { label: 'Active people', value: u.active_people, spark: u.series?.people },
              { label: 'Simulations', value: num(u.runs.simulations), spark: u.series?.simulations, hint: useCases.length ? 'all use cases' : undefined },
              { label: 'Agent sessions done', value: `${num(u.runs.completed)} / ${num(u.runs.sessions)}`, spark: u.series?.completed },
              { label: u.spend.filtered ? 'Their model spend this month' : 'Model spend this month', value: usd(u.spend.month_usd), spark: u.series?.spend, hint: u.spend.filtered ? 'runs they launched' : Number(u.spend.budget_usd) ? `of ${usd(u.spend.budget_usd)}` : 'no prepaid allowance yet' }
            ]} />
            {!u.spend.filtered && Number(u.spend.budget_usd) > 0 && <SpendMeter spent={Number(u.spend.month_usd)} budget={Number(u.spend.budget_usd)} className='max-w-md' />}
          </div>

          <div className='flex flex-col gap-10'>
            <Section title='Tool calls per day' description={`Every Octillion tool call${users.length ? ' from the people picked' : ' from your team'}, ${days} days.`}>
              {calls ? (
                <ChartContainer config={callsConfig} className='aspect-auto h-[240px] w-full'>
                  <AreaChart data={series} margin={{ left: 0, right: 8 }}>
                    <defs>
                      <linearGradient id='fillCalls' x1='0' y1='0' x2='0' y2='1'>
                        <stop offset='5%' stopColor='var(--color-calls)' stopOpacity={0.5} />
                        <stop offset='95%' stopColor='var(--color-calls)' stopOpacity={0.05} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} strokeDasharray='3 3' />
                    <XAxis dataKey='day' tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={(v: string) => v.slice(5)} />
                    <YAxis tickLine={false} axisLine={false} width={28} allowDecimals={false} />
                    <ChartTooltip cursor={false} content={<ChartTooltipContent indicator='dot' />} />
                    <Area dataKey='calls' type='monotone' fill='url(#fillCalls)' stroke='var(--color-calls)' strokeWidth={2} />
                  </AreaChart>
                </ChartContainer>
              ) : <NoData text='No tool calls in this period.' />}
            </Section>
            <Section title='Errors per day' description='Failed tool calls; see Setup for fixes.'>
              {errs ? (
                <ChartContainer config={callsConfig} className='aspect-auto h-[240px] w-full'>
                  <BarChart data={series} margin={{ left: 0, right: 8 }}>
                    <CartesianGrid vertical={false} strokeDasharray='3 3' />
                    <XAxis dataKey='day' tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={(v: string) => v.slice(5)} />
                    <YAxis tickLine={false} axisLine={false} width={24} allowDecimals={false} />
                    <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
                    <Bar dataKey='errors' fill='var(--color-errors)' radius={3} />
                  </BarChart>
                </ChartContainer>
              ) : <NoData text='No errors in this period.' />}
            </Section>
          </div>

          <Rule />

          <div className='flex flex-col gap-10'>
            <Section title='Tools' description={users.length ? 'Which parts of Octillion the people picked use.' : 'Which parts of Octillion your team uses.'}>
              <>
                <div className='overflow-x-auto'>
                  <PagedTable items={u.tools} empty='No tool calls yet.' noun='tools'>{(rows) => (
                  <Table>
                    <TableHeader><TableRow><TableHead>Tool</TableHead><TableHead className='text-right'>Calls</TableHead><TableHead className='text-right'>Errors</TableHead><TableHead className='text-right'>Avg</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {rows.map((t) => (
                        <TableRow key={t.name}>
                          <TableCell className='font-mono text-xs'>{t.name}</TableCell>
                          <TableCell className='text-right tabular-nums'>{num(t.calls)}</TableCell>
                          <TableCell className='text-right'>{Number(t.errors) ? <Badge variant='destructive'>{t.errors}</Badge> : <span className='text-muted-foreground'>0</span>}</TableCell>
                          <TableCell className='text-muted-foreground text-right tabular-nums'>{t.avg_ms != null ? `${t.avg_ms} ms` : ''}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  )}</PagedTable>
                </div>
</>
            </Section>
          </div>
        </div>
      )}
    </PageContainer>
  );
}

function NoData({ text }: { text: string }) {
  return <Empty className='py-10'><EmptyHeader><EmptyTitle className='text-base'>Nothing yet</EmptyTitle><EmptyDescription>{text}</EmptyDescription></EmptyHeader></Empty>;
}
