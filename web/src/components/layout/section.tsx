import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Flat page building blocks: the page is the container, so content sits in titled sections separated by space or a
 * hairline instead of boxed cards. Use a Card only for a dialog, a highlighted choice (e.g. a plan), or a call to action.
 */
export function Section({ title, description, action, children, className }: {
  title?: ReactNode; description?: ReactNode; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-3', className)}>
      {(title || action) && (
        <div className='flex flex-wrap items-end justify-between gap-2'>
          <div className='min-w-0'>
            {title && <h2 className='text-base font-semibold tracking-tight'>{title}</h2>}
            {description && <p className='text-muted-foreground text-sm'>{description}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/** A row of headline numbers divided by hairlines (wraps on small screens): replaces grids of stat cards. */
export function StatStrip({ items, className }: {
  items: { label: ReactNode; value: ReactNode; hint?: ReactNode; href?: string }[]; className?: string;
}) {
  return (
    <dl className={cn('grid grid-cols-2 border-y sm:flex sm:divide-x', className)}>
      {items.map((it, i) => {
        const body = (
          <>
            <dt className='text-muted-foreground text-xs font-medium'>{it.label}</dt>
            <dd className='mt-1 text-2xl font-semibold tabular-nums tracking-tight'>{it.value}</dd>
            {it.hint && <dd className='text-muted-foreground mt-0.5 text-xs'>{it.hint}</dd>}
          </>
        );
        return (
          <div key={i} className='min-w-0 flex-1 px-4 py-3 first:pl-0 max-sm:border-b max-sm:odd:pl-0 max-sm:even:border-l'>
            {it.href ? <a href={it.href} className='block hover:underline'>{body}</a> : body}
          </div>
        );
      })}
    </dl>
  );
}

/** A hairline between sections. */
export const Rule = () => <hr className='border-border' />;
