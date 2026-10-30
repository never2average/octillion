'use client';
// One account in full: a card with the account's facts and its 30 days, then a tab per list: onboarding milestones,
// people (Clerk), invitations, billing (Stripe), tool use, errors, clients, research, simulations, legacy keys.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import PageContainer from '@/components/layout/page-container';
import { DetailMeta, DetailTable, DetailTabs } from '@/components/layout/detail';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Icons } from '@/components/icons';
import { money, usd } from '@/lib/octillion-format';
import { adminApi } from '@/lib/api-client';
import { ACCOUNT_ROLES, accountRoleLabel, accountRoleOf, post, STAGE_LABELS, useAdmin, useAdminAction, type InviteResult, type OrgList } from './lib';
import { Gate } from './role';
import { useResult } from './result-dialog';
import { StatStrip } from '@/components/layout/section';
import { ConfirmButton, copyText, ErrorBox, Mono, Notice, StatusBadge, SubBadge, When, type Tone } from './ui';

type Detail = any; // GET /orgs/:slug (src/admin.ts orgDetail)
const day = (d: unknown) => (d ? String(d).slice(0, 10) : '—');
const dash = <span className='text-muted-foreground'>—</span>;

export function AdminAccountDetail({ slug }: { slug: string }) {
  const path = `/orgs/${encodeURIComponent(slug)}`;
  const { data: d, error, isLoading } = useAdmin<Detail>(path);
  const { data: list } = useAdmin<OrgList>('/orgs');
  const result = useResult();
  const labelOf = (k: string) => list?.stages.find((s) => s.id === k)?.label ?? STAGE_LABELS[k] ?? k;
  const show = (r: InviteResult, t: string) => result.show(r, t);
  const linked = d && (d.org.clerk_org_id ?? d.org.workos_org_id);

  return (
    // No page title: the card is the page's header, with a small way back above it.
    <PageContainer>
      <Link href='/admin/accounts' className='text-muted-foreground hover:text-foreground mb-3 inline-flex w-fit items-center gap-1 text-sm'>
        <Icons.chevronLeft className='size-4' /> Accounts
      </Link>
      <ErrorBox error={error} />
      {isLoading || !d ? (
        <div className='flex flex-col gap-4'>
          <Skeleton className='h-48 rounded-xl' />
          <Skeleton className='h-8 w-96' />
          <Skeleton className='h-64' />
        </div>
      ) : (
        <div className='flex w-full flex-col gap-4'>
          <AccountMeta d={d} path={path} />
          <DetailTabs
            url
            tabs={[
              { id: 'onboarding', label: 'Onboarding', content: <Onboarding d={d} labelOf={labelOf} /> },
              { id: 'people', label: 'People', count: linked ? (d.members ?? []).length : undefined, content: <People d={d} path={path} onResult={show} /> },
              { id: 'invitations', label: 'Invitations', count: (d.invitations ?? []).length, hidden: !linked || !(d.invitations ?? []).length, content: <Invitations d={d} path={path} /> },
              { id: 'billing', label: 'Billing', count: d.integrations.stripe ? (d.invoices ?? []).length : undefined, content: <Billing d={d} path={path} /> },
              { id: 'activity', label: 'Tool use', count: d.tools.length, content: <Activity d={d} /> },
              { id: 'errors', label: 'Errors', count: d.errors.length, content: <Errors d={d} /> },
              { id: 'clients', label: 'Clients', count: d.clients.length, content: <Clients d={d} /> },
              { id: 'products', label: 'Research', count: d.research.length, content: <Research d={d} /> },
              { id: 'simulations', label: 'Simulations', count: d.simulations.length, content: <Simulations d={d} /> },
              { id: 'keys', label: 'Legacy keys', count: d.keys.length, content: <Keys d={d} path={path} onResult={show} /> }
            ]}
          />
        </div>
      )}
      {result.dialog}
    </PageContainer>
  );
}

const subTone = (s: string): Tone => (s === 'active' ? 'ok' : s === 'trialing' ? 'info' : /past_due|unpaid|incomplete/.test(s) ? 'bad' : 'neutral');

/** The account's card: name, stage and billing badges, rename and the move to Clerk, the key facts, the 30-day strip
 *  and what needs attention. */
function AccountMeta({ d, path }: { d: Detail; path: string }) {
  const link = useAdminAction(() => post(`${path}/clerk`), { success: 'Moved to Clerk: invite people by email now' });
  const clerkOn = d.integrations.clerk ?? d.integrations.workos;
  const linked = d.org.clerk_org_id ?? d.org.workos_org_id;
  const s = d.org.subscription;
  const active = d.keys.filter((k: any) => !k.revoked_at).length;
  const renew = s?.renews_at ? `${s.cancel_at_period_end ? 'cancels' : 'renews'} ${day(s.renews_at)}` : '';
  const trial = s?.trial_end ? `trial ends ${day(s.trial_end)}` : '';
  return (
    <DetailMeta
      title={d.org.name}
      badges={<>
        <StatusBadge tone={d.org.stage_index >= 6 ? 'ok' : 'info'}>{d.org.stage_label}</StatusBadge>
        {s && <StatusBadge tone={subTone(s.status)}>{s.status.replace(/_/g, ' ')}</StatusBadge>}
        {s?.cancel_at_period_end && <StatusBadge tone='warn'>cancels</StatusBadge>}
        {d.org.attention.length > 0 && <StatusBadge tone='warn'>{`${d.org.attention.length} to look at`}</StatusBadge>}
      </>}
      subtitle={<>Next: {d.org.next_step} · Clerk and Stripe keep the change history (Events).</>}
      actions={<>
        {!linked && clerkOn && <Gate need='accounts'><Button variant='outline' disabled={link.isPending} onClick={() => link.mutate()}>Move to Clerk</Button></Gate>}
        <Rename path={path} name={d.org.name} />
      </>}
      facts={[
        { label: 'Slug', value: <Mono>{d.org.slug}</Mono> },
        { label: 'Created', value: day(d.org.created_at) },
        { label: 'Last seen', value: <When d={d.org.last_seen} /> },
        { label: 'Plan', value: d.integrations.stripe ? <SubBadge sub={s} /> : <span className='text-muted-foreground'>Stripe off</span>,
          hint: [renew, trial].filter(Boolean).join(' · ') || undefined },
        { label: 'Model spend this month', value: `${usd(d.org.month_spend_usd)} of ${d.org.budget_usd ? usd(d.org.budget_usd) : 'no cap'}` },
        { label: 'Access', value: linked ? 'Clerk' : clerkOn ? 'Key links (not on Clerk yet)' : <>Key links (Clerk off: <Mono>CLERK_SECRET_KEY</Mono>)</> },
        { label: 'Members', value: linked ? (d.members ?? []).length : dash },
        { label: 'Active keys', value: active }
      ]}
    >
      {/* Sparklines: the last 30 days (spend: this month), day by day. */}
      <StatStrip
        items={[
          { label: 'Calls in 7 days', value: d.org.calls_7d, spark: d.daily?.calls },
          { label: 'Errors in 7 days', value: d.org.errors_7d, spark: d.daily?.errors },
          { label: 'Model spend this month', value: usd(d.org.month_spend_usd), spark: d.daily?.spend, hint: d.org.budget_usd ? `of ${usd(d.org.budget_usd)} budget` : 'no cap' },
          { label: 'Agent sessions, 30 days', value: d.daily ? d.daily.sessions.reduce((a: number, b: number) => a + b, 0) : '—', spark: d.daily?.sessions }
        ]}
      />
      {d.org.attention.length > 0 && (
        <Notice>
          <b>Needs attention</b>
          <ul className='mt-1 list-disc pl-5'>
            {d.org.attention.map((a: string) => <li key={a}>{a}</li>)}
          </ul>
        </Notice>
      )}
    </DetailMeta>
  );
}

/** A labelled Rename button; the name is edited in a dialog. */
function Rename({ path, name }: { path: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(name);
  useEffect(() => setV(name), [name, open]);
  const rename = useAdminAction(() => adminApi('PATCH', path, { name: v }), { success: 'Renamed' });
  return (
    <>
      <Gate need='accounts'><Button variant='outline' onClick={() => setOpen(true)}><Icons.edit className='size-3.5' /> Rename</Button></Gate>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className='sm:max-w-md'>
          <form
            className='grid gap-4'
            onSubmit={(e) => {
              e.preventDefault();
              rename.mutate(undefined, { onSuccess: () => setOpen(false) });
            }}
          >
            <DialogHeader>
              <DialogTitle>Rename account</DialogTitle>
              <DialogDescription>The slug stays the same.</DialogDescription>
            </DialogHeader>
            <Input autoFocus value={v} onChange={(e) => setV(e.target.value)} aria-label='Account name' />
            <DialogFooter>
              <Button type='button' variant='outline' onClick={() => setOpen(false)}>Cancel</Button>
              <Gate need='accounts'><Button type='submit' disabled={rename.isPending || v.trim() === name || !v.trim()}>Rename</Button></Gate>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The onboarding milestones, reached or not: # | Milestone | Status | Reached. */
function Onboarding({ d, labelOf }: { d: Detail; labelOf: (k: string) => string }) {
  const rows = Object.keys(d.org.reached).map((k, i) => ({ k, i, at: d.org.reached[k] as string | null }));
  return (
    <DetailTable
      rows={rows} rowKey={(r) => r.k} noun='milestones' empty='No milestones.'
      cols={[
        { key: 'i', label: '#', type: 'number', value: (r) => r.i + 1, render: (r) => <span className='text-muted-foreground tabular-nums'>{r.i + 1}</span>, className: 'w-12' },
        { key: 'k', label: 'Milestone', render: (r) => (
          <span className='inline-flex items-center gap-1.5 font-medium'>
            {r.at ? <Icons.circleCheck className='text-primary size-3.5' /> : <Icons.circle className='size-3.5 opacity-40' />}{labelOf(r.k)}
          </span>
        ) },
        { key: 'state', label: 'Status', type: 'select', value: (r) => (r.at ? 'reached' : 'not yet'), render: (r) => <StatusBadge tone={r.at ? 'ok' : 'neutral'}>{r.at ? 'reached' : 'not yet'}</StatusBadge> },
        { key: 'at', label: 'Reached', type: 'date', value: (r) => r.at, render: (r) => (r.at ? <When d={r.at} /> : dash) }
      ]}
    />
  );
}

const inviteTone = (s: string): Tone => (s === 'accepted' ? 'ok' : s === 'pending' ? 'info' : s === 'expired' ? 'warn' : 'neutral');

function People({ d, path, onResult }: { d: Detail; path: string; onResult: (r: InviteResult, t: string) => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const invite = useAdminAction(() => post<InviteResult>(`${path}/invitations`, { email: email.trim(), role }));
  const member = useAdminAction(({ id, action }: { id: string; action: 'deactivate' | 'reactivate' }) => post(`${path}/members/${encodeURIComponent(id)}/${action}`), {
    success: 'Updated'
  });
  const setMemberRole = useAdminAction(({ id, role }: { id: string; role: string }) => post(`${path}/members/${encodeURIComponent(id)}/role`, { role }), {
    success: 'Role changed'
  });
  const clerkOn = d.integrations.clerk ?? d.integrations.workos;
  const linked = d.org.clerk_org_id ?? d.org.workos_org_id;

  const submitInvite = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    invite.mutate(undefined, {
      onSuccess: (r) => {
        setEmail('');
        onResult(r, `Invited to ${r.org.name}`);
      }
    });
  };
  const members = linked ? d.members ?? [] : [];
  return (
    <div className='flex flex-col gap-3'>
      {(d.clerk_error || d.workos_error) && <Notice>Clerk: {d.clerk_error || d.workos_error}</Notice>}
      <DetailTable
        rows={members} rowKey={(m: any) => m.id} noun='members'
        search={(m: any) => `${m.email ?? ''} ${m.name ?? ''} ${m.user_id} ${m.status}`} searchPlaceholder='Search members by email or name'
        empty={linked ? 'Nobody has joined yet.'
          : clerkOn ? 'This account predates Clerk: people connect with key links. Move it to Clerk (above) to invite people by email and let them sign in.'
          : <>Clerk is off (<Mono>CLERK_SECRET_KEY</Mono>). People connect with the legacy key links.</>}
        filters={linked ? (
          <form onSubmit={submitInvite} className='flex flex-wrap gap-2'>
            <Input type='email' required placeholder='colleague@company.com' className='w-full sm:w-72' value={email} onChange={(e) => setEmail(e.target.value)} aria-label='Email to invite' />
            <NativeSelect value={role} onChange={(e) => setRole(e.target.value)} aria-label='Role'>
              {ACCOUNT_ROLES.map((r) => <NativeSelectOption key={r.id} value={r.id}>{r.label}</NativeSelectOption>)}
            </NativeSelect>
            <Gate need='invite'><Button type='submit' disabled={invite.isPending}>
              <Icons.send className='size-3.5' /> Invite
            </Button></Gate>
          </form>
        ) : undefined}
        primary={linked && d.clerk_dashboard ? (
          <a className={buttonVariants({ variant: 'outline' })} href={d.clerk_dashboard} target='_blank' rel='noopener noreferrer'
            title='Enterprise SSO (SAML / OIDC) for an account is set up on its organization in the Clerk dashboard.'>
            Open in Clerk <Icons.externalLink className='size-3.5' />
          </a>
        ) : undefined}
        cols={[
          {
            key: 'person', label: 'Person', type: 'text', value: (m: any) => m.email || m.user_id,
            render: (m: any) => (
              <>
                <div className='font-medium'>{m.email || m.user_id}</div>
                {m.name && <div className='text-muted-foreground text-xs'>{m.name}</div>}
              </>
            )
          },
          {
            key: 'role', label: 'Role', type: 'text', value: (m: any) => accountRoleOf(m),
            render: (m: any) => (
              <Gate need='accounts'><NativeSelect
                size='sm'
                value={accountRoleOf(m)}
                disabled={setMemberRole.isPending}
                onChange={(e) => setMemberRole.mutate({ id: m.id, role: e.target.value })}
                aria-label={`Role for ${m.email || m.user_id}`}
              >
                {ACCOUNT_ROLES.map((r) => <NativeSelectOption key={r.id} value={r.id}>{r.label}</NativeSelectOption>)}
              </NativeSelect></Gate>
            )
          },
          {
            key: 'status', label: 'Status', type: 'select', value: (m: any) => m.status,
            render: (m: any) => <StatusBadge tone={m.status === 'active' ? 'ok' : m.status === 'inactive' ? 'bad' : 'info'}>{m.status === 'inactive' ? 'suspended' : m.status}</StatusBadge>
          },
          { key: 'joined', label: 'Joined', type: 'date', value: (m: any) => m.created_at, render: (m: any) => <When d={m.created_at} /> },
          {
            key: 'act', label: '', className: 'text-right',
            render: (m: any) =>
              m.status === 'active' ? (
                <Gate need='accounts'><ConfirmButton
                  label='Suspend'
                  variant='destructive'
                  title={`Suspend ${m.email || m.user_id}?`}
                  description='They can no longer use Octillion in this account until you restore access. Suspending stops their sign-ins and connector calls; tokens already issued expire within minutes.'
                  confirmLabel='Suspend'
                  onConfirm={() => member.mutate({ id: m.id, action: 'deactivate' })}
                /></Gate>
              ) : m.status === 'inactive' ? (
                <Gate need='accounts'><Button variant='outline' size='sm' onClick={() => member.mutate({ id: m.id, action: 'reactivate' })}>
                  Restore
                </Button></Gate>
              ) : null
          }
        ]}
      />
    </div>
  );
}

function Invitations({ d, path }: { d: Detail; path: string }) {
  const inv = useAdminAction(({ id, action }: { id: string; action: 'resend' | 'revoke' }) => post(`${path}/invitations/${encodeURIComponent(id)}/${action}`), {
    success: (r) => (r ? 'Invitation resent' : 'Invitation revoked')
  });
  return (
    <DetailTable
      rows={d.invitations ?? []} rowKey={(x: any) => x.id} noun='invitations' empty='No invitations.'
      search={(x: any) => `${x.email} ${x.state}`} searchPlaceholder='Search invitations by email'
      defaultSort={[{ key: 'sent', dir: 'desc' }]}
      cols={[
        { key: 'email', label: 'Email', type: 'text', value: (x: any) => x.email, render: (x: any) => x.email },
        { key: 'role', label: 'Role', render: (x: any) => accountRoleLabel(x) },
        { key: 'state', label: 'State', type: 'select', value: (x: any) => x.state, render: (x: any) => <StatusBadge tone={inviteTone(x.state)}>{x.state}</StatusBadge> },
        { key: 'sent', label: 'Sent', type: 'date', value: (x: any) => x.created_at, render: (x: any) => <When d={x.created_at} /> },
        { key: 'expires', label: 'Expires', type: 'date', value: (x: any) => x.expires_at, render: (x: any) => (x.state === 'pending' && x.expires_at ? <When d={x.expires_at} /> : dash) },
        {
          key: 'act', label: '', className: 'text-right',
          render: (x: any) => (
            <div className='flex justify-end gap-2'>
              {(x.state === 'pending' || x.state === 'expired') && (
                <Gate need='invite'><Button variant='outline' size='sm' onClick={() => inv.mutate({ id: x.id, action: 'resend' })}>
                  Resend
                </Button></Gate>
              )}
              {x.state === 'pending' && (
                <Gate need='invite'><ConfirmButton
                  label='Revoke'
                  variant='destructive'
                  title={`Revoke the invitation for ${x.email}?`}
                  description='The link in their email stops working.'
                  confirmLabel='Revoke'
                  onConfirm={() => inv.mutate({ id: x.id, action: 'revoke' })}
                /></Gate>
              )}
            </div>
          )
        }
      ]}
    />
  );
}

/** Invoices, with the plan tools (checkout link, billing portal, Stripe) as the toolbar. */
function Billing({ d, path }: { d: Detail; path: string }) {
  const [plan, setPlan] = useState<string>(d.plans?.[0]?.price_id ?? '');
  const checkout = useAdminAction(() => post<{ url: string }>(`${path}/billing/checkout`, { price_id: plan }));
  const portal = useAdminAction(() => post<{ url: string }>(`${path}/billing/portal`));
  const stripe = !!d.integrations.stripe;
  return (
    <DetailTable
      rows={stripe ? d.invoices : []} rowKey={(x: any) => x.id} noun='invoices'
      empty={stripe ? 'No invoices yet.' : <>Stripe is off (<Mono>STRIPE_SECRET_KEY</Mono>). The account gets the default budget of {usd(d.org.budget_usd)} a month.</>}
      search={stripe ? (x: any) => `${x.number ?? ''} ${x.id} ${x.status}` : undefined} searchPlaceholder='Search invoices'
      defaultSort={[{ key: 'date', dir: 'desc' }]}
      onRow={(x: any) => x.url && window.open(x.url, '_blank', 'noopener')} rowClickable={(x: any) => !!x.url}
      filters={stripe ? (
        <div className='flex flex-wrap gap-2'>
          {d.plans.length ? (
            <>
              <NativeSelect value={plan} onChange={(e) => setPlan(e.target.value)} aria-label='Plan'>
                {d.plans.map((p: any) => (
                  <NativeSelectOption key={p.price_id} value={p.price_id}>
                    {p.name}
                    {p.amount != null ? ` · ${money(p.amount, p.currency)}${p.interval ? `/${p.interval}` : ''}` : ''}
                    {p.monthly_budget_usd != null ? ` · ${usd(p.monthly_budget_usd)} budget` : ''}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <Gate need='accounts'><Button variant='outline' disabled={checkout.isPending} onClick={() => checkout.mutate(undefined, { onSuccess: (r) => copyText(r.url, 'Checkout link copied') })}>
                Copy checkout link
              </Button></Gate>
            </>
          ) : (
            <span className='text-muted-foreground self-center text-sm'>
              No plans: add Stripe prices with a lookup_key starting <Mono>octillion_</Mono>.
            </span>
          )}
        </div>
      ) : undefined}
      primary={stripe ? (<>
        <Gate need='accounts'><Button variant='outline' disabled={portal.isPending} onClick={() => portal.mutate(undefined, { onSuccess: (r) => window.open(r.url, '_blank', 'noopener') })}>
          Open billing portal
        </Button></Gate>
        {d.stripe_dashboard && (
          <a className={buttonVariants({ variant: 'outline' })} href={d.stripe_dashboard} target='_blank' rel='noopener noreferrer'>
            Open in Stripe <Icons.externalLink className='size-3.5' />
          </a>
        )}
      </>) : undefined}
      cols={[
        { key: 'invoice', label: 'Invoice', type: 'text', value: (x: any) => x.number || x.id, render: (x: any) => x.number || x.id },
        { key: 'status', label: 'Status', type: 'select', value: (x: any) => x.status, render: (x: any) => <StatusBadge tone={x.status === 'paid' ? 'ok' : x.status === 'open' ? 'warn' : 'neutral'}>{x.status}</StatusBadge> },
        { key: 'total', label: 'Total', type: 'number', value: (x: any) => Number(x.total), render: (x: any) => money(x.total, x.currency), className: 'text-right tabular-nums' },
        { key: 'date', label: 'Date', type: 'date', value: (x: any) => (typeof x.created === 'number' ? new Date(x.created * 1000).toISOString() : x.created), render: (x: any) => day(typeof x.created === 'number' ? new Date(x.created * 1000).toISOString() : x.created) },
        {
          key: 'v', label: '',
          render: (x: any) =>
            x.url ? (
              <a className='text-primary text-sm underline-offset-4 hover:underline' href={x.url} target='_blank' rel='noopener noreferrer' onClick={(e) => e.stopPropagation()}>
                View
              </a>
            ) : null
        }
      ]}
    />
  );
}

function Activity({ d }: { d: Detail }) {
  return (
    <DetailTable
      rows={d.tools} rowKey={(t: any) => t.name} noun='tools' empty='No tool calls yet.'
      search={(t: any) => t.name} searchPlaceholder='Search tools'
      defaultSort={[{ key: 'calls', dir: 'desc' }]}
      cols={[
        { key: 'tool', label: 'Tool', type: 'text', value: (t: any) => t.name, render: (t: any) => <Mono>{t.name}</Mono> },
        { key: 'calls', label: 'Calls', type: 'number', value: (t: any) => Number(t.calls), render: (t: any) => t.calls, className: 'text-right tabular-nums' },
        { key: 'errors', label: 'Errors', type: 'number', value: (t: any) => Number(t.errors), render: (t: any) => (Number(t.errors) ? <StatusBadge tone='bad'>{t.errors}</StatusBadge> : '0'), className: 'text-right' },
        { key: 'avg', label: 'Avg', type: 'number', value: (t: any) => t.avg_ms, render: (t: any) => (t.avg_ms != null ? `${t.avg_ms} ms` : ''), className: 'text-right tabular-nums' },
        { key: 'last', label: 'Last', type: 'date', value: (t: any) => t.last, render: (t: any) => <When d={t.last} /> }
      ]}
    />
  );
}

function Errors({ d }: { d: Detail }) {
  return (
    <DetailTable
      rows={d.errors} noun='errors' empty='No recent errors.'
      search={(e: any) => `${e.name ?? ''} ${e.method} ${e.error ?? ''}`} searchPlaceholder='Search errors'
      defaultSort={[{ key: 'at', dir: 'desc' }]}
      cols={[
        { key: 'at', label: 'When', type: 'date', value: (e: any) => e.at, render: (e: any) => <When d={e.at} /> },
        { key: 'call', label: 'Call', type: 'text', value: (e: any) => e.name || e.method, render: (e: any) => <Mono>{e.name || e.method}</Mono> },
        { key: 'error', label: 'Error', render: (e: any) => <span className='text-sm'>{e.error}</span> }
      ]}
    />
  );
}

function Clients({ d }: { d: Detail }) {
  return (
    <DetailTable
      rows={d.clients} rowKey={(c: any) => c.client} noun='clients' empty='No clients yet.'
      defaultSort={[{ key: 'n', dir: 'desc' }]}
      cols={[
        { key: 'client', label: 'Client', type: 'text', value: (c: any) => c.client, render: (c: any) => c.client },
        { key: 'n', label: 'Calls', type: 'number', value: (c: any) => Number(c.n), render: (c: any) => c.n, className: 'text-right tabular-nums' },
        { key: 'last', label: 'Last', type: 'date', value: (c: any) => c.last, render: (c: any) => (c.last ? <When d={c.last} /> : dash) }
      ]}
    />
  );
}

function Research({ d }: { d: Detail }) {
  return (
    <DetailTable
      rows={d.research} rowKey={(r: any) => String(r.id)} noun='runs'
      empty={d.products.length ? `Products were added directly, without onboarding research: ${d.products.map((p: any) => p.name).join(', ')}` : 'No product onboarded yet.'}
      defaultSort={[{ key: 'started', dir: 'desc' }]}
      cols={[
        { key: 'product', label: 'Product', type: 'text', value: (r: any) => r.product, render: (r: any) => r.product },
        {
          key: 'status', label: 'Onboarding', type: 'select', value: (r: any) => r.status,
          render: (r: any) => (
            <span className='inline-flex items-center gap-1.5'>
              <StatusBadge tone={r.status === 'completed' ? 'ok' : r.status === 'failed' ? 'bad' : 'info'}>{r.status}</StatusBadge>
              {r.stage && r.status === 'running' && <span className='text-muted-foreground text-xs'>{r.stage}</span>}
            </span>
          )
        },
        { key: 'started', label: 'Started', type: 'date', value: (r: any) => r.created_at, render: (r: any) => <When d={r.created_at} /> },
        // Only errors fill it: shown when a row has one, as in the accounts peek.
        ...(d.research.some((r: any) => r.error) ? [{ key: 'detail', label: 'Detail', render: (r: any) => <span className='text-sm'>{r.error || ''}</span> }] : [])
      ]}
    />
  );
}

function Simulations({ d }: { d: Detail }) {
  return (
    <DetailTable
      rows={d.simulations} rowKey={(s: any) => String(s.id)} noun='simulations' empty='No simulations yet.'
      search={(s: any) => `${s.name} ${s.status}`} searchPlaceholder='Search simulations'
      defaultSort={[{ key: 'started', dir: 'desc' }]}
      cols={[
        { key: 'name', label: 'Simulation', type: 'text', value: (s: any) => s.name, render: (s: any) => s.name },
        { key: 'status', label: 'Status', type: 'select', value: (s: any) => s.status, render: (s: any) => <StatusBadge tone={s.status === 'completed' ? 'ok' : s.status === 'cancelled' ? 'neutral' : 'info'}>{s.status}</StatusBadge> },
        { key: 'sessions', label: 'Sessions', type: 'number', value: (s: any) => Number(s.sessions), render: (s: any) => `${s.completed} / ${s.sessions}`, className: 'text-right tabular-nums' },
        { key: 'started', label: 'Started', type: 'date', value: (s: any) => s.created_at, render: (s: any) => <When d={s.created_at} /> }
      ]}
    />
  );
}

function Keys({ d, path, onResult }: { d: Detail; path: string; onResult: (r: InviteResult, t: string) => void }) {
  const [label, setLabel] = useState('');
  const issue = useAdminAction(() => post<InviteResult>(`${path}/keys`, { label: label.trim() || undefined }));
  const rotate = useAdminAction((id: number) => post<InviteResult>(`${path}/keys/${id}/rotate`));
  const revoke = useAdminAction((id: number) => post(`${path}/keys/${id}/revoke`), { success: 'Key revoked' });
  return (
    <DetailTable
      rows={d.keys} rowKey={(k: any) => String(k.id)} noun='keys'
      empty='No keys. Legacy API keys are from before Clerk sign-in, for clients that send a header (never in the URL). One per person.'
      search={(k: any) => `${k.label} ${k.key_prefix}`} searchPlaceholder='Search keys by label'
      rowClassName={(k: any) => (k.revoked_at ? 'text-muted-foreground' : undefined)}
      filters={
        <form
          className='flex flex-wrap gap-2'
          onSubmit={(e) => {
            e.preventDefault();
            issue.mutate(undefined, {
              onSuccess: (r) => {
                setLabel('');
                onResult(r, `New key for ${r.org.name}`);
              }
            });
          }}
        >
          <Input placeholder='Email or a label' className='w-full sm:w-72' value={label} onChange={(e) => setLabel(e.target.value)} aria-label='Key label' />
          <Gate need='accounts'><Button variant='outline' type='submit' disabled={issue.isPending}>
            Issue key
          </Button></Gate>
        </form>
      }
      cols={[
        { key: 'label', label: 'Label', type: 'text', value: (k: any) => k.label, render: (k: any) => k.label },
        { key: 'key', label: 'Key', render: (k: any) => <Mono>{k.key_prefix}…</Mono> },
        { key: 'created', label: 'Created', type: 'date', value: (k: any) => k.created_at, render: (k: any) => <When d={k.created_at} /> },
        { key: 'used', label: 'Last used', type: 'date', value: (k: any) => k.last_used_at, render: (k: any) => <When d={k.last_used_at} /> },
        {
          key: 'act', label: '', className: 'text-right',
          render: (k: any) =>
            k.revoked_at ? (
              <StatusBadge>
                revoked <When d={k.revoked_at} />
              </StatusBadge>
            ) : (
              <div className='flex justify-end gap-2'>
                <Gate need='delete'><ConfirmButton
                  label='Rotate'
                  title='Rotate this key?'
                  description='The current link stops working now and a new one is shown once.'
                  confirmLabel='Rotate'
                  onConfirm={() => rotate.mutate(k.id, { onSuccess: (r) => onResult(r, `Rotated key for ${r.org.name}`) })}
                /></Gate>
                <Gate need='delete'><ConfirmButton
                  label='Revoke'
                  variant='destructive'
                  title={`Revoke the key for ${k.label}?`}
                  description='Their connector stops working immediately.'
                  confirmLabel='Revoke'
                  onConfirm={() => revoke.mutate(k.id)}
                /></Gate>
              </div>
            )
        }
      ]}
    />
  );
}
