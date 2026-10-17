import Link from 'next/link';
import { cn } from '@/lib/utils';

/** The Octillion mark: an octagon on a rounded tile, tile in the foreground colour, octagon in the primary colour. */
export function OctillionMark({ className }: { className?: string }) {
  return (
    <svg viewBox='0 0 32 32' aria-hidden='true' className={cn('size-7', className)}>
      <rect width='32' height='32' rx='7' className='fill-foreground' />
      <path d='M16 6.5 22.7 9.3 25.5 16 22.7 22.7 16 25.5 9.3 22.7 6.5 16 9.3 9.3Z' fill='none' strokeWidth='3' strokeLinejoin='round' className='stroke-primary' />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <Link href='/' className={cn('flex items-center gap-2 font-semibold tracking-tight', className)} aria-label='Octillion home'>
      <OctillionMark />
      <span>Octillion</span>
    </Link>
  );
}
