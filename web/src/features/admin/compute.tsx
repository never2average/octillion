'use client';
// /admin/compute: the global settings that used to be environment variables only (models, run sizes, orchestrator
// capacity, research limits; src/settings.ts) and the default developer population's coding-agent mix. Each setting
// shows the value in force and where it comes from: set here, the server's environment, or the built-in default.
// Saving writes platform_settings (every server picks it up within 30s) and an audit log line. Model keys are the key
// vault's credentials: a key is typed once and never shown again, only its hint.
import { useState } from 'react';
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
import { Field, RecordView, type RecordCol } from '@/components/layout/record-view';

interface Setting {
  key: string; group: string; label: string; help: string; kind: 'text' | 'int' | 'number' | 'choice'; default: string | number;
  options?: string[]; min?: number; max?: number; value: string | number; source: 'set' | 'env' | 'default';
  env: string | null; updated_at: string | null; updated_by: string | null;
}
interface Agent {
  id: string; label: string; harness: string; model: string; vendor: string | null; in_mix: boolean; weight: number; share: number;
  sandboxes: number; paused: boolean; paused_reason: string | null; runnable: boolean; status: string;
}
interface Compute { groups: { id: string; label: string }[]; settings: Setting[]; population: { slug: string; name: string; sandbox_unit: number; as_of: string | null; agents: Agent[] } }

const pct = (x: number) => `${(x * 100).toFixed(x > 0 && x < 0.01 ? 1 : 0)}%`;

/** Compute: the sandbox provider and capacity settings. */
export const AdminCompute = () => <SettingsPage groups={['capacity']} sandbox />;
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

/** The settings of some groups (one input per row, a sticky save bar), optionally followed by the agent mix. */
function SettingsPage({ groups, sandbox }: { groups: string[]; sandbox?: boolean }) {
  const { data, error, isLoading } = useAdmin<Compute>('/compute');
  // Edits not saved yet: key -> the typed text, or null for "reset to the environment / default".
  const [edits, setEdits] = useState<Record<string, string | null>>({});
  const save = useAdminAction(() => adminApi<Compute>('PUT', '/compute/settings', { values: edits }), { success: 'Settings saved' });
  const dirty = Object.keys(edits).length;
  if (isLoading) return <PageContainer><LoadingCards count={4} /></PageContainer>;

  return (
    <PageContainer>
      <ErrorBox error={error} />
      {data && (
        <div className='flex w-full flex-col gap-10 pb-10'>
          {sandbox && <SandboxProvider />}
          {data.groups.filter((g) => groups.includes(g.id)).map((g) => (
            <Section key={g.id} title={g.label}>
              <div className='grid gap-x-12 gap-y-6 xl:grid-cols-2'>
                {data.settings.filter((s) => s.group === g.id).map((s) => (
                  <SettingRow key={s.key} s={s} edit={edits[s.key]} setEdit={(v) => setEdits((e) => {
                    const { [s.key]: _, ...rest } = e;
                    return v === undefined ? rest : { ...rest, [s.key]: v };
                  })} />
                ))}
              </div>
            </Section>
          ))}
          {/* The save bar sticks to the bottom of the page while anything is changed (settings only: the mix saves as you go). */}
          {dirty > 0 && (
            <div className='bg-background/95 sticky bottom-0 z-20 -mt-6 flex items-center gap-3 border-t py-3 backdrop-blur'>
              <span className='text-sm tabular-nums'>{dirty} unsaved change{dirty === 1 ? '' : 's'}</span>
              <Button variant='ghost' size='sm' className='ml-auto' onClick={() => setEdits({})}>Discard</Button>
              <Button size='sm' disabled={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => setEdits({}) })}>Save changes</Button>
            </div>
          )}
        </div>
      )}
    </PageContainer>
  );
}

/** One setting: its input, what it does, the value in force and where it comes from, and a reset. `edit` is the
 * unsaved text (null: reset pending; undefined: unchanged). */
function SettingRow({ s, edit, setEdit }: { s: Setting; edit: string | null | undefined; setEdit: (v: string | null | undefined) => void }) {
  const id = `set-${s.key}`;
  // A pending reset shows what it falls back to: the environment's value, else the default.
  const fallback = s.env ?? String(s.default);
  const shown = edit === null ? fallback : edit ?? String(s.value);
  const change = (v: string) => setEdit(v === String(s.value) ? undefined : v);
  const status = edit === null ? <>Goes back to {s.env != null ? 'the environment value' : 'the default'} when saved</>
    : edit !== undefined ? <>Not saved yet</>
    : s.source === 'set' ? <>Set here{s.updated_by && ` by ${s.updated_by}`}{s.updated_at && <>, <When d={s.updated_at} /></>}</>
    : s.source === 'env' ? <>From the environment</> : <>Default</>;
  const input = s.kind === 'choice' ? (
    <NativeSelect id={id} value={shown} onChange={(e) => change(e.target.value)} className='w-48'>
      {s.options!.map((o) => <NativeSelectOption key={o} value={o}>{o}</NativeSelectOption>)}
    </NativeSelect>
  ) : (
    <Input id={id} value={shown} onChange={(e) => change(e.target.value)} className={cn(s.kind === 'text' ? 'max-w-md font-mono text-sm' : 'w-40 tabular-nums')}
      type={s.kind === 'text' ? 'text' : 'number'} min={s.min} max={s.max} step={s.kind === 'number' ? 'any' : 1} />
  );
  return (
    <FormRow id={id} label={s.label} hint={s.help}>
      <div className='flex flex-wrap items-center gap-3'>
        {input}
        <span className={cn('text-xs', edit !== undefined ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>{status}</span>
        {edit !== undefined ? (
          <Button type='button' variant='ghost' size='xs' className='text-muted-foreground hover:text-foreground' onClick={() => setEdit(undefined)}>Undo</Button>
        ) : s.source === 'set' && (
          <Button type='button' variant='ghost' size='xs' className='text-muted-foreground hover:text-foreground' onClick={() => setEdit(null)}>
            Reset to {s.env != null ? 'environment' : 'default'}
          </Button>
        )}
      </div>
      <p className='text-muted-foreground text-xs'>
        <Mono>{s.key}</Mono> · default <Mono>{String(s.default)}</Mono>{s.env != null && <> · environment <Mono>{s.env}</Mono></>}
      </p>
    </FormRow>
  );
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
  const cols: RecordCol<Agent>[] = [
    { key: 'agent', label: 'Agent', keep: true, type: 'text', value: (a) => a.label,
      render: (a) => <span className='flex min-w-0 flex-col gap-1'><span className={cn('leading-none', a.status === 'On' && 'font-medium')}>{a.label}</span><Mono>{a.id}</Mono></span> },
    { key: 'vendor', label: 'Vendor', type: 'select', value: (a) => a.vendor ?? '', render: (a) => a.vendor ?? NA },
    { key: 'harness', label: 'Harness', type: 'select', value: (a) => a.harness, render: (a) => <Mono>{a.harness}</Mono> },
    { key: 'model', label: 'Model', type: 'text', value: (a) => a.model, render: (a) => <Mono>{a.model}</Mono> },
    { key: 'weight', label: 'Weight', className: 'w-32 text-right', type: 'number', value: (a) => a.weight,
      render: (a) => <span onClick={(e) => e.stopPropagation()}><WeightInput key={a.weight} value={a.weight} disabled={set.isPending} onSave={(w) => set.mutate({ id: a.id, market_share: w })} label={`Weight of ${a.label}`} /></span> },
    { key: 'share', label: 'Share of runs', className: 'text-right', type: 'number', value: (a) => a.share, render: (a) => <span className='tabular-nums'>{a.share ? pct(a.share) : '—'}</span> },
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
        noun='agents'
        searchText={(a) => `${a.label} ${a.id} ${a.vendor ?? ''} ${a.model} ${a.harness}`}
        searchPlaceholder={pop ? `Search ${pop.agents.length} agents · ${pop.name}: ${pop.agents.filter((a) => a.status === 'On').length} on, ${pop.sandbox_unit} sandboxes per unit` : 'Search agents'}
        views={[
          { id: 'mix', label: 'In the mix', match: (a) => a.in_mix || a.weight > 0 },
          { id: 'on', label: 'On', match: (a) => a.status === 'On' },
          { id: 'all', label: 'All agents' }
        ]}
        defaultSort={[{ key: 'weight', dir: 'desc' }]}
        actions={(a) => [
          { label: a.status === 'On' ? 'Turn off' : 'Turn on', icon: a.status === 'On' ? <Icons.eyeOff /> : <Icons.check />, disabled: !a.runnable, onSelect: () => set.mutate({ id: a.id, paused: a.status === 'On' }) }
        ]}
        bulk={(rows, clear) => [
          { label: 'Turn on', icon: <Icons.check />, onSelect: () => { rows.filter((a) => a.runnable).forEach((a) => set.mutate({ id: a.id, paused: false })); clear(); } },
          { label: 'Turn off', icon: <Icons.eyeOff />, onSelect: () => { rows.forEach((a) => set.mutate({ id: a.id, paused: true })); clear(); } }
        ]}
        exportName='harness-mix'
        empty='No agents.'
      />
    </PageContainer>
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

interface Sandbox {
  provider: string; api: string; namespace: string; ok: boolean; error: string | null;
  keys: { id: number; label: string; hint: string; enabled: boolean; uses: number; last_used_at: string | null }[];
  limits: { activeSandboxes: number; startsPerMinute: number; startsPerHour: number; startsPerDay: number; activeNow: number } | null;
  running: { total: number; ours: number; orchestrators: number; others: number } | null;
  orchestrators: Record<string, number>;
}

/** The sandbox provider: which account and key, live plan limits and what is running. Refresh = a live connection test. */
function SandboxProvider() {
  const { data, error, isFetching, refetch } = useAdmin<Sandbox>('/compute/sandbox');
  const key = data?.keys.find((k) => k.enabled);
  return (
    <Section title='Sandbox provider' description='Where orchestrators and agent sandboxes run. Its key lives in Key vault (provider boat): add a new one there to rotate it or switch to another boat.dev account.'
      action={<Button variant='outline' size='sm' disabled={isFetching} onClick={() => void refetch()}>{isFetching ? <Icons.spinner className='animate-spin' /> : <Icons.plug />} Test connection</Button>}>
      <ErrorBox error={error} />
      {data && (<>
        {!data.ok && <Notice>boat.dev did not answer: {data.error}</Notice>}
        <dl className='grid gap-x-12 xl:grid-cols-2'>
          <Field label='Provider'>{data.provider} <span className='text-muted-foreground'>· {data.ok ? 'connected' : 'not connected'}</span></Field>
          <Field label='Key'>{key ? <><Mono>{key.hint}</Mono> <span className='text-muted-foreground'>· {key.label} · used <When d={key.last_used_at} /></span></> : <span className='text-amber-700 dark:text-amber-400'>No boat key: add one in Key vault</span>}</Field>
          <Field label='API'><Mono>{data.api}</Mono></Field>
          <Field label='Namespace'><Mono>{data.namespace}</Mono> <span className='text-muted-foreground'>· this deployment only touches sandboxes named {data.namespace}-…</span></Field>
          {data.limits && <Field label='Plan'>{data.limits.activeSandboxes} sandboxes at once · {data.limits.startsPerDay} starts a day <span className='text-muted-foreground'>({data.limits.startsPerHour}/hour, {data.limits.startsPerMinute}/minute)</span></Field>}
          {data.running && <Field label='Running now'>{data.running.total} of {data.limits?.activeSandboxes ?? '?'} <span className='text-muted-foreground'>· ours {data.running.ours} ({data.running.orchestrators} orchestrators) · other deployments {data.running.others}</span></Field>}
          <Field label='Orchestrators'>{Object.keys(data.orchestrators).length ? Object.entries(data.orchestrators).map(([s, n]) => `${n} ${s}`).join(' · ') : <span className='text-muted-foreground'>none running</span>}</Field>
        </dl>
      </>)}
    </Section>
  );
}
