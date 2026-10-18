'use client';
// Operations pages as full-page tables: the Key vault (one row per provider) and Compute (capacity settings, with the
// sandbox provider's live status a click away). Harness mix and Agent configuration live in compute.tsx.
import { useState } from 'react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import PageContainer from '@/components/layout/page-container';
import { Field, RecordView, type RecordCol } from '@/components/layout/record-view';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { adminApi } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { post, useAdmin, useAdminAction } from './lib';
import { ErrorBox, FormRow, Mono, Notice, When } from './ui';

// ---------- key vault ----------

interface Provider { slug: string; mode: 'gateway' | 'direct'; backend: string; enabled: boolean; keys: number; enabled_keys: number; last_used_at: string | null }
interface Credential { id: number; provider: string; label: string; hint: string; enabled: boolean; uses: number; last_used_at: string | null }
const TYPE: Record<string, string> = {
  anthropic: 'Inference', openai: 'Inference', google: 'Inference', cloudflare: 'Inference', dashscope: 'Inference',
  boat: 'Sandbox', exa: 'Search', libraries_io: 'Search',
  amp: 'Coding agent', cursor: 'Coding agent', factory: 'Coding agent', github_copilot: 'Coding agent'
};
const TYPES = ['Inference', 'Sandbox', 'Search', 'Coding agent', 'Other'];
const typeOf = (slug: string) => TYPE[slug] ?? 'Other';

/** Every key Octillion uses, one row per provider; keys are added, disabled and deleted from the row's ⋯ menu. */
export function AdminKeyVault() {
  const { data, error, isLoading } = useAdmin<{ unlocked: boolean; providers: Provider[]; credentials: Credential[] }>('/compute/keys');
  const [adding, setAdding] = useState<string | null>(null);
  const [del, setDel] = useState<Credential | null>(null);
  const keyOn = useAdminAction((v: { id: number; enabled: boolean }) => post(`/compute/keys/${v.id}/enabled`, { enabled: v.enabled }), { success: 'Key updated' });
  const remove = useAdminAction((id: number) => adminApi('DELETE', `/compute/keys/${id}`), { success: 'Key deleted' });
  const provOn = useAdminAction((v: { slug: string; enabled: boolean }) => post(`/compute/providers/${encodeURIComponent(v.slug)}/enabled`, { enabled: v.enabled }), { success: 'Provider updated' });
  const creds = data?.credentials ?? [];
  const keysOf = (p: Provider) => creds.filter((c) => c.provider === p.slug);
  const cols: RecordCol<Provider>[] = [
    { key: 'provider', label: 'Provider', keep: true, type: 'text', value: (p) => p.slug, render: (p) => <Mono>{p.slug}</Mono> },
    { key: 'type', label: 'Type', type: 'select', value: (p) => typeOf(p.slug), options: TYPES.map((t) => ({ value: t })), render: (p) => typeOf(p.slug) },
    { key: 'use', label: 'How it is used', type: 'select', value: (p) => (p.mode === 'gateway' ? 'Through the gateway' : 'Handed to the orchestrator'),
      render: (p) => <span className='text-muted-foreground'>{p.mode === 'gateway' ? 'through the gateway' : 'handed to the orchestrator'}{p.backend !== 'direct' && ` · ${p.backend}`}</span> },
    { key: 'keys', label: 'Keys', type: 'number', value: (p) => keysOf(p).length, render: (p) => {
      const mine = keysOf(p);
      return mine.length ? <span className='flex flex-wrap gap-x-3 gap-y-1'>{mine.map((c) => <span key={c.id} className={c.enabled ? undefined : 'text-muted-foreground line-through'}><Mono>{c.hint}</Mono> <span className='text-muted-foreground'>{c.label} · {c.uses} uses</span></span>)}</span>
        : <span className='text-amber-700 dark:text-amber-400'>no key</span>;
    } },
    { key: 'last', label: 'Last used', type: 'date', value: (p) => p.last_used_at ?? undefined, render: (p) => (p.last_used_at ? <When d={p.last_used_at} /> : <span className='text-muted-foreground'>never</span>) },
    { key: 'on', label: 'On', className: 'w-12 text-right', keep: true,
      render: (p) => <span onClick={(e) => e.stopPropagation()}><Switch aria-label={`${p.slug} on`} checked={p.enabled} disabled={provOn.isPending} onCheckedChange={(c) => provOn.mutate({ slug: p.slug, enabled: c })} /></span> }
  ];
  return (
    <PageContainer>
      <ErrorBox error={error} />
      {data && !data.unlocked && <Notice>The key vault is locked: set <Mono>OCTILLION_VAULT_KEY</Mono> on the server to add keys.</Notice>}
      <RecordView id='key-vault' rows={data?.providers ?? []} loading={isLoading} rowKey={(p) => p.slug} cols={cols} noun='providers'
        searchText={(p) => `${p.slug} ${typeOf(p.slug)} ${keysOf(p).map((c) => `${c.label} ${c.hint}`).join(' ')}`}
        searchPlaceholder='Search providers and keys · encrypted at rest; agents get scoped gateway tokens, never these keys'
        views={[{ id: 'all', label: 'All' }, ...TYPES.slice(0, 4).map((t) => ({ id: t, label: t, match: (p: Provider) => typeOf(p.slug) === t }))]}
        defaultSort={[{ key: 'type', dir: 'asc' }]}
        primary={<Button onClick={() => setAdding(data?.providers[0]?.slug ?? null)} disabled={data?.unlocked === false}><Icons.add /> Add a key</Button>}
        actions={(p) => [
          { label: 'Add a key…', icon: <Icons.add />, disabled: data?.unlocked === false, onSelect: () => setAdding(p.slug) },
          ...keysOf(p).flatMap((c, i) => [
            { label: `${c.enabled ? 'Disable' : 'Enable'} ${c.label} (${c.hint})`, icon: c.enabled ? <Icons.eyeOff /> : <Icons.check />, separator: i === 0, onSelect: () => keyOn.mutate({ id: c.id, enabled: !c.enabled }) },
            { label: `Delete ${c.label}…`, icon: <Icons.trash />, destructive: true, onSelect: () => setDel(c) }
          ])
        ]}
        exportName='key-vault' empty='No providers.' />
      {adding && <AddKey providers={data?.providers ?? []} initial={adding} onClose={() => setAdding(null)} />}
      <AlertDialog open={!!del} onOpenChange={(o) => !o && setDel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the {del?.provider} key {del?.label}?</AlertDialogTitle>
            <AlertDialogDescription>Calls stop using it at once. This cannot be undone: to use it again, add it again.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant='destructive' onClick={() => { if (del) remove.mutate(del.id); setDel(null); }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  );
}

/** A key is posted once and the form is cleared; a failed save asks for it again rather than keeping it on screen. */
function AddKey({ providers, initial, onClose }: { providers: Provider[]; initial: string; onClose: () => void }) {
  const [f, setF] = useState({ provider: initial, label: '', secret: '' });
  const [err, setErr] = useState('');
  const add = useAdminAction(() => post<{ hint: string }>('/compute/keys', { provider: f.provider, label: f.label.trim() || undefined, secret: f.secret }), { success: (r) => `Key saved (${r.hint})` });
  const vertex = f.provider === 'anthropic' && f.label.trim() === 'vertex';
  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    add.mutate(undefined, { onSuccess: onClose, onError: (x) => { setErr(x.message); setF({ ...f, secret: '' }); } });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <form onSubmit={submit} className='grid gap-4' autoComplete='off'>
          <DialogHeader>
            <DialogTitle>Add a key</DialogTitle>
            <DialogDescription>Encrypted at rest and shown only as a hint once saved.</DialogDescription>
          </DialogHeader>
          <FormRow id='ak-provider' label='Provider'>
            <NativeSelect id='ak-provider' value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })} className='w-full'>
              {providers.map((p) => <NativeSelectOption key={p.slug} value={p.slug}>{p.slug} · {typeOf(p.slug)}</NativeSelectOption>)}
            </NativeSelect>
          </FormRow>
          <FormRow id='ak-label' label='Label (optional)' hint={f.provider === 'anthropic' ? 'Use the label vertex for a Google service-account JSON (Claude on Vertex AI).' : 'A new label adds to the pool; the same label replaces that key.'}>
            <Input id='ak-label' maxLength={60} placeholder='default' value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
          </FormRow>
          <FormRow id='ak-secret' label={vertex ? 'Service-account JSON' : 'Key'}>
            {vertex
              ? <Textarea id='ak-secret' rows={6} spellCheck={false} required className='font-mono text-xs' placeholder='{ "type": "service_account", … }' value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} />
              : <Input id='ak-secret' type='password' autoComplete='new-password' spellCheck={false} required value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} />}
          </FormRow>
          {err && <p className='text-destructive text-sm'>{err}</p>}
          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose}>Cancel</Button>
            <Button type='submit' disabled={add.isPending || !f.secret.trim()}>Save key</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- compute ----------

interface Setting {
  key: string; group: string; label: string; help: string; kind: 'text' | 'int' | 'number' | 'choice'; default: string | number;
  options?: string[]; min?: number; max?: number; value: string | number; source: 'set' | 'env' | 'default'; env: string | null; updated_at: string | null;
}
interface Sandbox {
  provider: string; api: string; namespace: string; ok: boolean; error: string | null;
  keys: { id: number; label: string; hint: string; enabled: boolean; last_used_at: string | null }[];
  limits: { activeSandboxes: number; startsPerMinute: number; startsPerHour: number; startsPerDay: number; activeNow: number } | null;
  running: { total: number; ours: number; orchestrators: number; others: number } | null;
  orchestrators: Record<string, number>;
}

/** Compute: the capacity settings as a full-page table; the sandbox provider's live status in the toolbar and a dialog. */
export function AdminCompute() {
  const { data, error, isLoading } = useAdmin<{ settings: Setting[] }>('/compute');
  const sb = useAdmin<Sandbox>('/compute/sandbox');
  const [showSandbox, setShowSandbox] = useState(false);
  const save = useAdminAction((v: Record<string, string | null>) => adminApi('PUT', '/compute/settings', { values: v }), { success: 'Setting saved' });
  const rows = (data?.settings ?? []).filter((x) => x.group === 'capacity');
  const cols: RecordCol<Setting>[] = [
    { key: 'setting', label: 'Setting', keep: true, type: 'text', value: (x) => x.label,
      render: (x) => <span className='flex min-w-0 flex-col gap-1'><span className='leading-none font-medium'>{x.label}</span><span className='text-muted-foreground truncate text-xs' title={x.help}>{x.help}</span></span> },
    { key: 'value', label: 'Value', className: 'w-56', keep: true, render: (x) => <span onClick={(e) => e.stopPropagation()}><Value key={String(x.value)} s={x} disabled={save.isPending} onSave={(v) => save.mutate({ [x.key]: v })} /></span> },
    { key: 'source', label: 'From', type: 'select', value: (x) => (x.source === 'set' ? 'Set here' : x.source === 'env' ? 'Environment' : 'Default'),
      render: (x) => (x.source === 'set' ? <span>Set here{x.updated_at && <span className='text-muted-foreground'> · <When d={x.updated_at} /></span>}</span> : <span className='text-muted-foreground'>{x.source === 'env' ? 'Environment' : 'Default'}</span>) },
    { key: 'default', label: 'Default', type: 'text', value: (x) => String(x.default), render: (x) => <Mono>{String(x.default)}</Mono> },
    { key: 'key', label: 'Variable', type: 'text', value: (x) => x.key, render: (x) => <Mono>{x.key}</Mono> }
  ];
  const s = sb.data;
  return (
    <PageContainer>
      <ErrorBox error={error} />
      <RecordView id='compute' rows={rows} loading={isLoading} rowKey={(x) => x.key} cols={cols} noun='settings'
        searchText={(x) => `${x.label} ${x.key} ${x.help}`}
        searchPlaceholder={s ? `Search capacity settings · ${s.provider} ${s.ok ? 'connected' : 'not connected'}${s.running && s.limits ? `, ${s.running.total} of ${s.limits.activeSandboxes} sandboxes running` : ''}` : 'Search capacity settings'}
        primary={<Button variant='outline' onClick={() => setShowSandbox(true)}><span className={cn('size-2 rounded-full', !s ? 'bg-muted-foreground' : s.ok ? 'bg-emerald-500' : 'bg-destructive')} /> Sandbox provider</Button>}
        actions={(x) => (x.source === 'set' ? [{ label: `Reset to ${x.env != null ? 'environment' : 'default'}`, icon: <Icons.close />, onSelect: () => save.mutate({ [x.key]: null }) }] : [])}
        exportName='compute' empty='No capacity settings.' />
      <Dialog open={showSandbox} onOpenChange={setShowSandbox}>
        <DialogContent className='sm:max-w-2xl'>
          <DialogHeader>
            <DialogTitle>Sandbox provider</DialogTitle>
            <DialogDescription>Where orchestrators and agent sandboxes run. Its key lives in Key vault (provider boat).</DialogDescription>
          </DialogHeader>
          <ErrorBox error={sb.error} />
          {s && (<>
            {!s.ok && <Notice>boat.dev did not answer: {s.error}</Notice>}
            <dl>
              <Field label='Provider'>{s.provider} <span className='text-muted-foreground'>· {s.ok ? 'connected' : 'not connected'}</span></Field>
              <Field label='Key'>{s.keys.find((k) => k.enabled) ? <><Mono>{s.keys.find((k) => k.enabled)!.hint}</Mono> <span className='text-muted-foreground'>· {s.keys.find((k) => k.enabled)!.label}</span></> : <span className='text-amber-700 dark:text-amber-400'>No boat key: add one in Key vault</span>}</Field>
              <Field label='API'><Mono>{s.api}</Mono></Field>
              <Field label='Namespace'><Mono>{s.namespace}</Mono> <span className='text-muted-foreground'>· this deployment only touches sandboxes named {s.namespace}-…</span></Field>
              {s.limits && <Field label='Plan'>{s.limits.activeSandboxes} at once · {s.limits.startsPerDay} starts a day ({s.limits.startsPerHour}/hour, {s.limits.startsPerMinute}/minute)</Field>}
              {s.running && <Field label='Running now'>{s.running.total} <span className='text-muted-foreground'>· ours {s.running.ours} ({s.running.orchestrators} orchestrators) · other deployments {s.running.others}</span></Field>}
              <Field label='Orchestrators'>{Object.keys(s.orchestrators).length ? Object.entries(s.orchestrators).map(([k, n]) => `${n} ${k}`).join(' · ') : <span className='text-muted-foreground'>none running</span>}</Field>
            </dl>
          </>)}
          <DialogFooter>
            <Button variant='outline' disabled={sb.isFetching} onClick={() => void sb.refetch()}>{sb.isFetching ? <Icons.spinner className='animate-spin' /> : <Icons.plug />} Test connection</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}

function Value({ s, onSave, disabled }: { s: Setting; onSave: (v: string) => void; disabled?: boolean }) {
  const [v, setV] = useState(String(s.value));
  const commit = (x: string) => { if (x.trim() !== '' && x !== String(s.value)) onSave(x); };
  return s.kind === 'choice' ? (
    <NativeSelect aria-label={s.label} value={v} disabled={disabled} onChange={(e) => { setV(e.target.value); commit(e.target.value); }} className='w-40'>
      {s.options!.map((o) => <NativeSelectOption key={o} value={o}>{o}</NativeSelectOption>)}
    </NativeSelect>
  ) : (
    <Input aria-label={s.label} value={v} disabled={disabled} onChange={(e) => setV(e.target.value)} onBlur={() => commit(v)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      className='h-8 w-28 tabular-nums' type='number' min={s.min} max={s.max} step={s.kind === 'number' ? 'any' : 1} />
  );
}
