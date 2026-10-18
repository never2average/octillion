'use client';
// /admin/compute: the global settings that used to be environment variables only (models, run sizes, orchestrator
// capacity, research limits; src/settings.ts) and the default developer population's coding-agent mix. Each setting
// shows the value in force and where it comes from: set here, the server's environment, or the built-in default.
// Saving writes platform_settings (every server picks it up within 30s) and an audit log line. Model keys are the key
// vault's credentials: a key is typed once and never shown again, only its hint.
import { useMemo, useState } from 'react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Icons } from '@/components/icons';
import { List } from './account-peek';
import PageContainer from '@/components/layout/page-container';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { adminApi } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { post, useAdmin, useAdminAction } from './lib';
import { ErrorBox, FormRow, LoadingCards, Mono, Notice, Section, When } from './ui';

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

export function AdminCompute() {
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
        <div className='flex max-w-3xl flex-col gap-10 pb-10'>
          {data.groups.map((g) => (
            <Section key={g.id} title={g.label}>
              <div className='grid gap-6'>
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
          <AgentMix pop={data.population} />
          <ModelKeys />
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
function AgentMix({ pop }: { pop: Compute['population'] }) {
  const set = useAdminAction((v: { id: string; market_share?: number; paused?: boolean }) =>
    adminApi('PUT', `/compute/agents/${encodeURIComponent(v.id)}`, { market_share: v.market_share, paused: v.paused }), { success: 'Agent mix saved' });
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(() => pop.agents.filter((a) => showAll || a.in_mix || a.weight > 0), [pop.agents, showAll]);
  const hidden = pop.agents.length - pop.agents.filter((a) => a.in_mix || a.weight > 0).length;
  const on = pop.agents.filter((a) => a.status === 'On').length;
  return (
    <Section title='Agent mix' description={<>The coding agents runs sample, by weight, in the default population ({pop.name}). {on} on, {pop.sandbox_unit} sandboxes per unit{pop.as_of && <>, shares as of {pop.as_of}</>}.</>}
      action={hidden > 0 ? <Button variant='ghost' size='sm' onClick={() => setShowAll(!showAll)}>{showAll ? 'Hide agents not in the mix' : `Show all ${pop.agents.length} agents`}</Button> : undefined}>
      <div className='overflow-x-auto border-y'>
        <Table>
          <TableHeader>
            <TableRow className='hover:bg-transparent'>
              {['Agent', 'Weight', 'Share', 'Sandboxes', 'Status', 'On'].map((h, i) => (
                <TableHead key={h} className={cn('text-muted-foreground h-8 px-3 text-xs font-normal', i > 0 && i < 4 && 'text-right', i === 5 && 'w-12 text-right')}>{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((a) => (
              <TableRow key={a.id} className={cn(a.status !== 'On' && 'text-muted-foreground')}>
                <TableCell className='px-3 py-2.5 text-sm leading-none'>
                  <span className='flex flex-col gap-1'><span className={cn(a.status === 'On' && 'text-foreground font-medium')}>{a.label}</span><Mono>{a.id}</Mono></span>
                </TableCell>
                <TableCell className='px-3 py-1.5 text-right'>
                  <WeightInput key={a.weight} value={a.weight} disabled={set.isPending} onSave={(w) => set.mutate({ id: a.id, market_share: w })} label={`Weight of ${a.label}`} />
                </TableCell>
                <TableCell className='px-3 py-2.5 text-right text-sm tabular-nums'>{a.share ? pct(a.share) : '—'}</TableCell>
                <TableCell className='px-3 py-2.5 text-right text-sm tabular-nums'>{a.sandboxes || '—'}</TableCell>
                <TableCell className='px-3 py-2.5 text-sm leading-none' title={a.paused_reason ?? undefined}>{a.status}</TableCell>
                <TableCell className='w-12 px-3 py-2.5 text-right'>
                  <Switch aria-label={`${a.label} on`} checked={a.status === 'On'}
                    disabled={!a.runnable || set.isPending} onCheckedChange={(c) => set.mutate({ id: a.id, paused: !c })} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className='text-muted-foreground text-xs'>Turning on an agent with no weight gives it the smallest weight in the mix. Changes apply to runs started from now on.</p>
    </Section>
  );
}

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

/** The key vault: providers (on/off, how many keys), their keys by hint, and a form to add one. The key itself is
 * posted once and the field is cleared; nothing on this page can show it again. */
function ModelKeys() {
  const { data, error } = useAdmin<{ unlocked: boolean; providers: Provider[]; credentials: Credential[] }>('/compute/keys');
  const [f, setF] = useState({ provider: '', label: '', secret: '' });
  const [err, setErr] = useState('');
  const [del, setDel] = useState<Credential | null>(null);
  const add = useAdminAction(() => post<{ hint: string }>('/compute/keys', { provider: f.provider || data?.providers[0]?.slug, label: f.label.trim() || undefined, secret: f.secret }),
    { success: (r) => `Key saved (${r.hint})` });
  const keyOn = useAdminAction((v: { id: number; enabled: boolean }) => post(`/compute/keys/${v.id}/enabled`, { enabled: v.enabled }), { success: 'Key updated' });
  const remove = useAdminAction((id: number) => adminApi('DELETE', `/compute/keys/${id}`), { success: 'Key deleted' });
  const provOn = useAdminAction((v: { slug: string; enabled: boolean }) => post(`/compute/providers/${encodeURIComponent(v.slug)}/enabled`, { enabled: v.enabled }), { success: 'Provider updated' });
  const providers = data?.providers ?? [];
  const provider = f.provider || providers[0]?.slug || '';
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    // The key leaves the form whatever happens: a failed save asks for it again rather than keeping it on screen.
    add.mutate(undefined, { onSuccess: () => setF({ ...f, label: '', secret: '' }), onError: (x) => { setErr(x.message); setF({ ...f, secret: '' }); } });
  };
  return (
    <Section title='Model keys' description='Provider keys in the key vault, encrypted at rest. Agents and orchestrators get scoped gateway tokens, never these keys.'>
      <ErrorBox error={error} />
      {data && !data.unlocked && <Notice>The key vault is locked: set <Mono>OCTILLION_VAULT_KEY</Mono> on the server to add keys.</Notice>}
      <List title='Providers' rows={providers} empty='No providers.' cols={[
        ['Provider', (p) => <Mono>{p.slug}</Mono>],
        ['Mode', (p) => <span className='text-muted-foreground'>{p.mode}{p.backend !== 'direct' && ` · ${p.backend}`}</span>],
        ['Keys', (p) => <span className='tabular-nums'>{p.keys ? `${p.enabled_keys} of ${p.keys} on` : '—'}</span>, 'text-right'],
        ['Last used', (p) => (p.last_used_at ? <When d={p.last_used_at} /> : <span className='text-muted-foreground'>never</span>)],
        ['On', (p) => <Switch aria-label={`${p.slug} on`} checked={p.enabled} disabled={provOn.isPending} onCheckedChange={(c) => provOn.mutate({ slug: p.slug, enabled: c })} />, 'w-12 text-right']
      ]} />
      <List title='Keys' rows={data?.credentials ?? []} empty='No keys yet.' rowClassName={(c) => (c.enabled ? undefined : 'text-muted-foreground')}
        actions={(c) => [
          { label: c.enabled ? 'Disable' : 'Enable', icon: c.enabled ? <Icons.eyeOff /> : <Icons.check />, onSelect: () => keyOn.mutate({ id: c.id, enabled: !c.enabled }) },
          { label: 'Delete…', icon: <Icons.trash />, destructive: true, separator: true, onSelect: () => setDel(c) }
        ]}
        cols={[
          ['Provider', (c) => <Mono>{c.provider}</Mono>],
          ['Label', (c) => c.label],
          ['Key', (c) => <Mono>{c.hint}</Mono>],
          ['Uses', (c) => <span className='tabular-nums'>{c.uses}</span>, 'text-right'],
          ['Last used', (c) => (c.last_used_at ? <When d={c.last_used_at} /> : <span className='text-muted-foreground'>never</span>)],
          ['Status', (c) => (c.enabled ? 'on' : 'off')]
        ]} />
      <form onSubmit={submit} className='grid max-w-md gap-4' autoComplete='off'>
        <p className='text-sm leading-none font-medium'>Add a key</p>
        <FormRow id='mk-provider' label='Provider'>
          <NativeSelect id='mk-provider' value={provider} onChange={(e) => setF({ ...f, provider: e.target.value })} className='w-full'>
            {providers.map((p) => <NativeSelectOption key={p.slug} value={p.slug}>{p.slug} ({p.mode})</NativeSelectOption>)}
          </NativeSelect>
        </FormRow>
        <FormRow id='mk-label' label='Label (optional)' hint='A second key under a new label adds to the pool; the same label replaces that key.'>
          <Input id='mk-label' maxLength={60} placeholder='default' value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
        </FormRow>
        <FormRow id='mk-secret' label='Key' hint='Shown only as a hint once saved.'>
          <Input id='mk-secret' type='password' autoComplete='new-password' spellCheck={false} required value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} />
        </FormRow>
        {err && <p className='text-destructive text-sm'>{err}</p>}
        <div><Button type='submit' disabled={add.isPending || !f.secret.trim() || !provider || data?.unlocked === false}>Save key</Button></div>
      </form>
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
