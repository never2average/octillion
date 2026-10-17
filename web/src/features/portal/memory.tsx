'use client';
// Institutional memory on /app/context: the pieces the context table uses. A Gmail-style floating button and a compose
// window docked bottom-right (minimise, close) that edits a core field or adds and changes memory items.
import { useEffect, useState } from 'react';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';

export type MemoryScope = 'company' | 'user' | 'product';
export type Kind = 'fact' | 'decision' | 'preference' | 'note';
export interface MemoryItem { id: number; kind: Kind; body: string; created_by: string | null; created_at: string; can_delete: boolean }

export const KINDS: { id: Kind; label: string; hint: string }[] = [
  { id: 'fact', label: 'Fact', hint: 'e.g. Our Python SDK is in beta; the Node SDK is GA.' },
  { id: 'decision', label: 'Decision', hint: 'e.g. We stopped competing on price with Postmark in 2026.' },
  { id: 'preference', label: 'Preference', hint: 'e.g. Always compare against Resend first.' },
  { id: 'note', label: 'Note', hint: 'Anything the team should not have to explain twice.' }
];
export const TYPE_STYLE: Record<string, string> = {
  core: 'bg-secondary text-secondary-foreground',
  fact: 'bg-primary/15 text-primary',
  decision: 'bg-amber-500/15 text-amber-400',
  preference: 'bg-sky-500/15 text-sky-400',
  note: 'bg-muted text-muted-foreground',
  task: 'bg-violet-500/15 text-violet-300'
};

/** The floating "Remember" button, bottom-right. */
export function RememberFab({ onClick }: { onClick: () => void }) {
  return (
    <button type='button' onClick={onClick}
      className='bg-primary text-primary-foreground fixed right-6 bottom-6 z-40 flex items-center gap-2 rounded-2xl px-5 py-4 text-sm font-semibold shadow-xl shadow-black/40 transition-transform hover:scale-[1.03] focus-visible:ring-4 focus-visible:ring-primary/30 focus-visible:outline-none'>
      <Icons.edit className='size-5' /> Remember
    </button>
  );
}

/** A compose window docked bottom-right, Gmail-style: title bar that minimises, close, and the form inside. */
export function Dock({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const [min, setMin] = useState(false);
  useEffect(() => setMin(false), [title]);
  return (
    <div role='dialog' aria-label={title}
      className='bg-card fixed right-4 bottom-0 z-50 flex w-[min(460px,calc(100vw-2rem))] flex-col overflow-hidden rounded-t-xl border border-b-0 shadow-2xl shadow-black/50 sm:right-6'>
      <div className='bg-muted/60 flex items-center gap-2 px-4 py-2.5'>
        <button type='button' onClick={() => setMin((v) => !v)} className='min-w-0 flex-1 truncate text-left text-sm font-medium'>{title}</button>
        <button type='button' aria-label={min ? 'Expand' : 'Minimise'} onClick={() => setMin((v) => !v)} className='text-muted-foreground hover:text-foreground rounded p-1'>
          <Icons.minus className='size-4' />
        </button>
        <button type='button' aria-label='Close' onClick={onClose} className='text-muted-foreground hover:text-foreground rounded p-1'>
          <Icons.close className='size-4' />
        </button>
      </div>
      <div className={cn(min && 'hidden')}>{children}</div>
    </div>
  );
}
