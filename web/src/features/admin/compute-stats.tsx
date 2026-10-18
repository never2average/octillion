'use client';
// Health › Jobs and Health › Sessions: two rows of four headline numbers between the toolbar and the table, as on the
// Errors tab. Live figures come from GET /compute/summary (the same query the Compute page refreshes); the Jobs
// figures that follow the table's range and filters come from the jobs loaded.
import { StatStrip } from '@/components/layout/section';
import { useAdmin } from './lib';
import { cents, dur, ageOf } from './compute-common';
import type { JobRow } from './compute-jobs';

interface Live {
  queue: { sessions: number; research: number; oldest_session_at: string | null; unclaimable: number; jobs_waiting: number };
  running: { sessions: number; research: number; orchestrators: { booting: number; running: number; draining: number }; pods_used: number; pods_reserved: number };
  wait_1h: { p50_s: number | null; p95_s: number | null; n: number };
  failures_24h: { sessions: number; launches: number; ended: number; rate: number; top: { key: string; label: string; count: number } | null };
  spend_today: { session_model_usd: number; orchestrator_model_usd: number; sandbox_est_usd: number; total_usd: number };
}

const useLive = () => useAdmin<Live>('/compute/summary', { refetchInterval: 30_000 }).data;
/** The last 24 hours, hour by hour (GET /compute/trends): every card's sparkline. */
const useTrend = () => {
  const t = useAdmin<{ series: Record<string, number[]> }>('/compute/trends', { refetchInterval: 60_000 }).data?.series;
  return (k: string) => t?.[k];
};
const n = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString());
const pct = (r: number) => `${Math.round(r * 100)}%`;

/** Jobs: what the loaded jobs are doing (range and filters applied), then live capacity, failures and spend. */
export function JobsStats({ rows }: { rows: readonly JobRow[] }) {
  const s = useLive(), t = useTrend();
  const by = (st: string) => rows.filter((j) => j.state === st).length;
  const o = s?.running.orchestrators;
  const failed = rows.filter((j) => j.failures.count > 0 || j.failed_launches > 0).length;
  const spend = rows.reduce((t, j) => t + j.spend.total_usd, 0), est = rows.reduce((t, j) => t + j.spend.sandbox_est_usd, 0);
  return (
    <>
      <StatStrip items={[
        { label: 'Jobs shown', spark: t('jobs'), value: n(rows.length), hint: `${by('finished')} finished · ${by('failed')} failed` },
        { label: 'Waiting', spark: t('queued'), value: n(by('waiting') + by('queued')), hint: s ? `${s.queue.jobs_waiting} waiting for an orchestrator now` : undefined },
        { label: 'Running', spark: t('running'), value: n(by('running') + by('booting')), hint: `${by('booting')} booting · ${by('draining')} draining` },
        { label: 'Orchestrators live', spark: t('orchestrators'), value: n(o ? o.booting + o.running + o.draining : null), hint: o ? `${o.running} running · ${o.booting} booting · ${o.draining} draining` : undefined }
      ]} />
      <StatStrip className='border-t-0' items={[
        { label: 'Pods running / reserved', spark: t('running'), value: s ? `${s.running.pods_used} / ${s.running.pods_reserved}` : '—' },
        { label: 'Jobs with failures', spark: t('jobs_failed'), value: n(failed), hint: rows.length ? `${pct(failed / rows.length)} of the jobs shown` : undefined },
        { label: 'Failed launches, 24 h', spark: t('launches_failed'), value: n(s?.failures_24h.launches), hint: 'orchestrators that did not start' },
        { label: 'Spend, jobs shown', spark: t('spend'), value: cents(spend), hint: est > 0 ? `incl. ${cents(est)} sandbox est.` : undefined }
      ]} />
    </>
  );
}

/** Sessions: the queue and what runs now, then how sessions ended in the last 24 hours and today's spend. */
export function SessionsStats() {
  const s = useLive(), t = useTrend();
  const oldest = ageOf(s?.queue.oldest_session_at);
  const f = s?.failures_24h;
  return (
    <>
      <StatStrip items={[
        { label: 'Queued now', spark: t('queued'), value: n(s?.queue.sessions), hint: oldest != null ? `oldest waiting ${dur(oldest)}` : 'nothing waiting' },
        { label: 'Running now', spark: t('running'), value: n(s?.running.sessions), hint: s?.running.research ? `and ${s.running.research} research jobs` : undefined },
        { label: 'Wait to start, p50 (1 h)', spark: t('wait_p50'), value: s?.wait_1h.p50_s != null ? dur(s.wait_1h.p50_s) : '—', hint: s?.wait_1h.p95_s != null ? `p95 ${dur(s.wait_1h.p95_s)} · ${s.wait_1h.n} started` : undefined },
        { label: 'Unclaimable', spark: t('unclaimable'), value: n(s?.queue.unclaimable), hint: 'queued for an agent no orchestrator runs' }
      ]} />
      <StatStrip className='border-t-0' items={[
        { label: 'Ended, 24 h', spark: t('ended'), value: n(f?.ended) },
        { label: 'Failed, 24 h', spark: t('failed'), value: n(f?.sessions), hint: f?.ended ? `${pct(f.rate)} of the sessions that ended` : undefined },
        { label: 'Top failure, 24 h', spark: t('top_failure'), value: f?.top ? n(f.top.count) : '—', hint: f?.top?.label ?? 'no failures' },
        { label: 'Spend today', spark: t('spend'), value: s ? cents(s.spend_today.total_usd) : '—', hint: s?.spend_today.sandbox_est_usd ? `incl. ${cents(s.spend_today.sandbox_est_usd)} sandbox est.` : undefined }
      ]} />
    </>
  );
}
