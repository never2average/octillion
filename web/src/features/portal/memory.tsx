'use client';
// Institutional memory on /app/context: short items beside the core fields (company, a user, a product), added from a
// Gmail-style compose window docked bottom-right and fed to the AI client as background (src/context.ts).
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { appApi } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { When, fail } from './shared';

export type MemoryScope = 'company' | 'user' | 'product';
interface Memory { id: number; kind: Kind; body: string; created_by: string | null; created_at: string; can_delete: boolean }
type Kind = 'fact' | 'decision' | 'preference' | 'note';

const KINDS: { id: Kind; label: string; hint: string }[] = [
  { id: 'fact', label: 'Fact', hint: 'e.g. Our Python SDK is in beta; the Node SDK is GA.' },
  { id: 'decision', label: 'Decision', hint: 'e.g. We stopped competing on price with Postmark in 2026.' },
  { id: 'preference', label: 'Preference', hint: 'e.g. Always compare against Resend first.' },
  { id: 'note', label: 'Note', hint: 'Anything the team should not have to explain twice.' }
];
const KIND_STYLE: Record<Kind, string> = {
  fact: 'bg-primary/15 text-primary',
  decision: 'bg-amber-500/15 text-amber-400',
  preference: 'bg-sky-500/15 text-sky-400',
  note: 'bg-muted text-muted-foreground'
};

/**
 * The memory for one subject: the list of items and the floating compose button. `label` names the subject in the
 * compose window ("Company", "Priya", "Resend"); `onChange` refreshes what the AI client is told.
 */
export function Memory({ scope, subject = '', label, onChange }: { scope: MemoryScope; subject?: string; label: string; onChange?: () => void }) {
  const [items, setItems] = useState<Memory[] | null>(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => {
    appApi<{ memories: Memory[] }>('GET', `/context/memories?scope=${scope}&subject=${encodeURIComponent(subject)}`).then((r) => setItems(r.memories)).catch(fail);
  }, [scope, subject]);
  useEffect(() => { setItems(null); load(); }, [load]);
  const remove = (m: Memory) => appApi('DELETE', `/context/memories/${m.id}`).then(() => { toast.success('Removed from memory'); load(); onChange?.(); }).catch(fail);
  return (
    <section className='flex flex-col gap-3'>
      <div className='flex flex-wrap items-end justify-between gap-2'>
        <div>
          <h2 className='text-base font-semibold tracking-tight'>Memory</h2>
          <p className='text-muted-foreground text-sm'>Facts, decisions and preferences the team adds over time. Your AI client reads the newest ones as background.</p>
        </div>
        <Button size='sm' variant='outline' onClick={() => setOpen(true)}><Icons.add /> Add</Button>
      </div>
      {!items ? <p className='text-muted-foreground text-sm'>Loading…</p> : !items.length ? (
        <button type='button' onClick={() => setOpen(true)} className='text-muted-foreground hover:border-primary/50 hover:text-foreground rounded-lg border border-dashed px-4 py-6 text-left text-sm transition-colors'>
          Nothing remembered yet. Add the first thing your team keeps re-explaining.
        </button>
      ) : (
        <ul className='divide-y border-y'>
          {items.map((m) => (
            <li key={m.id} className='group flex items-start gap-3 py-3'>
              <span className={cn('mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium', KIND_STYLE[m.kind] ?? KIND_STYLE.note)}>{m.kind}</span>
              <div className='min-w-0 flex-1'>
                <p className='text-sm whitespace-pre-wrap'>{m.body}</p>
                <p className='text-muted-foreground mt-1 text-xs'>{m.created_by ?? 'someone'} · <When d={m.created_at} /></p>
              </div>
              {m.can_delete && (
                <Button variant='ghost' size='icon' className='size-7 shrink-0 opacity-60 group-hover:opacity-100' aria-label='Remove from memory' onClick={() => remove(m)}>
                  <Icons.trash className='size-4' />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Composer open={open} onOpenChange={setOpen} scope={scope} subject={subject} label={label} onSaved={() => { load(); onChange?.(); }} />
    </section>
  );
}

/** Gmail-style: a floating "Remember" button bottom-right that opens a docked compose window (minimise, close). */
function Composer({ open, onOpenChange, scope, subject, label, onSaved }: {
  open: boolean; onOpenChange: (v: boolean) => void; scope: MemoryScope; subject: string; label: string; onSaved: () => void;
}) {
  const [min, setMin] = useState(false);
  const [kind, setKind] = useState<Kind>('fact');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (open) { setMin(false); setTimeout(() => area.current?.focus(), 0); } }, [open]);
  const save = (keepOpen: boolean) => {
    if (!body.trim()) return;
    setBusy(true);
    appApi('POST', '/context/memories', { scope, subject, kind, body: body.trim() })
      .then(() => { toast.success(`Remembered for ${label}`); setBody(''); onSaved(); if (!keepOpen) onOpenChange(false); else area.current?.focus(); })
      .catch(fail).finally(() => setBusy(false));
  };
  if (!open) {
    return (
      <button type='button' onClick={() => onOpenChange(true)}
        className='bg-primary text-primary-foreground fixed right-6 bottom-6 z-40 flex items-center gap-2 rounded-2xl px-5 py-4 text-sm font-semibold shadow-xl shadow-black/40 transition-transform hover:scale-[1.03] focus-visible:ring-4 focus-visible:ring-primary/30 focus-visible:outline-none'>
        <Icons.edit className='size-5' /> Remember
      </button>
    );
  }
  return (
    <div role='dialog' aria-label={`New memory for ${label}`}
      className='bg-card fixed right-4 bottom-0 z-50 flex w-[min(440px,calc(100vw-2rem))] flex-col overflow-hidden rounded-t-xl border border-b-0 shadow-2xl shadow-black/50 sm:right-6'>
      <div className='bg-muted/60 flex items-center gap-2 px-4 py-2.5'>
        <button type='button' onClick={() => setMin((v) => !v)} className='min-w-0 flex-1 truncate text-left text-sm font-medium'>New memory · {label}</button>
        <button type='button' aria-label={min ? 'Expand' : 'Minimise'} onClick={() => setMin((v) => !v)} className='text-muted-foreground hover:text-foreground rounded p-1'>
          <Icons.minus className='size-4' />
        </button>
        <button type='button' aria-label='Close' onClick={() => onOpenChange(false)} className='text-muted-foreground hover:text-foreground rounded p-1'>
          <Icons.close className='size-4' />
        </button>
      </div>
      {!min && (
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
            <Button type='submit' disabled={busy || !body.trim()}>Save to memory</Button>
            <Button type='button' variant='ghost' disabled={busy || !body.trim()} onClick={() => save(true)}>Save & add another</Button>
            <span className='text-muted-foreground ml-auto text-xs tabular-nums'>{body.length}/1000</span>
          </div>
        </form>
      )}
    </div>
  );
}
