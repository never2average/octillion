'use client';
// Operations › Spend (/admin/spend, GET /spend and /spend/accounts/:key, src/spend.ts): what Octillion spends on models
// across every account, from metered data only (never the boat sandbox estimate). Three tabs in ?section= (Accounts,
// Models, Days), each four headline numbers with a daily sparkline and one table. The range (UTC days) and the filters
// are page state, so switching tabs keeps them. Read only.
import { Suspense, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import PageContainer from '@/components/layout/page-container';
import { DateRangePicker, PRESETS, rangeQuery, type DateRange } from '@/components/layout/date-range-picker';
import { MultiSelectFilter } from '@/components/layout/multi-select-filter';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { StatStrip } from '@/components/layout/section';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Button } from '@/components/ui/button';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';
import { accountHref, useAdmin } from './lib';
import { copyText, ErrorBox, Mono, StatusBadge, When } from './ui';
import { AMBER, Chip, cents, PeekSection, UrlTabs } from './compute-common';
import { MiniTable } from './compute-sessions';

type Consumer = 'session' | 'orchestrator';
interface AccountRow {
  key: string; slug: string | null; name: string; shared: boolean;
  allowance: { budget_usd: number; plan: string | null; source: 'override' | 'plan' | 'default' } | null;
  spent_usd: number; session_usd: number; orchestrator_usd: number; month_usd: number; month_pct: number | null;
  sessions: number; top_model: string | null; last_spend_at: string | null;
  daily_session: number[]; daily_orchestrator: number[]; month_daily: number[];
}
interface ModelRow {
  key: string; provider: string; model: string; consumer: Consumer; requests: number; errors: number;
  input_tokens: number; cached_input_tokens: number; output_tokens: number; cost_usd: number; priced: boolean; unpriced_requests: number; last_day: string;
  daily_requests: number[]; daily_tokens: number[]; daily_unpriced: number[]; daily_cost: number[];
}
interface DayPart { session_usd: number; orchestrator_usd: number; sessions: number; top_model: string | null }
interface DayRow {
  day: string; total_usd: number; session_usd: number; orchestrator_usd: number; sessions: number;
  top_account: { key: string; name: string; usd: number } | null; top_model: string | null; by_account: Record<string, DayPart>;
}
interface Spend {
  range: { from: string; to: string; days: string[] };
  month: { start: string; days_in_month: number; elapsed_days: number; days: string[] };
  totals: { total_usd: number; session_usd: number; orchestrator_usd: number; shared_usd: number; metered_model_usd: number; unpriced_requests: number };
  accounts: AccountRow[]; models: ModelRow[]; days: DayRow[];
}
interface AccountDetail {
  key: string; name: string;
  by_person: { user_id: string | null; label: string; session_usd: number; orchestrator_usd: number; usd: number; sessions: number }[];
  by_model: { model: string; provider: string | null; usd: number; sessions: number | null; requests: number | null }[];
  by_agent: { agent: string; usd: number; sessions: number }[];
  by_product: { product: string; usd: number; sessions: number }[];
}

const TABS = [['accounts', 'Accounts'], ['models', 'Models'], ['days', 'Days']] as const;
const CONSUMER: Record<Consumer, string> = { session: 'Sessions', orchestrator: 'Orchestrators' };
const SOURCE: Record<string, string> = { override: 'Set by Octillion', plan: 'Plan', default: 'Default' };
const SHARED_HINT = 'Orchestrator spend no job claims: shared orchestrators, prospect research, and any gap between the gateway\'s daily meter and its per-orchestrator totals.';
const UNPRICED = 'Some requests used a model with no price in model_prices, so this cost is understated.';

const sumAt = (rows: readonly number[][], len: number) => Array.from({ length: len }, (_, i) => rows.reduce((t, r) => t + (r[i] ?? 0), 0));
const total = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const cumulative = (xs: readonly number[]) => { let t = 0; return xs.map((x) => (t += x)); };
const tokens = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(0)}k` : n.toLocaleString());
const dayLabel = (d: string, year = false) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC', ...(year ? { year: 'numeric' } : {}) });
const short = (m: string | null) => (m ? m.replace(/^.*\//, '') : null);
const NA = <span className='text-muted-foreground'>—</span>;
const thisMonth = () => PRESETS.find((p) => p.id === 'month')!.range();
const todayUtc = () => new Date().toISOString().slice(0, 10);

export function AdminSpend() {
  // useSearchParams (the tab) needs a Suspense boundary for the static render.
  return <Suspense fallback={<PageContainer><Skeleton className='h-72 rounded-lg' /></PageContainer>}><SpendPage /></Suspense>;
}

function SpendPage() {
  const section = useSearchParams().get('section');
  const tab = TABS.some(([id]) => id === section) ? section! : 'accounts';
  const [range, setRange] = useState<DateRange>(thisMonth);
  const { data, error, isLoading, isFetching, refetch } = useAdmin<Spend>(`/spend?${rangeQuery(range)}`, { keep: true });
  const picker = <DateRangePicker value={range} onChange={setRange} />;
  const common = { data, loading: isLoading && !data, picker };
  return (
    <PageContainer>
      <div className='flex min-w-0 flex-col gap-3'>
        <UrlTabs tabs={TABS} tab={tab} base='/admin/spend' right={
          <div className='flex flex-wrap items-center justify-end gap-2'>
            {data && data.totals.unpriced_requests > 0 && <span className={cn('text-sm', AMBER)} title={UNPRICED}>{data.totals.unpriced_requests.toLocaleString()} unpriced requests: spend is understated</span>}
            <Button variant='outline' size='sm' disabled={isFetching} onClick={() => void refetch()} title='Load the figures again'>
              {isFetching ? <Icons.spinner className='animate-spin' /> : <Icons.refresh />} Refresh
            </Button>
          </div>
        } />
        {error && !data && (
          <div role='alert' className='border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-3 rounded-lg border px-4 py-3 text-sm'>
            <span className='min-w-0 flex-1'>Could not load spend: {error.message}</span>
            <Button variant='outline' size='xs' onClick={() => void refetch()}>Retry</Button>
          </div>
        )}
        {tab === 'accounts' && <AccountsTab {...common} range={range} />}
        {tab === 'models' && <ModelsTab {...common} />}
        {tab === 'days' && <DaysTab {...common} />}
      </div>
    </PageContainer>
  );
}

interface TabProps { data: Spend | undefined; loading: boolean; picker: React.ReactNode }

// ---------------------------------------------------------------- Accounts

function AccountsTab({ data, loading, picker, range }: TabProps & { range: DateRange }) {
  const router = useRouter();
  const [picked, setPicked] = useState<string[]>([]);
  const [scope, setScope] = useState<'spend' | 'all'>('spend');
  const all = data?.accounts ?? [];
  const rows = useMemo(() => all.filter((a) => (picked.length ? picked.includes(a.key) : scope === 'all' || a.spent_usd > 0 || a.month_usd > 0)), [all, picked, scope]);
  const len = data?.range.days.length ?? 0;
  const session = sumAt(rows.map((r) => r.daily_session), len), orch = sumAt(rows.map((r) => r.daily_orchestrator), len);
  const month = sumAt(rows.map((r) => r.month_daily), data?.month.days.length ?? 0);
  const m = data?.month;
  const pace = m ? (total(month) / m.elapsed_days) * m.days_in_month : null;
  const cards = (
    <StatStrip items={[
      { label: 'Total spend', spark: session.map((x, i) => x + orch[i]), value: data ? cents(total(session) + total(orch)) : '—' },
      { label: 'Session spend', spark: session, value: data ? cents(total(session)) : '—' },
      { label: 'Orchestrator spend', spark: orch, value: data ? cents(total(orch)) : '—' },
      { label: 'Month-end pace', spark: cumulative(month), value: pace == null ? '—' : cents(pace) }
    ]} />
  );
  const cols: RecordCol<AccountRow>[] = [
    { key: 'account', label: 'Account', title: true, keep: true, type: 'text', value: (a) => a.name, render: (a) => (
      <span className='flex min-w-0 flex-col gap-1'>
        <span className='flex items-center gap-1.5'><span className='truncate font-medium'>{a.name}</span>{a.shared && <Chip title={SHARED_HINT}>shared</Chip>}</span>
        {a.slug && <span className='text-muted-foreground truncate text-xs'>{a.slug}</span>}
      </span>
    ) },
    { key: 'allowance', label: 'Plan / allowance', type: 'number', value: (a) => a.allowance?.budget_usd ?? null, render: (a) => (
      a.allowance ? (
        <span className='flex flex-col gap-1'>
          <span className='tabular-nums'>{a.allowance.budget_usd > 0 ? `${cents(a.allowance.budget_usd)} a month` : 'No allowance'}</span>
          <span className='text-muted-foreground text-xs'>{a.allowance.plan ?? SOURCE[a.allowance.source]}{a.allowance.plan && a.allowance.source === 'override' && ' · set by Octillion'}</span>
        </span>
      ) : NA
    ) },
    { key: 'spent', label: 'Spent in range', className: 'text-right', type: 'number', value: (a) => a.spent_usd, render: (a) => (
      <span className='tabular-nums' title={`Sessions ${cents(a.session_usd)} · orchestrators ${cents(a.orchestrator_usd)}`}>{cents(a.spent_usd)}</span>
    ) },
    { key: 'session', label: 'Sessions $', className: 'text-right', hidden: true, type: 'number', value: (a) => a.session_usd, render: (a) => <span className='tabular-nums'>{cents(a.session_usd)}</span> },
    { key: 'orchestrator', label: 'Orchestrators $', className: 'text-right', hidden: true, type: 'number', value: (a) => a.orchestrator_usd, render: (a) => <span className='tabular-nums'>{cents(a.orchestrator_usd)}</span> },
    { key: 'month', label: 'This month vs allowance', className: 'w-56', type: 'number', value: (a) => a.month_pct ?? null, render: (a) => (
      a.shared ? <span className='text-muted-foreground text-xs tabular-nums'>{cents(a.month_usd)} this month, no allowance</span>
        : <AllowanceMeter used={a.month_usd} budget={a.allowance?.budget_usd ?? 0} pct={a.month_pct} />
    ) },
    { key: 'sessions', label: 'Sessions', className: 'text-right', type: 'number', value: (a) => a.sessions, render: (a) => <span className='tabular-nums'>{a.sessions ? a.sessions.toLocaleString() : NA}</span> },
    { key: 'top_model', label: 'Top model', type: 'select', value: (a) => a.top_model ?? '', render: (a) => (a.top_model ? <Mono>{short(a.top_model)}</Mono> : NA) },
    { key: 'last', label: 'Last spend', type: 'date', value: (a) => a.last_spend_at, render: (a) => (a.last_spend_at ? <When d={a.last_spend_at} /> : NA) }
  ];
  const filters = (
    <>
      {picker}
      <MultiSelectFilter noun='accounts' options={all.map((a) => ({ value: a.key, label: a.name, hint: a.slug ?? undefined }))} value={picked} onChange={setPicked} />
      <NativeSelect aria-label='Accounts shown' value={scope} disabled={picked.length > 0} onChange={(e) => setScope(e.target.value as 'spend' | 'all')}>
        <NativeSelectOption value='spend'>Accounts with spend</NativeSelectOption>
        <NativeSelectOption value='all'>Every account</NativeSelectOption>
      </NativeSelect>
    </>
  );
  return (
    <RecordView id='spend-accounts' rows={rows} loading={loading} rowKey={(a) => a.key} cols={cols} noun='accounts' initialSize={50} compact summary={cards}
      searchText={(a) => `${a.name} ${a.slug ?? ''} ${a.top_model ?? ''} ${a.allowance?.plan ?? ''}`} searchPlaceholder='Search accounts, models'
      filters={filters} defaultSort={[{ key: 'spent', dir: 'desc' }]} exportName={`spend-accounts-${data?.range.from ?? ''}_${data?.range.to ?? ''}`}
      actions={(a) => [
        ...(a.slug ? [{ label: 'Open account', icon: <Icons.externalLink />, onSelect: () => router.push(accountHref(a.slug!)) }] : []),
        ...(a.slug ? [{ label: 'Copy slug', icon: <Icons.page />, onSelect: () => copyText(a.slug!, 'Slug copied') }] : [])
      ]}
      detailTitle={(a) => <span className='flex items-center gap-2'>{a.name}{a.shared && <Chip title={SHARED_HINT}>shared</Chip>}</span>}
      detail={(a) => <AccountPeek a={a} days={data?.range.days ?? []} range={range} />}
      empty={picked.length || scope === 'all' ? 'No accounts match.' : 'No model spend in this range.'} />
  );
}

/** This month's spend against the allowance: a small bar and the share, amber from 80%, red at 100%. */
function AllowanceMeter({ used, budget, pct }: { used: number; budget: number; pct: number | null }) {
  if (!budget || pct == null) return <span className='text-muted-foreground text-xs tabular-nums'>{cents(used)} · no allowance</span>;
  const fill = pct >= 1 ? 'bg-destructive' : pct >= 0.8 ? 'bg-amber-500' : 'bg-primary';
  return (
    <span className='flex flex-col gap-1.5' title={`${cents(used)} of ${cents(budget)} this month (session spend, as Billing counts it)`}>
      <span className='text-xs tabular-nums'>{cents(used)} <span className='text-muted-foreground'>of {cents(budget)}</span>
        <span className={cn('ml-1.5', pct >= 1 ? 'text-destructive' : pct >= 0.8 ? AMBER : 'text-muted-foreground')}>{Math.round(pct * 100)}%</span></span>
      <span className='bg-muted flex h-1.5 w-full overflow-hidden rounded-full' role='meter' aria-valuemin={0} aria-valuemax={budget} aria-valuenow={used}>
        <span className={fill} style={{ width: `${Math.min(100, pct * 100)}%` }} />
      </span>
    </span>
  );
}

const dailyConfig = { session: { label: 'Sessions', color: 'var(--chart-1)' }, orchestrator: { label: 'Orchestrators', color: 'var(--chart-2)' } } satisfies ChartConfig;

/** One account's peek: its daily spend, then spend by person, model, agent and product (GET /spend/accounts/:key). */
function AccountPeek({ a, days, range }: { a: AccountRow; days: string[]; range: DateRange }) {
  const { data, error, isLoading } = useAdmin<AccountDetail>(`/spend/accounts/${encodeURIComponent(a.key)}?${rangeQuery(range)}`);
  const points = days.map((d, i) => ({ day: d, session: a.daily_session[i] ?? 0, orchestrator: a.daily_orchestrator[i] ?? 0 }));
  return (
    <div className='grid gap-6'>
      <PeekSection title='Daily spend'>
        <p className='text-sm'>{cents(a.spent_usd)} in range: sessions {cents(a.session_usd)}, orchestrators {cents(a.orchestrator_usd)}.</p>
        {a.shared && <p className='text-muted-foreground text-xs'>{SHARED_HINT}</p>}
        <ChartContainer config={dailyConfig} className='aspect-auto h-[160px] w-full'>
          <BarChart data={points} margin={{ left: 0, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey='day' tickLine={false} axisLine={false} minTickGap={24} tickFormatter={(d: string) => dayLabel(d)} />
            <YAxis width={44} tickLine={false} axisLine={false} tickFormatter={(v: number) => `$${v < 10 ? v.toFixed(2) : Math.round(v)}`} />
            <ChartTooltip content={<ChartTooltipContent labelFormatter={(d) => dayLabel(String(d), true)} formatter={(v, name) => (
              <span className='flex w-full justify-between gap-3'><span className='text-muted-foreground'>{dailyConfig[name as keyof typeof dailyConfig]?.label ?? name}</span><span className='tabular-nums'>{cents(Number(v))}</span></span>
            )} />} />
            <Bar dataKey='session' stackId='s' fill='var(--color-session)' isAnimationActive={false} />
            <Bar dataKey='orchestrator' stackId='s' fill='var(--color-orchestrator)' radius={[2, 2, 0, 0]} isAnimationActive={false} />
            <ChartLegend content={<ChartLegendContent />} verticalAlign='top' />
          </BarChart>
        </ChartContainer>
      </PeekSection>
      {isLoading ? <Skeleton className='h-40' /> : !data ? <ErrorBox error={error} /> : (
        <>
          {!a.shared && (
            <PeekSection title='By person'>
              {data.by_person.length ? <MiniTable head={['Who', 'Sessions', 'Sessions $', 'Orchestrators $', 'Total']} rows={data.by_person.map((p) => [
                <span key='w' title={p.user_id ?? undefined}>{p.label}</span>, p.sessions, cents(p.session_usd), cents(p.orchestrator_usd), <span key='t' className='font-medium'>{cents(p.usd)}</span>])} />
                : <p className='text-muted-foreground text-sm'>No spend in this range.</p>}
            </PeekSection>
          )}
          <PeekSection title={a.shared ? 'Orchestrator models (all orchestrator spend)' : 'By model'}>
            {data.by_model.length ? <MiniTable head={a.shared ? ['Model', 'Provider', 'Requests', '$'] : ['Model', 'Sessions', '$']} rows={data.by_model.map((m) => a.shared
              ? [<Mono key='m'>{m.model}</Mono>, <Mono key='p'>{m.provider}</Mono>, (m.requests ?? 0).toLocaleString(), cents(m.usd)]
              : [<Mono key='m'>{m.model}</Mono>, m.sessions ?? 0, cents(m.usd)])} />
              : <p className='text-muted-foreground text-sm'>No spend in this range.</p>}
          </PeekSection>
          {data.by_agent.length > 0 && (
            <PeekSection title='By agent'>
              <MiniTable head={['Agent', 'Sessions', '$']} rows={data.by_agent.map((x) => [<Mono key='a'>{x.agent}</Mono>, x.sessions, cents(x.usd)])} />
            </PeekSection>
          )}
          {data.by_product.length > 0 && (
            <PeekSection title='By product'>
              <MiniTable head={['Product', 'Sessions', '$']} rows={data.by_product.map((x) => [x.product, x.sessions, cents(x.usd)])} />
            </PeekSection>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Models

function ModelsTab({ data, loading, picker }: TabProps) {
  const [provider, setProvider] = useState('');
  const [consumer, setConsumer] = useState('');
  const all = data?.models ?? [];
  const providers = useMemo(() => [...new Set(all.map((m) => m.provider))].sort(), [all]);
  const rows = useMemo(() => all.filter((m) => (!provider || m.provider === provider) && (!consumer || m.consumer === consumer)), [all, provider, consumer]);
  const len = data?.range.days.length ?? 0;
  const distinctPerDay = (f: (m: ModelRow) => string) => Array.from({ length: len }, (_, i) => new Set(rows.filter((m) => m.daily_requests[i] > 0).map(f)).size);
  const cards = (
    <StatStrip items={[
      { label: 'Providers used', spark: distinctPerDay((m) => m.provider), value: data ? new Set(rows.map((m) => m.provider)).size : '—' },
      { label: 'Models used', spark: distinctPerDay((m) => m.model), value: data ? new Set(rows.map((m) => m.model)).size : '—' },
      { label: 'Tokens (in + out)', spark: sumAt(rows.map((m) => m.daily_tokens), len), value: data ? tokens(total(rows.map((m) => m.input_tokens + m.output_tokens))) : '—' },
      { label: 'Unpriced requests', spark: sumAt(rows.map((m) => m.daily_unpriced), len), value: data ? total(rows.map((m) => m.unpriced_requests)).toLocaleString() : '—' }
    ]} />
  );
  const num = (k: 'requests' | 'input_tokens' | 'cached_input_tokens' | 'output_tokens', label: string): RecordCol<ModelRow> =>
    ({ key: k, label, className: 'text-right', type: 'number', value: (m) => m[k], render: (m) => <span className='tabular-nums' title={m[k].toLocaleString()}>{k === 'requests' ? m[k].toLocaleString() : tokens(m[k])}</span> });
  const cols: RecordCol<ModelRow>[] = [
    { key: 'provider', label: 'Provider', keep: true, type: 'select', value: (m) => m.provider, render: (m) => <Mono>{m.provider}</Mono> },
    { key: 'model', label: 'Model', title: true, keep: true, type: 'text', value: (m) => m.model, render: (m) => <Mono>{m.model}</Mono> },
    { key: 'consumer', label: 'Used by', type: 'select', value: (m) => CONSUMER[m.consumer], render: (m) => CONSUMER[m.consumer] },
    num('requests', 'Requests'),
    { key: 'errors', label: 'Errors', className: 'text-right', type: 'number', value: (m) => m.errors, render: (m) => (m.errors ? <span className='text-destructive tabular-nums'>{m.errors.toLocaleString()}</span> : <span className='text-muted-foreground'>0</span>) },
    num('input_tokens', 'Input'), num('cached_input_tokens', 'Cached'), num('output_tokens', 'Output'),
    { key: 'cost', label: 'Cost', className: 'text-right', keep: true, type: 'number', value: (m) => m.cost_usd, render: (m) => <span className='tabular-nums'>{cents(m.cost_usd)}</span> },
    { key: 'priced', label: 'Priced', type: 'select', value: (m) => (m.priced ? 'Priced' : 'Unpriced'), render: (m) => (
      m.priced ? <StatusBadge tone='ok'>Priced</StatusBadge>
        : <StatusBadge tone='warn' title={`${UNPRICED} ${m.unpriced_requests.toLocaleString()} requests on unpriced days.`}>Unpriced</StatusBadge>
    ) }
  ];
  const filters = (
    <>
      {picker}
      <NativeSelect aria-label='Provider' value={provider} onChange={(e) => setProvider(e.target.value)}>
        <NativeSelectOption value=''>Every provider</NativeSelectOption>
        {providers.map((p) => <NativeSelectOption key={p} value={p}>{p}</NativeSelectOption>)}
      </NativeSelect>
      <NativeSelect aria-label='Used by' value={consumer} onChange={(e) => setConsumer(e.target.value)}>
        <NativeSelectOption value=''>Sessions and orchestrators</NativeSelectOption>
        <NativeSelectOption value='session'>Sessions</NativeSelectOption>
        <NativeSelectOption value='orchestrator'>Orchestrators</NativeSelectOption>
      </NativeSelect>
    </>
  );
  return (
    <RecordView id='spend-models' rows={rows} loading={loading} rowKey={(m) => m.key} cols={cols} noun='models' initialSize={50} compact summary={cards}
      searchText={(m) => `${m.provider} ${m.model} ${CONSUMER[m.consumer]} ${m.priced ? '' : 'unpriced'}`} searchPlaceholder='Search providers, models'
      filters={filters} defaultSort={[{ key: 'cost', dir: 'desc' }]} exportName={`spend-models-${data?.range.from ?? ''}_${data?.range.to ?? ''}`}
      empty={provider || consumer ? 'No models match these filters.' : 'No model requests in this range.'} />
  );
}

// ---------------------------------------------------------------- Days

function DaysTab({ data, loading, picker }: TabProps) {
  const [account, setAccount] = useState('');
  const names = useMemo(() => new Map((data?.accounts ?? []).map((a) => [a.key, a.name])), [data]);
  const withSpend = useMemo(() => (data?.accounts ?? []).filter((a) => a.spent_usd > 0), [data]);
  // One account: each day is that account's part of it.
  const rows = useMemo(() => (data?.days ?? []).map((d): DayRow => {
    if (!account) return d;
    const p = d.by_account[account];
    const s = p?.session_usd ?? 0, o = p?.orchestrator_usd ?? 0;
    return { ...d, total_usd: s + o, session_usd: s, orchestrator_usd: o, sessions: p?.sessions ?? 0, top_model: p?.top_model ?? null,
      top_account: p ? { key: account, name: names.get(account) ?? account, usd: s + o } : null };
  }), [data, account, names]);
  const totals = rows.map((d) => d.total_usd);
  const busiest = rows.reduce<DayRow | null>((b, d) => (d.total_usd > (b?.total_usd ?? 0) ? d : b), null);
  const today = rows.find((d) => d.day === todayUtc());
  const cards = (
    <StatStrip items={[
      { label: 'Spend today', spark: totals, value: !data ? '—' : today ? cents(today.total_usd) : <span className='text-muted-foreground text-base'>Not in range</span> },
      { label: 'Avg per day', spark: cumulative(totals).map((t, i) => t / (i + 1)), value: data && rows.length ? cents(total(totals) / rows.length) : '—' },
      { label: 'Busiest day', spark: totals, value: busiest ? <span>{cents(busiest.total_usd)} <span className='text-muted-foreground text-base font-normal'>{dayLabel(busiest.day)}</span></span> : '—' },
      { label: 'Days in range', spark: rows.map((d) => d.sessions), value: data ? rows.length : '—' }
    ]} />
  );
  const cols: RecordCol<DayRow>[] = [
    { key: 'day', label: 'Day', title: true, keep: true, type: 'text', value: (d) => d.day, render: (d) => <span className='tabular-nums'>{dayLabel(d.day, true)}</span> },
    { key: 'total', label: 'Total', className: 'text-right', keep: true, type: 'number', value: (d) => d.total_usd, render: (d) => <span className={cn('tabular-nums', d.total_usd ? 'font-medium' : 'text-muted-foreground')}>{cents(d.total_usd)}</span> },
    { key: 'session', label: 'Sessions spend', className: 'text-right', type: 'number', value: (d) => d.session_usd, render: (d) => <span className='tabular-nums'>{cents(d.session_usd)}</span> },
    { key: 'orchestrator', label: 'Orchestrator spend', className: 'text-right', type: 'number', value: (d) => d.orchestrator_usd, render: (d) => <span className='tabular-nums'>{cents(d.orchestrator_usd)}</span> },
    { key: 'sessions', label: 'Sessions run', className: 'text-right', type: 'number', value: (d) => d.sessions, render: (d) => <span className='tabular-nums'>{d.sessions ? d.sessions.toLocaleString() : NA}</span> },
    { key: 'top_account', label: 'Top account', type: 'select', value: (d) => d.top_account?.name ?? '', render: (d) => (
      d.top_account ? <span className='flex items-center gap-1.5'><span className='truncate'>{d.top_account.name}</span><span className='text-muted-foreground text-xs tabular-nums'>{cents(d.top_account.usd)}</span></span> : NA
    ) },
    { key: 'top_model', label: 'Top model', type: 'select', value: (d) => d.top_model ?? '', render: (d) => (d.top_model ? <Mono>{short(d.top_model)}</Mono> : NA) }
  ];
  const filters = (
    <>
      {picker}
      <NativeSelect aria-label='Account' value={account} onChange={(e) => setAccount(e.target.value)}>
        <NativeSelectOption value=''>Every account</NativeSelectOption>
        {withSpend.map((a) => <NativeSelectOption key={a.key} value={a.key}>{a.name}</NativeSelectOption>)}
      </NativeSelect>
    </>
  );
  return (
    <RecordView id='spend-days' rows={rows} loading={loading} rowKey={(d) => d.day} cols={cols} noun='days' initialSize={50} compact summary={cards}
      searchText={(d) => `${d.day} ${dayLabel(d.day, true)} ${d.top_account?.name ?? ''} ${d.top_model ?? ''}`} searchPlaceholder='Search days, accounts, models'
      filters={filters} defaultSort={[{ key: 'day', dir: 'desc' }]} exportName={`spend-days-${data?.range.from ?? ''}_${data?.range.to ?? ''}`}
      empty='No days in this range.' />
  );
}
