'use client';
// Operations › FinOps (/admin/finops; /admin/spend redirects here; src/revenue.ts, src/spend.ts and src/spend-usage.ts).
// Five tabs in ?section=: Revenue (the default; GET /spend/revenue, Stripe subscriptions and invoices against metered model
// spend, by account), Plans (the same read by Stripe price: New plan, Archive plan), Model spend (GET /spend, metered model cost), Compute hours (GET /spend/compute, sandbox time measured from
// timestamps) and Data & storage (GET /spend/storage, sizes and rows). Measured figures only, never the boat price-table
// estimate; prepaid allowances are spending caps, never revenue. Each tab is one row of four headline numbers with a
// daily sparkline and one table, grouped by account or by provider (Revenue and Plans: no switch). The range (UTC days) and the
// grouping are page state, so switching tabs keeps them. Read only, except plans: on Plans an Owner adds a
// plan in Stripe (New plan: POST /plans) or archives one (row ⋯ › Archive plan: POST /plans/:price_id/archive).
import { Suspense, useMemo, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import PageContainer from '@/components/layout/page-container';
import { DateRangePicker, PRESETS, rangeQuery, type DateRange } from '@/components/layout/date-range-picker';
import { MultiSelectFilter } from '@/components/layout/multi-select-filter';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { StatStrip } from '@/components/layout/section';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { accountHref, post, useAdmin, useAdminAction } from './lib';
import { Gate, useAdminRole } from './role';
import { copyText, ErrorBox, FormRow, Mono, StatusBadge, When, type Tone } from './ui';
import { AMBER, Chip, cents, PeekSection, UrlTabs } from './compute-common';
import { MiniTable } from './compute-sessions';

// ---------------------------------------------------------------- API shapes

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
interface ProviderSpend { provider: string; top_accounts: { key: string; name: string; usd: number; requests: number }[] }
interface Spend {
  range: { from: string; to: string; days: string[] };
  month: { start: string; days_in_month: number; elapsed_days: number; days: string[] };
  totals: { total_usd: number; session_usd: number; orchestrator_usd: number; shared_usd: number; metered_model_usd: number; unpriced_requests: number };
  accounts: AccountRow[]; models: ModelRow[]; providers: ProviderSpend[];
}
interface AccountDetail {
  key: string; name: string;
  by_person: { user_id: string | null; label: string; session_usd: number; orchestrator_usd: number; usd: number; sessions: number }[];
  by_model: { model: string; provider: string | null; usd: number; sessions: number | null; requests: number | null }[];
  by_agent: { agent: string; usd: number; sessions: number }[];
  by_product: { product: string; usd: number; sessions: number }[];
}

interface ComputeAccount {
  key: string; slug: string | null; name: string; shared: boolean;
  orchestrator_hours: number; agent_hours: number; total_hours: number; sessions: number; orchestrators: number;
  avg_session_hours: number | null; longest_session_hours: number | null; daily_orchestrator: number[]; daily_agent: number[];
  by_agent: { agent: string; hours: number; sessions: number }[];
  by_job: { job_id: string; kind: string | null; name: string | null; orchestrator_hours: number; agent_hours: number; total_hours: number }[];
}
interface ComputeProvider {
  key: string; name: string; orchestrator_hours: number; agent_hours: number; total_hours: number; sessions: number; orchestrators: number;
  daily_orchestrator: number[]; daily_agent: number[];
  sandbox_types: { kind: string; type: string | null; hours: number }[];
  by_account: { key: string; name: string; orchestrator_hours: number; agent_hours: number; total_hours: number; sessions: number }[];
}
interface Compute {
  range: { from: string; to: string; days: string[] };
  totals: { orchestrator_hours: number; agent_hours: number; total_hours: number; peak_running: number; daily_peak: number[] };
  accounts: ComputeAccount[]; providers: ComputeProvider[];
}

type StoreKind = 'database' | 'transcripts' | 'archive' | 'gateway';
interface TablePart { name: string; label: string; bytes: number | null; rows: number; new_rows: number; last_write: string | null }
interface StoreRow {
  key: string; kind: StoreKind; name: string; detail: string; bytes: number | null; rows: number | null; new_rows: number | null; new_bytes: number | null;
  daily_new: number[]; last_write: string | null; parts: TablePart[];
}
interface StorageAccount {
  key: string; slug: string | null; name: string; shared: boolean;
  rows: number; new_rows: number; transcript_events: number; new_transcript_events: number; gateway_bytes: number; gateway_requests: number; last_write: string | null;
  daily_new: number[]; daily_events: number[]; daily_gateway_bytes: number[];
  by_table: { name: string; label: string; rows: number; new_rows: number }[];
  gateway_by_provider: { provider: string; bytes: number }[];
}
interface Storage {
  range: { from: string; to: string; days: string[] };
  totals: {
    db_bytes: number | null; sizes_available: boolean; transcript_store: 'postgres' | 'clickhouse'; transcript_rows: number | null; transcript_bytes: number | null;
    gateway_bytes: number; new_rows: number; daily_new_rows: number[]; daily_transcript_rows: number[]; daily_gateway_bytes: number[];
  };
  tables: (TablePart & { daily_new: number[] })[]; stores: StoreRow[]; accounts: StorageAccount[];
}

type SubStatus = string;
interface RevenueAccount {
  key: string; slug: string | null; name: string; shared: boolean; linked: boolean; customer: string | null;
  subscription_id: string | null; plan: string | null; price_id: string | null; status: SubStatus | null;
  mrr_usd: number; collected_usd: number; spend_usd: number; margin_usd: number; margin_pct: number | null;
  allowance: { budget_usd: number; plan: string | null; source: 'override' | 'plan' | 'default' } | null;
  renews_at: string | null; cancels_at: string | null; ended_at: string | null; trial_end: string | null;
  daily_mrr: number[]; daily_collected: number[]; daily_paying: number[]; daily_spend: number[];
  invoices: { id: string; number: string | null; status: string; currency: string; created: string; paid_at: string | null; amount_usd: number; url: string | null }[];
  subscriptions: { id: string; plan: string | null; price_id: string | null; interval: string | null; status: SubStatus; mrr_usd: number; started_at: string | null;
    trial_end: string | null; canceled_at: string | null; ended_at: string | null; cancel_at: string | null; current_period_end: string | null }[];
}
interface RevenuePlan {
  key: string; name: string; price_id: string | null; lookup_key: string | null; interval: string | null; interval_count: number | null;
  unit_amount_usd: number | null; currency: string | null; active_subscriptions: number; trialing: number; subscriptions: number; mrr_usd: number; collected_usd: number;
  daily_mrr: number[]; daily_collected: number[]; daily_active: number[];
  accounts: { key: string; slug: string | null; name: string; status: SubStatus; mrr_usd: number }[];
  /** A live Octillion plan (active price, octillion_ lookup key): it can be archived. */
  live?: boolean; monthly_budget_usd?: number | null;
}
interface Revenue {
  range: { from: string; to: string; days: string[] };
  stripe: { configured: boolean; error: string | null };
  currencies: string[];
  totals: {
    mrr_usd: number; collected_usd: number; paying_accounts: number; spend_usd: number; margin_usd: number; margin_pct: number | null;
    daily_mrr: number[]; daily_collected: number[]; daily_paying: number[]; daily_spend: number[]; daily_margin_pct: (number | null)[];
  } | null;
  accounts: RevenueAccount[]; plans: RevenuePlan[];
}

// ---------------------------------------------------------------- shared bits

const BASE = '/admin/finops';
const TABS = [['revenue', 'Revenue'], ['plans', 'Plans'], ['spend', 'Model spend'], ['compute', 'Compute hours'], ['storage', 'Data & storage']] as const;
type Tab = (typeof TABS)[number][0];
/** Older links: the Accounts and Models tabs are Model spend now, Days became Compute hours. */
const OLD: Record<string, Tab> = { accounts: 'spend', models: 'spend', days: 'compute' };
type Group = 'account' | 'provider';
const CONSUMER: Record<Consumer, string> = { session: 'Sessions', orchestrator: 'Orchestrators' };
const SOURCE: Record<string, string> = { override: 'Set by Octillion', plan: 'Plan', default: 'Default' };
const SHARED_HINT = 'Not tied to one account: shared orchestrators, prospect research, and platform data.';
const UNPRICED = 'Some requests used a model with no price in model_prices, so this cost is understated.';
const KIND: Record<StoreKind, string> = { database: 'Database', transcripts: 'Transcripts', archive: 'Archive', gateway: 'Gateway traffic' };

const sumAt = (rows: readonly number[][], len: number) => Array.from({ length: len }, (_, i) => rows.reduce((t, r) => t + (r[i] ?? 0), 0));
const total = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const cumulative = (xs: readonly number[]) => { let t = 0; return xs.map((x) => (t += x)); };
const tokens = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(0)}k` : n.toLocaleString());
const count = (n: number | null | undefined) => (n == null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e5 ? `${(n / 1e3).toFixed(0)}k` : n.toLocaleString());
const bytes = (n: number | null | undefined) => {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, x = n;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${i === 0 ? x : x < 10 ? x.toFixed(1) : Math.round(x)} ${u[i]}`;
};
const hrs = (h: number | null | undefined) => (h == null ? '—' : h === 0 ? '0 h' : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${h < 100 ? h.toFixed(1) : Math.round(h).toLocaleString()} h`);
const dayLabel = (d: string, year = false) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC', ...(year ? { year: 'numeric' } : {}) });
const short = (m: string | null) => (m ? m.replace(/^.*\//, '') : null);
const NA = <span className='text-muted-foreground'>—</span>;
const thisMonth = () => PRESETS.find((p) => p.id === 'month')!.range();
const num = (v: ReactNode, title?: string) => <span className='tabular-nums' title={title}>{v}</span>;
const exportName = (what: string, group: string, r?: { from: string; to: string }) => `${what}-by-${group}-${r?.from ?? ''}_${r?.to ?? ''}`;

export function AdminFinOps() {
  // useSearchParams (the tab) needs a Suspense boundary for the static render.
  return <Suspense fallback={<PageContainer><Skeleton className='h-72 rounded-lg' /></PageContainer>}><SpendPage /></Suspense>;
}

function SpendPage() {
  const section = useSearchParams().get('section') ?? '';
  const tab: Tab = TABS.some(([id]) => id === section) ? (section as Tab) : OLD[section] ?? 'revenue';
  const [range, setRange] = useState<DateRange>(thisMonth);
  const [group, setGroup] = useState<Group>('account');
  const q = rangeQuery(range);
  const revenue = useAdmin<Revenue>(tab === 'revenue' || tab === 'plans' ? `/spend/revenue?${q}` : null, { keep: true });
  const spend = useAdmin<Spend>(tab === 'spend' ? `/spend?${q}` : null, { keep: true });
  const compute = useAdmin<Compute>(tab === 'compute' ? `/spend/compute?${q}` : null, { keep: true });
  const storage = useAdmin<Storage>(tab === 'storage' ? `/spend/storage?${q}` : null, { keep: true });
  const active = tab === 'revenue' || tab === 'plans' ? revenue : tab === 'spend' ? spend : tab === 'compute' ? compute : storage;
  const qc = useQueryClient();
  const fetching = useIsFetching({ queryKey: ['admin'] }) > 0;
  const bar = (
    <div className='flex flex-wrap items-center gap-2'>
      <DateRangePicker value={range} onChange={setRange} />
      {tab !== 'revenue' && tab !== 'plans' && <GroupBy value={group} onChange={setGroup} second='Provider' />}
    </div>
  );
  const unpriced = tab === 'spend' ? spend.data?.totals.unpriced_requests ?? 0 : 0;
  return (
    <PageContainer>
      <div className='flex min-w-0 flex-col gap-3'>
        <UrlTabs tabs={TABS} tab={tab} base={BASE} right={
          <div className='flex flex-wrap items-center justify-end gap-2'>
            {unpriced > 0 && <span className={cn('text-sm', AMBER)} title={UNPRICED}>{unpriced.toLocaleString()} unpriced requests: spend is understated</span>}
            <Button variant='outline' size='sm' disabled={fetching} onClick={() => void qc.refetchQueries({ queryKey: ['admin'], type: 'active' })} title='Load the figures again'>
              {fetching ? <Icons.spinner className='animate-spin' /> : <Icons.refresh />} Refresh
            </Button>
          </div>
        } />
        {active.error && !active.data && (
          <div role='alert' className='border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-3 rounded-lg border px-4 py-3 text-sm'>
            <span className='min-w-0 flex-1'>Could not load the figures: {active.error.message}</span>
            <Button variant='outline' size='xs' onClick={() => void active.refetch()}>Retry</Button>
          </div>
        )}
        {tab === 'revenue' && <RevenueTab data={revenue.data} loading={!revenue.data && !revenue.error} bar={bar} group='account' />}
        {tab === 'plans' && <RevenueTab data={revenue.data} loading={!revenue.data && !revenue.error} bar={bar} group='provider' />}
        {tab === 'spend' && <SpendTab data={spend.data} loading={!spend.data && !spend.error} bar={bar} group={group} range={range} />}
        {tab === 'compute' && <ComputeTab data={compute.data} loading={!compute.data && !compute.error} bar={bar} group={group} />}
        {tab === 'storage' && <StorageTab data={storage.data} loading={!storage.data && !storage.error} bar={bar} group={group} />}
      </div>
    </PageContainer>
  );
}

/** Group by: one two-option segmented control, the chosen option filled (not on Revenue or Plans). */
function GroupBy({ value, onChange, second }: { value: Group; onChange: (g: Group) => void; second: string }) {
  return (
    <ButtonGroup aria-label='Group by'>
      {(['account', 'provider'] as const).map((g) => (
        <Button key={g} variant={value === g ? 'default' : 'outline'} aria-pressed={value === g} onClick={() => onChange(g)}>
          {g === 'account' ? 'Account' : second}
        </Button>
      ))}
    </ButtonGroup>
  );
}

interface TabProps<T> { data: T | undefined; loading: boolean; bar: ReactNode; group: Group }

/** The account cell every Account grouping shares: name, a shared chip, the slug under it. */
const accountCell = (a: { name: string; slug: string | null; shared: boolean }) => (
  <span className='flex min-w-0 flex-col gap-1'>
    <span className='flex items-center gap-1.5'><span className='truncate font-medium'>{a.name}</span>{a.shared && <Chip title={SHARED_HINT}>shared</Chip>}</span>
    {a.slug && <span className='text-muted-foreground truncate text-xs'>{a.slug}</span>}
  </span>
);
const accountTitle = (a: { name: string; shared: boolean }) => <span className='flex items-center gap-2'>{a.name}{a.shared && <Chip title={SHARED_HINT}>shared</Chip>}</span>;
function accountActions(router: ReturnType<typeof useRouter>) {
  return (a: { slug: string | null }) => [
    ...(a.slug ? [{ label: 'Open account', icon: <Icons.externalLink />, onSelect: () => router.push(accountHref(a.slug!)) }] : []),
    ...(a.slug ? [{ label: 'Copy slug', icon: <Icons.page />, onSelect: () => copyText(a.slug!, 'Slug copied') }] : [])
  ];
}

/** The account filter: a multi-select, and whether accounts with nothing in the range are listed. */
function useAccountFilter<T extends { key: string; name: string; slug: string | null }>(all: T[], has: (a: T) => boolean, noun: string) {
  const [picked, setPicked] = useState<string[]>([]);
  const [scope, setScope] = useState<'some' | 'all'>('some');
  const rows = useMemo(() => all.filter((a) => (picked.length ? picked.includes(a.key) : scope === 'all' || has(a))), [all, picked, scope, has]);
  const controls = (
    <>
      <MultiSelectFilter noun='accounts' options={all.map((a) => ({ value: a.key, label: a.name, hint: a.slug ?? undefined }))} value={picked} onChange={setPicked} />
      <NativeSelect aria-label='Accounts shown' value={scope} disabled={picked.length > 0} onChange={(e) => setScope(e.target.value as 'some' | 'all')}>
        <NativeSelectOption value='some'>Accounts with {noun}</NativeSelectOption>
        <NativeSelectOption value='all'>Every account</NativeSelectOption>
      </NativeSelect>
    </>
  );
  return { rows, controls, filtered: picked.length > 0 || scope === 'all' };
}

/** A small stacked daily bar chart for a peek. */
function DailyBars({ days, series, format }: { days: string[]; series: { key: string; label: string; values: number[] }[]; format: (v: number) => string }) {
  const config = Object.fromEntries(series.map((s, i) => [s.key, { label: s.label, color: `var(--chart-${i + 1})` }])) satisfies ChartConfig;
  const points = days.map((d, i) => ({ day: d, ...Object.fromEntries(series.map((s) => [s.key, s.values[i] ?? 0])) }));
  return (
    <ChartContainer config={config} className='aspect-auto h-[160px] w-full'>
      <BarChart data={points} margin={{ left: 0, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey='day' tickLine={false} axisLine={false} minTickGap={24} tickFormatter={(d: string) => dayLabel(d)} />
        <YAxis width={52} tickLine={false} axisLine={false} tickFormatter={(v: number) => format(v)} />
        <ChartTooltip content={<ChartTooltipContent labelFormatter={(d) => dayLabel(String(d), true)} formatter={(v, name) => (
          <span className='flex w-full justify-between gap-3'><span className='text-muted-foreground'>{config[String(name)]?.label ?? name}</span><span className='tabular-nums'>{format(Number(v))}</span></span>
        )} />} />
        {series.map((s, i) => <Bar key={s.key} dataKey={s.key} stackId='s' fill={`var(--color-${s.key})`} radius={i === series.length - 1 ? [2, 2, 0, 0] : undefined} isAnimationActive={false} />)}
        {series.length > 1 && <ChartLegend content={<ChartLegendContent />} verticalAlign='top' />}
      </BarChart>
    </ChartContainer>
  );
}

const none = (what = 'Nothing in this range.') => <p className='text-muted-foreground text-sm'>{what}</p>;

// ---------------------------------------------------------------- Revenue

const SUB_TONE = (s: SubStatus): Tone => (s === 'active' ? 'ok' : s === 'trialing' ? 'info' : /past_due|unpaid|incomplete/.test(s) ? 'bad' : 'neutral');
const subBadge = (s: SubStatus | null) => (s ? <StatusBadge tone={SUB_TONE(s)}>{s.replace(/_/g, ' ')}</StatusBadge> : NA);
const INVOICE_TONE: Record<string, Tone> = { paid: 'ok', open: 'warn', uncollectible: 'bad', void: 'neutral', draft: 'neutral' };
const pct = (x: number | null | undefined) => (x == null ? '—' : `${Math.round(x * 1000) / 10}%`);
const date = (d: string | null | undefined) => (d ? dayLabel(d.slice(0, 10), true) : '—');
const every = (n: number | null) => (n && n > 1 ? `${n} ` : '');
const ALLOWANCE_HINT = 'A prepaid allowance is the account’s monthly cap on model spend (set by Octillion or by its plan). It is not revenue and is never counted in MRR or collected.';

/** Margin: dollars and the share of what was collected; red when negative. */
const marginCell = (usd: number, share: number | null) => (
  <span className={cn('tabular-nums', usd < 0 && 'text-destructive')} title='Collected minus metered model spend'>{cents(usd)}<span className='text-muted-foreground ml-1.5 text-xs'>{pct(share)}</span></span>
);

function RevenueTab({ data, loading, bar, group }: TabProps<Revenue>) {
  const router = useRouter();
  const role = useAdminRole();
  const [newPlan, setNewPlan] = useState(false);
  const [archiving, setArchiving] = useState<RevenuePlan | null>(null);
  const all = data?.accounts ?? [];
  const f = useAccountFilter(all, (a) => a.collected_usd > 0 || a.mrr_usd > 0 || a.spend_usd > 0 || a.subscriptions.length > 0 || a.invoices.length > 0, 'revenue or spend');
  const len = data?.range.days.length ?? 0;
  // Grouped by account: the accounts shown; grouped by plan: every account (the report's totals).
  const src = group === 'account' ? f.rows : all;
  const mrr = sumAt(src.map((r) => r.daily_mrr), len), got = sumAt(src.map((r) => r.daily_collected), len);
  const paying = sumAt(src.map((r) => r.daily_paying), len), spent = sumAt(src.map((r) => r.daily_spend), len);
  const collected = total(got), cost = total(spent);
  const dailyMargin = got.flatMap((c, i) => (c > 0 ? [((c - spent[i]) / c) * 100] : []));
  const ok = Boolean(data?.totals);
  const plans = data?.plans ?? [];
  const cards = group === 'provider' ? (
    <StatStrip items={[
      { label: 'Live plans', value: ok ? plans.filter((p) => p.live).length.toLocaleString() : '—' },
      { label: 'Active subscriptions', spark: sumAt(plans.map((p) => p.daily_active), len), value: ok ? plans.reduce((n, p) => n + p.active_subscriptions, 0).toLocaleString() : '—' },
      { label: 'MRR', spark: mrr, value: ok ? cents(mrr[len - 1] ?? 0) : '—' },
      { label: 'Collected', spark: got, value: ok ? cents(collected) : '—' }
    ]} />
  ) : (
    <StatStrip items={[
      { label: 'MRR', spark: mrr, value: ok ? cents(mrr[len - 1] ?? 0) : '—' },
      { label: 'Collected', spark: got, value: ok ? cents(collected) : '—' },
      { label: 'Paying accounts', spark: paying, value: ok ? (paying[len - 1] ?? 0).toLocaleString() : '—' },
      { label: 'Gross margin', spark: dailyMargin, value: ok && collected > 0 ? pct((collected - cost) / collected) : '—' }
    ]} />
  );
  const stripeEmpty = data && !data.stripe.configured ? 'Stripe is not connected: add its secret key on Key vault › Stripe to see revenue and create plans.'
    : data?.stripe.error ? `Could not read Stripe: ${data.stripe.error}` : null;
  const mixed = (data?.currencies.length ?? 0) > 1 ? <span className={cn('text-sm', AMBER)}>Invoices in {data!.currencies.join(', ').toUpperCase()}: amounts are summed as they are.</span> : null;
  // New plan and Archive plan are on the Plans tab. Without a Stripe key New plan still shows, disabled, saying where the key goes.
  const newPlanBtn = data?.stripe.configured ? <Gate need='plans'><Button onClick={() => setNewPlan(true)}><Icons.add /> New plan</Button></Gate>
    : <span title='Add the Stripe secret key on Key vault › Stripe first' className='inline-flex cursor-not-allowed'><Button disabled><Icons.add /> New plan</Button></span>;
  const newPlanDialog = newPlan && <NewPlanDialog onClose={() => setNewPlan(false)} />;
  if (group === 'provider') {
    const cols: RecordCol<RevenuePlan>[] = [
      { key: 'plan', label: 'Plan / price', title: true, keep: true, type: 'text', value: (p) => p.name, render: (p) => (
        <span className='flex min-w-0 flex-col gap-1'><span className='truncate font-medium'>{p.name}</span>{p.price_id && <Mono>{p.lookup_key ?? p.price_id}</Mono>}</span>
      ) },
      { key: 'interval', label: 'Interval', type: 'select', value: (p) => p.interval ?? '', render: (p) => (p.interval ? `Every ${every(p.interval_count)}${p.interval}` : NA) },
      { key: 'unit', label: 'Unit amount', className: 'text-right', type: 'number', value: (p) => p.unit_amount_usd, render: (p) => (p.unit_amount_usd == null ? NA : num(cents(p.unit_amount_usd))) },
      { key: 'active', label: 'Subscriptions active', className: 'text-right', type: 'number', value: (p) => p.active_subscriptions, render: (p) => num(p.active_subscriptions.toLocaleString(), `${p.subscriptions} in all, ${p.trialing} in trial`) },
      { key: 'mrr', label: 'MRR', className: 'text-right', keep: true, type: 'number', value: (p) => p.mrr_usd, render: (p) => num(cents(p.mrr_usd)) },
      { key: 'collected', label: 'Collected in range', className: 'text-right', type: 'number', value: (p) => p.collected_usd, render: (p) => num(cents(p.collected_usd)) },
      { key: 'allowance', label: 'Monthly allowance', className: 'text-right', type: 'number', value: (p) => p.monthly_budget_usd ?? null,
        render: (p) => (p.monthly_budget_usd == null ? NA : num(cents(p.monthly_budget_usd), 'The plan’s monthly cap on model spend. Not revenue.')) }
    ];
    return (<>
      <RecordView id='finops-revenue-plans' rows={data?.plans ?? []} loading={loading} rowKey={(p) => p.key} cols={cols} noun='plans' initialSize={50} compact summary={cards}
        searchText={(p) => `${p.name} ${p.lookup_key ?? ''} ${p.price_id ?? ''} ${p.accounts.map((a) => a.name).join(' ')}`} searchPlaceholder='Search plans, accounts'
        filters={<>{bar}{mixed}</>} defaultSort={[{ key: 'mrr', dir: 'desc' }]} exportName={exportName('revenue', 'plan', data?.range)}
        primary={newPlanBtn}
        actions={(p) => (p.live && p.price_id ? [
          { label: 'Copy price ID', icon: <Icons.page />, onSelect: () => copyText(p.price_id!, 'Price ID copied') },
          role.lock({ label: 'Archive plan', icon: <Icons.trash />, destructive: true, separator: true, onSelect: () => setArchiving(p) }, 'plans')
        ] : [])}
        detailTitle={(p) => p.name}
        detail={(p) => (
          <div className='grid gap-6'>
            <PeekSection title='Collected per day'>
              <DailyBars days={data?.range.days ?? []} format={(v) => `$${v < 10 ? v.toFixed(2) : Math.round(v)}`} series={[{ key: 'collected', label: 'Collected', values: p.daily_collected }]} />
            </PeekSection>
            <PeekSection title='Accounts'>
              {p.accounts.length ? <MiniTable head={['Account', 'Status', 'MRR']} rows={p.accounts.map((a) => [
                a.slug ? <a key='a' className='hover:underline' href={accountHref(a.slug)}>{a.name}</a> : <Mono key='a'>{a.name}</Mono>, subBadge(a.status), cents(a.mrr_usd)])} />
                : none('No subscriptions on this price.')}
            </PeekSection>
          </div>
        )}
        empty={stripeEmpty ?? 'No plans yet.'} />
      {newPlanDialog}
      <ArchivePlan plan={archiving} onClose={() => setArchiving(null)} />
    </>);
  }
  const cols: RecordCol<RevenueAccount>[] = [
    { key: 'account', label: 'Account', title: true, keep: true, type: 'text', value: (a) => a.name, render: (a) => (
      <span className='flex min-w-0 flex-col gap-1'>
        <span className='flex items-center gap-1.5'><span className='truncate font-medium'>{a.name}</span>{a.shared && <Chip title={SHARED_HINT}>shared</Chip>}
          {!a.shared && !a.slug && <Chip tone='warn' title='A Stripe customer no Octillion account is linked to'>not linked</Chip>}</span>
        {a.slug ? <span className='text-muted-foreground truncate text-xs'>{a.slug}</span> : a.customer && <Mono>{a.customer}</Mono>}
      </span>
    ) },
    { key: 'plan', label: 'Plan', type: 'select', value: (a) => a.plan ?? '', render: (a) => a.plan ?? NA },
    { key: 'status', label: 'Status', type: 'select', value: (a) => a.status ?? '', render: (a) => subBadge(a.status) },
    { key: 'mrr', label: 'MRR', className: 'text-right', type: 'number', value: (a) => a.mrr_usd, render: (a) => (a.mrr_usd ? num(cents(a.mrr_usd)) : NA) },
    { key: 'collected', label: 'Collected in range', className: 'text-right', keep: true, type: 'number', value: (a) => a.collected_usd, render: (a) => (a.collected_usd ? num(cents(a.collected_usd)) : NA) },
    { key: 'spend', label: 'Model spend in range', className: 'text-right', type: 'number', value: (a) => a.spend_usd, render: (a) => (a.spend_usd ? num(cents(a.spend_usd), 'Metered model spend (Model spend tab)') : NA) },
    { key: 'margin', label: 'Margin in range', className: 'text-right', type: 'number', value: (a) => a.margin_usd, render: (a) => (a.collected_usd || a.spend_usd ? marginCell(a.margin_usd, a.margin_pct) : NA) },
    { key: 'allowance', label: 'Prepaid allowance (cap, not revenue)', type: 'number', value: (a) => a.allowance?.budget_usd ?? null, render: (a) => (
      a.allowance && a.allowance.budget_usd > 0 ? (
        <span className='flex flex-col gap-1' title={ALLOWANCE_HINT}>
          <span className='tabular-nums'>{cents(a.allowance.budget_usd)} this month</span>
          <span className='text-muted-foreground text-xs'>Allowance · {SOURCE[a.allowance.source]}</span>
        </span>
      ) : NA
    ) },
    { key: 'next', label: 'Next renewal / cancel', type: 'date', value: (a) => a.cancels_at ?? a.ended_at ?? a.trial_end ?? a.renews_at, render: (a) => (
      a.ended_at ? <span className='text-muted-foreground'>Ended {date(a.ended_at)}</span>
        : a.cancels_at ? <span className={AMBER}>Cancels {date(a.cancels_at)}</span>
        : a.trial_end ? <span>Trial ends {date(a.trial_end)}</span>
        : a.renews_at ? <span>Renews {date(a.renews_at)}</span> : NA
    ) }
  ];
  return (
    <RecordView id='finops-revenue-accounts' rows={stripeEmpty ? [] : f.rows} loading={loading} rowKey={(a) => a.key} cols={cols} noun='accounts' initialSize={50} compact summary={cards}
      searchText={(a) => `${a.name} ${a.slug ?? ''} ${a.customer ?? ''} ${a.plan ?? ''} ${a.status ?? ''}`} searchPlaceholder='Search accounts, plans'
      filters={<>{bar}{f.controls}{mixed}</>} defaultSort={[{ key: 'collected', dir: 'desc' }]} exportName={exportName('revenue', 'account', data?.range)}
      actions={accountActions(router)} detailTitle={accountTitle}
      detail={(a) => (
        <div className='grid gap-6'>
          <PeekSection title='Collected and model spend per day'>
            <p className='text-sm'>{cents(a.collected_usd)} collected, {cents(a.spend_usd)} metered model spend: margin {cents(a.margin_usd)} ({pct(a.margin_pct)}).</p>
            <DailyBars days={data?.range.days ?? []} format={(v) => `$${v < 10 ? v.toFixed(2) : Math.round(v)}`}
              series={[{ key: 'collected', label: 'Collected', values: a.daily_collected }, { key: 'spend', label: 'Model spend', values: a.daily_spend }]} />
          </PeekSection>
          <PeekSection title='Invoices in range'>
            {a.invoices.length ? <MiniTable head={['Number', 'Date', 'Amount', 'Status', '']} rows={a.invoices.map((i) => [
              <Mono key='n'>{i.number ?? i.id}</Mono>, date(i.paid_at ?? i.created), cents(i.amount_usd),
              <StatusBadge key='s' tone={INVOICE_TONE[i.status] ?? 'neutral'}>{i.status}</StatusBadge>,
              i.url ? <a key='u' href={i.url} target='_blank' rel='noreferrer' className='inline-flex items-center gap-1 hover:underline'>Open <Icons.externalLink className='size-3' /></a> : '—'])} />
              : none('No invoices in this range.')}
          </PeekSection>
          <PeekSection title='Subscription history'>
            {a.subscriptions.length ? <MiniTable head={['Plan', 'Status', 'Started', 'Trial end', 'Canceled', 'Ended', 'MRR']} rows={a.subscriptions.map((s) => [
              <span key='p' className='flex flex-col'><span>{s.plan ?? '—'}</span><Mono>{s.id}</Mono></span>, subBadge(s.status), date(s.started_at), date(s.trial_end),
              date(s.canceled_at), s.ended_at ? date(s.ended_at) : s.cancel_at ? `Cancels ${date(s.cancel_at)}` : '—', `${cents(s.mrr_usd)}${s.interval === 'year' ? ' (yearly ÷ 12)' : ''}`])} />
              : none(a.shared ? 'Shared spend has no subscription.' : 'No Stripe subscription.')}
          </PeekSection>
          {a.allowance && a.allowance.budget_usd > 0 && (
            <PeekSection title='Prepaid allowance'>
              <p className='text-muted-foreground text-sm'>{cents(a.allowance.budget_usd)} this month ({SOURCE[a.allowance.source]}). {ALLOWANCE_HINT}</p>
            </PeekSection>
          )}
        </div>
      )}
      empty={stripeEmpty ?? (f.filtered ? 'No accounts match.' : 'No revenue or model spend in this range.')} />
  );
}

// ---------------------------------------------------------------- Model spend

/** New plan (owner): a product and a recurring price in Stripe, with an octillion_ lookup key so checkout links can offer it. */
function NewPlanDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [allowance, setAllowance] = useState('');
  const [interval, setIv] = useState<'month' | 'year'>('month');
  const [err, setErr] = useState('');
  const make = useAdminAction((b: { name: string; amount_usd: number; monthly_budget_usd: number; interval: 'month' | 'year' }) =>
    post<{ name: string; lookup_key: string }>('/plans', b), { success: (r) => `Plan ${r.name} created in Stripe` });
  const price = Number(amount);
  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (!(price > 0)) return setErr('Enter a price above $0.');
    const budget = allowance.trim() === '' ? price : Number(allowance);
    if (!Number.isFinite(budget) || budget < 0) return setErr('Enter a monthly allowance of $0 or more.');
    make.mutate({ name: name.trim(), amount_usd: price, monthly_budget_usd: budget, interval }, { onSuccess: onClose, onError: (x) => setErr(x.message) });
  };
  const per = interval === 'year' ? 'year' : 'month';
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <form onSubmit={submit} className='grid gap-4'>
          <DialogHeader>
            <DialogTitle>New plan</DialogTitle>
            <DialogDescription>A prepaid plan in Stripe. Accounts allowed a prepaid plan can be sent a checkout link for it.</DialogDescription>
          </DialogHeader>
          <FormRow id='np-name' label='Plan name' hint={name.trim() ? `Lookup key: octillion_${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}` : 'Customers see this name at checkout.'}>
            <Input id='np-name' required autoFocus minLength={2} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder='Team' />
          </FormRow>
          <FormRow id='np-interval' label='Billed every'>
            <NativeSelect id='np-interval' value={interval} onChange={(e) => setIv(e.target.value as 'month' | 'year')}>
              <NativeSelectOption value='month'>Month</NativeSelectOption>
              <NativeSelectOption value='year'>Year</NativeSelectOption>
            </NativeSelect>
          </FormRow>
          <FormRow id='np-amount' label={`Price per ${per} (USD)`}>
            <Input id='np-amount' required type='number' inputMode='decimal' min='0.01' max='100000' step='0.01' value={amount} onChange={(e) => setAmount(e.target.value)} placeholder='250' />
          </FormRow>
          <FormRow id='np-allowance' label='Monthly allowance (USD)' hint={`The most the account can spend on models each month. Leave empty to use the price${price > 0 ? ` ($${price.toLocaleString()})` : ''}.`}>
            <Input id='np-allowance' type='number' inputMode='decimal' min='0' step='0.01' value={allowance} onChange={(e) => setAllowance(e.target.value)} placeholder={price > 0 ? String(price) : ''} />
          </FormRow>
          {err && <p className='text-destructive text-sm'>{err}</p>}
          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose}>Cancel</Button>
            <Button type='submit' disabled={make.isPending}>{make.isPending && <Icons.spinner className='animate-spin' />} Create plan</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Archive a plan (owner): the Stripe price is turned off, never deleted; current subscribers keep it. */
function ArchivePlan({ plan, onClose }: { plan: RevenuePlan | null; onClose: () => void }) {
  const archive = useAdminAction((id: string) => post(`/plans/${encodeURIComponent(id)}/archive`), { success: 'Plan archived' });
  return (
    <AlertDialog open={!!plan} onOpenChange={(v) => !v && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive {plan?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            New checkout links can no longer offer it. Accounts already on it keep it until they cancel. Stripe keeps the plan, so nothing is deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant='destructive' onClick={() => { if (plan?.price_id) archive.mutate(plan.price_id); onClose(); }}>Archive plan</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function SpendTab({ data, loading, bar, group, range }: TabProps<Spend> & { range: DateRange }) {
  const all = data?.accounts ?? [];
  const f = useAccountFilter(all, (a) => a.spent_usd > 0 || a.month_usd > 0, 'spend');
  // The four numbers are the same whichever grouping: the accounts shown, or every account when grouped by provider.
  const rows = group === 'account' ? f.rows : all;
  const len = data?.range.days.length ?? 0;
  const session = sumAt(rows.map((r) => r.daily_session), len), orch = sumAt(rows.map((r) => r.daily_orchestrator), len);
  const month = sumAt(rows.map((r) => r.month_daily), data?.month.days.length ?? 0);
  const m = data?.month;
  // Month-end pace: spend so far plus the last 7 days' daily rate times the days left (the same rule as Billing and
  // Budget rules), not the whole-month average, which lags when spending has only just started.
  const recentDays = m ? Math.min(7, m.elapsed_days) : 0;
  const pace = m && recentDays > 0 ? total(month) + (total(month.slice(-7)) / recentDays) * Math.max(0, m.days_in_month - m.elapsed_days) : null;
  const cards = (
    <StatStrip items={[
      { label: 'Total spend', spark: session.map((x, i) => x + orch[i]), value: data ? cents(total(session) + total(orch)) : '—' },
      { label: 'Session spend', spark: session, value: data ? cents(total(session)) : '—' },
      { label: 'Orchestrator spend', spark: orch, value: data ? cents(total(orch)) : '—' },
      { label: 'Month-end pace', spark: cumulative(month), value: pace == null ? '—' : cents(pace) }
    ]} />
  );
  return group === 'account'
    ? <SpendAccounts data={data} loading={loading} rows={f.rows} cards={cards} filters={<>{bar}{f.controls}</>} filtered={f.filtered} range={range} />
    : <SpendProviders data={data} loading={loading} cards={cards} bar={bar} />;
}

function SpendAccounts({ data, loading, rows, cards, filters, filtered, range }: { data: Spend | undefined; loading: boolean; rows: AccountRow[]; cards: ReactNode;
  filters: ReactNode; filtered: boolean; range: DateRange }) {
  const router = useRouter();
  const cols: RecordCol<AccountRow>[] = [
    { key: 'account', label: 'Account', title: true, keep: true, type: 'text', value: (a) => a.name, render: accountCell },
    { key: 'allowance', label: 'Plan / allowance', type: 'number', value: (a) => a.allowance?.budget_usd ?? null, render: (a) => (
      a.allowance ? (
        <span className='flex flex-col gap-1'>
          <span className='tabular-nums'>{a.allowance.budget_usd > 0 ? `${cents(a.allowance.budget_usd)} a month` : 'No allowance'}</span>
          <span className='text-muted-foreground text-xs'>{a.allowance.plan ?? SOURCE[a.allowance.source]}{a.allowance.plan && a.allowance.source === 'override' && ' · set by Octillion'}</span>
        </span>
      ) : NA
    ) },
    { key: 'spent', label: 'Spent in range', className: 'text-right', type: 'number', value: (a) => a.spent_usd, render: (a) => num(cents(a.spent_usd), `Sessions ${cents(a.session_usd)} · orchestrators ${cents(a.orchestrator_usd)}`) },
    { key: 'session', label: 'Sessions $', className: 'text-right', hidden: true, type: 'number', value: (a) => a.session_usd, render: (a) => num(cents(a.session_usd)) },
    { key: 'orchestrator', label: 'Orchestrators $', className: 'text-right', hidden: true, type: 'number', value: (a) => a.orchestrator_usd, render: (a) => num(cents(a.orchestrator_usd)) },
    { key: 'month', label: 'This month vs allowance', className: 'w-56', type: 'number', value: (a) => a.month_pct ?? null, render: (a) => (
      a.shared ? <span className='text-muted-foreground text-xs tabular-nums'>{cents(a.month_usd)} this month, no allowance</span>
        : <AllowanceMeter used={a.month_usd} budget={a.allowance?.budget_usd ?? 0} pct={a.month_pct} />
    ) },
    { key: 'sessions', label: 'Sessions', className: 'text-right', type: 'number', value: (a) => a.sessions, render: (a) => (a.sessions ? num(a.sessions.toLocaleString()) : NA) },
    { key: 'top_model', label: 'Top model', type: 'select', value: (a) => a.top_model ?? '', render: (a) => (a.top_model ? <Mono>{short(a.top_model)}</Mono> : NA) },
    { key: 'last', label: 'Last spend', type: 'date', value: (a) => a.last_spend_at, render: (a) => (a.last_spend_at ? <When d={a.last_spend_at} /> : NA) }
  ];
  return (
    <RecordView id='spend-accounts' rows={rows} loading={loading} rowKey={(a) => a.key} cols={cols} noun='accounts' initialSize={50} compact summary={cards}
      searchText={(a) => `${a.name} ${a.slug ?? ''} ${a.top_model ?? ''} ${a.allowance?.plan ?? ''}`} searchPlaceholder='Search accounts, models'
      filters={filters} defaultSort={[{ key: 'spent', dir: 'desc' }]} exportName={exportName('spend', 'account', data?.range)}
      actions={accountActions(router)} detailTitle={accountTitle}
      detail={(a) => <AccountPeek a={a} days={data?.range.days ?? []} range={range} />}
      empty={filtered ? 'No accounts match.' : 'No model spend in this range.'} />
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

/** One account's peek: its daily spend, then spend by person, model, agent and product (GET /spend/accounts/:key). */
function AccountPeek({ a, days, range }: { a: AccountRow; days: string[]; range: DateRange }) {
  const { data, error, isLoading } = useAdmin<AccountDetail>(`/spend/accounts/${encodeURIComponent(a.key)}?${rangeQuery(range)}`);
  return (
    <div className='grid gap-6'>
      <PeekSection title='Daily spend'>
        <p className='text-sm'>{cents(a.spent_usd)} in range: sessions {cents(a.session_usd)}, orchestrators {cents(a.orchestrator_usd)}.</p>
        <DailyBars days={days} format={(v) => `$${v < 10 ? v.toFixed(2) : Math.round(v)}`}
          series={[{ key: 'session', label: 'Sessions', values: a.daily_session }, { key: 'orchestrator', label: 'Orchestrators', values: a.daily_orchestrator }]} />
      </PeekSection>
      {isLoading ? <Skeleton className='h-40' /> : !data ? <ErrorBox error={error} /> : (
        <>
          {!a.shared && (
            <PeekSection title='By person'>
              {data.by_person.length ? <MiniTable head={['Who', 'Sessions', 'Sessions $', 'Orchestrators $', 'Total']} rows={data.by_person.map((p) => [
                <span key='w' title={p.user_id ?? undefined}>{p.label}</span>, p.sessions, cents(p.session_usd), cents(p.orchestrator_usd), <span key='t' className='font-medium'>{cents(p.usd)}</span>])} />
                : none('No spend in this range.')}
            </PeekSection>
          )}
          <PeekSection title={a.shared ? 'Orchestrator models (all orchestrator spend)' : 'By model'}>
            {data.by_model.length ? <MiniTable head={a.shared ? ['Model', 'Provider', 'Requests', '$'] : ['Model', 'Sessions', '$']} rows={data.by_model.map((m) => a.shared
              ? [<Mono key='m'>{m.model}</Mono>, <Mono key='p'>{m.provider}</Mono>, (m.requests ?? 0).toLocaleString(), cents(m.usd)]
              : [<Mono key='m'>{m.model}</Mono>, m.sessions ?? 0, cents(m.usd)])} />
              : none('No spend in this range.')}
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

interface ProviderRow {
  provider: string; models: ModelRow[]; requests: number; errors: number; input_tokens: number; cached_input_tokens: number; output_tokens: number;
  cost_usd: number; priced: boolean; unpriced_requests: number; top_accounts: ProviderSpend['top_accounts'];
}

/** Grouped by provider: the model rows (sessions, orchestrators or both) summed per provider. */
function SpendProviders({ data, loading, cards, bar }: { data: Spend | undefined; loading: boolean; cards: ReactNode; bar: ReactNode }) {
  const [consumer, setConsumer] = useState('');
  const rows = useMemo(() => {
    const top = new Map((data?.providers ?? []).map((p) => [p.provider, p.top_accounts]));
    const by = new Map<string, ProviderRow>();
    for (const m of data?.models ?? []) {
      if (consumer && m.consumer !== consumer) continue;
      const p = by.get(m.provider) ?? { provider: m.provider, models: [], requests: 0, errors: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, cost_usd: 0,
        priced: true, unpriced_requests: 0, top_accounts: top.get(m.provider) ?? [] };
      by.set(m.provider, p);
      p.models.push(m); p.requests += m.requests; p.errors += m.errors; p.input_tokens += m.input_tokens; p.cached_input_tokens += m.cached_input_tokens;
      p.output_tokens += m.output_tokens; p.cost_usd += m.cost_usd; p.priced &&= m.priced; p.unpriced_requests += m.unpriced_requests;
    }
    return [...by.values()];
  }, [data, consumer]);
  const tok = (k: 'input_tokens' | 'cached_input_tokens' | 'output_tokens', label: string): RecordCol<ProviderRow> =>
    ({ key: k, label, className: 'text-right', type: 'number', value: (p) => p[k], render: (p) => num(tokens(p[k]), p[k].toLocaleString()) });
  const cols: RecordCol<ProviderRow>[] = [
    { key: 'provider', label: 'Provider', title: true, keep: true, type: 'text', value: (p) => p.provider, render: (p) => <Mono>{p.provider}</Mono> },
    { key: 'models', label: 'Models', className: 'text-right', type: 'number', value: (p) => new Set(p.models.map((m) => m.model)).size, render: (p) => num(new Set(p.models.map((m) => m.model)).size) },
    { key: 'requests', label: 'Requests', className: 'text-right', type: 'number', value: (p) => p.requests, render: (p) => num(p.requests.toLocaleString()) },
    { key: 'errors', label: 'Errors', className: 'text-right', type: 'number', value: (p) => p.errors, render: (p) => (p.errors ? <span className='text-destructive tabular-nums'>{p.errors.toLocaleString()}</span> : <span className='text-muted-foreground'>0</span>) },
    tok('input_tokens', 'Input'), tok('cached_input_tokens', 'Cached'), tok('output_tokens', 'Output'),
    { key: 'cost', label: 'Cost', className: 'text-right', keep: true, type: 'number', value: (p) => p.cost_usd, render: (p) => num(cents(p.cost_usd)) },
    { key: 'priced', label: 'Priced', type: 'select', value: (p) => (p.priced ? 'Priced' : 'Unpriced'), render: (p) => (
      p.priced ? <StatusBadge tone='ok'>Priced</StatusBadge>
        : <StatusBadge tone='warn' title={`${UNPRICED} ${p.unpriced_requests.toLocaleString()} requests on unpriced days.`}>Unpriced</StatusBadge>
    ) }
  ];
  const filters = (
    <>
      {bar}
      <NativeSelect aria-label='Used by' value={consumer} onChange={(e) => setConsumer(e.target.value)}>
        <NativeSelectOption value=''>Sessions and orchestrators</NativeSelectOption>
        <NativeSelectOption value='session'>Sessions</NativeSelectOption>
        <NativeSelectOption value='orchestrator'>Orchestrators</NativeSelectOption>
      </NativeSelect>
    </>
  );
  return (
    <RecordView id='spend-providers' rows={rows} loading={loading} rowKey={(p) => p.provider} cols={cols} noun='providers' initialSize={50} compact summary={cards}
      searchText={(p) => `${p.provider} ${p.models.map((m) => m.model).join(' ')} ${p.priced ? '' : 'unpriced'}`} searchPlaceholder='Search providers, models'
      filters={filters} defaultSort={[{ key: 'cost', dir: 'desc' }]} exportName={exportName('spend', 'provider', data?.range)}
      detailTitle={(p) => <Mono>{p.provider}</Mono>}
      detail={(p) => (
        <div className='grid gap-6'>
          <PeekSection title='Models'>
            <MiniTable head={['Model', 'Used by', 'Requests', 'Tokens', 'Cost']} rows={[...p.models].sort((a, b) => b.cost_usd - a.cost_usd).map((m) => [
              <span key='m' className='flex items-center gap-1.5'><Mono>{m.model}</Mono>{!m.priced && <Chip tone='warn' title={UNPRICED}>unpriced</Chip>}</span>,
              CONSUMER[m.consumer], m.requests.toLocaleString(), tokens(m.input_tokens + m.output_tokens), cents(m.cost_usd)])} />
          </PeekSection>
          <PeekSection title='Top accounts'>
            {p.top_accounts.length ? <MiniTable head={['Account', 'Requests', '$']} rows={p.top_accounts.map((a) => [a.name, a.requests.toLocaleString(), cents(a.usd)])} />
              : none('No gateway requests through this provider in this range.')}
          </PeekSection>
        </div>
      )}
      empty={consumer ? 'No providers match.' : 'No model requests in this range.'} />
  );
}

// ---------------------------------------------------------------- Compute hours

function ComputeTab({ data, loading, bar, group }: TabProps<Compute>) {
  const router = useRouter();
  const all = data?.accounts ?? [];
  const f = useAccountFilter(all, (a) => a.total_hours > 0, 'compute');
  const len = data?.range.days.length ?? 0;
  const src = group === 'account' ? f.rows : all;
  const orch = sumAt(src.map((r) => r.daily_orchestrator), len), agent = sumAt(src.map((r) => r.daily_agent), len);
  const cards = (
    <StatStrip items={[
      { label: 'Total sandbox hours', spark: orch.map((x, i) => x + agent[i]), value: data ? hrs(total(orch) + total(agent)) : '—' },
      { label: 'Orchestrator hours', spark: orch, value: data ? hrs(total(orch)) : '—' },
      { label: 'Agent hours', spark: agent, value: data ? hrs(total(agent)) : '—' },
      // Computed from the sandboxes' start and end times (src/spend-usage.ts), not autoscaler samples.
      { label: 'Peak running at once', spark: data?.totals.daily_peak, value: data ? data.totals.peak_running.toLocaleString() : '—' }
    ]} />
  );
  const days = data?.range.days ?? [];
  const daily = (x: { daily_orchestrator: number[]; daily_agent: number[] }) => (
    <DailyBars days={days} format={(v) => hrs(v)}
      series={[{ key: 'orchestrator', label: 'Orchestrators', values: x.daily_orchestrator }, { key: 'agent', label: 'Agents', values: x.daily_agent }]} />
  );
  const hcol = <T extends { orchestrator_hours: number; agent_hours: number; total_hours: number }>(k: 'orchestrator_hours' | 'agent_hours' | 'total_hours', label: string, keep = false): RecordCol<T> =>
    ({ key: k, label, className: 'text-right', keep, type: 'number', value: (r) => r[k], render: (r) => <span className={cn('tabular-nums', k === 'total_hours' && 'font-medium')}>{hrs(r[k])}</span> });
  if (group === 'provider') {
    const cols: RecordCol<ComputeProvider>[] = [
      { key: 'provider', label: 'Sandbox provider', title: true, keep: true, type: 'text', value: (p) => p.name, render: (p) => <span className='font-medium'>{p.name}</span> },
      hcol('orchestrator_hours', 'Orchestrator hours'), hcol('agent_hours', 'Agent hours'), hcol('total_hours', 'Total', true),
      { key: 'sessions', label: 'Sessions run', className: 'text-right', type: 'number', value: (p) => p.sessions, render: (p) => num(p.sessions.toLocaleString()) },
      { key: 'orchestrators', label: 'Orchestrators launched', className: 'text-right', type: 'number', value: (p) => p.orchestrators, render: (p) => num(p.orchestrators.toLocaleString()) },
      { key: 'types', label: 'Sandbox types', type: 'text', value: (p) => p.sandbox_types.map((t) => t.type ?? '').join(' '), render: (p) => (
        <span className='flex flex-wrap gap-1'>{p.sandbox_types.map((t) => <Chip key={`${t.kind}${t.type}`}>{t.kind.toLowerCase()} {t.type ?? 'default'}</Chip>)}</span>
      ) }
    ];
    return (
      <RecordView id='spend-compute-providers' rows={data?.providers ?? []} loading={loading} rowKey={(p) => p.key} cols={cols} noun='providers' initialSize={50} compact summary={cards}
        searchText={(p) => `${p.name} ${p.by_account.map((a) => a.name).join(' ')}`} searchPlaceholder='Search providers, accounts'
        filters={bar} defaultSort={[{ key: 'total_hours', dir: 'desc' }]} exportName={exportName('compute-hours', 'provider', data?.range)}
        detailTitle={(p) => p.name}
        detail={(p) => (
          <div className='grid gap-6'>
            <PeekSection title='Hours per day'>{daily(p)}</PeekSection>
            <PeekSection title='By sandbox type'>
              {p.sandbox_types.length ? <MiniTable head={['Used for', 'Type', 'Hours']} rows={p.sandbox_types.map((t) => [t.kind === 'Agent' ? 'Agents' : 'Orchestrators', <Mono key='t'>{t.type ?? 'not recorded'}</Mono>, hrs(t.hours)])} /> : none()}
            </PeekSection>
            <PeekSection title='By account'>
              {p.by_account.length ? <MiniTable head={['Account', 'Orchestrator hours', 'Agent hours', 'Sessions', 'Total']} rows={p.by_account.map((a) => [a.name, hrs(a.orchestrator_hours), hrs(a.agent_hours), a.sessions, <span key='t' className='font-medium'>{hrs(a.total_hours)}</span>])} /> : none()}
            </PeekSection>
          </div>
        )}
        empty='No sandboxes ran in this range.' />
    );
  }
  const cols: RecordCol<ComputeAccount>[] = [
    { key: 'account', label: 'Account', title: true, keep: true, type: 'text', value: (a) => a.name, render: accountCell },
    hcol('orchestrator_hours', 'Orchestrator hours'), hcol('agent_hours', 'Agent hours'), hcol('total_hours', 'Total', true),
    { key: 'sessions', label: 'Sessions run', className: 'text-right', type: 'number', value: (a) => a.sessions, render: (a) => (a.sessions ? num(a.sessions.toLocaleString()) : NA) },
    { key: 'orchestrators', label: 'Orchestrators launched', className: 'text-right', type: 'number', value: (a) => a.orchestrators, render: (a) => (a.orchestrators ? num(a.orchestrators.toLocaleString()) : NA) },
    { key: 'avg', label: 'Avg session', className: 'text-right', type: 'number', value: (a) => a.avg_session_hours, render: (a) => (a.avg_session_hours == null ? NA : num(hrs(a.avg_session_hours))) },
    { key: 'longest', label: 'Longest session', className: 'text-right', type: 'number', value: (a) => a.longest_session_hours, render: (a) => (a.longest_session_hours == null ? NA : num(hrs(a.longest_session_hours))) }
  ];
  return (
    <RecordView id='spend-compute-accounts' rows={f.rows} loading={loading} rowKey={(a) => a.key} cols={cols} noun='accounts' initialSize={50} compact summary={cards}
      searchText={(a) => `${a.name} ${a.slug ?? ''} ${a.by_agent.map((x) => x.agent).join(' ')}`} searchPlaceholder='Search accounts, agents'
      filters={<>{bar}{f.controls}</>} defaultSort={[{ key: 'total_hours', dir: 'desc' }]} exportName={exportName('compute-hours', 'account', data?.range)}
      actions={accountActions(router)} detailTitle={accountTitle}
      detail={(a) => (
        <div className='grid gap-6'>
          <PeekSection title='Hours per day'>{daily(a)}</PeekSection>
          <PeekSection title='By agent'>
            {a.by_agent.length ? <MiniTable head={['Agent', 'Sessions', 'Hours']} rows={a.by_agent.map((x) => [<Mono key='a'>{x.agent}</Mono>, x.sessions, hrs(x.hours)])} /> : none('No agent sessions in this range.')}
          </PeekSection>
          <PeekSection title='Top jobs'>
            {a.by_job.length ? <MiniTable head={['Job', 'Orchestrator hours', 'Agent hours', 'Total']} rows={a.by_job.map((j) => [
              <span key='j' className='flex flex-col'><span>{j.name ?? (j.kind === 'research' ? 'Research' : 'Simulation')}</span><Mono>{j.job_id}</Mono></span>,
              hrs(j.orchestrator_hours), hrs(j.agent_hours), <span key='t' className='font-medium'>{hrs(j.total_hours)}</span>])} /> : none('No job ran in this range.')}
          </PeekSection>
        </div>
      )}
      empty={f.filtered ? 'No accounts match.' : 'No sandboxes ran in this range.'} />
  );
}

// ---------------------------------------------------------------- Data & storage

function StorageTab({ data, loading, bar, group }: TabProps<Storage>) {
  const router = useRouter();
  const all = data?.accounts ?? [];
  const f = useAccountFilter(all, (a) => a.rows > 0 || a.gateway_bytes > 0, 'data');
  const [kind, setKind] = useState('');
  const t = data?.totals;
  const cards = (
    <StatStrip items={[
      // Sizes have no history: these sparklines are the daily new rows of what they measure.
      { label: 'Database size', spark: t?.daily_new_rows, value: t ? bytes(t.db_bytes) : '—' },
      { label: 'Transcripts', spark: t?.daily_transcript_rows, value: t ? (t.transcript_bytes != null ? bytes(t.transcript_bytes) : count(t.transcript_rows)) : '—' },
      { label: 'Gateway data in range', spark: t?.daily_gateway_bytes, value: t ? bytes(t.gateway_bytes) : '—' },
      { label: 'New rows in range', spark: t?.daily_new_rows, value: t ? count(t.new_rows) : '—' }
    ]} />
  );
  if (group === 'provider') {
    const rows = (data?.stores ?? []).filter((s) => !kind || s.kind === kind);
    const cols: RecordCol<StoreRow>[] = [
      { key: 'store', label: 'Store', title: true, keep: true, type: 'text', value: (s) => s.name, render: (s) => (
        <span className='flex min-w-0 flex-col gap-1'><span className='truncate font-medium'>{s.name}</span><Mono>{s.detail}</Mono></span>
      ) },
      { key: 'kind', label: 'Kind', type: 'select', value: (s) => KIND[s.kind], render: (s) => KIND[s.kind] },
      { key: 'size', label: 'Size', className: 'text-right', keep: true, type: 'number', value: (s) => s.bytes, render: (s) => (s.bytes == null ? NA : num(bytes(s.bytes))) },
      { key: 'rows', label: 'Rows', className: 'text-right', type: 'number', value: (s) => s.rows, render: (s) => (s.rows == null ? NA : num(count(s.rows), `${s.rows.toLocaleString()}${s.kind === 'gateway' ? ' requests' : ''}`)) },
      { key: 'new', label: 'New in range', className: 'text-right', type: 'number', value: (s) => s.new_bytes ?? s.new_rows, render: (s) => (
        s.new_bytes != null ? num(bytes(s.new_bytes)) : s.new_rows == null ? NA : num(count(s.new_rows))
      ) },
      { key: 'last', label: 'Last write', type: 'date', value: (s) => s.last_write, render: (s) => (s.last_write ? <When d={s.last_write} /> : NA) }
    ];
    const filters = (
      <>
        {bar}
        <NativeSelect aria-label='Kind' value={kind} onChange={(e) => setKind(e.target.value)}>
          <NativeSelectOption value=''>Every kind</NativeSelectOption>
          {(Object.keys(KIND) as StoreKind[]).map((k) => <NativeSelectOption key={k} value={k}>{KIND[k]}</NativeSelectOption>)}
        </NativeSelect>
      </>
    );
    return (
      <RecordView id='spend-storage-stores' rows={rows} loading={loading} rowKey={(s) => s.key} cols={cols} noun='stores' initialSize={50} compact summary={cards}
        searchText={(s) => `${s.name} ${s.detail} ${KIND[s.kind]} ${s.parts.map((p) => `${p.label} ${p.name}`).join(' ')}`} searchPlaceholder='Search stores, tables'
        filters={filters} defaultSort={[{ key: 'size', dir: 'desc' }]} exportName={exportName('storage', 'provider', data?.range)}
        detailTitle={(s) => s.name}
        detail={(s) => <StorePeek s={s} days={data?.range.days ?? []} />}
        empty={kind ? 'No stores match.' : 'Nothing stored yet.'} />
    );
  }
  const cols: RecordCol<StorageAccount>[] = [
    { key: 'account', label: 'Account', title: true, keep: true, type: 'text', value: (a) => a.name, render: accountCell },
    { key: 'rows', label: 'Rows it owns', className: 'text-right', keep: true, type: 'number', value: (a) => a.rows, render: (a) => num(count(a.rows), a.rows.toLocaleString()) },
    { key: 'new', label: 'New rows in range', className: 'text-right', type: 'number', value: (a) => a.new_rows, render: (a) => (a.new_rows ? num(count(a.new_rows)) : NA) },
    { key: 'events', label: 'Transcript events', className: 'text-right', type: 'number', value: (a) => a.transcript_events, render: (a) => (a.transcript_events ? num(count(a.transcript_events), `${a.new_transcript_events.toLocaleString()} in range`) : NA) },
    { key: 'gateway', label: 'Gateway data in range', className: 'text-right', type: 'number', value: (a) => a.gateway_bytes, render: (a) => (a.gateway_bytes ? num(bytes(a.gateway_bytes), `${a.gateway_requests.toLocaleString()} requests`) : NA) },
    { key: 'last', label: 'Last write', type: 'date', value: (a) => a.last_write, render: (a) => (a.last_write ? <When d={a.last_write} /> : NA) }
  ];
  return (
    <RecordView id='spend-storage-accounts' rows={f.rows} loading={loading} rowKey={(a) => a.key} cols={cols} noun='accounts' initialSize={50} compact summary={cards}
      searchText={(a) => `${a.name} ${a.slug ?? ''}`} searchPlaceholder='Search accounts'
      filters={<>{bar}{f.controls}</>} defaultSort={[{ key: 'rows', dir: 'desc' }]} exportName={exportName('storage', 'account', data?.range)}
      actions={accountActions(router)} detailTitle={accountTitle}
      detail={(a) => (
        <div className='grid gap-6'>
          <PeekSection title='New rows per day'>
            <DailyBars days={data?.range.days ?? []} format={(v) => count(v)} series={[{ key: 'rows', label: 'New rows', values: a.daily_new }]} />
          </PeekSection>
          <PeekSection title='By table'>
            {a.by_table.length ? <MiniTable head={['Table', 'Rows', 'New in range']} rows={a.by_table.map((x) => [
              <span key='t' className='flex flex-col'><span>{x.label}</span><Mono>{x.name}</Mono></span>, x.rows.toLocaleString(), x.new_rows.toLocaleString()])} /> : none('No rows.')}
          </PeekSection>
          <PeekSection title='Gateway data by provider'>
            {a.gateway_by_provider.length ? <MiniTable head={['Provider', 'Data']} rows={a.gateway_by_provider.map((x) => [<Mono key='p'>{x.provider}</Mono>, bytes(x.bytes)])} /> : none('No gateway traffic in this range.')}
          </PeekSection>
        </div>
      )}
      empty={f.filtered ? 'No accounts match.' : 'No data in this range.'} />
  );
}

function StorePeek({ s, days }: { s: StoreRow; days: string[] }) {
  const gateway = s.kind === 'gateway';
  return (
    <div className='grid gap-6'>
      <PeekSection title={gateway ? 'Data per day' : 'New rows per day'}>
        <DailyBars days={days} format={gateway ? (v) => bytes(v) : (v) => count(v)} series={[{ key: 'n', label: gateway ? 'Data' : 'New rows', values: s.daily_new }]} />
      </PeekSection>
      {s.parts.length > 0 && (
        <PeekSection title={s.kind === 'database' ? 'Tables' : 'What it holds'}>
          <MiniTable head={s.kind === 'database' ? ['Table', 'Size', 'Rows', 'New in range', 'Last write'] : ['What', 'Rows']}
            rows={[...s.parts].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0) || b.rows - a.rows).map((p) => s.kind === 'database'
              ? [<span key='t' className='flex flex-col'><span>{p.label}</span><Mono>{p.name}</Mono></span>, bytes(p.bytes), p.rows.toLocaleString(), p.new_rows.toLocaleString(),
                p.last_write ? <When key='w' d={p.last_write} /> : '—']
              : [<span key='t' className='flex flex-col'><span>{p.label}</span><Mono>{p.name}</Mono></span>, p.rows.toLocaleString()])} />
        </PeekSection>
      )}
    </div>
  );
}
