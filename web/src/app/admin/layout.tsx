import { AreaShell } from '@/components/layout/area-shell';
import { adminNav } from '@/config/nav-config';
import { serverApi } from '@/lib/server-api';
import { auth } from '@clerk/nextjs/server';
import { SignOutButton } from '@clerk/nextjs';
import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: { default: 'Admin', template: '%s | Octillion Admin' } };

/** Octillion staff only: the API server decides who is a platform admin (OCTILLION_PLATFORM_ADMINS, Clerk metadata). */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await auth.protect();
  const s = await serverApi<{ email: string | null; is_platform_admin: boolean }>('/admin/session');
  if (!s.body?.is_platform_admin) {
    return (
      <main className='flex min-h-screen items-center justify-center p-6'>
        <div className='max-w-md space-y-4 text-center'>
          <h1 className='text-2xl font-semibold'>Platform admins only</h1>
          <p className='text-muted-foreground'>
            {s.body?.email ? `${s.body.email} is not an Octillion platform admin.` : 'This account is not an Octillion platform admin.'} Your
            account&apos;s own settings are in the <Link className='underline' href='/app'>customer portal</Link>.
          </p>
          <SignOutButton redirectUrl='/auth/sign-in'><button className='text-sm underline'>Sign in with another account</button></SignOutButton>
        </div>
      </main>
    );
  }
  return <AreaShell area='admin' groups={adminNav}>{children}</AreaShell>;
}
