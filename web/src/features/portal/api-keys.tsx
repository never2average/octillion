'use client';
// /app/settings/api-keys: personal API keys for agents that can't sign in through a browser (claude -p, the Agent SDK,
// CI, SSH, sandboxes). Anyone signed in creates keys for themselves in this account (src/api-keys.ts): a name, read or
// write access, an expiry. The key is shown once, then only its prefix. Members list and revoke their own keys; owners
// see and revoke every key in the account, including the account-wide connector keys Octillion issued before.
import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { ActionsMenu, RecordView, type RecordCol, type RowAction } from '@/components/layout/record-view';
import { DetailMeta, DetailTable, DetailTabs, KeyValueTable } from '@/components/layout/detail';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Icons } from '@/components/icons';
import { appApi } from '@/lib/api-client';
import { Mono, StatusBadge } from '@/features/admin/ui';
import { CopyButton, ErrorState, FormRow, When, fail, useOrgLoad } from './shared';
import type { Headless } from './setup';

export interface ApiKeyRow {
  id: number; name: string; prefix: string; scope: 'read' | 'write' | 'full';
  expires_at: string | null; created_at: string; last_used_at: string | null; revoked_at: string | null;
  created_via: string | null; user_id: string | null; status: 'active' | 'expired' | 'revoked'; mine: boolean;
  owner: { email: string | null; name: string | null } | null;
}
interface KeysResponse {
  keys: ApiKeyRow[]; me: string | null; can_manage: boolean; expiry_days: (number | null)[]; default_expiry_days: number;
  connector_url: string; env: { variable: string; shell: string; note: string }; headless: Headless[];
}

const NA = <span className='text-muted-foreground'>—</span>;
const ACCESS: Record<ApiKeyRow['scope'], string> = { read: 'Read only', write: 'Read and write', full: 'Full (older key)' };
const ORIGIN: Record<string, string> = { portal: 'Made here', admin: 'Issued by Octillion', cli: 'Command line' };
const tone = (k: ApiKeyRow) => (k.status === 'active' ? 'ok' : k.status === 'expired' ? 'warn' : 'neutral') as 'ok' | 'warn' | 'neutral';
const whose = (k: ApiKeyRow) => (k.mine ? 'You' : k.owner ? (k.owner.name || k.owner.email || 'A member') : 'Account (no person)');
const day = (d: string | null) => (d ? new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null);

export function ApiKeysPage() {
  const { data, error, reload } = useOrgLoad(() => appApi<KeysResponse>('GET', '/api-keys'));
  const [creating, setCreating] = useState(false);
  const [made, setMade] = useState<{ key: string; row: ApiKeyRow } | null>(null);
  const rows = data?.keys ?? [];

  const revoke = (k: ApiKeyRow) => {
    if (!window.confirm(`Revoke "${k.name}" (${k.prefix}…)? Anything using it stops working at once.`)) return;
    appApi('POST', `/api-keys/${k.id}/revoke`).then(() => { toast.success('Key revoked'); return reload(); }).catch(fail);
  };
  const actions = (k: ApiKeyRow): RowAction[] => k.status === 'revoked' ? [] : [
    { label: 'Revoke', icon: <Icons.trash />, destructive: true, onSelect: () => revoke(k) }
  ];

  const cols = useMemo<RecordCol<ApiKeyRow>[]>(() => [
    { key: 'name', label: 'Key', className: 'min-w-56', title: true, keep: true, peek: false, type: 'text', value: (k) => k.name, render: (k) => (
      <span className='flex flex-col gap-1.5'>
        <span className='leading-none font-medium'>{k.name}</span>
        <span className='text-muted-foreground font-mono text-xs'>{k.prefix}…</span>
      </span>
    ) },
    ...(data?.can_manage ? [{ key: 'owner', label: 'Person', className: 'w-48', type: 'select' as const, value: whose, render: (k: ApiKeyRow) => whose(k) }] : []),
    { key: 'scope', label: 'Access', className: 'w-36', type: 'select', value: (k) => ACCESS[k.scope], render: (k) => ACCESS[k.scope] },
    { key: 'expires', label: 'Expires', className: 'w-32', type: 'date', value: (k) => k.expires_at, render: (k) => day(k.expires_at) ?? <span className='text-muted-foreground'>Never</span> },
    { key: 'used', label: 'Last used', className: 'w-32', type: 'date', value: (k) => k.last_used_at, render: (k) => <When d={k.last_used_at} /> },
    { key: 'created', label: 'Created', className: 'w-32', hidden: true, type: 'date', value: (k) => k.created_at, render: (k) => <When d={k.created_at} /> },
    { key: 'origin', label: 'Origin', className: 'w-40', hidden: true, type: 'select', value: (k) => ORIGIN[k.created_via ?? ''] ?? 'Before personal keys', render: (k) => ORIGIN[k.created_via ?? ''] ?? 'Before personal keys' },
    { key: 'status', label: 'Status', className: 'w-24', keep: true, type: 'select', value: (k) => k.status, options: [{ value: 'active' }, { value: 'expired' }, { value: 'revoked' }],
      render: (k) => <StatusBadge tone={tone(k)}>{k.status}</StatusBadge> }
  ], [data?.can_manage]);

  const primary = <Button onClick={() => setCreating(true)}><Icons.add /> Create key</Button>;

  return (
    <PageContainer>
      {error ? <ErrorState error={error} /> : (
        <RecordView<ApiKeyRow>
          id='app-api-keys' noun='keys' exportName='api-keys'
          rows={rows} rowKey={(k) => String(k.id)} cols={cols} actions={actions} loading={!data}
          defaultSort={[{ key: 'status', dir: 'asc' }, { key: 'created', dir: 'desc' }]}
          searchText={(k) => `${k.name} ${k.prefix} ${ACCESS[k.scope]} ${k.status} ${whose(k)} ${k.owner?.email ?? ''}`}
          searchPlaceholder={data?.can_manage ? 'Search keys by name, prefix or person' : 'Search your keys by name or prefix'}
          primary={primary}
          empty={<>No API keys yet. Create one for an agent that can’t sign in through a browser (<code>claude -p</code>, the Agent SDK, CI), then set <code>OCTILLION_API_KEY</code> to it.</>}
          detailTitle={() => 'API key'}
          detail={(k) => <KeyBody k={k} data={data!} actions={k.status === 'revoked' ? null : <ActionsMenu items={actions(k)} />} />}
        />
      )}
      {creating && data && <CreateDialog data={data} onClose={() => setCreating(false)} onMade={(m) => { setCreating(false); setMade(m); void reload(); }} />}
      {made && data && <ShownOnce made={made} data={data} onClose={() => setMade(null)} />}
    </PageContainer>
  );
}

/** The key peek: the card, then tabs: its details, and how to use it (the env-var snippets per client). */
function KeyBody({ k, data, actions }: { k: ApiKeyRow; data: KeysResponse; actions: ReactNode }) {
  return (
    <div className='flex flex-col gap-4'>
      <DetailMeta title={k.name} badges={<StatusBadge tone={tone(k)}>{k.status}</StatusBadge>} actions={actions}
        subtitle={k.mine ? 'Your key: it acts as you, in this account.' : k.owner ? `${whose(k)}’s key` : 'An account-wide connector key (no person)'}
        facts={[
          { label: 'Key', value: <Mono>{k.prefix}…</Mono> },
          { label: 'Access', value: ACCESS[k.scope] },
          { label: 'Expires', value: day(k.expires_at) ?? 'Never' },
          { label: 'Last used', value: <When d={k.last_used_at} /> }
        ]} />
      <DetailTabs resetKey={String(k.id)} tabs={[
        { id: 'details', label: 'Details', content: (
          <KeyValueTable rows={[
            { label: 'Name', value: k.name },
            { label: 'Person', value: whose(k) },
            { label: 'Email', value: k.owner?.email ?? NA, hidden: k.mine || !k.owner },
            { label: 'Access', value: k.scope === 'read' ? 'Read only: reports, sessions, transcripts, lists and memory search. Tools that change things are refused.' : k.scope === 'write' ? 'Read and write: every tool your role allows.' : 'Full access (a key from before personal keys).' },
            { label: 'Created', value: <When d={k.created_at} /> },
            { label: 'Expires', value: day(k.expires_at) ?? 'Never' },
            { label: 'Revoked', value: <When d={k.revoked_at} />, hidden: !k.revoked_at },
            { label: 'Origin', value: ORIGIN[k.created_via ?? ''] ?? 'Before personal keys' }
          ]} />
        ) },
        { id: 'use', label: 'Use it', count: data.headless.length, content: <UseIt data={data} /> }
      ]} />
    </div>
  );
}

/** Each client's snippet: all read OCTILLION_API_KEY, none holds the key. */
function UseIt({ data }: { data: KeysResponse }) {
  return (
    <DetailTable rows={data.headless} rowKey={(h) => h.id} noun='clients' empty='No snippets.' cols={[
      { key: 'client', label: 'Client', type: 'text', value: (h) => h.client, className: 'w-48 align-top', render: (h) => (
        <span className='flex flex-col gap-1'>
          <span className='font-medium'>{h.client}</span>
          {!h.verified && <span className='text-muted-foreground text-xs'>Not checked against its docs yet</span>}
        </span>
      ) },
      { key: 'how', label: 'How', type: 'text', value: (h) => h.steps, className: 'whitespace-normal align-top', render: (h) => (
        <div className='flex flex-col gap-2 py-1'>
          <span className='text-sm leading-snug'>{h.steps}{h.file ? <> In <code className='font-mono'>{h.file}</code>:</> : null}</span>
          {(h.command || h.snippet) && (
            <div className='flex items-start gap-2'>
              <pre className='bg-background min-w-0 flex-1 overflow-x-auto rounded-md border p-2 font-mono text-xs whitespace-pre-wrap break-all'>{h.command ?? h.snippet}</pre>
              <CopyButton text={(h.command ?? h.snippet)!} />
            </div>
          )}
          {h.note && <span className='text-muted-foreground text-xs leading-snug'>{h.note}</span>}
        </div>
      ) }
    ]} />
  );
}

function CreateDialog({ data, onClose, onMade }: { data: KeysResponse; onClose: () => void; onMade: (m: { key: string; row: ApiKeyRow }) => void }) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'write' | 'read'>('write');
  const [expiry, setExpiry] = useState(String(data.default_expiry_days));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    appApi<{ key: string; row: ApiKeyRow }>('POST', '/api-keys', { name: name.trim(), scope, expires_days: expiry === 'never' ? null : Number(expiry) })
      .then(onMade).catch((x: Error) => setErr(x.message)).finally(() => setBusy(false));
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-lg'>
        <form onSubmit={submit} className='grid gap-4'>
          <DialogHeader>
            <DialogTitle>Create an API key</DialogTitle>
            <DialogDescription>For an agent that can’t sign in through a browser. The key acts as you, in this account, with your role and limits.</DialogDescription>
          </DialogHeader>
          <FormRow htmlFor='ak-name' label='Name' hint='Where it will be used, so you can tell keys apart.'>
            <Input id='ak-name' required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g. GitHub Actions, laptop claude -p' />
          </FormRow>
          <FormRow htmlFor='ak-scope' label='Access' hint='Read only can’t launch runs, onboard products or save anything.'>
            <NativeSelect id='ak-scope' value={scope} onChange={(e) => setScope(e.target.value as 'write' | 'read')} className='w-full'>
              <NativeSelectOption value='write'>Read and write</NativeSelectOption>
              <NativeSelectOption value='read'>Read only</NativeSelectOption>
            </NativeSelect>
          </FormRow>
          <FormRow htmlFor='ak-expiry' label='Expires'>
            <NativeSelect id='ak-expiry' value={expiry} onChange={(e) => setExpiry(e.target.value)} className='w-full'>
              {data.expiry_days.map((d) => <NativeSelectOption key={String(d)} value={d == null ? 'never' : String(d)}>{d == null ? 'Never' : `In ${d} days`}</NativeSelectOption>)}
            </NativeSelect>
          </FormRow>
          {err && <p className='text-destructive text-sm'>{err}</p>}
          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose}>Cancel</Button>
            <Button type='submit' disabled={busy || !name.trim()}>Create key</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The new key, once: copy it, set OCTILLION_API_KEY, pick a client. */
function ShownOnce({ made, data, onClose }: { made: { key: string; row: ApiKeyRow }; data: KeysResponse; onClose: () => void }) {
  const exportLine = `export ${data.env.variable}=${made.key}`;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>Your new key: {made.row.name}</DialogTitle>
          <DialogDescription>Copy it now: it is shown only once. Anyone with it acts as you in this account.</DialogDescription>
        </DialogHeader>
        <div className='flex items-center gap-2'>
          <code className='bg-background min-w-0 flex-1 rounded-md border px-2.5 py-2 font-mono text-xs break-all select-all' aria-label='API key'>{made.key}</code>
          <CopyButton text={made.key} label='Copy key' variant='default' />
        </div>
        <Alert>
          <Icons.info />
          <AlertDescription>
            Set it as <code>{data.env.variable}</code> in your shell, your CI’s secrets or a secret manager. {data.env.note}
          </AlertDescription>
        </Alert>
        <div className='flex items-center gap-2'>
          <code className='bg-background min-w-0 flex-1 rounded-md border px-2.5 py-2 font-mono text-xs break-all'>{exportLine}</code>
          <CopyButton text={exportLine} label='Copy export line' />
        </div>
        <UseIt data={data} />
        <p className='text-muted-foreground text-sm'>Signing in through a browser instead? See <Link className='underline' href='/app'>Setup</Link>.</p>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
