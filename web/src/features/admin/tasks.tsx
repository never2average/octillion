'use client';
// /admin/tasks: the shared task library (curated real-world tasks that become customers' scenarios). 7k+ rows, so it is
// searched, filtered and paged on the server (GET /tasks); RecordView pages in the browser, so this is the same layout
// (toolbar, outlined table that scrolls inside, ⋯ menus, bulk bar, side peek) over one server page at a time. An edit
// (or turning a task on or off) makes the row the admin's: the vault sync leaves it alone from then on (src/vault.ts).
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import PageContainer from '@/components/layout/page-container';
import { ActionsMenu, Field, type RowAction } from '@/components/layout/record-view';
import { TablePager, type Paged } from '@/components/layout/table-pager';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { useDebounce } from '@/hooks/use-debounce';
import { adminApi } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { List } from './account-peek';
import { post, useAdmin, useAdminAction } from './lib';
import { Chips, ErrorBox, FormRow, Mono, StatusBadge, When } from './ui';

export interface Task {
  id: number; slug: string; external_id: string | null; title: string; prompt: string; repo_url: string | null; language: string | null;
  category: string | null; tags: string[]; platform: string | null; active: boolean; source: 'vault' | 'admin';
  synced_at: string; edited_at: string | null; edited_by: string | null; attributes: Record<string, unknown>;
}
interface Facet { value: string; n: number }
interface TaskPage { tasks: Task[]; total: number; limit: number; offset: number; all: number; active: number; languages: Facet[]; categories: Facet[] }
interface Draft { id?: number; title: string; prompt: string; language: string; category: string; tags: string; repo_url: string }

const NA = <span className='text-muted-foreground'>—</span>;
const META = 'text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-none';
const PROMPT = 'font-mono text-xs leading-relaxed whitespace-pre-wrap border-l-2 pl-3';
const Dot = () => <span className='text-muted-foreground/60'>·</span>;
const Label = ({ children }: { children: ReactNode }) => <div className='text-muted-foreground mb-2 text-xs font-medium leading-none'>{children}</div>;
/** github.com/owner/repo: the host and path, without the scheme. */
const repoName = (u: string) => { try { const x = new URL(u); return `${x.host}${x.pathname.replace(/\/$/, '')}`; } catch { return u.replace(/^https?:\/\//, ''); } };
const originOf = (t: Task) => (t.source === 'admin' ? 'Written here' : t.edited_at ? 'Vault, edited here' : 'Vault');
const text = (v: unknown) => (v == null || v === '' ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));
const toDraft = (t: Task): Draft => ({ id: t.id, title: t.title, prompt: t.prompt, language: t.language ?? '', category: t.category ?? '', tags: t.tags.join(', '), repo_url: t.repo_url ?? '' });
const blank = (): Draft => ({ title: '', prompt: '', language: '', category: '', tags: '', repo_url: '' });

export function AdminTasks() {
  const [q, setQ] = useState('');
  const [f, setF] = useState({ language: '', category: '', active: '', has_repo: '' });
  const [size, setSize] = useState(25);
  const [open, setOpen] = useState<Task | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const query = useDebounce(q.trim(), 300);
  // The page and the selection belong to one search + filters: any change starts again at page 1 with nothing selected.
  const view = JSON.stringify([query, f, size]);
  const [paging, setPaging] = useState({ view, page: 1 });
  const page = paging.view === view ? paging.page : 1;
  const setPage = (p: number) => setPaging({ view, page: p });
  const [selection, setSelection] = useState<{ view: string; rows: Map<number, Task> }>({ view, rows: new Map() });
  const sel = selection.view === view ? selection.rows : new Map<number, Task>();
  const setSel = (fn: Map<number, Task> | ((s: Map<number, Task>) => Map<number, Task>)) =>
    setSelection({ view, rows: typeof fn === 'function' ? fn(sel) : fn });
  const params = new URLSearchParams({ ...(query ? { q: query } : {}), ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)),
    limit: String(size), offset: String((page - 1) * size) });
  const { data, error, isLoading, isFetching } = useAdmin<TaskPage>(`/tasks?${params}`, { keep: true });
  const setActive = useAdminAction((v: { ids: number[]; active: boolean }) => post<{ updated: number }>('/tasks/active', v),
    { success: (r) => `${r.updated} task${r.updated === 1 ? '' : 's'} updated` });

  const rows = useMemo(() => data?.tasks ?? [], [data]);
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / size));
  const pager: Paged<Task> = { rows, page, pages, size, total, setPage, setSize };
  // The peek shows the row as loaded on the current page, so an edit or toggle is reflected there too.
  const current = open ? rows.find((t) => t.id === open.id) ?? open : null;
  const narrowed = !!query || Object.values(f).some(Boolean);

  // ↑ ↓ / j k walk this page's rows; Escape closes the peek (same keys as RecordView).
  useEffect(() => {
    if (!current) return;
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('input,textarea,select') || document.querySelector('[role=dialog]') || e.metaKey || e.ctrlKey || e.altKey) return;
      const i = rows.findIndex((r) => r.id === current.id);
      if (e.key === 'Escape') setOpen(null);
      else if ((e.key === 'j' || e.key === 'ArrowDown') && rows[i + 1]) { e.preventDefault(); setOpen(rows[i + 1]); }
      else if ((e.key === 'k' || e.key === 'ArrowUp') && i > 0) { e.preventDefault(); setOpen(rows[i - 1]); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [current, rows]);

  const actions = (t: Task): RowAction[] => [
    { label: 'Edit', icon: <Icons.edit />, onSelect: () => setDraft(toDraft(t)) },
    { label: t.active ? 'Deactivate' : 'Activate', icon: t.active ? <Icons.eyeOff /> : <Icons.check />, separator: true,
      onSelect: () => setActive.mutate({ ids: [t.id], active: !t.active }) }
  ];
  const selRows = [...sel.values()];
  const toOn = selRows.filter((t) => !t.active), toOff = selRows.filter((t) => t.active);
  const bulkGo = (list: Task[], active: boolean) => setActive.mutate({ ids: list.map((t) => t.id), active }, { onSuccess: () => setSel(new Map()) });
  const toggle = (list: Task[], on: boolean) => setSel((s) => { const n = new Map(s); list.forEach((t) => (on ? n.set(t.id, t) : n.delete(t.id))); return n; });
  const allOnPage = rows.length > 0 && rows.every((t) => sel.has(t.id)), someOnPage = rows.some((t) => sel.has(t.id));
  const facet = (list: Facet[] | undefined) => (list ?? []).map((x) => <NativeSelectOption key={x.value} value={x.value}>{x.value} ({x.n})</NativeSelectOption>);
  const narrow = !!current;

  return (
    <PageContainer>
      <ErrorBox error={error} />
      <div className='flex h-[calc(100svh-5.5rem)] min-h-[24rem] min-w-0 flex-col gap-3'>
        <div className='flex flex-wrap items-center gap-2'>
          <div className='relative min-w-48 flex-1'>
            <Icons.search className='text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2' />
            <Input type='search' value={q} onChange={(e) => setQ(e.target.value)} placeholder='Search tasks by title, prompt, tag or repository' aria-label='Search tasks' className='h-9 pl-8' />
          </div>
          <NativeSelect aria-label='Language' value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })}>
            <NativeSelectOption value=''>All languages</NativeSelectOption>{facet(data?.languages)}
          </NativeSelect>
          <NativeSelect aria-label='Category' value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            <NativeSelectOption value=''>All categories</NativeSelectOption>{facet(data?.categories)}
          </NativeSelect>
          <NativeSelect aria-label='Status' value={f.active} onChange={(e) => setF({ ...f, active: e.target.value })}>
            <NativeSelectOption value=''>Active and inactive</NativeSelectOption>
            <NativeSelectOption value='true'>Active</NativeSelectOption>
            <NativeSelectOption value='false'>Inactive</NativeSelectOption>
          </NativeSelect>
          <NativeSelect aria-label='Repository' value={f.has_repo} onChange={(e) => setF({ ...f, has_repo: e.target.value })}>
            <NativeSelectOption value=''>With or without a repo</NativeSelectOption>
            <NativeSelectOption value='true'>Has a repo</NativeSelectOption>
            <NativeSelectOption value='false'>No repo (starter template)</NativeSelectOption>
          </NativeSelect>
          <Button onClick={() => setDraft(blank())}><Icons.add /> New task</Button>
        </div>

        {selRows.length > 0 ? (
          <div className='flex min-h-8 shrink-0 flex-wrap items-center gap-1 text-sm leading-none'>
            <span className='mr-2 font-medium tabular-nums'>{selRows.length} selected</span>
            {toOn.length > 0 && <Button variant='ghost' size='sm' onClick={() => bulkGo(toOn, true)}><Icons.check /> Activate {toOn.length}</Button>}
            {toOff.length > 0 && <Button variant='ghost' size='sm' onClick={() => bulkGo(toOff, false)}><Icons.eyeOff /> Deactivate {toOff.length}</Button>}
            <Button variant='ghost' size='sm' className='text-muted-foreground ml-auto' onClick={() => setSel(new Map())}>Clear</Button>
          </div>
        ) : narrowed && (
          <div className='flex min-h-8 shrink-0 items-center gap-2 text-sm leading-none'>
            <span className='text-muted-foreground tabular-nums'>{total} of {data?.all ?? '…'} tasks match</span>
            <Button variant='ghost' size='xs' className='text-muted-foreground ml-auto' onClick={() => { setQ(''); setF({ language: '', category: '', active: '', has_repo: '' }); }}>Reset</Button>
          </div>
        )}

        <div className='flex min-h-0 flex-1 gap-4'>
          <div className={cn('flex min-h-0 min-w-0 flex-col border-y', current ? 'hidden lg:flex lg:w-[40%] lg:shrink-0' : 'w-full')}>
            <div className={cn('min-h-0 flex-1 overflow-auto', isFetching && !isLoading && 'opacity-70')}>
              <Table className={cn(narrow && 'table-fixed')}>
                <TableHeader className='bg-background sticky top-0 z-10 shadow-[0_1px_0_var(--border)]'>
                  <TableRow>
                    <TableHead className='w-8'>
                      <Checkbox aria-label='Select all on this page' checked={allOnPage} indeterminate={!allOnPage && someOnPage} onCheckedChange={(on) => toggle(rows, !!on)} />
                    </TableHead>
                    <TableHead className='min-w-72 px-3'>Task</TableHead>
                    {!narrow && (<>
                      <TableHead className='w-28 px-3'>Language</TableHead>
                      <TableHead className='w-36 px-3'>Category</TableHead>
                      <TableHead className='w-56 px-3'>Repository</TableHead>
                      <TableHead className='min-w-40 px-3'>Tags</TableHead>
                    </>)}
                    <TableHead className='w-24 px-3'>Status</TableHead>
                    <TableHead className='w-10'><span className='sr-only'>Actions</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow><TableCell colSpan={8} className='text-muted-foreground py-12 text-center'>Loading…</TableCell></TableRow>
                  ) : !rows.length ? (
                    <TableRow><TableCell colSpan={8} className='text-muted-foreground py-12 text-center whitespace-normal'>
                      {narrowed ? 'Nothing matches.' : 'No tasks yet. Run the vault sync or add one.'}
                    </TableCell></TableRow>
                  ) : rows.map((t) => (
                    <TableRow key={t.id} data-state={current?.id === t.id ? 'selected' : undefined} tabIndex={0}
                      className={cn('cursor-pointer align-top', sel.has(t.id) && current?.id !== t.id && 'bg-muted/40')}
                      onClick={() => setOpen(current?.id === t.id ? null : t)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(t); }}>
                      <TableCell className='w-8 py-3' onClick={(e) => e.stopPropagation()}>
                        <Checkbox aria-label='Select row' checked={sel.has(t.id)} onCheckedChange={(on) => toggle([t], !!on)} />
                      </TableCell>
                      <TableCell className={cn('px-3 py-3.5', narrow ? 'overflow-hidden text-ellipsis whitespace-nowrap' : 'whitespace-normal')}>
                        <span className='flex min-w-0 flex-col gap-1.5'>
                          <span className='truncate leading-none font-medium' title={t.title}>{t.title}</span>
                          {!narrow && <span className='text-muted-foreground line-clamp-1 text-xs leading-snug'>{t.prompt}</span>}
                        </span>
                      </TableCell>
                      {!narrow && (<>
                        <TableCell className='px-3 py-3.5'>{t.language ?? NA}</TableCell>
                        <TableCell className='px-3 py-3.5'>{t.category ?? NA}</TableCell>
                        <TableCell className='px-3 py-3.5'>{t.repo_url ? <span className='text-muted-foreground block max-w-56 truncate text-xs' title={t.repo_url}>{repoName(t.repo_url)}</span> : NA}</TableCell>
                        <TableCell className='px-3 py-3.5'><Chips items={t.tags} max={2} oneLine /></TableCell>
                      </>)}
                      <TableCell className='px-3 py-3.5'><StatusBadge tone={t.active ? 'ok' : 'neutral'}>{t.active ? 'active' : 'inactive'}</StatusBadge></TableCell>
                      <TableCell className='w-10 py-1.5 text-center' onClick={(e) => e.stopPropagation()}><ActionsMenu items={actions(t)} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <TablePager p={pager} noun='tasks' className='border-t px-2' of={narrowed ? data?.all : undefined} />
          </div>

          {current && (
            <aside aria-label='Task' className='bg-card flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border lg:w-[60%]'>
              <div className='flex items-center gap-2 border-b px-5 py-3'>
                <Button variant='ghost' size='icon-sm' className='lg:hidden' aria-label='Back to the list' onClick={() => setOpen(null)}><Icons.chevronLeft /></Button>
                <div className='min-w-0 flex-1 truncate leading-none font-semibold'>{current.title}</div>
                <Button size='sm' variant='outline' onClick={() => setDraft(toDraft(current))}><Icons.edit /> Edit</Button>
                <ActionsMenu items={actions(current).filter((a) => a.label !== 'Edit')} />
                <Button variant='ghost' size='icon-sm' aria-label='Close' onClick={() => setOpen(null)}><Icons.close /></Button>
              </div>
              <div className='min-h-0 flex-1 overflow-y-auto p-5'><TaskBody t={current} /></div>
            </aside>
          )}
        </div>
      </div>
      {draft && <TaskEditor draft={draft} languages={data?.languages ?? []} categories={data?.categories ?? []} onClose={() => setDraft(null)} />}
    </PageContainer>
  );
}

/** The task peek: one meta line, the properties, the prompt in full, the vendor-neutral version if it differs, then the
 * rest of its attributes as a table. */
function TaskBody({ t }: { t: Task }) {
  const a = t.attributes ?? {};
  const generic = typeof a.generic_prompt === 'string' && a.generic_prompt.trim() && a.generic_prompt !== t.prompt ? a.generic_prompt : null;
  const src = a.source && typeof a.source === 'object' ? (a.source as Record<string, unknown>) : null;
  const other = useMemo(() => Object.entries(a).filter(([k, v]) => !['generic_prompt', 'generic_title'].includes(k) && text(v) != null).map(([k, v]) => ({ k, v: text(v)! })), [a]);
  return (
    <div className='flex flex-col gap-8'>
      <div className={META}>
        <span className={t.active ? 'text-foreground font-medium' : ''}>{t.active ? 'Active' : 'Inactive'}</span><Dot />
        <span>{originOf(t)}</span><Dot />
        <Mono>#{t.id} {t.slug}</Mono><Dot />
        {t.edited_at ? <span>Edited <When d={t.edited_at} />{t.edited_by && ` by ${t.edited_by}`}</span> : <span>Synced <When d={t.synced_at} /></span>}
      </div>
      <dl>
        <Field label='Language'>{t.language ?? NA}</Field>
        <Field label='Category'>{t.category ?? NA}</Field>
        <Field label='Platform'>{t.platform ?? NA}</Field>
        <Field label='Repository'>
          {t.repo_url
            ? <a href={t.repo_url} target='_blank' rel='noopener noreferrer' className='hover:text-primary inline-flex items-center gap-1'>{repoName(t.repo_url)}<Icons.externalLink className='size-3.5' /></a>
            : <span className='text-muted-foreground'>None: runs in the {typeof a.template === 'string' ? <Mono>{a.template}</Mono> : 'matching'} starter workspace</span>}
        </Field>
        <Field label='Tags'><Chips items={t.tags} /></Field>
        {typeof a.generic_title === 'string' && a.generic_title !== t.title && <Field label='Generic title'>{a.generic_title}</Field>}
        {src?.dataset != null && <Field label='From'>{String(src.dataset)}{src.license != null && <span className='text-muted-foreground'> · {String(src.license)}</span>}</Field>}
      </dl>
      <section><Label>Prompt</Label><code className={cn('block', PROMPT)}>{t.prompt}</code></section>
      {generic && <section><Label>Generic prompt (no vendor named)</Label><code className={cn('block', PROMPT)}>{generic}</code></section>}
      {other.length > 0 && (
        <List title='Attributes' rows={other} cols={[
          ['Attribute', (r) => <Mono>{r.k}</Mono>, 'w-40'],
          ['Value', (r) => r.v, 'whitespace-normal leading-snug break-all']
        ]} />
      )}
    </div>
  );
}

/** Edit a task or add one. One input per row; language and category suggest the values already in the library. */
function TaskEditor({ draft, languages, categories, onClose }: { draft: Draft; languages: Facet[]; categories: Facet[]; onClose: () => void }) {
  const [d, setD] = useState<Draft>(draft);
  const [err, setErr] = useState('');
  const isNew = d.id == null;
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setD({ ...d, [k]: e.target.value });
  const body = () => ({ title: d.title, prompt: d.prompt, language: d.language, category: d.category, repo_url: d.repo_url,
    tags: d.tags.split(',').map((s) => s.trim()).filter(Boolean) });
  const save = useAdminAction(() => (isNew ? post('/tasks', body()) : adminApi('PATCH', `/tasks/${d.id}`, body())), { success: isNew ? 'Task added' : 'Task saved' });
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
            <DialogTitle>{isNew ? 'New task' : 'Edit task'}</DialogTitle>
            <DialogDescription>{isNew ? 'A shared task every account can turn into a scenario.' : 'Once saved, the vault sync no longer changes this task.'}</DialogDescription>
          </DialogHeader>
          <FormRow id='te-title' label='Title'><Input id='te-title' required maxLength={200} value={d.title} onChange={set('title')} /></FormRow>
          <FormRow id='te-prompt' label='Prompt' hint='What the developer asks the coding agent, in their words. Never name a vendor.'>
            <Textarea id='te-prompt' required rows={8} maxLength={20000} value={d.prompt} onChange={set('prompt')} />
          </FormRow>
          <FormRow id='te-language' label='Language'>
            <Input id='te-language' list='te-languages' maxLength={60} value={d.language} onChange={set('language')} />
            <datalist id='te-languages'>{languages.map((x) => <option key={x.value} value={x.value}>{x.value}</option>)}</datalist>
          </FormRow>
          <FormRow id='te-category' label='Category'>
            <Input id='te-category' list='te-categories' maxLength={60} value={d.category} onChange={set('category')} />
            <datalist id='te-categories'>{categories.map((x) => <option key={x.value} value={x.value}>{x.value}</option>)}</datalist>
          </FormRow>
          <FormRow id='te-tags' label='Tags' hint='Separated by commas.'><Input id='te-tags' value={d.tags} onChange={set('tags')} placeholder='queues, retries' /></FormRow>
          <FormRow id='te-repo' label='Repository (optional)' hint='An https:// link. Without one, the task runs in a starter workspace for its language.'>
            <Input id='te-repo' type='url' maxLength={500} placeholder='https://github.com/owner/repo' value={d.repo_url} onChange={set('repo_url')} />
          </FormRow>
          {err && <p className='text-destructive text-sm'>{err}</p>}
          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose}>Cancel</Button>
            <Button type='submit' disabled={save.isPending || !d.title.trim() || !d.prompt.trim()}>{isNew ? 'Add task' : 'Save'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
