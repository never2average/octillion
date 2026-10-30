'use client';
// Compute › Activity and Autoscaler decisions, both from the autoscaler's history (src/autoscaler-ticks.ts): the
// leader records every tick that acted and a sample once a minute. Activity (GET /compute/activity) charts queued and
// running sessions and live orchestrators over 1 h / 2 h / 24 h, with launch and reap markers; a stretch with no
// autoscaler tick is a hatched band, never drawn through. Decisions (GET /compute/ticks) lists the acting ticks, newest
// first: what the tick saw, wanted and did, its note and error, with a peek and the raw row. Read only.
import { useMemo, type ReactNode } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceDot, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { DetailMeta, DetailTable, DetailTabs, KeyValueTable, LongText } from '@/components/layout/detail';
import { RecordView, useStored, type RecordCol } from '@/components/layout/record-view';
import { Button } from '@/components/ui/button';
import { MultiSelectFilter } from '@/components/layout/multi-select-filter';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Icons } from '@/components/icons';
import { counted } from '@/lib/octillion-format';
import { cn } from '@/lib/utils';
import { useAdmin } from './lib';
import { copyText, Mono, Section, When } from './ui';
import { Chip, useComputeParams, useScrollTo } from './compute-common';

// ---------------------------------------------------------------- Activity

interface Sample { t: string; queued: number | null; running: number | null; research: number | null; orchestrators: number | null; gap: boolean }
interface Marker { at: string; kind: 'launch' | 'reap'; row_id: number | null; orchestrator_id: string | null; sandbox_id: string | null; reason: string }
interface Activity { minutes: number; bucket_s: number; from: string; to: string; first_at: string | null; last_at: string | null; samples: Sample[]; events: Marker[] }

const WINDOWS = [{ m: 60, label: '1 h' }, { m: 120, label: '2 h' }, { m: 1440, label: '24 h' }];
const workConfig = { queued: { label: 'Queued sessions', color: 'var(--chart-1)' }, running: { label: 'Running sessions', color: 'var(--chart-2)' } } satisfies ChartConfig;
const orchConfig = { orchestrators: { label: 'Live orchestrators', color: 'var(--chart-4)' } } satisfies ChartConfig;
/** At most this many launch / reap markers are drawn (the newest); the decisions log has every one. */
const MAX_MARKERS = 300;

const clock = (ms: number, withDate = false) => new Date(ms).toLocaleString([], withDate ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' });

/**
 * The Activity section. Two small charts on one time axis rather than one chart with two scales: sessions (tens or
 * hundreds) above, orchestrators (a handful) below with the launch ▲ and reap ▼ markers. The window is kept per
 * browser. Refreshes every 60 s.
 */
export function ComputeActivity() {
  const [minutes, setMinutes] = useStored<number>('compute:activity-minutes', 120);
  const m = WINDOWS.some((w) => w.m === minutes) ? minutes : 120;
  const { data, error, isLoading, refetch } = useAdmin<Activity>(`/compute/activity?minutes=${m}`, { refetchInterval: 60_000, keep: true });
  const label = WINDOWS.find((w) => w.m === m)!.label;

  const view = useMemo(() => {
    if (!data) return null;
    const first = data.first_at ? Date.parse(data.first_at) : null;
    const step = data.bucket_s * 1000;
    const points = data.samples.map((s) => ({ ...s, ts: Date.parse(s.t) }));
    // Gap bands: runs of buckets with no tick, once recording had started (before that there is no history, not a gap).
    const bands: { x1: number; x2: number }[] = [];
    for (const p of points) {
      if (!p.gap || first == null || p.ts + step <= first) continue;
      const last = bands[bands.length - 1];
      if (last && last.x2 === p.ts) last.x2 = p.ts + step; else bands.push({ x1: p.ts, x2: p.ts + step });
    }
    const orchAt = (ms: number) => {
      let v = 0;
      for (const p of points) { if (p.ts > ms) break; if (!p.gap && p.orchestrators != null) v = p.orchestrators; }
      return v;
    };
    const markers = data.events.slice(-MAX_MARKERS).map((e) => ({ ...e, ts: Date.parse(e.at), y: orchAt(Date.parse(e.at)) }));
    const domain: [number, number] = [Date.parse(data.from), Date.parse(data.to)];
    const lastReal = points.findLast((p) => !p.gap);
    const trailingGap = !!points.length && points[points.length - 1]!.gap;
    const legend = !data.last_at ? null
      : trailingGap ? `No samples since ${clock(Date.parse(data.last_at), m === 1440)} (no autoscaler tick).`
      : lastReal ? `Data current through ${clock(lastReal.ts + step, m === 1440)}.` : null;
    const maxOrch = Math.max(1, ...points.map((p) => p.orchestrators ?? 0), ...markers.map((x) => x.y));
    return { points, bands, markers, domain, legend, maxOrch };
  }, [data, m]);

  const axis = { dataKey: 'ts', type: 'number' as const, scale: 'time' as const, domain: view?.domain, tickLine: false, axisLine: false, tickMargin: 8, minTickGap: 40,
    tickFormatter: (v: number) => clock(v, m === 1440 && view != null && view.domain[1] - view.domain[0] > 20 * 3600_000 && new Date(v).getHours() === 0) };
  const tooltip = <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(_, p) => clock(Number(p?.[0]?.payload?.ts), m === 1440)} indicator='dot' />} />;
  const bands = (id: string, labelled: boolean) => view!.bands.map((b) => (
    <ReferenceArea key={`${id}-${b.x1}`} x1={b.x1} x2={b.x2} fill={`url(#${id})`} fillOpacity={1} strokeOpacity={0} ifOverflow='hidden'
      label={labelled && b.x2 - b.x1 >= (view!.domain[1] - view!.domain[0]) / 8 ? { value: 'no autoscaler tick', position: 'insideTop', fontSize: 11, fill: 'var(--muted-foreground)' } : undefined} />
  ));

  return (
    <Section title={<span id='compute-activity'>Activity, last {label === '1 h' ? 'hour' : label === '2 h' ? '2 hours' : '24 hours'}</span>}
      description='Queued and running sessions, and live orchestrators, as the autoscaler saw them at each tick. ▲ an orchestrator launched, ▼ one reaped; hover a marker for why.'
      action={
        <div className='flex items-center gap-1.5' role='tablist' aria-label='Window'>
          {WINDOWS.map((w) => <Button key={w.m} role='tab' aria-selected={m === w.m} size='xs' variant={m === w.m ? 'default' : 'outline'} onClick={() => setMinutes(w.m)}>{w.label}</Button>)}
        </div>
      }>
      {error && !data && (
        <div role='alert' className='border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-3 rounded-lg border px-4 py-3 text-sm'>
          <span className='min-w-0 flex-1'>Could not load activity: {error.message}</span>
          <Button variant='outline' size='xs' onClick={() => void refetch()}>Retry</Button>
        </div>
      )}
      {isLoading && !data && <Skeleton className='h-72 rounded-lg' />}
      {data && !data.first_at && (
        <p className='text-muted-foreground rounded-lg border px-4 py-10 text-center text-sm'>No history yet. Recording starts with this release, from the next autoscaler tick.</p>
      )}
      {data && data.first_at && view && (
        <div className='grid gap-2 rounded-lg border p-4'>
          <ChartContainer config={workConfig} className='aspect-auto h-[200px] w-full'>
            <LineChart data={view.points} margin={{ left: 0, right: 8, top: 8 }} syncId='compute-activity'>
              <Hatch id='gap-work' />
              <CartesianGrid vertical={false} />
              <XAxis {...axis} hide />
              <YAxis width={36} tickLine={false} axisLine={false} allowDecimals={false} />
              {bands('gap-work', true)}
              {tooltip}
              <Line dataKey='queued' type='linear' stroke='var(--color-queued)' strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
              <Line dataKey='running' type='linear' stroke='var(--color-running)' strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
              <ChartLegend content={<ChartLegendContent />} verticalAlign='top' />
            </LineChart>
          </ChartContainer>
          <ChartContainer config={orchConfig} className='aspect-auto h-[140px] w-full'>
            <LineChart data={view.points} margin={{ left: 0, right: 8, top: 8 }} syncId='compute-activity'>
              <Hatch id='gap-orch' />
              <CartesianGrid vertical={false} />
              <XAxis {...axis} />
              <YAxis width={36} tickLine={false} axisLine={false} allowDecimals={false} domain={[0, view.maxOrch + 1]} />
              {bands('gap-orch', false)}
              {tooltip}
              <Line dataKey='orchestrators' type='stepAfter' stroke='var(--color-orchestrators)' strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
              {view.markers.map((e, i) => (
                <ReferenceDot key={`${e.kind}-${e.ts}-${i}`} x={e.ts} y={e.y} ifOverflow='extendDomain'
                  shape={(p: { cx?: number; cy?: number }) => <MarkerShape cx={p.cx ?? 0} cy={p.cy ?? 0} e={e} />} />
              ))}
              <ChartLegend content={<ChartLegendContent />} verticalAlign='top' />
            </LineChart>
          </ChartContainer>
          <p className='text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs'>
            <span>▲ launched · <span className='text-destructive'>▲</span> launch failed · ▼ reaped</span>
            <span className='flex items-center gap-1.5'><span aria-hidden className='inline-block h-3 w-4 rounded-sm border bg-[repeating-linear-gradient(45deg,var(--muted-foreground)_0_1px,transparent_1px_5px)] opacity-60' /> no autoscaler tick</span>
            {view.legend && <span>{view.legend}</span>}
            {data.events.length > MAX_MARKERS && <span>Showing the newest {MAX_MARKERS} of {data.events.length} launches and reaps.</span>}
          </p>
        </div>
      )}
    </Section>
  );
}

/** The diagonal fill of a "no autoscaler tick" band. */
function Hatch({ id }: { id: string }) {
  return (
    <defs>
      <pattern id={id} width='6' height='6' patternUnits='userSpaceOnUse' patternTransform='rotate(45)'>
        <line x1='0' y1='0' x2='0' y2='6' stroke='var(--muted-foreground)' strokeWidth='1' strokeOpacity='0.35' />
      </pattern>
    </defs>
  );
}

/** ▲ above the line for a launch (red when it failed), ▼ below it for a reap, with the reason on hover. */
function MarkerShape({ cx, cy, e }: { cx: number; cy: number; e: Marker }) {
  const up = e.kind === 'launch';
  const failed = up && e.reason.startsWith('launch failed');
  const y = up ? cy - 9 : cy + 9, s = 5;
  const d = up ? `M${cx} ${y - s}L${cx + s} ${y + s * 0.8}L${cx - s} ${y + s * 0.8}Z` : `M${cx} ${y + s}L${cx + s} ${y - s * 0.8}L${cx - s} ${y - s * 0.8}Z`;
  const who = e.orchestrator_id ?? (e.row_id ? `row ${e.row_id}` : e.sandbox_id ?? '');
  return (
    <g>
      <title>{`${new Date(e.at).toLocaleTimeString()} · ${up ? 'launched' : 'reaped'} ${who}: ${e.reason}`}</title>
      {/* A larger invisible target than the mark, so hovering finds it. */}
      <circle cx={cx} cy={y} r={9} fill='transparent' />
      <path d={d} fill={failed ? 'var(--destructive)' : up ? 'var(--foreground)' : 'var(--muted-foreground)'} stroke='var(--background)' strokeWidth={1.5} />
    </g>
  );
}

// ---------------------------------------------------------------- Autoscaler decisions

interface Launched { row: number | null; job_id: string | null; pods: number | null; label: string | null; orchestrator_id: string | null; sandbox_id: string | null; state: string | null; launch_step: string | null }
interface Reaped { sandbox_id: string; reason: string; row: number | null; orchestrator_id: string | null; job_id: string | null }
export interface Tick {
  id: number; at: string; holder: string | null; acted: boolean;
  queued: number | null; running: number | null; research: number | null; unclaimable: number | null; orchestrators: number | null;
  desired: number | null; cap: number | null; active: number | null; free: number | null;
  demand: Record<string, number> | null; jobs: { id: string; kind: string; sessions: number; served: boolean }[] | null;
  launched: Launched[]; reaped: Reaped[]; note: string | null; error: string | null; trace_id: string | null;
}

const HAS: { id: string; label: string; icon: ReactNode }[] = [
  { id: 'error', label: 'Has error', icon: <Icons.warning /> }, { id: 'launch', label: 'Launched', icon: <Icons.rocket /> }, { id: 'reap', label: 'Reaped', icon: <Icons.trash /> }
];
/** Rows asked for at once; the table pages them 25 at a time. */
const LIMIT = 500;

const saw = (t: Tick) => [
  t.queued != null && `queued ${t.queued}`, t.running && `running ${t.running}`, t.research && `research ${t.research}`, t.unclaimable && `can't run ${t.unclaimable}`
].filter(Boolean).join(' · ') || (t.queued == null ? '—' : 'nothing queued');
const wanted = (t: Tick) => (t.desired == null && t.cap == null && t.active == null ? '—'
  : `want ${t.desired ?? '—'} · cap ${t.cap ?? '—'} · have ${t.active ?? '—'}`);
/** The Note cell's text: the error first, then the note, so CSV and search keep both. */
const noted = (t: Tick) => [t.error, t.note].filter(Boolean).join(' · ');
const launchName = (l: Launched) => l.orchestrator_id ?? (l.row ? `row ${l.row}` : l.label ?? 'an orchestrator');
const reapName = (r: Reaped) => r.orchestrator_id ?? r.sandbox_id;
const did = (t: Tick) => [
  ...t.launched.map((l) => `launched ${launchName(l)}${l.job_id ? ` for ${l.job_id}` : ''}`),
  ...t.reaped.map((r) => `reaped ${reapName(r)} (${r.reason})`)
].join(' · ');

/** The decisions log: acting ticks, newest first; "Include minute samples" adds the rest. Filters live in the URL. */
export function ComputeDecisions({ runtime, stats }: { runtime: 'vm' | 'vercel' | null; stats?: (rows: Tick[]) => ReactNode }) {
  const url = useComputeParams();
  const has = (url.get('has') ?? '').split(',').filter((h) => HAS.some((x) => x.id === h));
  const samples = url.get('dsamples') === '1';
  const open = url.get('tick');
  const qs = new URLSearchParams({ limit: String(LIMIT), acted: samples ? '0' : '1', ...(has.length ? { has: has.join(',') } : {}) });
  const { data, error, isLoading, refetch } = useAdmin<{ total: number; facets?: { has: Record<string, number>; samples: Record<string, number> }; rows: Tick[] }>(`/compute/ticks?${qs}`, { refetchInterval: open ? undefined : 30_000, keep: true });
  const rows = useMemo(() => data?.rows ?? [], [data]);
  useScrollTo('decisions', !!data);
  const set = (patch: Record<string, string | null>) => url.write({ ...patch, tick: null });
  const showOrch = (row: number) => url.write({ section: 'orchestrators', orch: String(row), state: 'all', tick: null });

  const cols: RecordCol<Tick>[] = [
    { key: 'at', label: 'At', title: true, keep: true, type: 'date', value: (t) => t.at, render: (t) => (
      <span className='flex items-center gap-1.5 whitespace-nowrap'><When d={t.at} />{!t.acted && <Chip title='A minute sample: nothing changed on this tick'>sample</Chip>}</span>
    ) },
    { key: 'saw', label: 'Saw', type: 'text', value: saw, render: (t) => <span className='text-xs whitespace-nowrap'>{saw(t)}</span> },
    { key: 'wanted', label: 'Orchestrators', type: 'number', value: (t) => t.active ?? t.desired, render: (t) => (
      <span className='grid gap-0.5 text-xs whitespace-nowrap tabular-nums'>
        <span>{wanted(t)}</span>
        {t.free != null && <span className='text-muted-foreground text-xs'>{t.free} sandboxes free</span>}
      </span>
    ) },
    { key: 'did', label: 'Did', className: 'max-w-96', type: 'text', value: did, render: (t) => (
      t.launched.length || t.reaped.length ? <span className='line-clamp-2 text-xs' title={did(t)}>{did(t)}</span> : <span className='text-muted-foreground'>—</span>
    ) },
    { key: 'note', label: 'Note', className: 'max-w-80', type: 'text', value: noted, render: (t) => (t.error || t.note ? (
      <span className='grid gap-0.5'>
        {t.error && <span className='text-destructive line-clamp-2 text-xs' title={t.error}>{t.error}</span>}
        {t.note && <span className='text-muted-foreground line-clamp-2 text-xs' title={t.note}>{t.note}</span>}
      </span>
    ) : null) },
  ];

  const filters = (
    <>
      <MultiSelectFilter noun='decisions' options={HAS.map((h) => ({ value: h.id, label: h.label, count: data?.facets?.has[h.id] }))} value={has} onChange={(v) => set({ has: v.length ? v.join(',') : null })} />
      <NativeSelect aria-label='Minute samples' value={samples ? '1' : ''} onChange={(e) => set({ dsamples: e.target.value || null })} title='The once-a-minute rows where nothing changed'>
        <NativeSelectOption value=''>{counted('Ticks that acted', data?.facets?.samples[''])}</NativeSelectOption>
        <NativeSelectOption value='1'>{counted('Include minute samples', data?.facets?.samples['1'])}</NativeSelectOption>
      </NativeSelect>
    </>
  );
  const filtered = has.length > 0;
  const empty = filtered ? 'No decisions match these filters.'
    : `No decisions in this window. Only ticks that changed something are recorded.${runtime === 'vercel' ? ' On Vercel, ticks run only on events and on the cron every 5 minutes.' : ''}`;

  return (
    <div id='compute-decisions-anchor' className='flex min-w-0 flex-col gap-3'>
      {error && !data && (
        <div role='alert' className='border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-3 rounded-lg border px-4 py-3 text-sm'>
          <span className='min-w-0 flex-1'>Could not load decisions: {error.message}</span>
          <Button variant='outline' size='xs' onClick={() => void refetch()}>Retry</Button>
        </div>
      )}
      <RecordView id='compute-decisions' rows={rows} loading={isLoading && !data} rowKey={(t) => String(t.id)} cols={cols} noun='ticks' initialSize={25}
        searchText={(t) => `${saw(t)} ${did(t)} ${t.note ?? ''} ${t.error ?? ''} ${t.holder ?? ''} ${t.launched.map((l) => `${l.job_id ?? ''} ${l.sandbox_id ?? ''}`).join(' ')}`}
        searchPlaceholder='Search notes, errors, jobs, orchestrators' filters={filters} exportName='compute-decisions'
        openKey={open} onOpenChange={(k) => url.write({ tick: k })}
        actions={(t) => [
          { label: 'Copy row as JSON', icon: <Icons.page />, onSelect: () => copyText(JSON.stringify(t, null, 2), 'Tick copied') },
          ...(t.error ? [{ label: 'Copy error', icon: <Icons.warning />, onSelect: () => copyText(t.error!, 'Error copied') }] : [])
        ]}
        detailTitle={() => 'Tick'}
        detail={(t) => <TickPeek t={t} onOrch={showOrch} />}
        empty={empty} summary={stats?.(rows)} compact />
    </div>
  );
}

/** One tick: a card with what it saw and wanted, then tabs for its error and note, the jobs it served or left waiting,
 *  what it launched and reaped (each row opens the orchestrator) and the raw row. */
function TickPeek({ t, onOrch }: { t: Tick; onOrch: (row: number) => void }) {
  const waiting = t.jobs?.filter((j) => !j.served) ?? [];
  const served = t.jobs?.filter((j) => j.served) ?? [];
  const num = (v: number | null) => <span className='tabular-nums'>{v ?? '—'}</span>;
  const orchCell = (row: number | null, name: string) => (
    <span className={cn('font-mono text-xs', row && 'hover:underline')} title={row ? 'Show this orchestrator' : undefined}>{name}</span>
  );
  return (
    <div className='flex flex-col gap-4'>
      <DetailMeta
        title={<When d={t.at} />}
        badges={<>
          {!t.acted && <Chip title='A minute sample: nothing changed on this tick'>sample</Chip>}
          {t.error && <Chip tone='bad'>error</Chip>}
        </>}
        actions={<>
          <Button variant='outline' size='sm' onClick={() => copyText(JSON.stringify(t, null, 2), 'Tick copied')}><Icons.page /> Copy row as JSON</Button>
          {t.error && <Button variant='ghost' size='sm' onClick={() => copyText(t.error!, 'Error copied')}>Copy error</Button>}
        </>}
        facts={[
          { label: 'Queued', value: num(t.queued) },
          { label: 'Running', value: num(t.running) },
          { label: 'Research', value: num(t.research) },
          { label: "Can't run", value: num(t.unclaimable) },
          { label: 'Wanted', value: num(t.desired) },
          { label: 'Limit', value: num(t.cap) },
          { label: 'Active', value: num(t.active) },
          { label: 'Free on boat', value: num(t.free) },
          { label: 'Live orchestrators after the tick', value: <span className='tabular-nums'>{t.orchestrators ?? 0}</span> },
          { label: 'Leader', value: <Mono>{t.holder ?? '—'}</Mono> }
        ]}
      />

      <DetailTabs resetKey={t.id} tabs={[
        { id: 'note', label: t.error ? 'Error' : 'Note', hidden: !t.error && !t.note, content: (
          <KeyValueTable rows={[
            { label: 'Error', value: <span className='text-destructive'><LongText mono>{t.error}</LongText></span>, hidden: !t.error },
            { label: 'Note', value: <LongText mono>{t.note}</LongText>, hidden: !t.note }
          ]} />
        ) },
        { id: 'jobs', label: 'Jobs', count: t.jobs?.length, hidden: !t.jobs, content: (
          <DetailTable rows={[...waiting, ...served]} rowKey={(j) => j.id} noun='jobs' empty='No job wanted an orchestrator.'
            filters={<span className='text-muted-foreground text-xs'>{served.length} served, {waiting.length} waiting</span>} cols={[
            { key: 'id', label: 'Job', type: 'text', value: (j) => j.id, render: (j) => <Mono>{j.id}</Mono> },
            { key: 'kind', label: 'Kind', type: 'select', value: (j) => j.kind, render: (j) => <Chip>{j.kind}</Chip> },
            { key: 'sessions', label: 'Sessions', type: 'number', value: (j) => (j.kind === 'simulation' ? j.sessions : null), render: (j) => (j.kind === 'simulation' ? j.sessions : '—'), className: 'text-right tabular-nums' },
            { key: 'served', label: 'Served', type: 'select', value: (j) => (j.served ? 'served' : 'waiting'), render: (j) => <span className={cn(!j.served && 'text-amber-700 dark:text-amber-400')}>{j.served ? 'served' : 'waiting'}</span> }
          ]} />
        ) },
        { id: 'launched', label: 'Launched', count: t.launched.length, content: (
          <DetailTable rows={t.launched} noun='launches' empty='Nothing launched.' onRow={(l) => l.row && onOrch(l.row)} cols={[
            { key: 'orch', label: 'Orchestrator', type: 'text', value: launchName, render: (l) => orchCell(l.row, launchName(l)) },
            { key: 'job', label: 'Job', type: 'text', value: (l) => l.job_id ?? '', render: (l) => (l.job_id ? <Mono>{l.job_id}</Mono> : <span className='text-muted-foreground'>—</span>) },
            { key: 'pods', label: 'Pods', type: 'number', value: (l) => l.pods, render: (l) => l.pods ?? '—', className: 'text-right tabular-nums' },
            { key: 'state', label: 'State', type: 'text', value: (l) => (l.launch_step ? `failed at ${l.launch_step}` : l.state === 'deleted' ? 'ended' : l.state ?? ''),
              render: (l) => (l.state ? <Chip tone={l.launch_step ? 'bad' : undefined}>{l.launch_step ? `failed at ${l.launch_step}` : l.state === 'deleted' ? 'ended' : l.state}</Chip> : null) }
          ]} />
        ) },
        { id: 'reaped', label: 'Reaped', count: t.reaped.length, content: (
          <DetailTable rows={t.reaped} noun='reaps' empty='Nothing reaped.' onRow={(r) => r.row && onOrch(r.row)} cols={[
            { key: 'orch', label: 'Orchestrator', type: 'text', value: reapName, render: (r) => orchCell(r.row, reapName(r)) },
            { key: 'job', label: 'Job', type: 'text', value: (r) => r.job_id ?? '', render: (r) => (r.job_id ? <Mono>{r.job_id}</Mono> : <span className='text-muted-foreground'>—</span>) },
            { key: 'reason', label: 'Reason', type: 'text', value: (r) => r.reason, render: (r) => <span className='text-muted-foreground'>{r.reason}</span>, className: 'whitespace-normal leading-snug' }
          ]} />
        ) },
        { id: 'raw', label: 'Raw row', content: (
          <KeyValueTable rows={[{ label: 'JSON', value: <LongText mono>{JSON.stringify(t, null, 2)}</LongText> }]} />
        ) }
      ]} />
    </div>
  );
}
