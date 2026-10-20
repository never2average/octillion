'use client';
// The docs' left navigation: a filter box over page titles and headings, and collapsible groups of pages. It gets only
// titles, hrefs and headings as props (features/docs/docs-data.ts), never a page's body.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { IconChevronRight, IconMenu2, IconSearch, IconX } from '@tabler/icons-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { DocNavGroup, DocNavPage } from './docs-data';

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

/** The groups and pages that match `query` (all of them when it is empty); a page matched by headings lists them. */
function filterNav(groups: DocNavGroup[], query: string) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return groups.map((g) => ({ ...g, pages: g.pages.map((page) => ({ page, hits: [] as DocNavPage['headings'] })) }));
  const has = (s: string) => words.every((w) => norm(s).includes(w));
  return groups.map((g) => ({
    ...g,
    pages: g.pages.flatMap((page) => {
      const hits = page.headings.filter((h) => has(h.text));
      return has(page.title) || has(g.title) || hits.length ? [{ page, hits: hits.slice(0, 6) }] : [];
    })
  })).filter((g) => g.pages.length);
}

function NavTree({ groups, onNavigate, drawer = false }: { groups: DocNavGroup[]; onNavigate?: () => void; drawer?: boolean }) {
  const pathname = usePathname();
  const [query, setQuery] = useState('');
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const input = useRef<HTMLInputElement>(null);
  const shown = useMemo(() => filterNav(groups, query), [groups, query]);
  const filtering = query.trim().length > 0;

  // "/" focuses the filter, unless the reader is already typing somewhere.
  useEffect(() => {
    if (drawer) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || t?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (!input.current?.offsetParent) return; // the sidebar is hidden below lg
      e.preventDefault();
      input.current.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);

  const toggle = (title: string, open: boolean) =>
    setClosed((s) => {
      const n = new Set(s);
      if (open) n.delete(title);
      else n.add(title);
      return n;
    });

  return (
    <div className='flex flex-col gap-4'>
      <div className='relative'>
        <IconSearch className='text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2' />
        <input ref={input} type='search' value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
          placeholder='Filter pages' aria-label='Filter docs pages by title or heading'
          className='border-input bg-background placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full rounded-md border pr-8 pl-8 text-sm shadow-xs outline-none focus-visible:ring-3 [&::-webkit-search-cancel-button]:hidden' />
        {filtering ? (
          <button type='button' onClick={() => { setQuery(''); input.current?.focus(); }} aria-label='Clear filter'
            className='text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2'>
            <IconX className='size-3.5' />
          </button>
        ) : !drawer && (
          <kbd className='text-muted-foreground bg-muted pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded border px-1.5 font-mono text-[10px] leading-4 lg:block'>/</kbd>
        )}
      </div>

      <nav aria-label='Docs' className='flex flex-col gap-3'>
        {shown.map((g) => {
          const open = filtering || !closed.has(g.title);
          return (
            <Collapsible key={g.title} open={open} onOpenChange={(o) => toggle(g.title, o)}>
              <CollapsibleTrigger className='text-muted-foreground hover:text-foreground flex w-full items-center justify-between rounded-md px-2 py-1 text-xs font-semibold tracking-wide uppercase transition-colors'>
                {g.title}
                <IconChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className='mt-1 ml-2 flex flex-col gap-0.5 border-l'>
                  {g.pages.map(({ page, hits }) => {
                    const active = pathname === page.href;
                    return (
                      <li key={page.href}>
                        <Link href={page.href} onClick={onNavigate} aria-current={active ? 'page' : undefined}
                          className={cn('-ml-px block border-l py-1.5 pr-2 pl-3 text-sm transition-colors',
                            active ? 'border-primary text-primary bg-primary/5 font-medium' : 'text-muted-foreground hover:text-foreground hover:border-foreground/30 border-transparent')}>
                          {page.title}
                        </Link>
                        {hits.length > 0 && (
                          <ul className='mb-1 flex flex-col'>
                            {hits.map((h) => (
                              <li key={h.id}>
                                <Link href={`${page.href}#${h.id}`} onClick={onNavigate}
                                  className='text-muted-foreground hover:text-foreground block truncate py-1 pr-2 pl-6 text-xs'># {h.text}</Link>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
        {!shown.length && <p className='text-muted-foreground px-2 text-sm'>No pages match &ldquo;{query}&rdquo;.</p>}
      </nav>
    </div>
  );
}

/** The sticky left column, from lg up. */
export function DocsSidebar({ groups }: { groups: DocNavGroup[] }) {
  return <NavTree groups={groups} />;
}

/** Below lg: a button above the article that opens the same navigation in a drawer. */
export function DocsMobileNav({ groups, current }: { groups: DocNavGroup[]; current: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant='outline' size='sm' className='w-full justify-start gap-2 lg:hidden' />}>
        <IconMenu2 className='size-4' />
        <span className='text-muted-foreground'>Docs</span>
        <IconChevronRight className='text-muted-foreground size-3.5' />
        <span className='truncate'>{current}</span>
      </SheetTrigger>
      <SheetContent side='left' className='w-80 max-w-[85vw] gap-0 p-0'>
        <SheetHeader className='border-b'>
          <SheetTitle>Docs</SheetTitle>
        </SheetHeader>
        <div className='flex-1 overflow-y-auto p-4'>
          <NavTree groups={groups} onNavigate={() => setOpen(false)} drawer />
        </div>
      </SheetContent>
    </Sheet>
  );
}
