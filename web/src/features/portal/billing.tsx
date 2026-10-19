'use client';
// /app Billing: this month (plan, spend against the cap; for a member, their own budget and the rules in
// plain words; for an admin, a banner from 80% of the allowance or when the pace runs out) above three tabs. People: one
// searchable table of who is in the account, their role, access, team, limit, what is left and what limits them (invite,
// roles, limits and suspension in each row's ⋯ menu; "own settings only" narrows it to the exceptions). Teams: a
// searchable table of team budgets (deleting one first shows what it changes). Budget rules (admins): the policy as
// sentences (buffer, team budgets, how people share a budget, who can launch), run limits and exceptions, with who gets
// what previewed live by the server's allocate() and saved as one plan. Plans and cards are Stripe's; people are Clerk's.
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { StatStrip } from '@/components/layout/section';
import { ActionsMenu, RecordView, type RecordCol, type RowAction } from '@/components/layout/record-view';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Icons } from '@/components/icons';
import { ApiError, appApi } from '@/lib/api-client';
import { money, num, usd } from '@/lib/octillion-format';
import { cn } from '@/lib/utils';
import { ErrorState, LoadingCards, When, fail, useOrgLoad } from './shared';
import { ACCOUNT_ROLE_LABEL, Allowed, useAccountRole, type AccountRole, type AccountRoleInfo } from './role';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

interface Sub { status: string; plan: string | null; renews_at: string | null; cancel_at_period_end: boolean; trial_end: string | null }
interface Plan { price_id: string; name: string; amount: number | null; currency: string; interval: string | null; monthly_budget_usd: number | null }
interface Billing { enabled: boolean; customer: boolean; subscription: Sub | null; budget_usd: number; budget_source?: 'override' | 'plan' | 'default'; prepaid_allowed?: boolean; plans: Plan[]; can_manage: boolean
  contributions?: Contributions }
/** Credits for personas and tasks Octillion accepted into its library: from Stripe's balance transactions, plus accepted ones Stripe hasn't taken yet. */
interface Contributions { credits: { id: string; amount_usd: number; description: string | null; created: string; submission_id: string }[]; total_usd: number; error: string | null;
  pending: { id: string; kind: 'persona' | 'task'; title: string; credit_usd: number; decided_at: string | null }[] }
interface Usage {
  period: { start: string; end: string; days: number; elapsed_days: number };
  spent_usd: number; budget_usd: number; projected_usd: number; metered_usd: number; in_flight_usd: number;
  sessions: { finished: number; running: number }; meter: { enabled: boolean };
  daily: { day: string; usd: number; sessions: number }[];
}
interface Member { id: string; user_id: string; status: string; role: string; account_role?: AccountRole; created_at: string; email: string | null; name: string | null }
interface Invite { id: string; email: string; state: string; role?: string; account_role?: AccountRole; created_at: string }
interface Team { clerk: boolean; error: string | null; members: Member[]; invitations: Invite[]; me: string | null; can_manage: boolean }
type Mode = 'pool' | 'even' | 'custom';
interface Policy { mode: Mode; reserve_usd: number; default_cap_usd: number | null; new_members_can_run: boolean; max_concurrent_runs: number | null; max_sessions_per_run: number | null; max_run_usd: number | null }
type LimitCode = 'no_allowance' | 'account_cap' | 'budget_error' | 'launch_access' | 'person_limit' | 'team_budget' | 'rest_pot' | 'buffer' | 'runs_at_once' | 'run_sessions';
/** A budget's figures from allocate(): each person's amount before own limits (null: shared freely), launchers, running now, whether it limits. */
interface Pot { each_usd: number | null; launchers: number; in_flight_usd: number; limited_by: LimitCode | null }
interface LimitTeam extends Pot { id: number; name: string; budget_usd: number | null; max_concurrent_runs: number | null; members: number; spent: number; left_usd: number | null }
interface LimitMember { user_id: string; name?: string | null; email?: string | null; team_id: number | null; pot?: number | null; can_run: boolean; own_can_run?: boolean | null;
  adjust_usd: number; cap_usd: number | null; max_concurrent_runs: number | null; spent: number; in_flight_usd?: number; running: number;
  tokens_in: number; tokens_out: number; limit_usd?: number | null; limit_source?: 'own' | 'share' | 'default' | 'pool'; left_usd?: number | null; blocked?: LimitCode | null;
  limited_by?: LimitCode | null; effective_max_concurrent?: number | null; concurrent_source?: 'you' | 'team' | 'account' }
/** A member's own budget (GET /limits for a member): the budget they draw on, run limits, the account's totals, the rules in plain words. */
interface You { pot: { kind: 'team' | 'rest'; name: string; budget_usd: number; left_usd: number } | null; max_sessions: number; max_run_usd: number | null;
  account: { cap_usd: number; spent_usd: number; left_usd: number }; summary: string[] }
interface Limits { policy: Policy; budget_usd: number; teams: LimitTeam[]; members: LimitMember[]; can_manage: boolean; me: string | null; clerk?: boolean; budget_error?: boolean;
  admins?: { name: string }[]; last_change?: { by_name: string; at: string; summary: string | null } | null; server_max_sessions?: number; avg_session_usd?: number | null;
  period_end?: string; version?: string; you?: You; alert?: { used_pct: number; runs_out_on: string | null } | null }
/** The picture of a set of rules (saved, or a draft) that GET /limits and the preview both send an admin. */
interface Picture extends Limits { budget_error: boolean; buffer_usd: number; set_aside_usd: number; over_by_usd: number;
  account: { cap_usd: number; spent_usd: number; launchable_usd: number; left_usd: number; blocked: LimitCode | null };
  rest: Pot & { budget_usd: number; members: number; spent: number; left_usd: number } }
/** GET /limits for an admin: the saved picture, plus This month's figures. */
interface AdminLimits extends Picture { period_end: string; spent_live_usd: number; in_flight_usd: number; running_count: number; projected_usd: number | null; left_usd: number | null;
  unattributed_spent_usd: number;
  /** This month day by day: model spend, simulations launched, simulations running at some point of the day. */
  month_daily?: { days: string[]; spent: number[]; runs: number[]; running: number[] } }
interface PreviewChange { user_id: string; name: string | null; before: number | null; after: number | null; spent: number; blocked_now: boolean; blocked: LimitCode | null; limited_by: LimitCode | null }
interface Warning { code: string; message: string; team_id?: number | null }
/** POST /limits/preview: the draft's picture, its history line in parts, who it changes for, and what it warns about. */
interface Preview extends Picture { summary: string[]; changes: PreviewChange[]; inactive: { user_id: string; field: string; value: number }[]; launch_access_stops: number; warnings: Warning[] }
interface Change { id: number; at: string; by_name: string; summary: string }

const STATUS: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = { active: 'default', trialing: 'secondary', past_due: 'destructive', unpaid: 'destructive', canceled: 'outline' };
const orNull = (v: string) => (v.trim() === '' ? null : Number(v));
const str = (v: number | null | undefined) => (v == null ? '' : String(v));

/** A titled section: the page is the container, no cards. */
function Block({ id, title, action, children }: { id?: string; title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={id} className='flex scroll-mt-20 flex-col gap-4'>
      {(title || action) && <div className='flex items-center justify-between gap-2'>{title ? <h2 className='text-base leading-none font-semibold'>{title}</h2> : <span />}{action}</div>}
      {children}
    </section>
  );
}

const urlParam = (k: string) => (typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get(k));

export function BillingPage() {
  const { data: b, error } = useOrgLoad(() => appApi<Billing>('GET', '/billing'));
  const { data: u } = useOrgLoad(() => appApi<Usage>('GET', '/billing/usage'));
  const { data: t, reload: reloadTeam } = useOrgLoad(() => appApi<Team>('GET', '/team'));
  const { data: l, reload: reloadLimits } = useOrgLoad(() => appApi<Limits>('GET', '/limits'));
  const reload = () => { reloadTeam(); reloadLimits(); };
  // Budget rules links to People (a person's Edit limits, or everyone with their own settings) and Teams, so the tab and
  // People's filter are controlled here; ?tab=people&filter=exceptions opens them directly.
  // (The tabs only render once billing has loaded, in the browser, so reading the URL here can't mismatch the server's HTML.)
  const [tab, setTab] = useState(() => { const v = urlParam('tab'); return v && ['people', 'teams', 'rules'].includes(v) ? v : 'people'; });
  const [peopleFilter, setPeopleFilter] = useState<PeopleFilter>(() => (urlParam('filter') === 'exceptions' ? 'exceptions' : 'all'));
  const [editUser, setEditUser] = useState<string | null>(null);
  const onTab = (to: 'people' | 'teams', filter?: PeopleFilter) => { setTab(to); if (filter) setPeopleFilter(filter); };
  return (
    <PageContainer>
      {error ? <ErrorState error={error} /> : !b ? <LoadingCards count={3} /> : (
        <div className='flex w-full flex-col gap-6'>
          <ThisMonth b={b} u={u ?? undefined} l={l ?? undefined} />
          {/* People, Teams and Budget rules as tabs: the two tables get the full width and height they need. */}
          <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className='gap-4'>
            <TabsList variant='line' className='gap-6 p-0'>
              <TabsTrigger value='people' className='flex-none px-0'>People{t && <span className='text-muted-foreground ml-1.5 font-normal tabular-nums'>{t.members.length + t.invitations.length}</span>}</TabsTrigger>
              <TabsTrigger value='teams' className='flex-none px-0'>Teams{l && <span className='text-muted-foreground ml-1.5 font-normal tabular-nums'>{l.teams.length}</span>}</TabsTrigger>
              {l?.can_manage && <TabsTrigger value='rules' className='flex-none px-0'>Budget rules</TabsTrigger>}
            </TabsList>
            <TabsContent value='people'><People t={t ?? undefined} l={l ?? undefined} reload={reload} openUser={editUser} onOpened={() => setEditUser(null)} filter={peopleFilter} setFilter={setPeopleFilter} /></TabsContent>
            <TabsContent value='teams'>{l ? <Teams l={l} reload={reload} /> : <LoadingCards count={1} />}</TabsContent>
            {/* Kept mounted, so an unsaved draft survives a trip to People or Teams (the tab links there). */}
            {l?.can_manage && <TabsContent value='rules' keepMounted>
              <Rules l={l as AdminLimits} reload={reloadLimits} onTab={onTab} onEditPerson={(id) => { setEditUser(id); setTab('people'); }} />
            </TabsContent>}
          </Tabs>
        </div>
      )}
    </PageContainer>
  );
}

// ---------- this month: plan, spend against the cap ----------

function ThisMonth({ b, u, l }: { b: Billing; u: Usage | undefined; l: Limits | undefined }) {
  const [busy, setBusy] = useState<string | null>(null);
  const go = (path: string, body?: unknown, id = path) => {
    setBusy(id);
    appApi<{ url: string }>('POST', path, body).then((r) => { window.location.href = r.url; }).catch((e) => { setBusy(null); fail(e); });
  };
  const s = b.subscription, live = s && ['active', 'trialing', 'past_due'].includes(s.status);
  // A member's own budget leads; the account's totals move to a smaller line under it.
  const mine = !l?.can_manage && l?.you && !l.budget_error ? l.members.find((m) => m.user_id === l.me) : undefined;
  const cap = u?.budget_usd ?? b.budget_usd;
  const pct = (v: number) => (cap ? Math.min(100, (v / cap) * 100) : 0);
  const over = !!u && cap > 0 && u.projected_usd > cap;
  return (
    <Block title='' action={b.enabled && b.can_manage && b.customer
      ? <Button variant='outline' size='sm' disabled={busy !== null} onClick={() => go('/billing/portal')}>{busy ? <Icons.spinner className='animate-spin' /> : <Icons.creditCard />} Manage billing</Button> : undefined}>
      {s && ['past_due', 'unpaid'].includes(s.status) && <Alert variant='destructive'><Icons.warning /><AlertDescription>The last payment failed. Update the card to keep running simulations.</AlertDescription></Alert>}
      {l?.can_manage && l.alert && <UsageBanner a={l.alert} />}
      {mine && l?.you && <YourBudget m={mine} l={l} you={l.you} />}
      <div className='flex flex-wrap items-baseline gap-x-6 gap-y-2 leading-none'>
        <span className={cn('font-semibold tabular-nums', mine ? 'text-base' : 'text-4xl')}>{mine && 'Account: '}{usd(u?.spent_usd ?? 0)}</span>
        <span className='text-muted-foreground text-sm'>{cap ? `of ${usd(cap)} prepaid this month` : 'no prepaid allowance'}</span>
        <span className='ml-auto flex items-center gap-2 text-sm'>
          {b.budget_source === 'override' ? <span className='text-muted-foreground'>Allowance set by Octillion</span> : !b.enabled ? null : <>
            <span className='font-medium'>{s?.plan ?? 'No plan'}</span>
            {s && <Badge variant={STATUS[s.status] ?? 'outline'}>{s.status.replace('_', ' ')}</Badge>}
            {s?.renews_at && <span className='text-muted-foreground'>{s.cancel_at_period_end ? 'ends' : 'renews'} {new Date(s.renews_at).toLocaleDateString()}</span>}
          </>}
        </span>
      </div>
      {cap > 0 && u && (
        <div className='relative'>
          <div className='bg-muted h-2.5 overflow-hidden rounded-full'><div className={cn('h-full rounded-full', pct(u.spent_usd) >= 100 ? 'bg-destructive' : pct(u.spent_usd) >= 80 ? 'bg-amber-500' : 'bg-primary')} style={{ width: `${pct(u.spent_usd)}%` }} /></div>
          <div className={cn('absolute -top-1 h-4.5 w-0.5 rounded', over ? 'bg-destructive' : 'bg-foreground/50')} style={{ left: `calc(${pct(u.projected_usd)}% - 1px)` }} title={`Projected ${usd(u.projected_usd)}`} />
        </div>
      )}
      {u && (
        <p className='text-muted-foreground flex flex-wrap gap-x-5 gap-y-1 text-xs leading-none'>
          <span className={cn(over && 'text-destructive')}>Projected {usd(u.projected_usd)} by month end</span>
          <span>{usd(u.metered_usd)} metered{u.meter.enabled ? ' to Stripe' : ''} · {u.sessions.finished} sessions</span>
          {u.in_flight_usd > 0 && <span>{usd(u.in_flight_usd)} in flight · {u.sessions.running} running</span>}
          <span>Day {Math.ceil(u.period.elapsed_days)} of {u.period.days}</span>
        </p>
      )}
      {/* No plan and no allowance: runs are off. Plans are invite-only while inference costs are high. */}
      {cap <= 0 && !(b.enabled && b.plans.length > 0) && (
        <Alert><Icons.lock /><AlertDescription>
          Running simulations and onboarding needs a prepaid plan. Plans are invite-only for now: reply to your Octillion contact, or write to us, and we&apos;ll set one up for your team.
        </AlertDescription></Alert>
      )}
      {b.enabled && b.plans.length > 0 && !(live && b.customer) && (
        <ul className='divide-y border-y'>
          {b.plans.map((p) => (
            <li key={p.price_id} className='flex flex-wrap items-center gap-x-6 gap-y-2 py-3 leading-none'>
              <span className='w-32 font-medium'>{p.name}</span>
              <span className='text-muted-foreground flex-1 text-sm'>{p.monthly_budget_usd != null ? `Up to ${usd(p.monthly_budget_usd)} of model spend a month` : 'Model spend as you go'}</span>
              <span className='tabular-nums'>{money(p.amount, p.currency)}{p.interval && <span className='text-muted-foreground text-sm'> / {p.interval}</span>}</span>
              {b.can_manage && <Button size='sm' disabled={busy !== null} onClick={() => go('/billing/checkout', { price_id: p.price_id }, p.price_id)}>Choose</Button>}
            </li>
          ))}
        </ul>
      )}
      {b.contributions && <ContributionCredits c={b.contributions} />}
    </Block>
  );
}

/** "Credits from contributions": what accepted library contributions took off the next invoices (Stripe customer balance). */
function ContributionCredits({ c }: { c: Contributions }) {
  if (!c.credits.length && !c.pending.length) return null;
  return (
    <section className='flex flex-col gap-2'>
      <div className='flex items-baseline gap-3 text-sm leading-none'>
        <span className='font-medium'>Credits from contributions</span>
        {c.credits.length > 0 && <span className='text-muted-foreground tabular-nums'>{usd(c.total_usd)} applied to your next invoices</span>}
      </div>
      <ul className='divide-y border-y text-sm'>
        {c.credits.map((x) => (
          <li key={x.id} className='flex items-center gap-3 py-2 leading-none'>
            <span className='min-w-0 flex-1 truncate'>{x.description ?? 'Library contribution'}</span>
            <span className='text-muted-foreground text-xs'>{new Date(x.created).toLocaleDateString()}</span>
            <span className='w-20 text-right tabular-nums'>{usd(x.amount_usd)}</span>
          </li>
        ))}
        {c.pending.map((x) => (
          <li key={x.id} className='text-muted-foreground flex items-center gap-3 py-2 leading-none'>
            <span className='min-w-0 flex-1 truncate'>Library contribution: {x.title}</span>
            <span className='text-xs'>credit on its way</span>
            <span className='w-20 text-right tabular-nums'>{usd(x.credit_usd)}</span>
          </li>
        ))}
      </ul>
      {c.error && <p className='text-muted-foreground text-xs'>Stripe could not list the credits just now.</p>}
    </section>
  );
}

/** Admins, from 80% of the allowance or when the month's pace runs out before it ends (worked out on GET; nothing is sent). */
function UsageBanner({ a }: { a: NonNullable<Limits['alert']> }) {
  const lines = [
    ...(a.used_pct >= 80 ? [`Your account has used ${a.used_pct}% of this month's allowance.`] : []),
    ...(a.runs_out_on ? [`Your account is on pace to run out on ${utcDate(Date.parse(a.runs_out_on), { month: 'short', day: 'numeric' })}.`] : [])
  ];
  return (
    <Alert variant={a.used_pct >= 100 ? 'destructive' : 'default'} className={a.used_pct >= 100 ? undefined : 'border-amber-500/50'}>
      <Icons.warning /><AlertDescription>{lines.join(' ')}</AlertDescription>
    </Alert>
  );
}

/**
 * A member's own budget (members never see Budget rules): what is left of their limit this month (or, with no personal
 * limit, of the budget they draw on), their team, runs at once, run size and the reset, then the rules in plain words.
 */
function YourBudget({ m, l, you }: { m: LimitMember; l: Limits; you: You }) {
  const reset = l.period_end ? utcDate(Date.parse(l.period_end), { month: 'short', day: 'numeric' }) : null;
  const near = m.limit_usd != null && m.limit_usd > 0 && !m.blocked && m.spent >= 0.8 * m.limit_usd;
  const word = m.limited_by && m.limited_by !== 'launch_access' ? limitedWord(m.limited_by, l.teams, m.team_id, 'Your limit') : null;
  const team = l.teams.find((x) => x.id === m.team_id);
  const details = [
    // The budget they draw on, unless the headline already is it (no personal limit).
    team && team.budget_usd != null ? (m.limit_usd != null ? `Team ${team.name}: ${usd(team.left_usd ?? 0)} left` : `Team ${team.name}`) : team ? `Team ${team.name}` : '',
    m.effective_max_concurrent != null ? `${m.running} of ${m.effective_max_concurrent} running` : m.running ? `${m.running} running` : '',
    `up to ${plural(you.max_sessions, 'session')}${you.max_run_usd != null ? ` and ${usd(you.max_run_usd)}` : ''} per run`,
    reset ? `resets ${reset}` : ''
  ].filter(Boolean);
  return (
    <div className='flex flex-col gap-3'>
      <span className='text-muted-foreground text-xs leading-none'>Your budget</span>
      <div className='flex flex-wrap items-baseline gap-x-3 gap-y-2 leading-none'>
        {!m.can_run ? <span className='text-2xl font-semibold'>You can&apos;t launch simulations yet</span>
          : m.limit_usd == null ? <><span className='text-4xl font-semibold tabular-nums'>{usd(you.pot?.left_usd ?? 0)}</span>
            <span className='text-muted-foreground text-sm'>No personal limit · {you.pot?.name ?? 'Everyone'} has this left</span></>
          : <><span className='text-4xl font-semibold tabular-nums'>{usd(m.left_usd ?? 0)}</span><span className='text-muted-foreground text-sm'>left of {usd(m.limit_usd)} this month</span></>}
        <span className='flex flex-wrap gap-1.5'>
          {near && <Badge variant='outline' className='border-amber-500/50 text-amber-700 dark:text-amber-400'>Near your limit</Badge>}
          {word && <Badge variant={m.blocked ? 'destructive' : 'outline'}>Limited by: {word}</Badge>}
        </span>
      </div>
      <p className='text-muted-foreground text-xs leading-none'>{details.join(' · ')}</p>
      {you.summary.length > 0 && <p className='max-w-3xl text-sm leading-relaxed'>{you.summary.join(' ')}</p>}
    </div>
  );
}

// ---------- people: one table for membership, access and limits ----------

type PersonRow =
  | { kind: 'member'; key: string; m: Member; lim: LimitMember | undefined }
  | { kind: 'invite'; key: string; x: Invite };
type PeopleFilter = 'all' | 'exceptions';

/** A person's own settings, in words ("own limit $150.00", "can't launch"); none: they follow the defaults. Budget rules' Exceptions and People's filter. */
function exceptionWords(m: LimitMember, p: Policy) {
  return [
    ...(m.cap_usd != null ? [`own limit ${usd(m.cap_usd)}`] : []),
    ...(m.adjust_usd ? [`${m.adjust_usd > 0 ? '+' : '−'}${usd(Math.abs(m.adjust_usd))} ${p.mode === 'even' ? 'on top of equal share' : 'adjustment (only applies with an equal share)'}`] : []),
    ...(m.own_can_run != null && m.own_can_run !== p.new_members_can_run ? [m.own_can_run ? 'allowed to launch' : "can't launch"] : []),
    ...(m.max_concurrent_runs != null ? [plural(m.max_concurrent_runs, 'run') + ' at once'] : [])
  ];
}
const SOURCE_WORD = { you: 'own', team: 'team', account: 'account' } as const;

function People({ t, l, reload, openUser, onOpened, filter = 'all', setFilter }: { t: Team | undefined; l: Limits | undefined; reload: () => void; openUser?: string | null; onOpened?: () => void;
  filter?: PeopleFilter; setFilter?: (f: PeopleFilter) => void }) {
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<{ m: Member; lim: LimitMember } | null>(null);
  const [suspend, setSuspend] = useState<Member | null>(null);
  const { lock, roles } = useAccountRole();
  if (!t) return <LoadingCards count={1} />;
  // The team (invite, roles, suspension) is the owners'; Edit limits is Budget rules (owners and billing managers).
  const manage = t.can_manage, budget = !!l?.can_manage, mode = l?.policy.mode ?? 'pool';
  // "Edit on People →" from Budget rules opens that person's Edit limits; closing it clears the request.
  const asked = openUser ? { m: t.members.find((x) => x.user_id === openUser), lim: l?.members.find((x) => x.user_id === openUser) } : null;
  const dialog = editing ?? (asked?.m && asked.lim ? { m: asked.m, lim: asked.lim } : null);
  const act = (p: Promise<unknown>, msg: string) => p.then(() => { toast.success(msg); reload(); }).catch(fail);
  const all: PersonRow[] = [
    ...t.members.map((m) => ({ kind: 'member' as const, key: m.id, m, lim: l?.members.find((x) => x.user_id === m.user_id) })),
    ...t.invitations.map((x) => ({ kind: 'invite' as const, key: x.id, x }))
  ];
  // "Own settings only" (?filter=exceptions, or See all on Budget rules): the people who don't follow the defaults.
  const own = (r: PersonRow) => r.kind === 'member' && !!r.lim && !!l && exceptionWords(r.lim, l.policy).length > 0;
  const exceptions = budget ? all.filter(own).length : 0;
  const filtered = filter === 'exceptions' && budget;
  const rows = filtered ? all.filter(own) : all;
  const teamName = (id: number | null | undefined) => (id == null ? null : l?.teams.find((x) => x.id === id)?.name ?? null);
  const actions = (r: PersonRow): RowAction[] => {
    if (!manage && !budget) return [];
    if (r.kind === 'invite') return [
      lock({ label: 'Resend invitation', icon: <Icons.send />, onSelect: () => act(appApi('POST', `/team/invitations/${encodeURIComponent(r.x.id)}/resend`), `Invitation resent to ${r.x.email}`) }, 'team'),
      ...(r.x.state === 'pending' ? [lock({ label: 'Cancel invitation', icon: <Icons.close />, destructive: true, onSelect: () => act(appApi('POST', `/team/invitations/${encodeURIComponent(r.x.id)}/revoke`), 'Invitation cancelled') }, 'team')] : [])
    ];
    const { m, lim } = r, self = m.user_id === t.me, active = m.status === 'active', now = roleOf(m);
    return [
      ...(lim ? [lock({ label: 'Edit limits', icon: <Icons.gauge />, onSelect: () => setEditing({ m, lim }) }, 'budget')] : []),
      ...(self ? [] : [
        ...roles.filter((x) => x.id !== now).map((x, i) => lock({ label: `Make ${x.label.toLowerCase()}`, icon: <Icons.teams />, separator: i === 0 && !!lim,
          onSelect: () => act(appApi('POST', `/team/members/${encodeURIComponent(m.id)}/role`, { role: x.id }), `${m.email} is now ${/^[aeiou]/i.test(x.label) ? 'an' : 'a'} ${x.label.toLowerCase()}`) }, 'team')),
        lock(active ? { label: 'Suspend access', icon: <Icons.close />, destructive: true, separator: true, onSelect: () => setSuspend(m) }
          : { label: 'Restore access', icon: <Icons.check />, separator: true, onSelect: () => act(appApi('POST', `/team/members/${encodeURIComponent(m.id)}/reactivate`), `Access restored for ${m.email}`) }, 'team')
      ])
    ];
  };
  const statusOf = (r: PersonRow) => (r.kind === 'invite' ? (r.x.state === 'expired' ? 'Invitation expired' : 'Invited') : r.m.status === 'active' ? 'Active' : 'Suspended');
  const cols: RecordCol<PersonRow>[] = [
    { key: 'person', label: 'Person', keep: true, type: 'text', value: (r) => (r.kind === 'invite' ? r.x.email : r.m.name || r.m.email || ''),
      render: (r) => r.kind === 'invite' ? <span className='font-medium'>{r.x.email}</span> : (<>
        <span className='font-medium'>{r.m.name || r.m.email}</span>
        {r.m.user_id === t.me && <span className='text-muted-foreground ml-2 text-xs'>you</span>}
        {r.m.name && <span className='text-muted-foreground ml-2 text-xs'>{r.m.email}</span>}
      </>) },
    { key: 'role', label: 'Role', className: 'w-36', type: 'select', value: (r) => ACCOUNT_ROLE_LABEL[roleOf(r.kind === 'invite' ? r.x : r.m)],
      render: (r) => { const x = roleOf(r.kind === 'invite' ? r.x : r.m); return <span className={x === 'owner' ? '' : 'text-muted-foreground'} title={roles.find((y) => y.id === x)?.help}>{ACCOUNT_ROLE_LABEL[x]}</span>; } },
    { key: 'status', label: 'Status', className: 'w-36', type: 'select', value: statusOf,
      render: (r) => <Badge variant={statusOf(r) === 'Active' ? 'secondary' : statusOf(r) === 'Invited' ? 'outline' : 'destructive'}>{statusOf(r)}</Badge> },
    { key: 'team', label: 'Team', className: 'w-36', type: 'select', value: (r) => (r.kind === 'member' ? teamName(r.lim?.team_id) ?? 'No team' : 'No team'),
      render: (r) => <span className='text-muted-foreground'>{r.kind === 'member' ? teamName(r.lim?.team_id) ?? '—' : '—'}</span> },
    { key: 'spend', label: 'Spend this month', className: 'w-56', type: 'number', value: (r) => (r.kind === 'member' ? r.lim?.spent ?? 0 : 0),
      render: (r) => r.kind === 'invite' || !r.lim ? <span className='text-muted-foreground'>—</span> : r.lim.limit_usd == null
        ? <span className='text-xs tabular-nums'>{usd(r.lim.spent)} <span className='text-muted-foreground'>· shared budget</span></span>
        : <Allowance spent={r.lim.spent} cap={r.lim.limit_usd} /> },
    // What is left before the first limit that applies (their own, their budget, the buffer, the account), and which one binds.
    { key: 'left', label: 'Left', className: 'w-24', type: 'number', value: (r) => (r.kind === 'member' && r.lim ? r.lim.left_usd ?? undefined : undefined),
      render: (r) => <span className='text-xs tabular-nums'>{r.kind === 'member' && r.lim?.left_usd != null ? usd(r.lim.left_usd) : <span className='text-muted-foreground'>—</span>}</span> },
    { key: 'limited', label: 'Limited by', className: 'w-36', type: 'select', value: (r) => (r.kind === 'member' && r.lim ? limitedWord(r.lim.limited_by, l?.teams ?? [], r.lim.team_id) ?? '—' : '—'),
      render: (r) => {
        const w = r.kind === 'member' && r.lim ? limitedWord(r.lim.limited_by, l?.teams ?? [], r.lim.team_id) : null;
        return w ? <span className={cn('text-xs', r.kind === 'member' && r.lim?.blocked && 'text-destructive')}>{w}</span> : <span className='text-muted-foreground'>—</span>;
      } },
    { key: 'tokens', label: 'Tokens', className: 'w-28', type: 'number', value: (r) => (r.kind === 'member' && r.lim ? Number(r.lim.tokens_in) + Number(r.lim.tokens_out) : 0),
      render: (r) => <span className='text-xs tabular-nums'>{r.kind === 'member' && r.lim ? num(Number(r.lim.tokens_in) + Number(r.lim.tokens_out)) : '—'}</span> },
    // The one that applies (the most specific: their own, their team's, the account's) and where it comes from: "2 · team".
    { key: 'runs', label: 'Runs at once', className: 'w-36', render: (r) => r.kind === 'invite' || !r.lim ? <span className='text-muted-foreground'>—</span> : (
      <span className='text-xs tabular-nums'>
        {r.lim.effective_max_concurrent == null ? <span className='text-muted-foreground'>no limit</span>
          : <>{r.lim.effective_max_concurrent}<span className='text-muted-foreground'> · {SOURCE_WORD[r.lim.concurrent_source ?? 'account']}</span></>}
        {r.lim.running > 0 && <span className='text-primary ml-1.5'>· {r.lim.running} now</span>}
      </span>) },
    { key: 'can_run', label: 'Can run', className: 'w-24', type: 'select', value: (r) => (r.kind === 'member' && r.lim ? (r.lim.can_run ? 'Yes' : 'No') : '—'),
      render: (r) => <span className={r.kind === 'member' && r.lim?.can_run ? '' : 'text-muted-foreground'}>{r.kind === 'member' && r.lim ? (r.lim.can_run ? 'Yes' : 'No') : '—'}</span> },
    { key: 'joined', label: 'Joined', className: 'w-28', type: 'date', value: (r) => (r.kind === 'invite' ? r.x.created_at : r.m.created_at),
      render: (r) => <span className='text-muted-foreground text-xs'>{r.kind === 'invite' ? <>sent <When d={r.x.created_at} /></> : <When d={r.m.created_at} />}</span> }
  ];
  return (
    <div className='flex flex-col gap-3'>
      {t.error && <Alert variant='destructive'><AlertDescription>{t.error}</AlertDescription></Alert>}
      <RecordView compact id='billing-people' rows={rows} rowKey={(r) => r.key} cols={cols} noun='people'
        searchText={(r) => (r.kind === 'invite' ? r.x.email : `${r.m.name ?? ''} ${r.m.email ?? ''} ${teamName(r.lim?.team_id) ?? ''}`)}
        searchPlaceholder='Search people by name, email or team'
        filters={<>
          {budget && (
            <Button variant={filtered ? 'secondary' : 'outline'} size='sm' aria-pressed={!!filtered} onClick={() => setFilter?.(filtered ? 'all' : 'exceptions')}
              title='People with their own limit, adjustment, launch access or runs at once'>
              Own settings only<span className='text-muted-foreground ml-1 tabular-nums'>{exceptions}</span>
            </Button>)}
          <RolesHelp roles={roles} />
        </>}
        views={[{ id: 'all', label: 'Everyone' }, { id: 'active', label: 'Active', match: (r) => statusOf(r) === 'Active' }, { id: 'invited', label: 'Invited', match: (r) => r.kind === 'invite' },
          { id: 'suspended', label: 'Suspended', match: (r) => statusOf(r) === 'Suspended' }]}
        primary={<Allowed need='team'><Button onClick={() => setInviting(true)}><Icons.add /> Invite</Button></Allowed>}
        actions={manage || budget ? actions : undefined} exportName='people' empty={filtered ? 'Nobody has their own settings.' : 'Nobody here yet.'} />
      {inviting && <InviteDialog roles={roles} onClose={() => setInviting(false)} onSent={reload} />}
      {dialog && l && <LimitsDialog m={dialog.m} lim={dialog.lim} l={l} mode={mode} onClose={() => { setEditing(null); onOpened?.(); }} onSaved={reload} />}
      <Dialog open={!!suspend} onOpenChange={(o) => !o && setSuspend(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Suspend {suspend?.email}?</DialogTitle>
            <DialogDescription>Their AI client and this portal stop working for them within a minute. They stay in the account, and you can restore access any time.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant='outline' onClick={() => setSuspend(null)}>Keep access</Button>
            <Button variant='destructive' onClick={() => suspend && act(appApi('POST', `/team/members/${encodeURIComponent(suspend.id)}/deactivate`), `Access suspended for ${suspend.email}`).finally(() => setSuspend(null))}>Suspend</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Allowance({ spent, cap }: { spent: number; cap: number }) {
  const p = cap ? Math.min(100, (spent / cap) * 100) : 0;
  return (
    <div className='flex items-center gap-2'>
      <div className='bg-muted h-1.5 w-20 overflow-hidden rounded-full'><div className={cn('h-full rounded-full', p >= 100 ? 'bg-destructive' : p >= 80 ? 'bg-amber-500' : 'bg-primary')} style={{ width: `${p}%` }} /></div>
      <span className='text-xs tabular-nums'>{usd(spent)} <span className='text-muted-foreground'>of {usd(cap)}</span></span>
    </div>
  );
}

/** A person's or invitation's account role (older servers sent only Clerk's admin / member). */
const roleOf = (x: { role?: string; account_role?: AccountRole }): AccountRole => x.account_role ?? (x.role === 'admin' ? 'owner' : 'member');

/** What each role can do, one line each, next to Invite. */
function RolesHelp({ roles }: { roles: AccountRoleInfo[] }) {
  if (!roles.length) return null;
  return (
    <Popover>
      <PopoverTrigger render={<Button variant='ghost' size='sm' className='text-muted-foreground' />}>Roles</PopoverTrigger>
      <PopoverContent align='end' className='w-80'><RoleLines roles={roles} /></PopoverContent>
    </Popover>
  );
}
const RoleLines = ({ roles, on }: { roles: AccountRoleInfo[]; on?: string }) => (
  <dl className='grid gap-2 text-sm'>
    {roles.map((r) => <div key={r.id} className={cn(on && on !== r.id && 'text-muted-foreground')}><dt className='font-medium'>{r.label}</dt><dd className='text-muted-foreground text-xs'>{r.help}</dd></div>)}
  </dl>
);

function InviteDialog({ roles, onClose, onSent }: { roles: AccountRoleInfo[]; onClose: () => void; onSent: () => void }) {
  const [email, setEmail] = useState(''), [role, setRole] = useState('member'), [busy, setBusy] = useState(false);
  const send = (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    appApi('POST', '/team/invitations', { email: email.trim(), role })
      .then(() => { toast.success(`Invitation sent to ${email.trim()}`); onSent(); onClose(); }).catch(fail).finally(() => setBusy(false));
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <form onSubmit={send} className='grid gap-4'>
          <DialogHeader><DialogTitle>Invite someone</DialogTitle><DialogDescription>They get an email and join this account with the role you pick when they accept.</DialogDescription></DialogHeader>
          <div className='flex gap-2'>
            <Input autoFocus type='email' required placeholder='name@company.com' value={email} onChange={(e) => setEmail(e.target.value)} aria-label='Email' />
            <NativeSelect value={role} onChange={(e) => setRole(e.target.value)} aria-label='Role' className='w-40'>
              {(roles.length ? roles : [{ id: 'member', label: 'Member', help: '' }]).map((r) => <NativeSelectOption key={r.id} value={r.id}>{r.label}</NativeSelectOption>)}
            </NativeSelect>
          </div>
          <RoleLines roles={roles} on={role} />
          <DialogFooter><Button type='button' variant='outline' onClick={onClose}>Cancel</Button><Button type='submit' disabled={busy || !email.trim()}>Send invitation</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const runWord = (v: boolean | null) => (v == null ? 'default' : v ? 'yes' : 'no');

/**
 * One person's limits, one per row: their monthly limit (the default for how the account shares budgets, or their own,
 * in every mode), their adjustment (equal share only), team, launch access (the account's setting, or yes or no) and
 * runs at once (empty: their team's or the account's). Only what was changed is sent, so opening and saving never pins
 * a default onto the person.
 */
function LimitsDialog({ m, lim, l, mode, onClose, onSaved }: { m: Member; lim: LimitMember; l: Limits; mode: Mode; onClose: () => void; onSaved: () => void }) {
  const init = { team: lim.team_id == null ? '' : String(lim.team_id), run: runWord(lim.own_can_run ?? null), limit: lim.cap_usd == null ? 'default' : 'own', cap: str(lim.cap_usd),
    adjust: lim.adjust_usd ? String(lim.adjust_usd) : '', conc: str(lim.max_concurrent_runs) };
  const [f, setF] = useState(init);
  const p = l.policy;
  // The default, as it stands for this person's budget: the shared pot, their equal share, or the account's set amount.
  const pot = lim.pot == null ? (l as Partial<Picture>).rest : l.teams.find((x) => x.id === lim.pot);
  const byDefault = mode === 'pool' ? 'shared budget, no personal limit' : mode === 'custom' ? `${usd(p.default_cap_usd ?? 0)} for everyone` : `equal share: ${usd(pot?.each_usd ?? 0)}`;
  const team = l.teams.find((x) => String(x.id) === f.team);
  const runsDefault = team?.max_concurrent_runs ?? p.max_concurrent_runs;
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    if (f.team !== init.team) body.team_id = f.team === '' ? null : Number(f.team);
    if (f.run !== init.run) body.can_run = f.run === 'default' ? null : f.run === 'yes';
    if (f.conc !== init.conc) body.max_concurrent_runs = orNull(f.conc);
    const cap = f.limit === 'own' ? orNull(f.cap) : null;
    if (cap !== lim.cap_usd) body.cap_usd = cap;
    if (mode === 'even' && f.adjust !== init.adjust) body.adjust_usd = orNull(f.adjust) ?? 0;
    if (!Object.keys(body).length) return onClose();
    appApi('PUT', `/limits/members/${encodeURIComponent(m.user_id)}`, body)
      .then(() => { toast.success('Limits saved'); onSaved(); onClose(); }).catch(fail);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <form onSubmit={save} className='grid gap-4'>
          <DialogHeader><DialogTitle>Limits for {m.name || m.email}</DialogTitle>
            <DialogDescription>Spent {usd(lim.spent)} this month{lim.limit_usd != null ? ` of ${usd(lim.limit_usd)}` : ''}{lim.left_usd != null ? `, ${usd(lim.left_usd)} left` : ''}.</DialogDescription></DialogHeader>
          <label className='grid gap-1.5 text-sm'>Monthly limit
            <NativeSelect value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })} className='w-full'>
              <NativeSelectOption value='default'>Use the default ({byDefault})</NativeSelectOption>
              <NativeSelectOption value='own'>Own limit</NativeSelectOption>
            </NativeSelect>
          </label>
          {f.limit === 'own' && <label className='grid gap-1.5 text-sm'>Own limit ($ a month)<Input type='number' inputMode='decimal' required min={0} step={0.01} value={f.cap} onChange={(e) => setF({ ...f, cap: e.target.value })} /></label>}
          {mode === 'even' && <label className='grid gap-1.5 text-sm'>Adjustment on top of equal share (± $)<Input type='number' inputMode='decimal' step={0.01} value={f.adjust} onChange={(e) => setF({ ...f, adjust: e.target.value })} placeholder='0' /></label>}
          <label className='grid gap-1.5 text-sm'>Team
            <NativeSelect value={f.team} onChange={(e) => setF({ ...f, team: e.target.value })} className='w-full'>
              <NativeSelectOption value=''>No team</NativeSelectOption>
              {l.teams.map((x) => <NativeSelectOption key={x.id} value={String(x.id)}>{x.name}</NativeSelectOption>)}
            </NativeSelect>
          </label>
          <label className='grid gap-1.5 text-sm'>Can launch simulations
            <NativeSelect value={f.run} onChange={(e) => setF({ ...f, run: e.target.value })} className='w-full'>
              <NativeSelectOption value='default'>Use the account setting ({p.new_members_can_run ? 'everyone can launch' : 'only people allowed'})</NativeSelectOption>
              <NativeSelectOption value='yes'>Yes</NativeSelectOption>
              <NativeSelectOption value='no'>No</NativeSelectOption>
            </NativeSelect>
          </label>
          <label className='grid gap-1.5 text-sm'>Runs at once<Input type='number' inputMode='numeric' min={1} step={1} value={f.conc} onChange={(e) => setF({ ...f, conc: e.target.value })}
            placeholder={`Use team or account setting (${runsDefault ?? 'no limit'})`} /></label>
          <DialogFooter><Button type='button' variant='outline' onClick={onClose}>Cancel</Button><Button type='submit'>Save limits</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- budget rules (admins): the policy as sentences, its effect previewed live, saved as one plan ----------

const MODE_OPTIONS: { id: Mode; label: string; hint: string }[] = [
  { id: 'pool', label: 'share it freely', hint: 'Anyone can use the whole budget until it runs out. One person can use all of it.' },
  { id: 'even', label: 'get an equal share', hint: 'Each budget is split between the people in it who can launch. It goes down when someone joins.' },
  { id: 'custom', label: 'can each spend up to a set amount', hint: 'Everyone gets the same personal limit. A budget still stops at its total.' }
];
// Each budget's colour in the bar: its share (light), what is spent (solid) and what is running now (between).
const SEG = [
  { base: 'bg-sky-500/20', fill: 'bg-sky-500', run: 'bg-sky-500/50' },
  { base: 'bg-violet-500/20', fill: 'bg-violet-500', run: 'bg-violet-500/50' },
  { base: 'bg-amber-500/20', fill: 'bg-amber-500', run: 'bg-amber-500/50' },
  { base: 'bg-rose-500/20', fill: 'bg-rose-500', run: 'bg-rose-500/50' },
  { base: 'bg-teal-500/20', fill: 'bg-teal-500', run: 'bg-teal-500/50' },
  { base: 'bg-fuchsia-500/20', fill: 'bg-fuchsia-500', run: 'bg-fuchsia-500/50' }
];
const REST_SEG = { base: 'bg-primary/20', fill: 'bg-primary', run: 'bg-primary/50' };
const BUFFER_SEG = { base: 'bg-muted-foreground/25', fill: 'bg-muted-foreground', run: 'bg-muted-foreground/50' };

/** "≈ 16 sessions at this month's average of $1.24 per session", beside the run dollar cap. */
const runEstimate = (cap: number | null, avg: number | null | undefined) =>
  avg == null ? 'Not enough runs yet to estimate.' : cap == null || !(cap > 0) ? `This month's average is $${avg.toFixed(2)} per session.`
  : cap < avg ? `That is less than one session at this month's average of $${avg.toFixed(2)}.` : `≈ ${Math.floor(cap / avg)} sessions at this month's average of $${avg.toFixed(2)} per session.`;

/** Dates on this tab are the UTC month's, like the budget: "October", "Oct 31", "Nov 1". */
const utcDate = (ms: number, o: Intl.DateTimeFormatOptions) => new Date(ms).toLocaleDateString('en-US', { ...o, timeZone: 'UTC' });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const names = (xs: string[], max = 3) => xs.slice(0, max).join(', ') + (xs.length > max ? ` +${xs.length - max}` : '');

/** The tab's draft as typed: money and counts are strings (empty is none), team budgets in the order shown, people to reset. */
interface RulesDraft { mode: Mode; reserve: string; defaultCap: string; newRun: boolean; conc: string; sess: string; runUsd: string; budgets: [number, string][]; resets: string[] }
const draftOf = (l: AdminLimits): RulesDraft => ({
  mode: l.policy.mode, reserve: l.policy.reserve_usd ? String(l.policy.reserve_usd) : '', defaultCap: str(l.policy.default_cap_usd), newRun: l.policy.new_members_can_run,
  conc: str(l.policy.max_concurrent_runs), sess: str(l.policy.max_sessions_per_run), runUsd: str(l.policy.max_run_usd),
  budgets: l.teams.filter((t) => t.budget_usd != null).map((t) => [t.id, String(t.budget_usd)]), resets: []
});

/** Someone else saved while this draft was open: keep what this person changed, take everything else from the latest rules. */
function rebase(f: RulesDraft, was: RulesDraft, now: RulesDraft): RulesDraft {
  const pick = <K extends keyof RulesDraft>(k: K): RulesDraft[K] => (JSON.stringify(f[k]) !== JSON.stringify(was[k]) ? f[k] : now[k]);
  const mine = new Map(f.budgets), old = new Map(was.budgets), budgets = new Map(now.budgets);
  for (const id of new Set([...mine.keys(), ...old.keys()])) {
    if (mine.get(id) === old.get(id)) continue;
    if (mine.has(id)) budgets.set(id, mine.get(id)!); else budgets.delete(id);
  }
  return { mode: pick('mode'), reserve: pick('reserve'), defaultCap: pick('defaultCap'), newRun: pick('newRun'), conc: pick('conc'), sess: pick('sess'), runUsd: pick('runUsd'),
    budgets: [...budgets], resets: f.resets };
}

const parse = (v: string) => (v.trim() === '' ? null : Number(v));

/**
 * The draft as a PUT /limits/plan body (only what changed: the server diffs it into the history line) and a plain-English
 * error per field that can't be saved. The same checks as the server, so a typo shows beside its field, not as a 422.
 */
function planOf(l: AdminLimits, f: RulesDraft) {
  const errors: Record<string, string> = {};
  const cap = l.budget_error ? 0 : l.budget_usd, p = l.policy;
  const cash = (key: string, v: string, { min = 0, max = 1e7, tooMuch = 'Enter an amount up to $10,000,000.' }: { min?: number; max?: number; tooMuch?: string } = {}) => {
    const n = parse(v);
    if (n == null) return null;
    if (!Number.isFinite(n) || n < min) errors[key] = min > 0 ? `Enter at least ${usd(min)}, or leave it empty.` : 'Enter an amount of $0 or more.';
    else if (n > max) errors[key] = tooMuch;
    return Math.round(n * 100) / 100;
  };
  const whole = (key: string, v: string, max: number) => {
    const n = parse(v);
    if (n == null) return null;
    if (n === 0) errors[key] = "Use 'can launch' to stop launches.";
    else if (!Number.isInteger(n) || n < 1 || n > max) errors[key] = `Enter a whole number from 1 to ${max.toLocaleString()}, or leave it empty.`;
    return n;
  };
  const allowance = cap > 0 ? cap : 1e7;
  const next = {
    mode: f.mode,
    reserve_usd: cash('reserve', f.reserve, { max: allowance, tooMuch: `Can't hold back more than your ${usd(cap)} allowance.` }) ?? 0,
    default_cap_usd: f.mode !== 'custom' ? p.default_cap_usd : cash('defaultCap', f.defaultCap, { min: 0.01, max: allowance, tooMuch: `Can't be more than your ${usd(cap)} allowance.` }),
    new_members_can_run: f.newRun,
    max_concurrent_runs: whole('conc', f.conc, 10000),
    max_sessions_per_run: whole('sess', f.sess, l.server_max_sessions ?? 10000),
    max_run_usd: cash('runUsd', f.runUsd, { min: 0.01, max: allowance, tooMuch: `A simulation can't spend more than your ${usd(cap)} allowance.` })
  };
  if (f.mode === 'custom' && f.defaultCap.trim() === '') errors.defaultCap = "Enter an amount, or choose 'share it freely'.";
  const policy: Partial<Policy> = {};
  for (const k of Object.keys(next) as (keyof typeof next)[]) if (next[k] !== p[k]) (policy as Record<string, unknown>)[k] = next[k];
  const drafted = new Map(f.budgets);
  const team_budgets: { id: number; budget_usd: number | null }[] = [];
  for (const t of l.teams) {
    const d = drafted.get(t.id);
    if (d !== undefined && d.trim() === '') { errors[`team:${t.id}`] = 'Enter an amount or remove this row.'; continue; }
    const v = d === undefined ? null : cash(`team:${t.id}`, d);
    if (v !== t.budget_usd) team_budgets.push({ id: t.id, budget_usd: v });
  }
  return { body: { policy, team_budgets, member_resets: f.resets }, errors };
}

/** What a limit is called beside a person or budget: "Their limit" (to a member, "Your limit"), "Mobile budget". */
function limitedWord(c: LimitCode | null | undefined, teams: { id: number; name: string }[], teamId?: number | null, person = 'Their limit') {
  if (!c) return null;
  const team = teams.find((t) => t.id === teamId)?.name ?? 'Team';
  const words: Record<LimitCode, string> = { no_allowance: 'No allowance', account_cap: 'Allowance', budget_error: 'Allowance', launch_access: "Can't launch",
    person_limit: person, team_budget: `${team} budget`, rest_pot: 'Everyone else', buffer: 'Buffer', runs_at_once: 'Runs at once', run_sessions: 'Sessions per run' };
  return words[c];
}

function Rules({ l, reload, onEditPerson, onTab }: { l: AdminLimits; reload: () => Promise<Limits | null>; onEditPerson: (userId: string) => void; onTab: (tab: 'people' | 'teams', filter?: PeopleFilter) => void }) {
  const base = useMemo(() => draftOf(l), [l]);
  const [f, setF] = useState(base);
  // The rules reloaded (a save here, or a change on People or Teams): an untouched draft follows them; an edited one
  // keeps this person's edits on top of the latest rules.
  const shown = useRef(base);
  useEffect(() => {
    const was = shown.current;
    shown.current = base;
    if (was !== base) setF((x) => (JSON.stringify(x) === JSON.stringify(was) ? base : rebase(x, was, base)));
  }, [base]);
  const [pv, setPv] = useState<Preview | null>(null);
  const [pvState, setPvState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [review, setReview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const seq = useRef(0);
  const { body, errors } = planOf(l, f);
  const dirty = JSON.stringify(f) !== JSON.stringify(base);
  const bad = Object.keys(errors).length > 0;
  const key = JSON.stringify(body);
  // The preview: the whole draft, 300 ms after the last edit; only the newest answer is used. A draft with a field
  // error keeps the last good preview (dimmed) until it is fixed.
  useEffect(() => {
    const my = ++seq.current;
    if (!dirty || l.budget_error) { setPv(null); setPvState('idle'); return; }
    if (bad) { setPvState('idle'); return; }
    setPvState('loading');
    const t = setTimeout(() => {
      appApi<Preview>('POST', '/limits/preview', body)
        .then((r) => { if (my === seq.current) { setPv(r); setPvState('idle'); } }, () => { if (my === seq.current) setPvState('failed'); });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, dirty, bad, l]);

  const o: Picture = dirty && pv ? pv : l;
  const stale = dirty && (pvState !== 'idle' || bad || !pv);
  const changes = dirty ? pv?.changes ?? [] : [];
  const blockedNow = changes.filter((c) => c.blocked_now);
  const set = <K extends keyof RulesDraft>(k: K, v: RulesDraft[K]) => setF((x) => ({ ...x, [k]: v }));

  const save = (clear: boolean) => {
    setSaving(true);
    appApi('PUT', '/limits/plan', { ...body, clear_inactive: clear }, { 'If-Match': `"${l.version ?? '0'}"` })
      .then(async () => {
        toast.success("Rules saved. They apply to this month's spend now.");
        setReview(false); setConflict(false);
        const fresh = await reload();
        if (fresh) setF(draftOf(fresh as AdminLimits));
      })
      .catch((e) => { if (e instanceof ApiError && e.status === 409) { setReview(false); setConflict(true); } else fail(e); })
      .finally(() => setSaving(false));
  };
  // Someone else saved meanwhile: load their rules; the effect above puts this person's edits back on top.
  const rebaseOnLatest = async () => {
    await reload();
    setConflict(false);
  };
  const needsReview = !pv || pvState !== 'idle' || blockedNow.length > 0 || pv.over_by_usd > 0 || pv.inactive.length > 0 || pv.launch_access_stops > 0;
  const onSave = () => (needsReview ? setReview(true) : save(true));

  const end = Date.parse(l.period_end);
  const month = utcDate(end - 1, { month: 'long' });
  const noPeople = l.clerk === false || !l.members.length;
  return (
    <div className='flex flex-col gap-8 pb-4'>
      <header className='flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between'>
        <div className='flex flex-col gap-2'>
          <h2 className='text-base leading-none font-semibold'>Budget rules</h2>
          <p className='text-muted-foreground text-sm leading-none'>Changes apply right away to this month&apos;s spend.</p>
        </div>
        <div className='flex flex-col gap-2 text-xs leading-none sm:items-end'>
          <LastChanged l={l} />
          <span className='text-muted-foreground'>Month resets {utcDate(end, { month: 'short', day: 'numeric' })}, 00:00 UTC.</span>
        </div>
      </header>

      {l.budget_error && <Alert variant='destructive'><Icons.warning /><AlertDescription>We couldn&apos;t load your monthly allowance, so the preview is unavailable and saving is off. Try again in a minute.</AlertDescription></Alert>}
      <ShareNotice l={l} />
      {conflict && (
        <Alert variant='destructive'><Icons.warning />
          <AlertDescription className='flex flex-wrap items-center gap-x-3 gap-y-2'>
            Someone changed these rules while you were editing.
            <Button size='sm' variant='outline' onClick={() => void rebaseOnLatest()}>Reload and keep my edits</Button>
          </AlertDescription>
        </Alert>
      )}

      <Section title='This month'><MonthTiles l={l} /></Section>

      <Section title='Your policy'>
        <PolicySentences l={l} o={o} f={f} set={set} errors={errors} month={month} warnings={dirty ? pv?.warnings ?? [] : []} launchStops={dirty ? pv?.launch_access_stops ?? null : null} onTab={onTab} />
      </Section>

      <Section title='Run limits' note='These limit size and speed, not who gets which dollars.'>
        <RunLimits l={l} f={f} set={set} errors={errors} />
      </Section>

      <Section title='Exceptions'>
        <Exceptions l={l} resets={f.resets} setResets={(r) => set('resets', r)} onEditPerson={onEditPerson} onTab={onTab} />
      </Section>

      <Section title='Who gets what' note={!dirty ? undefined : pvState === 'loading' ? 'Updating…' : pvState === 'failed' ? 'Preview unavailable. Your edits are kept.' : bad ? 'Fix the fields marked in red to update this.' : 'Showing your unsaved changes'}>
        <Ledger o={o} onOpen={setOpenRow} />
        {noPeople
          ? <Alert><Icons.info /><AlertDescription>We can&apos;t load your people, so personal and team limits aren&apos;t being applied. Only the account allowance and run limits are.</AlertDescription></Alert>
          : <div className={cn('transition-opacity', stale && 'opacity-60')}><WhoGetsWhat l={l} o={o} changes={dirty ? changes : []} draftReserve={dirty} openRow={openRow} setOpenRow={setOpenRow} /></div>}
        {(l.unattributed_spent_usd ?? 0) > 0 && <p className='text-muted-foreground text-xs'>Not limited by these rules: connector keys ({usd(l.unattributed_spent_usd)} this month).</p>}
      </Section>

      {dirty && (
        <SaveBar pv={pv} pvState={pvState} bad={bad} blocked={blockedNow.map((c) => c.name || 'someone')} changes={changes} needsReview={needsReview}
          disabled={saving || bad || !!l.budget_error} onDiscard={() => { setF(base); setConflict(false); }} onSave={onSave} />
      )}
      {review && <ReviewDialog l={l} pv={pvState === 'idle' ? pv : null} loading={pvState === 'loading'} saving={saving} onClose={() => setReview(false)} onSave={save} />}
    </div>
  );
}

/**
 * The one-time notice for a change in meaning: equal shares now leave out people who can't launch. Shown in even mode
 * while someone's share is bigger for it (they share a budget with someone who can't launch), until dismissed (per browser).
 */
const SHARE_NOTICE = 'oct_budget_share_notice';
function ShareNotice({ l }: { l: AdminLimits }) {
  const [gone, setGone] = useState(() => { try { return localStorage.getItem(SHARE_NOTICE) === '1'; } catch { return false; } });
  const left = new Set(l.members.filter((m) => !m.can_run && m.cap_usd == null).map((m) => m.pot ?? null));
  const n = l.members.filter((m) => m.can_run && m.limit_source === 'share' && left.has(m.pot ?? null)).length;
  if (gone || l.policy.mode !== 'even' || !n) return null;
  const dismiss = () => { setGone(true); try { localStorage.setItem(SHARE_NOTICE, '1'); } catch { /* private mode */ } };
  return (
    <Alert><Icons.info />
      <AlertDescription className='flex flex-wrap items-center gap-x-3 gap-y-2'>
        Equal shares now count only people who can launch. Shares went up for {plural(n, 'person', 'people')}.
        <Button size='sm' variant='ghost' onClick={dismiss}>Dismiss</Button>
      </AlertDescription>
    </Alert>
  );
}

/** A titled part of the tab: a rule above, the label small and quiet, the page is the container (no cards). */
function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className='flex flex-col gap-4 border-t pt-5'>
      <div className='flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1'>
        <h3 className='text-muted-foreground text-xs leading-none font-medium tracking-wide uppercase'>{title}</h3>
        {note && <span className='text-muted-foreground text-xs leading-none'>{note}</span>}
      </div>
      {children}
    </section>
  );
}

/**
 * Runs, spent so far (live), running now, on pace for, left: one row of headline numbers, each with this month day by
 * day. The allowance itself is the first line of Your policy. On pace for follows the month's running total; Left is
 * the allowance less that running total.
 */
function MonthTiles({ l }: { l: AdminLimits }) {
  const cap = l.budget_usd, none = !l.budget_error && cap <= 0;
  const by = utcDate(Date.parse(l.period_end) - 1, { month: 'short', day: 'numeric' });
  const pace = l.projected_usd, m = l.month_daily;
  const runningTotal = m?.spent.reduce<number[]>((out, v) => [...out, (out[out.length - 1] ?? 0) + v], []);
  return (
    <StatStrip items={[
      { label: 'Runs this month', value: m ? num(m.runs.reduce((a, b) => a + b, 0)) : '—', spark: m?.runs },
      { label: 'Spent so far', value: usd(l.spent_live_usd), spark: m?.spent, hint: 'live' },
      { label: 'Running now', value: usd(l.in_flight_usd), spark: m?.running, hint: plural(l.running_count ?? 0, 'run') },
      { label: 'On pace for', value: pace == null ? <span className='text-muted-foreground text-base'>Too early to tell</span> : usd(pace), spark: runningTotal,
        hint: pace == null ? undefined : cap > 0 && pace > cap ? <span className='text-destructive'>over by {usd(pace - cap)}</span> : `by ${by}` },
      { label: 'Left', value: l.budget_error || none ? '—' : usd(l.left_usd ?? 0), spark: l.budget_error || none ? undefined : runningTotal?.map((v) => Math.max(0, cap - v)) }
    ]} />
  );
}

/** One rule written as a sentence, its control inline (on its own line on phones), and what to know under it. */
function Sentence({ children, hint, error, warn, aside }: { children: React.ReactNode; hint?: React.ReactNode; error?: string; warn?: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className='flex flex-col gap-1.5'>
      <div className='flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm'>{children}{aside && <span className='text-muted-foreground text-xs sm:ml-auto'>{aside}</span>}</div>
      {error && <p className='text-destructive text-xs'>{error}</p>}
      {warn && <p className='text-xs text-amber-600 dark:text-amber-500'>{warn}</p>}
      {hint && <p className='text-muted-foreground text-xs'>{hint}</p>}
    </div>
  );
}

function MoneyInput({ value, onChange, label, placeholder, error, disabled }: { value: string; onChange: (v: string) => void; label: string; placeholder?: string; error?: boolean; disabled?: boolean }) {
  return (
    <span className='relative inline-flex w-full sm:w-36'>
      <span className='text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm'>$</span>
      <Input type='number' inputMode='decimal' min={0} step={0.01} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} aria-invalid={error || undefined}
        placeholder={placeholder} disabled={disabled} className='h-8 pl-6 tabular-nums' />
    </span>
  );
}

function CountInput({ value, onChange, label, placeholder, error }: { value: string; onChange: (v: string) => void; label: string; placeholder?: string; error?: boolean }) {
  return <Input type='number' inputMode='numeric' min={1} step={1} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} aria-invalid={error || undefined}
    placeholder={placeholder} className='h-8 w-full tabular-nums sm:w-28' />;
}

type SetDraft = <K extends keyof RulesDraft>(k: K, v: RulesDraft[K]) => void;

/** P1–P6: the allowance, the buffer, team budgets, what everyone else shares, how people share a budget, who can launch. */
function PolicySentences({ l, o, f, set, errors, month, warnings, launchStops, onTab }: { l: AdminLimits; o: Picture; f: RulesDraft; set: SetDraft; errors: Record<string, string>; month: string;
  warnings: Warning[]; launchStops: number | null; onTab: (tab: 'people' | 'teams', filter?: PeopleFilter) => void }) {
  const cap = l.budget_usd, none = !l.budget_error && cap <= 0;
  const free = l.teams.filter((t) => !f.budgets.some(([id]) => id === t.id));
  const setBudget = (i: number, row: [number, string] | null) => set('budgets', row ? f.budgets.map((x, j) => (j === i ? row : x)) : f.budgets.filter((_, j) => j !== i));
  const R = o.rest.budget_usd, one = o.members.length === 1;
  const mode = MODE_OPTIONS.find((m) => m.id === f.mode)!;
  // "Today: Platform $25.00 each (4) · Everyone else $24.00 each (5)", from the preview (the server's allocate()).
  const pots = [...o.teams.filter((t) => t.budget_usd != null).map((t) => ({ name: t.name, each: t.each_usd, n: t.launchers })), { name: f.budgets.length ? 'Everyone else' : 'Everyone', each: o.rest.each_usd, n: o.rest.launchers }];
  const today = f.mode === 'pool' ? null : pots.filter((p) => p.n > 0).map((p) => `${p.name} ${usd(p.each ?? 0)} each (${p.n})`).join(' · ');
  const allowed = l.members.filter((m) => m.own_can_run === true).length;
  const exceeds = warnings.filter((w) => w.code === 'set_amount_exceeds_budget').map((w) => w.message);
  return (
    <div className='flex flex-col gap-5'>
      {l.budget_error ? <Sentence>This account&apos;s monthly allowance couldn&apos;t be loaded.</Sentence>
        : none ? <Sentence>This account has <strong>no prepaid allowance</strong> this month, so nobody can launch. Contact Octillion to add one.</Sentence>
        : <Sentence aside={<span title='Your prepaid monthly allowance. Contact Octillion to change it.'>(set by Octillion)</span>}><span>This account can spend <strong className='tabular-nums'>{usd(cap)}</strong> in {month}.</span></Sentence>}

      <Sentence error={errors.reserve} hint='Nobody can launch into this. It absorbs runs that finish past a limit.'>
        Hold back <MoneyInput label='Buffer' value={f.reserve} onChange={(v) => set('reserve', v)} placeholder='0.00' error={!!errors.reserve} /> as a buffer for runs that go over.
      </Sentence>

      {f.budgets.map(([id, amount], i) => {
        const t = o.teams.find((x) => x.id === id), name = l.teams.find((x) => x.id === id)?.name ?? 'This team';
        const zero = amount.trim() !== '' && Number(amount) === 0;
        return (
          <Sentence key={id} error={errors[`team:${id}`]}
            warn={t && t.members === 0 && amount.trim() !== '' ? `No one is in ${name}, so this ${usd(Number(amount))} sits unused.` : undefined}
            hint={zero && t?.members ? 'Its people can\'t launch.' : undefined}>
            <NativeSelect value={String(id)} onChange={(e) => setBudget(i, [Number(e.target.value), amount])} aria-label='Team' className='w-full sm:w-44'>
              {[l.teams.find((x) => x.id === id)!, ...free].filter(Boolean).map((x) => <NativeSelectOption key={x.id} value={String(x.id)}>{x.name}</NativeSelectOption>)}
            </NativeSelect>
            gets <MoneyInput label={`${name} budget`} value={amount} onChange={(v) => setBudget(i, [id, v])} error={!!errors[`team:${id}`]} /> this month.
            <Button variant='ghost' size='sm' className='ml-auto' aria-label={`Remove ${name}'s budget`} onClick={() => setBudget(i, null)}>
              <Icons.trash className='sm:hidden' /><span className='hidden sm:inline'>Remove</span>
            </Button>
          </Sentence>
        );
      })}
      {!l.teams.length
        ? <Sentence>No teams yet. <button type='button' className='underline underline-offset-4' onClick={() => onTab('teams')}>Create one on Teams →</button> to give a group its own budget.</Sentence>
        : free.length > 0 && (
          <NativeSelect value='' onChange={(e) => e.target.value && set('budgets', [...f.budgets, [Number(e.target.value), '']])} aria-label='Give a team its own budget' className='w-full sm:w-72'>
            <NativeSelectOption value=''>+ Give {f.budgets.length ? 'another' : 'a'} team its own budget</NativeSelectOption>
            {free.map((x) => <NativeSelectOption key={x.id} value={String(x.id)}>{x.name}</NativeSelectOption>)}
          </NativeSelect>
        )}

      <Sentence error={o.over_by_usd > 0 ? `Team budgets and the buffer are ${usd(o.over_by_usd)} more than your allowance.` : undefined}>
        <span>{one ? 'You can spend' : f.budgets.length ? 'Everyone else shares the remaining' : 'Everyone shares'} <strong className='tabular-nums'>{usd(R)}</strong>.</span>
      </Sentence>

      <Sentence hint={one ? undefined : <>{mode.hint}{today && <span className='mt-1 block'>Today: {today}</span>}</>}>
        Inside each budget, people
        <NativeSelect value={f.mode} onChange={(e) => set('mode', e.target.value as Mode)} aria-label='How people share a budget' className='w-full sm:w-72'>
          {MODE_OPTIONS.map((m) => <NativeSelectOption key={m.id} value={m.id}>{m.label}</NativeSelectOption>)}
        </NativeSelect>
      </Sentence>
      {f.mode === 'custom' && (
        <Sentence error={errors.defaultCap} warn={exceeds.length ? exceeds.join(' ') : undefined}>
          Each person can spend up to <MoneyInput label='Each person can spend up to' value={f.defaultCap} onChange={(v) => set('defaultCap', v)} error={!!errors.defaultCap} /> a month.
        </Sentence>
      )}

      <Sentence
        hint={!f.newRun ? <>{plural(allowed, 'person is', 'people are')} allowed individually. <button type='button' className='underline underline-offset-4' onClick={() => onTab('people')}>Allow people on People →</button></> : undefined}
        warn={!f.newRun && l.policy.new_members_can_run && launchStops ? `This stops ${plural(launchStops, 'person', 'people')} who haven't been allowed individually, including people already here.` : undefined}>
        <NativeSelect value={f.newRun ? 'all' : 'allowed'} onChange={(e) => set('newRun', e.target.value === 'all')} aria-label='Who can launch' className='w-full sm:w-60'>
          <NativeSelectOption value='all'>Everyone on the account</NativeSelectOption>
          <NativeSelectOption value='allowed'>Only people I&apos;ve allowed</NativeSelectOption>
        </NativeSelect>
        can launch simulations.
      </Sentence>
    </div>
  );
}

/** R1–R3: runs at once per person, agent sessions per simulation, and the most one simulation can spend. */
function RunLimits({ l, f, set, errors }: { l: AdminLimits; f: RulesDraft; set: SetDraft; errors: Record<string, string> }) {
  const own = l.members.filter((m) => m.max_concurrent_runs != null).length + l.teams.filter((t) => t.max_concurrent_runs != null).length;
  const max = l.server_max_sessions;
  const runUsd = f.runUsd.trim() === '' ? null : Number(f.runUsd);
  return (
    <div className='flex flex-col gap-5'>
      <Sentence error={errors.conc} hint={`Counts whole simulations, not agent sessions. Teams and people can set their own; the most specific one wins.${own ? ` (${own} do)` : ''}`}>
        Each person can have <CountInput label='Simulations running at once' value={f.conc} onChange={(v) => set('conc', v)} placeholder='no limit' error={!!errors.conc} /> simulations running at once.
      </Sentence>
      <Sentence error={errors.sess} aside={max ? `Octillion's maximum is ${max}.` : undefined} hint='Applies to every batch, including adaptive runs.'>
        Each simulation can use up to <CountInput label='Agent sessions per simulation' value={f.sess} onChange={(v) => set('sess', v)} placeholder={max ? String(max) : undefined} error={!!errors.sess} /> agent sessions.
      </Sentence>
      <Sentence error={errors.runUsd}
        warn={runUsd != null && l.avg_session_usd != null && runUsd < l.avg_session_usd ? runEstimate(runUsd, l.avg_session_usd) : undefined}
        hint={<>Adaptive runs stop adding sessions once a run reaches this. Sessions already running finish.{!(runUsd != null && l.avg_session_usd != null && runUsd < l.avg_session_usd) && <span className='mt-1 block'>{runEstimate(runUsd, l.avg_session_usd)}</span>}</>}>
        Each simulation can spend up to <MoneyInput label='Most a simulation can spend' value={f.runUsd} onChange={(v) => set('runUsd', v)} placeholder='no limit' error={!!errors.runUsd} />
      </Sentence>
    </div>
  );
}

/** People and teams with their own settings. Reset is part of the draft (it shows in the preview and saves with the rest). */
function Exceptions({ l, resets, setResets, onEditPerson, onTab }: { l: AdminLimits; resets: string[]; setResets: (r: string[]) => void; onEditPerson: (userId: string) => void; onTab: (tab: 'people' | 'teams', filter?: PeopleFilter) => void }) {
  const [all, setAll] = useState(false);
  const people = l.members.flatMap((m) => {
    const words = exceptionWords(m, l.policy);
    return words.length ? [{ m, words }] : [];
  });
  const teams = l.teams.filter((t) => t.max_concurrent_runs != null);
  if (!people.length && !teams.length) return <p className='text-muted-foreground text-sm'>Nobody has their own settings.</p>;
  const shown = all ? people : people.slice(0, 5);
  const heading = [people.length ? plural(people.length, 'person', 'people') : '', teams.length ? plural(teams.length, 'team') : ''].filter(Boolean).join(' and ');
  return (
    <div className='flex flex-col gap-3'>
      <p className='text-sm'>{heading} {people.length + teams.length === 1 ? 'has' : 'have'} their own settings.</p>
      <ul className='flex flex-col divide-y border-y'>
        {shown.map(({ m, words }) => {
          const reset = resets.includes(m.user_id);
          return (
            <li key={m.user_id} className='flex flex-col gap-2 py-3 text-sm sm:flex-row sm:items-center sm:gap-4'>
              <span className='font-medium sm:w-48 sm:truncate'>{m.name || m.email || m.user_id}</span>
              <span className={cn('flex-1', reset && 'text-muted-foreground line-through')}>{words.join(' · ')}{m.cap_usd != null && <span className='text-muted-foreground'> · spent {usd(m.spent)}</span>}</span>
              <span className='flex flex-wrap items-center gap-2'>
                {reset
                  ? <><span className='text-muted-foreground text-xs'>Resets when you save</span><Button variant='ghost' size='sm' onClick={() => setResets(resets.filter((x) => x !== m.user_id))}>Undo</Button></>
                  : <Button variant='secondary' size='sm' onClick={() => setResets([...resets, m.user_id])}>Reset to default</Button>}
                <Button variant='link' size='sm' className='px-0' onClick={() => onEditPerson(m.user_id)}>Edit on People →</Button>
              </span>
            </li>
          );
        })}
        {teams.map((t) => (
          <li key={`t${t.id}`} className='flex flex-col gap-2 py-3 text-sm sm:flex-row sm:items-center sm:gap-4'>
            <span className='font-medium sm:w-48 sm:truncate'>{t.name} team</span>
            <span className='flex-1'>{plural(t.max_concurrent_runs!, 'run')} at once per person</span>
            <Button variant='link' size='sm' className='self-start px-0 sm:self-auto' onClick={() => onTab('teams')}>Edit on Teams →</Button>
          </li>
        ))}
      </ul>
      {people.length > 5 && (
        <p className='text-muted-foreground text-xs'>
          {all ? <button type='button' className='underline underline-offset-4' onClick={() => setAll(false)}>Show fewer</button>
            : <><button type='button' className='underline underline-offset-4' onClick={() => setAll(true)}>+{people.length - 5} more</button> · <button type='button' className='underline underline-offset-4' onClick={() => onTab('people', 'exceptions')}>See all on People →</button></>}
        </p>
      )}
    </div>
  );
}

/** The cap as one bar: the buffer, each team budget and everyone else, spent (solid) and running now (lighter) inside each. */
function Ledger({ o, onOpen }: { o: Picture; onOpen: (id: string) => void }) {
  const cap = o.budget_usd;
  const segs = [
    ...(o.buffer_usd > 0 ? [{ id: 'buffer', label: 'Buffer', usd: o.buffer_usd, spent: 0, running: 0, c: BUFFER_SEG }] : []),
    ...o.teams.filter((t) => t.budget_usd != null && t.budget_usd > 0).map((t, i) => ({ id: `team:${t.id}`, label: t.name, usd: t.budget_usd!, spent: t.spent, running: t.in_flight_usd, c: SEG[i % SEG.length]! })),
    ...(o.rest.budget_usd > 0 ? [{ id: 'rest', label: !o.rest.members ? 'Not set aside' : o.policy.mode === 'pool' ? 'Everyone else (shared, no personal limits)' : 'Everyone else',
      usd: o.rest.budget_usd, spent: o.rest.spent, running: o.rest.in_flight_usd, c: REST_SEG }] : [])
  ];
  if (cap <= 0 && !o.set_aside_usd)
    return <div className='flex items-center gap-3'><div className='bg-muted h-3 flex-1 rounded-full' /><Badge variant='outline'>No allowance</Badge></div>;
  // Never clipped: past the allowance the bar goes on in red, beyond a solid line where the allowance ends.
  const scale = Math.max(cap, o.set_aside_usd), pct = (v: number) => `${(Math.max(0, v) / scale) * 100}%`;
  return (
    <div className='flex flex-col gap-3'>
      <div className='relative'>
        <div className='flex h-4 overflow-hidden rounded-sm'>
          {segs.map((s) => {
            const done = Math.min(s.usd, Math.max(0, s.spent - s.running)), run = Math.min(s.usd - done, s.running);
            return (
              <button key={s.id} type='button' onClick={() => onOpen(s.id)} aria-label={`${s.label}: ${usd(s.usd)}`} title={`${s.label}: ${usd(s.usd)}${s.id === 'buffer' ? '' : ` · ${usd(s.spent)} spent`}`}
                className={cn('flex h-full border-r-2 border-background last:border-r-0', s.c.base)} style={{ width: pct(s.usd) }}>
                <span className={cn('h-full', s.c.fill)} style={{ width: `${(done / s.usd) * 100}%` }} />
                <span className={cn('h-full', s.c.run)} style={{ width: `${(run / s.usd) * 100}%` }} />
              </button>
            );
          })}
        </div>
        {/* The segments already add up to the set-aside total, so the excess is the part past the allowance, shaded over them. */}
        {o.over_by_usd > 0 && <div className='bg-destructive/50 pointer-events-none absolute inset-y-0 right-0 rounded-r-sm' style={{ left: pct(cap) }} title={`${usd(o.over_by_usd)} more than your allowance`} />}
        {o.over_by_usd > 0 && <div className='bg-foreground absolute -top-1 -bottom-1 w-0.5' style={{ left: `calc(${pct(cap)} - 1px)` }} aria-hidden />}
      </div>
      <ul className='text-muted-foreground flex flex-col gap-1.5 text-xs leading-none sm:flex-row sm:flex-wrap sm:gap-x-5'>
        {segs.map((s) => (
          <li key={s.id}><button type='button' className='hover:text-foreground flex items-center gap-1.5' onClick={() => onOpen(s.id)}>
            <span className={cn('size-2 rounded-full', s.c.fill)} />{s.label} <span className='text-foreground tabular-nums'>{usd(s.usd)}</span>
          </button></li>
        ))}
        <li className='flex items-center gap-1.5'>Solid: spent (live) · lighter: running now</li>
      </ul>
      {o.over_by_usd > 0 && <p className='text-destructive text-sm'>That&apos;s {usd(o.over_by_usd)} more than your {usd(cap)} allowance. Lower a team budget or the buffer.</p>}
    </div>
  );
}

interface BudgetRow { id: string; name: string; count: number | null; each: React.ReactNode; spent: number | null; left: number | null; limited: string | null; change: string | null; people: LimitMember[] }

/** Budgets and the people in each: what each person can spend, spent (live), left, what limits them, what the draft changes. */
function WhoGetsWhat({ l, o, changes, draftReserve, openRow, setOpenRow }: { l: AdminLimits; o: Picture; changes: PreviewChange[]; draftReserve: boolean; openRow: string | null; setOpenRow: (id: string | null) => void }) {
  const was = (a: number | null | undefined, b: number | null | undefined, each = false) => (a === b || !draftReserve ? null : `was ${a == null ? (each ? 'shared' : 'none') : usd(a)}`);
  const each = (v: number | null) => (o.policy.mode === 'pool' ? <span className='text-muted-foreground'>Shared</span> : usd(v ?? 0));
  const rows: BudgetRow[] = [
    ...(o.buffer_usd > 0 || l.buffer_usd > 0 ? [{ id: 'buffer', name: 'Buffer', count: null, each: '—', spent: null, left: o.buffer_usd, limited: null, change: was(l.buffer_usd, o.buffer_usd), people: [] }] : []),
    ...o.teams.filter((t) => t.budget_usd != null).map((t) => {
      const saved = l.teams.find((x) => x.id === t.id);
      return { id: `team:${t.id}`, name: t.name, count: t.members, each: each(t.each_usd), spent: t.spent, left: t.left_usd, limited: limitedWord(t.limited_by, o.teams, t.id),
        change: was(saved?.budget_usd, t.budget_usd), people: o.members.filter((m) => m.pot === t.id) };
    }),
    { id: 'rest', name: o.teams.some((t) => t.budget_usd != null) ? 'Everyone else' : 'Everyone', count: o.rest.members, each: each(o.rest.each_usd), spent: o.rest.spent,
      left: o.rest.left_usd, limited: limitedWord(o.rest.limited_by, o.teams), change: o.policy.mode === 'pool' || l.policy.mode === 'pool' ? was(l.rest.budget_usd, o.rest.budget_usd) : was(l.rest.each_usd, o.rest.each_usd, true),
      people: o.members.filter((m) => m.pot == null) }
  ];
  const byUser = new Map(changes.map((c) => [c.user_id, c]));
  const toggle = (id: string) => setOpenRow(openRow === id ? null : id);
  return (<>
    <div className='hidden sm:block'>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Budget</TableHead><TableHead className='w-20'>People</TableHead><TableHead className='w-48'>Each person can spend</TableHead>
            <TableHead className='w-28'>Spent (live)</TableHead><TableHead className='w-28'>Left</TableHead><TableHead className='w-40'>Limited by</TableHead><TableHead className='w-40'>Change</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (<RowGroup key={r.id} r={r} o={o} open={openRow === r.id} toggle={() => toggle(r.id)} byUser={byUser} />))}
        </TableBody>
      </Table>
    </div>
    <ul className='flex flex-col gap-2 sm:hidden'>
      {rows.map((r) => (
        <li key={r.id} className='rounded-lg border'>
          <button type='button' className='flex w-full flex-col gap-2 p-3 text-left text-sm' onClick={() => r.people.length && toggle(r.id)} aria-expanded={openRow === r.id}>
            <span className='flex items-center justify-between gap-2 font-medium'>{r.name}{r.count != null && <span className='text-muted-foreground text-xs font-normal'>{plural(r.count, 'person', 'people')}</span>}</span>
            <span className='text-muted-foreground grid grid-cols-3 gap-2 text-xs'>
              <span>Each<span className='text-foreground block tabular-nums'>{r.each}</span></span>
              <span>Spent<span className='text-foreground block tabular-nums'>{r.spent == null ? '—' : usd(r.spent)}</span></span>
              <span>Left<span className='text-foreground block tabular-nums'>{r.left == null ? '—' : usd(r.left)}</span></span>
            </span>
            {(r.limited || r.change) && <span className='flex flex-wrap gap-1.5'>{r.limited && <Badge variant='outline'>Limited by {r.limited}</Badge>}{r.change && <Badge variant='secondary'>{r.change}</Badge>}</span>}
          </button>
          {openRow === r.id && (
            <ul className='divide-y border-t'>
              {r.people.map((m) => <li key={m.user_id} className='flex flex-col gap-1.5 px-3 py-2.5 text-sm'><PersonCells m={m} o={o} c={byUser.get(m.user_id)} stacked /></li>)}
            </ul>
          )}
        </li>
      ))}
    </ul>
  </>);
}

const PEOPLE_SHOWN = 8;

function RowGroup({ r, o, open, toggle, byUser }: { r: BudgetRow; o: Picture; open: boolean; toggle: () => void; byUser: Map<string, PreviewChange> }) {
  const [all, setAll] = useState(false);
  const people = all ? r.people : r.people.slice(0, PEOPLE_SHOWN);
  return (<>
    <TableRow className={cn(r.people.length && 'cursor-pointer')} onClick={() => r.people.length && toggle()}>
      <TableCell className='font-medium'>
        <span className='flex items-center gap-1.5'>
          {r.people.length ? (open ? <Icons.chevronDown className='size-4' /> : <Icons.chevronRight className='size-4' />) : <span className='size-4' />}{r.name}
        </span>
      </TableCell>
      <TableCell className='tabular-nums'>{r.count ?? '—'}</TableCell>
      <TableCell className='tabular-nums'>{r.each}</TableCell>
      <TableCell className='tabular-nums'>{r.spent == null ? '—' : usd(r.spent)}</TableCell>
      <TableCell className='tabular-nums'>{r.left == null ? '—' : usd(r.left)}</TableCell>
      <TableCell>{r.limited ?? <span className='text-muted-foreground'>—</span>}</TableCell>
      <TableCell className='text-muted-foreground text-xs'>{r.change ?? '—'}</TableCell>
    </TableRow>
    {open && people.map((m) => {
      const c = byUser.get(m.user_id);
      const word = limitedWord(m.limited_by, o.teams, m.team_id);
      return (
        <TableRow key={m.user_id} className='bg-muted/30' title={word ? `Limited by: ${word}${m.left_usd != null ? ` (${usd(m.left_usd)} left)` : ''}` : undefined}>
          <PersonCells m={m} o={o} c={c} />
        </TableRow>
      );
    })}
    {open && r.people.length > PEOPLE_SHOWN && (
      <TableRow className='bg-muted/30'><TableCell colSpan={7} className='pl-10'>
        <button type='button' className='text-muted-foreground hover:text-foreground text-xs underline underline-offset-4' onClick={() => setAll(!all)}>{all ? 'Show fewer' : `… ${r.people.length - PEOPLE_SHOWN} more`}</button>
      </TableCell></TableRow>
    )}
  </>);
}

/** One person under a budget: as table cells, or stacked (phones) with what limits them and the change as chips. */
function PersonCells({ m, o, c, stacked }: { m: LimitMember; o: Picture; c: PreviewChange | undefined; stacked?: boolean }) {
  const limit = !m.can_run ? '—' : m.limit_usd == null ? 'Shared' : usd(m.limit_usd);
  const near = m.limit_usd != null && m.limit_usd > 0 && !m.blocked && m.spent >= 0.8 * m.limit_usd;
  const word = limitedWord(m.limited_by, o.teams, m.team_id);
  const change = c && !c.blocked_now && c.before !== c.after ? `was ${c.before == null ? 'shared' : usd(c.before)}` : null;
  const chips = (
    <span className='flex flex-wrap gap-1.5'>
      {c?.blocked_now && <Badge variant='destructive'>Blocked now</Badge>}
      {!m.can_run && <Badge variant='outline'>Can&apos;t launch</Badge>}
      {near && <Badge variant='outline' className='border-amber-500/50 text-amber-700 dark:text-amber-400'>Near limit</Badge>}
      {m.limit_source === 'own' && <Badge variant='secondary'>Own limit</Badge>}
    </span>
  );
  const name = m.name || m.email || m.user_id;
  if (stacked) return (<>
    <span className='flex items-center justify-between gap-2'><span className='font-medium'>{name}</span><span className='tabular-nums'>{limit}</span></span>
    <span className='text-muted-foreground text-xs tabular-nums'>{usd(m.spent)} spent · {m.left_usd == null ? 'no limit' : `${usd(m.left_usd)} left`}</span>
    <span className='flex flex-wrap gap-1.5'>{chips}{word && m.limited_by !== 'launch_access' && <Badge variant='outline'>Limited by {word}</Badge>}{change && <Badge variant='secondary'>{change}</Badge>}</span>
  </>);
  return (<>
    <TableCell className='pl-10'><span className='flex flex-wrap items-center gap-2'>{name}{chips}</span></TableCell>
    <TableCell />
    <TableCell className='tabular-nums'>{limit}{m.limit_source === 'own' && <span className='text-muted-foreground text-xs'> (own limit)</span>}</TableCell>
    <TableCell className='tabular-nums'>{usd(m.spent)}</TableCell>
    <TableCell className='tabular-nums'>{m.left_usd == null ? '—' : usd(m.left_usd)}</TableCell>
    <TableCell>{word ?? <span className='text-muted-foreground'>—</span>}</TableCell>
    <TableCell className='text-muted-foreground text-xs'>{change ?? '—'}</TableCell>
  </>);
}

/** Pinned to the bottom while the draft is unsaved: what it changes, who it blocks, and Save (straight away when it is harmless). */
function SaveBar({ pv, pvState, bad, blocked, changes, needsReview, disabled, onDiscard, onSave }: { pv: Preview | null; pvState: 'idle' | 'loading' | 'failed'; bad: boolean; blocked: string[];
  changes: PreviewChange[]; needsReview: boolean; disabled: boolean; onDiscard: () => void; onSave: () => void }) {
  const down = changes.filter((c) => c.after != null && (c.before == null || c.after < c.before)).length;
  const parts = pv?.summary ?? [];
  const fields = parts.slice(0, 2).join('; ') + (parts.length > 2 ? ` +${parts.length - 2} more` : '');
  const line = bad ? 'Fix the fields marked in red to save.' : pvState === 'failed' ? 'Preview unavailable. Your edits are kept.' : !pv ? 'Updating…'
    : [fields || 'Unsaved changes', down ? `${plural(down, "person's limit goes", "people's limits go")} down` : '', blocked.length ? `${blocked.length} blocked right away (${names(blocked)})` : ''].filter(Boolean).join(' · ');
  const extra = pv && pvState === 'idle' ? [
    ...(pv.launch_access_stops ? [`Launch access: this stops ${plural(pv.launch_access_stops, 'person', 'people')} who haven't been allowed individually.`] : []),
    ...(pv.inactive.length ? [`${plural(pv.inactive.length, 'adjustment')} only ${pv.inactive.length === 1 ? 'applies' : 'apply'} with 'equal share'. You choose what happens in Review.`] : [])
  ] : [];
  return (
    <div className='bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky bottom-0 z-10 -mx-4 border-t px-4 py-3 backdrop-blur md:-mx-6 md:px-6'>
      <div className='hidden items-center gap-4 sm:flex'>
        <div className='flex min-w-0 flex-1 flex-col gap-1 text-sm'>
          <span className={cn('truncate', blocked.length && 'text-destructive')}>{line}</span>
          {extra.map((x) => <span key={x} className='text-muted-foreground truncate text-xs'>{x}</span>)}
        </div>
        <Button variant='outline' onClick={onDiscard}>Discard</Button>
        <Button disabled={disabled} onClick={onSave}>{needsReview ? 'Review and save' : 'Save rules'}</Button>
      </div>
      <div className='flex items-center gap-2 sm:hidden'>
        <span className={cn('flex-1 text-sm', blocked.length && 'text-destructive')}>{bad ? 'Fix the fields marked in red' : `${plural(parts.length || 1, 'change')}${blocked.length ? ` · ${blocked.length} blocked` : ''}`}</span>
        <ActionsMenu label='More' items={[{ label: 'Discard changes', icon: <Icons.close />, onSelect: onDiscard }]} />
        <Button disabled={disabled} onClick={onSave}>Review</Button>
      </div>
    </div>
  );
}

/** Before a save that blocks someone, goes over the allowance or could not be previewed: the changes, who they affect, and a checkbox. */
function ReviewDialog({ l, pv, loading, saving, onClose, onSave }: { l: AdminLimits; pv: Preview | null; loading: boolean; saving: boolean; onClose: () => void; onSave: (clear: boolean) => void }) {
  const [ok, setOk] = useState(false);
  const [clear, setClear] = useState(true);
  const blocked = pv?.changes.filter((c) => c.blocked_now) ?? [];
  const over = pv?.over_by_usd ?? 0;
  const outside = pv ? pv.rest.members : 0;
  const ask = loading ? null : !pv ? "I understand I'm saving without seeing who this affects."
    : blocked.length ? `I understand ${plural(blocked.length, 'person', 'people')} will be blocked right away.`
    : over > 0 ? `I understand this is ${usd(over)} more than the allowance${outside && pv.rest.budget_usd === 0 ? ` and ${plural(outside, 'person', 'people')} outside teams get $0` : ''}.` : null;
  // A tick is for the sentence it was ticked against: when the preview arrives or changes, it asks again.
  useEffect(() => setOk(false), [ask]);
  const who = new Map(l.members.map((m) => [m.user_id, m.name || m.email || m.user_id]));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>Review changes</DialogTitle>
          <DialogDescription>They apply to this month&apos;s spend as soon as you save.</DialogDescription>
        </DialogHeader>
        <div className='flex max-h-[60vh] flex-col gap-4 overflow-y-auto text-sm'>
          {loading ? <p className='text-muted-foreground'>Working out who this affects…</p>
            : !pv ? <Alert><Icons.info /><AlertDescription>Preview unavailable, so we can&apos;t show who this affects. Your edits are kept.</AlertDescription></Alert> : (<>
            <div className='flex flex-col gap-1.5'>
              <p className='font-medium'>Changes</p>
              <ul className='text-muted-foreground flex list-disc flex-col gap-1 pl-5'>{(pv.summary.length ? pv.summary : ['Nothing changes in the rules themselves.']).map((s) => <li key={s}>{s}</li>)}</ul>
            </div>
            {pv.changes.length > 0 && (
              <div className='flex flex-col gap-1.5'>
                <p className='font-medium'>Who this affects</p>
                <ul className='divide-y border-y'>
                  {pv.changes.map((c) => (
                    <li key={c.user_id} className='flex flex-wrap items-center gap-x-3 gap-y-1 py-2'>
                      <span className='flex-1'>{c.name || c.user_id}</span>
                      <span className='text-muted-foreground text-xs tabular-nums'>{c.before == null ? 'shared' : usd(c.before)} → {c.after == null ? 'shared' : usd(c.after)} · {usd(c.spent)} spent</span>
                      {c.blocked_now && <Badge variant='destructive'>Blocked now</Badge>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {pv.launch_access_stops > 0 && <p>This stops {plural(pv.launch_access_stops, 'person', 'people')} who haven&apos;t been allowed individually, including people already here.</p>}
            {pv.inactive.length > 0 && (
              <div className='flex flex-col gap-2'>
                <p className='font-medium'>Adjustments that won&apos;t apply</p>
                <p className='text-muted-foreground'>{pv.inactive.map((x) => `${who.get(x.user_id) ?? 'Someone'}'s ${x.value > 0 ? '+' : '−'}${usd(Math.abs(x.value))}`).join(', ')} only {pv.inactive.length === 1 ? 'applies' : 'apply'} with &apos;equal share&apos;.</p>
                <NativeSelect value={clear ? 'clear' : 'keep'} onChange={(e) => setClear(e.target.value === 'clear')} aria-label='What happens to adjustments' className='w-full'>
                  <NativeSelectOption value='clear'>Clear them</NativeSelectOption>
                  <NativeSelectOption value='keep'>Keep them for later</NativeSelectOption>
                </NativeSelect>
              </div>
            )}
          </>)}
          {ask && <label className='flex items-start gap-2 leading-snug'><Checkbox checked={ok} onCheckedChange={(v) => setOk(Boolean(v))} className='mt-0.5' />{ask}</label>}
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={onClose}>Keep editing</Button>
          <Button variant={blocked.length ? 'destructive' : 'default'} disabled={saving || loading || (!!ask && !ok)} onClick={() => onSave(clear)}>
            {saving ? 'Saving…' : blocked.length ? `Save and block ${blocked.length}` : 'Save rules'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Oct 12, 14:03 UTC": history times are UTC, like the month the budget runs on. */
const utcTime = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }) + ' UTC';

/** "Last changed by {name}, {when} · History"; History opens the account's change log, one sentence per save. */
function LastChanged({ l }: { l: Limits }) {
  const [open, setOpen] = useState(false);
  const c = l.last_change;
  return (
    <>
      <span className='text-muted-foreground text-xs leading-none'>
        {c ? <>Last changed by {c.by_name}, {utcTime(c.at)} · <button type='button' className='hover:text-foreground underline underline-offset-4' onClick={() => setOpen(true)}>History</button></>
          : "Using Octillion's default rules"}
      </span>
      {open && <History onClose={() => setOpen(false)} />}
    </>
  );
}

function History({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<Change[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const page = (before?: number) => {
    setBusy(true);
    appApi<{ entries: Change[]; next_before: number | null }>('GET', `/limits/history${before ? `?before=${before}` : ''}`)
      .then((r) => { setEntries((e) => [...(before ? e ?? [] : []), ...r.entries]); setNext(r.next_before); }).catch(fail).finally(() => setBusy(false));
  };
  useEffect(() => page(), []);
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side='right' className='gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-lg'>
        <SheetHeader className='border-b'>
          <SheetTitle>Budget rules history</SheetTitle>
          <SheetDescription>Every change to budgets, teams and people's limits, newest first. Times are UTC.</SheetDescription>
        </SheetHeader>
        <div className='min-h-0 flex-1 overflow-y-auto px-4 py-2'>
          {!entries ? <p className='text-muted-foreground py-4 text-sm'>Loading…</p>
            : !entries.length ? <p className='text-muted-foreground py-4 text-sm'>No changes yet.</p>
            : <ol className='divide-y'>
                {entries.map((e) => (
                  <li key={e.id} className='flex flex-col gap-1 py-3 text-sm'>
                    <span className='text-muted-foreground text-xs'>{utcTime(e.at)} · {e.by_name}</span>
                    <span>{e.summary}</span>
                  </li>
                ))}
              </ol>}
          {next && <Button variant='outline' size='sm' className='my-3' disabled={busy} onClick={() => page(next)}>{busy ? 'Loading…' : 'Show older'}</Button>}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Teams as one full table: budget used against the team cap, what is left, runs at once, people. Add, edit and delete (admins). */
function Teams({ l, reload }: { l: Limits; reload: () => void }) {
  const [edit, setEdit] = useState<{ id: number | null; name: string; budget: string; conc: string; was?: { name: string; budget: string; conc: string } } | null>(null);
  const [removing, setRemoving] = useState<LimitTeam | null>(null);
  const manage = l.can_manage;
  const save = (e: React.FormEvent) => {
    e.preventDefault(); if (!edit) return;
    // An edit sends only what changed, so a rename can't put back a budget someone saved on Budget rules meanwhile.
    const w = edit.was;
    const body = { ...(!w || edit.name !== w.name ? { name: edit.name } : {}), ...(!w || edit.budget !== w.budget ? { budget_usd: orNull(edit.budget) } : {}),
      ...(!w || edit.conc !== w.conc ? { max_concurrent_runs: orNull(edit.conc) } : {}) };
    (edit.id == null ? appApi('POST', '/limits/teams', body) : appApi('PUT', `/limits/teams/${edit.id}`, body))
      .then(() => { setEdit(null); toast.success(edit.id == null ? 'Team added' : 'Team saved'); reload(); }).catch(fail);
  };
  const cols: RecordCol<LimitTeam>[] = [
    { key: 'team', label: 'Team', keep: true, type: 'text', value: (x) => x.name, render: (x) => <span className='font-medium'>{x.name}</span> },
    { key: 'budget', label: 'Budget used this month', className: 'w-72', type: 'number', value: (x) => x.spent,
      render: (x) => (x.budget_usd == null ? <span className='text-xs tabular-nums'>{usd(x.spent)} <span className='text-muted-foreground'>· no team cap</span></span> : <Allowance spent={x.spent} cap={x.budget_usd} />) },
    // The cap already reads in "Budget used" ("$x of $cap"); kept hidden for sorting, filtering and export.
    { key: 'cap', label: 'Monthly cap', className: 'w-32', hidden: true, type: 'number', value: (x) => x.budget_usd ?? undefined, render: (x) => <span className='tabular-nums'>{x.budget_usd == null ? <span className='text-muted-foreground'>none</span> : usd(x.budget_usd)}</span> },
    { key: 'left', label: 'Left', className: 'w-28', type: 'number', value: (x) => x.left_usd ?? undefined,
      render: (x) => <span className={cn('text-xs tabular-nums', x.limited_by && 'text-amber-700 dark:text-amber-400')} title={x.limited_by ? 'Limits its people (90% or more used)' : undefined}>
        {x.left_usd == null ? <span className='text-muted-foreground'>—</span> : usd(x.left_usd)}</span> },
    { key: 'conc', label: 'Runs at once, per person', className: 'w-48', type: 'number', value: (x) => x.max_concurrent_runs ?? undefined,
      render: (x) => <span className='text-xs tabular-nums'>{x.max_concurrent_runs ?? <span className='text-muted-foreground'>account default</span>}</span> },
    { key: 'people', label: 'People', className: 'w-28', type: 'number', value: (x) => x.members, render: (x) => <span className='text-xs'>{x.members ? `${x.members} ${x.members === 1 ? 'person' : 'people'}` : <span className='text-muted-foreground'>nobody yet</span>}</span> }
  ];
  return (
    <>
      <RecordView compact id='billing-teams-v2' rows={l.teams} rowKey={(x) => String(x.id)} cols={cols} noun='teams'
        searchText={(x) => x.name} searchPlaceholder='Search teams'
        primary={manage ? <Button onClick={() => setEdit({ id: null, name: '', budget: '', conc: '' })}><Icons.add /> Add team</Button> : undefined}
        actions={manage ? (x) => [
          { label: 'Edit team', icon: <Icons.edit />, onSelect: () => { const v = { name: x.name, budget: str(x.budget_usd), conc: str(x.max_concurrent_runs) }; setEdit({ id: x.id, ...v, was: v }); } },
          { label: 'Delete team', icon: <Icons.trash />, destructive: true, separator: true, onSelect: () => setRemoving(x) }
        ] : undefined}
        exportName='teams' empty='No teams: everyone shares the account cap. Put people in teams from their row on People (Edit limits).' />
      <Dialog open={edit !== null} onOpenChange={(o) => { if (!o) setEdit(null); }}>
        <DialogContent className='sm:max-w-md'>
          {edit && (
            <form onSubmit={save} className='grid gap-4'>
              <DialogHeader><DialogTitle>{edit.id == null ? 'Add a team' : 'Edit team'}</DialogTitle><DialogDescription>This budget is set aside for the team and is the most it can spend. Leave it empty and the team shares Everyone else&apos;s.</DialogDescription></DialogHeader>
              <label className='grid gap-1.5 text-sm'>Name<Input required autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
              <label className='grid gap-1.5 text-sm'>Monthly budget ($)<Input type='number' min={0} step={0.01} value={edit.budget} onChange={(e) => setEdit({ ...edit, budget: e.target.value })} placeholder='no cap' /></label>
              <label className='grid gap-1.5 text-sm'>Runs at once, per person<Input type='number' min={1} step={1} value={edit.conc} onChange={(e) => setEdit({ ...edit, conc: e.target.value })} placeholder='account default' /></label>
              <DialogFooter><Button type='button' variant='outline' onClick={() => setEdit(null)}>Cancel</Button><Button type='submit'>{edit.id == null ? 'Add team' : 'Save team'}</Button></DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
      {removing && <DeleteTeam team={removing} l={l} onClose={() => setRemoving(null)} onDeleted={reload} />}
    </>
  );
}

/**
 * Before a team is deleted: what it changes, from the preview (the server's allocate() with the team gone). Its people
 * move to Everyone else, their limits there, its budget going back, and who would be blocked right away.
 */
function DeleteTeam({ team, l, onClose, onDeleted }: { team: LimitTeam; l: Limits; onClose: () => void; onDeleted: () => void }) {
  const [pv, setPv] = useState<Preview | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { appApi<Preview>('POST', '/limits/preview', { remove_teams: [team.id] }).then(setPv, () => setFailed(true)); }, [team.id]);
  const ids = new Set(l.members.filter((m) => m.team_id === team.id).map((m) => m.user_id));
  const moved = pv?.members.filter((m) => ids.has(m.user_id)) ?? [];
  const limits = [...new Set(moved.filter((m) => m.can_run && m.limit_source !== 'own').map((m) => m.limit_usd ?? 0))];
  const blocked = pv?.changes.filter((c) => c.blocked_now).length ?? 0;
  const n = ids.size, they = n === 1 ? 'Their limit becomes' : 'Their limits become';
  const lines = [
    n ? `Its ${plural(n, 'person', 'people')} ${n === 1 ? 'moves' : 'move'} to Everyone else.` : 'Nobody is in it.',
    ...(!n || !pv ? [] : pv.policy.mode === 'pool' ? ["They share Everyone else's budget, with no personal limit."]
      : limits.length === 1 ? [`${they} ${usd(limits[0]!)}${n > 1 ? ' each' : ''}.`] : limits.length ? [`${they} ${limits.map(usd).join(', ')}.`] : []),
    ...(moved.some((m) => m.limit_source === 'own') ? ['Own limits stay.'] : []),
    ...(team.budget_usd != null ? [`The ${usd(team.budget_usd)} set aside goes back to Everyone else.`] : []),
    ...(blocked ? [`${plural(blocked, 'person', 'people')} will be blocked right away.`] : [])
  ];
  const remove = () => {
    setBusy(true);
    appApi('DELETE', `/limits/teams/${team.id}`).then(() => { toast.success('Team deleted'); onDeleted(); onClose(); }).catch(fail).finally(() => setBusy(false));
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>Delete team {team.name}?</DialogTitle>
          <DialogDescription>{!pv && !failed ? 'Working out what changes…' : failed ? "We couldn't work out what changes. Its people move to Everyone else." : lines.join(' ')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant='outline' onClick={onClose}>Keep team</Button>
          <Button variant='destructive' disabled={busy || (!pv && !failed)} onClick={remove}>{blocked ? `Delete and block ${blocked}` : 'Delete team'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
