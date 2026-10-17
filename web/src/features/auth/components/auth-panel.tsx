import { cn } from '@/lib/utils';
import { InteractiveGridPattern } from './interactive-grid';

/** The left half of the sign-in and sign-up pages. */
export function AuthPanel() {
  return (
    <div className='relative hidden h-full flex-col p-10 lg:flex dark:border-r'>
      <div className='bg-sidebar absolute inset-0' />
      <div className='text-sidebar-foreground relative z-20 flex items-center gap-2 text-lg font-semibold'>
        <svg width='26' height='26' viewBox='0 0 32 32' aria-hidden='true'>
          <rect width='32' height='32' rx='7' fill='currentColor' />
          <path d='M16 6.5 22.7 9.3 25.5 16 22.7 22.7 16 25.5 9.3 22.7 6.5 16 9.3 9.3Z' fill='none' stroke='#ff5b2e' strokeWidth='3' strokeLinejoin='round' />
        </svg>
        Octillion
      </div>
      <InteractiveGridPattern className={cn('mask-[radial-gradient(400px_circle_at_center,white,transparent)]', 'inset-x-0 inset-y-[0%] h-full skew-y-12')} />
      <div className='text-sidebar-foreground relative z-20 mt-auto space-y-2'>
        <p className='text-lg'>SEO got you found by people. APO gets you picked by agents.</p>
        <p className='text-sidebar-foreground/70 text-sm'>See how often Claude Code, Codex and Cursor choose your product, and what to change.</p>
      </div>
    </div>
  );
}
