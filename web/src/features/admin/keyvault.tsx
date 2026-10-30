'use client';
// The Key vault: every key Octillion uses, one row per key. Each key type (provider) holds at most one key: adding one
// to a type that has a key replaces it. Keys are kept or deleted, never switched off. Keys live in the vault only (keys
// once set as server environment variables were imported on boot) and are only ever shown as hints.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import PageContainer from '@/components/layout/page-container';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { adminApi } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { post, useAdmin, useAdminAction } from './lib';
import { Gate, useAdminRole } from './role';
import { ErrorBox, FormRow, Mono, Notice, When } from './ui';

// ---------- key vault ----------

/** A key type: every provider the vault knows, whether or not it has its key. */
interface Provider { slug: string; mode: 'gateway' | 'direct'; backend: string; has_key: boolean; credential_id: number | null; last_used_at: string | null; env_set?: string[] }
/** A provider's one key: hint (or service-account email and project) and usage only, never the secret. */
interface Credential { id: number; provider: string; hint: string; uses: number; last_used_at: string | null; created_at: string; rotated_at: string | null; project_id?: string | null; client_email?: string }
/** Display names for the vault's provider ids. */
const NAME: Record<string, string> = {
  anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google Gemini', cloudflare: 'Cloudflare Workers AI', dashscope: 'Alibaba DashScope',
  vertex: 'Vertex AI (Google Cloud)', boat: 'boat.dev', exa: 'Exa', libraries_io: 'Libraries.io', resend: 'Resend', amp: 'Amp', cursor: 'Cursor', factory: 'Factory', github_copilot: 'GitHub Copilot',
  apollo: 'Apollo', slack: 'Slack', resend_webhook: 'Resend Webhook', email_unsubscribe: 'Email Unsubscribe Signing'
};
/** Title Case fallback for a provider id the NAME map does not know ("smoke_llm" → "Smoke Llm"). */
const MINOR = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'via', 'with']);
const titleCase = (s: string) => s.replace(/[_-]+/g, ' ').trim().split(/\s+/)
  .map((w, i) => (i > 0 && MINOR.has(w.toLowerCase()) ? w.toLowerCase() : /[A-Z]/.test(w.slice(1)) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(' ');
const nameOf = (slug: string) => NAME[slug] ?? titleCase(slug);
const TYPE: Record<string, string> = {
  anthropic: 'Inference', openai: 'Inference', google: 'Inference', cloudflare: 'Inference', dashscope: 'Inference', vertex: 'Inference',
  boat: 'Sandbox', exa: 'Search', libraries_io: 'Search', resend: 'Email', resend_webhook: 'Email', email_unsubscribe: 'Email', slack: 'Alerts', apollo: 'Prospecting',
  amp: 'Coding agent', cursor: 'Coding agent', factory: 'Coding agent', github_copilot: 'Coding agent'
};
const TYPES = ['Inference', 'Sandbox', 'Search', 'Email', 'Alerts', 'Prospecting', 'Coding agent', 'Other'];
const typeOf = (slug: string) => TYPE[slug] ?? 'Other';
/** 12400 → "12.4k". */
const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
/** Key types grouped by category (in TYPES order), by display name within one. */
const grouped = (providers: Provider[]) => TYPES.map((t) => ({ type: t, items: providers.filter((p) => typeOf(p.slug) === t).sort((a, b) => nameOf(a.slug).localeCompare(nameOf(b.slug))) }))
  .filter((g) => g.items.length);

/** Every key Octillion uses, one row per key (so one per key type that has one); replace and delete from the row's ⋯ menu. */
export function AdminKeyVault() {
  const { lock, can } = useAdminRole();
  const { data, error, isLoading } = useAdmin<{ unlocked: boolean; providers: Provider[]; credentials: Credential[] }>('/compute/keys');
  const [adding, setAdding] = useState<string | null>(null);
  const [del, setDel] = useState<Credential | null>(null);
  const [importing, setImporting] = useState(false);
  const remove = useAdminAction((id: number) => adminApi('DELETE', `/compute/keys/${id}`), { success: 'Key deleted' });
  const providers = data?.providers ?? [];
  const locked = data?.unlocked === false;
  const cols: RecordCol<Credential>[] = [
    { key: 'type', label: 'Type', keep: true, type: 'text', value: (c) => nameOf(c.provider),
      render: (c) => <span className='font-medium' title={c.provider}>{nameOf(c.provider)}</span> },
    { key: 'category', label: 'Category', type: 'select', value: (c) => typeOf(c.provider), options: TYPES.map((t) => ({ value: t })),
      render: (c) => <span className='text-muted-foreground'>{typeOf(c.provider)}</span> },
    { key: 'key', label: 'Key', className: 'w-80 max-w-80', type: 'text', value: (c) => c.client_email ?? c.hint, render: (c) => (
      // Cut short to the column's width; the full text is on hover.
      <span className='flex min-w-0 flex-col gap-0.5' title={c.client_email ? `${c.client_email}${c.project_id ? ` · project ${c.project_id}` : ''}` : c.hint}>
        <span className='truncate font-mono text-xs'>{c.client_email ?? c.hint}</span>
        {c.client_email && c.project_id && <span className='text-muted-foreground truncate text-xs'>project {c.project_id}</span>}
      </span>
    ) },
    { key: 'used', label: 'Used', type: 'number', value: (c) => c.uses, render: (c) => (
      <span className='flex flex-col gap-0.5'><span className='tabular-nums'>{COMPACT.format(c.uses)} uses</span>
        <span className='text-muted-foreground text-xs'>{c.last_used_at ? <>last <When d={c.last_used_at} /></> : 'never used'}</span></span>
    ) },
    { key: 'added', label: 'Added / rotated', type: 'date', value: (c) => c.rotated_at ?? c.created_at, render: (c) => (
      <span className='flex flex-col gap-0.5'><When d={c.rotated_at ?? c.created_at} /><span className='text-muted-foreground text-xs'>{c.rotated_at ? 'rotated' : 'added'}</span></span>
    ) }
  ];
  return (
    <PageContainer>
      <ErrorBox error={error} />
      {locked && <Notice>The key vault is locked: set <Mono>OCTILLION_VAULT_KEY</Mono> on the server to add keys.</Notice>}
      <RecordView id='key-vault' rows={data?.credentials ?? []} loading={isLoading} rowKey={(c) => String(c.id)} cols={cols} noun='keys' stacked
        searchText={(c) => `${c.provider} ${nameOf(c.provider)} ${typeOf(c.provider)} ${c.hint} ${c.client_email ?? ''} ${c.project_id ?? ''}`}
        searchPlaceholder='Search keys · encrypted at rest; agents get scoped gateway tokens, never these keys'
        views={[{ id: 'all', label: 'All' }, ...TYPES.slice(0, 4).map((t) => ({ id: t, label: t, match: (c: Credential) => typeOf(c.provider) === t }))]}
        defaultSort={[{ key: 'category', dir: 'asc' }]}
        onImport={can('keys') && !locked ? () => setImporting(true) : undefined} importLabel='Import keys'
        primary={<Gate need='keys'><Button onClick={() => setAdding('')} disabled={locked || !providers.length}><Icons.add /> Add key</Button></Gate>}
        actions={(c) => [
          { label: 'Replace key…', icon: <Icons.refresh />, disabled: locked, onSelect: () => setAdding(c.provider) },
          { label: 'Delete…', icon: <Icons.trash />, destructive: true, separator: true, onSelect: () => setDel(c) }
        ].map((a) => lock(a, 'keys'))}
        exportName='key-vault' empty='No keys yet. Add one with Add key.' />
      {importing && <ImportKeys providers={providers} onClose={() => setImporting(false)} />}
      {adding !== null && <AddKey providers={providers} initial={adding} onClose={() => setAdding(null)} />}
      <AlertDialog open={!!del} onOpenChange={(o) => !o && setDel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the {del && nameOf(del.provider)} key?</AlertDialogTitle>
            <AlertDialogDescription>
              Calls stop using it at once, and {del && nameOf(del.provider)} has no key until one is added again. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant='destructive' onClick={() => { if (del) remove.mutate(del.id); setDel(null); }}>Delete key</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  );
}

/**
 * Add a key, or replace a type's key. A key is posted once and the form is cleared; a failed save asks for it again
 * rather than keeping it on screen. `initial` is the type to start on ('' = the first type without a key).
 */
function AddKey({ providers, initial, onClose }: { providers: Provider[]; initial: string; onClose: () => void }) {
  const groups = grouped(providers);
  const first = initial || (groups.flatMap((g) => g.items).find((p) => !p.has_key) ?? groups[0]?.items[0])?.slug || '';
  const [f, setF] = useState({ provider: first, secret: '' });
  const [err, setErr] = useState('');
  const [file, setFile] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [drag, setDrag] = useState(false);
  // A key file read in the browser: the BOM some editors add is dropped so the JSON parses; the text never renders.
  const readFile = (fl: File | undefined) => { if (fl) void fl.text().then((t) => { setFile(fl.name); setErr(''); setF((x) => ({ ...x, secret: t.replace(/^﻿/, '').trim() })); }); };
  const add = useAdminAction(() => post<{ hint: string; project_id?: string; replaced?: boolean }>('/compute/keys', { provider: f.provider, secret: f.secret }),
    { success: (r) => `${r.replaced ? 'Key replaced' : 'Key saved'} (${r.project_id ? `${r.project_id} · ` : ''}${r.hint})` });
  const vertex = f.provider === 'vertex';
  const replacing = !!providers.find((p) => p.slug === f.provider)?.has_key;
  const sa = vertex && f.secret.trim() ? checkServiceAccount(f.secret) : null;
  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (sa && 'error' in sa) return setErr(sa.error);
    add.mutate(undefined, { onSuccess: onClose, onError: (x) => { setErr(x.message); setF({ ...f, secret: '' }); } });
  };
  const switchType = (provider: string) => { setF({ provider, secret: '' }); setFile(null); setPasting(false); setErr(''); };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <form onSubmit={submit} className='grid min-w-0 gap-4 [&>*]:min-w-0' autoComplete='off'>
          <DialogHeader>
            <DialogTitle>{replacing ? `Replace the ${nameOf(f.provider)} key` : 'Add key'}</DialogTitle>
            <DialogDescription>One key per type: a type that has a key gets it replaced. Encrypted at rest and shown only as a hint once saved.</DialogDescription>
          </DialogHeader>
          <FormRow id='ak-provider' label='Key type'>
            <NativeSelect id='ak-provider' value={f.provider} onChange={(e) => switchType(e.target.value)} className='w-full'>
              {groups.map((g) => (
                <NativeSelectOptGroup key={g.type} label={g.type}>
                  {g.items.map((p) => <NativeSelectOption key={p.slug} value={p.slug}>{nameOf(p.slug)}{p.has_key ? ' (has a key, will be replaced)' : ''}</NativeSelectOption>)}
                </NativeSelectOptGroup>
              ))}
            </NativeSelect>
          </FormRow>
          <FormRow id='ak-secret' label={vertex ? 'Service-account JSON' : 'Key'}
            hint={vertex ? 'A Google Cloud service-account JSON key. Every Vertex AI backend signs in with it (Claude on Vertex AI: project from the key, region from Agent configuration).' : undefined}>
            {vertex
              ? <div className='grid min-w-0 gap-2'>
                  {!f.secret ? (
                    <label onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
                      onDrop={(e) => { e.preventDefault(); setDrag(false); readFile(e.dataTransfer.files?.[0]); }}
                      className={cn('flex cursor-pointer flex-col items-center gap-1 rounded-md border border-dashed px-4 py-6 text-center text-sm', drag ? 'border-primary bg-primary/5' : 'hover:bg-muted/40')}>
                      <Icons.upload className='text-muted-foreground size-5' />
                      <span className='font-medium'>Drop the key file here, or choose it</span>
                      <span className='text-muted-foreground text-xs'>The .json file Google Cloud downloads. It is checked here and never shown.</span>
                      <input type='file' accept='.json,application/json' className='sr-only' aria-label='Choose the service-account JSON file' onChange={(e) => { readFile(e.target.files?.[0]); e.target.value = ''; }} />
                    </label>
                  ) : (
                    <div className={cn('flex min-w-0 items-start gap-3 overflow-hidden rounded-md border px-3 py-2.5 text-sm', sa && 'error' in sa ? 'border-destructive/40' : 'border-emerald-500/40')}>
                      {sa && 'error' in sa ? <Icons.warning className='text-destructive mt-0.5 size-4 shrink-0' /> : <Icons.circleCheck className='mt-0.5 size-4 shrink-0 text-emerald-600' />}
                      <div className='min-w-0 flex-1 space-y-0.5'>
                        <div className='truncate font-medium' title={file ?? undefined}>{file ?? 'Pasted key'}</div>
                        {sa && ('error' in sa
                          ? <p className='text-destructive text-xs'>{sa.error}</p>
                          : <p className='text-muted-foreground truncate text-xs'><Mono>{sa.project_id}</Mono> · <Mono>{sa.client_email}</Mono></p>)}
                      </div>
                      <Button type='button' variant='ghost' size='xs' className='shrink-0' onClick={() => { setF({ ...f, secret: '' }); setFile(null); setPasting(false); }}>Choose another</Button>
                    </div>
                  )}
                  {!f.secret && (pasting
                    ? <Textarea id='ak-secret' rows={3} spellCheck={false} autoComplete='off' className='font-mono text-xs [-webkit-text-security:disc]' placeholder='Paste the whole key file' value={f.secret}
                        onChange={(e) => { setFile(null); setF({ ...f, secret: e.target.value.replace(/^﻿/, '').trim() }); }} />
                    : <button type='button' className='text-muted-foreground hover:text-foreground self-start text-xs underline-offset-2 hover:underline' onClick={() => setPasting(true)}>Or paste the JSON instead</button>)}
                </div>
              : <Input id='ak-secret' type='password' autoComplete='new-password' spellCheck={false} required value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} />}
          </FormRow>
          {err && <p className='text-destructive text-sm'>{err}</p>}
          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose}>Cancel</Button>
            <Gate need='keys'><Button type='submit' disabled={add.isPending || !f.provider || !f.secret.trim() || (!!sa && 'error' in sa)}>{replacing ? 'Replace key' : 'Save key'}</Button></Gate>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The same checks the server makes on a Vertex AI key (src/keyvault.ts checkServiceAccount); never shows the key. */
function checkServiceAccount(text: string): { project_id: string; client_email: string } | { error: string } {
  let j: Record<string, unknown>;
  try { j = JSON.parse(text); } catch { return { error: 'That is not valid JSON: paste the whole service-account key file from Google Cloud' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { error: 'That is not a service-account key file' };
  if (j.type !== 'service_account') return { error: 'That is not a service-account key: "type" must be "service_account"' };
  for (const k of ['project_id', 'client_email', 'private_key']) if (typeof j[k] !== 'string' || !(j[k] as string).trim()) return { error: `The service-account key has no ${k}` };
  return { project_id: j.project_id as string, client_email: j.client_email as string };
}

/** Environment variable names Octillion knows, to the vault provider that holds them. */
const ENV_PROVIDER: Record<string, string> = {
  ANTHROPIC_API_KEY: 'anthropic', OPENAI_API_KEY: 'openai', CODEX_API_KEY: 'openai', GEMINI_API_KEY: 'google', GOOGLE_API_KEY: 'google',
  CLOUDFLARE_API_TOKEN: 'cloudflare', CF_API_TOKEN: 'cloudflare', DASHSCOPE_API_KEY: 'dashscope', BOAT_API_KEY: 'boat', EXA_API_KEY: 'exa',
  LIBRARIES_IO_API_KEY: 'libraries_io', RESEND_API_KEY: 'resend', AMP_API_KEY: 'amp', CURSOR_API_KEY: 'cursor', FACTORY_API_KEY: 'factory', COPILOT_GITHUB_TOKEN: 'github_copilot'
};
interface Parsed { provider: string; secret: string; source: string; status?: 'saved' | 'failed'; error?: string }
const hint = (s: string) => (s.trim().startsWith('{') ? 'service-account JSON' : s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : '••••');

/**
 * Keys from a .env file (KNOWN_NAME=value), a CSV (provider,key; a label column from older exports is ignored) or a
 * Google service-account JSON (the Vertex AI key). Parsed in the browser, shown by hint only, then saved one by one;
 * lines it does not recognise are listed.
 */
function parseKeys(text: string, slugs: Set<string>): { keys: Parsed[]; skipped: string[] } {
  const t = text.trim(), keys: Parsed[] = [], skipped: string[] = [];
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      if (j.type === 'service_account' && slugs.has('vertex')) return { keys: [{ provider: 'vertex', secret: t, source: `service-account JSON${j.client_email ? ` (${j.client_email})` : ''}` }], skipped };
    } catch { /* not JSON */ }
  }
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const header = /^(provider|type)\s*,/i.test(lines[0] ?? '') ? lines[0].split(',').map((x) => x.trim().toLowerCase()) : null;
  const pi = header ? Math.max(0, header.findIndex((h) => h === 'provider' || h === 'type')) : 0;
  const ki = header ? header.findIndex((h) => h === 'key' || h === 'secret') : -1;
  for (const line of header ? lines.slice(1) : lines) {
    if (header) {
      const cells = line.split(',').map((x) => x.trim());
      const at = ki >= 0 ? ki : cells.length - 1; // the key column runs to the end of the line (a key may hold commas)
      const provider = cells[pi], secret = cells.slice(at).join(',').replace(/^["']|["']$/g, '');
      if (slugs.has(provider) && secret) keys.push({ provider, secret, source: line.slice(0, 24) });
      else skipped.push(line.slice(0, 40));
      continue;
    }
    const m = line.replace(/^export\s+/, '').match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    const provider = m && (ENV_PROVIDER[m[1].toUpperCase()] ?? (slugs.has(m[1].toLowerCase()) ? m[1].toLowerCase() : null));
    const secret = m?.[2].trim().replace(/^["']|["']$/g, '') ?? '';
    if (m && provider && secret) keys.push({ provider, secret, source: m[1] });
    else skipped.push(m ? m[1] : line.slice(0, 40));
  }
  return { keys, skipped };
}

/** One row per key type; an import naming a type twice is refused until the extra rows are gone. */
function ImportKeys({ providers, onClose }: { providers: Provider[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [rows, setRows] = useState<Parsed[] | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const slugs = new Set(providers.map((p) => p.slug));
  const hasKey = new Set(providers.filter((p) => p.has_key).map((p) => p.slug));
  const read = (t: string) => { const r = parseKeys(t, slugs); setRows(r.keys); setSkipped(r.skipped); setText(''); };
  const count = (provider: string) => rows?.filter((r) => r.provider === provider).length ?? 0;
  const dupes = [...new Set((rows ?? []).filter((r) => count(r.provider) > 1).map((r) => r.provider))];
  const save = async () => {
    if (!rows || dupes.length) return;
    setBusy(true);
    const out: Parsed[] = [];
    for (const k of rows) {
      try { await post('/compute/keys', { provider: k.provider, secret: k.secret }); out.push({ ...k, secret: '', status: 'saved' }); }
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
          <DialogDescription>Paste or choose a .env file (ANTHROPIC_API_KEY=…, CLOUDFLARE_API_TOKEN=…), a CSV with provider,key, or a Google service-account JSON. One key per type: a type that has a key gets it replaced. Nothing is saved until you confirm; keys are shown only as hints.</DialogDescription>
        </DialogHeader>
        {!rows ? (<>
          <Textarea rows={8} spellCheck={false} autoComplete='off' className='font-mono text-xs' placeholder={'ANTHROPIC_API_KEY=sk-ant-…\nCLOUDFLARE_API_TOKEN=…'} value={text} onChange={(e) => setText(e.target.value)} />
          <div className='flex items-center gap-3'>
            <Input type='file' accept='.env,.txt,.csv,.json,text/plain,application/json' className='max-w-xs' onChange={(e) => { const f = e.target.files?.[0]; if (f) void f.text().then(read); }} />
            <Button className='ml-auto' disabled={!text.trim()} onClick={() => read(text)}>Read keys</Button>
          </div>
        </>) : (<>
          <div className='max-h-72 overflow-y-auto border'>
            <table className='w-full text-sm [&_td]:border-r [&_td:last-child]:border-r-0 [&_th]:border-r [&_th:last-child]:border-r-0'>
              <thead><tr className='text-muted-foreground border-b text-xs'><th className='px-3 py-2 text-left font-normal'>From</th><th className='px-3 py-2 text-left font-normal'>Type</th><th className='px-3 py-2 text-left font-normal'>Key</th><th className='px-3 py-2 text-left font-normal'>Status</th><th className='px-3 py-2 text-left font-normal'>Actions</th></tr></thead>
              <tbody>
                {rows.map((r, i) => {
                  const dupe = !r.status && count(r.provider) > 1;
                  return (
                    <tr key={i} className='border-t'>
                      <td className='px-3 py-2'><Mono>{r.source}</Mono></td>
                      <td className='px-3 py-2'>{nameOf(r.provider)}</td>
                      <td className='px-3 py-2'><Mono>{r.status ? '—' : hint(r.secret)}</Mono></td>
                      <td className={cn('px-3 py-2', (r.status === 'failed' || dupe) && 'text-destructive')}>
                        {r.status === 'saved' ? 'saved' : r.status === 'failed' ? r.error : dupe ? 'duplicate type' : hasKey.has(r.provider) ? 'ready, replaces the current key' : 'ready'}
                      </td>
                      <td className='px-3 py-2'>{!done && <Button variant='ghost' size='xs' onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</Button>}</td>
                    </tr>
                  );
                })}
                {!rows.length && <tr><td colSpan={5} className='text-muted-foreground px-3 py-6 text-center'>No keys recognised.</td></tr>}
              </tbody>
            </table>
          </div>
          {dupes.length > 0 && !done && <p className='text-destructive text-sm'>Each type can have one key: {dupes.map(nameOf).join(', ')} {dupes.length === 1 ? 'appears' : 'appear'} more than once. Remove the extra rows to import.</p>}
          {skipped.length > 0 && <p className='text-muted-foreground text-xs'>Skipped (not a known key): {skipped.join(', ')}</p>}
        </>)}
        <DialogFooter>
          <Button variant='outline' disabled={busy} onClick={onClose}>{done ? 'Close' : 'Cancel'}</Button>
          {rows && !done && <Button variant='ghost' onClick={() => setRows(null)}>Back</Button>}
          {rows && !done && <Gate need='keys'><Button disabled={busy || !rows.length || dupes.length > 0} onClick={() => void save()}>{busy ? 'Saving…' : `Import ${rows.length} key${rows.length === 1 ? '' : 's'}`}</Button></Gate>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
