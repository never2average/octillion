'use client';
// /app Context: one full-page table per tab (company, users, products), the account's institutional memory. Rows are
// the core fields (what the AI client always gets), memory items people add, and on products the coding tasks. The
// floating Remember button and the docked editor add and change rows. Admins edit company and product fields; anyone
// adds memory; a person edits their own user context, admins anyone's (src/app.ts enforces all of it).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { PageTabs } from '@/components/layout/page-tabs';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { appApi } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { Dock, KINDS, RememberFab, TYPE_STYLE, type Kind, type MemoryItem, type MemoryScope } from './memory';
import { ErrorState, LoadingCards, When, fail, useOrgLoad } from './shared';

interface Company { about: string | null; audience: string | null; competitors: string[]; terms: string | null; notes_for_ai: string | null; updated_at: string | null; updated_by: string | null }
interface Person { title: string | null; focus_product: string | null; interests: string | null; answer_style: string | null; notes: string | null; updated_at?: string | null }
interface Ctx { company: Company; person: Person | null; products: { slug: string; name: string }[]; can_manage: boolean; preview: string }
interface UserRow { user_id: string; email: string | null; name: string | null; role: 'admin' | 'member'; active: boolean; me: boolean; context: Person }
interface Product { slug: string; name: string; category: string | null; description: string | null; website_url: string | null; docs_url: string | null;
  aliases: string[]; packages: string[]; domains: string[]; competitors: { name: string; packages?: string[]; domains?: string[] }[] }
interface Scenario { id: number; title: string; prompt: string; expectation: string; active: boolean }

export type ContextSection = 'company' | 'users' | 'products';
const CONTEXT_TABS = [
  { href: '/app/context/company', label: 'Company', icon: Icons.building },
  { href: '/app/context/users', label: 'Users', icon: Icons.teams },
  { href: '/app/context/products', label: 'Products', icon: Icons.product }
];

const csv = (xs?: string[] | null) => (xs ?? []).join(', ');
const parseCsv = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
const STYLES: Record<string, string> = { brief: 'Brief', detailed: 'Detailed, with numbers and quotes', executive: 'For an executive' };

/** A core field: how it shows as a row and how the docked editor edits it. */
interface Field { key: string; label: string; input: 'text' | 'textarea' | 'select'; options?: [string, string][]; placeholder?: string; hint?: string; mono?: boolean }
type Row =
  | { type: 'core'; key: string; field: Field; value: string; display: string; by: string | null; at: string | null; editable: boolean }
  | { type: Kind; key: string; item: MemoryItem }
  | { type: 'task'; key: string; task: Scenario; editable: boolean };
type Editing = { mode: 'field'; field: Field; value: string } | { mode: 'memory'; item?: MemoryItem } | { mode: 'product' } | null;

const FILTERS = [['all', 'All'], ['core', 'Core'], ['fact', 'Facts'], ['decision', 'Decisions'], ['preference', 'Preferences'], ['note', 'Notes'], ['task', 'Tasks']] as const;

/** Context: three pages (company, users, products) under one header with route tabs; each is one table. */
export function ContextPage({ section }: { section: ContextSection }) {
  const { data: d, error, reload } = useOrgLoad(() => appApi<Ctx>('GET', '/context'));
  const shown: ContextSection = section === 'users' && d && !d.person ? 'company' : section;
  return (
    <PageContainer pageTitle='Context' pageDescription='Your institutional memory: what Octillion and your AI client know about your company, its users and each product.'>
      <PageTabs items={d && !d.person ? CONTEXT_TABS.filter((t) => t.label !== 'Users') : CONTEXT_TABS} />
      {error ? <ErrorState error={error} /> : !d ? <LoadingCards count={2} /> : <ContextTable key={shown} d={d} section={shown} onChanged={reload} />}
    </PageContainer>
  );
}

function ContextTable({ d, section, onChanged }: { d: Ctx; section: ContextSection; onChanged: () => void }) {
  // The subject: the company, a person (Users) or a product (Products).
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [subject, setSubject] = useState<string>(section === 'products' ? d.products[0]?.slug ?? '' : '');
  const [product, setProduct] = useState<Product | null>(null);
  const [tasks, setTasks] = useState<Scenario[]>([]);
  const [memories, setMemories] = useState<MemoryItem[] | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>('all');
  const [editing, setEditing] = useState<Editing>(null);
  const [preview, setPreview] = useState(false);
  const scope: MemoryScope = section === 'company' ? 'company' : section === 'users' ? 'user' : 'product';

  const loadUsers = useCallback(() => appApi<{ users: UserRow[] }>('GET', '/context/users').then((r) => {
    setUsers(r.users);
    setSubject((cur) => cur || r.users.find((u) => u.me)?.user_id || r.users[0]?.user_id || '');
  }).catch(fail), []);
  useEffect(() => { if (section === 'users') void loadUsers(); }, [section, loadUsers]);

  const loadProduct = useCallback((slug: string) => {
    if (!slug) { setProduct(null); setTasks([]); return; }
    appApi<{ product: Product; scenarios: Scenario[] }>('GET', `/context/products/${encodeURIComponent(slug)}`)
      .then((r) => { setProduct(r.product); setTasks(r.scenarios ?? []); }).catch(fail);
  }, []);
  useEffect(() => { if (section === 'products') loadProduct(subject); }, [section, subject, loadProduct]);

  const loadMemories = useCallback(() => {
    if (section !== 'company' && !subject) { setMemories([]); return; }
    appApi<{ memories: MemoryItem[] }>('GET', `/context/memories?scope=${scope}&subject=${encodeURIComponent(subject)}`).then((r) => setMemories(r.memories)).catch(fail);
  }, [section, scope, subject]);
  useEffect(() => { setMemories(null); loadMemories(); }, [loadMemories]);

  const user = users?.find((u) => u.user_id === subject);
  const subjectLabel = section === 'company' ? 'Company' : section === 'users' ? (user ? (user.me ? 'You' : user.name || user.email || 'this user') : '') : (product?.name ?? '');

  // ---------- rows ----------
  const core: Row[] = useMemo(() => {
    const row = (field: Field, value: string, display: string, by: string | null, at: string | null, editable: boolean): Row =>
      ({ type: 'core', key: `core-${field.key}`, field, value, display, by, at, editable });
    if (section === 'company') {
      const c = d.company, by = c.updated_by?.replace(/^customer:/, '') ?? null, ro = !d.can_manage;
      return [
        row({ key: 'about', label: 'What the company does', input: 'textarea' }, c.about ?? '', c.about ?? '', by, c.updated_at, !ro),
        row({ key: 'audience', label: 'The developers you build for', input: 'textarea', placeholder: 'e.g. backend engineers at B2B SaaS companies' }, c.audience ?? '', c.audience ?? '', by, c.updated_at, !ro),
        row({ key: 'competitors', label: 'Competitors to always track', input: 'text', hint: 'Comma-separated.', placeholder: 'e.g. Postmark, SendGrid' }, csv(c.competitors), csv(c.competitors), by, c.updated_at, !ro),
        row({ key: 'terms', label: 'Internal product names and terms', input: 'textarea' }, c.terms ?? '', c.terms ?? '', by, c.updated_at, !ro),
        row({ key: 'notes_for_ai', label: 'Anything else your AI client should know', input: 'textarea' }, c.notes_for_ai ?? '', c.notes_for_ai ?? '', by, c.updated_at, !ro)
      ];
    }
    if (section === 'users') {
      if (!user) return [];
      const p = user.context, at = p.updated_at ?? null, products = d.products.map((x) => [x.slug, x.name] as [string, string]);
      return [
        row({ key: 'title', label: 'Role', input: 'text', placeholder: 'e.g. Head of DevRel' }, p.title ?? '', p.title ?? '', null, at, true),
        row({ key: 'focus_product', label: 'Product they work on most', input: 'select', options: [['', 'None'], ...products] }, p.focus_product ?? '', d.products.find((x) => x.slug === p.focus_product)?.name ?? '', null, at, true),
        row({ key: 'interests', label: 'What they care about', input: 'textarea', placeholder: 'e.g. why we lose to BullMQ on queue work' }, p.interests ?? '', p.interests ?? '', null, at, true),
        row({ key: 'answer_style', label: 'How they like answers', input: 'select', options: [['', 'No preference'], ...Object.entries(STYLES)] }, p.answer_style ?? '', p.answer_style ? STYLES[p.answer_style] : '', null, at, true),
        row({ key: 'notes', label: 'Notes', input: 'textarea' }, p.notes ?? '', p.notes ?? '', null, at, true)
      ];
    }
    if (!product) return [];
    const ro = !d.can_manage, comps = (product.competitors ?? []).map((c) => [c.name, csv(c.packages), csv(c.domains)].join(' | ')).join('\n');
    return [
      row({ key: 'name', label: 'Name', input: 'text' }, product.name, product.name, null, null, !ro),
      row({ key: 'category', label: 'Category', input: 'text', placeholder: 'e.g. transactional email API' }, product.category ?? '', product.category ?? '', null, null, !ro),
      row({ key: 'description', label: 'Description', input: 'textarea' }, product.description ?? '', product.description ?? '', null, null, !ro),
      row({ key: 'website_url', label: 'Website', input: 'text', mono: true }, product.website_url ?? '', product.website_url ?? '', null, null, !ro),
      row({ key: 'docs_url', label: 'Docs', input: 'text', mono: true }, product.docs_url ?? '', product.docs_url ?? '', null, null, !ro),
      row({ key: 'aliases', label: 'Other names', input: 'text', hint: 'Comma-separated.' }, csv(product.aliases), csv(product.aliases), null, null, !ro),
      row({ key: 'packages', label: 'Packages agents would install', input: 'text', hint: 'Comma-separated. How Octillion recognises a pick in transcripts.', mono: true, placeholder: 'npm: resend, pypi: resend' }, csv(product.packages), csv(product.packages), null, null, !ro),
      row({ key: 'domains', label: 'Domains', input: 'text', hint: 'Comma-separated.', mono: true }, csv(product.domains), csv(product.domains), null, null, !ro),
      row({ key: 'competitors', label: 'Competitors', input: 'textarea', hint: 'One per line: Name | packages | domains', mono: true, placeholder: 'Postmark | postmark | postmarkapp.com' }, comps, (product.competitors ?? []).map((c) => c.name).join(', '), null, null, !ro)
    ];
  }, [section, d, user, product]);

  const rows: Row[] = useMemo(() => {
    const all: Row[] = [...core, ...(memories ?? []).map((m) => ({ type: m.kind, key: `m-${m.id}`, item: m }) as Row),
      ...(section === 'products' ? tasks.map((t) => ({ type: 'task', key: `t-${t.id}`, task: t, editable: d.can_manage }) as Row) : [])];
    const needle = q.trim().toLowerCase();
    return all.filter((r) => (filter === 'all' || r.type === filter) && (!needle || text(r).toLowerCase().includes(needle)));
  }, [core, memories, tasks, section, d.can_manage, q, filter]);

  // ---------- saving ----------
  const saveField = (field: Field, value: string) => {
    let call: Promise<unknown>;
    if (section === 'company') {
      const c = d.company;
      const body: Record<string, unknown> = { about: c.about ?? '', audience: c.audience ?? '', competitors: c.competitors, terms: c.terms ?? '', notes_for_ai: c.notes_for_ai ?? '' };
      body[field.key] = field.key === 'competitors' ? parseCsv(value) : value;
      call = appApi('PUT', '/context/company', body);
    } else if (section === 'users' && user) {
      const p = user.context;
      const body: Record<string, unknown> = { title: p.title ?? '', focus_product: p.focus_product, interests: p.interests ?? '', answer_style: p.answer_style, notes: p.notes ?? '' };
      body[field.key] = (field.key === 'focus_product' || field.key === 'answer_style') ? (value || null) : value;
      call = appApi('PUT', `/context/users/${encodeURIComponent(user.user_id)}`, body);
    } else if (product) {
      const body: Record<string, unknown> = { name: product.name, category: product.category ?? undefined, description: product.description ?? undefined,
        website_url: product.website_url ?? undefined, docs_url: product.docs_url ?? undefined, aliases: product.aliases, packages: product.packages, domains: product.domains,
        competitors: (product.competitors ?? []).map((c) => ({ name: c.name, packages: c.packages ?? [], domains: c.domains ?? [], aliases: [] })) };
      if (['aliases', 'packages', 'domains'].includes(field.key)) body[field.key] = parseCsv(value);
      else if (field.key === 'competitors') body.competitors = value.split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((a) => a[0])
        .map((a) => ({ name: a[0], packages: parseCsv(a[1] ?? ''), domains: parseCsv(a[2] ?? ''), aliases: [] }));
      else body[field.key] = value.trim() || undefined;
      call = appApi('PUT', `/context/products/${encodeURIComponent(product.slug)}`, body);
    } else return Promise.resolve(false);
    return call.then(() => {
      toast.success(`${field.label} saved`);
      onChanged();
      if (section === 'users') void loadUsers();
      if (section === 'products' && product) loadProduct(product.slug);
      return true;
    }).catch((e) => { fail(e); return false; });
  };
  const saveMemory = (item: MemoryItem | undefined, kind: Kind, body: string) =>
    (item ? appApi('PUT', `/context/memories/${item.id}`, { kind, body }) : appApi('POST', '/context/memories', { scope, subject, kind, body }))
      .then(() => { toast.success(item ? 'Memory updated' : `Remembered for ${subjectLabel}`); loadMemories(); onChanged(); return true; })
      .catch((e) => { fail(e); return false; });
  const removeMemory = (m: MemoryItem) => appApi('DELETE', `/context/memories/${m.id}`).then(() => { toast.success('Removed from memory'); loadMemories(); onChanged(); }).catch(fail);
  const toggleTask = (t: Scenario, active: boolean) => product && appApi('PUT', `/context/products/${encodeURIComponent(product.slug)}/scenarios/${t.id}`, { active })
    .then(() => { toast.success(active ? 'Task back in use' : 'Task retired'); setTasks((xs) => xs.map((x) => (x.id === t.id ? { ...x, active } : x))); }).catch(fail);
  const createProduct = (b: { name: string; website_url: string; docs_url: string; description: string }) =>
    appApi<{ product: Product }>('POST', '/context/products', { name: b.name.trim(), website_url: b.website_url.trim() || undefined, docs_url: b.docs_url.trim() || undefined, description: b.description.trim() || undefined })
      .then((r) => { toast.success('Product created'); onChanged(); if (r?.product?.slug) setSubject(r.product.slug); return true; })
      .catch((e) => { fail(e); return false; });

  const noSubject = section !== 'company' && !subject;
  const loading = memories === null || (section === 'users' && !users) || (section === 'products' && !!subject && !product);
  return (
    <div className='flex min-w-0 flex-col gap-3 pb-24'>
      {/* toolbar */}
      <div className='flex flex-wrap items-center gap-2'>
        {section === 'users' && users && users.length > 1 && (
          <NativeSelect aria-label='User' value={subject} onChange={(e) => setSubject(e.target.value)} className='w-56'>
            {users.map((u) => <NativeSelectOption key={u.user_id} value={u.user_id}>{`${u.name || u.email || 'Unnamed user'}${u.me ? ' (you)' : ''}${u.active ? '' : ' · suspended'}`}</NativeSelectOption>)}
          </NativeSelect>
        )}
        {section === 'products' && d.products.length > 0 && (
          <NativeSelect aria-label='Product' value={subject} onChange={(e) => setSubject(e.target.value)} className='w-56'>
            {d.products.map((p) => <NativeSelectOption key={p.slug} value={p.slug}>{p.name}</NativeSelectOption>)}
          </NativeSelect>
        )}
        <div className='relative min-w-48 flex-1 sm:max-w-xs'>
          <Icons.search className='text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2' />
          <Input type='search' value={q} onChange={(e) => setQ(e.target.value)} placeholder='Search memory' aria-label='Search memory' className='h-9 pl-8' />
        </div>
        <div role='radiogroup' aria-label='Type' className='flex flex-wrap gap-1'>
          {FILTERS.filter(([id]) => id !== 'task' || section === 'products').map(([id, label]) => (
            <button key={id} type='button' role='radio' aria-checked={filter === id} onClick={() => setFilter(id)}
              className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors', filter === id ? 'border-primary bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground')}>
              {label}
            </button>
          ))}
        </div>
        <div className='ml-auto flex gap-2'>
          {section === 'products' && d.can_manage && <Button variant='outline' size='sm' onClick={() => setEditing({ mode: 'product' })}><Icons.add /> New product</Button>}
          <Button variant='ghost' size='sm' onClick={() => setPreview(true)}><Icons.sparkles /> What your AI sees</Button>
        </div>
      </div>

      {/* the table */}
      {noSubject ? (
        <p className='text-muted-foreground border-y py-10 text-center text-sm'>{section === 'products' ? (d.can_manage ? 'No products yet. Create one with New product.' : 'No products yet.') : 'Nobody to show.'}</p>
      ) : loading ? <LoadingCards count={1} /> : (
        <div className='overflow-x-auto border-y'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className='w-28'>Type</TableHead>
                <TableHead>Item</TableHead>
                <TableHead className='hidden w-48 md:table-cell'>Added by</TableHead>
                <TableHead className='hidden w-32 sm:table-cell'>Updated</TableHead>
                <TableHead className='w-24 text-right'><span className='sr-only'>Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && (
                <TableRow><TableCell colSpan={5} className='text-muted-foreground py-10 text-center'>
                  {q || filter !== 'all' ? 'Nothing matches.' : 'Nothing here yet. Press Remember to add the first item.'}
                </TableCell></TableRow>
              )}
              {rows.map((r) => <ItemRow key={r.key} r={r}
                onEdit={() => r.type === 'core' ? r.editable && setEditing({ mode: 'field', field: r.field, value: r.value }) : r.type === 'task' ? undefined : r.item.can_delete && setEditing({ mode: 'memory', item: r.item })}
                onDelete={r.type !== 'core' && r.type !== 'task' && r.item.can_delete ? () => removeMemory(r.item) : undefined}
                onToggle={r.type === 'task' && r.editable ? (v) => toggleTask(r.task, v) : undefined} />)}
            </TableBody>
          </Table>
        </div>
      )}

      {!noSubject && !editing && <RememberFab onClick={() => setEditing({ mode: 'memory' })} />}
      {editing?.mode === 'memory' && <MemoryEditor key={editing.item?.id ?? 'new'} item={editing.item} label={subjectLabel} onClose={() => setEditing(null)} onSave={saveMemory} />}
      {editing?.mode === 'field' && <FieldEditor key={editing.field.key} field={editing.field} value={editing.value} label={subjectLabel} onClose={() => setEditing(null)} onSave={(v) => saveField(editing.field, v)} />}
      {editing?.mode === 'product' && <ProductEditor onClose={() => setEditing(null)} onSave={createProduct} />}

      <Dialog open={preview} onOpenChange={setPreview}>
        <DialogContent className='sm:max-w-2xl'>
          <DialogHeader>
            <DialogTitle>What your AI client is told</DialogTitle>
            <DialogDescription>Added to Octillion&apos;s instructions whenever you connect, as background. Product details are used by research and scoring.</DialogDescription>
          </DialogHeader>
          <pre className='bg-muted max-h-[60vh] overflow-auto rounded-lg p-3 font-mono text-xs whitespace-pre-wrap'>{d.preview ? d.preview.trim() : 'Nothing yet.'}</pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const text = (r: Row) => r.type === 'core' ? `${r.field.label} ${r.display}` : r.type === 'task' ? `${r.task.title} ${r.task.prompt}` : `${r.type} ${r.item.body} ${r.item.created_by ?? ''}`;

function ItemRow({ r, onEdit, onDelete, onToggle }: { r: Row; onEdit: () => void; onDelete?: () => void; onToggle?: (v: boolean) => void }) {
  const editable = r.type === 'core' ? r.editable : r.type === 'task' ? false : r.item.can_delete;
  const label = r.type === 'core' ? 'core' : r.type;
  return (
    <TableRow className={cn('group align-top', editable && 'cursor-pointer')} onClick={editable ? onEdit : undefined}>
      <TableCell className='py-3'><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', TYPE_STYLE[label])}>{label}</span></TableCell>
      <TableCell className='py-3 whitespace-normal'>
        {r.type === 'core' ? (<>
          <p className='text-muted-foreground text-xs font-medium'>{r.field.label}</p>
          {r.display ? <p className={cn('mt-0.5 line-clamp-2 text-sm', r.field.mono && 'font-mono text-xs')}>{r.display}</p> : <p className='text-muted-foreground/60 mt-0.5 text-sm italic'>Not set</p>}
        </>) : r.type === 'task' ? (<>
          <p className='text-sm font-medium'>{r.task.title} {!r.task.active && <span className='text-muted-foreground text-xs'>· retired</span>}</p>
          <p className='text-muted-foreground mt-0.5 line-clamp-2 text-sm'>{r.task.prompt}</p>
        </>) : <p className='line-clamp-3 text-sm whitespace-pre-wrap'>{r.item.body}</p>}
      </TableCell>
      <TableCell className='text-muted-foreground hidden py-3 text-xs md:table-cell'>{r.type === 'core' ? (r.by ?? '—') : r.type === 'task' ? 'Octillion' : (r.item.created_by ?? '—')}</TableCell>
      <TableCell className='text-muted-foreground hidden py-3 text-xs sm:table-cell'>{r.type === 'core' ? (r.at ? <When d={r.at} /> : '—') : r.type === 'task' ? r.task.expectation : <When d={r.item.created_at} />}</TableCell>
      <TableCell className='py-2 text-right' onClick={(e) => e.stopPropagation()}>
        <div className='flex items-center justify-end gap-1'>
          {onToggle && r.type === 'task' && <Switch size='sm' checked={r.task.active} onCheckedChange={(v) => onToggle(Boolean(v))} aria-label='In use' />}
          {editable && <Button variant='ghost' size='icon' className='size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100' aria-label='Edit' onClick={onEdit}><Icons.edit className='size-4' /></Button>}
          {onDelete && <Button variant='ghost' size='icon' className='size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100' aria-label='Remove from memory' onClick={onDelete}><Icons.trash className='size-4' /></Button>}
        </div>
      </TableCell>
    </TableRow>
  );
}

/** Add or change a memory item in the docked window. */
function MemoryEditor({ item, label, onClose, onSave }: { item?: MemoryItem; label: string; onClose: () => void; onSave: (item: MemoryItem | undefined, kind: Kind, body: string) => Promise<boolean> }) {
  const [kind, setKind] = useState<Kind>(item?.kind ?? 'fact');
  const [body, setBody] = useState(item?.body ?? '');
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { area.current?.focus(); }, []);
  const save = (again: boolean) => {
    if (!body.trim()) return;
    setBusy(true);
    void onSave(item, kind, body.trim()).then((ok) => { setBusy(false); if (!ok) return; if (again && !item) { setBody(''); area.current?.focus(); } else onClose(); });
  };
  return (
    <Dock title={`${item ? 'Edit memory' : 'New memory'} · ${label}`} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); save(false); }} className='flex flex-col gap-3 p-4'>
        <div role='radiogroup' aria-label='Kind' className='flex flex-wrap gap-1.5'>
          {KINDS.map((k) => (
            <button key={k.id} type='button' role='radio' aria-checked={kind === k.id} onClick={() => setKind(k.id)}
              className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors', kind === k.id ? 'border-primary bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground')}>
              {k.label}
            </button>
          ))}
        </div>
        <Textarea ref={area} rows={5} maxLength={1000} value={body} onChange={(e) => setBody(e.target.value)} placeholder={KINDS.find((k) => k.id === kind)?.hint}
          aria-label='What to remember' className='resize-none border-0 bg-transparent px-0 shadow-none focus-visible:ring-0'
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(false); } }} />
        <div className='flex items-center gap-2 border-t pt-3'>
          <Button type='submit' disabled={busy || !body.trim()}>{item ? 'Save' : 'Save to memory'}</Button>
          {!item && <Button type='button' variant='ghost' disabled={busy || !body.trim()} onClick={() => save(true)}>Save & add another</Button>}
          <span className='text-muted-foreground ml-auto text-xs tabular-nums'>{body.length}/1000</span>
        </div>
      </form>
    </Dock>
  );
}

/** Edit one core field in the docked window. */
function FieldEditor({ field, value, label, onClose, onSave }: { field: Field; value: string; label: string; onClose: () => void; onSave: (v: string) => Promise<boolean> }) {
  const [v, setV] = useState(value);
  const [busy, setBusy] = useState(false);
  const submit = (e: React.FormEvent) => { e.preventDefault(); setBusy(true); void onSave(v).then((ok) => { setBusy(false); if (ok) onClose(); }); };
  return (
    <Dock title={`${field.label} · ${label}`} onClose={onClose}>
      <form onSubmit={submit} className='flex flex-col gap-3 p-4'>
        {field.input === 'select' ? (
          <NativeSelect aria-label={field.label} value={v} onChange={(e) => setV(e.target.value)} className='w-full'>
            {field.options!.map(([k, l]) => <NativeSelectOption key={k} value={k}>{l}</NativeSelectOption>)}
          </NativeSelect>
        ) : field.input === 'text' ? (
          <Input autoFocus aria-label={field.label} value={v} onChange={(e) => setV(e.target.value)} placeholder={field.placeholder} className={cn(field.mono && 'font-mono text-xs')} />
        ) : (
          <Textarea autoFocus aria-label={field.label} rows={6} maxLength={2000} value={v} onChange={(e) => setV(e.target.value)} placeholder={field.placeholder} className={cn('resize-none', field.mono && 'font-mono text-xs')} />
        )}
        {field.hint && <p className='text-muted-foreground text-xs'>{field.hint}</p>}
        <div className='flex items-center gap-2 border-t pt-3'>
          <Button type='submit' disabled={busy || v === value}>Save</Button>
          <Button type='button' variant='ghost' onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Dock>
  );
}

/** Create a product in the docked window: name and links; research or the table fills in the rest. */
function ProductEditor({ onClose, onSave }: { onClose: () => void; onSave: (b: { name: string; website_url: string; docs_url: string; description: string }) => Promise<boolean> }) {
  const [f, setF] = useState({ name: '', website_url: '', docs_url: '', description: '' });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const submit = (e: React.FormEvent) => { e.preventDefault(); setBusy(true); void onSave(f).then((ok) => { setBusy(false); if (ok) onClose(); }); };
  return (
    <Dock title='New product' onClose={onClose}>
      <form onSubmit={submit} className='flex flex-col gap-3 p-4'>
        <Input autoFocus required maxLength={120} aria-label='Name' placeholder='Name' value={f.name} onChange={set('name')} />
        <Input type='url' aria-label='Website' placeholder='Website' value={f.website_url} onChange={set('website_url')} />
        <Input type='url' aria-label='Docs' placeholder='Docs' value={f.docs_url} onChange={set('docs_url')} />
        <Textarea rows={3} aria-label='Description' placeholder='What it is, in a sentence or two' value={f.description} onChange={set('description')} className='resize-none' />
        <p className='text-muted-foreground text-xs'>Fastest: ask your AI client to onboard it, and Octillion researches packages, domains and competitors.</p>
        <div className='flex items-center gap-2 border-t pt-3'>
          <Button type='submit' disabled={busy || !f.name.trim()}>Create product</Button>
          <Button type='button' variant='ghost' onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Dock>
  );
}
