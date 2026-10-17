'use client';
// Access requests from the landing page: approve (a new account, or a person added to one), decline, reopen.
import Link from 'next/link';
import { useMemo, useState } from 'react';
import PageContainer from '@/components/layout/page-container';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Icons } from '@/components/icons';
import { accountHref, post, useAdmin, useAdminAction, type InviteResult, type OrgList } from './lib';
import { useResult } from './result-dialog';
import { Field, RecordView, type RecordCol } from '@/components/layout/record-view';
import { ConfirmButton, ErrorBox, StatusBadge, When } from './ui';

interface Req {
  id: number;
  email: string;
  company: string;
  product_url: string | null;
  message: string | null;
  created_at: string;
  status: 'pending' | 'approved' | 'declined';
  org_slug: string | null;
  org_name: string | null;
}
type Status = 'pending' | 'approved' | 'declined' | 'all';

export function AdminRequests() {
  const [status, setStatus] = useState<Status>('pending');
  const { data, error, isLoading } = useAdmin<{ requests: Req[] }>(`/requests${status === 'all' ? '' : `?status=${status}`}`);
  const [approving, setApproving] = useState<Req | null>(null);
  const result = useResult();
  const decline = useAdminAction((q: Req) => post(`/requests/${q.id}/decline`), { success: 'Declined' });
  const reopen = useAdminAction((q: Req) => post(`/requests/${q.id}/reopen`), { success: 'Back in pending' });

  const link = (q: Req) => (q.product_url ? (/^https?:\/\//.test(q.product_url) ? q.product_url : `https://${q.product_url}`) : null);
  const tone = (q: Req) => (q.status === 'pending' ? 'info' : q.status === 'approved' ? 'ok' : 'neutral') as 'info' | 'ok' | 'neutral';
  const actions = (q: Req) => (
    <div className='flex flex-wrap gap-2'>
      {q.status === 'pending' && (<>
        <Button size='sm' onClick={() => setApproving(q)}><Icons.check className='size-3.5' /> Approve</Button>
        <ConfirmButton label='Decline' title={`Decline ${q.company}?`} description='Nothing is sent to them. You can reopen the request later.' confirmLabel='Decline' onConfirm={() => decline.mutate(q)} />
      </>)}
      {q.status === 'declined' && <Button variant='outline' size='sm' disabled={reopen.isPending} onClick={() => reopen.mutate(q)}>Reopen</Button>}
      {q.status === 'approved' && q.org_slug && <Link className={buttonVariants({ variant: 'outline', size: 'sm' })} href={accountHref(q.org_slug)}>Open {q.org_name}</Link>}
    </div>
  );
  const cols: RecordCol<Req>[] = [
    { key: 'company', label: 'Company', keep: true, render: (q) => <div className='space-y-1'><p className='font-semibold'>{q.company}</p><StatusBadge tone={tone(q)}>{q.status}</StatusBadge></div> },
    { key: 'contact', label: 'Contact', render: (q) => <span className='text-muted-foreground text-sm'>{q.email}</span> },
    { key: 'message', label: 'Message', render: (q) => q.message ? <p className='line-clamp-2 text-sm'>{q.message}</p> : <span className='text-muted-foreground'>—</span> },
    { key: 'at', label: 'Requested', className: 'w-28', keep: true, render: (q) => <When d={q.created_at} className='text-muted-foreground text-xs' /> }
  ];

  return (
    <PageContainer>
      <ErrorBox error={error} />
      <RecordView<Req>
        rows={data?.requests ?? []} rowKey={(q) => String(q.id)} cols={cols} loading={isLoading || !data} noun='requests'
        searchText={(q) => `${q.company} ${q.email} ${q.product_url ?? ''} ${q.message ?? ''} ${q.status}`}
        searchPlaceholder='Search access requests'
        filters={
          <NativeSelect value={status} onChange={(e) => setStatus(e.target.value as Status)} aria-label='Status' className='w-36'>
            <NativeSelectOption value='pending'>Pending</NativeSelectOption>
            <NativeSelectOption value='approved'>Approved</NativeSelectOption>
            <NativeSelectOption value='declined'>Declined</NativeSelectOption>
            <NativeSelectOption value='all'>All</NativeSelectOption>
          </NativeSelect>
        }
        empty={`No ${status === 'all' ? '' : `${status} `}requests.`}
        detailTitle={(q) => q.company}
        detail={(q) => {
          const url = link(q);
          return (
            <div className='flex flex-col gap-5'>
              <dl>
                <Field label='Status'><StatusBadge tone={tone(q)}>{q.status}</StatusBadge></Field>
                <Field label='Email'><a className='text-primary underline-offset-4 hover:underline' href={`mailto:${q.email}`}>{q.email}</a></Field>
                <Field label='Product'>{url ? <a className='inline-flex items-center gap-1 underline-offset-4 hover:underline' href={url} target='_blank' rel='noopener noreferrer'>{q.product_url}<Icons.externalLink className='size-3' /></a> : '—'}</Field>
                <Field label='Requested'><When d={q.created_at} /></Field>
                {q.org_name && <Field label='Account'>{q.org_name}</Field>}
                <Field label='Message'>{q.message ? <p className='whitespace-pre-wrap'>{q.message}</p> : '—'}</Field>
              </dl>
              {actions(q)}
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
      {result.dialog}
    </PageContainer>
  );
}

function ApproveDialog({ req, onClose, onDone }: { req: Req; onClose: () => void; onDone: (r: InviteResult) => void }) {
  const { data } = useAdmin<OrgList>('/orgs');
  const domain = (req.email.split('@')[1] || '').toLowerCase();
  const personal = /gmail|outlook|hotmail|yahoo|proton|icloud/.test(domain);
  const match = useMemo(
    () => (!data || personal ? null : data.orgs.find((o) => (o.contact || '').toLowerCase().split('@')[1] === domain) ?? null),
    [data, personal, domain]
  );
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
