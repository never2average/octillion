'use client';
// Access requests from the landing page as a database: views by status, approve (a new account, or a person added to
// one), decline, reopen, one at a time from the ⋯ menu or in bulk. Everything is fetched once and the views filter here.
import { useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { IconCopy, IconMail } from '@tabler/icons-react';
import PageContainer from '@/components/layout/page-container';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Icons } from '@/components/icons';
import { post, useAdmin, useAdminAction, type InviteResult, type OrgList, type OrgRow } from './lib';
import { useResult } from './result-dialog';
import { ActionsMenu, RecordView, type RecordCol, type RecordViewDef, type RowAction } from '@/components/layout/record-view';
import { copyText, ErrorBox, StatusBadge, When } from './ui';

interface Req {
  id: number;
  email: string;
  company: string;
  product_url: string | null;
  message: string | null;
  created_at: string;
  decided_at: string | null;
  status: 'pending' | 'approved' | 'declined';
  org_slug: string | null;
  org_name: string | null;
}
interface Confirm { title: string; body: ReactNode; label: string; run: () => void }

const PERSONAL = /gmail|outlook|hotmail|yahoo|proton|icloud/;
const domainOf = (email: string) => (email.split('@')[1] || '').toLowerCase();
const isWork = (q: Req) => !PERSONAL.test(domainOf(q.email));
/** An existing account whose contact shares the requester's work domain (personal mail never matches). */
export function matchOrg(req: Req, orgs: readonly OrgRow[] | undefined): OrgRow | null {
  const d = domainOf(req.email);
  if (!orgs || !d || !isWork(req)) return null;
  return orgs.find((o) => domainOf(o.contact || '') === d) ?? null;
}
const link = (q: Req) => (q.product_url ? (/^https?:\/\//.test(q.product_url) ? q.product_url : `https://${q.product_url}`) : null);
const host = (q: Req) => { const u = link(q); try { return u ? new URL(u).host.replace(/^www\./, '') : null; } catch { return q.product_url; } };
const TONE = { pending: 'info', approved: 'ok', declined: 'neutral' } as const;
// Days a request waited: still waiting when pending, else until it was decided.
const waited = (q: Req) => {
  const end = q.status === 'pending' ? Date.now() : q.decided_at ? Date.parse(q.decided_at) : NaN;
  const d = Math.floor((end - Date.parse(q.created_at)) / 864e5);
  return Number.isFinite(d) ? Math.max(0, d) : null;
};
const emails = (list: readonly Req[]) => [...new Set(list.map((q) => q.email))].join(', ');
const plural = (n: number) => `${n} request${n === 1 ? '' : 's'}`;
const muted = (s: ReactNode) => <span className='text-muted-foreground block truncate text-sm leading-none'>{s}</span>;

const VIEWS: RecordViewDef<Req>[] = [
  { id: 'pending', label: 'Pending', match: (q) => q.status === 'pending', sort: [{ key: 'created_at', dir: 'asc' }] },
  { id: 'waiting', label: 'Waiting > 2 days', match: (q) => q.status === 'pending' && (waited(q) ?? 0) > 2, sort: [{ key: 'created_at', dir: 'asc' }] },
  { id: 'approved', label: 'Approved', match: (q) => q.status === 'approved', sort: [{ key: 'decided_at', dir: 'desc' }] },
  { id: 'declined', label: 'Declined', match: (q) => q.status === 'declined', sort: [{ key: 'decided_at', dir: 'desc' }] },
  { id: 'all', label: 'All', group: 'status' }
];

export function AdminRequests() {
  const { data, error, isLoading } = useAdmin<{ requests: Req[] }>('/requests');
  const { data: orgList } = useAdmin<OrgList>('/orgs');
  const [approving, setApproving] = useState<Req | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const result = useResult();
  const qc = useQueryClient();
  const decline = useAdminAction((q: Req) => post(`/requests/${q.id}/decline`), { success: 'Declined' });
  const reopen = useAdminAction((q: Req) => post(`/requests/${q.id}/reopen`), { success: 'Back in pending' });
  const rows = useMemo(() => data?.requests ?? [], [data]);
  const matches = useMemo(() => new Map(rows.map((q) => [q.id, matchOrg(q, orgList?.orgs)?.name ?? null])), [rows, orgList]);

  const askDecline = (q: Req) => setConfirm({
    title: `Decline ${q.company}?`, body: 'Nothing is sent to them; you can reopen it later.', label: 'Decline', run: () => decline.mutate(q)
  });
  // Bulk writes go one at a time so a failure is counted, not fatal; one toast and one refetch at the end.
  const runEach = async (list: Req[], verb: 'decline' | 'reopen', clear: () => void) => {
    let failed = 0;
    for (const q of list) { try { await post(`/requests/${q.id}/${verb}`); } catch { failed++; } }
    const ok = list.length - failed, past = verb === 'decline' ? 'Declined' : 'Reopened';
    if (failed) toast.error(`${past} ${ok} of ${plural(list.length)}; ${failed} failed`); else toast.success(`${past} ${plural(ok)}`);
    clear();
    void qc.invalidateQueries({ queryKey: ['admin'] });
  };
  // RecordView keeps the open tab in localStorage under its id; read it back so the menu copies that tab's emails.
  const currentView = () => { try { return VIEWS.find((v) => v.id === JSON.parse(localStorage.getItem('rv:admin-requests:view') ?? 'null')) ?? VIEWS[0]; } catch { return VIEWS[0]; } };

  const copyEmail = (q: Req): RowAction => ({ label: 'Copy email', icon: <IconCopy />, onSelect: () => copyText(q.email, 'Email copied') });
  const statusActions = (q: Req): RowAction[] => [
    ...(q.status === 'pending' ? [{ label: 'Decline', icon: <Icons.close />, destructive: true, onSelect: () => askDecline(q) }] : []),
    ...(q.status === 'declined' ? [{ label: 'Reopen', icon: <Icons.arrowRight />, onSelect: () => reopen.mutate(q) }] : [])
  ];
  const actions = (q: Req): RowAction[] => {
    const url = link(q);
    return [
      ...(q.status === 'pending' ? [{ label: 'Approve…', icon: <Icons.check />, onSelect: () => setApproving(q) }] : []),
      ...statusActions(q),
      { ...copyEmail(q), separator: true },
      ...(url ? [{ label: 'Open product site', icon: <Icons.externalLink />, onSelect: () => window.open(url, '_blank', 'noopener,noreferrer') }] : [])
    ];
  };
  const bulk = (sel: Req[], clear: () => void): RowAction[] => {
    const pending = sel.filter((q) => q.status === 'pending'), declined = sel.filter((q) => q.status === 'declined');
    return [
      { label: `Decline ${pending.length} pending`, icon: <Icons.close />, destructive: true, disabled: !pending.length, onSelect: () => setConfirm({
        title: `Decline ${plural(pending.length)}?`, body: 'Nothing is sent to them; you can reopen them later.', label: 'Decline', run: () => void runEach(pending, 'decline', clear)
      }) },
      { label: `Reopen ${declined.length} declined`, icon: <Icons.arrowRight />, disabled: !declined.length, onSelect: () => setConfirm({
        title: `Reopen ${plural(declined.length)}?`, body: 'They go back to pending.', label: 'Reopen', run: () => void runEach(declined, 'reopen', clear)
      }) },
      { label: 'Copy emails', icon: <IconCopy />, onSelect: () => copyText(emails(sel), `${sel.length} emails copied`) }
    ];
  };

  const cols: RecordCol<Req>[] = [
    { key: 'company', label: 'Company', type: 'text', title: true, keep: true, peek: false, value: (q) => q.company, render: (q) => <span className='font-medium leading-none'>{q.company}</span> },
    { key: 'status', label: 'Status', type: 'select', className: 'w-28', keep: true, value: (q) => q.status,
      options: [{ value: 'pending', label: 'Pending' }, { value: 'approved', label: 'Approved' }, { value: 'declined', label: 'Declined' }],
      render: (q) => <StatusBadge tone={TONE[q.status]}>{q.status}</StatusBadge> },
    { key: 'email', label: 'Email', type: 'text', className: 'w-56', value: (q) => q.email, render: (q) => muted(q.email) },
    { key: 'domain', label: 'Domain', type: 'text', hidden: true, value: (q) => domainOf(q.email), render: (q) => muted(domainOf(q.email) || '—') },
    { key: 'work', label: 'Work email', type: 'boolean', hidden: true, value: isWork, render: (q) => muted(isWork(q) ? 'Yes' : 'No') },
    { key: 'product', label: 'Product', type: 'text', className: 'w-44', value: link, render: (q) => muted(host(q) ?? '—') },
    { key: 'message', label: 'Message', type: 'text', peek: false, value: (q) => q.message, render: (q) => (q.message ? <span className='block max-w-md truncate text-sm leading-none'>{q.message}</span> : muted('—')) },
    { key: 'account', label: 'Account', type: 'text', hidden: true, value: (q) => q.org_name, render: (q) => muted(q.org_name ?? '—') },
    { key: 'match', label: 'Matches account', type: 'text', hidden: true, value: (q) => matches.get(q.id), render: (q) => muted(matches.get(q.id) ?? '—') },
    { key: 'created_at', label: 'Requested', type: 'date', className: 'w-28', keep: true, value: (q) => q.created_at, render: (q) => <When d={q.created_at} className='text-muted-foreground text-xs leading-none' /> },
    { key: 'decided_at', label: 'Decided', type: 'date', className: 'w-28', hidden: true, value: (q) => q.decided_at, render: (q) => <When d={q.decided_at} className='text-muted-foreground text-xs leading-none' /> },
    { key: 'waiting', label: 'Waiting (days)', type: 'number', className: 'w-28', value: waited, render: (q) => { const d = waited(q); return muted(d == null ? '—' : `${d}d`); } }
  ];

  return (
    <PageContainer>
      <ErrorBox error={error} />
      <RecordView<Req>
        id='admin-requests' noun='requests' exportName='access-requests' properties views={VIEWS} defaultSort={[{ key: 'created_at', dir: 'desc' }]}
        rows={rows} rowKey={(q) => String(q.id)} cols={cols} actions={actions} bulk={bulk} loading={isLoading || !data}
        searchText={(q) => `${q.company} ${q.email} ${q.product_url ?? ''} ${q.message ?? ''} ${q.status} ${q.org_name ?? ''}`}
        searchPlaceholder='Search access requests'
        primaryMenu={[{ label: 'Copy emails (current view)', icon: <IconCopy />, onSelect: () => {
          const v = currentView(), list = v.match ? rows.filter(v.match) : rows;
          if (list.length) copyText(emails(list), `${list.length} emails copied`); else toast.info('No requests in this view');
        } }]}
        empty='No pending requests.'
        detailActions={(q) => (<>
          {q.status === 'pending' && <Button size='sm' onClick={() => setApproving(q)}><Icons.check /> Approve</Button>}
          <ActionsMenu items={[...statusActions(q), copyEmail(q)]} />
        </>)}
        detail={(q) => {
          const m = matches.get(q.id);
          return (
            <div className='flex flex-col gap-4 text-sm'>
              <div className='flex flex-col gap-2'>
                <div className='text-muted-foreground text-xs font-medium leading-none'>Message</div>
                {q.message ? <p className='w-full leading-relaxed whitespace-pre-wrap'>{q.message}</p> : <p className='text-muted-foreground leading-none'>No message.</p>}
              </div>
              {m && <p className='text-muted-foreground leading-none'>Same domain as {m}.</p>}
              <a className='text-primary inline-flex items-center gap-1.5 self-start leading-none underline-offset-4 hover:underline' href={`mailto:${q.email}`}>
                <IconMail className='size-4' /> Write to {q.email}
              </a>
            </div>
          );
        }}
      />
      {approving && (
        <ApproveDialog
          req={approving}
          onClose={() => setApproving(null)}
          onDone={(r) => {
            setApproving(null);
            result.show(r, `Approved: ${r.org.name}`);
          }}
        />
      )}
      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant={confirm?.label === 'Decline' ? 'destructive' : 'default'} onClick={() => { confirm?.run(); setConfirm(null); }}>
              {confirm?.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {result.dialog}
    </PageContainer>
  );
}

function ApproveDialog({ req, onClose, onDone }: { req: Req; onClose: () => void; onDone: (r: InviteResult) => void }) {
  const { data } = useAdmin<OrgList>('/orgs');
  const domain = domainOf(req.email);
  const match = useMemo(() => matchOrg(req, data?.orgs), [data, req]);
  const [mode, setMode] = useState<'new' | 'existing' | null>(null);
  const [org, setOrg] = useState<string | null>(null);
  const [name, setName] = useState(req.company);
  const [slug, setSlug] = useState('');
  const [err, setErr] = useState('');
  const m = mode ?? (match ? 'existing' : 'new');
  const chosen = org ?? match?.slug ?? data?.orgs[0]?.slug ?? '';
  const approve = useAdminAction(
    () => post<InviteResult>(`/requests/${req.id}/approve`, m === 'existing' ? { org_slug: chosen } : { name: name.trim(), slug: slug.trim() || undefined }),
    {}
  );
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    approve.mutate(undefined, { onSuccess: onDone, onError: (x) => setErr(x.message) });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-lg'>
        <form onSubmit={submit} className='grid gap-4'>
          <DialogHeader>
            <DialogTitle>Approve request</DialogTitle>
            <DialogDescription>
              {req.company} · {req.email}
            </DialogDescription>
          </DialogHeader>
          <Tabs value={m} onValueChange={(v) => setMode(v as 'new' | 'existing')}>
            <TabsList>
              <TabsTrigger value='new'>New account</TabsTrigger>
              <TabsTrigger value='existing'>Add to an existing account</TabsTrigger>
            </TabsList>
          </Tabs>
          {m === 'new' ? (
            <div className='grid gap-3'>
              <div className='grid gap-1.5'>
                <Label htmlFor='ap-name'>Account name</Label>
                <Input id='ap-name' required value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className='grid gap-1.5'>
                <Label htmlFor='ap-slug'>Slug (optional)</Label>
                <Input id='ap-slug' placeholder='from the name' value={slug} onChange={(e) => setSlug(e.target.value)} />
              </div>
              <p className='text-muted-foreground text-xs'>Clerk invites the requester as the account&apos;s admin.</p>
            </div>
          ) : (
            <div className='grid gap-1.5'>
              <Label htmlFor='ap-org'>Account</Label>
              <NativeSelect id='ap-org' className='w-full' value={chosen} onChange={(e) => setOrg(e.target.value)}>
                {(data?.orgs ?? []).map((o) => (
                  <NativeSelectOption key={o.slug} value={o.slug}>
                    {o.name} ({o.slug})
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <p className='text-muted-foreground text-xs'>Clerk invites them as a member of that account.</p>
            </div>
          )}
          {match && (
            <p className='text-muted-foreground text-xs'>
              {match.name} already has someone from @{domain}.
            </p>
          )}
          {err && <p className='text-destructive text-sm'>{err}</p>}
          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose}>
              Cancel
            </Button>
            <Button type='submit' disabled={approve.isPending}>
              {approve.isPending ? 'Approving…' : 'Approve and invite'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
