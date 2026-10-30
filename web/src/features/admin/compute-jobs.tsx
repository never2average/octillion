'use client';
// Compute › Jobs (GET /compute/jobs, src/compute-jobs.ts): every simulation and research job that is active or
// finished recently, waiting first, with why each one waits (from the autoscaler's last tick), its work, its
// orchestrator, pods and spend, and a peek with its sessions by agent (and whether each agent can run), its
// orchestrators and a spend breakdown. State, kind, range and "has failures" are asked of the server and kept in the
// URL (?section=jobs&jstate=waiting&job=sim_…), so the verdict, tiles and Health deep-link here. Read only.
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DetailMeta, DetailTable, DetailTabs, KeyValueTable, LongText } from '@/components/layout/detail';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { Button, buttonVariants } from '@/components/ui/button';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Icons } from '@/components/icons';
import { counted } from '@/lib/octillion-format';
import { cn } from '@/lib/utils';
import { useAdmin } from './lib';
import { copyText, ErrorBox, Mono, Notice, StatusBadge, When, type Tone } from './ui';
import { Chip, cents, dur, jobSessions, since, useComputeParams, useNow, nextPinned, useScrollTo } from './compute-common';
import { JobsStats } from './compute-stats';

type Kind = 'simulation' | 'research' | 'prospect';
type JobState = 'waiting' | 'queued' | 'booting' | 'running' | 'draining' | 'failed' | 'finished';
interface Sessions { queued: number; running: number; completed: number; failed: number; timeout: number; cancelled: number }
export interface JobRow {
  id: string; kind: Kind; name: string | null; status: string; org: { slug: string; name: string } | null; company: string | null;
  product: { id: number; name: string } | null; state: JobState; why_waiting: string | null; note: string | null;
  sessions: Sessions | null; research: { stage: string | null; attempts: number } | null;
  orchestrator: { id: number; orchestrator_id: string | null; state: string } | null; orchestrators_total: number; failed_launches: number;
  pods: { running: number; reserved: number }; created_at: string; finished_at: string | null; waiting_since: string | null; running_since: string | null;
  failures: { count: number; top_key: string | null; top_label: string | null };
  spend: { session_model_usd: number; orchestrator_model_usd: number; sandbox_est_usd: number; total_usd: number };
}
interface JobDetail {
  job: JobRow;
  why: { text: string; note: string | null; free: number | null; needed: number | null; cap: number | null } | null;
  agents: { agent_id: string | null; harness: string; queued: number; running: number; completed: number; failed: number; usd: number; runnable: { ok: boolean; reason: string } | null }[];
  orchestrators: { id: number; orchestrator_id: string | null; sandbox_id: string | null; state: string; created_at: string; boot_ms: number | null; lifetime_s: number;
    end_reason: { key: string; label: string; routine: boolean; message: string } | null }[];
  research: { status: string; stage: string | null; note: string | null; attempts: number; searches: number; heartbeat_at: string | null; error: string | null } | null;
}

const STATES: { id: string; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'active', label: 'Active' }, { id: 'waiting', label: 'Waiting' }, { id: 'booting', label: 'Booting' },
  { id: 'running', label: 'Running' }, { id: 'draining', label: 'Draining' }, { id: 'finished', label: 'Finished' }, { id: 'failed', label: 'Failed' }
];
const STATE_TONE: Record<JobState, Tone> = { waiting: 'warn', queued: 'info', booting: 'info', running: 'ok', draining: 'warn', failed: 'bad', finished: 'neutral' };
const KIND_LABEL: Record<Kind, string> = { simulation: 'Simulation', research: 'Research', prospect: 'Prospect research' };
const ORCH_TONE: Record<string, Tone> = { booting: 'info', running: 'ok', draining: 'warn', deleted: 'neutral' };
const RESEARCH_SPEND = 'Research spend is metered only through its orchestrator.';
/** Rows asked for at once; the table pages them 25 at a time. */
const LIMIT = 500;

const accountOf = (j: JobRow) => j.org?.name ?? j.company ?? '—';
const jobHref = (j: JobRow) => (j.org ? `/admin/accounts/${encodeURIComponent(j.org.slug)}` : j.kind === 'prospect' ? '/admin/requests' : null);
const done = (s: Sessions) => s.completed + s.cancelled;
const failedOf = (s: Sessions) => s.failed + s.timeout;
const total = (s: Sessions) => s.queued + s.running + done(s) + failedOf(s);
/** Failed sessions plus failed orchestrator launches, as the server's "has failures" filter counts them. */
const failuresOf = (j: JobRow) => j.failures.count + j.failed_launches;
/** Waiting since (queued work), else running for (the orchestrator's ready time). */
const clockOf = (j: JobRow) => (j.state === 'finished' || j.state === 'failed' ? null : j.waiting_since && j.state !== 'running' ? since(j.waiting_since) : since(j.running_since));

/** The Jobs section: filters in the URL, a peek per job (?job=<id>). */
export function ComputeJobs() {
  const url = useComputeParams();
  const router = useRouter();
  useNow(15_000);
  const state = url.get('jstate') ?? 'all', kind = url.get('jkind'), range = url.get('jsince') ?? '1h', failures = url.get('jfail') === '1';
  const sort = url.get('jsort');
  const open = url.get('job');
  const qs = new URLSearchParams({ limit: String(LIMIT), since: range, state, ...(kind ? { kind } : {}), ...(failures ? { has_failures: '1' } : {}), ...(sort === 'spend' ? { sort } : {}) });
  const [pinned, setPinned] = useState<string | null>(null);
  if (pinned) qs.set('include', pinned);
  // Refresh every 30 s, paused while a record is open (and, as every query, while the tab is hidden).
  const { data, error, isLoading, refetch } = useAdmin<{ total: number; facets?: Record<'state' | 'kind' | 'has_failures', Record<string, number>>; rows: JobRow[] }>(`/compute/jobs?${qs}`, { refetchInterval: open ? undefined : 30_000, keep: true });
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const pin = nextPinned(open, data?.rows.map((r) => r.id), pinned);
  if (pin !== pinned) setPinned(pin);
  useScrollTo('jobs', !!data);

  const set = (patch: Record<string, string | null>) => url.write({ ...patch, job: null });
  // Jobs each choice matches under the other filters (the server's facets); "" is the dropdown's "every".
  const fc = (k: 'state' | 'kind' | 'has_failures', v: string) => (data?.facets ? data.facets[k][v] ?? 0 : undefined);
  const showSessions = (id: string) => url.write({ ...jobSessions(id), job: null });
  // Opens the orchestrator's peek in its table (the job peek closes; its "Back to job" link returns here).
  const showOrch = (orch: number, job: string) => url.write({ section: 'orchestrators', orch: String(orch), back: job, job: null });

  const cols: RecordCol<JobRow>[] = [
    { key: 'job', label: 'Job', title: true, keep: true, type: 'text', value: (j) => j.id, render: (j) => (
      <span className='flex min-w-0 flex-col gap-1'>
        <span className='flex items-center gap-1.5'><Mono>{j.id}</Mono><Chip>{KIND_LABEL[j.kind]}</Chip></span>
        <span className='text-muted-foreground truncate text-xs'>{accountOf(j)}{j.product && ` · ${j.product.name}`}</span>
      </span>
    ) },
    { key: 'state', label: 'State', keep: true, type: 'select', value: (j) => j.state, render: (j) => {
      const c = clockOf(j), waiting = !!j.waiting_since && j.state !== 'running';
      return (
        <span className='flex min-w-0 flex-col gap-1'>
          <span><StatusBadge tone={STATE_TONE[j.state]}>{j.state}</StatusBadge></span>
          {c != null ? <span className='text-muted-foreground text-xs tabular-nums' title={waiting ? 'Oldest queued work' : 'Since its orchestrator was ready'}>{waiting ? 'waiting ' : 'running '}{dur(c)}</span>
            : j.finished_at && <span className='text-muted-foreground text-xs'>ended {dur(since(j.finished_at))} ago</span>}
          {(j.state === 'waiting' || j.state === 'queued') && j.why_waiting && (
            <span className='text-muted-foreground line-clamp-2 max-w-72 text-xs' title={j.note ? `${j.why_waiting}\n${j.note}` : j.why_waiting}>{j.why_waiting}</span>
          )}
        </span>
      );
    } },
    { key: 'work', label: 'Work', type: 'number', value: (j) => (j.sessions ? total(j.sessions) : null), render: (j) => <Work j={j} /> },
    { key: 'orch', label: 'Orchestrator', type: 'text', value: (j) => j.orchestrator?.orchestrator_id ?? '', render: (j) => (
      j.orchestrator ? (
        <span className='flex flex-col gap-1'>
          <span className='flex items-center gap-1.5'><Mono>{j.orchestrator.orchestrator_id ?? `row ${j.orchestrator.id}`}</Mono>
            <StatusBadge tone={ORCH_TONE[j.orchestrator.state]}>{j.orchestrator.state === 'deleted' ? 'ended' : j.orchestrator.state}</StatusBadge></span>
          {j.orchestrators_total > 1 && <span className='text-muted-foreground text-xs'>{j.orchestrators_total} in all</span>}
        </span>
      ) : <span className='text-muted-foreground'>—</span>
    ) },
    // Folded into State's second line; kept hidden for its sort.
    { key: 'clock', label: 'Waiting since / running for', className: 'text-right', type: 'number', hidden: true, value: clockOf, render: (j) => {
      const c = clockOf(j);
      if (c == null) return j.finished_at ? <span className='text-muted-foreground text-xs'>ended {dur(since(j.finished_at))} ago</span> : <span className='text-muted-foreground'>—</span>;
      const waiting = !!j.waiting_since && j.state !== 'running';
      return <span className='tabular-nums' title={waiting ? 'Oldest queued work' : 'Since its orchestrator was ready'}>{waiting ? 'waiting ' : 'running '}{dur(c)}</span>;
    } },
    // Failed sessions plus failed orchestrator launches: the server's "has failures" filter counts both (okFail).
    { key: 'failures', label: 'Failures', type: 'number', value: failuresOf, render: (j) => (
      failuresOf(j) ? (
        <span className='flex flex-col gap-1'>
          {j.failures.count > 0 && <span className='flex flex-wrap items-center gap-1.5'><span className='text-destructive tabular-nums'>{j.failures.count}</span>
            {j.failures.top_label && <Chip tone='bad' title='Most common failure class'>{j.failures.top_label}</Chip>}</span>}
          {j.failed_launches > 0 && <span className='text-destructive text-xs tabular-nums'>{j.failed_launches} failed launch{j.failed_launches > 1 ? 'es' : ''}</span>}
        </span>
      ) : <span className='text-muted-foreground'>0</span>
    ) },
    // Metered model spend only (sessions and orchestrators through the gateway), not the sandbox price-table estimate.
    { key: 'spend', label: 'Model spend', className: 'text-right', type: 'number', value: (j) => j.spend.session_model_usd + j.spend.orchestrator_model_usd, render: (j) => (
      <span className='tabular-nums' title={j.kind === 'simulation' ? undefined : RESEARCH_SPEND}>{cents(j.spend.session_model_usd + j.spend.orchestrator_model_usd)}</span>
    ) }
  ];

  const filters = (
    <>
      <NativeSelect aria-label='State' value={state} onChange={(e) => set({ jstate: e.target.value === 'all' ? null : e.target.value })}>
        {STATES.map((c) => <NativeSelectOption key={c.id} value={c.id}>{counted(c.id === 'all' ? 'Every state' : c.label, fc('state', c.id))}</NativeSelectOption>)}
      </NativeSelect>
      <NativeSelect aria-label='Kind' value={kind ?? ''} onChange={(e) => set({ jkind: e.target.value || null })}>
        <NativeSelectOption value=''>{counted('Every kind', fc('kind', ''))}</NativeSelectOption>
        {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <NativeSelectOption key={k} value={k}>{counted(KIND_LABEL[k], fc('kind', k))}</NativeSelectOption>)}
      </NativeSelect>
      <NativeSelect aria-label='Finished within' value={range} onChange={(e) => set({ jsince: e.target.value === '1h' ? null : e.target.value })}>
        <NativeSelectOption value='1h'>Finished in the last hour</NativeSelectOption>
        <NativeSelectOption value='24h'>Finished in 24 h</NativeSelectOption>
        <NativeSelectOption value='7d'>Finished in 7 days</NativeSelectOption>
      </NativeSelect>
      <NativeSelect aria-label='Failures' value={failures ? '1' : ''} onChange={(e) => set({ jfail: e.target.value || null })}
        title='Jobs with failed sessions or failed orchestrator launches'>
        <NativeSelectOption value=''>{counted('With or without failures', fc('has_failures', ''))}</NativeSelectOption>
        <NativeSelectOption value='1'>{counted('Has failures', fc('has_failures', '1'))}</NativeSelectOption>
      </NativeSelect>
      <NativeSelect aria-label='Order' value={sort ?? ''} onChange={(e) => set({ jsort: e.target.value || null })}>
        <NativeSelectOption value=''>Most urgent first</NativeSelectOption>
        <NativeSelectOption value='spend'>Most spend first</NativeSelectOption>
      </NativeSelect>
    </>
  );

  return (
    <div id='compute-jobs-anchor' className='flex min-w-0 flex-col gap-3'>
      {error && !data && (
        <div role='alert' className='border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-3 rounded-lg border px-4 py-3 text-sm'>
          <span className='min-w-0 flex-1'>Could not load jobs: {error.message}</span>
          <Button variant='outline' size='xs' onClick={() => void refetch()}>Retry</Button>
        </div>
      )}
      <RecordView id='compute-jobs' summary={<JobsStats rows={rows} />} rows={rows} loading={isLoading && !data} rowKey={(j) => j.id} cols={cols} noun='jobs' initialSize={25}
        searchText={(j) => `${j.id} ${j.name ?? ''} ${j.org?.name ?? ''} ${j.org?.slug ?? ''} ${j.company ?? ''} ${j.product?.name ?? ''} ${j.state} ${KIND_LABEL[j.kind]} ${j.why_waiting ?? ''} ${j.orchestrator?.orchestrator_id ?? ''}`}
        searchPlaceholder='Search jobs, accounts, products' filters={filters} exportName='compute-jobs'
        openKey={open} onOpenChange={(k) => url.write({ job: k })}
        actions={(j) => [
          ...(jobHref(j) ? [{ label: j.org ? 'Open account' : 'Open access requests', icon: <Icons.externalLink />, onSelect: () => router.push(jobHref(j)!) }] : []),
          ...(j.kind === 'simulation' ? [{ label: 'Show sessions', icon: <Icons.search />, onSelect: () => showSessions(j.id) }] : []),
          ...(j.orchestrator ? [{ label: 'Show orchestrator', icon: <Icons.route />, onSelect: () => showOrch(j.orchestrator!.id, j.id) }] : []),
          { label: 'Copy id', icon: <Icons.page />, onSelect: () => copyText(j.id, 'Job id copied') }
        ]}
        detailTitle={() => 'Job'}
        detail={(j) => <JobPeek id={j.id} onSessions={() => showSessions(j.id)} onOrch={(o) => showOrch(o, j.id)} />}
        empty={state === 'all' && !kind && !failures ? `No jobs active or finished in the last ${range === '1h' ? 'hour' : range === '24h' ? '24 hours' : '7 days'}.` : 'No jobs match these filters.'} compact />
    </div>
  );
}

/** Simulation: sessions done / failed / running / queued as a small stacked bar. Research: its stage and attempt. */
function Work({ j }: { j: JobRow }) {
  if (j.research) return <span className='text-xs'>{j.research.stage ?? j.status}{j.research.attempts > 0 && <span className='text-muted-foreground'> · attempt {j.research.attempts + 1}</span>}</span>;
  const s = j.sessions!, all = total(s);
  if (!all) return <span className='text-muted-foreground'>no sessions</span>;
  const parts = [
    { n: done(s), c: 'bg-emerald-500', l: 'done' }, { n: failedOf(s), c: 'bg-destructive', l: 'failed' },
    { n: s.running, c: 'bg-sky-500', l: 'running' }, { n: s.queued, c: 'bg-muted-foreground/30', l: 'queued' }
  ];
  const label = parts.filter((p) => p.n).map((p) => `${p.n} ${p.l}`).join(' · ');
  return (
    <span className='flex min-w-28 flex-col gap-1' title={label}>
      <span className='bg-muted flex h-1.5 w-full overflow-hidden rounded-full'>
        {parts.map((p) => (p.n ? <span key={p.l} className={p.c} style={{ width: `${(p.n / all) * 100}%` }} /> : null))}
      </span>
      <span className='text-muted-foreground text-xs tabular-nums'>{done(s)}/{all} done{failedOf(s) ? ` · ${failedOf(s)} failed` : ''}{s.queued ? ` · ${s.queued} queued` : ''}</span>
    </span>
  );
}

/** One sentence on where the job is: "Running 38 of 40 pods on orch-212. 12 sessions queued; the oldest has waited 3 min." */
function statusSentence(j: JobRow, why: JobDetail['why']): string {
  const orch = j.orchestrator?.orchestrator_id ?? (j.orchestrator ? `row ${j.orchestrator.id}` : null);
  const queued = j.sessions?.queued ?? 0;
  const wait = queued && j.waiting_since ? ` ${queued} session${queued > 1 ? 's' : ''} queued; the oldest has waited ${dur(since(j.waiting_since))}.` : '';
  switch (j.state) {
    case 'finished': return `Finished ${dur(since(j.finished_at ?? j.created_at))} ago.`;
    case 'failed': return `Failed ${j.finished_at ? `${dur(since(j.finished_at))} ago` : ''}.`.replace(' .', '.');
    case 'waiting': case 'queued': return `${j.state === 'waiting' ? 'Waiting' : 'Queued'}${why ? `: ${why.text}` : ''}.${wait}`;
    case 'booting': return `Its orchestrator ${orch ?? ''} is booting.${wait}`.replace('  ', ' ');
    case 'draining': return `Its orchestrator ${orch ?? ''} is draining: it finishes what it runs and takes nothing new.${wait}`.replace('  ', ' ');
    default: return j.sessions
      ? `Running ${j.pods.running} of ${j.pods.reserved} pods${orch ? ` on ${orch}` : ''}.${wait}`
      : `Research is running${j.research?.stage ? ` (${j.research.stage})` : ''}${orch ? ` on ${orch}` : ''}.`;
  }
}

/** One job's peek: a card with where it is and its key facts, then tabs for why it waits, sessions by agent, its
 *  orchestrators, research details and spend. */
function JobPeek({ id, onSessions, onOrch }: { id: string; onSessions: () => void; onOrch: (orch: number) => void }) {
  const { data, error, isLoading } = useAdmin<JobDetail>(`/compute/jobs/${encodeURIComponent(id)}`);
  if (isLoading) return <div className='grid gap-3'><Skeleton className='h-16' /><Skeleton className='h-40' /></div>;
  if (!data) return <ErrorBox error={error} />;
  const j = data.job, w = data.why, r = data.research;
  const href = jobHref(j);
  return (
    <div className='flex flex-col gap-4'>
      <DetailMeta
        title={<Mono>{j.id}</Mono>}
        badges={<><StatusBadge tone={STATE_TONE[j.state]}>{j.state}</StatusBadge><Chip>{KIND_LABEL[j.kind]}</Chip></>}
        subtitle={statusSentence(j, w)}
        actions={<>
          {href && <Link href={href} className={buttonVariants({ variant: 'outline', size: 'sm' })}><Icons.account /> {j.org ? j.org.name : 'Access requests'}</Link>}
          {j.kind === 'simulation' && <Button variant='outline' size='sm' onClick={onSessions}><Icons.search /> Sessions</Button>}
          <Button variant='ghost' size='sm' onClick={() => copyText(j.id, 'Job id copied')}>Copy id</Button>
        </>}
        facts={[
          { label: 'Name', value: j.name, hidden: !j.name },
          { label: 'Account', value: accountOf(j) },
          { label: 'Product', value: j.product?.name, hidden: !j.product },
          { label: 'Created', value: <When d={j.created_at} /> },
          { label: 'Pods', value: <span className='tabular-nums'>{j.pods.running} of {j.pods.reserved}</span>, hint: 'running of reserved', hidden: !j.sessions },
          { label: 'Failures', value: <span className={cn('tabular-nums', failuresOf(j) > 0 && 'text-destructive')}>{failuresOf(j)}</span>,
            hint: j.failures.top_label ?? (j.failed_launches ? `${j.failed_launches} failed launch${j.failed_launches > 1 ? 'es' : ''}` : undefined) },
          { label: 'Model spend', value: <span className='tabular-nums'>{cents(j.spend.session_model_usd + j.spend.orchestrator_model_usd)}</span> }
        ]}
      >
        {j.kind !== 'simulation' && <Notice tone='info'>{RESEARCH_SPEND}</Notice>}
      </DetailMeta>

      <DetailTabs resetKey={id} tabs={[
        { id: 'why', label: 'Why it waits', hidden: !w, content: w && (
          <KeyValueTable rows={[
            { label: 'Reason', value: `${w.text}.` },
            { label: 'Free on boat', value: <span className='tabular-nums'>{w.free ?? '—'}</span> },
            { label: 'Needs (1 + pods)', value: <span className='tabular-nums'>{w.needed ?? '—'}</span> },
            { label: 'Orchestrator limit', value: <span className='tabular-nums'>{w.cap ?? '—'}</span> },
            { label: 'Autoscaler note', value: <Mono>{w.note}</Mono>, hidden: !w.note }
          ]} />
        ) },
        { id: 'agents', label: 'Sessions by agent', count: data.agents.length, hidden: !data.agents.length, content: (
          <DetailTable rows={data.agents} rowKey={(a) => a.agent_id ?? a.harness} noun='agents' empty='No sessions.'
            primary={<Button variant='outline' onClick={onSessions}><Icons.search /> Show sessions</Button>} cols={[
            { key: 'agent', label: 'Agent', type: 'text', value: (a) => a.agent_id ?? a.harness, render: (a) => (
              <span className='flex flex-col gap-0.5'>
                <span>{a.agent_id ?? a.harness}</span>
                {a.runnable && !a.runnable.ok && <Link href={/not in the harness mix/i.test(a.runnable.reason) ? '/admin/agents' : '/admin/keys'} className='text-destructive text-xs hover:underline'>{a.runnable.reason}</Link>}
              </span>
            ) },
            { key: 'queued', label: 'Queued', type: 'number', value: (a) => a.queued, render: (a) => a.queued, className: 'text-right tabular-nums' },
            { key: 'running', label: 'Running', type: 'number', value: (a) => a.running, render: (a) => a.running, className: 'text-right tabular-nums' },
            { key: 'done', label: 'Done', type: 'number', value: (a) => a.completed, render: (a) => a.completed, className: 'text-right tabular-nums' },
            { key: 'failed', label: 'Failed', type: 'number', value: (a) => a.failed, render: (a) => (a.failed ? <span className='text-destructive'>{a.failed}</span> : 0), className: 'text-right tabular-nums' },
            { key: 'usd', label: '$', type: 'number', value: (a) => a.usd, render: (a) => cents(a.usd), className: 'text-right tabular-nums' }
          ]} />
        ) },
        { id: 'orchestrators', label: 'Orchestrators', count: data.orchestrators.length, content: (
          <DetailTable rows={data.orchestrators} rowKey={(o) => String(o.id)} noun='orchestrators' empty='No orchestrator has been launched for it.' onRow={(o) => onOrch(o.id)} cols={[
            { key: 'orch', label: 'Orchestrator', type: 'text', value: (o) => o.orchestrator_id ?? `row ${o.id}`, render: (o) => <Mono>{o.orchestrator_id ?? `row ${o.id}`}</Mono> },
            { key: 'state', label: 'State', type: 'select', value: (o) => (o.state === 'deleted' ? 'ended' : o.state), render: (o) => <StatusBadge tone={ORCH_TONE[o.state]}>{o.state === 'deleted' ? 'ended' : o.state}</StatusBadge> },
            { key: 'created', label: 'Created', type: 'date', value: (o) => o.created_at, render: (o) => <When d={o.created_at} /> },
            { key: 'boot', label: 'Boot', type: 'number', value: (o) => o.boot_ms, render: (o) => (o.boot_ms == null ? '—' : dur(o.boot_ms / 1000)), className: 'text-right tabular-nums' },
            { key: 'lived', label: 'Lived', type: 'number', value: (o) => o.lifetime_s, render: (o) => dur(o.lifetime_s), className: 'text-right tabular-nums' },
            { key: 'end', label: 'Ended because', type: 'text', value: (o) => o.end_reason?.label ?? '', className: 'whitespace-normal leading-snug', render: (o) => (o.end_reason
              ? <span className={cn('line-clamp-2 text-xs', o.end_reason.key.startsWith('launch:') ? 'text-destructive' : 'text-muted-foreground')} title={o.end_reason.message}>{o.end_reason.label}: {o.end_reason.message}</span>
              : <span className='text-muted-foreground'>—</span>) }
          ]} />
        ) },
        { id: 'research', label: 'Research', hidden: !r, content: r && (
          <KeyValueTable rows={[
            { label: 'Stage', value: r.stage ?? r.status },
            { label: 'Attempts rejected', value: <span className='tabular-nums'>{r.attempts}</span> },
            { label: 'Searches', value: <span className='tabular-nums'>{r.searches}</span> },
            { label: 'Last heartbeat', value: <When d={r.heartbeat_at} /> },
            { label: 'Note', value: r.note, hidden: !r.note },
            { label: 'Error', value: <LongText mono>{r.error}</LongText>, hidden: !r.error }
          ]} />
        ) },
        { id: 'spend', label: 'Spend', content: (
          <KeyValueTable head={['Spend', 'Amount']} rows={[
            { label: 'Session models (finished sessions)', value: <span className='tabular-nums'>{cents(j.spend.session_model_usd)}</span> },
            { label: 'Orchestrator model (through the gateway)', value: <span className='tabular-nums'>{cents(j.spend.orchestrator_model_usd)}</span> },
            { label: 'Total', value: <span className='font-medium tabular-nums'>{cents(j.spend.session_model_usd + j.spend.orchestrator_model_usd)}</span> }
          ]} />
        ) }
      ]} />
    </div>
  );
}
