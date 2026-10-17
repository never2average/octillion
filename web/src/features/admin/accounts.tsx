'use client';
// Every account, where it is in onboarding, its people and plan, and whether it is being used.
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import PageContainer from '@/components/layout/page-container';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Icons } from '@/components/icons';
import { usd } from '@/lib/octillion-format';
import { accountHref, post, useAdmin, useAdminAction, type InviteResult, type OrgList, type OrgRow } from './lib';
import { useResult } from './result-dialog';
import { DataList, ErrorBox, Notice, StageDots, StatusBadge, SubBadge, When } from './ui';
import { Skeleton } from '@/components/ui/skeleton';

type Sort = 'created' | 'seen' | 'calls' | 'stage' | 'attention';

export function AdminAccounts() {
  const router = useRouter();
  const { data, error, isLoading } = useAdmin<OrgList>('/orgs');
  const { data: ov } = useAdmin<{ integrations: { clerk?: boolean } }>('/overview');
  const [q, setQ] = useState('');
  const [stage, setStage] = useState('');
  const [att, setAtt] = useState(false);
  const [sort, setSort] = useState<Sort>('created');
  const [creating, setCreating] = useState(false);
  const result = useResult();

  const rows = useMemo(() => {
    const list = (data?.orgs ?? []).filter(
      (o) =>
        (!q || `${o.name} ${o.slug} ${o.contact || ''}`.toLowerCase().includes(q.trim().toLowerCase())) &&
        (!stage || o.stage === stage) &&
        (!att || o.attention.length)
    );
    const by: Record<Sort, (a: OrgRow, b: OrgRow) => number> = {
      created: () => 0, // the API's order: newest first
      seen: (a, b) => new Date(b.last_seen ?? 0).getTime() - new Date(a.last_seen ?? 0).getTime(),
      calls: (a, b) => b.calls_7d - a.calls_7d,
      stage: (a, b) => b.stage_index - a.stage_index,
      attention: (a, b) => b.attention.length - a.attention.length
    };
    return [...list].sort(by[sort]);
  }, [data, q, stage, att, sort]);
  const n = data?.stages.length || 8;

  return (
    <PageContainer
      pageTitle='Accounts'
      pageDescription='Every organization, where it is in onboarding, its people and plan, and whether it is being used.'
      pageHeaderAction={
        <Button onClick={() => setCreating(true)}>
          <Icons.add className='size-4' /> New account
        </Button>
      }
    >
      <ErrorBox error={error} />
      {data?.stripe_error && <div className='mb-4'><Notice>Stripe: {data.stripe_error}</Notice></div>}
      <div className='mb-4 flex flex-wrap items-center gap-2'>
        <div className='relative w-full sm:w-72'>
          <Icons.search className='text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2' />
          <Input placeholder='Filter by name, slug or email' className='pl-8' value={q} onChange={(e) => setQ(e.target.value)} aria-label='Filter accounts' />
        </div>
        <NativeSelect value={stage} onChange={(e) => setStage(e.target.value)} aria-label='Stage'>
          <NativeSelectOption value=''>All stages</NativeSelectOption>
          {(data?.stages ?? []).map((s) => (
            <NativeSelectOption key={s.id} value={s.id}>
              {s.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label='Sort'>
          <NativeSelectOption value='created'>Newest first</NativeSelectOption>
          <NativeSelectOption value='seen'>Last seen</NativeSelectOption>
          <NativeSelectOption value='calls'>Most calls (7d)</NativeSelectOption>
          <NativeSelectOption value='stage'>Furthest stage</NativeSelectOption>
          <NativeSelectOption value='attention'>Most to check</NativeSelectOption>
        </NativeSelect>
        <label className='flex items-center gap-2 text-sm'>
          <Checkbox checked={att} onCheckedChange={(v) => setAtt(Boolean(v))} /> Needs attention
        </label>
        {data && <span className='text-muted-foreground ml-auto text-xs'>{rows.length} of {data.orgs.length}</span>}
      </div>
      <div>
          {isLoading || !data ? (
            <div className='grid gap-2'>
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className='h-12' />
              ))}
            </div>
          ) : (
            <DataList
              rows={rows}
              empty='No accounts match.'
              minWidth={900}
              onRow={(o) => router.push(accountHref(o.slug))}
              cols={[
                {
                  label: 'Account',
                  render: (o) => (
                    <>
                      <div className='font-medium'>{o.name}</div>
                      <div className='text-muted-foreground text-xs'>
                        {o.slug}
                        {o.contact ? ` · ${o.contact}` : ''}
                      </div>
                    </>
                  )
                },
                {
                  label: 'Stage',
                  render: (o) => (
                    <>
                      <div className='whitespace-nowrap'>
                        <StageDots index={o.stage_index} total={n} />
                        {o.stage_label}
                      </div>
                      <div className='text-muted-foreground text-xs'>Next: {o.next_step}</div>
                    </>
                  )
                },
                {
                  label: 'Members',
                  render: (o) =>
                    o.clerk_org_id ? (
                      <span className='inline-flex flex-wrap items-center gap-1.5'>
                        {o.members}
                        {o.pending_invites > 0 && <StatusBadge tone='info'>+{o.pending_invites} invited</StatusBadge>}
                      </span>
                    ) : (
                      <span className='inline-flex items-center gap-1.5'>
                        <span className='text-muted-foreground'>keys: {o.active_keys}</span>
                        {!o.active_keys && <StatusBadge tone='bad'>none</StatusBadge>}
                      </span>
                    )
                },
                { label: 'Plan', render: (o) => <SubBadge sub={o.subscription} /> },
                { label: 'Last seen', render: (o) => <When d={o.last_seen} /> },
                {
                  label: 'Calls 7d',
                  render: (o) => (
                    <span className='inline-flex items-center gap-1.5 tabular-nums'>
                      {o.calls_7d}
                      {o.errors_7d > 0 && <StatusBadge tone='bad'>{o.errors_7d} err</StatusBadge>}
                    </span>
                  )
                },
                {
                  label: 'Spend (month)',
                  render: (o) => (
                    <span className='tabular-nums'>
                      {usd(o.month_spend_usd)}
                      {o.budget_usd ? <span className='text-muted-foreground'> / {usd(o.budget_usd)}</span> : null}
                    </span>
                  )
                },
                {
                  label: '',
                  key: 'att',
                  render: (o) =>
                    o.attention.length ? (
                      <StatusBadge tone='warn' title={o.attention.join('\n')}>
                        {o.attention.length} to check
                      </StatusBadge>
                    ) : null
                }
              ]}
            />
          )}
      </div>
      {creating && (
        <NewAccount
          clerk={Boolean(ov?.integrations.clerk)}
          onClose={() => setCreating(false)}
          onDone={(r) => {
            setCreating(false);
            result.show(r, `Account created: ${r.org.name}`);
          }}
        />
      )}
      {result.dialog}
    </PageContainer>
  );
}

function NewAccount({ clerk, onClose, onDone }: { clerk: boolean; onClose: () => void; onDone: (r: InviteResult) => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [email, setEmail] = useState('');
  const [err, setErr] = useState('');
  const create = useAdminAction(() => post<InviteResult>('/orgs', { name: name.trim(), slug: slug.trim() || undefined, email: email.trim() || undefined }));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    create.mutate(undefined, { onSuccess: onDone, onError: (x) => setErr(x.message) });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <form onSubmit={submit} className='grid gap-4'>
          <DialogHeader>
            <DialogTitle>New account</DialogTitle>
            <DialogDescription>For someone who did not use the landing page form.</DialogDescription>
          </DialogHeader>
          <div className='grid gap-1.5'>
            <Label htmlFor='na-name'>Account name</Label>
            <Input id='na-name' required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className='grid gap-1.5'>
            <Label htmlFor='na-slug'>Slug (optional)</Label>
            <Input id='na-slug' placeholder='from the name' value={slug} onChange={(e) => setSlug(e.target.value)} />
          </div>
          <div className='grid gap-1.5'>
            <Label htmlFor='na-email'>First person&apos;s email (optional)</Label>
            <Input id='na-email' type='email' value={email} onChange={(e) => setEmail(e.target.value)} />
            <p className='text-muted-foreground text-xs'>
              {clerk ? "With an email, Clerk invites that person as the account's admin." : 'Clerk is off: the account gets a secret key link, labelled with the email.'}
            </p>
          </div>
          {err && <p className='text-destructive text-sm'>{err}</p>}
          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose}>
              Cancel
            </Button>
            <Button type='submit' disabled={create.isPending}>
              Create account
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
