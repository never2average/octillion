'use client';
// One structure for every record, on its own page or in a table's side peek:
//   DetailMeta  — the card on top: title, status badges, the key facts as a label/value grid, the primary actions.
//   DetailTabs  — the tab selector right under it; the state lives in ?tab= on a page and in memory in a peek.
//   DetailTable — each tab's table: RecordView embedded (search, sortable typed columns, paging, row click-through).
//   KeyValueTable — a Field | Value table for a tab whose data is inherently key/value (settings, configuration).
//   TimelineTable — a timeline as When | Event | Detail | Actor.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { RecordView, type RecordCol, type RowAction, type SortRule } from '@/components/layout/record-view';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

export type { RecordCol, RowAction, SortRule } from '@/components/layout/record-view';

/** A key fact on the card. `wide` takes two grid columns (a long id, a URL); `hidden` drops it. */
export interface Fact { label: ReactNode; value: ReactNode; hint?: ReactNode; wide?: boolean; hidden?: boolean }

const muted = <span className='text-muted-foreground'>—</span>;

/** The record's card: title and badges with the actions on the right, an optional line under the title, the facts as a
 *  compact grid, then anything compact that belongs to the whole record (a sparkline strip, a notice). */
export function DetailMeta({ title, subtitle, badges, actions, facts, children, className }: {
  title?: ReactNode;
  subtitle?: ReactNode;
  badges?: ReactNode;
  /** Labelled buttons or the ⋯ menu; never icon-only buttons. */
  actions?: ReactNode;
  facts?: Fact[];
  children?: ReactNode;
  className?: string;
}) {
  const shown = (facts ?? []).filter((f) => !f.hidden);
  const head = title || badges || actions || subtitle;
  return (
    <section aria-label='Summary' className={cn('bg-card text-card-foreground @container flex min-w-0 flex-col gap-4 rounded-xl border p-4 sm:p-5', className)}>
      {head && (
        <div className='flex flex-wrap items-start justify-between gap-x-4 gap-y-2'>
          <div className='flex min-w-0 flex-1 flex-col gap-1.5'>
            {(title || badges) && (
              <div className='flex min-w-0 flex-wrap items-center gap-2'>
                {title && <h2 className='min-w-0 truncate text-lg leading-tight font-semibold tracking-tight'>{title}</h2>}
                {badges}
              </div>
            )}
            {subtitle && <div className='text-muted-foreground min-w-0 text-sm leading-snug'>{subtitle}</div>}
          </div>
          {actions && <div className='flex shrink-0 flex-wrap items-center justify-end gap-2'>{actions}</div>}
        </div>
      )}
      {shown.length > 0 && (
        <dl className='grid grid-cols-1 gap-x-6 gap-y-3 @xs:grid-cols-2 @2xl:grid-cols-3 @5xl:grid-cols-4'>
          {shown.map((f, i) => (
            <div key={i} className={cn('flex min-w-0 flex-col gap-1', f.wide && '@xs:col-span-2')}>
              <dt className='text-muted-foreground text-xs leading-none font-medium'>{f.label}</dt>
              <dd className='min-w-0 text-sm leading-snug break-words'>{f.value ?? muted}</dd>
              {f.hint && <dd className='text-muted-foreground text-xs leading-snug'>{f.hint}</dd>}
            </div>
          ))}
        </dl>
      )}
      {children}
    </section>
  );
}

export interface DetailTab { id: string; label: ReactNode; count?: number | null; content: ReactNode; hidden?: boolean }

const readTab = (param: string) => {
  try { return new URLSearchParams(window.location.search).get(param); } catch { return null; }
};

/** The tab selector under the card. `url` keeps the open tab in the address (?tab=, or `url` when it is a string) so a
 *  page can be linked to a tab; without it (a peek) the tab is local state. `resetKey` reopens the first tab when it
 *  changes (the next record in a peek). */
export function DetailTabs({ tabs, url, defaultTab, value, onValueChange, resetKey, className }: {
  tabs: DetailTab[];
  url?: boolean | string;
  defaultTab?: string;
  /** Controlled: the open tab (a problem's "View" switches to it). */
  value?: string;
  onValueChange?: (id: string) => void;
  resetKey?: string | number;
  className?: string;
}) {
  const shown = tabs.filter((t) => !t.hidden);
  const first = defaultTab && shown.some((t) => t.id === defaultTab) ? defaultTab : shown[0]?.id;
  const param = typeof url === 'string' ? url : 'tab';
  const [local, setLocal] = useState<string | undefined>(first);
  useEffect(() => { if (resetKey !== undefined) setLocal(first); }, [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // The address is read after mount (so server markup matches) and written with replaceState (no history entry per tab).
  useEffect(() => {
    if (!url) return;
    const t = readTab(param);
    if (t && shown.some((x) => x.id === t)) setLocal(t);
  }, [url, param]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = useCallback((id: string) => {
    setLocal(id);
    onValueChange?.(id);
    if (!url) return;
    try {
      const u = new URL(window.location.href);
      if (id === first) u.searchParams.delete(param); else u.searchParams.set(param, id);
      window.history.replaceState(window.history.state, '', u.toString());
    } catch { /* address unchanged */ }
  }, [url, param, first, onValueChange]);
  const raw = value ?? local;
  const current = raw && shown.some((t) => t.id === raw) ? raw : first;
  if (!shown.length) return null;
  return (
    <Tabs value={current} onValueChange={(v) => set(String(v))} className={cn('min-w-0 gap-3', className)}>
      <div className='-mx-1 overflow-x-auto px-1 pb-1'>
        <TabsList>
          {shown.map((t) => (
            <TabsTrigger key={t.id} value={t.id} className='px-2.5'>
              {t.label}
              {t.count != null && <span className='text-muted-foreground text-xs tabular-nums'>{t.count}</span>}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {shown.map((t) => (
        <TabsContent key={t.id} value={t.id} className='min-w-0'>{t.content}</TabsContent>
      ))}
    </Tabs>
  );
}

/** A tab's table: the list pages' RecordView, embedded — full-width search (when `search` is given), labelled buttons,
 *  typed columns sort on their header, 10 rows a page, and `onRow` opens the row's own record. Columns with a `value`
 *  and no `type` sort as text. */
export function DetailTable<T>({ rows, cols, rowKey, search, searchPlaceholder, onRow, empty, noun = 'items', actions, primary, filters,
  defaultSort, exportName, initialSize = 10, rowClassName, loading }: {
  rows: readonly T[] | undefined;
  cols: RecordCol<T>[];
  rowKey?: (row: T) => string;
  /** The text a row is searched by; omitted, there is no search box. */
  search?: (row: T) => string;
  searchPlaceholder?: string;
  onRow?: (row: T) => void;
  empty: ReactNode;
  noun?: string;
  actions?: (row: T) => RowAction[];
  /** Labelled buttons on the right of the toolbar (Add, Invite…). */
  primary?: ReactNode;
  /** Controls on the left of the toolbar (a select, a form). */
  filters?: ReactNode;
  defaultSort?: SortRule[];
  exportName?: string;
  initialSize?: number;
  rowClassName?: (row: T) => string | undefined;
  loading?: boolean;
}) {
  const list = rows ?? [];
  const index = useMemo(() => new Map(list.map((r, i) => [r, i])), [list]);
  const key = useCallback((r: T) => (rowKey ? rowKey(r) : String(index.get(r) ?? 0)), [rowKey, index]);
  const typedCols = useMemo(() => cols.map((c) => (c.value && !c.type ? { ...c, type: 'text' as const } : c)), [cols]);
  return (
    <RecordView<T>
      embedded rows={list} rowKey={key} cols={typedCols} noun={noun} empty={empty} loading={loading}
      searchText={search ?? (() => '')} noSearch={!search} searchPlaceholder={searchPlaceholder ?? `Search ${noun}`}
      onRow={onRow} actions={actions} primary={primary} filters={filters} defaultSort={defaultSort} exportName={exportName}
      initialSize={initialSize} rowClassName={rowClassName}
    />
  );
}

export interface KV { label: ReactNode; value: ReactNode; hidden?: boolean }

/** A two-column Field | Value table, for a tab whose data is inherently key/value. */
export function KeyValueTable({ rows, empty = 'Nothing set.', head = ['Field', 'Value'], className }: {
  rows: KV[]; empty?: ReactNode; head?: [ReactNode, ReactNode]; className?: string;
}) {
  const shown = rows.filter((r) => !r.hidden);
  return (
    <div className={cn('overflow-x-auto border', className)}>
      <Table>
        <TableHeader>
          <TableRow className='hover:bg-transparent'>
            <TableHead className='w-[32%] min-w-36 px-3'>{head[0]}</TableHead>
            <TableHead className='px-3'>{head[1]}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((r, i) => (
            <TableRow key={i} className='align-top hover:bg-transparent'>
              <TableCell className='text-muted-foreground px-3 py-2.5 text-xs font-medium whitespace-normal'>{r.label}</TableCell>
              <TableCell className='min-w-0 px-3 py-2.5 text-sm break-words whitespace-normal'>{r.value ?? muted}</TableCell>
            </TableRow>
          ))}
          {!shown.length && (
            <TableRow className='hover:bg-transparent'>
              <TableCell colSpan={2} className='text-muted-foreground py-8 text-center text-sm'>{empty}</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

/** A long piece of text (a prompt, a message body) as the value of a KeyValueTable row: wraps, keeps line breaks. */
export function LongText({ children, mono }: { children: ReactNode; mono?: boolean }) {
  return <div className={cn('max-h-80 overflow-y-auto leading-relaxed whitespace-pre-wrap', mono && 'font-mono text-xs')}>{children}</div>;
}

export interface TimelineEvent { at: string | Date | null | undefined; event: ReactNode; detail?: ReactNode; actor?: ReactNode; key?: string; search?: string }

/** A timeline as a table: When | Event | Detail | Actor, newest first. `when` renders the time (the admin's <When>). */
export function TimelineTable({ events, when, empty = 'Nothing has happened yet.', noun = 'events', onRow, search }: {
  events: TimelineEvent[];
  when: (at: TimelineEvent['at']) => ReactNode;
  empty?: ReactNode;
  noun?: string;
  onRow?: (e: TimelineEvent) => void;
  search?: boolean;
}) {
  const iso = (d: TimelineEvent['at']) => (d ? new Date(d).toISOString() : null);
  return (
    <DetailTable<TimelineEvent>
      rows={events} noun={noun} empty={empty} onRow={onRow}
      rowKey={events.every((e) => e.key) ? (e) => e.key! : undefined}
      search={search ? (e) => e.search ?? '' : undefined}
      defaultSort={[{ key: 'at', dir: 'desc' }]}
      cols={[
        { key: 'at', label: 'When', type: 'date', value: (e) => iso(e.at), render: (e) => when(e.at), className: 'w-32 whitespace-nowrap' },
        { key: 'event', label: 'Event', render: (e) => e.event },
        { key: 'detail', label: 'Detail', render: (e) => e.detail ?? muted, className: 'whitespace-normal' },
        { key: 'actor', label: 'Actor', render: (e) => e.actor ?? muted }
      ]}
    />
  );
}
