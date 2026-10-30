'use client';
// /admin/personas: the shared developer personas (vault profiles plus ones written here) the orchestrator role-plays
// when an agent asks a question. Every action sits in a row's ⋯ menu, the bulk bar or the peek. An edit (or turning a
// persona on or off) makes the row the admin's: the vault sync leaves it alone from then on (src/vault.ts).
import { useState, type ReactNode } from 'react';
import PageContainer from '@/components/layout/page-container';
import { ActionsMenu, RecordView, type RecordCol, type RowAction } from '@/components/layout/record-view';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { DetailMeta, DetailTable, DetailTabs, KeyValueTable, LongText } from '@/components/layout/detail';
import { adminApi } from '@/lib/api-client';
import { post, useAdmin, useAdminAction } from './lib';
import { Gate, useAdminRole } from './role';
import { Chips, ErrorBox, FormRow, Mono, StatusBadge, When } from './ui';
import { companySize } from '@/lib/octillion-format';
import { LibraryViewSwitch, Submissions, useLibraryView } from './submissions';

export interface Persona {
  slug: string; external_id: string | null; name: string; summary: string; instructions: string; active: boolean;
  source: 'vault' | 'admin' | 'contributed'; synced_at: string; edited_at: string | null; edited_by: string | null;
  attributes: { role?: string | null; experience_years?: number | null; company_size?: string | null; stack?: string[]; constraints?: string[]; tone?: string | null; [k: string]: unknown };
}
/** What the edit form writes (PATCH / POST /personas). */
interface Draft { slug?: string; name: string; summary: string; role: string; experience_years: string; company_size: string; stack: string; constraints: string; tone: string; instructions: string }

const NA = <span className='text-muted-foreground'>—</span>;
// The attributes the table and form show; the rest (industry, survey, ...) are listed as they are in the peek.
/** "100 to 499 employees" → "100 to 499"; an unknown size ("Unknown org size") is no size. */
/** The headcount band in its standard form (companySize): "<20", "100-499", "10,000+" or "-". */
const sizeOf = (p: { attributes: { company_size?: string | null } }) => companySize(p.attributes.company_size);
const SHOWN = new Set(['role', 'experience_years', 'company_size', 'stack', 'constraints', 'tone']);
const text = (v: unknown) => (v == null || v === '' ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));
const years = (p: Persona) => (typeof p.attributes.experience_years === 'number' ? p.attributes.experience_years : null);
const originOf = (p: Persona) => (p.source === 'admin' ? 'Written here' : p.source === 'contributed' ? 'Contributed by an account' : p.edited_at ? 'Vault, edited here' : 'Vault');

const toDraft = (p: Persona, copy = false): Draft => ({
  slug: copy ? undefined : p.slug, name: copy ? `${p.name} (copy)` : p.name, summary: p.summary, role: p.attributes.role ?? '',
  experience_years: years(p) == null ? '' : String(years(p)), company_size: p.attributes.company_size ?? '', stack: (p.attributes.stack ?? []).join(', '),
  constraints: (p.attributes.constraints ?? []).join('\n'), tone: p.attributes.tone ?? '', instructions: p.instructions
});
const blank = (): Draft => ({ name: '', summary: '', role: '', experience_years: '', company_size: '', stack: '', constraints: '', tone: '', instructions: '' });

export function AdminPersonas() {
  const { lock } = useAdminRole();
  const { data, error, isLoading } = useAdmin<{ personas: Persona[] }>('/personas');
  const [draft, setDraft] = useState<{ d: Draft; from?: Persona } | null>(null);
  const setActive = useAdminAction((v: { slugs: string[]; active: boolean }) => post<{ updated: number }>('/personas/active', v),
    { success: (r) => `${r.updated} persona${r.updated === 1 ? '' : 's'} ${r.updated === 1 ? 'updated' : 'updated'}` });
  const rows = data?.personas ?? [];
  const [view, setView] = useLibraryView();
  const switcher = <LibraryViewSwitch kind='persona' value={view} onChange={setView} />;

  const cols: RecordCol<Persona>[] = [
    { key: 'name', label: 'Persona', className: 'min-w-56', title: true, keep: true, peek: false, type: 'text', value: (p) => p.name, render: (p) => (
      <span className='flex flex-col gap-1.5'><span className='leading-none font-medium'>{p.name}</span>
        {p.summary && <span className='text-muted-foreground line-clamp-1 text-xs leading-snug'>{p.summary}</span>}</span>
    ) },
    { key: 'role', label: 'Role', className: 'w-56', type: 'select', value: (p) => p.attributes.role ?? null, render: (p) => {
      const sub = [years(p) == null ? null : `${years(p)} yrs`, sizeOf(p) === '-' ? null : sizeOf(p)].filter(Boolean).join(' · ');
      return (
        <span className='flex flex-col gap-0.5'>{p.attributes.role ?? NA}{sub && <span className='text-muted-foreground text-xs tabular-nums'>{sub}</span>}</span>
      );
    } },
    { key: 'experience', label: 'Experience', hidden: true, className: 'w-24 text-right', type: 'number', value: years,
      render: (p) => (years(p) == null ? NA : <span className='tabular-nums'>{years(p)} yrs</span>) },
    { key: 'company_size', label: 'Company size', hidden: true, className: 'w-44', type: 'select', value: (p) => sizeOf(p), render: (p) => sizeOf(p) },
    { key: 'stack', label: 'Stack', hidden: true, className: 'min-w-56', type: 'text', value: (p) => (p.attributes.stack ?? []).join(', '), render: (p) => <Chips items={p.attributes.stack} max={3} oneLine /> },
    { key: 'tone', label: 'Tone', hidden: true, type: 'text', value: (p) => p.attributes.tone ?? null, render: (p) => p.attributes.tone ?? NA },
    { key: 'source', label: 'Origin', hidden: true, className: 'w-36', type: 'select', value: originOf,
      options: [{ value: 'Vault' }, { value: 'Vault, edited here' }, { value: 'Written here' }, { value: 'Contributed by an account' }], render: (p) => <span className='text-muted-foreground text-sm'>{originOf(p)}</span> },
    { key: 'edited_at', label: 'Edited', hidden: true, className: 'w-28', type: 'date', value: (p) => p.edited_at, render: (p) => (p.edited_at ? <When d={p.edited_at} className='text-muted-foreground text-xs' /> : NA) },
    { key: 'active', label: 'Active', name: 'Active', className: 'w-24', keep: true, type: 'boolean', value: (p) => p.active,
      render: (p) => <StatusBadge tone={p.active ? 'ok' : 'neutral'}>{p.active ? 'active' : 'inactive'}</StatusBadge> }
  ];

  const actions = (p: Persona): RowAction[] => [
    { label: 'Edit', icon: <Icons.edit />, onSelect: () => setDraft({ d: toDraft(p), from: p }) },
    { label: 'Duplicate', icon: <Icons.add />, onSelect: () => setDraft({ d: toDraft(p, true) }) },
    { label: p.active ? 'Deactivate' : 'Activate', icon: p.active ? <Icons.eyeOff /> : <Icons.check />, separator: true,
      onSelect: () => setActive.mutate({ slugs: [p.slug], active: !p.active }) }
  ].map((a) => lock(a, 'library'));
  const bulk = (sel: Persona[], clear: () => void): RowAction[] => {
    const on = sel.filter((p) => !p.active), off = sel.filter((p) => p.active);
    const go = (list: Persona[], active: boolean) => setActive.mutate({ slugs: list.map((p) => p.slug), active }, { onSuccess: clear });
    return [
      ...(on.length ? [{ label: `Activate ${on.length}`, icon: <Icons.check />, onSelect: () => go(on, true) }] : []),
      ...(off.length ? [{ label: `Deactivate ${off.length}`, icon: <Icons.eyeOff />, onSelect: () => go(off, false) }] : [])
    ].map((a) => lock(a, 'library'));
  };

  if (view === 'submissions') return <Submissions kind='persona' switcher={switcher} />;
  return (
    <PageContainer>
      <ErrorBox error={error} />
      <RecordView<Persona>
        filters={switcher}
        id='admin-personas' noun='personas' exportName='personas' groupable
        rows={rows} rowKey={(p) => p.slug} cols={cols} actions={actions} bulk={bulk} loading={isLoading}
        defaultSort={[{ key: 'name', dir: 'asc' }]}
        searchText={(p) => `${p.name} ${p.summary} ${p.slug} ${p.attributes.role ?? ''} ${(p.attributes.stack ?? []).join(' ')}`}
        searchPlaceholder='Search personas by name, summary or stack'
        primary={<Gate need='library'><Button onClick={() => setDraft({ d: blank() })}><Icons.add /> New persona</Button></Gate>}
        empty='No personas yet. Run the vault sync or add one.'
        detailTitle={() => 'Persona'}
        detail={(p) => <PersonaBody p={p} actions={<>
          <Gate need='library'><Button size='sm' variant='outline' onClick={() => setDraft({ d: toDraft(p), from: p })}><Icons.edit /> Edit</Button></Gate>
          <ActionsMenu items={actions(p).filter((a) => a.label !== 'Edit')} />
        </>} />}
      />
      {draft && <PersonaEditor draft={draft.d} from={draft.from} onClose={() => setDraft(null)} />}
    </PageContainer>
  );
}

/** The persona peek: the card (status, origin, slug, when it last changed, the actions), then tabs: the properties, the
 * summary and instructions (what the orchestrator follows when it answers as this developer), constraints and other
 * attributes as tables. */
function PersonaBody({ p, actions }: { p: Persona; actions: ReactNode }) {
  const a = p.attributes;
  const other = Object.entries(a).filter(([k, v]) => !SHOWN.has(k) && text(v) != null).map(([k, v]) => ({ k, v: text(v)! }));
  const constraints = (a.constraints ?? []).map((c, i) => ({ i, c }));
  return (
    <div className='flex flex-col gap-4'>
      <DetailMeta
        title={p.name}
        badges={<StatusBadge tone={p.active ? 'ok' : 'neutral'}>{p.active ? 'active' : 'inactive'}</StatusBadge>}
        actions={actions}
        facts={[
          { label: 'Origin', value: originOf(p) },
          { label: 'Slug', value: <Mono>{p.slug}</Mono> },
          p.edited_at
            ? { label: 'Edited', value: <When d={p.edited_at} />, hint: p.edited_by ? `by ${p.edited_by}` : undefined }
            : { label: 'Synced', value: <When d={p.synced_at} /> },
          { label: 'Vault id', value: <Mono>{p.external_id}</Mono>, hidden: !p.external_id }
        ]}
      />
      <DetailTabs resetKey={p.slug} tabs={[
        { id: 'persona', label: 'Persona', content: (
          <KeyValueTable rows={[
            { label: 'Role', value: a.role ?? NA },
            { label: 'Experience', value: years(p) == null ? NA : `${years(p)} years` },
            { label: 'Company size', value: sizeOf({ attributes: a }) },
            { label: 'Stack', value: <Chips items={a.stack} /> },
            { label: 'Tone', value: a.tone ?? NA }
          ]} />
        ) },
        { id: 'prompt', label: 'Prompt', content: (
          <KeyValueTable rows={[
            { label: 'Summary', value: p.summary ? <LongText>{p.summary}</LongText> : <span className='text-muted-foreground'>None.</span> },
            { label: 'Instructions', value: p.instructions ? <LongText>{p.instructions}</LongText> : <span className='text-muted-foreground'>None.</span> }
          ]} />
        ) },
        { id: 'constraints', label: 'Constraints', count: constraints.length, content: (
          <DetailTable rows={constraints} rowKey={(r) => String(r.i)} noun='constraints' empty='No constraints.' cols={[
            { key: 'i', label: '#', type: 'number', value: (r) => r.i + 1, render: (r) => <span className='text-muted-foreground tabular-nums'>{r.i + 1}</span>, className: 'w-8' },
            { key: 'c', label: 'Constraint', render: (r) => r.c, className: 'whitespace-normal leading-snug' }
          ]} />
        ) },
        { id: 'other', label: 'Other attributes', count: other.length, hidden: !other.length, content: (
          <DetailTable rows={other} rowKey={(r) => r.k} noun='attributes' empty='No other attributes.' search={(r) => `${r.k} ${r.v}`} cols={[
            { key: 'k', label: 'Attribute', type: 'text', value: (r) => r.k, render: (r) => <Mono>{r.k}</Mono>, className: 'w-40' },
            { key: 'v', label: 'Value', render: (r) => r.v, className: 'whitespace-normal leading-snug break-all' }
          ]} />
        ) }
      ]} />
    </div>
  );
}

/** Edit a persona, or write a new one (a duplicate starts as a prefilled new one). One input per row. */
function PersonaEditor({ draft, from, onClose }: { draft: Draft; from?: Persona; onClose: () => void }) {
  const [d, setD] = useState<Draft>(draft);
  const [err, setErr] = useState('');
  const isNew = !d.slug;
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setD({ ...d, [k]: e.target.value });
  const body = () => ({
    name: d.name, summary: d.summary, role: d.role, experience_years: d.experience_years.trim() === '' ? null : Number(d.experience_years),
    company_size: d.company_size, stack: d.stack.split(',').map((s) => s.trim()).filter(Boolean),
    constraints: d.constraints.split('\n').map((s) => s.trim()).filter(Boolean), tone: d.tone, instructions: d.instructions
  });
  const save = useAdminAction(() => (isNew ? post('/personas', body()) : adminApi('PATCH', `/personas/${encodeURIComponent(d.slug!)}`, body())),
    { success: isNew ? 'Persona added' : 'Persona saved' });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    save.mutate(undefined, { onSuccess: onClose, onError: (x) => setErr(x.message) });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-xl'>
        <form onSubmit={submit} className='grid gap-4'>
          <DialogHeader>
            <DialogTitle>{isNew ? 'New persona' : `Edit ${from?.name ?? d.name}`}</DialogTitle>
            <DialogDescription>
              {isNew ? 'A shared developer persona every account can pick.'
                : from?.source === 'vault' ? 'Once saved, the vault sync no longer changes this persona.' : 'A persona written here; the vault sync never changes it.'}
            </DialogDescription>
          </DialogHeader>
          <FormRow id='pe-name' label='Name'><Input id='pe-name' required maxLength={120} value={d.name} onChange={set('name')} /></FormRow>
          <FormRow id='pe-summary' label='Summary' hint='Who they are, in a sentence or two.'>
            <Textarea id='pe-summary' rows={3} maxLength={2000} value={d.summary} onChange={set('summary')} />
          </FormRow>
          <FormRow id='pe-role' label='Role'><Input id='pe-role' maxLength={200} placeholder='e.g. Developer, back-end' value={d.role} onChange={set('role')} /></FormRow>
          <FormRow id='pe-exp' label='Experience (years)'>
            <Input id='pe-exp' type='number' min={0} max={70} value={d.experience_years} onChange={set('experience_years')} className='w-32' />
          </FormRow>
          <FormRow id='pe-size' label='Company size'><Input id='pe-size' maxLength={200} placeholder='e.g. <20, 100-499 or 10,000+' value={d.company_size} onChange={set('company_size')} /></FormRow>
          <FormRow id='pe-stack' label='Stack' hint='Languages, frameworks and tools, separated by commas.'>
            <Input id='pe-stack' value={d.stack} onChange={set('stack')} placeholder='TypeScript, Next.js, Postgres' />
          </FormRow>
          <FormRow id='pe-constraints' label='Constraints' hint='One per line.'>
            <Textarea id='pe-constraints' rows={4} value={d.constraints} onChange={set('constraints')} />
          </FormRow>
          <FormRow id='pe-tone' label='Tone'><Input id='pe-tone' maxLength={200} placeholder='e.g. Concise and practical' value={d.tone} onChange={set('tone')} /></FormRow>
          <FormRow id='pe-instructions' label='Instructions' hint='How this developer answers the coding agent.'>
            <Textarea id='pe-instructions' rows={6} maxLength={8000} value={d.instructions} onChange={set('instructions')} />
          </FormRow>
          {err && <p className='text-destructive text-sm'>{err}</p>}
          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose}>Cancel</Button>
            <Gate need='library'><Button type='submit' disabled={save.isPending || !d.name.trim()}>{isNew ? 'Add persona' : 'Save'}</Button></Gate>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
