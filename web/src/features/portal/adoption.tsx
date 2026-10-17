'use client';
// /app Adoption, a Notion-style database: the parts of the workflow your team has tried (from real tool calls), the
// use cases (journeys from Octillion plus the account's own, added here) and the AI clients you connected. Click a row
// to open it beside the table: stages with their prompts, what is done, and mark-done for steps without a tool.
import { useCallback, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { Field, RecordView, type RecordCol } from '@/components/layout/record-view';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { appApi } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { Dock } from './memory';
import { CopyButton, ErrorState, When, copy, fail, useOrgLoad } from './shared';

interface Setup { clients: { client: string; last: string }[]; groups: { id: string; label: string; prompt: string; used: number; total: number }[] }
interface Stage { id: string; title: string; why: string; prompt: string; tools: string[]; expect: string; manual?: boolean; done: boolean; at: string | null }
interface Journey { id: string; name: string; outcome: string; who: string; time: string; stages: Stage[]; done: number; total: number; own?: boolean; added_by?: string | null }
type Row =
  | { key: string; type: 'workflow'; name: string; detail: string; done: number; total: number; g: Setup['groups'][number] }
  | { key: string; type: 'use case'; name: string; detail: string; done: number; total: number; j: Journey }
  | { key: string; type: 'client'; name: string; detail: string; done: number; total: number; at: string };

const TYPE_STYLE: Record<Row['type'], string> = { workflow: 'bg-primary/15 text-primary', 'use case': 'bg-sky-500/15 text-sky-400', client: 'bg-muted text-muted-foreground' };

export function AdoptionPage() {
  const { data: s, error } = useOrgLoad(() => appApi<Setup>('GET', '/setup'));
  const { data: jr, reload } = useOrgLoad(() => appApi<{ journeys: Journey[] }>('GET', '/journeys'));
  const [adding, setAdding] = useState(false);
  const router = useRouter();
  const removeUseCase = (j: Journey) => {
    if (!window.confirm(`Remove ${j.name}?`)) return;
    appApi('DELETE', `/journeys/${encodeURIComponent(j.id)}`).then(() => { toast.success('Use case removed'); reload(); }).catch(fail);
  };
  const rows: Row[] = !s ? [] : [
    ...(jr?.journeys ?? []).map((j) => ({ key: `j-${j.id}`, type: 'use case' as const, name: j.name, detail: j.outcome, done: j.done, total: j.total, j })),
    ...s.groups.map((g) => ({ key: `w-${g.id}`, type: 'workflow' as const, name: g.label, detail: g.used ? `${g.used} of ${g.total} tools used` : 'Not tried yet', done: g.used, total: g.total, g })),
    ...s.clients.map((c) => ({ key: `c-${c.client}`, type: 'client' as const, name: c.client, detail: 'Connected', done: 1, total: 1, at: c.last }))
  ];
  const cols: RecordCol<Row>[] = [
    { key: 'type', label: 'Type', className: 'w-28', keep: true, render: (r) => <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap', TYPE_STYLE[r.type])}>{r.type}</span> },
    { key: 'item', label: 'Item', keep: true, render: (r) => (<>
      <p className='text-sm font-medium'>{r.name}{r.type === 'use case' && r.j.own && <span className='text-muted-foreground font-normal'> · yours</span>}</p>
      <p className='text-muted-foreground mt-0.5 line-clamp-2 text-xs'>{r.detail}</p>
    </>) },
    { key: 'progress', label: 'Progress', className: 'w-56', render: (r) => <Progress done={r.done} total={r.total} check={r.type === 'client'} /> },
    { key: 'last', label: 'Last', className: 'hidden w-32 sm:table-cell', render: (r) => <span className='text-muted-foreground text-xs'>{r.type === 'client' ? <When d={r.at} /> : r.type === 'use case' ? lastDone(r.j) : '—'}</span> }
  ];
  if (error) return <PageContainer><ErrorState error={error} /></PageContainer>;
  return (
    <PageContainer>
      <RecordView<Row>
        rows={rows} rowKey={(r) => r.key} cols={cols} loading={!s} noun='items'
        searchText={(r) => `${r.type} ${r.name} ${r.detail}`}
        searchPlaceholder='Search adoption: use cases, workflow, clients'
        primary={<Button onClick={() => setAdding(true)}><Icons.add /> Add use case</Button>}
        empty='Nothing to show yet.'
        detailTitle={(r) => r.name}
        actions={(r) => r.type === 'use case' ? [
          { label: 'Open in Setup & training', icon: <Icons.arrowRight />, onSelect: () => router.push(`/app?journey=${encodeURIComponent(r.j.id)}`) },
          ...(r.j.own ? [{ label: 'Remove use case', icon: <Icons.trash />, destructive: true, onSelect: () => removeUseCase(r.j) }] : [])
        ] : r.type === 'workflow' ? [{ label: 'Copy prompt', icon: <Icons.page />, onSelect: () => copy(r.g.prompt) }] : []}
        detail={(r) => r.type === 'use case' ? <UseCase j={r.j} onChanged={reload} />
          : r.type === 'workflow' ? <Workflow g={r.g} /> : <Client name={r.name} at={r.at} />}
      />
      {adding && <UseCaseEditor onClose={() => setAdding(false)} onSaved={() => { setAdding(false); reload(); }} />}
    </PageContainer>
  );
}

const lastDone = (j: Journey) => {
  const at = j.stages.map((x) => x.at).filter(Boolean).sort().pop();
  return at ? <When d={at} /> : '—';
};

function Progress({ done, total, check }: { done: number; total: number; check?: boolean }) {
  return (
    <div className='flex items-center gap-2'>
      <div className='bg-muted h-1.5 flex-1 overflow-hidden rounded-full'><div className={cn('h-full rounded-full', done ? 'bg-primary' : 'bg-muted')} style={{ width: `${Math.round((done / Math.max(1, total)) * 100)}%` }} /></div>
      <span className='text-muted-foreground w-10 text-right text-xs tabular-nums'>{check ? '✓' : `${done}/${total}`}</span>
    </div>
  );
}

function UseCase({ j, onChanged }: { j: Journey; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const mark = (st: Stage) => {
    setBusy(st.id);
    appApi('POST', `/journeys/${encodeURIComponent(j.id)}/stages/${encodeURIComponent(st.id)}`, { done: !st.done })
      .then(() => { toast.success(st.done ? 'Marked not done' : 'Marked done'); onChanged(); }).catch(fail).finally(() => setBusy(null));
  };
  return (
    <div className='flex flex-col gap-5'>
      <dl>
        <Field label='Outcome'>{j.outcome}</Field>
        {j.who && <Field label='For'>{j.who}</Field>}
        {j.time && <Field label='Takes'>{j.time}</Field>}
        <Field label='Progress'><Progress done={j.done} total={j.total} /></Field>
        <Field label='Source'>{j.own ? `Your account${j.added_by ? ` · added by ${j.added_by.replace(/^customer:/, '')}` : ''}` : 'Octillion'}</Field>
      </dl>
      <ol className='flex flex-col gap-4'>
        {j.stages.map((st, i) => (
          <li key={st.id} className='flex gap-3'>
            <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold', st.done ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground')}>
              {st.done ? <Icons.check className='size-3.5' /> : i + 1}
            </span>
            <div className='min-w-0 flex-1 space-y-1.5'>
              <p className='text-sm font-medium'>{st.title}</p>
              {st.why && <p className='text-muted-foreground text-xs'>{st.why}</p>}
              <div className='flex items-center gap-2'>
                <code className='bg-muted min-w-0 flex-1 truncate rounded px-2 py-1 text-xs' title={st.prompt}>{st.prompt}</code>
                <CopyButton text={st.prompt} />
              </div>
              <p className='text-muted-foreground text-xs'>
                {st.manual ? 'Marked by hand.' : `Done when your AI client runs ${st.tools.join(' or ')}.`}{st.done && st.at && <> Done <When d={st.at} />.</>}
              </p>
              {st.manual && <Button size='sm' variant={st.done ? 'outline' : 'default'} disabled={busy === st.id} onClick={() => mark(st)}>{st.done ? 'Mark not done' : 'Mark done'}</Button>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Workflow({ g }: { g: Setup['groups'][number] }) {
  return (
    <div className='flex flex-col gap-5'>
      <dl>
        <Field label='Used'>{g.used} of {g.total} tools</Field>
        <Field label='Progress'><Progress done={g.used} total={g.total} /></Field>
      </dl>
      <div className='space-y-2'>
        <p className='text-sm font-medium'>{g.used ? 'Do it again' : 'Try it'}</p>
        <div className='flex items-center gap-2'>
          <code className='bg-muted min-w-0 flex-1 rounded px-2 py-1.5 text-xs whitespace-pre-wrap'>{g.prompt}</code>
          <CopyButton text={g.prompt} />
        </div>
        <p className='text-muted-foreground text-xs'>Paste it into your AI client with Octillion connected.</p>
      </div>
    </div>
  );
}

function Client({ name, at }: { name: string; at: string }) {
  return (
    <dl>
      <Field label='Client'>{name}</Field>
      <Field label='Last connected'><When d={at} /></Field>
      <Field label='Add another'><Link className='text-primary underline-offset-4 hover:underline' href='/app'>Connection string on Setup & training</Link></Field>
    </dl>
  );
}

/** Add use case: a name, the outcome, and the steps, each a prompt to type; steps are marked done by hand. */
function UseCaseEditor({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: '', outcome: '' });
  const [steps, setSteps] = useState([{ title: '', prompt: '' }]);
  const [busy, setBusy] = useState(false);
  const setStep = useCallback((i: number, k: 'title' | 'prompt', v: string) => setSteps((xs) => xs.map((x, j) => (j === i ? { ...x, [k]: v } : x))), []);
  const ok = f.name.trim() && f.outcome.trim() && steps.some((x) => x.prompt.trim());
  const save = (e: React.FormEvent) => {
    e.preventDefault(); if (!ok) return; setBusy(true);
    appApi('POST', '/journeys', { name: f.name.trim(), outcome: f.outcome.trim(), stages: steps.filter((x) => x.prompt.trim()).map((x) => ({ title: x.title.trim(), prompt: x.prompt.trim() })) })
      .then(() => { toast.success('Use case added'); onSaved(); }).catch(fail).finally(() => setBusy(false));
  };
  return (
    <Dock title='New use case' onClose={onClose}>
      <form onSubmit={save} className='flex max-h-[70vh] flex-col gap-3 overflow-y-auto p-4'>
        <Input autoFocus maxLength={80} placeholder='Name, e.g. Pricing page check' aria-label='Name' value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Textarea rows={2} maxLength={300} placeholder='Outcome: what you know or have at the end' aria-label='Outcome' value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })} className='resize-none' />
        <p className='text-muted-foreground pt-1 text-xs font-medium'>Steps</p>
        {steps.map((x, i) => (
          <div key={i} className='flex flex-col gap-1.5 border-l-2 pl-3'>
            <Input maxLength={120} placeholder={`Step ${i + 1} title (optional)`} aria-label={`Step ${i + 1} title`} value={x.title} onChange={(e) => setStep(i, 'title', e.target.value)} />
            <Textarea rows={2} maxLength={600} placeholder='The prompt to type in your AI client' aria-label={`Step ${i + 1} prompt`} value={x.prompt} onChange={(e) => setStep(i, 'prompt', e.target.value)} className='resize-none' />
          </div>
        ))}
        {steps.length < 12 && <Button type='button' variant='ghost' size='sm' className='self-start' onClick={() => setSteps((xs) => [...xs, { title: '', prompt: '' }])}><Icons.add /> Add step</Button>}
        <div className='flex items-center gap-2 border-t pt-3'>
          <Button type='submit' disabled={busy || !ok}>Add use case</Button>
          <Button type='button' variant='ghost' onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Dock>
  );
}
