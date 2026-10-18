'use client';
// Operations pages as full-page tables: the Key vault (one row per provider). Compute, Harness mix and Agent
// configuration live in compute.tsx.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import PageContainer from '@/components/layout/page-container';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
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
  const [importing, setImporting] = useState(false);
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
        primaryMenu={[{ label: 'Import keys…', icon: <Icons.upload />, disabled: data?.unlocked === false, onSelect: () => setImporting(true) }]}
        actions={(p) => [
          { label: 'Add a key…', icon: <Icons.add />, disabled: data?.unlocked === false, onSelect: () => setAdding(p.slug) },
          ...keysOf(p).flatMap((c, i) => [
            { label: `${c.enabled ? 'Disable' : 'Enable'} ${c.label} (${c.hint})`, icon: c.enabled ? <Icons.eyeOff /> : <Icons.check />, separator: i === 0, onSelect: () => keyOn.mutate({ id: c.id, enabled: !c.enabled }) },
            { label: `Delete ${c.label}…`, icon: <Icons.trash />, destructive: true, onSelect: () => setDel(c) }
          ])
        ]}
        exportName='key-vault-providers' empty='No providers.' />
      {importing && <ImportKeys providers={data?.providers ?? []} onClose={() => setImporting(false)} />}
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

/** Environment variable names Octillion knows, to the vault provider that holds them. */
const ENV_PROVIDER: Record<string, string> = {
  ANTHROPIC_API_KEY: 'anthropic', OPENAI_API_KEY: 'openai', CODEX_API_KEY: 'openai', GEMINI_API_KEY: 'google', GOOGLE_API_KEY: 'google',
  CLOUDFLARE_API_TOKEN: 'cloudflare', CF_API_TOKEN: 'cloudflare', DASHSCOPE_API_KEY: 'dashscope', BOAT_API_KEY: 'boat', EXA_API_KEY: 'exa',
  LIBRARIES_IO_API_KEY: 'libraries_io', AMP_API_KEY: 'amp', CURSOR_API_KEY: 'cursor', FACTORY_API_KEY: 'factory', COPILOT_GITHUB_TOKEN: 'github_copilot'
};
interface Parsed { provider: string; label: string; secret: string; source: string; status?: 'saved' | 'failed'; error?: string }
const hint = (s: string) => (s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : '••••');

/**
 * Keys from a .env file (KNOWN_NAME=value), a CSV (provider,label,key) or a Google service-account JSON (Claude on
 * Vertex). Parsed in the browser, shown by hint only, then saved one by one; lines it does not recognise are listed.
 */
function parseKeys(text: string, slugs: Set<string>): { keys: Parsed[]; skipped: string[] } {
  const t = text.trim(), keys: Parsed[] = [], skipped: string[] = [];
  if (t.startsWith('{')) {
    try { const j = JSON.parse(t); if (j.type === 'service_account') return { keys: [{ provider: 'anthropic', label: 'vertex', secret: t, source: 'service-account JSON' }], skipped }; } catch { /* not JSON */ }
  }
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const csv = /^provider\s*,/i.test(lines[0] ?? '');
  for (const line of csv ? lines.slice(1) : lines) {
    if (csv) {
      const [provider, label, ...rest] = line.split(',').map((x) => x.trim());
      const secret = rest.join(',').replace(/^["']|["']$/g, '');
      if (slugs.has(provider) && secret) keys.push({ provider, label: label || 'imported', secret, source: line.slice(0, 24) });
      else skipped.push(line.slice(0, 40));
      continue;
    }
    const m = line.replace(/^export\s+/, '').match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    const provider = m && (ENV_PROVIDER[m[1].toUpperCase()] ?? (slugs.has(m[1].toLowerCase()) ? m[1].toLowerCase() : null));
    const secret = m?.[2].trim().replace(/^["']|["']$/g, '') ?? '';
    if (m && provider && secret) keys.push({ provider, label: 'imported', secret, source: m[1] });
    else skipped.push(m ? m[1] : line.slice(0, 40));
  }
  return { keys, skipped };
}

function ImportKeys({ providers, onClose }: { providers: Provider[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [rows, setRows] = useState<Parsed[] | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const slugs = new Set(providers.map((p) => p.slug));
  const read = (t: string) => { const r = parseKeys(t, slugs); setRows(r.keys); setSkipped(r.skipped); setText(''); };
  const save = async () => {
    if (!rows) return;
    setBusy(true);
    const out: Parsed[] = [];
    for (const k of rows) {
      try { await post('/compute/keys', { provider: k.provider, label: k.label, secret: k.secret }); out.push({ ...k, secret: '', status: 'saved' }); }
      catch (e) { out.push({ ...k, secret: '', status: 'failed', error: (e as Error).message }); }
    }
    setRows(out); setBusy(false);
    void qc.invalidateQueries({ queryKey: ['admin'] });
  };
  const done = rows?.some((r) => r.status);
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className='sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>Import keys</DialogTitle>
          <DialogDescription>Paste or choose a .env file (ANTHROPIC_API_KEY=…, CLOUDFLARE_API_TOKEN=…), a CSV with provider,label,key, or a Google service-account JSON. Nothing is saved until you confirm; keys are shown only as hints.</DialogDescription>
        </DialogHeader>
        {!rows ? (<>
          <Textarea rows={8} spellCheck={false} autoComplete='off' className='font-mono text-xs' placeholder={'ANTHROPIC_API_KEY=sk-ant-…\nCLOUDFLARE_API_TOKEN=…'} value={text} onChange={(e) => setText(e.target.value)} />
          <div className='flex items-center gap-3'>
            <Input type='file' accept='.env,.txt,.csv,.json,text/plain,application/json' className='max-w-xs' onChange={(e) => { const f = e.target.files?.[0]; if (f) void f.text().then(read); }} />
            <Button className='ml-auto' disabled={!text.trim()} onClick={() => read(text)}>Read keys</Button>
          </div>
        </>) : (<>
          <div className='max-h-72 overflow-y-auto border-y'>
            <table className='w-full text-sm'>
              <thead><tr className='text-muted-foreground text-xs'><th className='px-3 py-2 text-left font-normal'>From</th><th className='px-3 py-2 text-left font-normal'>Provider</th><th className='px-3 py-2 text-left font-normal'>Label</th><th className='px-3 py-2 text-left font-normal'>Key</th><th className='px-3 py-2 text-left font-normal'>Status</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className='border-t'>
                    <td className='px-3 py-2'><Mono>{r.source}</Mono></td>
                    <td className='px-3 py-2'><Mono>{r.provider}</Mono></td>
                    <td className='px-3 py-2'>
                      {done ? r.label : <Input aria-label='Label' value={r.label} maxLength={60} className='h-7 w-32' onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />}
                    </td>
                    <td className='px-3 py-2'><Mono>{r.status ? '—' : hint(r.secret)}</Mono></td>
                    <td className={cn('px-3 py-2', r.status === 'failed' && 'text-destructive')}>{r.status === 'saved' ? 'saved' : r.status === 'failed' ? r.error : 'ready'}</td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={5} className='text-muted-foreground px-3 py-6 text-center'>No keys recognised.</td></tr>}
              </tbody>
            </table>
          </div>
          {skipped.length > 0 && <p className='text-muted-foreground text-xs'>Skipped (not a known key): {skipped.join(', ')}</p>}
        </>)}
        <DialogFooter>
          <Button variant='outline' disabled={busy} onClick={onClose}>{done ? 'Close' : 'Cancel'}</Button>
          {rows && !done && <Button variant='ghost' onClick={() => setRows(null)}>Back</Button>}
          {rows && !done && <Button disabled={busy || !rows.length} onClick={() => void save()}>{busy ? 'Saving…' : `Import ${rows.length} key${rows.length === 1 ? '' : 's'}`}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
