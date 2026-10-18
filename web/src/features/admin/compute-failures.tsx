'use client';
// Compute › Failures by reason (GET /compute/failures, src/compute-jobs.ts): two lists over the last 24 h (or 7 days).
// Orchestrator launches and reaps: failed launches by step, unattended deletes, then reaps by normalized reason, the
// routine ones (idle or job drain, retired, job ended) muted below a divider and not counted as failures. Session
// failures by class (src/error-classes.ts) with the page that fixes each. A row filters the matching table below.
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useAdmin } from './lib';
import { Section } from './ui';
import { dur, since, useComputeParams, useScrollTo } from './compute-common';

interface Failures {
  hours: number; ended: number;
  launches: { step: string; label: string; count: number; last_at: string; message: string }[];
  reaps: { reason: string; key: string; label: string; routine: boolean; count: number; last_at: string; message: string }[];
  unattended: { kind: string; label: string; count: number; last_at: string; message: string | null }[];
  sessions: { key: string; label: string; count: number; share: number | null; jobs: number; top_agent: string | null; last_at: string; fix: { text: string; href: string } | null }[];
}
interface Line { id: string; reason: string; count: number; last_at: string; message: string | null; tone?: 'bad' | 'muted'; onClick?: () => void }

const ago = (d: string) => <span title={new Date(d).toLocaleString()}>{dur(since(d))} ago</span>;

/** The Failures section, with a 24 h / 7 d picker (?fhours=168). */
export function ComputeFailures() {
  const url = useComputeParams();
  const hours = url.get('fhours') === '168' ? 168 : 24;
  const { data, error, isLoading, refetch } = useAdmin<Failures>(`/compute/failures?hours=${hours}`, { refetchInterval: 30_000, keep: true });
  useScrollTo('failures', !!data);
  const span = hours === 24 ? 'the last 24 hours' : 'the last 7 days';
  // Ended (24 h) holds a day of orchestrators; a week needs All.
  const orchState = hours === 24 ? 'ended' : 'all';
  const showOrch = (reason: string) => url.write({ section: 'orchestrators', state: orchState, oreason: reason, orch: null, back: null });
  const showSessions = (cls: string) => url.write({ section: 'sessions', class: cls, status: cls === 'unclaimable' ? 'queued' : 'failed,timeout', since: hours === 168 ? '7d' : null, session: null });

  const failing: Line[] = data ? [
    ...data.launches.map((l): Line => ({ id: `l:${l.step}`, reason: `Launch failed: ${l.label}`, count: l.count, last_at: l.last_at, message: l.message, tone: 'bad', onClick: () => showOrch(`launch:${l.step}`) })),
    ...data.unattended.map((u): Line => ({ id: `u:${u.kind}`, reason: u.label, count: u.count, last_at: u.last_at, message: u.message })),
    ...data.reaps.filter((r) => !r.routine).map((r): Line => ({ id: r.key, reason: `Reaped: ${r.label}`, count: r.count, last_at: r.last_at, message: r.message, onClick: () => showOrch(r.key) }))
  ] : [];
  const routine: Line[] = data ? data.reaps.filter((r) => r.routine).map((r) => ({ id: r.key, reason: r.label, count: r.count, last_at: r.last_at, message: r.message, tone: 'muted', onClick: () => showOrch(r.key) })) : [];
  const nothing = !!data && !failing.length && !data.sessions.length;

  return (
    <Section title={<span id='compute-failures'>Failures by reason</span>}
      description={`Why orchestrators and sessions failed in ${span}. Pick a row to see those orchestrators or sessions.`}
      action={
        <div className='flex items-center gap-1.5' role='tablist' aria-label='Window'>
          {[24, 168].map((h) => (
            <Button key={h} role='tab' aria-selected={hours === h} size='xs' variant={hours === h ? 'default' : 'outline'} onClick={() => url.write({ fhours: h === 24 ? null : '168' })}>{h === 24 ? '24 h' : '7 d'}</Button>
          ))}
        </div>
      }>
      {error && !data && (
        <div role='alert' className='border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-3 rounded-lg border px-4 py-3 text-sm'>
          <span className='min-w-0 flex-1'>Could not load failures: {error.message}</span>
          <Button variant='outline' size='xs' onClick={() => void refetch()}>Retry</Button>
        </div>
      )}
      {isLoading && !data && <div className='grid gap-4 md:grid-cols-2'><Skeleton className='h-40 rounded-lg' /><Skeleton className='h-40 rounded-lg' /></div>}
      {nothing && <p className='text-muted-foreground rounded-lg border px-4 py-6 text-center text-sm'>No failures in {span}.{routine.length ? ' Routine reaps are listed below.' : ''}</p>}
      {data && (!nothing || routine.length > 0) && (
        <div className='grid items-start gap-4 md:grid-cols-2'>
          <Panel title='Orchestrator launches and reaps' head={['Reason', 'Count', 'Last seen']}>
            {failing.length ? failing.map((l) => <OrchLine key={l.id} l={l} />) : <Empty>No failed launches or unexpected reaps.</Empty>}
            {routine.length > 0 && (
              <>
                <li className='text-muted-foreground bg-muted/30 px-3 py-1.5 text-xs'>Routine: the autoscaler doing its job ({routine.reduce((a, r) => a + r.count, 0)}, not counted as failures)</li>
                {routine.map((l) => <OrchLine key={l.id} l={l} />)}
              </>
            )}
          </Panel>
          <Panel title='Session failures' head={['Failure class', 'Count', 'Last seen']}>
            {data.sessions.length ? data.sessions.map((s) => (
              <li key={s.key}>
                <button type='button' onClick={() => showSessions(s.key)} className='hover:bg-muted/50 grid w-full grid-cols-[1fr_4rem_6rem] gap-x-3 gap-y-0.5 px-3 py-2 text-left text-sm'>
                  <span className='font-medium'>{s.label}</span>
                  <span className='text-right tabular-nums'>{s.count}</span>
                  <span className='text-muted-foreground text-right text-xs'>{ago(s.last_at)}</span>
                  <span className='text-muted-foreground col-span-3 text-xs'>
                    {s.share != null ? `${(s.share * 100).toFixed(s.share < 0.1 ? 1 : 0)}% of the ${data.ended} sessions that ended` : 'queued, never claimed'}
                    {` · ${s.jobs} job${s.jobs === 1 ? '' : 's'}`}{s.top_agent && ` · mostly ${s.top_agent}`}
                  </span>
                </button>
                {s.fix && <p className='-mt-1 px-3 pb-2 text-xs'>Fix it in <Link href={s.fix.href} className='font-medium hover:underline'>{s.fix.text}</Link></p>}
              </li>
            )) : <Empty>No session failures.</Empty>}
          </Panel>
        </div>
      )}
    </Section>
  );
}

function Panel({ title, head, children }: { title: string; head: string[]; children: ReactNode }) {
  return (
    <div className='min-w-0 rounded-lg border'>
      <h3 className='border-b px-3 py-2 text-sm font-medium'>{title}</h3>
      <div className='text-muted-foreground grid grid-cols-[1fr_4rem_6rem] gap-x-3 border-b px-3 py-1.5 text-xs'>
        <span>{head[0]}</span><span className='text-right'>{head[1]}</span><span className='text-right'>{head[2]}</span>
      </div>
      <ul className='divide-y'>{children}</ul>
    </div>
  );
}

function OrchLine({ l }: { l: Line }) {
  const body = (
    <>
      <span className={cn('font-medium', l.tone === 'bad' && 'text-destructive', l.tone === 'muted' && 'text-muted-foreground font-normal')}>{l.reason}</span>
      <span className={cn('text-right tabular-nums', l.tone === 'muted' && 'text-muted-foreground')}>{l.count}</span>
      <span className='text-muted-foreground text-right text-xs'>{ago(l.last_at)}</span>
      {l.message && <span className='text-muted-foreground col-span-3 line-clamp-1 font-mono text-xs' title={l.message}>{l.message}</span>}
    </>
  );
  const cls = 'grid w-full grid-cols-[1fr_4rem_6rem] gap-x-3 gap-y-0.5 px-3 py-2 text-left text-sm';
  return <li>{l.onClick ? <button type='button' onClick={l.onClick} className={cn(cls, 'hover:bg-muted/50')}>{body}</button> : <div className={cls}>{body}</div>}</li>;
}

const Empty = ({ children }: { children: ReactNode }) => <li className='text-muted-foreground px-3 py-4 text-sm'>{children}</li>;
