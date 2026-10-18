'use client';
// /app Billing: this month (plan, spend against the cap, daily spend) above three tabs. People: one searchable table of
// who is in the account, their role, access, team and spend against their allowance (invite, roles, limits and
// suspension in each row's ⋯ menu). Teams: a searchable table of team budgets. Budget rules (admins): how the cap is
// shared and the limits, beside where the cap goes. Plans and cards are Stripe's; people are Clerk's.
import { useState } from 'react';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { ActionsMenu, RecordView, type RecordCol, type RowAction } from '@/components/layout/record-view';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Icons } from '@/components/icons';
import { appApi } from '@/lib/api-client';
import { money, num, usd } from '@/lib/octillion-format';
import { cn } from '@/lib/utils';
import { ErrorState, LoadingCards, When, fail, useOrgLoad } from './shared';

interface Sub { status: string; plan: string | null; renews_at: string | null; cancel_at_period_end: boolean; trial_end: string | null }
interface Plan { price_id: string; name: string; amount: number | null; currency: string; interval: string | null; monthly_budget_usd: number | null }
interface Billing { enabled: boolean; customer: boolean; subscription: Sub | null; budget_usd: number; budget_source?: 'override' | 'plan' | 'default'; prepaid_allowed?: boolean; plans: Plan[]; can_manage: boolean }
interface Usage {
  period: { start: string; end: string; days: number; elapsed_days: number };
  spent_usd: number; budget_usd: number; projected_usd: number; metered_usd: number; in_flight_usd: number;
  sessions: { finished: number; running: number }; meter: { enabled: boolean };
  daily: { day: string; usd: number; sessions: number }[];
}
interface Member { id: string; user_id: string; status: string; role: string; created_at: string; email: string | null; name: string | null }
interface Invite { id: string; email: string; state: string; role?: string; created_at: string }
interface Team { clerk: boolean; error: string | null; members: Member[]; invitations: Invite[]; me: string | null; can_manage: boolean }
type Mode = 'pool' | 'even' | 'custom';
interface Policy { mode: Mode; reserve_usd: number; default_cap_usd: number | null; new_members_can_run: boolean; max_concurrent_runs: number | null; max_sessions_per_run: number | null }
interface LimitTeam { id: number; name: string; budget_usd: number | null; max_concurrent_runs: number | null; members: number; spent: number }
interface LimitMember { user_id: string; team_id: number | null; can_run: boolean; adjust_usd: number; cap_usd: number | null; max_concurrent_runs: number | null; allowance_usd: number | null; spent: number; running: number; tokens_in: number; tokens_out: number }
interface Limits { policy: Policy; budget_usd: number; teams: LimitTeam[]; members: LimitMember[]; can_manage: boolean; me: string | null; clerk?: boolean;
  allocated_usd?: number; unallocated_usd?: number | null; spent_usd?: number }

const STATUS: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = { active: 'default', trialing: 'secondary', past_due: 'destructive', unpaid: 'destructive', canceled: 'outline' };
const orNull = (v: string) => (v.trim() === '' ? null : Number(v));
const str = (v: number | null | undefined) => (v == null ? '' : String(v));

/** A titled section: the page is the container, no cards. */
function Block({ id, title, action, children }: { id?: string; title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={id} className='flex scroll-mt-20 flex-col gap-4'>
      <div className='flex items-center justify-between gap-2'>{title ? <h2 className='text-base leading-none font-semibold'>{title}</h2> : <span />}{action}</div>
      {children}
    </section>
  );
}

export function BillingPage() {
  const { data: b, error } = useOrgLoad(() => appApi<Billing>('GET', '/billing'));
  const { data: u } = useOrgLoad(() => appApi<Usage>('GET', '/billing/usage'));
  const { data: t, reload: reloadTeam } = useOrgLoad(() => appApi<Team>('GET', '/team'));
  const { data: l, reload: reloadLimits } = useOrgLoad(() => appApi<Limits>('GET', '/limits'));
  const reload = () => { reloadTeam(); reloadLimits(); };
  return (
    <PageContainer pageTitle='Billing'>
      {error ? <ErrorState error={error} /> : !b ? <LoadingCards count={3} /> : (
        <div className='flex w-full flex-col gap-6'>
          <ThisMonth b={b} u={u ?? undefined} l={l ?? undefined} />
          {/* People, Teams and Budget rules as tabs: the two tables get the full width and height they need. */}
          <Tabs defaultValue='people' className='gap-4'>
            <TabsList variant='line' className='gap-6 p-0'>
              <TabsTrigger value='people' className='flex-none px-0'>People{t && <span className='text-muted-foreground ml-1.5 font-normal tabular-nums'>{t.members.length + t.invitations.length}</span>}</TabsTrigger>
              <TabsTrigger value='teams' className='flex-none px-0'>Teams{l && <span className='text-muted-foreground ml-1.5 font-normal tabular-nums'>{l.teams.length}</span>}</TabsTrigger>
              {l?.can_manage && <TabsTrigger value='rules' className='flex-none px-0'>Budget rules</TabsTrigger>}
            </TabsList>
            <TabsContent value='people'><People t={t ?? undefined} l={l ?? undefined} reload={reload} /></TabsContent>
            <TabsContent value='teams'>{l ? <Teams l={l} reload={reload} /> : <LoadingCards count={1} />}</TabsContent>
            {l?.can_manage && <TabsContent value='rules'><Rules l={l} reload={reloadLimits} /></TabsContent>}
          </Tabs>
        </div>
      )}
    </PageContainer>
  );
}

// ---------- this month: plan, spend against the cap, daily spend ----------

function ThisMonth({ b, u, l }: { b: Billing; u: Usage | undefined; l: Limits | undefined }) {
  const [busy, setBusy] = useState<string | null>(null);
  const go = (path: string, body?: unknown, id = path) => {
    setBusy(id);
    appApi<{ url: string }>('POST', path, body).then((r) => { window.location.href = r.url; }).catch((e) => { setBusy(null); fail(e); });
  };
  const s = b.subscription, live = s && ['active', 'trialing', 'past_due'].includes(s.status);
  const mine = !l?.can_manage ? l?.members.find((m) => m.user_id === l.me) : undefined;
  const cap = u?.budget_usd ?? b.budget_usd;
  const pct = (v: number) => (cap ? Math.min(100, (v / cap) * 100) : 0);
  const over = !!u && cap > 0 && u.projected_usd > cap;
  return (
    <Block title='This month' action={b.enabled && b.can_manage && b.customer
      ? <Button variant='outline' size='sm' disabled={busy !== null} onClick={() => go('/billing/portal')}>{busy ? <Icons.spinner className='animate-spin' /> : <Icons.creditCard />} Manage billing</Button> : undefined}>
      {s && ['past_due', 'unpaid'].includes(s.status) && <Alert variant='destructive'><Icons.warning /><AlertDescription>The last payment failed. Update the card to keep running simulations.</AlertDescription></Alert>}
      <div className='flex flex-wrap items-baseline gap-x-6 gap-y-2 leading-none'>
        <span className='text-4xl font-semibold tabular-nums'>{usd(u?.spent_usd ?? 0)}</span>
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
          {mine && <span className='text-foreground'>Your allowance: {mine.allowance_usd == null ? 'shared' : `${usd(mine.spent)} of ${usd(mine.allowance_usd)}`}</span>}
        </p>
      )}
      {u && <Daily u={u} />}
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
    </Block>
  );
}

function Daily({ u }: { u: Usage }) {
  const by = new Map(u.daily.map((d) => [d.day, d.usd]));
  const start = Date.parse(u.period.start), today = new Date().toISOString().slice(0, 10);
  const days = Array.from({ length: u.period.days }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
  const max = Math.max(0.01, ...u.daily.map((d) => d.usd));
  return (
    // Short when nothing has been spent yet: a flat strip, not an empty 4rem box.
    <div className={cn('flex items-end gap-0.5', u.daily.some((d) => d.usd > 0) ? 'h-12' : 'h-1.5')} role='img' aria-label='Model spend per day this month'>
      {days.map((d) => {
        const v = by.get(d) ?? 0;
        return <div key={d} title={`${d}: ${usd(v)}`} className={cn('flex-1 rounded-t-sm', d > today ? 'bg-muted/40' : v ? 'bg-primary/80' : 'bg-muted')} style={{ height: u.daily.some((x) => x.usd > 0) ? `${d > today ? 6 : Math.max(6, (v / max) * 100)}%` : '100%' }} />;
      })}
    </div>
  );
}

// ---------- people: one table for membership, access and limits ----------

type PersonRow =
  | { kind: 'member'; key: string; m: Member; lim: LimitMember | undefined }
  | { kind: 'invite'; key: string; x: Invite };

function People({ t, l, reload }: { t: Team | undefined; l: Limits | undefined; reload: () => void }) {
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<{ m: Member; lim: LimitMember } | null>(null);
  const [suspend, setSuspend] = useState<Member | null>(null);
  if (!t) return <LoadingCards count={1} />;
  const manage = t.can_manage, mode = l?.policy.mode ?? 'pool';
  const act = (p: Promise<unknown>, msg: string) => p.then(() => { toast.success(msg); reload(); }).catch(fail);
  const rows: PersonRow[] = [
    ...t.members.map((m) => ({ kind: 'member' as const, key: m.id, m, lim: l?.members.find((x) => x.user_id === m.user_id) })),
    ...t.invitations.map((x) => ({ kind: 'invite' as const, key: x.id, x }))
  ];
  const teamName = (id: number | null | undefined) => (id == null ? null : l?.teams.find((x) => x.id === id)?.name ?? null);
  const actions = (r: PersonRow): RowAction[] => {
    if (!manage) return [];
    if (r.kind === 'invite') return [
      { label: 'Resend invitation', icon: <Icons.send />, onSelect: () => act(appApi('POST', `/team/invitations/${encodeURIComponent(r.x.id)}/resend`), `Invitation resent to ${r.x.email}`) },
      ...(r.x.state === 'pending' ? [{ label: 'Cancel invitation', icon: <Icons.close />, destructive: true, onSelect: () => act(appApi('POST', `/team/invitations/${encodeURIComponent(r.x.id)}/revoke`), 'Invitation cancelled') }] : [])
    ];
    const { m, lim } = r, self = m.user_id === t.me, active = m.status === 'active';
    return [
      ...(lim ? [{ label: 'Edit limits', icon: <Icons.gauge />, onSelect: () => setEditing({ m, lim }) }] : []),
      ...(self ? [] : [
        { label: m.role === 'admin' ? 'Make member' : 'Make admin', icon: <Icons.teams />, onSelect: () => act(appApi('POST', `/team/members/${encodeURIComponent(m.id)}/role`, { role: m.role === 'admin' ? 'member' : 'admin' }), `${m.email} is now ${m.role === 'admin' ? 'a member' : 'an admin'}`) },
        active ? { label: 'Suspend access', icon: <Icons.close />, destructive: true, separator: true, onSelect: () => setSuspend(m) }
          : { label: 'Restore access', icon: <Icons.check />, separator: true, onSelect: () => act(appApi('POST', `/team/members/${encodeURIComponent(m.id)}/reactivate`), `Access restored for ${m.email}`) }
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
    { key: 'role', label: 'Role', className: 'w-24', type: 'select', value: (r) => ((r.kind === 'invite' ? r.x.role : r.m.role) === 'admin' ? 'Admin' : 'Member'),
      render: (r) => { const admin = (r.kind === 'invite' ? r.x.role : r.m.role) === 'admin'; return <span className={admin ? '' : 'text-muted-foreground'}>{admin ? 'Admin' : 'Member'}</span>; } },
    { key: 'status', label: 'Status', className: 'w-36', type: 'select', value: statusOf,
      render: (r) => <Badge variant={statusOf(r) === 'Active' ? 'secondary' : statusOf(r) === 'Invited' ? 'outline' : 'destructive'}>{statusOf(r)}</Badge> },
    { key: 'team', label: 'Team', className: 'w-36', type: 'select', value: (r) => (r.kind === 'member' ? teamName(r.lim?.team_id) ?? 'No team' : 'No team'),
      render: (r) => <span className='text-muted-foreground'>{r.kind === 'member' ? teamName(r.lim?.team_id) ?? '—' : '—'}</span> },
    { key: 'spend', label: 'Spend this month', className: 'w-56', type: 'number', value: (r) => (r.kind === 'member' ? r.lim?.spent ?? 0 : 0),
      render: (r) => r.kind === 'invite' || !r.lim ? <span className='text-muted-foreground'>—</span> : r.lim.allowance_usd == null
        ? <span className='text-xs tabular-nums'>{usd(r.lim.spent)} <span className='text-muted-foreground'>· shared budget</span></span>
        : <Allowance spent={r.lim.spent} cap={r.lim.allowance_usd} /> },
    { key: 'tokens', label: 'Tokens', className: 'w-28', type: 'number', value: (r) => (r.kind === 'member' && r.lim ? Number(r.lim.tokens_in) + Number(r.lim.tokens_out) : 0),
      render: (r) => <span className='text-xs tabular-nums'>{r.kind === 'member' && r.lim ? num(Number(r.lim.tokens_in) + Number(r.lim.tokens_out)) : '—'}</span> },
    { key: 'runs', label: 'Runs at once', className: 'w-32', render: (r) => r.kind === 'invite' || !r.lim ? <span className='text-muted-foreground'>—</span> : (
      <span className='text-xs tabular-nums'>
        {r.lim.max_concurrent_runs ?? l?.policy.max_concurrent_runs ?? <span className='text-muted-foreground'>any</span>}
        {r.lim.max_concurrent_runs == null && l?.policy.max_concurrent_runs != null && <span className='text-muted-foreground'> default</span>}
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
        views={[{ id: 'all', label: 'Everyone' }, { id: 'active', label: 'Active', match: (r) => statusOf(r) === 'Active' }, { id: 'invited', label: 'Invited', match: (r) => r.kind === 'invite' },
          { id: 'suspended', label: 'Suspended', match: (r) => statusOf(r) === 'Suspended' }]}
        primary={manage ? <Button onClick={() => setInviting(true)}><Icons.add /> Invite</Button> : undefined}
        actions={manage ? actions : undefined} exportName='people' empty='Nobody here yet.' />
      {inviting && <InviteDialog onClose={() => setInviting(false)} onSent={reload} />}
      {editing && l && <LimitsDialog m={editing.m} lim={editing.lim} l={l} mode={mode} onClose={() => setEditing(null)} onSaved={reload} />}
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

function InviteDialog({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
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
          <DialogHeader><DialogTitle>Invite someone</DialogTitle><DialogDescription>They get an email and join this account when they accept. Admins also manage people, limits and billing.</DialogDescription></DialogHeader>
          <div className='flex gap-2'>
            <Input autoFocus type='email' required placeholder='name@company.com' value={email} onChange={(e) => setEmail(e.target.value)} aria-label='Email' />
            <NativeSelect value={role} onChange={(e) => setRole(e.target.value)} aria-label='Role' className='w-32'>
              <NativeSelectOption value='member'>Member</NativeSelectOption><NativeSelectOption value='admin'>Admin</NativeSelectOption>
            </NativeSelect>
          </div>
          <DialogFooter><Button type='button' variant='outline' onClick={onClose}>Cancel</Button><Button type='submit' disabled={busy || !email.trim()}>Send invitation</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One person's limits: team, whether they may launch simulations, their cap or adjustment (per the sharing mode), concurrency. */
function LimitsDialog({ m, lim, l, mode, onClose, onSaved }: { m: Member; lim: LimitMember; l: Limits; mode: Mode; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ team: lim.team_id == null ? '' : String(lim.team_id), run: lim.can_run, cap: str(lim.cap_usd), adjust: lim.adjust_usd ? String(lim.adjust_usd) : '', conc: str(lim.max_concurrent_runs) });
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    appApi('PUT', `/limits/members/${encodeURIComponent(m.user_id)}`, {
      team_id: f.team === '' ? null : Number(f.team), can_run: f.run, max_concurrent_runs: orNull(f.conc),
      ...(mode === 'custom' ? { cap_usd: orNull(f.cap) } : {}), ...(mode === 'even' ? { adjust_usd: orNull(f.adjust) ?? 0 } : {})
    }).then(() => { toast.success('Limits saved'); onSaved(); onClose(); }).catch(fail);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <form onSubmit={save} className='grid gap-4'>
          <DialogHeader><DialogTitle>Limits for {m.name || m.email}</DialogTitle><DialogDescription>Spent {usd(lim.spent)} this month{lim.allowance_usd != null ? ` of ${usd(lim.allowance_usd)}` : ''}.</DialogDescription></DialogHeader>
          <label className='grid gap-1.5 text-sm'>Team
            <NativeSelect value={f.team} onChange={(e) => setF({ ...f, team: e.target.value })} className='w-full'>
              <NativeSelectOption value=''>No team</NativeSelectOption>
              {l.teams.map((x) => <NativeSelectOption key={x.id} value={String(x.id)}>{x.name}</NativeSelectOption>)}
            </NativeSelect>
          </label>
          {mode === 'custom' && <label className='grid gap-1.5 text-sm'>Monthly cap ($)<Input type='number' min={0} step={1} value={f.cap} onChange={(e) => setF({ ...f, cap: e.target.value })} placeholder={l.policy.default_cap_usd == null ? 'no cap' : `default ${l.policy.default_cap_usd}`} /></label>}
          {mode === 'even' && <label className='grid gap-1.5 text-sm'>Adjust their even share (± $)<Input type='number' step={1} value={f.adjust} onChange={(e) => setF({ ...f, adjust: e.target.value })} placeholder='0' /></label>}
          <label className='grid gap-1.5 text-sm'>Simulations running at once<Input type='number' min={0} step={1} value={f.conc} onChange={(e) => setF({ ...f, conc: e.target.value })} placeholder={l.policy.max_concurrent_runs == null ? 'no limit' : `default ${l.policy.max_concurrent_runs}`} /></label>
          <label className='flex items-center gap-2 text-sm leading-none'><Checkbox checked={f.run} onCheckedChange={(v) => setF({ ...f, run: Boolean(v) })} /> Can launch simulations</label>
          <DialogFooter><Button type='button' variant='outline' onClick={onClose}>Cancel</Button><Button type='submit'>Save limits</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- budget rules (admins): how the cap is shared, rollout and throughput, teams ----------

const MODES: { id: Mode; title: string; body: string }[] = [
  { id: 'pool', title: 'Shared pool', body: 'Everyone draws from the account cap, and their team budget if it has one, until it runs out.' },
  { id: 'even', title: 'Split evenly', body: 'Each person gets an equal share of what is left after the reserve and team budgets; adjust anyone from their ⋯ menu.' },
  { id: 'custom', title: 'Custom caps', body: 'Each person has their own monthly cap, set from their ⋯ menu; people without one get the default.' }
];
const SEG = ['bg-sky-500', 'bg-violet-500', 'bg-amber-500', 'bg-rose-500', 'bg-teal-500', 'bg-fuchsia-500'];

function Rules({ l, reload }: { l: Limits; reload: () => void }) {
  const p = l.policy;
  const init = () => ({ mode: p.mode, reserve: p.reserve_usd ? String(p.reserve_usd) : '', defaultCap: str(p.default_cap_usd), newRun: p.new_members_can_run, conc: str(p.max_concurrent_runs), sess: str(p.max_sessions_per_run) });
  const [f, setF] = useState(init);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(f) !== JSON.stringify(init());
  const save = () => {
    setBusy(true);
    appApi('PUT', '/limits/policy', { mode: f.mode, reserve_usd: orNull(f.reserve) || 0, default_cap_usd: orNull(f.defaultCap), new_members_can_run: f.newRun,
      max_concurrent_runs: orNull(f.conc), max_sessions_per_run: orNull(f.sess) })
      .then(() => { toast.success('Budget rules saved'); reload(); }).catch(fail).finally(() => setBusy(false));
  };
  return (
    <Block id='limits' title='' action={
      <div className='flex items-center gap-3'>
        {dirty && <span className='text-muted-foreground text-xs leading-none'>Unsaved changes · <button type='button' className='hover:text-foreground underline-offset-4 hover:underline' onClick={() => setF(init())}>Reset</button></span>}
        <Button size='sm' onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save rules'}</Button>
      </div>}>
      <div className='grid gap-x-12 gap-y-8 xl:grid-cols-[minmax(0,1fr)_26rem] xl:items-start'>
      <div className='flex flex-col gap-8'>
      <div className='flex flex-col gap-3'>
      <p className='text-sm leading-none font-medium'>How the monthly cap is shared</p>
      <div role='radiogroup' aria-label='How the cap is shared' className='grid gap-3 lg:grid-cols-3'>
        {MODES.map((m) => (
          <button key={m.id} type='button' role='radio' aria-checked={f.mode === m.id} onClick={() => setF({ ...f, mode: m.id })}
            className={cn('flex flex-col gap-2 rounded-lg border p-4 text-left transition-colors', f.mode === m.id ? 'border-primary bg-primary/10' : 'hover:bg-muted/50')}>
            <span className='flex items-center gap-2 text-sm leading-none font-medium'>
              <span className={cn('flex size-4 items-center justify-center rounded-full border', f.mode === m.id ? 'border-primary' : 'border-muted-foreground/50')}>{f.mode === m.id && <span className='bg-primary size-2 rounded-full' />}</span>
              {m.title}{p.mode === m.id && <span className='text-muted-foreground text-xs font-normal'>current</span>}
            </span>
            <span className='text-muted-foreground text-xs'>{m.body}</span>
          </button>
        ))}
      </div>
      </div>
      <div className='flex flex-col gap-3'>
      <p className='text-sm leading-none font-medium'>Limits</p>
      <div className='grid gap-x-8 gap-y-5 sm:grid-cols-2'>
        {f.mode === 'even' && <NumberField label='Shared reserve' unit='$' value={f.reserve} onChange={(v) => setF({ ...f, reserve: v })} hint='Kept out of the even split.' />}
        {f.mode === 'custom' && <NumberField label='Default monthly cap' unit='$' value={f.defaultCap} onChange={(v) => setF({ ...f, defaultCap: v })} placeholder='no cap' hint='For people without their own.' />}
        <NumberField label='Runs at once, per person' value={f.conc} onChange={(v) => setF({ ...f, conc: v })} placeholder='no limit' hint='Simulations running together.' />
        <NumberField label='Agent sessions per launch' value={f.sess} onChange={(v) => setF({ ...f, sess: v })} placeholder="server's limit" hint='The size of one run.' min={1} />
        <label className='flex flex-col gap-2 text-sm leading-none'>
          New members can launch
          <span className='flex h-9 items-center gap-2'><Switch checked={f.newRun} onCheckedChange={(v) => setF({ ...f, newRun: Boolean(v) })} /><span className='text-muted-foreground text-xs'>{f.newRun ? 'Yes, from day one' : 'Only once allowed'}</span></span>
        </label>
      </div>
      </div>
      </div>
      {/* Where the cap goes, beside the rules on wide screens so a change and its effect are seen together. */}
      <div className='xl:sticky xl:top-20 rounded-lg border p-5'><Allocation l={l} /></div>
      </div>
    </Block>
  );
}

function NumberField({ label, unit, value, onChange, placeholder, hint, min = 0 }: { label: string; unit?: string; value: string; onChange: (v: string) => void; placeholder?: string; hint?: string; min?: number }) {
  return (
    <label className='flex flex-col gap-2 text-sm leading-none'>
      {label}
      <span className='relative'>
        {unit && <span className='text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm'>{unit}</span>}
        <Input type='number' min={min} step={1} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={cn('h-9', unit && 'pl-7')} />
      </span>
      {hint && <span className='text-muted-foreground text-xs'>{hint}</span>}
    </label>
  );
}

/** Where the month's cap goes: reserve, team budgets, people's shares, and what nobody has been given. */
function Allocation({ l }: { l: Limits }) {
  const cap = l.budget_usd;
  if (!cap) return <p className='text-muted-foreground text-sm'>No monthly cap on this plan; limits apply per person and team only.</p>;
  const p = l.policy;
  const parts: { label: string; usd: number; cls: string }[] = [];
  if (p.mode === 'even' && p.reserve_usd) parts.push({ label: 'Shared reserve', usd: Number(p.reserve_usd), cls: 'bg-muted-foreground/60' });
  l.teams.filter((x) => x.budget_usd).forEach((x, i) => parts.push({ label: `Team ${x.name}`, usd: Number(x.budget_usd), cls: SEG[i % SEG.length] }));
  if (p.mode !== 'pool') {
    const teamless = l.members.filter((m) => m.team_id == null || !l.teams.find((x) => x.id === m.team_id)?.budget_usd);
    const people = teamless.reduce((n, m) => n + (m.allowance_usd ?? 0), 0);
    if (people) parts.push({ label: `People's shares (${teamless.length})`, usd: people, cls: 'bg-primary' });
  }
  const used = parts.reduce((n, x) => n + x.usd, 0);
  const left = Math.max(0, cap - used);
  return (
    <div className='flex flex-col gap-2.5'>
      <div className='flex items-baseline justify-between text-sm leading-none'>
        <span className='font-medium'>Where the {usd(cap)} cap goes</span>
        <span className='text-muted-foreground text-xs'>{usd(l.spent_usd ?? 0)} spent so far</span>
      </div>
      <div className='bg-muted flex h-3 overflow-hidden rounded-full'>
        {parts.map((x) => <div key={x.label} className={x.cls} style={{ width: `${Math.min(100, (x.usd / cap) * 100)}%` }} title={`${x.label}: ${usd(x.usd)}`} />)}
      </div>
      <ul className='text-muted-foreground flex flex-wrap gap-x-5 gap-y-1.5 text-xs leading-none'>
        {parts.map((x) => <li key={x.label} className='flex items-center gap-1.5'><span className={cn('size-2 rounded-full', x.cls)} />{x.label} <span className='text-foreground tabular-nums'>{usd(x.usd)}</span></li>)}
        <li className='flex items-center gap-1.5'><span className='bg-muted size-2 rounded-full border' />{p.mode === 'pool' ? 'Shared by everyone' : 'Not allocated'} <span className='text-foreground tabular-nums'>{usd(left)}</span></li>
      </ul>
    </div>
  );
}

/** Teams as one full table: budget used against the team cap, runs at once, people. Add, edit and delete (admins). */
function Teams({ l, reload }: { l: Limits; reload: () => void }) {
  const [edit, setEdit] = useState<{ id: number | null; name: string; budget: string; conc: string } | null>(null);
  const manage = l.can_manage;
  const save = (e: React.FormEvent) => {
    e.preventDefault(); if (!edit) return;
    const body = { name: edit.name, budget_usd: orNull(edit.budget), max_concurrent_runs: orNull(edit.conc) };
    (edit.id == null ? appApi('POST', '/limits/teams', body) : appApi('PUT', `/limits/teams/${edit.id}`, body))
      .then(() => { setEdit(null); toast.success(edit.id == null ? 'Team added' : 'Team saved'); reload(); }).catch(fail);
  };
  const remove = (x: LimitTeam) => { if (window.confirm(`Delete team ${x.name}? Its people go back to the shared budget.`)) appApi('DELETE', `/limits/teams/${x.id}`).then(() => { toast.success('Team deleted'); reload(); }).catch(fail); };
  const cols: RecordCol<LimitTeam>[] = [
    { key: 'team', label: 'Team', keep: true, type: 'text', value: (x) => x.name, render: (x) => <span className='font-medium'>{x.name}</span> },
    { key: 'budget', label: 'Budget used this month', className: 'w-72', type: 'number', value: (x) => x.spent,
      render: (x) => (x.budget_usd == null ? <span className='text-xs tabular-nums'>{usd(x.spent)} <span className='text-muted-foreground'>· no team cap</span></span> : <Allowance spent={x.spent} cap={x.budget_usd} />) },
    { key: 'cap', label: 'Monthly cap', className: 'w-32', type: 'number', value: (x) => x.budget_usd ?? undefined, render: (x) => <span className='tabular-nums'>{x.budget_usd == null ? <span className='text-muted-foreground'>none</span> : usd(x.budget_usd)}</span> },
    { key: 'conc', label: 'Runs at once, per person', className: 'w-48', type: 'number', value: (x) => x.max_concurrent_runs ?? undefined,
      render: (x) => <span className='text-xs tabular-nums'>{x.max_concurrent_runs ?? <span className='text-muted-foreground'>account default</span>}</span> },
    { key: 'people', label: 'People', className: 'w-28', type: 'number', value: (x) => x.members, render: (x) => <span className='text-xs'>{x.members ? `${x.members} ${x.members === 1 ? 'person' : 'people'}` : <span className='text-muted-foreground'>nobody yet</span>}</span> }
  ];
  return (
    <>
      <RecordView compact id='billing-teams' rows={l.teams} rowKey={(x) => String(x.id)} cols={cols} noun='teams'
        searchText={(x) => x.name} searchPlaceholder='Search teams'
        primary={manage ? <Button onClick={() => setEdit({ id: null, name: '', budget: '', conc: '' })}><Icons.add /> Add team</Button> : undefined}
        actions={manage ? (x) => [
          { label: 'Edit team', icon: <Icons.edit />, onSelect: () => setEdit({ id: x.id, name: x.name, budget: str(x.budget_usd), conc: str(x.max_concurrent_runs) }) },
          { label: 'Delete team', icon: <Icons.trash />, destructive: true, separator: true, onSelect: () => remove(x) }
        ] : undefined}
        exportName='teams' empty='No teams: everyone shares the account cap. Put people in teams from their row on People (Edit limits).' />
      <Dialog open={edit !== null} onOpenChange={(o) => { if (!o) setEdit(null); }}>
        <DialogContent className='sm:max-w-md'>
          {edit && (
            <form onSubmit={save} className='grid gap-4'>
              <DialogHeader><DialogTitle>{edit.id == null ? 'Add a team' : 'Edit team'}</DialogTitle><DialogDescription>A team budget caps the team&apos;s combined spend; in Split evenly it is shared among its people.</DialogDescription></DialogHeader>
              <label className='grid gap-1.5 text-sm'>Name<Input required autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
              <label className='grid gap-1.5 text-sm'>Monthly budget ($)<Input type='number' min={0} step={1} value={edit.budget} onChange={(e) => setEdit({ ...edit, budget: e.target.value })} placeholder='no cap' /></label>
              <label className='grid gap-1.5 text-sm'>Runs at once, per person<Input type='number' min={0} step={1} value={edit.conc} onChange={(e) => setEdit({ ...edit, conc: e.target.value })} placeholder='account default' /></label>
              <DialogFooter><Button type='button' variant='outline' onClick={() => setEdit(null)}>Cancel</Button><Button type='submit'>{edit.id == null ? 'Add team' : 'Save team'}</Button></DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
