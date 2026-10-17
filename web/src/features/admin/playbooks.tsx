'use client';
// Customer journeys: the use-case pipelines customers follow on /app Setup. The editor used by the
// Journeys table (journeys.tsx); write journeys there and promote the ones customers see. Progress on /app comes from real tool calls (src/playbooks.ts).
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { adminApi } from '@/lib/api-client';
import { post, useAdminAction } from './lib';

export interface Stage { id?: string; title: string; why: string; prompt: string; tools: string[]; expect: string; manual?: boolean }
export interface Playbook {
  id: string; name: string; outcome: string; who: string; time: string; example: { title: string; result: string };
  stages: Stage[]; promoted: boolean; updated_at: string; updated_by: string | null;
  adoption?: { started: number; completed: number; median_hours_to_complete: number | null; dropoff: { id: string; title: string; lost: number } | null;
    last_activity: string | null; funnel: { id: string; title: string; reached: number }[] };
  accounts_active?: number;
}
export type Draft = Omit<Playbook, 'promoted' | 'updated_at' | 'updated_by' | 'adoption' | 'accounts_active'> & { isNew: boolean };

const emptyStage = (): Stage => ({ title: '', why: '', prompt: '', tools: [], expect: '' });
// Journeys are not ordered, so the draft carries only what the editor writes (no ordering, no adoption).
export const toDraft = (p: Playbook): Draft => ({ id: p.id, name: p.name, outcome: p.outcome, who: p.who, time: p.time, example: { ...p.example },
  stages: p.stages.map((s) => ({ ...s, tools: [...s.tools] })), isNew: false });
export const blank = (): Draft => ({ id: '', name: '', outcome: '', who: '', time: '', example: { title: '', result: '' }, stages: [emptyStage()], isNew: true });

export function Editor({ draft: initial, tools, onClose }: { draft: Draft; tools: string[]; onClose: () => void }) {
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
