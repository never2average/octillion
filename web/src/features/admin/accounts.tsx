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
import { Field, RecordView, type RecordCol } from '@/components/layout/record-view';
import { ErrorBox, Notice, StageDots, StatusBadge, SubBadge, When } from './ui';

type Sort = 'created' | 'seen' | 'calls' | 'stage' | 'attention';

export function AdminAccounts() {
  const router = useRouter();
  const { data, error, isLoading } = useAdmin<OrgList>('/orgs');
  const { data: ov } = useAdmin<{ integrations: { clerk?: boolean } }>('/overview');
  const [stage, setStage] = useState('');
  const [att, setAtt] = useState(false);
  const [sort, setSort] = useState<Sort>('created');
  const [creating, setCreating] = useState(false);
  const result = useResult();

  // Filters and sort apply before search (search is the table's own).
  const rows = useMemo(() => {
    const list = (data?.orgs ?? []).filter((o) => (!stage || o.stage === stage) && (!att || o.attention.length));
    const by: Record<Sort, (a: OrgRow, b: OrgRow) => number> = {
      created: () => 0, // the API's order: newest first
      seen: (a, b) => new Date(b.last_seen ?? 0).getTime() - new Date(a.last_seen ?? 0).getTime(),
      calls: (a, b) => b.calls_7d - a.calls_7d,
      stage: (a, b) => b.stage_index - a.stage_index,
      attention: (a, b) => b.attention.length - a.attention.length
    };
    return [...list].sort(by[sort]);
  }, [data, stage, att, sort]);
  const n = data?.stages.length || 8;
  const members = (o: OrgRow) => o.clerk_org_id ? (
    <span className='inline-flex flex-wrap items-center gap-1.5'>{o.members}{o.pending_invites > 0 && <StatusBadge tone='info'>+{o.pending_invites} invited</StatusBadge>}</span>
  ) : (
    <span className='inline-flex items-center gap-1.5'><span className='text-muted-foreground'>keys: {o.active_keys}</span>{!o.active_keys && <StatusBadge tone='bad'>none</StatusBadge>}</span>
  );
  const spend = (o: OrgRow) => <span className='tabular-nums'>{usd(o.month_spend_usd)}{o.budget_usd ? <span className='text-muted-foreground'> / {usd(o.budget_usd)}</span> : null}</span>;
  const cols: RecordCol<OrgRow>[] = [
    { key: 'account', label: 'Account', keep: true, render: (o) => (<>
      <div className='font-medium'>{o.name}</div>
      <div className='text-muted-foreground text-xs'>{o.slug}{o.contact ? ` · ${o.contact}` : ''}</div>
    </>) },
    { key: 'stage', label: 'Stage', keep: true, render: (o) => <div className='whitespace-nowrap'><StageDots index={o.stage_index} total={n} />{o.stage_label}</div> },
    { key: 'members', label: 'Members', render: members },
    { key: 'plan', label: 'Plan', render: (o) => <SubBadge sub={o.subscription} /> },
    { key: 'seen', label: 'Last seen', render: (o) => <When d={o.last_seen} /> },
    { key: 'calls', label: 'Calls 7d', render: (o) => <span className='inline-flex items-center gap-1.5 tabular-nums'>{o.calls_7d}{o.errors_7d > 0 && <StatusBadge tone='bad'>{o.errors_7d} err</StatusBadge>}</span> },
    { key: 'spend', label: 'Spend (month)', render: spend },
    { key: 'att', label: '', keep: true, render: (o) => o.attention.length ? <StatusBadge tone='warn' title={o.attention.join('\n')}>{o.attention.length} to check</StatusBadge> : null }
  ];

  return (
    <PageContainer>
      <ErrorBox error={error} />
      {data?.stripe_error && <div className='mb-4'><Notice>Stripe: {data.stripe_error}</Notice></div>}
      <RecordView<OrgRow>
        rows={rows} rowKey={(o) => o.slug} cols={cols} loading={isLoading || !data} noun='accounts'
        searchText={(o) => `${o.name} ${o.slug} ${o.contact ?? ''} ${o.stage_label}`}
        searchPlaceholder='Search accounts by name, slug or email'
        filters={<>
          <NativeSelect value={stage} onChange={(e) => setStage(e.target.value)} aria-label='Stage' className='w-40'>
            <NativeSelectOption value=''>All stages</NativeSelectOption>
            {(data?.stages ?? []).map((s) => <NativeSelectOption key={s.id} value={s.id}>{s.label}</NativeSelectOption>)}
          </NativeSelect>
          <NativeSelect value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label='Sort' className='w-40'>
            <NativeSelectOption value='created'>Newest first</NativeSelectOption>
            <NativeSelectOption value='seen'>Last seen</NativeSelectOption>
            <NativeSelectOption value='calls'>Most calls (7d)</NativeSelectOption>
            <NativeSelectOption value='stage'>Furthest stage</NativeSelectOption>
            <NativeSelectOption value='attention'>Most to check</NativeSelectOption>
          </NativeSelect>
          <label className='flex items-center gap-2 text-sm whitespace-nowrap'><Checkbox checked={att} onCheckedChange={(v) => setAtt(Boolean(v))} /> Needs attention</label>
        </>}
        primary={<Button onClick={() => setCreating(true)}><Icons.add className='size-4' /> New account</Button>}
        empty='No accounts match.'
        detailTitle={(o) => o.name}
        detail={(o) => (
          <div className='flex flex-col gap-5'>
            <dl>
              <Field label='Slug'><code className='text-xs'>{o.slug}</code></Field>
              <Field label='Contact'>{o.contact ?? '—'}</Field>
              <Field label='Stage'><div><StageDots index={o.stage_index} total={n} />{o.stage_label}</div><p className='text-muted-foreground mt-1 text-xs'>Next: {o.next_step}</p></Field>
              <Field label='Members'>{members(o)}</Field>
              <Field label='Plan'><SubBadge sub={o.subscription} /></Field>
              <Field label='Last seen'><When d={o.last_seen} /></Field>
              <Field label='Calls (7 days)'>{o.calls_7d}{o.errors_7d > 0 && <span className='text-destructive'> · {o.errors_7d} errors</span>}</Field>
              <Field label='Spend this month'>{spend(o)}</Field>
            </dl>
            {o.attention.length > 0 && (
              <div className='space-y-2'>
                <p className='text-sm font-medium'>Needs attention</p>
                <ul className='list-disc space-y-1 pl-5 text-sm text-amber-400'>{o.attention.map((a) => <li key={a}>{a}</li>)}</ul>
              </div>
            )}
            <div><Button onClick={() => router.push(accountHref(o.slug))}>Open account <Icons.arrowRight /></Button></div>
          </div>
        )}
      />
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
