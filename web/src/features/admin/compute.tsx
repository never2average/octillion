'use client';
// Operations pages over src/settings.ts and the default population: Agent configuration (models, run sizes, research
// limits), Harness mix (the coding-agent mix and admin-added harnesses) and Compute (/admin/compute: the on-call
// console over GET /compute/summary, src/compute.ts, with the capacity settings in its Limits table, and its Sessions
// and Orchestrators tables in compute-sessions.tsx / compute-orchestrators.tsx, its Activity chart and Autoscaler
// decisions in compute-decisions.tsx). Each setting
// shows the value in force and where it comes from: set here, the server's environment, or the built-in default.
// Saving writes platform_settings (every server picks it up within 30s) and an audit log line. Model keys are the key
// vault's credentials: a key is typed once and never shown again, only its hint.
import { Suspense, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Icons } from '@/components/icons';
import { List } from './account-peek';
import PageContainer from '@/components/layout/page-container';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { adminApi } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { post, useAdmin, useAdminAction } from './lib';
import { ErrorBox, FormRow, LoadingCards, Mono, Notice, Section, When } from './ui';
import { ActionsMenu, Field, RecordView, type RecordCol } from '@/components/layout/record-view';
import { ageOf, dur, EST, money, useNow } from './compute-common';
import { ComputeSessions } from './compute-sessions';
import { ComputeOrchestrators } from './compute-orchestrators';
import { ComputeJobs } from './compute-jobs';
import { ComputeFailures } from './compute-failures';
import { ComputeActivity, ComputeDecisions } from './compute-decisions';

interface Setting {
  key: string; group: string; label: string; help: string; kind: 'text' | 'int' | 'number' | 'choice'; default: string | number;
  options?: string[]; min?: number; max?: number; value: string | number; source: 'set' | 'env' | 'default';
  env: string | null; updated_at: string | null; updated_by: string | null;
}
interface Agent {
  id: string; label: string; harness: string; model: string | null; vendor: string | null; in_mix: boolean; weight: number; share: number;
  sandboxes: number; paused: boolean; paused_reason: string | null; runnable: boolean; status: string;
  origin: 'registry' | 'admin'; base_agent: string | null; harness_version: string | null;
}
/** A CLI of harnesses/registry.json that an added harness can use, and its added rows (GET /compute/harnesses). */
interface HarnessBase { harness: string; cli: string | null; label: string; harness_version: string | null; routes: string[]; models: string[] }
interface AddedHarness { id: string; harness: string; model: string; label: string; harness_version: string | null; notes: string | null; enabled: boolean }
interface Compute { groups: { id: string; label: string }[]; settings: Setting[]; population: { slug: string; name: string; sandbox_unit: number; as_of: string | null; agents: Agent[] } }

const pct = (x: number) => `${(x * 100).toFixed(x > 0 && x < 0.01 ? 1 : 0)}%`;

/** Agent configuration: one row per setting (models, run sizes, research limits), edited in place. */
export function AdminConfiguration() {
  const { data, error, isLoading } = useAdmin<Compute>('/compute');
  const save = useAdminAction((v: Record<string, string | null>) => adminApi<Compute>('PUT', '/compute/settings', { values: v }), { success: 'Setting saved' });
  const groupName = (id: string) => data?.groups.find((g) => g.id === id)?.label ?? id;
  const rows = (data?.settings ?? []).filter((x) => ['models', 'runs', 'research'].includes(x.group));
  const cols: RecordCol<Setting>[] = [
    { key: 'setting', label: 'Setting', keep: true, type: 'text', value: (x) => x.label,
      render: (x) => <span className='flex min-w-0 flex-col gap-1'><span className='leading-none font-medium'>{x.label}</span><span className='text-muted-foreground truncate text-xs' title={x.help}>{x.help}</span></span> },
    { key: 'group', label: 'Group', type: 'select', value: (x) => groupName(x.group), render: (x) => groupName(x.group) },
    { key: 'value', label: 'Value', className: 'w-72', keep: true, render: (x) => <span onClick={(e) => e.stopPropagation()}><InlineValue key={String(x.value)} s={x} disabled={save.isPending} onSave={(v) => save.mutate({ [x.key]: v })} /></span> },
    { key: 'source', label: 'From', type: 'select', value: (x) => (x.source === 'set' ? 'Set here' : x.source === 'env' ? 'Environment' : 'Default'),
      render: (x) => (x.source === 'set' ? <span>Set here{x.updated_at && <span className='text-muted-foreground'> · <When d={x.updated_at} /></span>}</span> : <span className='text-muted-foreground'>{x.source === 'env' ? 'Environment' : 'Default'}</span>) },
    { key: 'default', label: 'Default', type: 'text', value: (x) => String(x.default), render: (x) => <Mono>{String(x.default)}</Mono> },
    { key: 'key', label: 'Variable', type: 'text', value: (x) => x.key, render: (x) => <Mono>{x.key}</Mono> }
  ];
  return (
    <PageContainer>
      <ErrorBox error={error} />
      <RecordView id='agent-configuration' rows={rows} loading={isLoading} rowKey={(x) => x.key} cols={cols} noun='settings'
        searchText={(x) => `${x.label} ${x.key} ${x.help} ${groupName(x.group)}`} searchPlaceholder='Search settings'
        defaultSort={[{ key: 'group', dir: 'asc' }]} groupable
        actions={(x) => x.source === 'set' ? [{ label: `Reset to ${x.env != null ? 'environment' : 'default'}`, icon: <Icons.close />, onSelect: () => save.mutate({ [x.key]: null }) }] : []}
        exportName='agent-configuration' empty='No settings.' />
    </PageContainer>
  );
}

/** One setting's value, edited in its row: saves on Enter or when you leave the field, if it changed. */
function InlineValue({ s, onSave, disabled }: { s: Setting; onSave: (v: string) => void; disabled?: boolean }) {
  const [v, setV] = useState(String(s.value));
  const commit = (x: string) => { if (x.trim() !== '' && x !== String(s.value)) onSave(x); };
  return s.kind === 'choice' ? (
    <NativeSelect aria-label={s.label} value={v} disabled={disabled} onChange={(e) => { setV(e.target.value); commit(e.target.value); }} className='w-48'>
      {s.options!.map((o) => <NativeSelectOption key={o} value={o}>{o}</NativeSelectOption>)}
    </NativeSelect>
  ) : (
    <Input aria-label={s.label} value={v} disabled={disabled} onChange={(e) => setV(e.target.value)} onBlur={() => commit(v)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      className={cn('h-8', s.kind === 'text' ? 'w-64 font-mono text-sm' : 'w-28 tabular-nums')} type={s.kind === 'text' ? 'text' : 'number'} min={s.min} max={s.max} step={s.kind === 'number' ? 'any' : 1} />
  );
}
/** Key vault: provider keys for agents, orchestrators and research. */
export function AdminKeyVault() {
  return <PageContainer><div className='flex w-full flex-col gap-10 pb-10'><ModelKeys /></div></PageContainer>;
}

/** The default population's mix: every registry agent with its weight, its share of the running mix, its sandboxes out
 * of the unit, and a switch. Weights need not sum to 1: shares are renormalised over the agents that are on. */
/**
 * The agent mix, full screen: every coding agent in the registry with its weight in the default population, its share
 * of runs and sandboxes, and an on/off switch. Weights save as you leave the field; changes apply to new runs.
 */
export function AdminAgentMix() {
  const { data, error, isLoading } = useAdmin<Compute>('/compute');
  const set = useAdminAction((v: { id: string; market_share?: number; paused?: boolean }) =>
    adminApi('PUT', `/compute/agents/${encodeURIComponent(v.id)}`, { market_share: v.market_share, paused: v.paused }), { success: 'Harness mix saved' });
  const pop = data?.population;
  const [form, setForm] = useState<{ edit: AddedHarness | null } | null>(null);
  const [del, setDel] = useState<Agent | null>(null);
  const added = useAdmin<{ harnesses: AddedHarness[]; bases: HarnessBase[] }>('/compute/harnesses');
  const remove = useAdminAction((id: string) => adminApi('DELETE', `/compute/harnesses/${encodeURIComponent(id)}`), { success: 'Harness deleted' });
  const addedRow = (id: string) => added.data?.harnesses.find((h) => h.id === id) ?? null;
  // Compact: one line per harness, its model beside it, and the numbers that matter. Ids are in the export and on hover.
  const cols: RecordCol<Agent>[] = [
    { key: 'harness', label: 'Harness', keep: true, type: 'text', value: (a) => a.label,
      render: (a) => (
        <span title={a.id} className='flex min-w-0 items-center gap-1.5 leading-none'>
          <span className={cn('truncate', a.status === 'On' && 'font-medium')}>{a.label}</span>
          {a.origin === 'admin' && <span title={`Added on this page; inherits ${a.base_agent ?? a.harness}`} className='text-muted-foreground shrink-0 rounded border px-1 py-px text-[10px] leading-none'>added</span>}
        </span>
      ) },
    { key: 'cli', label: 'CLI', type: 'select', value: (a) => a.harness, render: (a) => <Mono>{a.harness}</Mono> },
    { key: 'model', label: 'Model', type: 'select', value: (a) => a.model ?? '', render: (a) => (a.model ? <Mono>{a.model.replace(/^.*\//, '')}</Mono> : <span className='text-muted-foreground'>its own</span>) },
    { key: 'weight', label: 'Weight', className: 'w-28 text-right', type: 'number', value: (a) => a.weight,
      render: (a) => <span onClick={(e) => e.stopPropagation()}><WeightInput key={a.weight} value={a.weight} disabled={set.isPending} onSave={(w) => set.mutate({ id: a.id, market_share: w })} label={`Weight of ${a.label}`} /></span> },
    { key: 'share', label: 'Share', className: 'text-right', type: 'number', value: (a) => a.share, render: (a) => <span className='tabular-nums'>{a.share ? pct(a.share) : '—'}</span> },
    { key: 'sandboxes', label: 'Sandboxes', className: 'text-right', type: 'number', value: (a) => a.sandboxes, render: (a) => <span className='tabular-nums'>{a.sandboxes || '—'}</span> },
    { key: 'status', label: 'Status', type: 'select', value: (a) => a.status, render: (a) => <span title={a.paused_reason ?? undefined} className={a.status === 'On' ? undefined : 'text-muted-foreground'}>{a.status}</span> },
    { key: 'on', label: 'On', className: 'w-12 text-right', keep: true,
      render: (a) => <span onClick={(e) => e.stopPropagation()}><Switch aria-label={`${a.label} on`} checked={a.status === 'On'} disabled={!a.runnable || set.isPending} onCheckedChange={(c) => set.mutate({ id: a.id, paused: !c })} /></span> }
  ];
  return (
    <PageContainer>
      <ErrorBox error={error} />
      <RecordView
        id='harness-mix'
        rows={pop?.agents ?? []}
        loading={isLoading}
        rowKey={(a) => a.id}
        cols={cols}
        noun='harnesses'
        searchText={(a) => `${a.label} ${a.id} ${a.model ?? ''} ${a.harness}${a.origin === 'admin' ? ' added' : ''}`}
        primary={<Button onClick={() => setForm({ edit: null })} disabled={!added.data}><Icons.add /> Add harness</Button>}
        searchPlaceholder={pop ? `Search ${pop.agents.length} harnesses (${pop.agents.filter((a) => a.status === 'On').length} on)` : 'Search harnesses'}
        views={[
          { id: 'all', label: 'All harnesses' },
          { id: 'on', label: 'On', match: (a) => a.status === 'On' },
          { id: 'off', label: 'Off', match: (a) => a.status !== 'On' }
        ]}
        initialSize={50}
        defaultSort={[{ key: 'weight', dir: 'desc' }]}
        actions={(a) => [
          { label: a.status === 'On' ? 'Turn off' : 'Turn on', icon: a.status === 'On' ? <Icons.eyeOff /> : <Icons.check />, disabled: !a.runnable, onSelect: () => set.mutate({ id: a.id, paused: a.status === 'On' }) },
          ...(a.origin === 'admin' ? [
            { label: 'Edit…', icon: <Icons.edit />, separator: true, disabled: !addedRow(a.id), onSelect: () => setForm({ edit: addedRow(a.id) }) },
            { label: 'Delete…', icon: <Icons.trash />, destructive: true, onSelect: () => setDel(a) }
          ] : [])
        ]}
        bulk={(rows, clear) => [
          { label: 'Turn on', icon: <Icons.check />, onSelect: () => { rows.filter((a) => a.runnable).forEach((a) => set.mutate({ id: a.id, paused: false })); clear(); } },
          { label: 'Turn off', icon: <Icons.eyeOff />, onSelect: () => { rows.forEach((a) => set.mutate({ id: a.id, paused: true })); clear(); } }
        ]}
        exportName='harness-mix'
        empty='No agents.'
      />
      {form && added.data && <HarnessDialog bases={added.data.bases} edit={form.edit} onClose={() => setForm(null)} />}
      <AlertDialog open={!!del} onOpenChange={(o) => !o && setDel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {del?.label}?</AlertDialogTitle>
            <AlertDialogDescription>It leaves the harness mix at once; runs already done keep their results. To use it again, add it again.</AlertDialogDescription>
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

/**
 * Add (or edit) a harness: a variant of a CLI the registry already runs, with its own model, label and optionally
 * another version pin. A new one joins the mix at weight 0 and off.
 */
function HarnessDialog({ bases, edit, onClose }: { bases: HarnessBase[]; edit: AddedHarness | null; onClose: () => void }) {
  const [f, setF] = useState({ harness: edit?.harness ?? bases[0]?.harness ?? '', model: edit?.model ?? '', label: edit?.label ?? '', version: edit?.harness_version ?? '' });
  const [labelTouched, setLabelTouched] = useState(!!edit);
  const [err, setErr] = useState('');
  const base = bases.find((b) => b.harness === f.harness);
  const autoLabel = (h: string, m: string) => `${bases.find((b) => b.harness === h)?.label ?? h} · ${m.trim().replace(/^.*\//, '') || 'model'}`;
  const label = labelTouched ? f.label : autoLabel(f.harness, f.model);
  const save = useAdminAction(() => edit
    ? adminApi('PATCH', `/compute/harnesses/${encodeURIComponent(edit.id)}`, { model: f.model.trim(), label: label.trim(), harness_version: f.version.trim() || null })
    : post('/compute/harnesses', { harness: f.harness, model: f.model.trim(), label: label.trim(), harness_version: f.version.trim() || undefined }),
  { success: edit ? 'Harness saved' : 'Harness added: give it a weight and turn it on' });
  const routes = base?.routes.map((r) => (r === 'bare' ? 'a plain model id' : `${r}/…`)).join(' or ');
  const submit = (e: React.FormEvent) => { e.preventDefault(); setErr(''); save.mutate(undefined, { onSuccess: onClose, onError: (x) => setErr(x.message) }); };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <form onSubmit={submit} className='grid gap-4' autoComplete='off'>
          <DialogHeader>
            <DialogTitle>{edit ? `Edit ${edit.label}` : 'Add harness'}</DialogTitle>
            <DialogDescription>{edit ? <Mono>{edit.id}</Mono> : 'A CLI the registry already runs, on another model. It joins the mix at weight 0, off.'}</DialogDescription>
          </DialogHeader>
          <FormRow id='hx-base' label='CLI' hint={base && <>Pinned at <Mono>{base.harness_version ?? 'latest'}</Mono>{base.cli && <> · runs <Mono>{base.cli}</Mono></>}</>}>
            <NativeSelect id='hx-base' value={f.harness} disabled={!!edit} onChange={(e) => setF({ ...f, harness: e.target.value })} className='w-full'>
              {bases.map((b) => <NativeSelectOption key={b.harness} value={b.harness}>{b.label} ({b.harness_version ?? 'latest'})</NativeSelectOption>)}
            </NativeSelect>
          </FormRow>
          <FormRow id='hx-model' label='Model' hint={routes && <>Use {routes}: the routes this CLI is verified on through the gateway.</>}>
            <Input id='hx-model' required list='hx-models' spellCheck={false} className='font-mono text-sm' placeholder={base?.models[0] ?? ''} value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} />
            <datalist id='hx-models'>{base?.models.map((m) => <option key={m} value={m} />)}</datalist>
          </FormRow>
          <FormRow id='hx-label' label='Label'>
            <Input id='hx-label' required maxLength={80} value={label} onChange={(e) => { setLabelTouched(true); setF({ ...f, label: e.target.value }); }} />
          </FormRow>
          <FormRow id='hx-version' label='Version pin (optional)' hint={`Empty: the CLI's pin${base?.harness_version ? ` (${base.harness_version})` : ''}. Another version is installed in each sandbox.`}>
            <Input id='hx-version' spellCheck={false} className='font-mono text-sm' maxLength={60} placeholder={base?.harness_version ?? ''} value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })} />
          </FormRow>
          {err && <p className='text-destructive text-sm'>{err}</p>}
          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose}>Cancel</Button>
            <Button type='submit' disabled={save.isPending || !f.model.trim() || !label.trim()}>{edit ? 'Save' : 'Add harness'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const NA = <span className='text-muted-foreground'>—</span>;

/** A weight that saves when you leave the field or press Enter, if it changed (keyed by the saved weight, so a save resets it). */
function WeightInput({ value, onSave, disabled, label }: { value: number; onSave: (v: number) => void; disabled?: boolean; label: string }) {
  const fmt = (v: number) => String(Math.round(v * 10000) / 10000);
  const [v, setV] = useState(fmt(value));
  const commit = () => { const n = Number(v); if (v.trim() !== '' && Number.isFinite(n) && n >= 0 && fmt(n) !== fmt(value)) onSave(n); else setV(fmt(value)); };
  return (
    <Input aria-label={label} type='number' min={0} step='any' value={v} disabled={disabled} onChange={(e) => setV(e.target.value)}
      onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} className='ml-auto h-7 w-24 text-right tabular-nums' />
  );
}

interface Provider { slug: string; mode: 'gateway' | 'direct'; backend: string; enabled: boolean; keys: number; enabled_keys: number; last_used_at: string | null }
interface Credential { id: number; provider: string; label: string; hint: string; priority: number; enabled: boolean; uses: number; last_used_at: string | null; created_at: string; rotated_at: string | null }

/** What each vault provider is for: the one Key vault table groups and filters by it. */
const TYPE: Record<string, string> = {
  anthropic: 'Inference', openai: 'Inference', google: 'Inference', cloudflare: 'Inference', dashscope: 'Inference',
  boat: 'Sandbox', exa: 'Search', libraries_io: 'Search',
  amp: 'Coding agent', cursor: 'Coding agent', factory: 'Coding agent', github_copilot: 'Coding agent'
};
const typeOf = (slug: string) => TYPE[slug] ?? 'Other';
const TYPE_ORDER = ['Inference', 'Sandbox', 'Search', 'Coding agent', 'Other'];

/**
 * The key vault as one table: a row per provider (inference, sandbox, search, coding-agent subscriptions) with its
 * type, keys by hint, and an on/off switch. Keys are added, disabled and deleted from the row's ⋯ menu. A key is posted
 * once and never shown again, only its hint.
 */
function ModelKeys() {
  const { data, error } = useAdmin<{ unlocked: boolean; providers: Provider[]; credentials: Credential[] }>('/compute/keys');
  const [adding, setAdding] = useState<string | null>(null);
  const [f, setF] = useState({ label: '', secret: '' });
  const [err, setErr] = useState('');
  const [del, setDel] = useState<Credential | null>(null);
  const [type, setType] = useState('');
  const add = useAdminAction(() => post<{ hint: string }>('/compute/keys', { provider: adding, label: f.label.trim() || undefined, secret: f.secret }),
    { success: (r) => `Key saved (${r.hint})` });
  const keyOn = useAdminAction((v: { id: number; enabled: boolean }) => post(`/compute/keys/${v.id}/enabled`, { enabled: v.enabled }), { success: 'Key updated' });
  const remove = useAdminAction((id: number) => adminApi('DELETE', `/compute/keys/${id}`), { success: 'Key deleted' });
  const provOn = useAdminAction((v: { slug: string; enabled: boolean }) => post(`/compute/providers/${encodeURIComponent(v.slug)}/enabled`, { enabled: v.enabled }), { success: 'Provider updated' });
  const creds = data?.credentials ?? [];
  const rows = (data?.providers ?? [])
    .filter((p) => !type || typeOf(p.slug) === type)
    .sort((a, b) => TYPE_ORDER.indexOf(typeOf(a.slug)) - TYPE_ORDER.indexOf(typeOf(b.slug)) || a.slug.localeCompare(b.slug));
  const close = () => { setAdding(null); setF({ label: '', secret: '' }); setErr(''); };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    // The key leaves the form whatever happens: a failed save asks for it again rather than keeping it on screen.
    add.mutate(undefined, { onSuccess: close, onError: (x) => { setErr(x.message); setF({ ...f, secret: '' }); } });
  };
  return (
    <Section title='Key vault' description='Every key Octillion uses, encrypted at rest: inference providers, the sandbox provider, search and coding-agent subscriptions. Agents and orchestrators get scoped gateway tokens, never these keys.'
      action={<NativeSelect aria-label='Type' value={type} onChange={(e) => setType(e.target.value)}>
        <NativeSelectOption value=''>All types</NativeSelectOption>
        {TYPE_ORDER.map((t) => <NativeSelectOption key={t} value={t}>{t}</NativeSelectOption>)}
      </NativeSelect>}>
      <ErrorBox error={error} />
      {data && !data.unlocked && <Notice>The key vault is locked: set <Mono>OCTILLION_VAULT_KEY</Mono> on the server to add keys.</Notice>}
      <List title='Providers' rows={rows} empty='No providers.'
        rowClassName={(p) => (p.enabled ? undefined : 'text-muted-foreground')}
        actions={(p) => [
          { label: 'Add a key…', icon: <Icons.add />, disabled: data?.unlocked === false, onSelect: () => setAdding(p.slug) },
          ...creds.filter((c) => c.provider === p.slug).flatMap((c, i) => [
            { label: `${c.enabled ? 'Disable' : 'Enable'} ${c.label} (${c.hint})`, icon: c.enabled ? <Icons.eyeOff /> : <Icons.check />, separator: i === 0, onSelect: () => keyOn.mutate({ id: c.id, enabled: !c.enabled }) },
            { label: `Delete ${c.label}…`, icon: <Icons.trash />, destructive: true, onSelect: () => setDel(c) }
          ])
        ]}
        cols={[
          ['Provider', (p) => <Mono>{p.slug}</Mono>],
          ['Type', (p) => typeOf(p.slug)],
          ['How it is used', (p) => <span className='text-muted-foreground'>{p.mode === 'gateway' ? 'through the gateway' : 'handed to the orchestrator'}{p.backend !== 'direct' && ` · ${p.backend}`}</span>],
          ['Keys', (p) => {
            const mine = creds.filter((c) => c.provider === p.slug);
            return mine.length ? <span className='flex flex-wrap gap-x-3 gap-y-1'>{mine.map((c) => <span key={c.id} className={c.enabled ? undefined : 'text-muted-foreground line-through'}><Mono>{c.hint}</Mono> <span className='text-muted-foreground'>{c.label} · {c.uses} uses</span></span>)}</span>
              : <span className='text-amber-700 dark:text-amber-400'>no key</span>;
          }],
          ['Last used', (p) => (p.last_used_at ? <When d={p.last_used_at} /> : <span className='text-muted-foreground'>never</span>)],
          ['On', (p) => <Switch aria-label={`${p.slug} on`} checked={p.enabled} disabled={provOn.isPending} onCheckedChange={(c) => provOn.mutate({ slug: p.slug, enabled: c })} />, 'w-12 text-right']
        ]} />
      <Dialog open={!!adding} onOpenChange={(o) => !o && close()}>
        <DialogContent className='sm:max-w-md'>
          <form onSubmit={submit} className='grid gap-4' autoComplete='off'>
            <DialogHeader>
              <DialogTitle>Add a {adding} key</DialogTitle>
              <DialogDescription>{adding && typeOf(adding)}. Shown only as a hint once saved.</DialogDescription>
            </DialogHeader>
            <FormRow id='mk-label' label='Label (optional)' hint={adding === 'anthropic' ? 'Use the label vertex for a Google service-account JSON (Claude on Vertex AI).' : 'A new label adds to the pool; the same label replaces that key.'}>
              <Input id='mk-label' maxLength={60} placeholder='default' value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
            </FormRow>
            <FormRow id='mk-secret' label='Key'>
              {f.label.trim() === 'vertex'
                ? <Textarea id='mk-secret' rows={6} spellCheck={false} required className='font-mono text-xs' placeholder='{ "type": "service_account", … }' value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} />
                : <Input id='mk-secret' type='password' autoComplete='new-password' spellCheck={false} required value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} />}
            </FormRow>
            {err && <p className='text-destructive text-sm'>{err}</p>}
            <DialogFooter>
              <Button type='button' variant='outline' onClick={close}>Cancel</Button>
              <Button type='submit' disabled={add.isPending || !f.secret.trim()}>Save key</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
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
    </Section>
  );
}

// ---------- compute: the on-call console (GET /compute/summary, src/compute.ts) ----------

type Level = 'red' | 'amber' | 'green';
interface Verdict { level: Level; code: string; text: string; href: string | null }
interface Knob { name: string; value: string; source: 'env' | 'default'; meaning: string }
interface Summary {
  at: string; runtime: 'vm' | 'vercel'; verdict: Verdict[];
  tick: { at: string | null; age_s: number | null; holder: string | null; enabled: boolean; kick_configured: boolean; note: string | null; error: string | null; tick_seconds: number; free: number | null };
  queue: { sessions: number; research: number; oldest_session_at: string | null; oldest_research_at: string | null; unclaimable: number; jobs_waiting: number };
  running: { sessions: number; research: number; orchestrators: { booting: number; running: number; draining: number }; pods_used: number; pods_reserved: number };
  wait_1h: { p50_s: number | null; p95_s: number | null; n: number };
  failures_24h: { sessions: number; launches: number; ended: number; rate: number; top: { key: string; label: string; count: number } | null };
  spend_today: { session_model_usd: number; orchestrator_model_usd: number; sandbox_est_usd: number; total_usd: number };
  limits: {
    ok: boolean; error: string | null; stale: boolean; plan: number | null; active_now: number | null; ours_orch: number; ours_workers: number; others: number; other_prefixes: string[];
    our_starts: { minute: number; hour: number; day: number }; starts: { per_minute: number; per_hour: number; per_day: number } | null;
    job_orch_live: number; job_orch_cap: number; shared_orch_live: number; shared_orch_cap: number; per_job_mode: boolean;
    pods_max_reserved: number; pods_avg_running: number; pods_cap: number; available: number | null; per_orchestrator: number;
    sessions_per_day_ceiling: number | null; reason: string | null; binding: 'plan' | 'job_orch' | 'pods' | null; note: string | null; sandbox_prices: Record<string, number>;
  };
  settings: Setting[]; knobs: Knob[];
  provider: { name: string; api: string; namespace: string; ok: boolean; error: string | null; has_key: boolean; key_hint: string | null; key_label: string | null; uses: number; last_used_at: string | null };
  links: { newrelic: string | null };
}

const SUMMARY = '/compute/summary';
const LEVEL: Record<Level, { border: string; text: string }> = {
  red: { border: 'border-l-destructive', text: 'text-destructive' },
  amber: { border: 'border-l-amber-500', text: 'text-amber-700 dark:text-amber-400' },
  green: { border: 'border-l-emerald-500', text: 'text-emerald-700 dark:text-emerald-400' }
};

/**
 * Compute: is compute healthy, is work flowing, what is stuck, and why. A verdict worked out on the server, how fresh
 * the autoscaler's last tick is, the headline numbers, which limit binds (the capacity settings are edited on the row
 * of the limit they change) and the environment it runs with. Read only apart from those settings, "Run a tick now" and
 * cancelling a session (both behind a confirm, both in the admin log). Refreshes every
 * 15 s while the tab is visible; paused while a setting has an unsaved edit.
 */
export function AdminCompute() {
  const qc = useQueryClient();
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [resumed, setResumed] = useState(false);
  const editing = Object.values(dirty).some(Boolean);
  const paused = editing && !resumed;
  const { data, error, isLoading, refetch } = useAdmin<Summary>(SUMMARY, { refetchInterval: paused ? undefined : 15_000 });
  const [refreshing, setRefreshing] = useState(false);
  // Refresh asks boat again (past its 30 s listing cache): the same call as "Test connection".
  const refresh = async () => {
    setRefreshing(true);
    try {
      qc.setQueryData(['admin', SUMMARY], await adminApi<Summary>('GET', `${SUMMARY}?fresh=1`));
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'admin' && /^\/compute\/(jobs|sessions|orchestrators|failures|ticks|activity)/.test(String(q.queryKey[1])) });
    }
    catch (e) { toast.error((e as Error).message); }
    finally { setRefreshing(false); }
  };
  // "Resume" lasts until the edits are saved or dropped; the next edit pauses again.
  const setEdit = (key: string, on: boolean) => {
    const next = { ...dirty, [key]: on };
    if (dirty[key] !== on) setDirty(next);
    if (!Object.values(next).some(Boolean)) setResumed(false);
  };
  // The record tables load and fail on their own, so they show even when the summary did not load. They read their
  // filters and open record from the URL (useSearchParams needs a Suspense boundary).
  const tables = (
    <Suspense fallback={<Skeleton className='h-72 rounded-lg' />}>
      <ComputeActivity />
      <ComputeJobs />
      <ComputeSessions />
      <ComputeOrchestrators verdict={data?.verdict ?? []} />
      <ComputeFailures />
      <ComputeDecisions runtime={data?.runtime ?? null} />
    </Suspense>
  );
  return (
    <PageContainer pageTitle='Compute' pageDescription='Orchestrators and agent sandboxes on boat.dev: what is running, what is waiting, and why.'
      pageHeaderAction={
        <div className='flex flex-wrap items-center gap-2'>
          {data && <Freshness s={data} />}
          {paused && <Button variant='outline' size='xs' onClick={() => setResumed(true)} title='Refresh is paused while a setting has an unsaved edit'><Icons.clock /> Paused · Resume</Button>}
          <Button variant='outline' size='sm' disabled={refreshing} onClick={() => void refresh()}>{refreshing ? <Icons.spinner className='animate-spin' /> : <Icons.chartLine />} Refresh</Button>
          {data && <RunTick s={data} />}
          {data?.links.newrelic && <ActionsMenu label='More' items={[{ label: 'Open in New Relic', icon: <Icons.externalLink />, onSelect: () => window.open(data.links.newrelic!, '_blank', 'noopener') }]} />}
        </div>
      }>
      {error && !data && (
        <div role='alert' className='border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-3 rounded-lg border px-4 py-3 text-sm'>
          <span className='min-w-0 flex-1'>Could not load compute status: {error.message}</span>
          <Button variant='outline' size='xs' onClick={() => void refetch()}>Retry</Button>
        </div>
      )}
      {error && !data && <div className='flex w-full flex-col gap-10 pb-10'>{tables}</div>}
      {isLoading && <div className='grid gap-6'><Skeleton className='h-11 rounded-lg' /><LoadingCards count={6} /><Skeleton className='h-72 rounded-lg' /></div>}
      {data && (
        <div className='flex w-full flex-col gap-10 pb-10'>
          <div className='flex flex-col gap-6'>
            <VerdictBanner verdict={data.verdict} />
            <Tiles s={data} />
          </div>
          <Limits s={data} onEditing={setEdit} />
          {tables}
          <Environment s={data} onTest={() => void refresh()} testing={refreshing} />
        </div>
      )}
    </PageContainer>
  );
}

interface TickResult { leader: boolean; launched: number; reaped: number; note: string | null; error: string | null; message: string }

/** "Run a tick now" (POST /compute/tick, audited): one autoscaler tick at once, behind a confirm. Hidden when
 * autoscaling is off; disabled on a Vercel deployment that cannot trigger the autoscaler. */
function RunTick({ s }: { s: Summary }) {
  const [asking, setAsking] = useState(false);
  const tick = useAdminAction(() => post<TickResult>('/compute/tick'));
  if (!s.tick.enabled) return null;
  const blocked = s.runtime === 'vercel' && !s.tick.kick_configured;
  const run = () => tick.mutate(undefined, { onSuccess: (r) => (r.error ? toast.error(r.message) : r.leader ? toast.success(r.message) : toast.info(r.message)) });
  return (
    <>
      <Button variant='outline' size='sm' disabled={tick.isPending || blocked} onClick={() => setAsking(true)}
        title={blocked ? 'This deployment cannot trigger the autoscaler: PUBLIC_URL is not HTTPS or the worker token is unset' : 'Run one autoscaler tick now instead of waiting for the next one'}>
        {tick.isPending ? <Icons.spinner className='animate-spin' /> : <Icons.clock />} Run a tick now
      </Button>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run an autoscaler tick now?</AlertDialogTitle>
            <AlertDialogDescription>
              It does what the next scheduled tick would: it may start orchestrators for queued work and stop idle or broken ones. Your name goes in the admin log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setAsking(false); run(); }}>Run a tick</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** "Last autoscaler tick 12 s ago · runtime VM · data as of 14:03:21": amber past 3 ticks, red past 10 minutes. */
function Freshness({ s }: { s: Summary }) {
  useNow();
  const age = ageOf(s.tick.at);
  const tone = age == null || age > 600 ? 'red' : age > 3 * s.tick.tick_seconds ? 'amber' : null;
  const runtime = s.runtime === 'vercel' ? 'Vercel' : 'VM';
  const text = age == null ? 'The autoscaler has not ticked yet'
    : tone === 'red' && s.runtime === 'vercel' ? `No autoscaler tick for ${Math.round(age / 60)} min. On Vercel, ticks only happen when something happens; queued work may wait for the next 5-minute cron.`
    : `Last autoscaler tick ${dur(age)} ago`;
  return (
    <span id='tick' className={cn('text-muted-foreground max-w-xl text-xs', tone && LEVEL[tone].text)} title={s.tick.at ? `Last tick ${new Date(s.tick.at).toLocaleString()}${s.tick.holder ? ` by ${s.tick.holder}` : ''}` : undefined}>
      {text} · runtime {runtime} · data as of {new Date(s.at).toLocaleTimeString()}
    </span>
  );
}

/** The worst true rule on one line; "+N more" lists the rest. Each links to the records behind it. */
function VerdictBanner({ verdict }: { verdict: Verdict[] }) {
  const [open, setOpen] = useState(false);
  const [first, ...rest] = verdict;
  if (!first) return null;
  const line = (v: Verdict) => (
    <span className='min-w-0'>
      {v.href ? <Link href={v.href} className='hover:underline'>{v.text}</Link> : v.text}
    </span>
  );
  return (
    <div role='status' className={cn('rounded-r-lg border border-l-4 px-4 py-3 text-sm', LEVEL[first.level].border)}>
      <div className='flex flex-wrap items-baseline gap-x-3 gap-y-1'>
        <span className={cn('font-medium', LEVEL[first.level].text)}>{line(first)}</span>
        {rest.length > 0 && (
          <Button variant='ghost' size='xs' className='text-muted-foreground -my-1 ml-auto' onClick={() => setOpen(!open)}>
            {open ? 'Show less' : `+${rest.length} more`}
          </Button>
        )}
      </div>
      {open && (
        <ul className='mt-2 grid gap-1.5 border-t pt-2'>
          {rest.map((v) => (
            <li key={v.code} className='flex gap-2'>
              <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', v.level === 'red' ? 'bg-destructive' : v.level === 'amber' ? 'bg-amber-500' : 'bg-emerald-500')} aria-label={v.level} />
              {line(v)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface Tile { label: string; value: ReactNode; hint: ReactNode; href: string; warn?: boolean; title?: string }

/** Six headline numbers: one row on wide screens, three per row on medium, two on phones. Each opens its records. */
function Tiles({ s }: { s: Summary }) {
  useNow();
  const o = s.running.orchestrators, live = o.booting + o.running + o.draining;
  const oldest = Math.max(ageOf(s.queue.oldest_session_at) ?? 0, ageOf(s.queue.oldest_research_at) ?? 0);
  const queued = s.queue.sessions + s.queue.research;
  const f = s.failures_24h, sp = s.spend_today;
  const tiles: Tile[] = [
    { label: 'Queued', value: queued, hint: queued ? `oldest ${dur(oldest)} · ${s.queue.jobs_waiting} job${s.queue.jobs_waiting === 1 ? '' : 's'}` : 'nothing waiting',
      href: '/admin/compute?section=sessions&status=queued', warn: s.verdict.some((v) => v.code === 'queue_old') },
    { label: 'Running', value: s.running.sessions + s.running.research, hint: `on ${live} orchestrator${live === 1 ? '' : 's'} · ${s.running.pods_used} of ${s.running.pods_reserved} pods`,
      href: '/admin/compute?section=sessions&status=running', title: s.running.research ? `${s.running.sessions} sessions and ${s.running.research} research jobs` : undefined },
    { label: 'Queue wait p50 / p95 (1 h)', value: s.wait_1h.n ? `${dur(s.wait_1h.p50_s)} / ${dur(s.wait_1h.p95_s)}` : '—', hint: `queued → started, n=${s.wait_1h.n}`,
      href: '/admin/compute?section=sessions&sort=wait' },
    { label: 'Orchestrators', value: live, hint: `${o.running} running · ${o.booting} booting · ${o.draining} draining`, href: '/admin/compute?section=orchestrators' },
    { label: 'Failures (24 h)', value: f.sessions + f.launches, hint: `${f.sessions} session${f.sessions === 1 ? '' : 's'} · ${f.launches} launch${f.launches === 1 ? '' : 'es'}${f.top ? ` · top: ${f.top.label}` : ''}`,
      href: '/admin/compute?section=failures', warn: f.rate > 0.1, title: f.ended ? `${Math.round(f.rate * 100)}% of the ${f.ended} sessions that ended in 24 h failed` : undefined },
    { label: 'Spend today (UTC)', value: money(sp.total_usd), title: `Sandbox: ${EST}`,
      hint: `${money(sp.session_model_usd)} model (finished sessions) · ${money(sp.orchestrator_model_usd)} orchestrators · ${money(sp.sandbox_est_usd)} sandbox est.`,
      href: '/admin/compute?section=jobs&jsort=spend' }
  ];
  return (
    <dl className='grid grid-cols-2 border-y md:grid-cols-3 xl:grid-cols-6'>
      {tiles.map((t) => (
        <Link key={t.label} href={t.href} title={t.title}
          className='hover:bg-muted/40 min-w-0 border-b px-4 py-3 transition-colors max-md:odd:pl-0 max-md:even:border-l md:border-l md:[&:nth-child(3n+1)]:border-l-0 md:[&:nth-child(3n+1)]:pl-0 xl:border-b-0 xl:[&:nth-child(3n+1)]:border-l xl:[&:nth-child(3n+1)]:pl-4 xl:first:border-l-0 xl:first:pl-0'>
          <dt className='text-muted-foreground text-xs font-medium'>{t.label}</dt>
          <dd className={cn('mt-1 text-2xl font-semibold tabular-nums tracking-tight', t.warn && 'text-amber-700 dark:text-amber-400')}>{t.value}</dd>
          <dd className='text-muted-foreground mt-0.5 truncate text-xs' title={typeof t.hint === 'string' ? t.hint : undefined}>{t.hint}</dd>
        </Link>
      ))}
    </dl>
  );
}

type Status = 'ok' | 'near' | 'binding';
interface LimitRow {
  key: string; label: string; help?: string;
  used: number | null; limit: number | null; sub?: ReactNode;
  /** Stacked meter parts (boat sandboxes): label, count, colour class. */
  parts?: { label: string; n: number; className: string }[];
  status: Status | null; source: ReactNode; setting?: Setting; fixed?: string; unavailable?: string | null; noBinding?: boolean;
}

const statusOf = (used: number | null, limit: number | null, binding: boolean, canBind = true): Status | null =>
  used == null || !limit ? (binding ? 'binding' : null) : binding && canBind ? 'binding' : used / limit >= 0.85 ? 'near' : 'ok';
const STATUS: Record<Status, ReactNode> = {
  ok: <span className='text-muted-foreground'>OK</span>,
  near: <span className='text-amber-700 dark:text-amber-400'>Near</span>,
  binding: <span className='text-destructive font-medium'>Binding</span>
};

/** Used against limit as a bar: one fill, or stacked parts (ours, others, free) when given. */
function Meter({ used, limit, parts, status }: { used: number; limit: number; parts?: LimitRow['parts']; status: Status | null }) {
  const w = (x: number) => `${Math.min(100, Math.max(0, (x / limit) * 100))}%`;
  const fill = status === 'binding' ? 'bg-destructive' : status === 'near' ? 'bg-amber-500' : 'bg-primary';
  return (
    <div className='bg-muted flex h-1.5 w-full overflow-hidden rounded-full' role='meter' aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used}>
      {parts ? parts.map((p) => <div key={p.label} className={p.className} style={{ width: w(p.n) }} title={`${p.label}: ${p.n}`} />)
        : <div className={fill} style={{ width: w(used) }} />}
    </div>
  );
}

/** Where a setting's value comes from: set here (by whom, when), the environment, or the default. */
function SourceOf({ s }: { s: Setting }) {
  if (s.source === 'set') return <span>set{s.updated_by && ` by ${s.updated_by}`}{s.updated_at && <span className='text-muted-foreground'>, <When d={s.updated_at} /></span>}</span>;
  return <span className='text-muted-foreground'>{s.source === 'env' ? 'env' : 'default'}</span>;
}

/**
 * Which ceiling binds, one row per limit, with the capacity settings edited on the row they change (saved through
 * PUT /compute/settings, so the audit log is the same). boat's figures show "—" when boat did not answer.
 */
function Limits({ s, onEditing }: { s: Summary; onEditing: (key: string, on: boolean) => void }) {
  const save = useAdminAction((v: Record<string, string | null>) => adminApi('PUT', '/compute/settings', { values: v }), { success: 'Setting saved' });
  const l = s.limits;
  const set = (k: string) => s.settings.find((x) => x.key === k);
  const boatDown = l.plan == null ? `boat.dev did not answer: ${l.error ?? 'no answer'}` : null;
  const startsNote = 'boat does not report used starts; other deployments\' starts are not counted.';
  const free = l.plan == null || l.active_now == null ? 0 : Math.max(0, l.plan - l.ours_orch - l.ours_workers - l.others);
  const size = set('BOAT_SANDBOX_SIZE');
  const rows: LimitRow[] = [
    { key: 'plan', label: 'boat sandboxes at once', used: l.active_now, limit: l.plan, unavailable: boatDown,
      sub: l.plan != null && <>ours {l.ours_orch} orchestrators · {l.ours_workers} workers · other deployments {l.others} · free {free}</>,
      parts: [
        { label: 'Our orchestrators', n: l.ours_orch, className: 'bg-primary' },
        { label: 'Our workers', n: l.ours_workers, className: 'bg-primary/55' },
        { label: 'Other deployments', n: l.others, className: 'bg-amber-500/70' }
      ],
      status: statusOf(l.active_now, l.plan, l.binding === 'plan'), source: <span className='text-muted-foreground'>boat plan</span>, fixed: 'Set by your boat plan' },
    ...(['minute', 'hour', 'day'] as const).map((w): LimitRow => {
      const limit = l.starts ? l.starts[w === 'minute' ? 'per_minute' : w === 'hour' ? 'per_hour' : 'per_day'] : null;
      return { key: `starts-${w}`, label: `Our starts: per ${w}`, help: startsNote, used: l.our_starts[w], limit, unavailable: limit == null ? boatDown : null,
        status: statusOf(l.our_starts[w], limit, false, false), source: <span className='text-muted-foreground'>boat plan · database</span>, fixed: 'Set by your boat plan', noBinding: true };
    }),
    ...(l.per_job_mode ? [
      { key: 'job_orch', label: 'Job orchestrators', used: l.job_orch_live, limit: l.job_orch_cap, setting: set('OCTILLION_MAX_JOB_ORCHESTRATORS'),
        status: statusOf(l.job_orch_live, l.job_orch_cap, l.binding === 'job_orch'), source: null },
      { key: 'pods', label: 'Worker pods per job orchestrator', used: l.pods_max_reserved, limit: l.pods_cap, setting: set('OCTILLION_JOB_POD_CAPACITY'),
        sub: <>most reserved by one · avg running {l.pods_avg_running}</>, status: statusOf(l.pods_max_reserved, l.pods_cap, l.binding === 'pods'), source: null }
    ] : [
      { key: 'shared', label: 'Shared orchestrators', used: l.shared_orch_live, limit: l.shared_orch_cap, setting: set('OCTILLION_MAX_ORCHESTRATORS'),
        status: statusOf(l.shared_orch_live, l.shared_orch_cap, false), source: null }
    ]),
    { key: 'size', label: 'Worker sandbox size', used: null, limit: null, setting: size, status: null, source: null,
      sub: size && <>{money(l.sandbox_prices[String(size.value)] ?? 0)}/h per sandbox (est.)</> }
  ];
  return (
    <Section title={<span id='limits'>Limits</span>} description='Which ceiling holds work back. Capacity settings are changed on the row of the limit they set; every server picks a change up within 30 s.'>
      <div className='overflow-x-auto border-y'>
        <Table className='min-w-[760px]'>
          <TableHeader>
            <TableRow className='hover:bg-transparent'>
              {['Limit', 'Used / Limit', 'Status', 'Source', 'Change'].map((h) => <TableHead key={h} className='text-muted-foreground h-8 px-3 text-xs font-normal'>{h}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key} className='hover:bg-transparent'>
                <TableCell className='px-3 py-2.5 align-top'>
                  <span className='flex flex-col gap-1'>
                    <span className='leading-none font-medium' title={r.help ?? r.setting?.help}>{r.label}</span>
                    {r.sub && <span className='text-muted-foreground text-xs'>{r.sub}</span>}
                  </span>
                </TableCell>
                <TableCell className='w-64 px-3 py-2.5 align-top'>
                  {r.unavailable ? <span className='text-muted-foreground' title={r.unavailable}>—</span>
                    : r.limit != null && r.used != null ? (
                      <span className='flex flex-col gap-1.5'>
                        <span className='text-sm tabular-nums'>{r.used} <span className='text-muted-foreground'>of {r.limit}</span></span>
                        <Meter used={r.used} limit={r.limit} parts={r.parts} status={r.status} />
                      </span>
                    ) : r.setting ? <Mono>{String(r.setting.value)}</Mono> : <span className='text-muted-foreground'>—</span>}
                </TableCell>
                <TableCell className='px-3 py-2.5 align-top text-sm' title={r.noBinding ? 'Never marked binding on its own: other deployments share the account\'s starts.' : undefined}>
                  {r.unavailable || !r.status ? <span className='text-muted-foreground'>—</span> : STATUS[r.status]}
                </TableCell>
                <TableCell className='px-3 py-2.5 align-top text-sm'>{r.setting ? <SourceOf s={r.setting} /> : r.source}</TableCell>
                <TableCell className='w-64 px-3 py-1.5 align-top'>
                  {r.setting ? (
                    <span className='flex items-center gap-1'>
                      <LimitInput key={String(r.setting.value)} s={r.setting} disabled={save.isPending} onDirty={(on) => onEditing(r.setting!.key, on)}
                        onSave={(v) => save.mutate({ [r.setting!.key]: v }, { onSettled: () => onEditing(r.setting!.key, false) })} />
                      {r.setting.source === 'set' && (
                        <Button variant='ghost' size='xs' className='text-muted-foreground hover:text-foreground' disabled={save.isPending}
                          title={`Back to ${r.setting.env != null ? `the environment (${r.setting.env})` : `the default (${r.setting.default})`}`}
                          onClick={() => save.mutate({ [r.setting!.key]: null })}>Reset</Button>
                      )}
                    </span>
                  ) : <span className='text-muted-foreground text-xs'>{r.fixed ?? '—'}</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className='text-muted-foreground grid gap-1 text-sm'>
        {l.per_job_mode && <p className='text-xs'>Shared orchestrators: not used in per-job mode (limit {l.shared_orch_cap}).</p>}
        <p>
          {l.available != null ? <>Room for {l.available} more orchestrator{l.available === 1 ? '' : 's'} of {l.per_orchestrator} sandboxes</> : <>Room unknown (boat did not answer)</>}
          {l.sessions_per_day_ceiling != null && <>; about {l.sessions_per_day_ceiling} sessions a day</>}.
          {l.note && <> Autoscaler says: &ldquo;{l.note}&rdquo;</>}
        </p>
        {l.others > 0 && <p>Other deployments on this boat account{l.other_prefixes.length ? ` (${l.other_prefixes.join(', ')})` : ''} use {l.others} sandboxes. They share the plan.</p>}
        {l.stale && <p className='text-amber-700 dark:text-amber-400'>boat.dev did not answer just now ({l.error}); showing its last answer.</p>}
      </div>
    </Section>
  );
}

/** A capacity setting in its Limits row: saves on Enter, on leaving the field, or on choosing an option. */
function LimitInput({ s, onSave, onDirty, disabled }: { s: Setting; onSave: (v: string) => void; onDirty: (on: boolean) => void; disabled?: boolean }) {
  const [v, setV] = useState(String(s.value));
  const change = (x: string) => { setV(x); onDirty(x !== String(s.value)); };
  const commit = (x: string) => { if (x.trim() !== '' && x !== String(s.value)) onSave(x); else { setV(String(s.value)); onDirty(false); } };
  return s.kind === 'choice' ? (
    <NativeSelect aria-label={s.label} value={v} disabled={disabled} onChange={(e) => { change(e.target.value); commit(e.target.value); }} className='w-36'>
      {s.options!.map((o) => <NativeSelectOption key={o} value={o}>{o}</NativeSelectOption>)}
    </NativeSelect>
  ) : (
    <Input aria-label={s.label} value={v} disabled={disabled} onChange={(e) => change(e.target.value)} onBlur={() => commit(v)}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setV(String(s.value)); onDirty(false); } }}
      className='h-8 w-24 tabular-nums' type='number' min={s.min} max={s.max} step={s.kind === 'number' ? 'any' : 1} />
  );
}

/** Settings that shape compute but are changed elsewhere: shown read only, with a link to their page. */
const RELATED: { key: string; page: string; href: string }[] = [
  { key: 'ORCHESTRATOR_MODEL', page: 'Agent configuration', href: '/admin/configuration' },
  { key: 'OCTILLION_MAX_SESSIONS_PER_RUN', page: 'Agent configuration', href: '/admin/configuration' },
  { key: 'RESEARCH_MAX_COST_USD', page: 'Agent configuration', href: '/admin/configuration' }
];

/** The environment the autoscaler runs with (read only) and the boat account. */
function Environment({ s, onTest, testing }: { s: Summary; onTest: () => void; testing: boolean }) {
  const p = s.provider;
  const related = RELATED.map((r) => ({ ...r, s: s.settings.find((x) => x.key === r.key) })).filter((r) => r.s);
  return (
    <Section title={<span id='environment'>Environment and boat account</span>} description='Change these in the deployment environment.' className='text-muted-foreground [&_h2]:text-foreground'>
      <div className='grid gap-8 xl:grid-cols-[3fr_2fr]'>
        <div className='grid gap-6'>
          <div className='overflow-x-auto border-y'>
            <Table className='min-w-[640px]'>
              <TableHeader>
                <TableRow className='hover:bg-transparent'>
                  {['Name', 'Value', 'Source', 'Meaning'].map((h) => <TableHead key={h} className='text-muted-foreground h-8 px-3 text-xs font-normal'>{h}</TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.knobs.map((k) => (
                  <TableRow key={k.name} className='hover:bg-transparent'>
                    <TableCell className='px-3 py-2'><Mono>{k.name}</Mono></TableCell>
                    <TableCell className='px-3 py-2'><Mono>{k.value}</Mono></TableCell>
                    <TableCell className='px-3 py-2 text-xs'>{k.source}</TableCell>
                    <TableCell className='px-3 py-2 text-xs whitespace-normal'>{k.meaning}</TableCell>
                  </TableRow>
                ))}
                {related.map((r) => (
                  <TableRow key={r.key} className='hover:bg-transparent'>
                    <TableCell className='px-3 py-2'><Mono>{r.key}</Mono></TableCell>
                    <TableCell className='px-3 py-2'><Mono>{String(r.s!.value)}</Mono></TableCell>
                    <TableCell className='px-3 py-2 text-xs'><SourceOf s={r.s!} /></TableCell>
                    <TableCell className='px-3 py-2 text-xs whitespace-normal'>{r.s!.label}. <Link href={r.href} className='text-foreground hover:underline'>Change it in {r.page}</Link></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
        <div className='grid content-start gap-3'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <p className='text-foreground text-sm font-medium'>
              <span className={cn('mr-2 inline-block size-2 rounded-full', p.ok ? 'bg-emerald-500' : 'bg-destructive')} aria-hidden />
              {p.name} · {p.ok ? 'connected' : 'not connected'}
            </p>
            <Button variant='outline' size='sm' disabled={testing} onClick={onTest}>{testing ? <Icons.spinner className='animate-spin' /> : <Icons.plug />} Test connection</Button>
          </div>
          {!p.ok && p.error && <Notice>boat.dev did not answer: {p.error}</Notice>}
          <dl>
            <Field label='Key'>{p.has_key ? <><Mono>{p.key_hint}</Mono> <span className='text-muted-foreground'>· {p.key_label} · {p.uses} uses · used <When d={p.last_used_at} /></span></>
              : <span className='text-amber-700 dark:text-amber-400'>No boat key</span>} · <Link href='/admin/keys' className='hover:underline'>Key vault</Link></Field>
            <Field label='API'><Mono>{p.api}</Mono></Field>
            <Field label='Namespace'><Mono>{p.namespace}</Mono> <span className='text-muted-foreground'>· this deployment only touches sandboxes named {p.namespace}-…</span></Field>
          </dl>
        </div>
      </div>
    </Section>
  );
}
