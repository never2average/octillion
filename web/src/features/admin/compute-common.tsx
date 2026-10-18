'use client';
// Formatting and URL state shared by the Compute page's sections (compute.tsx, compute-sessions.tsx,
// compute-orchestrators.tsx): durations, money, "est." labels, a ticking clock for relative times, and the query
// string that deep-links a section, its filters and an open record (?section=sessions&status=queued&session=ses_…).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { cn } from '@/lib/utils';

export const EST = 'Estimate from the boat price table (BOAT_PRICE_PER_HOUR), not boat\'s billing meter.';
export const money = (x: number) => `$${x.toFixed(2)}`;
/** Small amounts keep their cents' fractions ("$0.004"), so a cheap session does not read as free. */
export const cents = (x: number | null | undefined) => (x == null ? '—' : x > 0 && x < 0.01 ? `$${x.toFixed(3)}` : money(x));
/** "45 s", "2.1 min", "3 h". */
export const dur = (s: number | null | undefined) => (s == null ? '—' : s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${(s / 60).toFixed(1)} min` : `${(s / 3600).toFixed(1)} h`);
export const ageOf = (d: string | null | undefined) => (d ? Math.max(0, (Date.now() - new Date(d).getTime()) / 1000) : null);
export const since = (a: string | null | undefined, b?: string | null) => (a ? Math.max(0, ((b ? new Date(b).getTime() : Date.now()) - new Date(a).getTime()) / 1000) : null);
export const AMBER = 'text-amber-700 dark:text-amber-400';

/** Re-renders every `ms` so relative times ("12 s ago") stay current between fetches. */
export function useNow(ms = 5_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

/** A small outlined chip beside a value ("image", "retiring", "infra retry"). */
export function Chip({ children, title, tone }: { children: ReactNode; title?: string; tone?: 'warn' | 'bad' }) {
  return (
    <span title={title} className={cn('shrink-0 rounded border px-1 py-px text-[10px] leading-none whitespace-nowrap',
      tone === 'bad' ? 'border-destructive/40 text-destructive' : tone === 'warn' ? 'border-amber-500/50 ' + AMBER : 'text-muted-foreground')}>
      {children}
    </span>
  );
}

/** A heading inside a record peek. */
export function PeekSection({ title, children, action }: { title: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <section className='grid gap-2'>
      <div className='flex items-center justify-between gap-2'>
        <h3 className='text-muted-foreground text-xs font-medium tracking-wide uppercase'>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * The Compute page's query string: read, and written in place (replace, so Back leaves the page rather than undoing
 * a filter). Needs a Suspense boundary above it (useSearchParams).
 */
export function useComputeParams() {
  const params = useSearchParams(), router = useRouter(), pathname = usePathname();
  const s = params.toString();
  const p = useMemo(() => new URLSearchParams(s), [s]);
  const write = (patch: Record<string, string | null | undefined>) => {
    const next = new URLSearchParams(s);
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  return { get: (k: string) => p.get(k), has: (k: string) => p.has(k), write };
}

/** Scrolls to the section once when the URL names it (?section=sessions), after its first data arrives. */
export function useScrollTo(section: string, ready: boolean) {
  const { get } = useComputeParams();
  const done = useRef(false);
  const wanted = get('section') === section;
  useEffect(() => {
    if (done.current || !ready || !wanted) return;
    done.current = true;
    document.getElementById(`compute-${section}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [ready, wanted, section]);
}

/**
 * Keeps a deep-linked record in a list whatever its filters: once the open id is missing from the loaded rows, the
 * list asks for it by `include` until the record is closed. Rows clicked in the table are already there, so the list
 * never reorders under the pointer. Callers hold `pinned` in state and set it to this during render when it differs.
 */
export function nextPinned(open: string | null, ids: string[] | undefined, pinned: string | null): string | null {
  if (!open) return null;
  return ids && pinned !== open && !ids.includes(open) ? open : pinned;
}
