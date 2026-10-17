'use client';
// Customer journeys: the use-case pipelines customers follow on /app Setup. Write them here, promote the ones
// customers see, and set their order. Progress on /app comes from real tool calls (src/playbooks.ts).
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { adminApi } from '@/lib/api-client';
import { post, useAdmin, useAdminAction } from './lib';
import { Field as Prop, RecordView, type RecordCol } from '@/components/layout/record-view';
import { ConfirmButton, ErrorBox, When } from './ui';

interface Stage { id?: string; title: string; why: string; prompt: string; tools: string[]; expect: string; manual?: boolean }
interface Playbook {
  id: string; name: string; outcome: string; who: string; time: string; example: { title: string; result: string };
  stages: Stage[]; promoted: boolean; position: number; updated_at: string; updated_by: string | null;
  adoption?: { started: number; completed: number; median_hours_to_complete: number | null; dropoff: { id: string; title: string; lost: number } | null;
    last_activity: string | null; funnel: { id: string; title: string; reached: number }[] };
  accounts_active?: number;
}
type Draft = Omit<Playbook, 'promoted' | 'position' | 'updated_at' | 'updated_by' | 'adoption' | 'accounts_active'> & { isNew: boolean };

const emptyStage = (): Stage => ({ title: '', why: '', prompt: '', tools: [], expect: '' });
const blank = (): Draft => ({ id: '', name: '', outcome: '', who: '', time: '', example: { title: '', result: '' }, stages: [emptyStage()], isNew: true });

export function CustomerJourneys({ switcher }: { switcher?: React.ReactNode }) {
  const { data, error, isLoading } = useAdmin<{ playbooks: Playbook[]; tools: string[] }>('/playbooks');
  const [draft, setDraft] = useState<Draft | null>(null);
  const promote = useAdminAction((v: { id: string; on: boolean }) => post(`/playbooks/${v.id}/promote`, { promoted: v.on }), { success: 'Saved' });
  const move = useAdminAction((ids: string[]) => post('/playbooks/reorder', { ids }), { success: 'Order saved' });
  const remove = useAdminAction((id: string) => adminApi('DELETE', `/playbooks/${id}`), { success: 'Journey deleted' });
  const list = data?.playbooks ?? [];
  const reorder = (id: string, dir: -1 | 1) => {
    const ids = list.map((p) => p.id);
    const i = ids.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    move.mutate(ids);
  };
  const edit = (p: Playbook) => setDraft({ ...p, stages: p.stages.map((s) => ({ ...s, tools: [...s.tools] })), example: { ...p.example }, isNew: false });
  const cols: RecordCol<Playbook>[] = [
    { key: 'pos', label: '#', className: 'w-10', keep: true, render: (p) => <span className='text-muted-foreground tabular-nums'>{list.indexOf(p) + 1}</span> },
    { key: 'name', label: 'Journey', keep: true, render: (p) => (<>
      <p className='font-medium'>{p.name}</p>
      <p className='text-muted-foreground line-clamp-1 text-xs'>{p.outcome}</p>
    </>) },
    { key: 'stages', label: 'Stages', className: 'w-20', render: (p) => <span className='tabular-nums'>{p.stages.length}</span> },
    { key: 'promoted', label: 'Promoted', className: 'w-24', keep: true, render: (p) => (
      <span onClick={(e) => e.stopPropagation()}><Switch checked={p.promoted} onCheckedChange={(on) => promote.mutate({ id: p.id, on })} aria-label={`Promote ${p.name}`} /></span>
    ) },
    { key: 'use', label: 'Started / finished', className: 'w-36', render: (p) => p.adoption ? <span className='tabular-nums'>{p.adoption.started} / {p.adoption.completed}</span> : '—' },
    { key: 'edited', label: 'Edited', className: 'w-28', render: (p) => <When d={p.updated_at} className='text-muted-foreground text-xs' /> }
  ];
  const promoted = list.filter((p) => p.promoted).length;
  return (
    <>
      <ErrorBox error={error} />
      <RecordView<Playbook>
        rows={list} rowKey={(p) => p.id} cols={cols} loading={isLoading} noun='journeys'
        searchText={(p) => `${p.name} ${p.outcome} ${p.who} ${p.stages.map((s) => s.title).join(' ')}`}
        searchPlaceholder={`Search ${list.length} customer journeys (${promoted} promoted)`}
        filters={switcher}
        primary={<Button onClick={() => setDraft(blank())}><Icons.add /> New journey</Button>}
        empty='No journeys yet.'
        detailTitle={(p) => p.name}
        detail={(p) => {
          const i = list.indexOf(p);
          return (
            <div className='flex flex-col gap-5'>
              <dl>
                <Prop label='Outcome'>{p.outcome}</Prop>
                {p.who && <Prop label='For'>{p.who}</Prop>}
                {p.time && <Prop label='Takes'>{p.time}</Prop>}
                <Prop label='Shown to customers'>
                  <label className='flex items-center gap-2'><Switch checked={p.promoted} onCheckedChange={(on) => promote.mutate({ id: p.id, on })} aria-label={`Promote ${p.name}`} /> {p.promoted ? 'Promoted' : 'Hidden'}</label>
                </Prop>
                <Prop label='Order'>
                  <span className='inline-flex items-center gap-1'>
                    #{i + 1}
                    <Button size='icon-sm' variant='ghost' aria-label='Move up' disabled={i === 0 || move.isPending} onClick={() => reorder(p.id, -1)}><Icons.chevronUp /></Button>
                    <Button size='icon-sm' variant='ghost' aria-label='Move down' disabled={i === list.length - 1 || move.isPending} onClick={() => reorder(p.id, 1)}><Icons.chevronDown /></Button>
                  </span>
                </Prop>
                {p.updated_by && <Prop label='Edited'>{p.updated_by} · <When d={p.updated_at} /></Prop>}
              </dl>
              {p.adoption && <JourneyStats p={p} />}
              <div className='space-y-3'>
                <p className='text-sm font-medium'>Stages</p>
                <ol className='flex flex-col gap-3'>
                  {p.stages.map((st, k) => (
                    <li key={st.id ?? k} className='flex gap-3'>
                      <span className='text-muted-foreground w-5 shrink-0 text-xs tabular-nums'>{k + 1}</span>
                      <div className='min-w-0 flex-1 space-y-1'>
                        <p className='text-sm font-medium'>{st.title}</p>
                        <code className='bg-muted block rounded px-2 py-1 text-xs whitespace-pre-wrap'>{st.prompt}</code>
                        <p className='text-muted-foreground text-xs'>{st.manual || !st.tools.length ? 'Marked by the customer' : `Done by ${st.tools.join(', ')}`}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
              <div className='flex flex-wrap gap-2 border-t pt-4'>
                <Button onClick={() => edit(p)}><Icons.edit /> Edit</Button>
                <ConfirmButton variant='ghost' label='Delete' title={`Delete ${p.name}?`} description='Customers stop seeing it at once. This cannot be undone.' onConfirm={() => remove.mutate(p.id)} />
              </div>
            </div>
          );
        }}
      />
      {draft && <Editor draft={draft} tools={data?.tools ?? []} onClose={() => setDraft(null)} />}
    </>
  );
}

/** Journey-level usage: started and finished accounts, time to finish, where accounts stop, and the stage funnel. */
function JourneyStats({ p }: { p: Playbook }) {
  const a = p.adoption!;
  const [open, setOpen] = useState(true);
  const active = Math.max(1, p.accounts_active ?? 0);
  const hrs = a.median_hours_to_complete;
  const time = hrs == null ? '—' : hrs < 1 ? `${Math.round(hrs * 60)} min` : hrs < 48 ? `${Math.round(hrs)} h` : `${Math.round(hrs / 24)} d`;
  const top = Math.max(1, ...a.funnel.map((f) => f.reached));
  return (
    <div className='mt-2'>
      <dl className='text-muted-foreground flex flex-wrap gap-x-5 gap-y-1 text-xs'>
        <div><dt className='inline'>Started </dt><dd className='text-foreground inline font-medium tabular-nums'>{a.started}</dd><span> of {p.accounts_active ?? 0} active accounts ({Math.round((a.started / active) * 100)}%)</span></div>
        <div><dt className='inline'>Finished </dt><dd className='text-foreground inline font-medium tabular-nums'>{a.completed}</dd>{a.started > 0 && <span> ({Math.round((a.completed / a.started) * 100)}% of starters)</span>}</div>
        <div><dt className='inline'>Median time to finish </dt><dd className='text-foreground inline font-medium'>{time}</dd></div>
        {a.dropoff && <div><dt className='inline'>Most stop at </dt><dd className='text-foreground inline font-medium'>{a.dropoff.title}</dd><span> (−{a.dropoff.lost})</span></div>}
        <button type='button' className='text-primary hover:underline' onClick={() => setOpen(!open)}>{open ? 'Hide funnel' : 'Stage funnel'}</button>
      </dl>
      {open && (
        <ol className='mt-3 flex max-w-xl flex-col gap-1.5'>
          {a.funnel.map((f, i) => (
            <li key={f.id} className='grid grid-cols-[1.5rem_minmax(0,10rem)_1fr_2rem] items-center gap-2 text-xs'>
              <span className='text-muted-foreground tabular-nums'>{i + 1}</span>
              <span className='truncate' title={f.title}>{f.title}</span>
              <span className='bg-muted h-2 overflow-hidden rounded-full'><span className='bg-primary block h-full' style={{ width: `${(f.reached / top) * 100}%` }} /></span>
              <span className='text-right tabular-nums'>{f.reached}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Editor({ draft: initial, tools, onClose }: { draft: Draft; tools: string[]; onClose: () => void }) {
  const [d, setD] = useState<Draft>(initial);
  const [err, setErr] = useState('');
  const save = useAdminAction(() => (d.isNew ? post('/playbooks', d) : adminApi('PUT', `/playbooks/${d.id}`, d)),
    { success: d.isNew ? 'Journey created (not promoted yet)' : 'Journey saved' });
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const setStage = (i: number, patch: Partial<Stage>) => setD((x) => ({ ...x, stages: x.stages.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const moveStage = (i: number, dir: -1 | 1) => setD((x) => {
    const st = [...x.stages], j = i + dir;
    if (j < 0 || j >= st.length) return x;
    [st[i], st[j]] = [st[j], st[i]];
    return { ...x, stages: st };
  });
  const submit = () => { setErr(''); save.mutate(undefined, { onSuccess: onClose, onError: (e) => setErr(e.message) }); };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-3xl'>
        <DialogHeader>
          <DialogTitle>{d.isNew ? 'New journey' : `Edit ${initial.name}`}</DialogTitle>
          <DialogDescription>A real use case as stages a customer replicates in their AI client. A stage is done when one of its tools runs after the previous stage; a stage with no tools is marked by the customer.</DialogDescription>
        </DialogHeader>
        <div className='grid gap-4 sm:grid-cols-2'>
          <Field label='Name'><Input value={d.name} onChange={(e) => set('name', e.target.value)} placeholder='Fix a losing task' /></Field>
          <Field label='Takes'><Input value={d.time} onChange={(e) => set('time', e.target.value)} placeholder='a day, including your docs change' /></Field>
          <Field label='Outcome' className='sm:col-span-2'><Input value={d.outcome} onChange={(e) => set('outcome', e.target.value)} placeholder='What the customer gets at the end' /></Field>
          <Field label='For' className='sm:col-span-2'><Input value={d.who} onChange={(e) => set('who', e.target.value)} placeholder='DevRel and docs owners after the first report' /></Field>
          <Field label='Worked example: title'><Input value={d.example.title} onChange={(e) => set('example', { ...d.example, title: e.target.value })} placeholder='Resend inbound email' /></Field>
          <Field label='Worked example: result' className='sm:col-span-2'><Textarea rows={2} value={d.example.result} onChange={(e) => set('example', { ...d.example, result: e.target.value })} /></Field>
        </div>
        <div className='mt-2 flex items-center justify-between'>
          <h3 className='text-sm font-semibold'>Stages</h3>
          <Button size='sm' variant='outline' disabled={d.stages.length >= 12} onClick={() => set('stages', [...d.stages, emptyStage()])}><Icons.add /> Add stage</Button>
        </div>
        <ol className='flex flex-col gap-4'>
          {d.stages.map((s, i) => (
            <li key={i} className='border-primary/30 space-y-3 border-l-2 pl-4'>
              <div className='flex items-center gap-2'>
                <span className='text-muted-foreground text-xs font-semibold'>Stage {i + 1}</span>
                <span className='flex-1' />
                <Button size='icon-sm' variant='ghost' aria-label='Move stage up' disabled={i === 0} onClick={() => moveStage(i, -1)}><Icons.chevronUp /></Button>
                <Button size='icon-sm' variant='ghost' aria-label='Move stage down' disabled={i === d.stages.length - 1} onClick={() => moveStage(i, 1)}><Icons.chevronDown /></Button>
                <Button size='icon-sm' variant='ghost' aria-label='Remove stage' disabled={d.stages.length === 1} onClick={() => set('stages', d.stages.filter((_, j) => j !== i))}><Icons.trash /></Button>
              </div>
              <div className='grid gap-3 sm:grid-cols-2'>
                <Field label='Title'><Input value={s.title} onChange={(e) => setStage(i, { title: e.target.value })} /></Field>
                <Field label='Why'><Input value={s.why} onChange={(e) => setStage(i, { why: e.target.value })} /></Field>
                <Field label='Prompt to paste' className='sm:col-span-2'><Textarea rows={2} className='font-mono text-xs' value={s.prompt} onChange={(e) => setStage(i, { prompt: e.target.value })} placeholder='Show my visibility report for {product}.' /></Field>
                <Field label="You'll see" className='sm:col-span-2'><Input value={s.expect} onChange={(e) => setStage(i, { expect: e.target.value })} /></Field>
              </div>
              <div>
                <Label className='text-xs'>Done when one of these tools runs {s.tools.length === 0 && <span className='text-muted-foreground font-normal'>(none: the customer marks it done)</span>}</Label>
                <div className='mt-2 flex flex-wrap gap-x-4 gap-y-2'>
                  {tools.map((t) => (
                    <label key={t} className='flex items-center gap-1.5 font-mono text-xs'>
                      <Checkbox checked={s.tools.includes(t)} onCheckedChange={(on) => setStage(i, { tools: on ? [...s.tools, t] : s.tools.filter((x) => x !== t) })} />{t}
                    </label>
                  ))}
                </div>
              </div>
            </li>
          ))}
        </ol>
        {err && <p className='text-destructive text-sm'>{err}</p>}
        <DialogFooter>
          <Button variant='outline' onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={save.isPending}>{save.isPending ? 'Saving…' : d.isNew ? 'Create journey' : 'Save journey'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return <div className={`space-y-1.5 ${className ?? ''}`}><Label className='text-xs'>{label}</Label>{children}</div>;
}
