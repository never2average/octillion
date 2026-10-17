'use client';
// /app Adoption: how much of Octillion the account uses, as one searchable, paged table like the memory pages: the
// parts of the workflow your team has tried (from real tool calls), journey progress, and the AI clients you connected.
import { useMemo, useState } from 'react';
import Link from 'next/link';
import PageContainer from '@/components/layout/page-container';
import { TablePager, usePaged } from '@/components/layout/table-pager';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Icons } from '@/components/icons';
import { appApi } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { ErrorState, LoadingCards, When, copy, useOrgLoad } from './shared';

interface Setup {
  clients: { client: string; last: string }[];
  groups: { id: string; label: string; prompt: string; used: number; total: number }[];
}
interface Journey { id: string; name: string; outcome: string; done: number; total: number }
interface Row { key: string; type: 'workflow' | 'journey' | 'client'; name: string; detail: string; done: number; total: number; at?: string; prompt?: string; href?: string }

const TYPE_STYLE = { workflow: 'bg-primary/15 text-primary', journey: 'bg-sky-500/15 text-sky-400', client: 'bg-muted text-muted-foreground' };

export function AdoptionPage() {
  const { data: s, error } = useOrgLoad(() => appApi<Setup>('GET', '/setup'));
  const { data: jr } = useOrgLoad(() => appApi<{ journeys: Journey[] }>('GET', '/journeys'));
  const [q, setQ] = useState('');
  const rows = useMemo<Row[]>(() => !s ? [] : [
    ...s.groups.map((g) => ({ key: `w-${g.id}`, type: 'workflow' as const, name: g.label, detail: g.used ? `${g.used} of ${g.total} tools used` : g.prompt, done: g.used, total: g.total, prompt: g.used ? undefined : g.prompt })),
    ...(jr?.journeys ?? []).map((j) => ({ key: `j-${j.id}`, type: 'journey' as const, name: j.name, detail: j.outcome, done: j.done, total: j.total, href: `/app?journey=${encodeURIComponent(j.id)}` })),
    ...s.clients.map((c) => ({ key: `c-${c.client}`, type: 'client' as const, name: c.client, detail: 'Connected', done: 1, total: 1, at: c.last }))
  ], [s, jr]);
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter((r) => words.every((w) => `${r.type} ${r.name} ${r.detail}`.toLowerCase().includes(w)));
  }, [rows, q]);
  const page = usePaged(shown);
  return (
    <PageContainer>
      {error ? <ErrorState error={error} /> : !s ? <LoadingCards count={2} /> : (
        <div className='flex min-w-0 flex-col gap-3'>
          <div className='relative'>
            <Icons.search className='text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2' />
            <Input type='search' value={q} onChange={(e) => setQ(e.target.value)} placeholder='Search adoption: workflow, journeys, clients' aria-label='Search adoption' className='h-9 pl-8' />
          </div>
          <div className='overflow-x-auto border-y'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className='w-28'>Type</TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead className='w-56'>Progress</TableHead>
                  <TableHead className='hidden w-32 sm:table-cell'>Last</TableHead>
                  <TableHead className='w-24'><span className='sr-only'>Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.length === 0 && (
                  <TableRow><TableCell colSpan={5} className='text-muted-foreground py-12 text-center'>{q ? 'Nothing matches.' : 'Nothing to show yet.'}</TableCell></TableRow>
                )}
                {page.rows.map((r) => {
                  const pct = Math.round((r.done / Math.max(1, r.total)) * 100);
                  return (
                    <TableRow key={r.key} className='align-top'>
                      <TableCell className='py-3'><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', TYPE_STYLE[r.type])}>{r.type}</span></TableCell>
                      <TableCell className='py-3 whitespace-normal'>
                        <p className='text-sm font-medium'>{r.name}</p>
                        <p className={cn('text-muted-foreground mt-0.5 line-clamp-2 text-xs', r.prompt && 'font-mono')}>{r.detail}</p>
                      </TableCell>
                      <TableCell className='py-3'>
                        <div className='flex items-center gap-2'>
                          <div className='bg-muted h-1.5 flex-1 overflow-hidden rounded-full'><div className={cn('h-full rounded-full', r.done ? 'bg-primary' : 'bg-muted')} style={{ width: `${pct}%` }} /></div>
                          <span className='text-muted-foreground w-10 text-right text-xs tabular-nums'>{r.type === 'client' ? '✓' : `${r.done}/${r.total}`}</span>
                        </div>
                      </TableCell>
                      <TableCell className='text-muted-foreground hidden py-3 text-xs sm:table-cell'>{r.at ? <When d={r.at} /> : '—'}</TableCell>
                      <TableCell className='py-2 text-right'>
                        {r.prompt && <Button variant='ghost' size='sm' onClick={() => copy(r.prompt!)}><Icons.page /> Prompt</Button>}
                        {r.href && <Button variant='ghost' size='sm' render={<Link href={r.href} />}>Open</Button>}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <TablePager p={page} className='border-t px-2' />
          </div>
        </div>
      )}
    </PageContainer>
  );
}
