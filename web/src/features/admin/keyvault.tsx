'use client';
// The Key vault: every key Octillion uses, one row per key. Each key has one type (provider), picked from the list when
// it is added; a type may hold several keys (two Vertex AI keys are two rows), which requests use in turn, least
// recently used first. Adding a key always creates a row; a key is replaced on its own row or deleted, never switched
// off. Keys live in the vault only (keys once set as server environment variables were imported on boot) and are
// only ever shown as hints.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import PageContainer from '@/components/layout/page-container';
import { ActionsMenu, RecordView, type RecordCol, type RowAction } from '@/components/layout/record-view';
import { DetailMeta, DetailTabs, KeyValueTable } from '@/components/layout/detail';
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
import { ErrorBox, FormRow, Mono, Notice, StatusBadge, When } from './ui';

// ---------- key vault ----------

/** A key type: every provider the vault knows, with how many keys it holds. */
interface Provider { slug: string; name?: string; mode: 'gateway' | 'direct'; backend: string; has_key: boolean; keys?: number; env_set?: string[] }
/** One key (one row): its name, type, hint (or service-account email and project) and usage only, never the secret. */
interface Credential {
  id: number; provider: string; name: string; type_name?: string; hint: string; uses: number; last_used_at: string | null; created_at: string; rotated_at: string | null;
  project_id?: string | null; client_email?: string;
}
/** Title Case fallback for a provider id the server sent no name for ("smoke_llm" → "Smoke Llm"). */
const titleCase = (s: string) => s.replace(/[_-]+/g, ' ').trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
const CATEGORY: Record<string, string> = {
  anthropic: 'Inference', openai: 'Inference', google: 'Inference', cloudflare: 'Inference', dashscope: 'Inference', vertex: 'Inference',
  boat: 'Sandbox', exa: 'Search', libraries_io: 'Search', resend: 'Email', resend_webhook: 'Email', email_unsubscribe: 'Email', slack: 'Alerts', apollo: 'Prospecting',
  amp: 'Coding agent', cursor: 'Coding agent', factory: 'Coding agent', github_copilot: 'Coding agent'
};
const CATEGORIES = ['Inference', 'Sandbox', 'Search', 'Email', 'Alerts', 'Prospecting', 'Coding agent', 'Other'];
const categoryOf = (slug: string) => CATEGORY[slug] ?? 'Other';
/** The generated unsubscribe-link signing key: a singleton, never added by hand, replaced or imported (every link
 *  already sent is signed with it). */
const GENERATED = new Set(['email_unsubscribe']);
/** 12400 → "12.4k". */
const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
type NameOf = (slug: string) => string;
const namer = (providers: Provider[]): NameOf => {
  const m = new Map(providers.map((p) => [p.slug, p.name]));
  return (slug) => m.get(slug) || titleCase(slug);
};
/** Key types grouped by category (in CATEGORIES order), by display name within one. */
const grouped = (providers: Provider[], nameOf: NameOf) => CATEGORIES.map((t) => ({ type: t, items: providers.filter((p) => categoryOf(p.slug) === t).sort((a, b) => nameOf(a.slug).localeCompare(nameOf(b.slug))) }))
  .filter((g) => g.items.length);
const keyText = (c: Credential) => c.client_email ?? c.hint;

/** Every key Octillion uses, one row per key; replace or delete one from its row's ⋯ menu or its peek. */
export function AdminKeyVault() {
  const { lock, can } = useAdminRole();
  const { data, error, isLoading } = useAdmin<{ unlocked: boolean; providers: Provider[]; credentials: Credential[] }>('/compute/keys');
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState<Credential | null>(null);
  const [del, setDel] = useState<Credential | null>(null);
  const [importing, setImporting] = useState(false);
  const remove = useAdminAction((id: number) => adminApi('DELETE', `/compute/keys/${id}`), { success: 'Key deleted' });
  const providers = data?.providers ?? [];
  const creds = data?.credentials ?? [];
  const nameOf = namer(providers);
  const typeName = (c: Credential) => c.type_name || nameOf(c.provider);
  const locked = data?.unlocked === false;
  const sameType = (c: Credential) => creds.filter((x) => x.provider === c.provider).length;
  const actions = (c: Credential): RowAction[] => [
    ...(GENERATED.has(c.provider) ? [] : [{ label: 'Replace key…', icon: <Icons.refresh />, disabled: locked, onSelect: () => setReplacing(c) }]),
    { label: 'Delete…', icon: <Icons.trash />, destructive: true, separator: !GENERATED.has(c.provider), onSelect: () => setDel(c) }
  ].map((a) => lock(a, 'keys'));
  const cols: RecordCol<Credential>[] = [
    { key: 'name', label: 'Name', title: true, keep: true, type: 'text', value: (c) => c.name,
      render: (c) => <span className='font-medium'>{c.name}</span> },
    { key: 'type', label: 'Type', type: 'text', value: (c) => typeName(c),
      render: (c) => <span title={c.provider}>{typeName(c)}</span> },
    { key: 'category', label: 'Category', type: 'select', value: (c) => categoryOf(c.provider), options: CATEGORIES.map((t) => ({ value: t })),
      render: (c) => <span className='text-muted-foreground'>{categoryOf(c.provider)}</span> },
    { key: 'key', label: 'Key', className: 'w-80 max-w-80', type: 'text', value: (c) => keyText(c), render: (c) => (
      // Cut short to the column's width; the full text is on hover.
      <span className='flex min-w-0 flex-col gap-0.5' title={c.client_email ? `${c.client_email}${c.project_id ? ` · project ${c.project_id}` : ''}` : c.hint}>
        <span className='truncate font-mono text-xs'>{keyText(c)}</span>
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
      <RecordView id='key-vault' rows={creds} loading={isLoading} rowKey={(c) => String(c.id)} cols={cols} noun='keys' stacked
        searchText={(c) => `${c.name} ${c.provider} ${typeName(c)} ${categoryOf(c.provider)} ${c.hint} ${c.client_email ?? ''} ${c.project_id ?? ''}`}
        searchPlaceholder='Search keys · encrypted at rest; agents get scoped gateway tokens, never these keys'
        views={[{ id: 'all', label: 'All' }, ...CATEGORIES.slice(0, 4).map((t) => ({ id: t, label: t, match: (c: Credential) => categoryOf(c.provider) === t }))]}
        defaultSort={[{ key: 'category', dir: 'asc' }]}
        onImport={can('keys') && !locked ? () => setImporting(true) : undefined} importLabel='Import keys'
        primary={<Gate need='keys'><Button onClick={() => setAdding(true)} disabled={locked || !providers.length}><Icons.add /> Add key</Button></Gate>}
        actions={actions}
        detailTitle={() => 'Key'}
        detail={(c) => (
          <div className='flex flex-col gap-4 text-sm'>
            <DetailMeta
              title={c.name}
              subtitle={<>{typeName(c)} · {categoryOf(c.provider)}</>}
              badges={<>
                <StatusBadge tone={c.uses ? 'ok' : 'neutral'}>{c.uses ? 'in use' : 'never used'}</StatusBadge>
                {GENERATED.has(c.provider) && <StatusBadge tone='info' title='Generated by Octillion; never replaced'>generated</StatusBadge>}
              </>}
              actions={<ActionsMenu items={actions(c)} />}
              facts={[
                { label: 'Key', value: <Mono>{keyText(c)}</Mono>, wide: true },
                { label: 'Project', value: c.project_id, hidden: !c.project_id },
                { label: 'Used', value: `${COMPACT.format(c.uses)} uses`, hint: c.last_used_at ? <>last <When d={c.last_used_at} /></> : 'never used' },
                { label: c.rotated_at ? 'Rotated' : 'Added', value: <When d={c.rotated_at ?? c.created_at} />, hint: c.rotated_at ? <>added <When d={c.created_at} /></> : undefined }
              ]}
            />
            <DetailTabs resetKey={c.id} tabs={[
              { id: 'details', label: 'Details', content: (
                <KeyValueTable rows={[
                  { label: 'Name', value: c.name },
                  { label: 'Type', value: <>{typeName(c)} <span className='text-muted-foreground'>(<Mono>{c.provider}</Mono>)</span></> },
                  { label: 'Category', value: categoryOf(c.provider) },
                  { label: 'Key', value: <Mono>{c.hint}</Mono>, hidden: !!c.client_email },
                  { label: 'Service account', value: c.client_email ? <Mono>{c.client_email}</Mono> : null, hidden: !c.client_email },
                  { label: 'Project', value: c.project_id ? <Mono>{c.project_id}</Mono> : null, hidden: !c.project_id },
                  { label: 'Keys of this type', value: sameType(c) > 1 ? `${sameType(c)}, used in turn (least recently used first)` : '1 (this one)' },
                  { label: 'Uses', value: c.uses.toLocaleString('en') },
                  { label: 'Last used', value: c.last_used_at ? <When d={c.last_used_at} /> : 'never' },
                  { label: 'Added', value: <When d={c.created_at} /> },
                  { label: 'Rotated', value: c.rotated_at ? <When d={c.rotated_at} /> : 'never replaced' },
                  { label: 'Credential id', value: <Mono>#{c.id}</Mono> }
                ]} />
              ) }
            ]} />
          </div>
        )}
        exportName='key-vault' empty='No keys yet. Add one with Add key.' />
      {importing && <ImportKeys providers={providers} nameOf={nameOf} onClose={() => setImporting(false)} />}
      {adding && <AddKey providers={providers.filter((p) => !GENERATED.has(p.slug))} nameOf={nameOf} onClose={() => setAdding(false)} />}
      {replacing && <ReplaceKey cred={replacing} typeName={typeName(replacing)} onClose={() => setReplacing(null)} />}
      <AlertDialog open={!!del} onOpenChange={(o) => !o && setDel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {del?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {del && GENERATED.has(del.provider)
                ? 'Every unsubscribe link (and reply address) in emails already sent is signed with this key: deleting it breaks all of them for good. A new key is generated on the next send. This cannot be undone.'
                : del && sameType(del) > 1
                  ? <>Calls stop using it at once; the other {typeName(del)} {sameType(del) === 2 ? 'key carries on' : 'keys carry on'}. This cannot be undone.</>
                  : <>Calls stop using it at once, and {del && typeName(del)} has no key until one is added again. This cannot be undone.</>}
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
 * The secret input: a password field, or for a Vertex AI key the service-account JSON (dropped, chosen or pasted),
 * checked in the browser and never shown. `onChange('')` clears it.
 */
function SecretField({ id, vertex, value, onChange, onError }: { id: string; vertex: boolean; value: string; onChange: (v: string) => void; onError: (e: string) => void }) {
  const [file, setFile] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [drag, setDrag] = useState(false);
  // A key file read in the browser: the BOM some editors add is dropped so the JSON parses; the text never renders.
  const readFile = (fl: File | undefined) => { if (fl) void fl.text().then((t) => { setFile(fl.name); onError(''); onChange(t.replace(/^﻿/, '').trim()); }); };
  const sa = vertex && value.trim() ? checkServiceAccount(value) : null;
  if (!vertex) return <Input id={id} type='password' autoComplete='new-password' spellCheck={false} required value={value} onChange={(e) => onChange(e.target.value)} />;
  return (
    <div className='grid min-w-0 gap-2'>
      {!value ? (
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
          <Button type='button' variant='ghost' size='xs' className='shrink-0' onClick={() => { onChange(''); setFile(null); setPasting(false); }}>Choose another</Button>
        </div>
      )}
      {!value && (pasting
        ? <Textarea id={id} rows={3} spellCheck={false} autoComplete='off' className='font-mono text-xs [-webkit-text-security:disc]' placeholder='Paste the whole key file' value={value}
            onChange={(e) => { setFile(null); onChange(e.target.value.replace(/^﻿/, '').trim()); }} />
        : <button type='button' className='text-muted-foreground hover:text-foreground self-start text-xs underline-offset-2 hover:underline' onClick={() => setPasting(true)}>Or paste the JSON instead</button>)}
    </div>
  );
}

const VERTEX_HINT = 'A Google Cloud service-account JSON key. Vertex AI backends sign in with the Vertex AI keys in turn (Claude on Vertex AI: project from the key, region from Agent configuration).';

/**
 * Add a key: always a new row of the chosen type, never a replacement. A key is posted once and the form is cleared; a
 * failed save (an identical key already in the vault included) asks for it again rather than keeping it on screen.
 */
function AddKey({ providers, nameOf, onClose }: { providers: Provider[]; nameOf: NameOf; onClose: () => void }) {
  const groups = grouped(providers, nameOf);
  const first = (groups.flatMap((g) => g.items).find((p) => !p.has_key) ?? groups[0]?.items[0])?.slug || '';
  const [f, setF] = useState({ provider: first, name: '', secret: '' });
  const [err, setErr] = useState('');
  const [field, setField] = useState(0); // remounts the secret field (drops a chosen file) on a type switch or a failed save
  const add = useAdminAction(() => post<{ name: string; hint: string; project_id?: string }>('/compute/keys', { provider: f.provider, name: f.name.trim() || undefined, secret: f.secret }),
    { success: (r) => `Added ${r.name} (${r.project_id ? `${r.project_id} · ` : ''}${r.hint})` });
  const vertex = f.provider === 'vertex';
  const sa = vertex && f.secret.trim() ? checkServiceAccount(f.secret) : null;
  const count = providers.find((p) => p.slug === f.provider)?.keys ?? 0;
  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (sa && 'error' in sa) return setErr(sa.error);
    add.mutate(undefined, { onSuccess: onClose, onError: (x) => { setErr(x.message); setF({ ...f, secret: '' }); setField((n) => n + 1); } });
  };
  const switchType = (provider: string) => { setF({ ...f, provider, secret: '' }); setErr(''); setField((n) => n + 1); };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <form onSubmit={submit} className='grid min-w-0 gap-4 [&>*]:min-w-0' autoComplete='off'>
          <DialogHeader>
            <DialogTitle>Add key</DialogTitle>
            <DialogDescription>Each key is its own row. A type can hold several keys, used in turn. Encrypted at rest and shown only as a hint once saved.</DialogDescription>
          </DialogHeader>
          <FormRow id='ak-provider' label='Key type' hint={count ? `${nameOf(f.provider)} has ${count} key${count === 1 ? '' : 's'}; this one is added alongside.` : undefined}>
            <NativeSelect id='ak-provider' value={f.provider} onChange={(e) => switchType(e.target.value)} className='w-full'>
              {groups.map((g) => (
                <NativeSelectOptGroup key={g.type} label={g.type}>
                  {g.items.map((p) => <NativeSelectOption key={p.slug} value={p.slug}>{nameOf(p.slug)}</NativeSelectOption>)}
                </NativeSelectOptGroup>
              ))}
            </NativeSelect>
          </FormRow>
          <FormRow id='ak-name' label='Name (optional)' hint='To tell keys apart. Left empty, it is named automatically.'>
            <Input id='ak-name' maxLength={80} placeholder={`${nameOf(f.provider)} key${count ? ` ${count + 1}` : ''}`} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </FormRow>
          <FormRow id='ak-secret' label={vertex ? 'Service-account JSON' : 'Key'} hint={vertex ? VERTEX_HINT : undefined}>
            <SecretField key={field} id='ak-secret' vertex={vertex} value={f.secret} onChange={(secret) => setF((x) => ({ ...x, secret }))} onError={setErr} />
          </FormRow>
          {err && <p className='text-destructive text-sm'>{err}</p>}
          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose}>Cancel</Button>
            <Gate need='keys'><Button type='submit' disabled={add.isPending || !f.provider || !f.secret.trim() || (!!sa && 'error' in sa)}>Add key</Button></Gate>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Replace one key's secret on its own row; the type's other keys are untouched. */
function ReplaceKey({ cred, typeName, onClose }: { cred: Credential; typeName: string; onClose: () => void }) {
  const [secret, setSecret] = useState('');
  const [err, setErr] = useState('');
  const [field, setField] = useState(0);
  const replace = useAdminAction(() => post<{ name: string; hint: string; project_id?: string }>(`/compute/keys/${cred.id}/replace`, { secret }),
    { success: (r) => `Replaced ${r.name} (${r.project_id ? `${r.project_id} · ` : ''}${r.hint})` });
  const vertex = cred.provider === 'vertex';
  const sa = vertex && secret.trim() ? checkServiceAccount(secret) : null;
  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (sa && 'error' in sa) return setErr(sa.error);
    replace.mutate(undefined, { onSuccess: onClose, onError: (x) => { setErr(x.message); setSecret(''); setField((n) => n + 1); } });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <form onSubmit={submit} className='grid min-w-0 gap-4 [&>*]:min-w-0' autoComplete='off'>
          <DialogHeader>
            <DialogTitle>Replace {cred.name}</DialogTitle>
            <DialogDescription>The new secret takes this row&apos;s place ({typeName}, now <Mono>{keyText(cred)}</Mono>); other keys are untouched. Calls use the new one at once.</DialogDescription>
          </DialogHeader>
          <FormRow id='rk-secret' label={vertex ? 'New service-account JSON' : 'New key'} hint={vertex ? VERTEX_HINT : undefined}>
            <SecretField key={field} id='rk-secret' vertex={vertex} value={secret} onChange={setSecret} onError={setErr} />
          </FormRow>
          {cred.provider === 'resend_webhook' && (
            <p className='flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400'><Icons.warning className='mt-0.5 size-4 shrink-0' />Replacing a webhook secret stops Resend events signed with it until the new secret is also set in Resend.</p>
          )}
          {err && <p className='text-destructive text-sm'>{err}</p>}
          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose}>Cancel</Button>
            <Gate need='keys'><Button type='submit' disabled={replace.isPending || !secret.trim() || (!!sa && 'error' in sa)}>Replace key</Button></Gate>
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
interface Parsed { provider: string; name?: string; secret: string; source: string; status?: 'saved' | 'failed'; error?: string }
const hint = (s: string) => (s.trim().startsWith('{') ? 'service-account JSON' : s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : '••••');

/**
 * Keys from a .env file (KNOWN_NAME=value), a CSV (provider,key with an optional name column) or a Google
 * service-account JSON (a Vertex AI key). Parsed in the browser, shown by hint only, then each added as its own row;
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
  const header = /^(provider|type|name)\s*,/i.test(lines[0] ?? '') ? lines[0].split(',').map((x) => x.trim().toLowerCase()) : null;
  const pi = header ? Math.max(0, header.findIndex((h) => h === 'provider' || h === 'type')) : 0;
  const ki = header ? header.findIndex((h) => h === 'key' || h === 'secret') : -1;
  const ni = header ? header.findIndex((h) => h === 'name' || h === 'label') : -1;
  for (const line of header ? lines.slice(1) : lines) {
    if (header) {
      const cells = line.split(',').map((x) => x.trim());
      const at = ki >= 0 ? ki : cells.length - 1; // the key column runs to the end of the line (a key may hold commas)
      const provider = cells[pi], secret = cells.slice(at).join(',').replace(/^["']|["']$/g, '');
      const name = ni >= 0 && ni < at ? cells[ni]?.replace(/^["']|["']$/g, '') : undefined;
      if (slugs.has(provider) && secret) keys.push({ provider, name: name && name !== 'default' ? name : undefined, secret, source: line.slice(0, 24) });
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

/** Each recognised key is added as its own row (several of one type are fine); a key already in the vault is refused
 *  on its row, and the same key twice in one import is flagged before anything is saved. */
function ImportKeys({ providers, nameOf, onClose }: { providers: Provider[]; nameOf: NameOf; onClose: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [rows, setRows] = useState<Parsed[] | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const slugs = new Set(providers.map((p) => p.slug));
  const keysOf = new Map(providers.map((p) => [p.slug, p.keys ?? (p.has_key ? 1 : 0)]));
  const read = (t: string) => { const r = parseKeys(t, slugs); setRows(r.keys); setSkipped(r.skipped); setText(''); };
  const repeated = (i: number) => !!rows && rows.findIndex((r) => r.provider === rows[i].provider && r.secret.trim() === rows[i].secret.trim()) < i;
  const dupes = (rows ?? []).filter((r, i) => !r.status && repeated(i)).length;
  const refused = (rows ?? []).filter((r) => !r.status && GENERATED.has(r.provider));
  const save = async () => {
    if (!rows || dupes || refused.length) return;
    setBusy(true);
    const out: Parsed[] = [];
    for (const k of rows) {
      try { await post('/compute/keys', { provider: k.provider, name: k.name, secret: k.secret }); out.push({ ...k, secret: '', status: 'saved' }); }
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
          <DialogDescription>Paste or choose a .env file (ANTHROPIC_API_KEY=…, CLOUDFLARE_API_TOKEN=…), a CSV with provider,key (and an optional name column), or a Google service-account JSON. Each key is added as its own row, never replacing one; a key already in the vault is refused. Nothing is saved until you confirm; keys are shown only as hints.</DialogDescription>
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
                  const dupe = !r.status && repeated(i), no = !r.status && GENERATED.has(r.provider);
                  const has = keysOf.get(r.provider) ?? 0;
                  return (
                    <tr key={i} className='border-t'>
                      <td className='px-3 py-2'><Mono>{r.source}</Mono></td>
                      <td className='px-3 py-2'>{nameOf(r.provider)}{r.name && <span className='text-muted-foreground'> · {r.name}</span>}</td>
                      <td className='px-3 py-2'><Mono>{r.status ? '—' : hint(r.secret)}</Mono></td>
                      <td className={cn('px-3 py-2', (r.status === 'failed' || dupe || no) && 'text-destructive')}>
                        {r.status === 'saved' ? 'added' : r.status === 'failed' ? r.error : no ? 'not importable: generated automatically' : dupe ? 'the same key twice in this import' : has ? `ready, added alongside ${has} existing` : 'ready'}
                      </td>
                      <td className='px-3 py-2'>{!done && <Button variant='ghost' size='xs' onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</Button>}</td>
                    </tr>
                  );
                })}
                {!rows.length && <tr><td colSpan={5} className='text-muted-foreground px-3 py-6 text-center'>No keys recognised.</td></tr>}
              </tbody>
            </table>
          </div>
          {dupes > 0 && !done && <p className='text-destructive text-sm'>The same key appears more than once in this import. Remove the repeated rows to import.</p>}
          {refused.length > 0 && !done && <p className='text-destructive text-sm'>The email unsubscribe signing key is generated automatically and never imported: every unsubscribe link already sent is signed with it. Remove that row to import.</p>}
          {skipped.length > 0 && <p className='text-muted-foreground text-xs'>Skipped (not a known key): {skipped.join(', ')}</p>}
        </>)}
        <DialogFooter>
          <Button variant='outline' disabled={busy} onClick={onClose}>{done ? 'Close' : 'Cancel'}</Button>
          {rows && !done && <Button variant='ghost' onClick={() => setRows(null)}>Back</Button>}
          {rows && !done && <Gate need='keys'><Button disabled={busy || !rows.length || dupes > 0 || refused.length > 0} onClick={() => void save()}>{busy ? 'Saving…' : `Import ${rows.length} key${rows.length === 1 ? '' : 's'}`}</Button></Gate>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
