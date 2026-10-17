'use client';
// Client-side paging for the app's tables: a page of rows, plus a footer with the item count, page size and prev/next.
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';

export const PAGE_SIZES = [10, 25, 50, 100];

export interface Paged<T> { rows: T[]; page: number; pages: number; size: number; total: number; setPage: (p: number) => void; setSize: (s: number) => void }

/** One page of `items`; jumps back to the first page when the list changes length (a search or filter). */
export function usePaged<T>(items: readonly T[], initialSize = 25): Paged<T> {
  const [size, setSize] = useState(initialSize);
  const [page, setPage] = useState(1);
  const total = items.length, pages = Math.max(1, Math.ceil(total / size));
  useEffect(() => { setPage(1); }, [total, size]);
  const at = Math.min(page, pages);
  const rows = useMemo(() => items.slice((at - 1) * size, at * size), [items, at, size]);
  return { rows, page: at, pages, size, total, setPage, setSize };
}

/** "21–40 of 137 · Rows [25] · ‹ 2 / 7 ›". Hidden when there is nothing to show. */
export function TablePager<T>({ p, noun = 'items', className }: { p: Paged<T>; noun?: string; className?: string }) {
  if (!p.total) return null;
  const from = (p.page - 1) * p.size + 1, to = Math.min(p.total, p.page * p.size);
  return (
    <div className={cn('text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-2 py-2 text-xs', className)}>
      <span className='tabular-nums'>{p.total <= p.size ? `${p.total} ${noun}` : `${from}–${to} of ${p.total} ${noun}`}</span>
      <label className='ml-auto flex items-center gap-2'>
        Rows
        <NativeSelect size='sm' aria-label='Rows per page' value={String(p.size)} onChange={(e) => p.setSize(Number(e.target.value))} className='w-[4.5rem]'>
          {PAGE_SIZES.map((s) => <NativeSelectOption key={s} value={String(s)}>{s}</NativeSelectOption>)}
        </NativeSelect>
      </label>
      <div className='flex items-center gap-1'>
        <Button variant='ghost' size='icon-sm' aria-label='Previous page' disabled={p.page <= 1} onClick={() => p.setPage(p.page - 1)}><Icons.chevronLeft /></Button>
        <span className='min-w-12 text-center tabular-nums'>{p.page} / {p.pages}</span>
        <Button variant='ghost' size='icon-sm' aria-label='Next page' disabled={p.page >= p.pages} onClick={() => p.setPage(p.page + 1)}><Icons.chevronRight /></Button>
      </div>
    </div>
  );
}

/** Page any table in place: `children` renders the current page's rows; the pager follows the table. */
export function PagedTable<T>({ items, noun, initialSize, children }: { items: readonly T[]; noun?: string; initialSize?: number; children: (rows: T[]) => React.ReactNode }) {
  const p = usePaged(items, initialSize);
  return <>{children(p.rows)}<TablePager p={p} noun={noun} /></>;
}
