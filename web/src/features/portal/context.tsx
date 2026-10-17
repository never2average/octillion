'use client';
// /app Context: the account's institutional memory, one page each for the company, a user and a product. Each page
// does three things: show the memory list, save to it (the floating Remember button and its docked editor), and
// search it. The AI client reads and writes the same memory (save_to_memory, search_memory; src/context.ts).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { PageTabs } from '@/components/layout/page-tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { appApi } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { Dock, KINDS, RememberFab, TYPE_STYLE, type Kind, type MemoryItem, type MemoryScope } from './memory';
import { ErrorState, LoadingCards, When, fail, useOrgLoad } from './shared';

interface Ctx { person: unknown | null; products: { slug: string; name: string }[] }
interface UserRow { user_id: string; email: string | null; name: string | null; active: boolean; me: boolean }

export type ContextSection = 'company' | 'users' | 'products';
const CONTEXT_TABS = [
  { href: '/app/context/company', label: 'Company', icon: Icons.building },
  { href: '/app/context/users', label: 'Users', icon: Icons.teams },
  { href: '/app/context/products', label: 'Products', icon: Icons.product }
];

/** Context: three pages (company, users, products) under one header with route tabs; each is one memory table. */
export function ContextPage({ section }: { section: ContextSection }) {
  const { data: d, error } = useOrgLoad(() => appApi<Ctx>('GET', '/context'));
  const shown: ContextSection = section === 'users' && d && !d.person ? 'company' : section;
  return (
    <PageContainer pageTitle='Context' pageDescription='Your institutional memory: what Octillion and your AI client know about your company, its users and each product.'>
      <PageTabs items={d && !d.person ? CONTEXT_TABS.filter((t) => t.label !== 'Users') : CONTEXT_TABS} />
      {error ? <ErrorState error={error} /> : !d ? <LoadingCards count={2} /> : <MemoryTable key={shown} d={d} section={shown} />}
    </PageContainer>
  );
}

function MemoryTable({ d, section }: { d: Ctx; section: ContextSection }) {
  const scope: MemoryScope = section === 'company' ? 'company' : section === 'users' ? 'user' : 'product';
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [subject, setSubject] = useState<string>(section === 'products' ? d.products[0]?.slug ?? '' : '');
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<{ item?: MemoryItem } | null>(null);

  useEffect(() => {
    if (section !== 'users') return;
    appApi<{ users: UserRow[] }>('GET', '/context/users').then((r) => {
      setUsers(r.users);
      setSubject((cur) => cur || r.users.find((u) => u.me)?.user_id || r.users[0]?.user_id || '');
    }).catch(fail);
  }, [section]);

  const load = useCallback(() => {
    if (section !== 'company' && !subject) { setItems([]); return; }
    appApi<{ memories: MemoryItem[] }>('GET', `/context/memories?scope=${scope}&subject=${encodeURIComponent(subject)}`).then((r) => setItems(r.memories)).catch(fail);
  }, [section, scope, subject]);
  useEffect(() => { setItems(null); load(); }, [load]);

  const user = users?.find((u) => u.user_id === subject);
  const label = section === 'company' ? 'Company' : section === 'users' ? (user ? (user.me ? 'You' : user.name || user.email || 'this user') : '') : (d.products.find((p) => p.slug === subject)?.name ?? '');
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (items ?? []).filter((m) => words.every((w) => `${m.kind} ${m.body} ${m.created_by ?? ''}`.toLowerCase().includes(w)));
  }, [items, q]);

  const save = (item: MemoryItem | undefined, kind: Kind, body: string) =>
    (item ? appApi('PUT', `/context/memories/${item.id}`, { kind, body }) : appApi('POST', '/context/memories', { scope, subject, kind, body }))
      .then(() => { toast.success(item ? 'Memory updated' : `Saved to ${label === 'You' ? 'your' : `${label}'s`} memory`); load(); return true; })
      .catch((e) => { fail(e); return false; });
  const remove = (m: MemoryItem) => appApi('DELETE', `/context/memories/${m.id}`).then(() => { toast.success('Removed from memory'); load(); }).catch(fail);

  const noSubject = section !== 'company' && !subject;
  return (
    <div className='flex min-w-0 flex-col gap-3 pb-24'>
      <div className='flex flex-wrap items-center gap-2'>
        {section === 'users' && users && users.length > 1 && (
          <NativeSelect aria-label='User' value={subject} onChange={(e) => setSubject(e.target.value)} className='w-56'>
            {users.map((u) => <NativeSelectOption key={u.user_id} value={u.user_id}>{`${u.name || u.email || 'Unnamed user'}${u.me ? ' (you)' : ''}${u.active ? '' : ' · suspended'}`}</NativeSelectOption>)}
          </NativeSelect>
        )}
        {section === 'products' && d.products.length > 1 && (
          <NativeSelect aria-label='Product' value={subject} onChange={(e) => setSubject(e.target.value)} className='w-56'>
            {d.products.map((p) => <NativeSelectOption key={p.slug} value={p.slug}>{p.name}</NativeSelectOption>)}
          </NativeSelect>
        )}
        <div className='relative min-w-48 flex-1 sm:max-w-sm'>
          <Icons.search className='text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2' />
          <Input type='search' value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${label ? `${label === 'You' ? 'your' : `${label}'s`} ` : ''}memory`} aria-label='Search memory' className='h-9 pl-8' />
        </div>
      </div>

      {noSubject ? (
        <p className='text-muted-foreground border-y py-10 text-center text-sm'>{section === 'products' ? 'No products yet. Onboard one from your AI client.' : 'Nobody to show.'}</p>
      ) : items === null ? <LoadingCards count={1} /> : (
        <div className='overflow-x-auto border-y'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className='w-28'>Type</TableHead>
                <TableHead>Memory</TableHead>
                <TableHead className='hidden w-48 md:table-cell'>Added by</TableHead>
                <TableHead className='hidden w-32 sm:table-cell'>Added</TableHead>
                <TableHead className='w-20'><span className='sr-only'>Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.length === 0 && (
                <TableRow><TableCell colSpan={5} className='text-muted-foreground py-12 text-center'>
                  {q ? 'No memory matches.' : 'Nothing remembered yet. Press Remember to save the first item.'}
                </TableCell></TableRow>
              )}
              {shown.map((m) => (
                <TableRow key={m.id} className={cn('group align-top', m.can_delete && 'cursor-pointer')} onClick={m.can_delete ? () => setEditing({ item: m }) : undefined}>
                  <TableCell className='py-3'><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', TYPE_STYLE[m.kind] ?? TYPE_STYLE.note)}>{m.kind}</span></TableCell>
                  <TableCell className='py-3 whitespace-normal'><p className='text-sm whitespace-pre-wrap'>{m.body}</p></TableCell>
                  <TableCell className='text-muted-foreground hidden py-3 text-xs md:table-cell'>{m.created_by ?? '—'}</TableCell>
                  <TableCell className='text-muted-foreground hidden py-3 text-xs sm:table-cell'><When d={m.created_at} /></TableCell>
                  <TableCell className='py-2 text-right' onClick={(e) => e.stopPropagation()}>
                    {m.can_delete && (
                      <div className='flex justify-end gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100'>
                        <Button variant='ghost' size='icon' className='size-7' aria-label='Edit' onClick={() => setEditing({ item: m })}><Icons.edit className='size-4' /></Button>
                        <Button variant='ghost' size='icon' className='size-7' aria-label='Remove from memory' onClick={() => remove(m)}><Icons.trash className='size-4' /></Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {!noSubject && !editing && <RememberFab onClick={() => setEditing({})} />}
      {editing && <MemoryEditor key={editing.item?.id ?? 'new'} item={editing.item} label={label} onClose={() => setEditing(null)} onSave={save} />}
    </div>
  );
}

/** Save a new memory item or change one, in the docked window. */
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
