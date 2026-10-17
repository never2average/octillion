'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { IconMenu2 } from '@tabler/icons-react';
import { buttonVariants } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { Logo } from './logo';
import { SECTIONS } from './nav';

export function SiteHeader() {
  const { isSignedIn } = useAuth();
  const [open, setOpen] = useState(false);
  const account = isSignedIn
    ? { href: '/app', label: 'Open dashboard' }
    : { href: '/auth/sign-in', label: 'Sign in' };
  return (
    <header className='bg-background/80 supports-backdrop-filter:bg-background/60 sticky top-0 z-40 border-b backdrop-blur'>
      <div className='mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6'>
        <Logo />
        <nav aria-label='Sections' className='hidden items-center gap-1 lg:flex'>
          {SECTIONS.map((s) => (
            <Link key={s.href} href={s.href} className='text-muted-foreground hover:text-foreground rounded-md px-3 py-2 text-sm transition-colors'>
              {s.label}
            </Link>
          ))}
        </nav>
        <div className='ml-auto flex items-center gap-2'>
          <Link href={account.href} className={cn(buttonVariants({ variant: 'ghost' }), 'hidden sm:inline-flex')}>{account.label}</Link>
          <Link href='/#access' className={buttonVariants()}>Request access</Link>
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'lg:hidden')} aria-label='Open menu'>
              <IconMenu2 />
            </SheetTrigger>
            <SheetContent side='right' className='w-72'>
              <SheetHeader>
                <SheetTitle>Octillion</SheetTitle>
              </SheetHeader>
              <nav aria-label='Menu' className='flex flex-col gap-1 px-4 pb-6'>
                {[...SECTIONS, account].map((s) => (
                  <Link key={s.href} href={s.href} onClick={() => setOpen(false)} className='hover:bg-muted rounded-md px-3 py-2 text-sm'>
                    {s.label}
                  </Link>
                ))}
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
