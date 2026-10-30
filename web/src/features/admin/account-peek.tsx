'use client';
// One account in the accounts page's side peek: its problems with a fix, a short summary and four tabs, without leaving
// the list. Its actions (the row ⋯ menu and the peek header) share one controller, so every dialog and result is
// rendered once by the page.
import { useEffect, useState, type ReactNode } from 'react';
import { DetailMeta, DetailTable, DetailTabs } from '@/components/layout/detail';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ActionsMenu, type RowAction } from '@/components/layout/record-view';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { adminApi } from '@/lib/api-client';
import { money, usd } from '@/lib/octillion-format';
import { TablePager, usePaged } from '@/components/layout/table-pager';
import { cn } from '@/lib/utils';
import { Sparkline } from '@/components/layout/section';
import { Dock } from '@/features/portal/memory';
import { ACCOUNT_ROLES, accountRoleLabel, accountRoleOf, post, STAGE_LABELS, useAdmin, type InviteResult, type OrgRow } from './lib';
import { copyText, ErrorBox, Mono, StatusBadge, When, type Tone } from './ui';
import { Gate, useAdminRole, type AdminPermission } from './role';

/** A row of GET /orgs: lib.ts's OrgRow plus the fields shapeOrg (src/admin.ts) also returns. */
export type Org = OrgRow & {
  id: number; created_at: string; stripe_customer_id: string | null; reached: Record<string, string | null>;
  key_last_used: string | null; onboarding_running: number; sims_running: number;
};

/** GET /orgs/:slug (src/admin.ts orgDetail). */
export interface OrgDetail {
  org: Org;
  /** Tool calls, errors and agent sessions per day for 30 days; model spend per day this month. */
  daily?: { days: string[]; calls: number[]; errors: number[]; sessions: number[]; month_days: string[]; spend: number[] };
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
/** Whole dollars with separators; cents only under $10, and only when there are some ($4, $4.20, $1,234). */
export const dollars = (n: number | null | undefined) => {
  const v = Number(n || 0);
  const cents = Math.abs(v) < 9.995 && Math.round(v * 100) % 100 !== 0 ? 2 : 0;
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: cents, maximumFractionDigits: cents });
};
const dash = <span className='text-muted-foreground'>—</span>;

type Kind = 'invite' | 'rename' | 'checkout' | 'key' | 'tip' | 'allowance';
export type AccountCtl = ReturnType<typeof useAccountActions>;

/** Dialog state, on-demand detail and plain writes for account actions; render `dialogs` once on the page. */
export function useAccountActions(show: (r: InviteResult, title: string) => void, clerkOn: boolean) {
  const qc = useQueryClient();
  const { lock } = useAdminRole();
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
    detailOf, cached, run, show, clerkOn, lock,
    dialogs: dlg && <AccountDialog key={dlg.kind + dlg.orgs.map((o) => o.slug).join()} kind={dlg.kind} orgs={dlg.orgs} run={run} show={show} close={close} />
  };
}

/** Each account action as a plain function: the ⋯ menus and the peek's problem fixes share them. */
function actionsOf(o: Org, ctl: AccountCtl) {
  const p = orgPath(o.slug);
  const fromDetail = (f: (d: OrgDetail) => void) => () => void ctl.detailOf(o).then(f, (e: Error) => toast.error(e.message));
  return {
    invite: () => ctl.open('invite', o),
    key: () => ctl.open('key', o),
    tip: () => ctl.open('tip', o),
    linkClerk: () => void ctl.run(() => post(`${p}/clerk`), 'Moved to Clerk: invite people by email now'),
    welcome: fromDetail((x) => copyText(`Subject: ${x.connect.email.subject}\n\n${x.connect.email.body}`, 'Welcome email copied')),
    connector: fromDetail((x) => copyText(x.connect.connector_url, 'Connector URL copied')),
    portal: () => void ctl.run(() => post<{ url: string }>(`${p}/billing/portal`)).then((r) => r && copyText(r.url, 'Billing portal link copied')),
    prepaid: (allowed: boolean) => void ctl.run(() => post(`${p}/prepaid`, { allowed }), allowed ? `${o.name} can now subscribe to a prepaid plan` : `${o.name} can no longer subscribe`),
    allowance: () => ctl.open('allowance', o)
  };
}

/** The row ⋯ menu (and the peek's), in groups: people, share, billing, account, dashboards. Pass `d` when the detail
 *  is at hand, else whatever is cached is used. */
export function accountActions(o: Org, ctl: AccountCtl, d: OrgDetail | undefined = ctl.cached(o)): RowAction[] {
  const x = actionsOf(o, ctl);
  const ext = (url: string) => () => window.open(url, '_blank', 'noopener');
  const { lock } = ctl;
  const issue: RowAction = lock({ label: 'Issue key…', icon: <Icons.lock />, onSelect: x.key }, 'accounts');
  const people: RowAction[] = o.clerk_org_id
    ? [lock({ label: 'Invite person…', icon: <Icons.send />, onSelect: x.invite }, 'invite'), issue]
    : [issue, ...(ctl.clerkOn ? [lock({ label: 'Link to Clerk', icon: <Icons.shield />, onSelect: x.linkClerk }, 'accounts')] : [])];
  const groups: RowAction[][] = [
    [...people, lock({ label: 'Send a tip…', icon: <Icons.chat />, onSelect: x.tip }, 'journeys')],
    [
      { label: 'Copy connector URL', icon: <Icons.plug />, onSelect: x.connector },
      { label: 'Copy welcome email', icon: <Icons.post />, onSelect: x.welcome }
    ],
    [
      o.prepaid_allowed
        ? { label: 'Stop allowing a prepaid plan', icon: <Icons.close />, onSelect: () => x.prepaid(false) }
        : { label: 'Allow a prepaid plan', icon: <Icons.check />, onSelect: () => x.prepaid(true) },
      { label: o.allowance_usd != null ? 'Change monthly allowance…' : 'Set monthly allowance…', icon: <Icons.billing />, onSelect: x.allowance },
      { label: 'Copy billing portal link', icon: <Icons.billing />, onSelect: x.portal },
      ...(o.prepaid_allowed ? [{ label: 'Copy checkout link…', icon: <Icons.creditCard />, onSelect: () => ctl.open('checkout', o) }] : [])
    ].map((a) => lock(a, 'accounts')),
    [lock({ label: 'Rename…', icon: <Icons.edit />, onSelect: () => ctl.open('rename', o) }, 'accounts')],
    [
      ...(d?.clerk_dashboard ? [{ label: 'Clerk dashboard', icon: <Icons.externalLink />, onSelect: ext(d.clerk_dashboard) }] : []),
      ...(d?.stripe_dashboard ? [{ label: 'Stripe dashboard', icon: <Icons.externalLink />, onSelect: ext(d.stripe_dashboard) }] : [])
    ]
  ];
  return groups.filter((g) => g.length).flatMap((g) => g.map((a, i) => (i ? a : { ...a, separator: true })));
}

/** The peek header: just the ⋯ menu, with the dashboards once the detail has loaded. */
export function AccountPeekActions({ org, ctl }: { org: Org; ctl: AccountCtl }) {
  const { data: d } = useAdmin<OrgDetail>(orgPath(org.slug));
  return <ActionsMenu items={accountActions(org, ctl, d)} />;
}

// ---------- dialogs ----------

function AccountDialog({ kind, orgs, run, show, close }: { kind: Kind; orgs: Org[]; run: AccountCtl['run']; show: AccountCtl['show']; close: () => void }) {
  const o = orgs[0];
  const p = orgPath(o.slug);
  const [a, setA] = useState(kind === 'rename' ? o.name : kind === 'allowance' && o.allowance_usd != null ? String(o.allowance_usd) : '');
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
          {ACCOUNT_ROLES.map((r) => <NativeSelectOption key={r.id} value={r.id}>{r.label}</NativeSelectOption>)}
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
    allowance: {
      title: `Monthly allowance for ${o.name}`,
      description: 'Model spend this account may use each month, set by you: for your own account, trials or comps. It overrides any plan. Leave it empty to clear it (then a plan, or $0, applies).',
      submit: a.trim() ? 'Set allowance' : 'Clear allowance', ok: a.trim() === '' ? o.allowance_usd != null : Number(a) >= 0,
      body: (<div className='relative'>
        <span className='text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm'>$</span>
        <Input autoFocus inputMode='decimal' placeholder='e.g. 200' aria-label='Monthly allowance in US dollars' value={a} onChange={(e) => setA(e.target.value.replace(/[^0-9.]/g, ''))} className='pl-7' />
      </div>),
      act: async () => { if (await run(() => post(`${p}/allowance`, { usd: a.trim() === '' ? null : Number(a) }), a.trim() ? 'Allowance set' : 'Allowance cleared') !== undefined) close(); }
    },
    key: {
      title: 'Issue a key', description: 'A secret API key, sent in a header (never in the URL), shown once. One per person.', submit: 'Issue key', ok: true,
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
          <Gate need='journeys'><Button type='submit' disabled={busy || !f.message.trim()}>Queue tip</Button></Gate>
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

/** Flat list: muted header, no borders between columns; one muted line, or nothing, when empty. */
/** A section of the panel: an outlined table, paged (10 a page) with the item count, empty ones keep their outline. */
export function List<T>({ title, rows, cols, empty, actions, rowClassName }: {
  title: string; rows: T[]; cols: [string, (r: T) => ReactNode, string?][]; empty?: string; actions?: (r: T) => RowAction[]; rowClassName?: (r: T) => string | undefined;
}) {
  const p = usePaged(rows, 10);
  return (
    <div className='grid gap-2'>
      <p className='text-sm leading-none font-medium'>{title}</p>
      <div className='overflow-x-auto border'>
        <Table>
          <TableHeader>
            <TableRow className='hover:bg-transparent'>
              {cols.map(([l, , c], i) => <TableHead key={i} className={cn('text-muted-foreground h-8 px-3 text-xs font-normal', c)}>{l}</TableHead>)}
              {actions && <TableHead className='h-8 w-8'><span className='sr-only'>Actions</span></TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {p.rows.map((r, i) => (
              <TableRow key={i} className={rowClassName?.(r)}>
                {cols.map(([, f, c], j) => <TableCell key={j} className={cn('px-3 py-2.5 text-sm leading-none', c)}>{f(r)}</TableCell>)}
                {actions && <TableCell className='w-8 py-1 text-right'><ActionsMenu items={actions(r)} /></TableCell>}
              </TableRow>
            ))}
            {!rows.length && (
              <TableRow className='hover:bg-transparent'>
                <TableCell colSpan={cols.length + (actions ? 1 : 0)} className='text-muted-foreground py-6 text-center text-sm'>{empty ?? 'Nothing yet.'}</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <TablePager p={p} noun={title.toLowerCase()} className='py-0' />
    </div>
  );
}

// Status is a plain word: colour only for warn and bad.
const toneText: Record<Tone, string> = { ok: 'text-muted-foreground', neutral: 'text-muted-foreground', warn: 'text-amber-700 dark:text-amber-400', bad: 'text-destructive', info: '' };
const word = (tone: Tone, s: ReactNode) => <span className={toneText[tone]}>{s}</span>;
const runTone = (s: string): Tone => (s === 'completed' ? 'ok' : s === 'failed' ? 'bad' : s === 'cancelled' ? 'neutral' : 'info');
const count = (n: number | null | undefined) => (n == null ? dash : Number(n) ? <span className='tabular-nums'>{n}</span> : <span className='text-muted-foreground tabular-nums'>0</span>);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const host = (u: string) => { try { return new URL(u).host; } catch { return u.replace(/^https?:\/\//, ''); } };
const amber = 'text-amber-700 dark:text-amber-400';
/** Plain text that copies itself on click or Enter. */
const CopyText = ({ value, ok }: { value: string; ok: string }) => (
  <button type='button' title='Copy' aria-label={`Copy ${value}`} onClick={() => copyText(value, ok)} className='cursor-pointer text-left leading-none hover:underline focus-visible:underline focus-visible:outline-none'>{value}</button>
);

/** The one-click fix for an attention message (src/admin.ts shapeOrg), or null when there is none. */
function fixFor(a: string, o: Org, d: OrgDetail | undefined, ctl: AccountCtl, view: (tab: string) => void): { label: string; onSelect: () => void; need?: AdminPermission } | null {
  const x = actionsOf(o, ctl);
  if (a.startsWith('Nobody can get in')) {
    if (ctl.clerkOn && !o.clerk_org_id) return { label: 'Link to Clerk', onSelect: x.linkClerk, need: 'accounts' };
    return o.clerk_org_id ? { label: 'Invite…', onSelect: x.invite, need: 'invite' } : { label: 'Issue key…', onSelect: x.key, need: 'accounts' };
  }
  if (a.startsWith('Created ') && a.includes('nobody invited')) return { label: 'Invite…', onSelect: x.invite, need: 'invite' };
  if (a.startsWith('Invitation expired for ')) {
    // The message lists the emails exactly ("Invitation expired for a@x, b@x: resend it"); members are already left out.
    const emails = new Set(a.slice('Invitation expired for '.length).replace(/: resend it$/, '').split(', '));
    const joined = new Set(d?.members.map((m) => m.email ?? ''));
    const expired = d?.invitations.filter((i) => i.state === 'expired' && emails.has(i.email) && !joined.has(i.email)) ?? [];
    if (!expired.length) return null;
    const p = orgPath(o.slug);
    return { label: 'Resend', onSelect: () => void ctl.run(() => Promise.all(expired.map((i) => post(`${p}/invitations/${encodeURIComponent(i.id)}/resend`))), 'Invitation resent'), need: 'invite' };
  }
  if ((a.startsWith('Joined ') && a.includes('never connected')) || a.startsWith('Connected but never called')) return { label: 'Copy welcome email', onSelect: x.welcome };
  if (['Using tools but has not onboarded', 'Product onboarded, no simulation', 'Simulation ran, report never opened'].some((m) => a.startsWith(m))) return { label: 'Send a tip…', onSelect: x.tip, need: 'journeys' };
  if (a.startsWith('Stripe subscription is') || a.startsWith('Subscription cancels')) return { label: 'Copy portal link', onSelect: x.portal, need: 'accounts' };
  if (a.startsWith('Product onboarding failed') || a.includes('tool errors')) return { label: 'View', onSelect: () => view('usage') };
  return null;
}

/** Plan and where the subscription stands; "active" goes without saying. `stripeOn` is unknown until the detail loads. */
function planLine(s: Org['subscription'], stripeOn: boolean | undefined): ReactNode {
  if (stripeOn === undefined && !s) return dash;
  if (stripeOn === false) return <span className='text-muted-foreground'>Stripe off</span>;
  if (!s) return <span className='text-muted-foreground'>No subscription</span>;
  const state = s.cancel_at_period_end ? <span className={amber}>cancels <When d={s.renews_at} /></span>
    : s.status === 'trialing' ? <>trial ends <When d={s.trial_end} /></>
    : s.status === 'active' ? (s.renews_at ? <>renews <When d={s.renews_at} /></> : null)
    : <span className={['past_due', 'unpaid', 'incomplete'].includes(s.status) ? 'text-destructive' : undefined}>{s.status.replace(/_/g, ' ')}</span>;
  return <>{s.plan ?? 'No plan'}{state && <><span className='text-muted-foreground'> · </span>{state}</>}</>;
}

/** The card (problems with their fix, the account's facts, the ⋯ menu), then a tab per list (fetched lazily). */
export function AccountPeek({ org, ctl, actions }: { org: Org; ctl: AccountCtl; actions?: ReactNode }) {
  const path = orgPath(org.slug);
  const { data: d, error } = useAdmin<OrgDetail>(path);
  const confirm = useConfirm();
  const [tab, setTab] = useState<string | undefined>(undefined);
  // The next record in the peek opens on its first tab.
  useEffect(() => setTab(undefined), [org.slug]);

  const member = (m: OrgDetail['members'][number]): RowAction[] => {
    const who = m.email || m.user_id;
    const act = (a: string, ok: string, body?: unknown) => () => void ctl.run(() => post(`${path}/members/${encodeURIComponent(m.id)}/${a}`, body), ok);
    return ([
      ...ACCOUNT_ROLES.filter((r) => r.id !== accountRoleOf(m)).map((r) => ({ label: `Make ${r.label.toLowerCase()}`, onSelect: act('role', 'Role changed', { role: r.id }) })),
      ...(m.status === 'active' ? [{ label: 'Suspend…', destructive: true, separator: true, onSelect: () => confirm.ask({ title: `Suspend ${who}?`, description: 'They can no longer use Octillion in this account until you restore access; tokens already issued expire within minutes.', label: 'Suspend', destructive: true, run: act('deactivate', 'Suspended') }) }] : []),
      ...(m.status === 'inactive' ? [{ label: 'Restore', separator: true, onSelect: act('reactivate', 'Restored') }] : [])
    ] as RowAction[]).map((a) => ctl.lock(a, 'accounts'));
  };
  const invitation = (x: OrgDetail['invitations'][number]): RowAction[] => {
    const act = (a: string, ok: string) => () => void ctl.run(() => post(`${path}/invitations/${encodeURIComponent(x.id)}/${a}`), ok);
    return ([
      ...(x.state === 'pending' || x.state === 'expired' ? [{ label: 'Resend', onSelect: act('resend', 'Invitation resent') }] : []),
      ...(x.state === 'pending' ? [{ label: 'Revoke…', destructive: true, separator: true, onSelect: () => confirm.ask({ title: `Revoke the invitation for ${x.email}?`, description: 'The link in their email stops working.', label: 'Revoke', destructive: true, run: act('revoke', 'Invitation revoked') }) }] : [])
    ] as RowAction[]).map((a) => ctl.lock(a, 'invite'));
  };
  const key = (k: OrgDetail['keys'][number]): RowAction[] => k.revoked_at ? [] : ([
    { label: 'Rotate…', onSelect: () => confirm.ask({ title: 'Rotate this key?', description: 'The current link stops working now and a new one is shown once.', label: 'Rotate',
      run: () => void ctl.run(() => post<InviteResult>(`${path}/keys/${k.id}/rotate`)).then((r) => r && ctl.show(r, `Rotated key for ${r.org.name}`)) }) },
    { label: 'Revoke…', destructive: true, separator: true, onSelect: () => confirm.ask({ title: `Revoke the key for ${k.label}?`, description: 'Their connector stops working immediately.', label: 'Revoke', destructive: true,
      run: () => void ctl.run(() => post(`${path}/keys/${k.id}/revoke`), 'Key revoked') }) }
  ] as RowAction[]).map((a) => ctl.lock(a, 'delete'));

  const s = org.subscription;
  const stripeOn = d ? !!d.integrations.stripe : undefined;
  const access = org.clerk_org_id
    ? ['Clerk', org.members > 0 && plural(org.members, 'member'), org.pending_invites > 0 && `${org.pending_invites} invited`, org.active_keys > 0 && plural(org.active_keys, 'key')]
    : ['Key links', org.active_keys > 0 && plural(org.active_keys, 'key')];
  const running = org.onboarding_running + org.sims_running;
  const over = org.budget_usd > 0 && org.month_spend_usd >= org.budget_usd * 0.8;
  const stages = Object.keys(org.reached ?? STAGE_LABELS);
  const keys = d ? [...d.keys].sort((a, b) => Number(!!a.revoked_at) - Number(!!b.revoked_at)) : [];
  const req = d?.requests[0];
  const subState = s ? (s.cancel_at_period_end ? 'cancels' : s.status.replace(/_/g, ' ')) : null;
  const subTone: Tone = !s ? 'neutral' : s.cancel_at_period_end ? 'warn' : s.status === 'active' ? 'ok' : s.status === 'trialing' ? 'info' : ['past_due', 'unpaid', 'incomplete'].includes(s.status) ? 'bad' : 'neutral';
  const milestones = stages.filter((k) => org.reached?.[k]).map((k) => ({ k, at: org.reached[k] }));
  const view = (t: string) => setTab(t === 'usage' ? 'tools' : t);

  return (
    <div className='flex flex-col gap-4'>
      <DetailMeta
        title={org.name}
        badges={<>
          <StatusBadge tone={org.stage_index >= 6 ? 'ok' : 'info'}>{org.stage_label}</StatusBadge>
          {subState && <StatusBadge tone={subTone}>{subState}</StatusBadge>}
          {org.attention.length > 0 && <StatusBadge tone='warn'>{`${org.attention.length} to look at`}</StatusBadge>}
        </>}
        actions={actions ?? <AccountPeekActions org={org} ctl={ctl} />}
        facts={[
          { label: 'Customer', value: org.stripe_customer_id ? <CopyText value={org.stripe_customer_id} ok='Customer id copied' /> : <span className='text-muted-foreground'>{stripeOn ? 'No Stripe customer yet' : 'Stripe off'}</span> },
          { label: 'Stage', value: org.stage_label, hint: `next: ${org.next_step}` },
          { label: 'Access', value: org.members || org.pending_invites || org.active_keys ? access.filter(Boolean).join(' · ') : <span className='text-muted-foreground'>No one yet</span> },
          { label: 'Last seen', value: org.last_seen ? <When d={org.last_seen} /> : <span className='text-muted-foreground'>Never connected</span>,
            hint: org.last_seen ? <>{org.calls_7d} calls 7d{org.errors_7d > 0 && <> · <span className='text-destructive'>{org.errors_7d} errors</span></>}{running > 0 && <> · {running} running</>}</> : undefined },
          { label: 'Plan', value: planLine(s, stripeOn), hint: org.prepaid_allowed ? 'may subscribe' : 'invite-only, not allowed' },
          { label: 'Allowance', value: org.budget_source === 'override' ? <>{dollars(org.allowance_usd)}/month</>
              : org.budget_source === 'plan' ? <>{dollars(org.budget_usd)}/month</>
              : <span className={amber}>$0: no runs until a plan or an allowance</span>,
            hint: org.budget_source === 'override' ? 'set by an admin' : org.budget_source === 'plan' ? 'from the plan' : undefined },
          { label: 'Spend this month', value: <span className={cn('tabular-nums', over && amber)}>{dollars(org.month_spend_usd)} of {dollars(org.budget_usd)}</span> },
          { label: 'Contact', value: <CopyText value={org.contact ?? ''} ok='Email copied' />, hidden: !org.contact },
          { label: 'Slug', value: <CopyText value={org.slug} ok='Slug copied' /> },
          { label: 'Created', value: <When d={org.created_at} />, hint: req ? <>requested <When d={req.created_at} /> by {req.email}</> : undefined }
        ]}
      >
        {d?.daily && (
          <div className='text-muted-foreground flex flex-wrap gap-x-8 gap-y-2 border-t pt-3 text-xs'>
            <span className='flex items-center gap-2' title='Tool calls per day, last 30 days'>Calls, 30 days <Sparkline values={d.daily.calls} /></span>
            {d.daily.spend.length > 1 && <span className='flex items-center gap-2' title='Model spend per day, this month'>Spend, this month <Sparkline values={d.daily.spend} /></span>}
          </div>
        )}
        {org.attention.length > 0 && (
          <div className='border-t'>
            {org.attention.map((a) => {
              const fix = fixFor(a, org, d, ctl, view);
              return (
                <div key={a} className='flex items-center gap-3 border-b py-2.5 text-sm leading-none last:border-b-0'>
                  <Icons.warning className='size-3.5 shrink-0 text-amber-700 dark:text-amber-400' />
                  <span className='min-w-0 flex-1 truncate text-amber-700 dark:text-amber-400' title={a}>{a}</span>
                  {fix && (() => {
                    const b = <Button variant='outline' size='xs' className='-my-1.5' onClick={fix.onSelect}>{fix.label}</Button>;
                    return fix.need ? <Gate need={fix.need}>{b}</Gate> : b;
                  })()}
                </div>
              );
            })}
          </div>
        )}
      </DetailMeta>

      <ErrorBox error={error} />
      {!d ? (!error &&
        <div className='grid gap-3'><Skeleton className='h-8 w-80' /><Skeleton className='h-40' /></div>
      ) : (
        <DetailTabs value={tab} onValueChange={setTab} tabs={[
          { id: 'members', label: 'Members', count: d.members.length, hidden: !org.clerk_org_id, content: (
            <DetailTable rows={d.members} rowKey={(m) => m.id} noun='members' empty='Nobody has joined yet.' actions={member}
              search={(m) => `${m.email ?? ''} ${m.name ?? ''} ${m.user_id}`} searchPlaceholder='Search members' cols={[
              { key: 'person', label: 'Person', type: 'text', value: (m) => m.email || m.user_id, render: (m) => <>{m.email || m.user_id}{m.name && <span className='text-muted-foreground ml-2'>{m.name}</span>}</> },
              { key: 'role', label: 'Role', type: 'text', value: (m) => accountRoleLabel(m), render: (m) => accountRoleLabel(m) },
              { key: 'status', label: 'Status', type: 'select', value: (m) => m.status, render: (m) => (m.status === 'inactive' ? word('bad', 'suspended') : word(m.status === 'active' || m.status === 'pending' ? 'ok' : 'info', m.status)) },
              { key: 'joined', label: 'Joined', type: 'date', value: (m) => m.created_at, render: (m) => <When d={m.created_at} /> }
            ]} />
          ) },
          { id: 'invitations', label: 'Invitations', count: d.invitations.length, hidden: !org.clerk_org_id, content: (
            <DetailTable rows={d.invitations} rowKey={(x) => x.id} noun='invitations' empty='No invitations.' actions={invitation} cols={[
              { key: 'email', label: 'Email', type: 'text', value: (x) => x.email, render: (x) => x.email },
              { key: 'role', label: 'Role', render: (x) => accountRoleLabel(x) },
              { key: 'state', label: 'State', type: 'select', value: (x) => x.state, render: (x) => word(x.state === 'expired' ? 'warn' : x.state === 'pending' ? 'ok' : 'info', x.state) },
              { key: 'expires', label: 'Expires', type: 'date', value: (x) => x.expires_at, render: (x) => (x.state === 'pending' && x.expires_at ? <When d={x.expires_at} /> : dash) }
            ]} />
          ) },
          { id: 'keys', label: 'Keys', count: keys.length, hidden: !!org.clerk_org_id && d.keys.length === 0, content: (
            <DetailTable rows={keys} rowKey={(k) => String(k.id)} noun='keys' empty='No keys.' actions={key} rowClassName={(k) => (k.revoked_at ? 'text-muted-foreground' : undefined)} cols={[
              { key: 'label', label: 'Label', type: 'text', value: (k) => k.label, render: (k) => k.label },
              { key: 'key', label: 'Key', render: (k) => <span className='tabular-nums'>{k.key_prefix}…</span> },
              { key: 'used', label: 'Last used', type: 'date', value: (k) => k.revoked_at ?? k.last_used_at, render: (k) => (k.revoked_at ? <>revoked <When d={k.revoked_at} /></> : <When d={k.last_used_at} />) },
              { key: 'created', label: 'Created', type: 'date', value: (k) => k.created_at, render: (k) => <When d={k.created_at} /> }
            ]} />
          ) },
          { id: 'tools', label: 'Tools', count: d.tools.length, content: (
            <DetailTable rows={d.tools} rowKey={(t) => t.name} noun='tools' empty='No tool calls yet.' search={(t) => t.name} searchPlaceholder='Search tools' cols={[
              { key: 'tool', label: 'Tool', type: 'text', value: (t) => t.name, render: (t) => t.name },
              { key: 'calls', label: 'Calls', type: 'number', value: (t) => Number(t.calls), render: (t) => count(t.calls), className: 'text-right tabular-nums' },
              { key: 'errors', label: 'Errors', type: 'number', value: (t) => Number(t.errors), render: (t) => (Number(t.errors) ? <span className='text-destructive'>{t.errors}</span> : count(0)), className: 'text-right tabular-nums' },
              { key: 'avg', label: 'Avg', type: 'number', value: (t) => t.avg_ms, render: (t) => (t.avg_ms != null ? `${t.avg_ms} ms` : dash), className: 'text-right tabular-nums' },
              { key: 'last', label: 'Last', type: 'date', value: (t) => t.last, render: (t) => <When d={t.last} /> }
            ]} />
          ) },
          { id: 'errors', label: 'Errors', count: d.errors.length, content: (
            <DetailTable rows={d.errors} noun='errors' empty='No recent errors.' defaultSort={[{ key: 'at', dir: 'desc' }]} cols={[
              { key: 'at', label: 'When', type: 'date', value: (e) => e.at, render: (e) => <When d={e.at} /> },
              { key: 'call', label: 'Call', type: 'text', value: (e) => e.name || e.method, render: (e) => e.name || e.method },
              { key: 'error', label: 'Error', render: (e) => e.error, className: 'whitespace-normal leading-snug' }
            ]} />
          ) },
          { id: 'clients', label: 'Clients', count: d.clients.length, content: (
            <DetailTable rows={d.clients} rowKey={(c) => c.client} noun='clients' empty='No clients yet.' cols={[
              { key: 'client', label: 'Client', type: 'text', value: (c) => c.client, render: (c) => c.client },
              { key: 'n', label: 'Calls', type: 'number', value: (c) => Number(c.n), render: (c) => count(c.n), className: 'text-right tabular-nums' },
              { key: 'last', label: 'Last', type: 'date', value: (c) => c.last, render: (c) => <When d={c.last} /> }
            ]} />
          ) },
          { id: 'products', label: 'Products', count: d.products.length, content: (
            <DetailTable rows={d.products} rowKey={(x) => x.slug} noun='products' empty='No product yet.' cols={[
              { key: 'name', label: 'Product', type: 'text', value: (x) => x.name, render: (x) => x.name },
              { key: 'site', label: 'Website', render: (x) => (x.website_url ? <a href={x.website_url} target='_blank' rel='noopener noreferrer' className='text-muted-foreground hover:text-foreground'>{host(x.website_url)}</a> : dash) },
              { key: 'added', label: 'Added', type: 'date', value: (x) => x.created_at, render: (x) => <When d={x.created_at} /> }
            ]} />
          ) },
          { id: 'research', label: 'Research', count: d.research.length, content: (
            <DetailTable rows={d.research} rowKey={(r) => String(r.id)} noun='runs' empty='No onboarding research yet.' defaultSort={[{ key: 'started', dir: 'desc' }]} cols={[
              { key: 'product', label: 'Product', type: 'text', value: (r) => r.product, render: (r) => r.product },
              { key: 'status', label: 'Status', type: 'select', value: (r) => r.status, render: (r) => <>{word(runTone(r.status), r.status)}{r.stage && r.status === 'running' && <span className='text-muted-foreground ml-1.5'>{r.stage}</span>}</> },
              { key: 'started', label: 'Started', type: 'date', value: (r) => r.created_at, render: (r) => <When d={r.created_at} /> },
              ...(d.research.some((r) => r.error) ? [{ key: 'detail', label: 'Detail', render: (r: OrgDetail['research'][number]) => (r.error ? <span className='text-destructive'>{r.error}</span> : null), className: 'whitespace-normal leading-snug' }] : [])
            ]} />
          ) },
          { id: 'simulations', label: 'Simulations', count: d.simulations.length, content: (
            <DetailTable rows={d.simulations} rowKey={(x) => String(x.id)} noun='simulations' empty='No simulations yet.' defaultSort={[{ key: 'started', dir: 'desc' }]} cols={[
              { key: 'name', label: 'Simulation', type: 'text', value: (x) => x.name, render: (x) => x.name },
              { key: 'status', label: 'Status', type: 'select', value: (x) => x.status, render: (x) => word(runTone(x.status), x.status) },
              { key: 'sessions', label: 'Sessions', type: 'number', value: (x) => Number(x.sessions), render: (x) => `${x.completed} / ${x.sessions}`, className: 'text-right tabular-nums' },
              { key: 'started', label: 'Started', type: 'date', value: (x) => x.created_at, render: (x) => <When d={x.created_at} /> }
            ]} />
          ) },
          { id: 'invoices', label: 'Invoices', count: d.invoices.length, hidden: !d.integrations.stripe, content: (
            <DetailTable rows={d.invoices} rowKey={(x) => x.id} noun='invoices' empty='No invoices yet.' defaultSort={[{ key: 'date', dir: 'desc' }]}
              onRow={(x) => x.url && window.open(x.url, '_blank', 'noopener')} cols={[
              { key: 'invoice', label: 'Invoice', type: 'text', value: (x) => x.number || x.id, render: (x) => x.number || x.id },
              { key: 'status', label: 'Status', type: 'select', value: (x) => x.status, render: (x) => word(x.status === 'paid' ? 'ok' : x.status === 'open' ? 'warn' : x.status === 'uncollectible' ? 'bad' : 'neutral', x.status) },
              { key: 'total', label: 'Total', type: 'number', value: (x) => Number(x.total), render: (x) => money(x.total, x.currency), className: 'text-right tabular-nums' },
              { key: 'date', label: 'Date', type: 'date', value: (x) => (typeof x.created === 'number' ? new Date(x.created * 1000).toISOString() : x.created), render: (x) => <When d={typeof x.created === 'number' ? new Date(x.created * 1000) : x.created} /> },
              { key: 'open', label: '', render: (x) => (x.url ? <a href={x.url} target='_blank' rel='noopener noreferrer' onClick={(e) => e.stopPropagation()} className='text-primary text-sm underline-offset-4 hover:underline'>View</a> : null), className: 'text-right' }
            ]} />
          ) },
          { id: 'milestones', label: 'Milestones', count: milestones.length, content: (
            <DetailTable rows={milestones} rowKey={(m) => m.k} noun='milestones' empty='No milestone reached yet.' cols={[
              { key: 'k', label: 'Milestone', render: (m) => STAGE_LABELS[m.k] ?? m.k },
              { key: 'at', label: 'Reached', type: 'date', value: (m) => m.at, render: (m) => <When d={m.at} /> }
            ]} />
          ) }
        ]} />
      )}

      {confirm.dialog}
    </div>
  );
}
