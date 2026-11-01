'use client';
// Compute › Sandbox probes (GET /compute/probes, src/sandbox-probe.ts): boat.dev and Vercel Sandbox side by side,
// measured by the deployment's own probe cron. On top, the two providers compared over the last 24 h (or 7 days):
// create success, ready time, how many probes lived their full 15 minutes, how many vanished early and at what age,
// exec success and latency, delete success, plus what the probe costs a day. Below, one row per probe with a peek: its
// facts, then its execs and checks, and every error it met. Read only: the cron starts and deletes probes.
import { useMemo, type ReactNode } from 'react';
import { DetailMeta, DetailTable, DetailTabs } from '@/components/layout/detail';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';
import { useAdmin } from './lib';
import { copyText, ErrorBox, Mono, Notice, StatusBadge, When, type Tone } from './ui';
import { AMBER, dur, money, since, useComputeParams } from './compute-common';

type Provider = 'boat' | 'vercel';
interface ProviderSummary {
  provider: Provider; configured: boolean; not_configured_reason: string | null; started: number; created: number; create_ok_pct: number | null;
  ready_p50_ms: number | null; ready_p95_ms: number | null; finished: number; survived: number; survived_pct: number | null;
  gone_early: number; gone_median_age_s: number | null; execs: number; exec_ok_pct: number | null; exec_p50_ms: number | null; exec_p95_ms: number | null;
  checks: number; check_ok_pct: number | null; deletes: number; delete_ok_pct: number | null; live: number; last_started_at: string | null; last_error: string | null;
}
interface Cost { probes_per_day: number; minutes_each: number; boat_usd_day: number; vercel_usd_day: number; total_usd_day: number; boat_starts_per_day: number; note: string }
export interface ProbeRow {
  id: number; provider: Provider; sandbox_id: string | null; name: string | null; state: string; region: string | null; started_at: string;
  create_ms: number | null; ready_ms: number | null; create_error: string | null; gone_at: string | null; gone_reason: string | null; gone_age_s: number | null;
  deleted_at: string | null; delete_ms: number | null; delete_error: string | null; execs_ok: number; execs_failed: number;
  exec_p50_ms: number | null; exec_p95_ms: number | null; last_error: string | null;
}
interface Probes { hours: number; enabled: boolean; lifetime_minutes: number; every_minutes: number; providers: ProviderSummary[]; cost: Cost; rows: ProbeRow[] }
interface Detail {
  row: ProbeRow;
  execs: { id: number; at: string; kind: 'exec' | 'check'; ok: boolean; ms: number | null; exit_code: number | null; error: string | null }[];
  errors: { at: string; step: string; error: string }[];
}

const LABEL: Record<Provider, string> = { boat: 'boat.dev', vercel: 'Vercel Sandbox' };
const STATE: Record<string, { label: string; tone: Tone }> = {
  starting: { label: 'starting', tone: 'info' }, live: { label: 'live', tone: 'ok' }, deleted: { label: 'lived its time', tone: 'neutral' },
  gone: { label: 'gone early', tone: 'bad' }, failed: { label: 'create failed', tone: 'bad' }, not_configured: { label: 'not configured', tone: 'warn' }
};
const ms = (v: number | null | undefined) => (v == null ? '—' : v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)} s`);
const pct = (v: number | null | undefined) => (v == null ? '—' : `${v}%`);
const stateOf = (r: ProbeRow) => STATE[r.state] ?? { label: r.state, tone: 'neutral' as Tone };
/** What went wrong with a probe, in one line: the create, its disappearance, the delete, else its last exec error. */
const problemOf = (r: ProbeRow) => r.create_error ?? r.gone_reason ?? r.delete_error ?? r.last_error;

/** The Sandbox probes tab: the providers compared, then every probe. The window (24 h / 7 d) is on the search row. */
export function ComputeProbes() {
  const url = useComputeParams();
  const hours = url.get('phours') === '168' ? 168 : 24;
  const open = url.get('probe');
  const { data, error, isLoading, refetch } = useAdmin<Probes>(`/compute/probes?hours=${hours}`, { refetchInterval: open ? undefined : 30_000, keep: true });
  const rows = useMemo(() => data?.rows ?? [], [data]);

  const cols: RecordCol<ProbeRow>[] = [
    { key: 'probe', label: 'Probe', title: true, keep: true, type: 'text', value: (r) => r.name ?? `probe ${r.id}`, render: (r) => (
      <span className='flex min-w-0 flex-col gap-1'>
        <span className='truncate font-medium'>{LABEL[r.provider]}</span>
        <Mono>{r.sandbox_id ?? r.name ?? `probe ${r.id}`}</Mono>
      </span>
    ) },
    { key: 'provider', label: 'Provider', hidden: true, type: 'select', value: (r) => LABEL[r.provider], render: (r) => LABEL[r.provider] },
    { key: 'state', label: 'Outcome', keep: true, className: 'max-w-80', type: 'select', value: (r) => stateOf(r).label, render: (r) => {
      const problem = problemOf(r);
      return (
        <span className='flex min-w-0 flex-col gap-1'>
          <span><StatusBadge tone={stateOf(r).tone}>{stateOf(r).label}</StatusBadge></span>
          {r.state === 'gone' && r.gone_age_s != null && <span className='text-destructive text-xs'>after {dur(r.gone_age_s)}</span>}
          {problem && r.state !== 'deleted' && <span className='text-muted-foreground line-clamp-1 font-mono text-xs' title={problem}>{problem}</span>}
        </span>
      );
    } },
    { key: 'started', label: 'Started', type: 'date', value: (r) => r.started_at, render: (r) => (
      <span className='text-muted-foreground text-xs' title={new Date(r.started_at).toLocaleString()}>{dur(since(r.started_at))} ago</span>
    ) },
    { key: 'ready', label: 'Ready in', className: 'text-right', type: 'number', value: (r) => r.ready_ms, render: (r) => <span className='tabular-nums'>{ms(r.ready_ms)}</span> },
    { key: 'execs', label: 'Execs ok', className: 'text-right', type: 'number', value: (r) => r.execs_ok, render: (r) => (
      <span className='flex flex-col items-end gap-1'>
        <span className='tabular-nums'>{r.execs_ok} <span className={cn(r.execs_failed ? 'text-destructive' : 'text-muted-foreground')}>/ {r.execs_ok + r.execs_failed}</span></span>
        {r.exec_p50_ms != null && <span className='text-muted-foreground text-xs tabular-nums'>p50 {ms(r.exec_p50_ms)} · p95 {ms(r.exec_p95_ms)}</span>}
      </span>
    ) },
    { key: 'delete', label: 'Delete', className: 'text-right', type: 'number', value: (r) => r.delete_ms, render: (r) => (
      r.delete_ms == null ? <span className='text-muted-foreground'>—</span>
        : <span className={cn('tabular-nums', r.delete_error && 'text-destructive')} title={r.delete_error ?? undefined}>{r.delete_error ? 'failed' : ms(r.delete_ms)}</span>
    ) },
    { key: 'region', label: 'Region', hidden: true, type: 'select', value: (r) => r.region ?? '', render: (r) => r.region ?? '—' },
    { key: 'error', label: 'Last error', hidden: true, className: 'max-w-96', type: 'text', value: (r) => problemOf(r) ?? '',
      render: (r) => <span className='text-muted-foreground line-clamp-2 font-mono text-xs'>{problemOf(r) ?? ''}</span> }
  ];

  const filters = (
    <NativeSelect aria-label='Window' value={String(hours)} onChange={(e) => url.write({ phours: e.target.value === '24' ? null : '168' })}>
      <NativeSelectOption value='24'>Last 24 hours</NativeSelectOption>
      <NativeSelectOption value='168'>Last 7 days</NativeSelectOption>
    </NativeSelect>
  );
  const empty = data && !data.enabled ? 'The probe is off (OCTILLION_SANDBOX_PROBE=off).' : `No probes in the last ${hours === 24 ? '24 hours' : '7 days'}. The probe cron starts one per provider every ${data?.every_minutes ?? 15} minutes.`;

  return (
    <div id='compute-probes-anchor' className='flex min-w-0 flex-col gap-3'>
      {error && !data && (
        <div role='alert' className='border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-3 rounded-lg border px-4 py-3 text-sm'>
          <span className='min-w-0 flex-1'>Could not load sandbox probes: {error.message}</span>
          <Button variant='outline' size='xs' onClick={() => void refetch()}>Retry</Button>
        </div>
      )}
      <RecordView id='compute-probes' rows={rows} loading={isLoading && !data} rowKey={(r) => String(r.id)} cols={cols} noun='probes' initialSize={50}
        searchText={(r) => `${LABEL[r.provider]} ${r.sandbox_id ?? ''} ${r.name ?? ''} ${stateOf(r).label} ${problemOf(r) ?? ''}`}
        searchPlaceholder='Search probes, sandboxes, errors' filters={filters} summary={data && <Comparison d={data} />} exportName='sandbox-probes' compact
        openKey={open} onOpenChange={(k) => url.write({ probe: k })}
        actions={(r) => [
          ...(r.sandbox_id ? [{ label: 'Copy sandbox id', icon: <Icons.page />, onSelect: () => copyText(r.sandbox_id!, 'Sandbox id copied') }] : []),
          ...(problemOf(r) ? [{ label: 'Copy error', icon: <Icons.page />, onSelect: () => copyText(problemOf(r)!, 'Error copied') }] : [])
        ]}
        detailTitle={() => 'Sandbox probe'}
        detail={(r) => <ProbePeek id={r.id} />}
        empty={empty} />
    </div>
  );
}

/** The two providers, metric by metric, with the daily cost under them. */
function Comparison({ d }: { d: Probes }) {
  const by = (p: Provider) => d.providers.find((x) => x.provider === p)!;
  const b = by('boat'), v = by('vercel');
  const line = (label: ReactNode, f: (s: ProviderSummary) => ReactNode, hint?: string) => ({ label, f, hint });
  const lines = [
    line('Probes started', (s) => s.started),
    line('Create success', (s) => <>{pct(s.create_ok_pct)} <span className='text-muted-foreground text-xs'>{s.created} of {s.started}</span></>),
    line('Ready time, p50 / p95', (s) => <>{ms(s.ready_p50_ms)} <span className='text-muted-foreground'>/ {ms(s.ready_p95_ms)}</span></>, 'from the create call until it can run commands'),
    line(`Survived ${d.lifetime_minutes} min`, (s) => <>{pct(s.survived_pct)} <span className='text-muted-foreground text-xs'>{s.survived} of {s.finished}</span></>, 'of the probes that ended: deleted by us, not gone first'),
    line('Gone early', (s) => <span className={cn(s.gone_early > 0 && 'text-destructive')}>{s.gone_early}{s.gone_median_age_s != null && <span className='text-muted-foreground text-xs'> · median age {dur(s.gone_median_age_s)}</span>}</span>,
      'the provider lost or stopped it before we deleted it'),
    line('Exec success', (s) => <>{pct(s.exec_ok_pct)} <span className='text-muted-foreground text-xs'>{s.execs} execs</span></>, 'echo ok && uptime, about every 30 s'),
    line('Exec latency, p50 / p95', (s) => <>{ms(s.exec_p50_ms)} <span className='text-muted-foreground'>/ {ms(s.exec_p95_ms)}</span></>),
    line('Get API success', (s) => <>{pct(s.check_ok_pct)} <span className='text-muted-foreground text-xs'>{s.checks} checks</span></>, 'does it still exist?'),
    line('Delete success', (s) => <>{pct(s.delete_ok_pct)} <span className='text-muted-foreground text-xs'>{s.deletes} deletes</span></>)
  ];
  const cell = (s: ProviderSummary, f: (s: ProviderSummary) => ReactNode) =>
    s.configured || s.started ? f(s) : <span className='text-muted-foreground'>—</span>;
  const c = d.cost;
  return (
    <div className='flex flex-col gap-3 pb-3'>
      {!d.enabled && <Notice tone='info'>The probe is off (OCTILLION_SANDBOX_PROBE=off): no new probes start. Past probes are shown.</Notice>}
      {[b, v].filter((s) => !s.configured).map((s) => (
        <Notice key={s.provider}>{LABEL[s.provider]} is not configured, so it is not probed: {s.not_configured_reason ?? 'no credentials'}. See docs/sandbox-probe.md.</Notice>
      ))}
      <div className='overflow-x-auto rounded-lg border'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className='w-64'>Last {d.hours === 24 ? '24 hours' : '7 days'}</TableHead>
              <TableHead className='text-right'>{LABEL.boat}</TableHead>
              <TableHead className='text-right'>{LABEL.vercel} <span className='text-muted-foreground font-normal'>· iad1</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l, i) => (
              <TableRow key={i}>
                <TableCell><span className='flex flex-col gap-0.5'><span>{l.label}</span>{l.hint && <span className='text-muted-foreground text-xs'>{l.hint}</span>}</span></TableCell>
                <TableCell className='text-right tabular-nums'>{cell(b, l.f)}</TableCell>
                <TableCell className='text-right tabular-nums'>{cell(v, l.f)}</TableCell>
              </TableRow>
            ))}
            <TableRow>
              <TableCell><span className='flex flex-col gap-0.5'><span>Estimated cost a day</span><span className='text-muted-foreground text-xs'>{c.probes_per_day} probes a provider a day, ~{c.minutes_each} min each, smallest size</span></span></TableCell>
              <TableCell className='text-right tabular-nums'>{money(c.boat_usd_day)} <span className={cn('text-xs', AMBER)} title='boat counts every create as a start against the account limit'>· {c.boat_starts_per_day} starts</span></TableCell>
              <TableCell className='text-right tabular-nums'>{money(c.vercel_usd_day)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <p className='text-muted-foreground text-xs'>{c.note} Total about {money(c.total_usd_day)} a day.</p>
    </div>
  );
}

/** One probe: its facts, then its execs and checks, and every error it met. */
function ProbePeek({ id }: { id: number }) {
  const { data, error, isLoading } = useAdmin<Detail>(`/compute/probes/${id}`);
  if (isLoading) return <div className='grid gap-3'><Skeleton className='h-24' /><Skeleton className='h-40' /></div>;
  if (!data) return <ErrorBox error={error} />;
  const r = data.row;
  const none = <span className='text-muted-foreground'>—</span>;
  return (
    <div className='flex flex-col gap-4'>
      <DetailMeta
        title={LABEL[r.provider]}
        badges={<StatusBadge tone={stateOf(r).tone}>{stateOf(r).label}</StatusBadge>}
        actions={r.sandbox_id ? <Button variant='outline' size='sm' onClick={() => copyText(r.sandbox_id!, 'Sandbox id copied')}><Icons.page /> Copy sandbox id</Button> : undefined}
        facts={[
          { label: 'Sandbox', value: r.sandbox_id ? <Mono>{r.sandbox_id}</Mono> : <span className='text-muted-foreground'>never created</span> },
          { label: 'Name', value: r.name ? <Mono>{r.name}</Mono> : none, hidden: !r.name || r.name === r.sandbox_id },
          { label: 'Region', value: r.region ?? none },
          { label: 'Started', value: <When d={r.started_at} /> },
          { label: 'Create call', value: ms(r.create_ms) },
          { label: 'Ready in', value: ms(r.ready_ms), hint: 'from the create call' },
          { label: 'Gone', value: r.gone_at ? <span className='text-destructive'><When d={r.gone_at} /> · after {dur(r.gone_age_s)}</span> : none, hidden: !r.gone_at },
          { label: 'Deleted', value: r.deleted_at ? <><When d={r.deleted_at} /> · {ms(r.delete_ms)}</> : r.delete_error ? <span className='text-destructive'>failed</span> : none },
          { label: 'Execs', value: <span className='tabular-nums'>{r.execs_ok} ok · {r.execs_failed} failed</span>, hint: r.exec_p50_ms != null ? `p50 ${ms(r.exec_p50_ms)} · p95 ${ms(r.exec_p95_ms)}` : undefined },
          { label: 'Problem', value: <span className='font-mono text-xs'>{problemOf(r)}</span>, wide: true, hidden: !problemOf(r) || r.state === 'deleted' }
        ]}
      />
      <DetailTabs resetKey={id} tabs={[
        { id: 'execs', label: 'Execs', count: data.execs.length, content: (
          <DetailTable rows={data.execs} rowKey={(e) => String(e.id)} noun='calls' empty='No execs or checks yet.'
            search={(e) => `${e.kind} ${e.error ?? ''}`} cols={[
            { key: 'at', label: 'When', type: 'date', value: (e) => e.at, render: (e) => <When d={e.at} /> },
            { key: 'kind', label: 'Call', type: 'select', value: (e) => (e.kind === 'exec' ? 'echo + uptime' : 'get (exists?)'), render: (e) => (e.kind === 'exec' ? 'echo + uptime' : 'get (exists?)') },
            { key: 'ok', label: 'Result', type: 'select', value: (e) => (e.ok ? 'ok' : 'failed'), render: (e) => <StatusBadge tone={e.ok ? 'ok' : 'bad'}>{e.ok ? 'ok' : 'failed'}</StatusBadge> },
            { key: 'ms', label: 'Latency', className: 'text-right tabular-nums', type: 'number', value: (e) => e.ms, render: (e) => ms(e.ms) },
            { key: 'exit', label: 'Exit code', className: 'text-right tabular-nums', type: 'number', value: (e) => e.exit_code, render: (e) => (e.exit_code == null ? '—' : e.exit_code) },
            { key: 'error', label: 'Error', className: 'max-w-80', type: 'text', value: (e) => e.error ?? '', render: (e) => <span className='text-muted-foreground line-clamp-2 font-mono text-xs' title={e.error ?? undefined}>{e.error ?? ''}</span> }
          ]} />
        ) },
        { id: 'errors', label: 'Errors', count: data.errors.length, content: (
          <DetailTable rows={data.errors} rowKey={(e) => `${e.at}:${e.step}:${e.error}`} noun='errors' empty='No errors.' search={(e) => `${e.step} ${e.error}`} cols={[
            { key: 'at', label: 'When', type: 'date', value: (e) => e.at, render: (e) => <When d={e.at} /> },
            { key: 'step', label: 'Step', type: 'select', value: (e) => e.step, render: (e) => e.step },
            { key: 'error', label: 'Error', className: 'max-w-[32rem]', type: 'text', value: (e) => e.error, render: (e) => <span className='line-clamp-3 font-mono text-xs' title={e.error}>{e.error}</span> }
          ]} />
        ) }
      ]} />
    </div>
  );
}
