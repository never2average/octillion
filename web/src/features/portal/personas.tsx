'use client';
// /app/personas: the developers this account targets, and only the account's own (private: save_personas in the AI
// client, or New persona and Import here; src/private.ts). The ones onboarding picked for the product show by name
// only (no badge; the library itself is never listed). Members add, edit and publish their own to Octillion's library
// (the Published column; publish.tsx), viewers read, owners also delete. A save here counts for the "Bring your own
// developer personas" journey the same as the tool.
import { useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { ActionsMenu, RecordView, type RecordCol, type RowAction } from '@/components/layout/record-view';
import { DetailMeta, DetailTable, DetailTabs, KeyValueTable, LongText } from '@/components/layout/detail';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { appApi } from '@/lib/api-client';
import { parseCsv } from '@/lib/csv';
import { Chips, Mono, StatusBadge } from '@/features/admin/ui';
import { CopyButton, ErrorState, FormRow, copy, fail, useOrgLoad } from './shared';
import { PUBLISHED_OPTIONS, PublishDialog, PublishedBadge, PublishedLine, publishedLabel, withdrawPublication, type Publication } from './publish';
import { Allowed, useAccountRole } from './role';
import { companySize } from '@/lib/octillion-format';

type Attributes = { role?: string | null; experience_years?: number | null; company_size?: string | null; stack?: string[]; constraints?: string[]; tone?: string | null; [k: string]: unknown };
interface ApiPersona { slug: string; name: string; summary: string | null; instructions?: string | null; attributes: Attributes; environment: { editor?: string; tools?: string[] } | null; source?: string; active?: boolean; curated?: boolean;
  publishable?: boolean; publication?: Publication | null }
export interface Persona extends ApiPersona { curated: boolean; active: boolean; origin: 'Yours' | 'Written by research' | typeof PICKED }
/** What save_personas takes (POST /personas). */
export interface PersonaInput { slug?: string; name: string; summary?: string; instructions?: string; attributes?: Record<string, unknown>; environment?: unknown; active?: boolean }
interface Draft { slug?: string; name: string; summary: string; role: string; experience_years: string; company_size: string; stack: string; constraints: string; tone: string; instructions: string }

const PICKED = 'Picked by onboarding';
const NA = <span className='text-muted-foreground'>—</span>;
const SHOWN = new Set(['role', 'experience_years', 'company_size', 'stack', 'constraints', 'tone']);
const text = (v: unknown) => (v == null || v === '' ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));
const years = (p: Persona) => (typeof p.attributes.experience_years === 'number' ? p.attributes.experience_years : null);
const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
const editable = (p: Persona) => !p.curated && p.source === 'custom';
const runPrompt = (p: Persona) => `Run a simulation for my product with the developer persona ${p.slug} (${p.name}).`;

const toDraft = (p: Persona, copyOf = false): Draft => ({
  slug: copyOf ? undefined : p.slug, name: copyOf ? p.name.slice(0, 80) : p.name, summary: p.summary ?? '', role: p.attributes.role ?? '',
  experience_years: years(p) == null ? '' : String(years(p)), company_size: p.attributes.company_size ?? '', stack: list(p.attributes.stack).join(', '),
  constraints: list(p.attributes.constraints).join('\n'), tone: p.attributes.tone ?? '', instructions: p.instructions ?? ''
});
const blank = (): Draft => ({ name: '', summary: '', role: '', experience_years: '', company_size: '', stack: '', constraints: '', tone: '', instructions: '' });

export function PersonasPage() {
  const { data, error, reload } = useOrgLoad(() => appApi<{ personas: ApiPersona[]; publish?: { credit_usd: number } }>('GET', '/personas'));
  const { lock } = useAccountRole();
  const [draft, setDraft] = useState<{ d: Draft; from?: Persona } | null>(null);
  const [importing, setImporting] = useState(false);
  const [publishing, setPublishing] = useState<Persona | null>(null);

  const rows = useMemo<Persona[]>(() => (data?.personas ?? []).map((p) => ({
    ...p, attributes: p.attributes ?? {}, curated: !!p.curated, active: p.active !== false,
    origin: (p.curated ? PICKED : p.source === 'custom' ? 'Yours' : 'Written by research') as Persona['origin']
  })), [data]);

  const setActive = (p: Persona, active: boolean) => appApi('PATCH', `/personas/${encodeURIComponent(p.slug)}`, { active })
    .then(() => { toast.success(active ? 'Persona turned on' : 'Persona turned off'); return reload(); }).catch(fail);
  const remove = (p: Persona) => {
    if (!window.confirm(`Delete ${p.name}? Past runs keep their transcripts.`)) return;
    appApi('DELETE', `/personas/${encodeURIComponent(p.slug)}`).then(() => { toast.success('Persona deleted'); return reload(); }).catch(fail);
  };

  const cols: RecordCol<Persona>[] = [
    { key: 'name', label: 'Persona', className: 'min-w-56', title: true, keep: true, peek: false, type: 'text', value: (p) => p.name, render: (p) => (
      <span className='flex flex-col gap-1.5'>
        <span className='leading-none font-medium'>{p.name}</span>
        {p.summary && <span className='text-muted-foreground line-clamp-1 text-xs leading-snug'>{p.summary}</span>}
      </span>
    ) },
    { key: 'role', label: 'Role', className: 'w-48', type: 'select', value: (p) => p.attributes.role ?? null, render: (p) => (
      <span className='flex flex-col gap-1.5'>
        <span className='leading-none'>{p.attributes.role ?? NA}</span>
        {years(p) != null && <span className='text-muted-foreground text-xs leading-none tabular-nums'>{years(p)} yrs</span>}
      </span>
    ) },
    { key: 'experience', label: 'Experience', className: 'w-24 text-right', hidden: true, type: 'number', value: years,
      render: (p) => (years(p) == null ? NA : <span className='tabular-nums'>{years(p)} yrs</span>) },
    { key: 'company_size', label: 'Company size', className: 'w-40', hidden: true, type: 'select', value: (p) => companySize(p.attributes.company_size), render: (p) => companySize(p.attributes.company_size) },
    { key: 'stack', label: 'Stack', className: 'min-w-48', type: 'text', value: (p) => list(p.attributes.stack).join(', '), render: (p) => <Chips items={list(p.attributes.stack)} max={3} oneLine /> },
    { key: 'origin', label: 'Origin', className: 'w-40', type: 'select', value: (p) => p.origin,
      options: [{ value: 'Yours' }, { value: 'Written by research' }, { value: PICKED }], render: (p) => <span className='text-muted-foreground text-sm'>{p.origin}</span> },
    { key: 'published', label: 'Published', className: 'w-28', hidden: true, type: 'select', value: (p) => publishedLabel(p.publication), options: PUBLISHED_OPTIONS,
      render: (p) => <PublishedBadge p={p.publication} /> },
    { key: 'slug', label: 'Id', hidden: true, type: 'text', value: (p) => p.slug, render: (p) => <Mono>{p.slug}</Mono> },
    { key: 'active', label: 'Status', name: 'Active', className: 'w-24', keep: true, type: 'boolean', value: (p) => p.active,
      render: (p) => (
        <span className='flex flex-col items-start gap-1.5'>
          <StatusBadge tone={p.active ? 'ok' : 'neutral'}>{p.active ? 'on' : 'off'}</StatusBadge>
          {p.publication && <span className='text-muted-foreground text-xs leading-none'>{publishedLabel(p.publication)}</span>}
        </span>
      ) }
  ];

  const actions = (p: Persona): RowAction[] => [
    ...(editable(p) ? [lock({ label: 'Edit', icon: <Icons.edit />, onSelect: () => setDraft({ d: toDraft(p), from: p }) }, 'edit')] : []),
    ...(p.curated ? [] : [lock({ label: 'Duplicate', icon: <Icons.add />, onSelect: () => setDraft({ d: toDraft(p, true) }) }, 'edit')]),
    { label: 'Copy id', icon: <Icons.page />, onSelect: () => copy(p.slug) },
    ...(p.publishable && p.publication?.status === 'submitted'
      ? [lock({ label: 'Withdraw from review', icon: <Icons.xCircle />, separator: true, onSelect: () => void withdrawPublication(p.publication!, reload) }, 'edit')]
      : p.publishable ? [lock({ label: 'Publish to Octillion’s library', icon: <Icons.share />, separator: true, onSelect: () => setPublishing(p) }, 'edit')] : []),
    ...(editable(p) ? [
      lock({ label: p.active ? 'Turn off' : 'Turn on', icon: p.active ? <Icons.eyeOff /> : <Icons.check />, separator: true, onSelect: () => void setActive(p, !p.active) }, 'edit'),
      lock({ label: 'Delete', icon: <Icons.trash />, destructive: true, onSelect: () => remove(p) }, 'manage')
    ] : [])
  ];

  // One button plus RecordView's own ▾ menu (Import, then the export items).
  const primary = <Allowed need='edit'><Button onClick={() => setDraft({ d: blank() })}><Icons.add /> New persona</Button></Allowed>;
  const primaryMenu: RowAction[] = [lock({ label: 'Import', icon: <Icons.upload />, onSelect: () => setImporting(true) }, 'edit')];

  return (
    <PageContainer>
      {error ? <ErrorState error={error} /> : (
        <RecordView<Persona>
          id='app-personas' noun='personas' exportName='personas'
          rows={rows} rowKey={(p) => p.slug} cols={cols} actions={actions} loading={!data}
          defaultSort={[{ key: 'origin', dir: 'asc' }, { key: 'name', dir: 'asc' }]}
          searchText={(p) => `${p.name} ${p.summary ?? ''} ${p.slug} ${p.attributes.role ?? ''} ${list(p.attributes.stack).join(' ')} ${p.origin}`}
          searchPlaceholder='Search personas by name, summary or stack'
          primary={primary} primaryMenu={primaryMenu}
          empty='No personas yet. Onboarding picks personas for your product; add your own, import a list, or ask your AI client to save them.'
          detailTitle={() => 'Persona'}
          detail={(p) => <PersonaBody p={p} actions={(<>
            {editable(p) && <Allowed need='edit'><Button size='sm' variant='outline' onClick={() => setDraft({ d: toDraft(p), from: p })}><Icons.edit /> Edit</Button></Allowed>}
            <ActionsMenu items={actions(p).filter((a) => a.label !== 'Edit')} />
          </>)} />}
        />
      )}
      {draft && <PersonaEditor draft={draft.d} from={draft.from} onClose={() => setDraft(null)} onSaved={() => { setDraft(null); void reload(); }} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} onDone={() => { setImporting(false); void reload(); }} />}
      {publishing && <PublishDialog kind='persona' title={publishing.name} path={`/personas/${encodeURIComponent(publishing.slug)}/publish`} creditUsd={data?.publish?.credit_usd}
        onClose={() => setPublishing(null)} onDone={() => { setPublishing(null); void reload(); }} />}
    </PageContainer>
  );
}

/** The persona peek: the card (status, origin, id, the key facts, Edit and the ⋯ menu), then tabs: its profile, its
 *  constraints and how to use it in a run. One onboarding picked: its name, id and how to use it. */
function PersonaBody({ p, actions }: { p: Persona; actions: ReactNode }) {
  const a = p.attributes;
  const status = <StatusBadge tone={p.active ? 'ok' : 'neutral'}>{p.active ? 'on' : 'off'}</StatusBadge>;
  const useIt = { id: 'use', label: 'Use it', content: <RunIt p={p} /> };
  if (p.curated) return (
    <div className='flex flex-col gap-4'>
      <DetailMeta title={p.name} badges={status} actions={actions}
        subtitle={<>Onboarding picked this developer persona for your product. Its details aren&apos;t shown, and it can&apos;t be published.</>}
        facts={[
          { label: 'Id', value: <Mono>{p.slug}</Mono> },
          { label: 'Origin', value: p.origin }
        ]} />
      <DetailTabs resetKey={p.slug} tabs={[useIt]} />
    </div>
  );
  const other = Object.entries(a).filter(([k, v]) => !SHOWN.has(k) && text(v) != null).map(([k, v]) => ({ k, v: text(v)! }));
  const constraints = list(a.constraints).map((c, i) => ({ i, c }));
  return (
    <div className='flex flex-col gap-4'>
      <DetailMeta title={p.name} badges={status} actions={actions}
        subtitle={p.origin === 'Yours' ? 'Private to your account' : 'Written by research for your account'}
        facts={[
          { label: 'Id', value: <Mono>{p.slug}</Mono> },
          { label: 'Role', value: a.role ?? NA },
          { label: 'Experience', value: years(p) == null ? NA : `${years(p)} years` },
          { label: 'Company size', value: companySize(a.company_size) },
          { label: 'Published', value: <PublishedLine p={p.publication} />, hidden: !p.publishable }
        ]} />
      <DetailTabs resetKey={p.slug} tabs={[
        { id: 'profile', label: 'Profile', content: (
          <KeyValueTable rows={[
            { label: 'Summary', value: p.summary ? <LongText>{p.summary}</LongText> : NA },
            { label: 'Stack', value: <Chips items={list(a.stack)} /> },
            { label: 'Tone', value: a.tone ?? NA },
            { label: 'Editor', value: p.environment?.editor, hidden: !p.environment?.editor },
            { label: 'Tools', value: <Chips items={p.environment?.tools ?? []} />, hidden: !p.environment?.tools?.length },
            ...other.map((o) => ({ label: o.k, value: <span className='break-all'>{o.v}</span> })),
            { label: 'Instructions', value: p.instructions ? <LongText>{p.instructions}</LongText> : <span className='text-muted-foreground'>None.</span> }
          ]} />
        ) },
        { id: 'constraints', label: 'Constraints', count: constraints.length, content: (
          <DetailTable rows={constraints} rowKey={(x) => String(x.i)} noun='constraints' empty='No constraints.' cols={[
            { key: 'n', label: '#', type: 'number', value: (x) => x.i + 1, render: (x) => <span className='text-muted-foreground tabular-nums'>{x.i + 1}</span>, className: 'w-12' },
            { key: 'c', label: 'Constraint', type: 'text', value: (x) => x.c, render: (x) => x.c, className: 'whitespace-normal leading-snug' }
          ]} />
        ) },
        useIt
      ]} />
    </div>
  );
}

/** How to use the persona in a run: the prompt to paste, with a copy button. */
function RunIt({ p }: { p: Persona }) {
  return (
    <KeyValueTable rows={[
      { label: 'Prompt', value: (
        <div className='flex items-start gap-2'>
          <div className='min-w-0 flex-1 select-all'><LongText mono>{runPrompt(p)}</LongText></div>
          <CopyButton text={runPrompt(p)} label='Copy prompt' />
        </div>
      ) }
    ]} />
  );
}

/** The form's fields as save_personas input; `keep` carries attributes the form does not show (an import's extras). */
function toInput(d: Draft, keep: Attributes = {}): PersonaInput {
  const attributes: Record<string, unknown> = { ...keep };
  for (const k of SHOWN) delete attributes[k];
  if (d.role.trim()) attributes.role = d.role.trim();
  if (d.experience_years.trim() !== '' && Number.isFinite(Number(d.experience_years))) attributes.experience_years = Number(d.experience_years);
  if (d.company_size.trim()) attributes.company_size = d.company_size.trim();
  const stack = d.stack.split(',').map((s) => s.trim()).filter(Boolean), constraints = d.constraints.split('\n').map((s) => s.trim()).filter(Boolean);
  if (stack.length) attributes.stack = stack;
  if (constraints.length) attributes.constraints = constraints;
  if (d.tone.trim()) attributes.tone = d.tone.trim();
  return { ...(d.slug ? { slug: d.slug } : {}), name: d.name.trim(), summary: d.summary.trim(), instructions: d.instructions.trim(), attributes };
}

function PersonaEditor({ draft, from, onClose, onSaved }: { draft: Draft; from?: Persona; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<Draft>(draft);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const isNew = !d.slug;
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setD({ ...d, [k]: e.target.value });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    const body = toInput(d, from && !from.curated ? from.attributes : {});
    (isNew ? appApi('POST', '/personas', { personas: [body] }) : appApi('PATCH', `/personas/${encodeURIComponent(d.slug!)}`, body))
      .then(() => { toast.success(isNew ? 'Persona added' : 'Persona saved'); onSaved(); })
      .catch((x: Error) => setErr(x.message)).finally(() => setBusy(false));
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-xl'>
        <form onSubmit={submit} className='grid gap-4'>
          <DialogHeader>
            <DialogTitle>{isNew ? 'New persona' : `Edit ${from?.name ?? d.name}`}</DialogTitle>
            <DialogDescription>A developer you target. Private to your account: no other account can see or use it.</DialogDescription>
          </DialogHeader>
          <FormRow htmlFor='pp-name' label='Name'><Input id='pp-name' required maxLength={80} value={d.name} onChange={set('name')} placeholder='e.g. Flutter lead at a startup' /></FormRow>
          <FormRow htmlFor='pp-summary' label='Summary' hint='Who they are, in a sentence or two.'>
            <Textarea id='pp-summary' rows={3} maxLength={600} value={d.summary} onChange={set('summary')} />
          </FormRow>
          <FormRow htmlFor='pp-role' label='Role'><Input id='pp-role' maxLength={120} placeholder='e.g. Mobile lead' value={d.role} onChange={set('role')} /></FormRow>
          <FormRow htmlFor='pp-exp' label='Experience (years)'>
            <Input id='pp-exp' type='number' min={0} max={70} value={d.experience_years} onChange={set('experience_years')} className='w-32' />
          </FormRow>
          <FormRow htmlFor='pp-size' label='Company size'><Input id='pp-size' maxLength={80} placeholder='e.g. <20, 100-499 or 10,000+' value={d.company_size} onChange={set('company_size')} /></FormRow>
          <FormRow htmlFor='pp-stack' label='Stack' hint='Languages, frameworks and tools, separated by commas.'>
            <Input id='pp-stack' value={d.stack} onChange={set('stack')} placeholder='Dart, Flutter, Firebase' />
          </FormRow>
          <FormRow htmlFor='pp-constraints' label='Constraints' hint='One per line, e.g. "Must run on-prem".'>
            <Textarea id='pp-constraints' rows={3} value={d.constraints} onChange={set('constraints')} />
          </FormRow>
          <FormRow htmlFor='pp-tone' label='Tone'><Input id='pp-tone' maxLength={80} placeholder='e.g. Brief and practical' value={d.tone} onChange={set('tone')} /></FormRow>
          <FormRow htmlFor='pp-instructions' label='Instructions' hint='How this developer answers the coding agent’s questions.'>
            <Textarea id='pp-instructions' rows={5} maxLength={1500} value={d.instructions} onChange={set('instructions')} />
          </FormRow>
          {err && <p className='text-destructive text-sm'>{err}</p>}
          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose}>Cancel</Button>
            <Allowed need='edit'><Button type='submit' disabled={busy || !d.name.trim()}>{isNew ? 'Add persona' : 'Save'}</Button></Allowed>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- import ----------

const LIST_KEYS = new Set(['stack', 'constraints', 'tools']);
const splitList = (v: string, sep: RegExp) => v.split(sep).map((s) => s.trim()).filter(Boolean);

/**
 * Pasted personas in the shape save_personas takes: JSON (a list, or { personas: [...] }), CSV with a name column
 * (summary, instructions, role, experience_years, company_size, stack, constraints, tone, editor, tools), or a plain
 * list, one per line ("Name: summary" or just a name).
 */
export function parsePersonas(raw: string): PersonaInput[] {
  const t = raw.replace(/^﻿/, '').trim();
  if (!t) return [];
  if (t.startsWith('[') || t.startsWith('{')) {
    const data = JSON.parse(t);
    const items = Array.isArray(data) ? data : Array.isArray(data?.personas) ? data.personas : [data];
    return items.map((x: any) => {
      if (typeof x === 'string') return { name: x };
      const { name, summary, instructions, attributes, environment, slug, active, ...rest } = x ?? {};
      const extra = Object.fromEntries(Object.entries(rest).filter(([k]) => SHOWN.has(k)));
      return { ...(slug ? { slug } : {}), name: String(name ?? ''), ...(summary != null ? { summary: String(summary) } : {}), ...(instructions != null ? { instructions: String(instructions) } : {}),
        ...(attributes || Object.keys(extra).length ? { attributes: { ...extra, ...(attributes ?? {}) } } : {}), ...(environment ? { environment } : {}), ...(active != null ? { active } : {}) };
    });
  }
  const rows = parseCsv(t);
  const head = (rows[0] ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  if (rows.length > 1 && head.includes('name')) {
    return rows.slice(1).filter((r) => r.some((c) => c.trim())).map((r) => {
      const get = (k: string) => { const i = head.indexOf(k); return i < 0 ? '' : (r[i] ?? '').trim(); };
      const attributes: Record<string, unknown> = {};
      for (const k of SHOWN) {
        const v = get(k);
        if (!v) continue;
        attributes[k] = k === 'experience_years' ? Number(v) : LIST_KEYS.has(k) ? splitList(v, k === 'constraints' ? /[;\n]/ : /[;,]/) : v;
      }
      const editor = get('editor'), tools = get('tools');
      return { name: get('name'), ...(get('summary') ? { summary: get('summary') } : {}), ...(get('instructions') ? { instructions: get('instructions') } : {}),
        ...(Object.keys(attributes).length ? { attributes } : {}), ...(editor ? { environment: { editor, ...(tools ? { tools: splitList(tools, /[;,]/) } : {}) } } : {}) };
    });
  }
  return t.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean).map((l) => {
    const m = l.match(/^(.{1,80}?)\s*(?::|\s[-–—]\s)\s*(.+)$/);
    return m ? { name: m[1].trim(), summary: m[2].trim() } : { name: l };
  });
}

const IMPORT_EXAMPLE = `name,role,experience_years,company_size,stack,summary
Flutter lead,Mobile lead,8,50 to 199,"Dart, Flutter, Firebase",Ships a field-service app offline-first
Platform engineer,Back-end,12,1000+,"Go, Kubernetes, Postgres",Owns the internal developer platform`;

function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [raw, setRaw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => { try { return { items: parsePersonas(raw), error: '' }; } catch (e) { return { items: [], error: (e as Error).message }; } }, [raw]);
  const go = () => {
    setErr(''); setBusy(true);
    appApi<{ saved: string[] }>('POST', '/personas', { personas: parsed.items })
      .then((r) => { toast.success(`Imported ${r.saved.length} persona${r.saved.length === 1 ? '' : 's'}`); onDone(); })
      .catch((x: Error) => setErr(x.message)).finally(() => setBusy(false));
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>Import personas</DialogTitle>
          <DialogDescription>
            Paste JSON (the same shape your AI client sends to save_personas), CSV with a name column, or a list with one persona per line
            (“Name: summary”). Up to 20 at a time; each is checked before anything is saved.
          </DialogDescription>
        </DialogHeader>
        <Textarea rows={10} value={raw} onChange={(e) => setRaw(e.target.value)} placeholder={IMPORT_EXAMPLE} aria-label='Personas to import' className='font-mono text-xs' />
        <p className='text-muted-foreground text-sm'>
          {parsed.error ? <span className='text-destructive'>Not valid JSON: {parsed.error}</span>
            : parsed.items.length ? `${parsed.items.length} persona${parsed.items.length === 1 ? '' : 's'} ready: ${parsed.items.slice(0, 4).map((p) => p.name || '(no name)').join(', ')}${parsed.items.length > 4 ? ', …' : ''}`
              : 'Nothing to import yet.'}
        </p>
        {err && <p className='text-destructive text-sm'>{err}</p>}
        <DialogFooter>
          <Button type='button' variant='outline' onClick={onClose}>Cancel</Button>
          <Allowed need='edit'><Button disabled={busy || !parsed.items.length} onClick={go}>Import</Button></Allowed>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
