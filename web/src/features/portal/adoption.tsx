'use client';
// /app Adoption: how much of Octillion the account actually uses. Setup, the parts of the workflow your team has
// tried (from real tool calls), journey progress and the AI clients that connect. Same data as Setup & training.
import Link from 'next/link';
import PageContainer from '@/components/layout/page-container';
import { Section, StatStrip } from '@/components/layout/section';
import { Badge } from '@/components/ui/badge';
import { Icons } from '@/components/icons';
import { appApi } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { CopyButton, ErrorState, LoadingCards, When, useOrgLoad } from './shared';

interface Setup {
  done: number; total: number; clients: { client: string; last: string }[]; calls: number;
  groups: { id: string; label: string; prompt: string; used: number; total: number }[];
}
interface Journey { id: string; name: string; outcome: string; done: number; total: number }

const Bar = ({ value, total, tone = 'primary' }: { value: number; total: number; tone?: 'primary' | 'muted' }) => (
  <div className='bg-muted h-1.5 w-full overflow-hidden rounded-full'>
    <div className={cn('h-full rounded-full', tone === 'primary' ? 'bg-primary' : 'bg-muted-foreground/40')} style={{ width: `${Math.round((value / Math.max(1, total)) * 100)}%` }} />
  </div>
);

export function AdoptionPage() {
  const { data: s, error } = useOrgLoad(() => appApi<Setup>('GET', '/setup'));
  const { data: jr } = useOrgLoad(() => appApi<{ journeys: Journey[] }>('GET', '/journeys'));
  const journeys = jr?.journeys ?? [];
  const used = s?.groups.filter((g) => g.used).length ?? 0;
  return (
    <PageContainer pageTitle='Adoption' pageDescription='How much of Octillion your team uses, from real tool calls: the workflow, the journeys and the AI clients that connect.'>
      {error ? <ErrorState error={error} /> : !s ? <LoadingCards count={3} /> : (
        <div className='flex max-w-6xl flex-col gap-10'>
          <StatStrip items={[
            { label: 'Setup', value: `${s.done}/${s.total}`, hint: 'steps done', href: '/app' },
            { label: 'Workflow', value: `${used}/${s.groups.length}`, hint: 'parts in use' },
            { label: 'Journeys', value: `${journeys.filter((j) => j.done === j.total && j.total > 0).length}/${journeys.length}`, hint: `${journeys.filter((j) => j.done > 0).length} started` },
            { label: 'Tool calls', value: s.calls.toLocaleString(), hint: `${s.clients.length} client${s.clients.length === 1 ? '' : 's'} connected` }
          ]} />

          <div className='grid gap-x-12 gap-y-10 lg:grid-cols-2'>
            <Section title='Workflow' description={`Your team has used ${used} of ${s.groups.length} parts of the workflow. Try the prompt in your AI client to start one.`}>
              <ul className='divide-y border-y'>
                {s.groups.map((g) => (
                  <li key={g.id} className='space-y-2 py-3'>
                    <div className='flex items-center justify-between gap-2 text-sm'>
                      <span className='font-medium'>{g.label}</span>
                      {g.used > 0 ? <Badge variant='secondary'><Icons.check className='size-3' /> {g.used}/{g.total} tools</Badge> : <Badge variant='outline'>not yet</Badge>}
                    </div>
                    <Bar value={g.used} total={g.total} tone={g.used ? 'primary' : 'muted'} />
                    {!g.used && (
                      <div className='flex items-center gap-2'>
                        <code className='bg-muted flex-1 truncate rounded px-2 py-1 text-xs' title={g.prompt}>{g.prompt}</code>
                        <CopyButton text={g.prompt} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Section>

            <div className='flex flex-col gap-10'>
              <Section title='Journeys' description='Step-by-step use cases. A stage counts as done when its tools run, so progress follows real work.'>
                {!journeys.length ? <p className='text-muted-foreground text-sm'>No journeys yet.</p> : (
                  <ul className='divide-y border-y'>
                    {journeys.map((j) => (
                      <li key={j.id}>
                        <Link href={`/app?journey=${encodeURIComponent(j.id)}`} className='hover:bg-muted/40 -mx-2 block space-y-2 rounded-md px-2 py-3'>
                          <div className='flex items-center justify-between gap-2 text-sm'>
                            <span className='min-w-0 truncate font-medium'>{j.name}</span>
                            <span className='text-muted-foreground shrink-0 tabular-nums'>{j.done}/{j.total}</span>
                          </div>
                          <Bar value={j.done} total={j.total} tone={j.done ? 'primary' : 'muted'} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section title='AI clients' description='Clients that have called Octillion for this account, most recent first.'>
                {!s.clients.length ? <p className='text-muted-foreground text-sm'>None yet. Connect one from <Link className='text-primary underline-offset-4 hover:underline' href='/app'>Setup & training</Link>.</p> : (
                  <ul className='divide-y border-y'>
                    {s.clients.map((c) => (
                      <li key={c.client} className='flex items-center justify-between gap-2 py-3 text-sm'>
                        <span className='font-medium'>{c.client}</span>
                        <span className='text-muted-foreground text-xs'><When d={c.last} /></span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </div>
          </div>
        </div>
      )}
    </PageContainer>
  );
}
