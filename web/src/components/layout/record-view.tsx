'use client';
// A Notion-style database page: a toolbar (full-width search, filters, the primary action), one paged table exactly the
// page's height that scrolls inside, a ⋯ menu of actions on each row, and a side peek. Clicking a row narrows the table to 40% and opens the record beside it; Escape or ✕
// closes it. On small screens the record replaces the table, with a way back. Used by /app and /admin list pages.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { TablePager, usePaged } from '@/components/layout/table-pager';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';

export interface RecordCol<T> {
  key: string;
  label: ReactNode;
  render: (row: T) => ReactNode;
  className?: string;
  /** Still shown while a record is open beside the table (the narrow 40% view). */
  keep?: boolean;
}

/** One entry in a row's ⋯ menu. */
export interface RowAction { label: string; icon?: ReactNode; onSelect: () => void; destructive?: boolean; disabled?: boolean }

export function RecordView<T>({ rows, rowKey, cols, searchText, searchPlaceholder = 'Search', filters, primary, detail, detailTitle, actions, empty, noun = 'items', loading, initialSize }: {
  rows: readonly T[];
  rowKey: (row: T) => string;
  cols: RecordCol<T>[];
  /** The text a row is searched by; every word typed must appear in it. */
  searchText: (row: T) => string;
  searchPlaceholder?: string;
  filters?: ReactNode;
  primary?: ReactNode;
  /** The record, shown beside the table when a row is clicked; without it rows are not clickable. */
  detail?: (row: T, close: () => void) => ReactNode;
  detailTitle?: (row: T) => ReactNode;
  /** The row's ⋯ menu: toggles and actions live here, not in the cells. */
  actions?: (row: T) => RowAction[];
  empty: ReactNode;
  noun?: string;
  loading?: boolean;
  initialSize?: number;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter((r) => words.every((w) => searchText(r).toLowerCase().includes(w)));
  }, [rows, q, searchText]);
  const page = usePaged(shown, initialSize);
  const current = open ? rows.find((r) => rowKey(r) === open) : undefined;
  const close = () => setOpen(null);
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current]);
  const visible = current ? cols.filter((c) => c.keep) : cols;
  const span = visible.length + (actions ? 1 : 0);

  return (
    // Fills the page below the header (header 3.5–4rem plus the page's padding): the table frame never scrolls or shrinks.
    <div className='flex h-[calc(100svh-5.5rem)] min-h-[24rem] min-w-0 flex-col gap-3'>
      <div className='flex flex-wrap items-center gap-2'>
        <div className='relative min-w-48 flex-1'>
          <Icons.search className='text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2' />
          <Input type='search' value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder} aria-label={searchPlaceholder} className='h-9 pl-8' />
        </div>
        {filters}
        {primary}
      </div>

      <div className='flex min-h-0 flex-1 gap-4'>
        <div className={cn('flex min-h-0 min-w-0 flex-col border-y', current ? 'hidden lg:flex lg:w-[40%] lg:shrink-0' : 'w-full')}>
          <div className='min-h-0 flex-1 overflow-auto'>
            <Table>
              <TableHeader className='bg-background sticky top-0 z-10 shadow-[0_1px_0_var(--border)]'>
                <TableRow>
                  {visible.map((c) => <TableHead key={c.key} className={c.className}>{c.label}</TableHead>)}
                  {actions && <TableHead className='w-10'><span className='sr-only'>Actions</span></TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow><TableCell colSpan={span} className='text-muted-foreground py-12 text-center'>Loading…</TableCell></TableRow>
                ) : shown.length === 0 ? (
                  <TableRow><TableCell colSpan={span} className='text-muted-foreground py-12 text-center whitespace-normal'>{q ? 'Nothing matches.' : empty}</TableCell></TableRow>
                ) : page.rows.map((r) => {
                  const k = rowKey(r);
                  return (
                    <TableRow key={k} data-state={open === k ? 'selected' : undefined}
                      className={cn('align-top', detail && 'cursor-pointer')}
                      onClick={detail ? () => setOpen(open === k ? null : k) : undefined}
                      onKeyDown={detail ? (e) => { if (e.key === 'Enter') setOpen(k); } : undefined}
                      tabIndex={detail ? 0 : undefined}>
                      {visible.map((c) => <TableCell key={c.key} className={cn('py-3 whitespace-normal', c.className)}>{c.render(r)}</TableCell>)}
                      {actions && <TableCell className='w-10 py-1.5 text-center' onClick={(e) => e.stopPropagation()}><RowMenu items={actions(r)} /></TableCell>}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <TablePager p={page} noun={noun} className='border-t px-2' />
        </div>

        {current && detail && (
          <aside aria-label='Record' className='bg-card flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border lg:w-[60%]'>
            <div className='flex items-center gap-2 border-b px-5 py-3'>
              <Button variant='ghost' size='icon-sm' className='lg:hidden' aria-label='Back to the list' onClick={close}><Icons.chevronLeft /></Button>
              <div className='min-w-0 flex-1 truncate font-semibold'>{detailTitle?.(current)}</div>
              <Button variant='ghost' size='icon-sm' aria-label='Close' onClick={close}><Icons.close /></Button>
            </div>
            <div className='min-h-0 flex-1 overflow-y-auto p-5'>{detail(current, close)}</div>
          </aside>
        )}
      </div>
    </div>
  );
}

function RowMenu({ items }: { items: RowAction[] }) {
  if (!items.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant='ghost' size='icon-sm' aria-label='Actions' />}><Icons.dots /></DropdownMenuTrigger>
      <DropdownMenuContent align='end' className='w-48'>
        {items.map((a) => (
          <DropdownMenuItem key={a.label} disabled={a.disabled} onClick={a.onSelect} className={cn(a.destructive && 'text-destructive focus:text-destructive')}>
            {a.icon}{a.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A label / value pair for a record's side panel. */
export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className='grid items-center gap-1.5 border-b py-3 leading-none last:border-b-0 sm:grid-cols-[10rem_1fr] sm:gap-4'>
      <dt className='text-muted-foreground text-xs font-medium'>{label}</dt>
      <dd className='min-w-0 text-sm break-words'>{children}</dd>
    </div>
  );
}
