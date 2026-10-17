'use client';
// One account in the accounts page's side peek: what account-detail.tsx showed, without leaving the list. Its actions
// (the row ⋯ menu and the peek header) share one controller, so every dialog and result is rendered once by the page.
import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ActionsMenu, Field, type RowAction } from '@/components/layout/record-view';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { adminApi } from '@/lib/api-client';
import { money, usd } from '@/lib/octillion-format';
import { cn } from '@/lib/utils';
import { Dock } from '@/features/portal/memory';
import { post, STAGE_LABELS, useAdmin, type InviteResult, type OrgRow } from './lib';
import { copyText, ErrorBox, Mono, Notice, StatusBadge, SubBadge, When, type Tone } from './ui';

/** A row of GET /orgs: lib.ts's OrgRow plus the fields shapeOrg (src/admin.ts) also returns. */
export type Org = OrgRow & {
  id: number; created_at: string; stripe_customer_id: string | null; reached: Record<string, string | null>;
  key_last_used: string | null; onboarding_running: number; sims_running: number;
};

/** GET /orgs/:slug (src/admin.ts orgDetail). */
export interface OrgDetail {
  org: Org;
  integrations: { clerk?: boolean; stripe?: boolean; stripe_test_mode?: boolean; default_budget_usd?: number };
  connect: { connector_url: string; secret: boolean; email: { subject: string; body: string } };
  members: { id: string; user_id: string; email: string | null; name?: string | null; role?: string | null; status: string; created_at: string | null }[];
  invitations: { id: string; email: string; role?: string | null; state: string; created_at: string | null; expires_at: string | null }[];
  clerk_error: string | null;
  clerk_dashboard: string | null;
  stripe_dashboard: string | null;
  plans: { price_id: string; name: string; amount: number | null; currency?: string; interval?: string | null; monthly_budget_usd?: number | null }[];
  invoices: { id: string; number: string | null; status: string; total: number; currency: string; created: string | number; url: string | null }[];
  keys: { id: number; label: string; key_prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null }[];
  tools: { name: string; calls: number; errors: number; avg_ms: number | null; last: string }[];
  clients: { client: string; n: number; last: string }[];
  errors: { at: string; method: string; name: string | null; error: string | null }[];
  products: { slug: string; name: string; website_url: string | null; created_at: string }[];
  research: { id: number; product: string; status: string; stage: string | null; error: string | null; created_at: string; finished_at: string | null }[];
  simulations: { id: number; name: string; status: string; created_at: string; finished_at: string | null; sessions: number; completed: number }[];
  requests: { id: number; email: string; company: string; created_at: string; status: string }[];
}

export const orgPath = (slug: string) => `/orgs/${encodeURIComponent(slug)}`;
const day = (d: unknown) => (d ? String(d).slice(0, 10) : '—');
const dash = <span className='text-muted-foreground'>—</span>;

type Kind = 'invite' | 'rename' | 'checkout' | 'key' | 'tip';
export type AccountCtl = ReturnType<typeof useAccountActions>;

/** Dialog state, on-demand detail and plain writes for account actions; render `dialogs` once on the page. */
export function useAccountActions(show: (r: InviteResult, title: string) => void, clerkOn: boolean) {
  const qc = useQueryClient();
  const [dlg, setDlg] = useState<{ kind: Kind; orgs: Org[] } | null>(null);
  // Shares the peek's cache entry, so a row action after opening the peek costs nothing.
  const detailOf = (o: Org) => qc.fetchQuery({ queryKey: ['admin', orgPath(o.slug)], queryFn: () => adminApi<OrgDetail>('GET', orgPath(o.slug)), staleTime: 15_000 });
  const cached = (o: Org) => qc.getQueryData<OrgDetail>(['admin', orgPath(o.slug)]);
  const run = async <R,>(p: () => Promise<R>, ok?: string): Promise<R | undefined> => {
    try {
      const r = await p();
      if (ok) toast.success(ok);
      void qc.invalidateQueries({ queryKey: ['admin'] });
      return r;
    } catch (e) {
      toast.error((e as Error).message);
      return undefined;
    }
  };
  const close = () => setDlg(null);
  return {
    open: (kind: Kind, ...orgs: Org[]) => setDlg({ kind, orgs }),
    detailOf, cached, run, show, clerkOn,
    dialogs: dlg && <AccountDialog key={dlg.kind + dlg.orgs.map((o) => o.slug).join()} kind={dlg.kind} orgs={dlg.orgs} run={run} show={show} close={close} />
  };
}

/** The row ⋯ menu (and the peek's): pass `d` when the detail is at hand, else whatever is cached is used. */
export function accountActions(o: Org, ctl: AccountCtl, d: OrgDetail | undefined = ctl.cached(o)): RowAction[] {
  const p = orgPath(o.slug);
  const fromDetail = (f: (d: OrgDetail) => void) => () => void ctl.detailOf(o).then(f, (e: Error) => toast.error(e.message));
  const ext = (url: string) => () => window.open(url, '_blank', 'noopener');
  const items: RowAction[] = [
    { label: 'Invite person…', icon: <Icons.send />, onSelect: () => ctl.open('invite', o) },
    { label: 'Rename…', icon: <Icons.edit />, onSelect: () => ctl.open('rename', o) },
    { label: 'Copy connector URL', icon: <Icons.plug />, onSelect: fromDetail((x) => copyText(x.connect.connector_url, 'Connector URL copied')) },
    { label: 'Copy welcome email', icon: <Icons.post />, onSelect: fromDetail((x) => copyText(`Subject: ${x.connect.email.subject}\n\n${x.connect.email.body}`, 'Welcome email copied')) },
    { label: 'Billing portal link', icon: <Icons.billing />, onSelect: () => void ctl.run(() => post<{ url: string }>(`${p}/billing/portal`)).then((r) => r && copyText(r.url, 'Billing portal link copied')) },
    { label: 'Checkout link…', icon: <Icons.creditCard />, onSelect: () => ctl.open('checkout', o) },
    { label: 'Issue key…', icon: <Icons.lock />, onSelect: () => ctl.open('key', o) },
    ...(!o.clerk_org_id && ctl.clerkOn ? [{ label: 'Link to Clerk', icon: <Icons.shield />, onSelect: () => void ctl.run(() => post(`${p}/clerk`), 'Moved to Clerk: invite people by email now') }] : []),
    { label: 'Send a tip…', icon: <Icons.chat />, onSelect: () => ctl.open('tip', o) }
  ];
  const links: RowAction[] = [
    ...(d?.clerk_dashboard ? [{ label: 'Clerk dashboard', icon: <Icons.externalLink />, onSelect: ext(d.clerk_dashboard) }] : []),
    ...(d?.stripe_dashboard ? [{ label: 'Stripe dashboard', icon: <Icons.externalLink />, onSelect: ext(d.stripe_dashboard) }] : [])
  ];
  if (links.length) links[0].separator = true;
  return [...items, ...links];
}

/** The peek header: Invite, then the ⋯ menu with the dashboards once the detail has loaded. */
export function AccountPeekActions({ org, ctl }: { org: Org; ctl: AccountCtl }) {
  const { data: d } = useAdmin<OrgDetail>(orgPath(org.slug));
  return (<>
    <Button size='sm' onClick={() => ctl.open('invite', org)}><Icons.send /> Invite</Button>
    <ActionsMenu items={accountActions(org, ctl, d)} />
  </>);
}

// ---------- dialogs ----------

function AccountDialog({ kind, orgs, run, show, close }: { kind: Kind; orgs: Org[]; run: AccountCtl['run']; show: AccountCtl['show']; close: () => void }) {
  const o = orgs[0];
  const p = orgPath(o.slug);
  const [a, setA] = useState(kind === 'rename' ? o.name : '');
  const [role, setRole] = useState('member');
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const { data: d } = useAdmin<OrgDetail>(kind === 'checkout' ? p : null);
  const plan = pick || d?.plans[0]?.price_id || '';
  if (kind === 'tip') return <TipDock orgs={orgs} onClose={close} />;
  const go = async (f: () => Promise<unknown>) => { setBusy(true); await f(); setBusy(false); };
  const spec: Record<Exclude<Kind, 'tip'>, { title: string; description: string; submit: string; ok: boolean; body: ReactNode; act: () => Promise<unknown> }> = {
    invite: {
      title: `Invite to ${o.name}`, description: 'Clerk emails the invitation; without Clerk the person gets a key link.', submit: 'Invite', ok: !!a.trim(),
      body: (<div className='grid gap-3 sm:grid-cols-[1fr_8rem]'>
        <Input type='email' required autoFocus placeholder='colleague@company.com' aria-label='Email' value={a} onChange={(e) => setA(e.target.value)} />
        <NativeSelect aria-label='Role' value={role} onChange={(e) => setRole(e.target.value)} className='w-full'>
          <NativeSelectOption value='member'>Member</NativeSelectOption>
          <NativeSelectOption value='admin'>Admin</NativeSelectOption>
        </NativeSelect>
      </div>),
      act: async () => { const r = await run(() => post<InviteResult>(`${p}/invitations`, { email: a.trim(), role })); if (r) { close(); show(r, `Invited to ${r.org.name}`); } }
    },
    rename: {
      title: 'Rename account', description: `The slug stays ${o.slug}.`, submit: 'Rename', ok: !!a.trim() && a.trim() !== o.name,
      body: <Input autoFocus aria-label='Account name' value={a} onChange={(e) => setA(e.target.value)} />,
      act: async () => { if (await run(() => adminApi('PATCH', p, { name: a.trim() }), 'Renamed') !== undefined) close(); }
    },
    checkout: {
      title: 'Checkout link', description: 'A Stripe Checkout link for this account, copied to send to the customer.', submit: 'Copy checkout link', ok: !!plan,
      body: !d ? <Skeleton className='h-8' /> : d.plans.length ? (
        <NativeSelect aria-label='Plan' value={plan} onChange={(e) => setPick(e.target.value)} className='w-full'>
          {d.plans.map((x) => (
            <NativeSelectOption key={x.price_id} value={x.price_id}>
              {x.name}{x.amount != null ? ` · ${money(x.amount, x.currency)}${x.interval ? `/${x.interval}` : ''}` : ''}{x.monthly_budget_usd != null ? ` · ${usd(x.monthly_budget_usd)} budget` : ''}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : <p className='text-muted-foreground text-sm'>No plans: add Stripe prices with a lookup_key starting <Mono>octillion_</Mono>.</p>,
      act: async () => { const r = await run(() => post<{ url: string }>(`${p}/billing/checkout`, { price_id: plan })); if (r) { copyText(r.url, 'Checkout link copied'); close(); } }
    },
    key: {
      title: 'Issue a key', description: 'A secret connector link, shown once. One per person.', submit: 'Issue key', ok: true,
      body: <Input autoFocus placeholder='Email or a label' aria-label='Key label' value={a} onChange={(e) => setA(e.target.value)} />,
      act: async () => { const r = await run(() => post<InviteResult>(`${p}/keys`, { label: a.trim() || undefined })); if (r) { close(); show(r, `New key for ${r.org.name}`); } }
    }
  };
  const s = spec[kind];
  return (
    <Dialog open onOpenChange={(v) => !v && close()}>
      <DialogContent className='sm:max-w-md'>
        <form className='grid gap-4' onSubmit={(e) => { e.preventDefault(); void go(s.act); }}>
          <DialogHeader>
            <DialogTitle>{s.title}</DialogTitle>
            <DialogDescription>{s.description}</DialogDescription>
          </DialogHeader>
          {s.body}
          <DialogFooter>
            <Button type='button' variant='outline' onClick={close}>Cancel</Button>
            <Button type='submit' disabled={busy || !s.ok}>{s.submit}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A tip to one or more accounts, docked bottom-right: one POST per account (journeys.tsx's TipDock is private). */
export function TipDock({ orgs, onClose }: { orgs: Org[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ journey: 'manual', step: 'announcement', message: '', prompt: '', link: '' });
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    let ok = 0;
    const failed: string[] = [];
    for (const o of orgs) {
      try {
        await post('/journeys/nudges', { org_slug: o.slug, journey: f.journey, step: f.step, message: f.message, prompt: f.prompt || undefined, link: f.link || undefined });
        ok++;
      } catch { failed.push(o.name); }
    }
    setBusy(false);
    void qc.invalidateQueries({ queryKey: ['admin'] });
    if (failed.length) toast.error(`Tip queued for ${ok}; failed for ${failed.join(', ')}`);
    else { toast.success(ok === 1 ? 'Tip queued' : `Tip queued for ${ok} accounts`); onClose(); }
  };
  return (
    <Dock title={orgs.length === 1 ? `Send a tip to ${orgs[0].name}` : `Send a tip to ${orgs.length} accounts`} onClose={onClose}>
      <form className='flex flex-col gap-3 p-4' onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <div className='grid gap-2 sm:grid-cols-2'>
          <Input aria-label='Journey' placeholder='Journey' value={f.journey} onChange={(e) => setF({ ...f, journey: e.target.value })} />
          <Input aria-label='Step' placeholder='Step' value={f.step} onChange={(e) => setF({ ...f, step: e.target.value })} />
        </div>
        <Textarea aria-label='Message' required autoFocus maxLength={280} rows={3} placeholder='The tip, up to 280 characters' value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} className='resize-none' />
        <Input aria-label='Prompt' maxLength={300} placeholder='Prompt to try (optional)' value={f.prompt} onChange={(e) => setF({ ...f, prompt: e.target.value })} />
        <Input aria-label='Link' type='url' placeholder='Link (optional)' value={f.link} onChange={(e) => setF({ ...f, link: e.target.value })} />
        <div className='flex items-center gap-2 border-t pt-3'>
          <Button type='submit' disabled={busy || !f.message.trim()}>Queue tip</Button>
          <span className='text-muted-foreground ml-auto text-xs tabular-nums'>{f.message.length}/280</span>
        </div>
      </form>
    </Dock>
  );
}

// ---------- the peek ----------

/** One confirm dialog for every destructive sub-row action in the peek. */
function useConfirm() {
  const [c, setC] = useState<{ title: string; description: string; label: string; destructive?: boolean; run: () => void } | null>(null);
  return {
    ask: setC,
    dialog: (
      <AlertDialog open={!!c} onOpenChange={(v) => !v && setC(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{c?.title}</AlertDialogTitle>
            <AlertDialogDescription>{c?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant={c?.destructive ? 'destructive' : 'default'} onClick={() => { c?.run(); setC(null); }}>{c?.label}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
  };
}

/** A small flat table that keeps its header and an empty row; the ⋯ column appears when `actions` is given. */
function Sub<T>({ cols, rows, empty, actions, title }: { cols: [string, (r: T) => ReactNode][]; rows: T[]; empty: string; actions?: (r: T) => RowAction[]; title?: string }) {
  return (
    <div className='grid gap-2'>
      {title && <p className='text-sm leading-none font-medium'>{title}</p>}
      <div className='overflow-x-auto border-y'>
        <Table>
          <TableHeader><TableRow>{cols.map(([l]) => <TableHead key={l}>{l}</TableHead>)}{actions && <TableHead className='w-10'><span className='sr-only'>Actions</span></TableHead>}</TableRow></TableHeader>
          <TableBody>
            {rows.length ? rows.map((r, i) => (
              <TableRow key={i}>
                {cols.map(([l, f]) => <TableCell key={l} className='leading-none'>{f(r)}</TableCell>)}
                {actions && <TableCell className='w-10 py-1 text-center'><ActionsMenu items={actions(r)} /></TableCell>}
              </TableRow>
            )) : (
              <TableRow><TableCell colSpan={cols.length + (actions ? 1 : 0)} className='text-muted-foreground py-6 text-center'>{empty}</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

const inviteTone = (s: string): Tone => (s === 'accepted' ? 'ok' : s === 'pending' ? 'info' : s === 'expired' ? 'warn' : 'neutral');
const runTone = (s: string): Tone => (s === 'completed' ? 'ok' : s === 'failed' ? 'bad' : s === 'cancelled' ? 'neutral' : 'info');

/** The body under the peek's property list: attention, the onboarding timeline, then the detail in tabs (fetched lazily). */
export function AccountPeek({ org, ctl }: { org: Org; close?: () => void; ctl: AccountCtl }) {
  const path = orgPath(org.slug);
  const { data: d, error } = useAdmin<OrgDetail>(path);
  const confirm = useConfirm();
  const [tab, setTab] = useState('people');
  useEffect(() => setTab('people'), [org.slug]);
  const stages = Object.keys(org.reached ?? STAGE_LABELS);

  const member = (m: OrgDetail['members'][number]): RowAction[] => {
    const who = m.email || m.user_id;
    const act = (a: string, ok: string, body?: unknown) => () => void ctl.run(() => post(`${path}/members/${encodeURIComponent(m.id)}/${a}`, body), ok);
    return [
      m.role === 'admin' ? { label: 'Make member', onSelect: act('role', 'Role changed', { role: 'member' }) } : { label: 'Make admin', onSelect: act('role', 'Role changed', { role: 'admin' }) },
      ...(m.status === 'active' ? [{ label: 'Suspend…', destructive: true, separator: true, onSelect: () => confirm.ask({ title: `Suspend ${who}?`, description: 'They can no longer use Octillion in this account until you restore access; tokens already issued expire within minutes.', label: 'Suspend', destructive: true, run: act('deactivate', 'Suspended') }) }] : []),
      ...(m.status === 'inactive' ? [{ label: 'Restore', separator: true, onSelect: act('reactivate', 'Restored') }] : [])
    ];
  };
  const invitation = (x: OrgDetail['invitations'][number]): RowAction[] => {
    const act = (a: string, ok: string) => () => void ctl.run(() => post(`${path}/invitations/${encodeURIComponent(x.id)}/${a}`), ok);
    return [
      ...(x.state === 'pending' || x.state === 'expired' ? [{ label: 'Resend', onSelect: act('resend', 'Invitation resent') }] : []),
      ...(x.state === 'pending' ? [{ label: 'Revoke…', destructive: true, separator: true, onSelect: () => confirm.ask({ title: `Revoke the invitation for ${x.email}?`, description: 'The link in their email stops working.', label: 'Revoke', destructive: true, run: act('revoke', 'Invitation revoked') }) }] : [])
    ];
  };
  const key = (k: OrgDetail['keys'][number]): RowAction[] => k.revoked_at ? [] : [
    { label: 'Rotate…', onSelect: () => confirm.ask({ title: 'Rotate this key?', description: 'The current link stops working now and a new one is shown once.', label: 'Rotate',
      run: () => void ctl.run(() => post<InviteResult>(`${path}/keys/${k.id}/rotate`)).then((r) => r && ctl.show(r, `Rotated key for ${r.org.name}`)) }) },
    { label: 'Revoke…', destructive: true, separator: true, onSelect: () => confirm.ask({ title: `Revoke the key for ${k.label}?`, description: 'Their connector stops working immediately.', label: 'Revoke', destructive: true,
      run: () => void ctl.run(() => post(`${path}/keys/${k.id}/revoke`), 'Key revoked') }) }
  ];

  const s = org.subscription;
  const showKeys = !d || !org.clerk_org_id || d.keys.length > 0;
  return (
    <div className='flex flex-col gap-6'>
      {org.attention.length > 0 && (
        <div className='grid gap-2'>
          <p className='text-sm leading-none font-medium'>Needs attention</p>
          <ul className='grid list-disc gap-1.5 pl-5 text-sm leading-none text-amber-400'>{org.attention.map((a) => <li key={a}>{a}</li>)}</ul>
        </div>
      )}

      <div className='grid gap-2'>
        <p className='text-sm leading-none font-medium'>Onboarding</p>
        <ol className='grid gap-x-4 sm:grid-cols-2'>
          {stages.map((k) => {
            const at = org.reached?.[k];
            return (
              <li key={k} className={cn('flex items-center gap-2 border-b py-2 text-sm leading-none', !at && 'text-muted-foreground')}>
                {at ? <Icons.circleCheck className='text-primary size-3.5 shrink-0' /> : <Icons.circle className='size-3.5 shrink-0 opacity-40' />}
                <span className='flex-1 truncate'>{STAGE_LABELS[k] ?? k}</span>
                <span className='text-muted-foreground text-xs'>{at ? <When d={at} /> : 'not yet'}</span>
              </li>
            );
          })}
        </ol>
      </div>

      <ErrorBox error={error} />
      {!d ? (
        <div className='grid gap-3'><Skeleton className='h-8' /><Skeleton className='h-40' /></div>
      ) : (
        <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
          <div className='overflow-x-auto'>
            <TabsList variant='line'>
              <TabsTrigger value='people'>People</TabsTrigger>
              <TabsTrigger value='billing'>Billing</TabsTrigger>
              <TabsTrigger value='activity'>Activity</TabsTrigger>
              <TabsTrigger value='products'>Products & runs</TabsTrigger>
              {showKeys && <TabsTrigger value='keys'>Keys</TabsTrigger>}
              <TabsTrigger value='requests'>Requests</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value='people' className='mt-4 grid gap-6'>
            {d.clerk_error && <Notice>Clerk: {d.clerk_error}</Notice>}
            {!org.clerk_org_id ? (
              <p className='text-muted-foreground text-sm'>
                {d.integrations.clerk
                  ? 'This account predates Clerk: people connect with key links. Use Link to Clerk in the ⋯ menu to invite people by email.'
                  : 'Clerk is off (CLERK_SECRET_KEY). People connect with the legacy key links.'}
              </p>
            ) : (<>
              <Sub title='Members' rows={d.members} empty='Nobody has joined yet.' actions={member} cols={[
                ['Person', (m) => <span className='grid gap-1'><span className='font-medium'>{m.email || m.user_id}</span>{m.name && <span className='text-muted-foreground text-xs'>{m.name}</span>}</span>],
                ['Role', (m) => m.role || 'member'],
                ['Status', (m) => <StatusBadge tone={m.status === 'active' ? 'ok' : m.status === 'inactive' ? 'bad' : 'info'}>{m.status === 'inactive' ? 'suspended' : m.status}</StatusBadge>],
                ['Joined', (m) => <When d={m.created_at} />]
              ]} />
              <Sub title='Invitations' rows={d.invitations} empty='No invitations.' actions={invitation} cols={[
                ['Email', (x) => x.email],
                ['Role', (x) => x.role || 'member'],
                ['State', (x) => <StatusBadge tone={inviteTone(x.state)}>{x.state}</StatusBadge>],
                ['Expires', (x) => (x.state === 'pending' && x.expires_at ? <When d={x.expires_at} /> : dash)]
              ]} />
            </>)}
          </TabsContent>

          <TabsContent value='billing' className='mt-4 grid gap-6'>
            {!d.integrations.stripe ? (
              <p className='text-muted-foreground text-sm'>Stripe is off (STRIPE_SECRET_KEY). The account gets the default budget of {usd(org.budget_usd)} a month.</p>
            ) : (<>
              <dl>
                <Field label='Subscription'><SubBadge sub={s} /></Field>
                <Field label='Plan'>{s?.plan ?? dash}</Field>
                <Field label={s?.cancel_at_period_end ? 'Cancels' : 'Renews'}>{s?.renews_at ? day(s.renews_at) : dash}</Field>
                <Field label='Trial ends'>{s?.trial_end ? day(s.trial_end) : dash}</Field>
                <Field label='Model spend'>{usd(org.month_spend_usd)} of {org.budget_usd ? usd(org.budget_usd) : 'no cap'} this month</Field>
                <Field label='Stripe customer'>{org.stripe_customer_id ? <Mono>{org.stripe_customer_id}</Mono> : dash}</Field>
              </dl>
              <Sub title='Invoices' rows={d.invoices} empty='No invoices yet.' cols={[
                ['Invoice', (x) => x.number || x.id],
                ['Status', (x) => <StatusBadge tone={x.status === 'paid' ? 'ok' : x.status === 'open' ? 'warn' : 'neutral'}>{x.status}</StatusBadge>],
                ['Total', (x) => money(x.total, x.currency)],
                ['Date', (x) => day(typeof x.created === 'number' ? new Date(x.created * 1000).toISOString() : x.created)],
                ['', (x) => x.url ? <a href={x.url} target='_blank' rel='noopener noreferrer' aria-label='Open invoice' className='text-muted-foreground hover:text-foreground'><Icons.externalLink className='size-3.5' /></a> : null]
              ]} />
            </>)}
          </TabsContent>

          <TabsContent value='activity' className='mt-4 grid gap-6'>
            <Sub title='Tools' rows={d.tools} empty='No tool calls yet.' cols={[
              ['Tool', (t) => <Mono>{t.name}</Mono>],
              ['Calls', (t) => <span className='tabular-nums'>{t.calls}</span>],
              ['Errors', (t) => (Number(t.errors) ? <StatusBadge tone='bad'>{t.errors}</StatusBadge> : '0')],
              ['Avg', (t) => (t.avg_ms != null ? `${t.avg_ms} ms` : dash)],
              ['Last', (t) => <When d={t.last} />]
            ]} />
            <Sub title='Clients' rows={d.clients} empty='No clients yet.' cols={[
              ['Client', (c) => c.client],
              ['Calls', (c) => <span className='tabular-nums'>{c.n}</span>],
              ['Last', (c) => <When d={c.last} />]
            ]} />
            <Sub title='Recent errors' rows={d.errors} empty='No errors.' cols={[
              ['When', (e) => <When d={e.at} />],
              ['Call', (e) => <Mono>{e.name || e.method}</Mono>],
              ['Error', (e) => <span className='text-sm whitespace-normal'>{e.error}</span>]
            ]} />
          </TabsContent>

          <TabsContent value='products' className='mt-4 grid gap-6'>
            <Sub title='Products' rows={d.products} empty='No product yet.' cols={[
              ['Product', (x) => x.name],
              ['Website', (x) => x.website_url ? <a href={x.website_url} target='_blank' rel='noopener noreferrer' className='text-muted-foreground hover:text-foreground'>{x.website_url.replace(/^https?:\/\//, '')}</a> : dash],
              ['Added', (x) => <When d={x.created_at} />]
            ]} />
            <Sub title='Onboarding research' rows={d.research} empty='No onboarding research.' cols={[
              ['Product', (r) => r.product],
              ['Status', (r) => <span className='inline-flex items-center gap-1.5'><StatusBadge tone={runTone(r.status)}>{r.status}</StatusBadge>{r.stage && r.status === 'running' && <span className='text-muted-foreground text-xs'>{r.stage}</span>}</span>],
              ['Started', (r) => <When d={r.created_at} />],
              ['Detail', (r) => <span className='text-sm whitespace-normal'>{r.error || ''}</span>]
            ]} />
            <Sub title='Simulations' rows={d.simulations} empty='No simulations yet.' cols={[
              ['Simulation', (x) => x.name],
              ['Status', (x) => <StatusBadge tone={runTone(x.status)}>{x.status}</StatusBadge>],
              ['Sessions', (x) => <span className='tabular-nums'>{x.completed} / {x.sessions}</span>],
              ['Started', (x) => <When d={x.created_at} />]
            ]} />
          </TabsContent>

          {showKeys && (
            <TabsContent value='keys' className='mt-4 grid gap-2'>
              <p className='text-muted-foreground text-xs leading-none'>Secret connector links from before Clerk sign-in, and for clients that can only send a header. Issue one from the ⋯ menu.</p>
              <Sub rows={d.keys} empty='No keys.' actions={key} cols={[
                ['Label', (k) => k.label],
                ['Key', (k) => <Mono>{k.key_prefix}…</Mono>],
                ['Created', (k) => <When d={k.created_at} />],
                ['Last used', (k) => (k.last_used_at ? <When d={k.last_used_at} /> : dash)],
                ['Revoked', (k) => (k.revoked_at ? <When d={k.revoked_at} /> : dash)]
              ]} />
            </TabsContent>
          )}

          <TabsContent value='requests' className='mt-4'>
            <Sub rows={d.requests} empty='No access requests.' cols={[
              ['Email', (r) => r.email],
              ['Company', (r) => r.company],
              ['Status', (r) => r.status],
              ['Requested', (r) => day(r.created_at)]
            ]} />
          </TabsContent>
        </Tabs>
      )}
      {confirm.dialog}
    </div>
  );
}
