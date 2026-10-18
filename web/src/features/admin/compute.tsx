'use client';
// Operations pages over src/settings.ts and the default population: Agent configuration (models, run sizes, research
// limits), Harness mix (the coding-agent mix and admin-added harnesses) and Compute (/admin/compute: the on-call
// console over GET /compute/summary, src/compute.ts, with the capacity settings in its Limits table, its Orchestrators
// table in compute-orchestrators.tsx (Jobs and Sessions are tabs on Health), its Activity chart and Autoscaler
// decisions in compute-decisions.tsx). Each setting
// shows the value in force and where it comes from: set here, the server's environment, or the built-in default.
// Saving writes platform_settings (every server picks it up within 30s) and an audit log line. Model keys are the key
// vault's credentials: a key is typed once and never shown again, only its hint.
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
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
import { counted } from '@/lib/octillion-format';
import { cn } from '@/lib/utils';
import { post, useAdmin, useAdminAction } from './lib';
import { ErrorBox, FormRow, LoadingCards, Mono, Notice, Section, When } from './ui';
import { ActionsMenu, Field, RecordView, type RecordCol } from '@/components/layout/record-view';
import { ageOf, dur, EST, money, SectionLink, UrlTabs, useComputeParams, useNow } from './compute-common';
import { StatStrip } from '@/components/layout/section';
import { ComputeOrchestrators } from './compute-orchestrators';
import { ComputeFailures, type Failures } from './compute-failures';
import { ComputeDecisions, type Tick } from './compute-decisions';

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
  const changed = rows.filter((x) => x.source === 'set');
  const [askReset, setAskReset] = useState(false);
  // Back to the environment's value where one is set, else the default (saving null clears the admin's value).
  const backTo = (x: Setting) => (x.env != null ? `the environment (${x.env})` : `the default (${x.default})`);
  const cols: RecordCol<Setting>[] = [
    { key: 'setting', label: 'Setting', keep: true, type: 'text', value: (x) => x.label,
      render: (x) => <span className='flex min-w-0 flex-col gap-1'><span className='leading-none font-medium'>{x.label}</span><span className='text-muted-foreground truncate text-xs' title={x.help}>{x.help}</span></span> },
    { key: 'group', label: 'Group', type: 'select', value: (x) => groupName(x.group), render: (x) => groupName(x.group) },
    { key: 'value', label: 'Value', className: 'w-80', keep: true, render: (x) => (
      <span className='flex items-center gap-1' onClick={(e) => e.stopPropagation()}>
        <InlineValue key={String(x.value)} s={x} disabled={save.isPending} onSave={(v) => save.mutate({ [x.key]: v })} />
        {x.source === 'set' && <Button variant='ghost' size='xs' className='text-muted-foreground hover:text-foreground' disabled={save.isPending}
          title={`Back to ${backTo(x)}`} onClick={() => save.mutate({ [x.key]: null })}>Reset</Button>}
      </span>
    ) },
    { key: 'source', label: 'From', type: 'select', value: (x) => (x.source === 'set' ? 'Set here' : x.source === 'env' ? 'Environment' : 'Default'),
      render: (x) => (x.source === 'set' ? <span>Set here{x.updated_at && <span className='text-muted-foreground'> · <When d={x.updated_at} /></span>}</span> : <span className='text-muted-foreground'>{x.source === 'env' ? 'Environment' : 'Default'}</span>) },
    { key: 'key', label: 'Variable', type: 'text', value: (x) => x.key, render: (x) => <Mono>{x.key}</Mono> }
  ];
  return (
    <PageContainer>
      <ErrorBox error={error} />
      <RecordView id='agent-configuration' rows={rows} loading={isLoading} rowKey={(x) => x.key} cols={cols} noun='settings'
        searchText={(x) => `${x.label} ${x.key} ${x.help} ${groupName(x.group)}`} searchPlaceholder='Search settings'
        defaultSort={[{ key: 'group', dir: 'asc' }]} groupable
        actions={(x) => x.source === 'set' ? [{ label: `Reset to ${x.env != null ? 'environment' : 'default'}`, icon: <Icons.close />, onSelect: () => save.mutate({ [x.key]: null }) }] : []}
        primary={<Button variant='outline' disabled={!changed.length || save.isPending} onClick={() => setAskReset(true)}
          title={changed.length ? `${changed.length} setting${changed.length === 1 ? '' : 's'} changed here` : 'Every setting is at its default'}><Icons.refresh /> Reset to defaults</Button>}
        exportName='agent-configuration' empty='No settings.' />
      <AlertDialog open={askReset} onOpenChange={setAskReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset {changed.length} setting{changed.length === 1 ? '' : 's'} to defaults?</AlertDialogTitle>
            <AlertDialogDescription>
              {changed.map((x) => x.label).join(', ')} go back to their defaults (or the environment's value where one is set). Every server picks this up within 30 s.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setAskReset(false); save.mutate(Object.fromEntries(changed.map((x) => [x.key, null]))); }}>Reset to defaults</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
          {a.origin === 'admin' && <span title={`Added on this page; inherits ${a.base_agent ?? a.harness}`} className='text-muted-foreground inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-xs leading-none font-medium ring-1 ring-border ring-inset'>added</span>}
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
        <NativeSelectOption value=''>{counted('All types', data?.providers.length)}</NativeSelectOption>
        {TYPE_ORDER.map((t) => <NativeSelectOption key={t} value={t}>{counted(t, data && data.providers.filter((p) => typeOf(p.slug) === t).length)}</NativeSelectOption>)}
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
    ok: boolean; error: string | null; stale: boolean; plan: number | null; active_now: number | null; ours_orch: number; ours_workers: number; ours_images: number; others: number; other_prefixes: string[];
    our_starts: { minute: number; hour: number; day: number }; starts: { per_minute: number; per_hour: number; per_day: number } | null;
    job_orch_live: number; job_orch_draining: number; job_orch_cap: number; shared_orch_live: number; shared_orch_cap: number; per_job_mode: boolean;
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
 * 15 s while the tab is visible; paused (with a Paused · Resume chip) while a setting has an unsaved edit or a record
 * peek is open.
 */
export function AdminCompute() {
  // useSearchParams (the tab, filters and open records) needs a Suspense boundary for the static render.
  return <Suspense fallback={<PageContainer><Skeleton className='h-72 rounded-lg' /></PageContainer>}><ComputePage /></Suspense>;
}

function ComputePage() {
  const qc = useQueryClient();
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [resumed, setResumed] = useState(false);
  const [peeking, setPeeking] = useState(false);
  const editing = Object.values(dirty).some(Boolean);
  const paused = (editing || peeking) && !resumed;
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
  // "Resume" lasts until the edits are saved or dropped and the peek is closed; the next edit or peek pauses again.
  const setEdit = (key: string, on: boolean) => {
    const next = { ...dirty, [key]: on };
    if (dirty[key] !== on) setDirty(next);
    if (!Object.values(next).some(Boolean) && !peeking) setResumed(false);
  };
  const setPeek = (on: boolean) => {
    setPeeking(on);
    if (!on && !editing) setResumed(false);
  };
  // ?section= picks the tab (orchestrators by default); each tab is its headline numbers and one table. The record
  // tables load and fail on their own, so they show even when the summary did not load.
  const section = useSearchParams().get('section');
  const tab = TABS.some(([id]) => id === section) ? section! : section === 'activity' ? 'decisions' : 'orchestrators';
  const s = data;
  return (
    <PageContainer>
      <div className='flex min-w-0 flex-col gap-3'>
        <UrlTabs tabs={TABS} tab={tab} base='/admin/compute' right={
          <div className='flex flex-wrap items-center justify-end gap-x-4 gap-y-2'>
            {data && <VerdictLine verdict={data.verdict} />}
            <div className='flex flex-wrap items-center gap-2'>
              {data && <Freshness s={data} />}
              {paused && <Button variant='outline' size='sm' onClick={() => setResumed(true)} title={editing ? 'Refresh is paused while a setting has an unsaved edit' : 'Refresh is paused while a record is open'}><Icons.clock /> Paused · Resume</Button>}
              <Button variant='outline' size='sm' disabled={refreshing} onClick={() => void refresh()} title='Ask boat.dev again and reload every figure'>{refreshing ? <Icons.spinner className='animate-spin' /> : <Icons.refresh />} Refresh</Button>
              {data && <RunTick s={data} />}
              {data?.links.newrelic && <ActionsMenu label='More' items={[{ label: 'Open in New Relic', icon: <Icons.externalLink />, onSelect: () => window.open(data.links.newrelic!, '_blank', 'noopener') }]} />}
            </div>
          </div>
        } />
        {error && !data && (
          <div role='alert' className='border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-3 rounded-lg border px-4 py-3 text-sm'>
            <span className='min-w-0 flex-1'>Could not load compute status: {error.message}</span>
            <Button variant='outline' size='xs' onClick={() => void refetch()}>Retry</Button>
          </div>
        )}
        <PeekWatch onChange={setPeek} />
        {tab === 'orchestrators' && <ComputeOrchestrators verdict={data?.verdict ?? []} summary={s && <OrchCards s={s} />} />}
        {tab === 'failures' && <ComputeFailures stats={(f, hours) => <FailureCards f={f} hours={hours} />} />}
        {tab === 'decisions' && <ComputeDecisions runtime={data?.runtime ?? null} stats={(rows) => <DecisionCards s={s} rows={rows} />} />}
        {tab === 'limits' && (isLoading ? <Skeleton className='h-72 rounded-lg' /> : s && <Limits s={s} onEditing={setEdit} />)}
        {tab === 'environment' && (isLoading ? <Skeleton className='h-72 rounded-lg' /> : s && <Environment s={s} onTest={() => void refresh()} testing={refreshing} />)}
      </div>
    </PageContainer>
  );
}

const TABS = [['orchestrators', 'Orchestrators'], ['failures', 'Failures'], ['decisions', 'Autoscaler decisions'], ['limits', 'Limits'], ['environment', 'Environment']] as const;

/** Tells the page whether a record peek is open (?session, ?orch, ?job or ?tick), so the summary stops refreshing. */
function PeekWatch({ onChange }: { onChange: (open: boolean) => void }) {
  const url = useComputeParams();
  const open = ['session', 'orch', 'job', 'tick'].some((k) => url.has(k));
  useEffect(() => { onChange(open); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
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
        {tick.isPending ? <Icons.spinner className='animate-spin' /> : <Icons.play />} Run a tick
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

/** "Ticked 12 s ago": amber past 3 ticks, red past 10 minutes; the runtime, the leader and the data's time on hover. */
function Freshness({ s }: { s: Summary }) {
  useNow();
  const age = ageOf(s.tick.at);
  const tone = age == null || age > 600 ? 'red' : age > 3 * s.tick.tick_seconds ? 'amber' : null;
  const runtime = s.runtime === 'vercel' ? 'Vercel' : 'VM';
  const text = age == null ? 'Not ticked yet' : `Ticked ${dur(age)} ago`;
  const title = [s.tick.at && `Last autoscaler tick ${new Date(s.tick.at).toLocaleString()}${s.tick.holder ? ` by ${s.tick.holder}` : ''}`,
    tone === 'red' && s.runtime === 'vercel' && 'On Vercel, ticks only happen when something happens; queued work may wait for the next 5-minute cron.',
    `Runtime ${runtime} · data as of ${new Date(s.at).toLocaleTimeString()}`].filter(Boolean).join('\n');
  return <span id='tick' className={cn('text-muted-foreground text-xs whitespace-nowrap tabular-nums', tone && LEVEL[tone].text)} title={title}>{text}</span>;
}

/** The worst true rule, on the tabs row: a coloured dot and its line (a link to the records behind it); the rest on hover. */
function VerdictLine({ verdict }: { verdict: Verdict[] }) {
  // Healthy needs no words: the line shows only when something is amber or red.
  const [first, ...rest] = verdict.filter((v) => v.level !== 'green');
  if (!first) return null;
  const dot = first.level === 'red' ? 'bg-destructive' : first.level === 'amber' ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <span role='status' className={cn('flex min-w-0 items-center gap-2 text-sm', LEVEL[first.level].text)} title={rest.map((v) => v.text).join('\n') || undefined}>
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', dot)} />
      <span className='truncate'>{first.href ? <SectionLink href={first.href} className='hover:underline'>{first.text}</SectionLink> : first.text}</span>
      {rest.length > 0 && <span className='text-muted-foreground shrink-0 text-xs'>+{rest.length} more</span>}
    </span>
  );
}

type Card = { label: ReactNode; value: ReactNode; hint?: ReactNode };
/** Two rows of four headline numbers, as on Health › Errors. */
function Cards({ a, b }: { a: Card[]; b: Card[] }) {
  return <><StatStrip items={a} /><StatStrip className='border-t-0' items={b} /></>;
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function OrchCards({ s }: { s: Summary }) {
  useNow();
  const o = s.running.orchestrators, l = s.limits, sp = s.spend_today;
  return <Cards
    a={[
      { label: 'Orchestrators live', value: o.booting + o.running + o.draining, hint: `${o.running} running · ${o.booting} booting · ${o.draining} draining` },
      { label: 'Worker pods used / reserved', value: `${s.running.pods_used} / ${s.running.pods_reserved}`, hint: `${plural(s.running.sessions, 'session')} running` },
      { label: 'boat sandboxes in use', value: l.active_now != null && l.plan != null ? `${l.active_now} / ${l.plan}` : '—', hint: l.plan == null ? 'boat.dev did not answer' : `${l.others} by other deployments` },
      { label: 'Room for more', value: l.available ?? '—', hint: `orchestrators of ${l.per_orchestrator} sandboxes` }
    ]}
    b={[
      { label: 'Failed launches, 24 h', value: s.failures_24h.launches, hint: 'orchestrators that did not start' },
      { label: 'Queued work', value: s.queue.sessions + s.queue.research, hint: `${plural(s.queue.jobs_waiting, 'job')} waiting for an orchestrator` },
      { label: 'Orchestrator model, today', value: money(sp.orchestrator_model_usd), hint: 'through the gateway (UTC day)' },
      { label: 'Sandboxes, today', value: money(sp.sandbox_est_usd), hint: 'estimate from the boat price table' }
    ]} />;
}

function FailureCards({ f, hours }: { f: Failures | undefined; hours: number }) {
  const sum = (xs: { count: number }[] | undefined) => (xs ?? []).reduce((t, x) => t + x.count, 0);
  const sessions = sum(f?.sessions), top = f?.sessions.slice().sort((x, y) => y.count - x.count)[0];
  const w = hours === 24 ? '24 h' : '7 d';
  return <Cards
    a={[
      { label: `Session failures, ${w}`, value: f ? sessions : '—', hint: f?.ended ? `${Math.round((sessions / f.ended) * 100)}% of ${f.ended} that ended` : 'none ended' },
      { label: `Failed launches, ${w}`, value: f ? sum(f.launches) : '—', hint: `${plural(f?.launches.length ?? 0, 'step')} failing` },
      { label: `Unexpected reaps, ${w}`, value: f ? sum(f.reaps.filter((r) => !r.routine)) : '—', hint: 'stopped for a reason other than routine' },
      { label: `Unattended deletes, ${w}`, value: f ? sum(f.unattended) : '—', hint: 'sandboxes gone with no reap recorded' }
    ]}
    b={[
      { label: 'Top session failure', value: top ? top.count : '—', hint: top?.label ?? 'no session failures' },
      { label: 'Failure classes seen', value: f ? f.sessions.length : '—', hint: 'distinct reasons sessions failed' },
      { label: `Sessions ended, ${w}`, value: f ? f.ended : '—' },
      { label: `Routine reaps, ${w}`, value: f ? sum(f.reaps.filter((r) => r.routine)) : '—', hint: 'idle, drained, retired: not failures' }
    ]} />;
}

function DecisionCards({ s, rows }: { s: Summary | undefined; rows: Tick[] }) {
  useNow();
  const age = ageOf(s?.tick.at);
  return <Cards
    a={[
      { label: 'Last tick', value: age == null ? '—' : `${dur(age)} ago`, hint: s?.tick.holder ? `by ${s.tick.holder}` : undefined },
      { label: 'Autoscaler', value: s ? (s.tick.enabled ? 'On' : 'Off') : '—', hint: s ? `every ${s.tick.tick_seconds} s on ${s.runtime === 'vercel' ? 'Vercel (events and 5-minute cron)' : 'the VM'}` : undefined },
      { label: 'Free sandboxes', value: s?.tick.free ?? '—', hint: 'as the last tick saw them' },
      { label: 'Last tick note', value: s?.tick.error ? 'Error' : s?.tick.note ? 'Note' : 'None', hint: s?.tick.error ?? s?.tick.note ?? 'nothing to report' }
    ]}
    b={[
      { label: 'Decisions shown', value: rows.length, hint: 'kept 14 days' },
      { label: 'Orchestrators launched', value: rows.reduce((t, r) => t + r.launched.length, 0) },
      { label: 'Orchestrators reaped', value: rows.reduce((t, r) => t + r.reaped.length, 0) },
      { label: 'Ticks with an error', value: rows.filter((r) => r.error).length }
    ]} />;
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
  // A rejected save (say, over the setting's max) puts the field back to the saved value: its key changes.
  const [rejected, setRejected] = useState(0);
  const set = (k: string) => s.settings.find((x) => x.key === k);
  const boatDown = l.plan == null ? `boat.dev did not answer: ${l.error ?? 'no answer'}` : null;
  const startsNote = 'boat does not report used starts; other deployments\' starts are not counted.';
  const free = l.plan == null || l.active_now == null ? 0 : Math.max(0, l.plan - l.ours_orch - l.ours_workers - l.ours_images - l.others);
  const size = set('BOAT_SANDBOX_SIZE');
  const rows: LimitRow[] = [
    { key: 'plan', label: 'boat sandboxes at once', used: l.active_now, limit: l.plan, unavailable: boatDown,
      sub: l.plan != null && <>ours {l.ours_orch} orchestrators · {l.ours_workers} workers{l.ours_images > 0 && <> · image builder {l.ours_images}</>} · other deployments {l.others} · free {free}</>,
      parts: [
        { label: 'Our orchestrators', n: l.ours_orch, className: 'bg-primary' },
        { label: 'Our workers', n: l.ours_workers, className: 'bg-primary/55' },
        { label: 'Our image builder and images', n: l.ours_images, className: 'bg-primary/30' },
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
        sub: l.job_orch_draining > 0 && <>booting or running · {l.job_orch_draining} draining, not counted</>,
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
  const binding = rows.find((r) => r.status === 'binding');
  const cols: RecordCol<LimitRow>[] = [
    { key: 'limit', label: 'Limit', title: true, keep: true, type: 'text', value: (r) => r.label, render: (r) => (
      <span className='flex flex-col gap-1'>
        <span className='leading-none font-medium' title={r.help ?? r.setting?.help}>{r.label}</span>
        {r.sub && <span className='text-muted-foreground text-xs'>{r.sub}</span>}
      </span>
    ) },
    { key: 'used', label: 'Used / Limit', className: 'w-64', type: 'number', value: (r) => (r.limit ? (r.used ?? 0) / r.limit : null), render: (r) => (
      r.unavailable ? <span className='text-muted-foreground' title={r.unavailable}>—</span>
        : r.limit != null && r.used != null ? (
          <span className='flex flex-col gap-1.5'>
            <span className='text-sm tabular-nums'>{r.used} <span className='text-muted-foreground'>of {r.limit}</span></span>
            <Meter used={r.used} limit={r.limit} parts={r.parts} status={r.status} />
          </span>
        ) : r.setting ? <Mono>{String(r.setting.value)}</Mono> : <span className='text-muted-foreground'>—</span>
    ) },
    { key: 'status', label: 'Status', type: 'select', value: (r) => (r.unavailable || !r.status ? '' : r.status), render: (r) => (
      <span title={r.noBinding ? 'Never marked binding on its own: other deployments share the account\'s starts.' : undefined}>
        {r.unavailable || !r.status ? <span className='text-muted-foreground'>—</span> : STATUS[r.status]}
      </span>
    ) },
    { key: 'source', label: 'Source', type: 'text', value: (r) => r.setting?.source ?? '', render: (r) => (r.setting ? <SourceOf s={r.setting} /> : r.source) },
    { key: 'change', label: 'Change', className: 'w-64', render: (r) => (
      r.setting ? (
        <span className='flex items-center gap-1' onClick={(e) => e.stopPropagation()}>
          <LimitInput key={`${String(r.setting.value)}:${rejected}`} s={r.setting} disabled={save.isPending} onDirty={(on) => onEditing(r.setting!.key, on)}
            onSave={(v) => save.mutate({ [r.setting!.key]: v }, { onError: () => setRejected((k) => k + 1), onSettled: () => onEditing(r.setting!.key, false) })} />
          {r.setting.source === 'set' && (
            <Button variant='ghost' size='xs' className='text-muted-foreground hover:text-foreground' disabled={save.isPending}
              title={`Back to ${r.setting.env != null ? `the environment (${r.setting.env})` : `the default (${r.setting.default})`}`}
              onClick={() => save.mutate({ [r.setting!.key]: null })}>Reset</Button>
          )}
        </span>
      ) : <span className='text-muted-foreground text-xs'>{r.fixed ?? '—'}</span>
    ) }
  ];
  const cards = <Cards
    a={[
      { label: 'boat sandboxes in use', value: l.active_now != null && l.plan != null ? `${l.active_now} / ${l.plan}` : '—', hint: l.plan == null ? 'boat.dev did not answer' : `free ${free}` },
      { label: 'Room for more', value: l.available ?? '—', hint: `orchestrators of ${l.per_orchestrator} sandboxes` },
      { label: 'Sessions a day, at most', value: l.sessions_per_day_ceiling ?? '—', hint: 'at the current limits' },
      { label: 'Binding limit', value: binding ? binding.label : 'None', hint: l.note ? `Autoscaler: “${l.note}”` : l.stale ? `boat.dev is slow (${l.error}); last answer shown` : 'nothing holds work back' }
    ]}
    b={[
      { label: 'Our starts this hour', value: l.starts ? `${l.our_starts.hour} / ${l.starts.per_hour}` : l.our_starts.hour, hint: `${l.our_starts.minute} this minute · ${l.our_starts.day} today` },
      l.per_job_mode
        ? { label: 'Job orchestrators', value: `${l.job_orch_live} / ${l.job_orch_cap}`, hint: l.job_orch_draining ? `${l.job_orch_draining} draining, not counted` : 'per-job mode' }
        : { label: 'Shared orchestrators', value: `${l.shared_orch_live} / ${l.shared_orch_cap}`, hint: 'shared fleet mode' },
      { label: 'Pods per orchestrator', value: `${l.pods_max_reserved} / ${l.pods_cap}`, hint: `most reserved by one · avg running ${l.pods_avg_running}` },
      { label: 'Other deployments', value: l.others, hint: l.other_prefixes.length ? l.other_prefixes.join(', ') : 'sandboxes they hold on this boat account' }
    ]} />;
  return (
    <RecordView id='compute-limits' rows={rows} rowKey={(r) => r.key} cols={cols} noun='limits' initialSize={25} compact summary={cards}
      searchText={(r) => `${r.label} ${r.setting?.key ?? ''} ${r.help ?? ''}`} searchPlaceholder='Search limits'
      empty='No limits.' />
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

/** The environment the autoscaler runs with (read only), settings changed elsewhere, and the boat account in the cards. */
interface EnvRow { name: string; value: string; source: ReactNode; sourceText: string; meaning: ReactNode; meaningText: string }
function Environment({ s, onTest, testing }: { s: Summary; onTest: () => void; testing: boolean }) {
  const p = s.provider;
  const rows: EnvRow[] = [
    ...s.knobs.map((k) => ({ name: k.name, value: k.value, source: k.source, sourceText: k.source, meaning: k.meaning, meaningText: k.meaning })),
    ...RELATED.map((r) => ({ ...r, s: s.settings.find((x) => x.key === r.key) })).filter((r) => r.s).map((r) => ({
      name: r.key, value: String(r.s!.value), source: <SourceOf s={r.s!} />, sourceText: r.s!.source, meaningText: `${r.s!.label}. Change it in ${r.page}`,
      meaning: <>{r.s!.label}. <Link href={r.href} className='text-foreground hover:underline'>Change it in {r.page}</Link></>
    }))
  ];
  const cols: RecordCol<EnvRow>[] = [
    { key: 'name', label: 'Name', title: true, keep: true, type: 'text', value: (r) => r.name, render: (r) => <Mono>{r.name}</Mono> },
    { key: 'value', label: 'Value', type: 'text', value: (r) => r.value, render: (r) => <Mono>{r.value}</Mono> },
    { key: 'source', label: 'Source', type: 'select', value: (r) => r.sourceText, render: (r) => <span className='text-xs'>{r.source}</span> },
    { key: 'meaning', label: 'Meaning', className: 'min-w-80', type: 'text', value: (r) => r.meaningText, render: (r) => <span className='text-muted-foreground text-xs whitespace-normal'>{r.meaning}</span> }
  ];
  const cards = <Cards
    a={[
      { label: 'boat.dev', value: p.ok ? 'Connected' : 'Not connected', hint: p.ok ? p.name : `did not answer: ${p.error ?? 'no answer'}` },
      { label: 'boat key', value: p.has_key ? <Mono>{p.key_hint}</Mono> : 'None', hint: p.has_key ? <>{p.key_label} · {p.uses} uses · <Link href='/admin/keys' className='hover:underline'>Key vault</Link></> : <Link href='/admin/keys' className='hover:underline'>Add one in Key vault</Link> },
      { label: 'Namespace', value: <Mono>{p.namespace}</Mono>, hint: `only sandboxes named ${p.namespace}-…` },
      { label: 'API', value: <span className='text-base'><Mono>{p.api.replace(/^https?:\/\//, '')}</Mono></span>, hint: p.last_used_at ? <>key used <When d={p.last_used_at} /></> : undefined }
    ]}
    b={[
      { label: 'Runtime', value: s.runtime === 'vercel' ? 'Vercel' : 'VM', hint: s.runtime === 'vercel' ? 'ticks on events and a 5-minute cron' : 'ticks on a timer' },
      { label: 'Autoscaler', value: s.tick.enabled ? 'On' : 'Off', hint: `tick every ${s.tick.tick_seconds} s` },
      { label: 'Event ticks', value: s.tick.kick_configured ? 'Configured' : 'Not configured', hint: 'tool calls and portal writes trigger a tick' },
      { label: 'Settings shown', value: rows.length, hint: 'change them in the deployment environment' }
    ]} />;
  return (
    <RecordView id='compute-environment' rows={rows} rowKey={(r) => r.name} cols={cols} noun='settings' initialSize={50} compact summary={cards}
      searchText={(r) => `${r.name} ${r.value} ${r.sourceText} ${r.meaningText}`} searchPlaceholder='Search settings'
      filters={<Button variant='outline' disabled={testing} onClick={onTest}>{testing ? <Icons.spinner className='animate-spin' /> : <Icons.plug />} Test connection</Button>}
      empty='No settings.' />
  );
}
