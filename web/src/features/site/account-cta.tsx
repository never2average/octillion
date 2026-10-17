'use client';
import Link from 'next/link';
import { useAuth } from '@clerk/nextjs';
import { IconArrowRight } from '@tabler/icons-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Where the account button goes: sign in, or straight into the dashboard when already signed in. */
export function useAccountLink() {
  const { isSignedIn } = useAuth();
  return isSignedIn ? { href: '/app', label: 'Open dashboard' } : { href: '/auth/sign-in', label: 'Sign in' };
}

/** The site's primary call to action. */
export function AccountButton({ size, className }: { size?: 'default' | 'lg'; className?: string }) {
  const a = useAccountLink();
  return (
    <Link href={a.href} className={cn(buttonVariants({ size }), className)}>
      {a.label} <IconArrowRight />
    </Link>
  );
}
