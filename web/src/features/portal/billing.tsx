'use client';
// /app Billing, one page: this month's usage-based spend (live meter, daily spend, projection, what is metered to
// Stripe, by person and by agent), the plan with Stripe-hosted checkout and portal, and the limits that split the budget.
import { useState } from 'react';
import PageContainer from '@/components/layout/page-container';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { Rule, Section } from '@/components/layout/section';
import { appApi } from '@/lib/api-client';
import { money, usd } from '@/lib/octillion-format';
import { cn } from '@/lib/utils';
import { LimitsSection } from './limits';
import { ErrorState, LoadingCards, fail, useOrgLoad } from './shared';

interface Sub { status: string; plan: string | null; renews_at: string | null; cancel_at_period_end: boolean; trial_end: string | null }
interface Plan { price_id: string; name: string; amount: number | null; currency: string; interval: string | null; monthly_budget_usd: number | null }
interface Billing { enabled: boolean; customer: boolean; subscription: Sub | null; budget_usd: number; month_spend_usd: number; plans: Plan[]; can_manage: boolean }
interface Usage {
  period: { start: string; end: string; days: number; elapsed_days: number };
  spent_usd: number; budget_usd: number; projected_usd: number; metered_usd: number; in_flight_usd: number;
  sessions: { finished: number; running: number }; meter: { enabled: boolean; event: string | null };
  daily: { day: string; usd: number; sessions: number }[];
  by_agent: { agent: string; usd: number; sessions: number }[];
  by_person: { user_id: string | null; label: string; usd: number; runs: number }[];
}

const STATUS: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = { active: 'default', trialing: 'secondary', past_due: 'destructive', unpaid: 'destructive', canceled: 'outline' };

export function BillingPage() {
  const { data: b, error } = useOrgLoad(() => appApi<Billing>('GET', '/billing'));
  const { data: u } = useOrgLoad(() => appApi<Usage>('GET', '/billing/usage'));
  return (
    <PageContainer pageTitle='Billing' pageDescription="Usage-based: you pay for the model spend your simulations use, metered live, up to your plan's monthly cap.">
      {error ? <ErrorState error={error} /> : !b ? <LoadingCards count={3} /> : (
        <div className='flex max-w-6xl flex-col gap-10'>
          {u ? <Meter u={u} /> : <LoadingCards count={1} />}
          {u && (
            <div className='grid gap-x-12 gap-y-10 lg:grid-cols-3'>
              <Daily u={u} />
              <Breakdown title='By person' rows={u.by_person.map((p) => ({ key: p.user_id ?? 'key', label: p.label, usd: p.usd, sub: `${p.runs} run${p.runs === 1 ? '' : 's'}` }))} />
              <Breakdown title='By agent' rows={u.by_agent.map((a) => ({ key: a.agent, label: a.agent, usd: a.usd, sub: `${a.sessions} session${a.sessions === 1 ? '' : 's'}`, mono: true }))} />
            </div>
          )}
          <Rule />
          <PlanSection b={b} />
          <Rule />
          <Section title='Limits' description="Split the monthly cap across teams and people, choose who can launch simulations, and cap how much runs at once.">
            <LimitsSection />
          </Section>
        </div>
      )}
    </PageContainer>
  );
}

/** The live meter: spent and projected against the cap, with what Stripe has been sent and what is still running. */
function Meter({ u }: { u: Usage }) {
  const cap = u.budget_usd;
  const pct = (v: number) => (cap ? Math.min(100, (v / cap) * 100) : 0);
  const over = cap > 0 && u.projected_usd > cap;
  const ends = new Date(u.period.end); ends.setUTCDate(ends.getUTCDate() - 1);
  return (
    <section className='flex flex-col gap-4'>
      <div className='flex flex-wrap items-end justify-between gap-4'>
        <div>
          <p className='text-muted-foreground text-xs font-medium uppercase'>Model spend this month</p>
          <p className='mt-1 text-4xl font-semibold tabular-nums'>{usd(u.spent_usd)}<span className='text-muted-foreground text-lg font-normal'>{cap ? ` / ${usd(cap)}` : ' · no cap'}</span></p>
        </div>
        <p className='text-muted-foreground text-sm'>
          {new Date(u.period.start).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })} – {ends.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}
          {' · '}day {Math.ceil(u.period.elapsed_days)} of {u.period.days}
        </p>
      </div>
      {cap > 0 && (
        <div className='relative'>
          <div className='bg-muted h-3 w-full overflow-hidden rounded-full'>
            <div className={cn('h-full rounded-full', pct(u.spent_usd) >= 100 ? 'bg-destructive' : pct(u.spent_usd) >= 80 ? 'bg-amber-500' : 'bg-primary')} style={{ width: `${pct(u.spent_usd)}%` }} />
          </div>
          {/* where today's pace ends the month */}
          <div className={cn('absolute -top-1 h-5 w-0.5 rounded', over ? 'bg-destructive' : 'bg-foreground/50')} style={{ left: `calc(${pct(u.projected_usd)}% - 1px)` }} title={`Projected ${usd(u.projected_usd)}`} />
        </div>
      )}
      <dl className='grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-4'>
        <div><dt className='text-muted-foreground text-xs'>Projected at month end</dt><dd className={cn('font-semibold tabular-nums', over && 'text-destructive')}>{usd(u.projected_usd)}</dd></div>
        <div><dt className='text-muted-foreground text-xs'>Metered to Stripe</dt><dd className='font-semibold tabular-nums'>{usd(u.metered_usd)}<span className='text-muted-foreground font-normal'> · {u.sessions.finished} sessions</span></dd></div>
        <div><dt className='text-muted-foreground text-xs'>In flight</dt><dd className='font-semibold tabular-nums'>{usd(u.in_flight_usd)}<span className='text-muted-foreground font-normal'> · {u.sessions.running} running</span></dd></div>
        <div><dt className='text-muted-foreground text-xs'>Left this month</dt><dd className='font-semibold tabular-nums'>{cap ? usd(Math.max(0, cap - u.spent_usd)) : '—'}</dd></div>
      </dl>
      {over && <Alert variant='destructive'><Icons.warning /><AlertDescription>At this pace you reach the cap before the month ends; simulations pause there and results stay available. Raise the plan or set limits below.</AlertDescription></Alert>}
      {!u.meter.enabled && <p className='text-muted-foreground text-xs'>Metering to Stripe is off for this deployment; spend is tracked here and capped all the same.</p>}
    </section>
  );
}

/** Spend per day this month, as bars. */
function Daily({ u }: { u: Usage }) {
  const byDay = new Map(u.daily.map((d) => [d.day, d]));
  const start = new Date(u.period.start);
  const days = Array.from({ length: u.period.days }, (_, i) => { const d = new Date(start); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); });
  const max = Math.max(0.01, ...u.daily.map((d) => d.usd));
  const today = new Date().toISOString().slice(0, 10);
  return (
    <Section title='Daily spend' description={`${u.daily.reduce((a, d) => a + d.sessions, 0)} sessions this month`}>
      <div className='flex h-32 items-end gap-0.5 border-b' role='img' aria-label='Model spend per day this month'>
        {days.map((d) => {
          const v = byDay.get(d)?.usd ?? 0;
          return <div key={d} title={`${d}: ${usd(v)}`} className={cn('flex-1 rounded-t-sm', d > today ? 'bg-muted/40' : v ? 'bg-primary' : 'bg-muted')} style={{ height: `${d > today ? 4 : Math.max(2, (v / max) * 100)}%` }} />;
        })}
      </div>
      <div className='text-muted-foreground flex justify-between text-[11px]'><span>{days[0].slice(5)}</span><span>{days[days.length - 1].slice(5)}</span></div>
    </Section>
  );
}

function Breakdown({ title, rows }: { title: string; rows: { key: string; label: string; usd: number; sub: string; mono?: boolean }[] }) {
  const max = Math.max(0.01, ...rows.map((r) => r.usd));
  return (
    <Section title={title}>
      {!rows.length ? <p className='text-muted-foreground text-sm'>No spend yet this month.</p> : (
        <ul className='flex flex-col gap-3'>
          {rows.map((r) => (
            <li key={r.key} className='space-y-1'>
              <div className='flex items-baseline justify-between gap-2 text-sm'>
                <span className={cn('min-w-0 truncate', r.mono && 'font-mono text-xs')} title={r.label}>{r.label}</span>
                <span className='shrink-0 tabular-nums'>{usd(r.usd)}</span>
              </div>
              <div className='bg-muted h-1.5 overflow-hidden rounded-full'><div className='bg-primary h-full rounded-full' style={{ width: `${(r.usd / max) * 100}%` }} /></div>
              <p className='text-muted-foreground text-[11px]'>{r.sub}</p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** The plan, compact: status and renewal, Stripe's portal for card and invoices, or the plans to choose from. */
function PlanSection({ b }: { b: Billing }) {
  const [busy, setBusy] = useState<string | null>(null);
  const go = (path: string, body?: unknown, id = path) => {
    setBusy(id);
    appApi<{ url: string }>('POST', path, body).then((r) => { window.location.href = r.url; }).catch((e) => { setBusy(null); fail(e); });
  };
  const s = b.subscription;
  const live = s && ['active', 'trialing', 'past_due'].includes(s.status);
  return (
    <Section title='Plan' description={!b.enabled ? 'Octillion is free during the beta.' : b.can_manage ? undefined : 'Ask an account admin to change the plan.'}>
      {s && ['past_due', 'unpaid'].includes(s.status) && (
        <Alert variant='destructive'><Icons.warning /><AlertDescription>The last payment failed. Update the card to keep running simulations.</AlertDescription></Alert>
      )}
      {b.enabled && (
        <div className='flex flex-wrap items-center gap-x-6 gap-y-3'>
          <div className='flex items-center gap-2'>
            <span className='text-lg font-semibold'>{s?.plan ?? 'No plan yet'}</span>
            <Badge variant={s ? STATUS[s.status] ?? 'outline' : 'outline'}>{s ? s.status.replace('_', ' ') : 'no plan'}</Badge>
          </div>
          {s?.renews_at && <span className='text-muted-foreground text-sm'>{s.cancel_at_period_end ? 'Ends' : 'Renews'} {new Date(s.renews_at).toLocaleDateString()}{s.trial_end ? ` · trial until ${new Date(s.trial_end).toLocaleDateString()}` : ''}</span>}
          {b.can_manage && b.customer && (
            <Button variant='outline' className='ml-auto' disabled={busy !== null} onClick={() => go('/billing/portal')}>
              {busy === '/billing/portal' ? <Icons.spinner className='animate-spin' /> : <Icons.creditCard />} Card, invoices and plan
            </Button>
          )}
        </div>
      )}
      {b.enabled && b.plans.length > 0 && !(live && b.customer) && (
        <ul className='divide-y border-y'>
          {b.plans.map((p) => (
            <li key={p.price_id} className='flex flex-wrap items-center gap-x-6 gap-y-2 py-3'>
              <span className='w-32 font-medium'>{p.name}</span>
              <span className='text-muted-foreground flex-1 text-sm'>{p.monthly_budget_usd != null ? `Up to ${usd(p.monthly_budget_usd)} of model spend a month` : 'Model spend as you go'}</span>
              <span className='tabular-nums'>{money(p.amount, p.currency)}{p.interval && <span className='text-muted-foreground text-sm'> / {p.interval}</span>}</span>
              {b.can_manage && (
                <Button size='sm' disabled={busy !== null} onClick={() => go('/billing/checkout', { price_id: p.price_id }, p.price_id)}>
                  {busy === p.price_id && <Icons.spinner className='animate-spin' />} Choose
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
