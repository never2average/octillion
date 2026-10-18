import { AreaShell } from '@/components/layout/area-shell';
import { portalNav } from '@/config/nav-config';
import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { serverApi } from '@/lib/server-api';
import { NoOrganization } from '@/features/portal/no-organization';

export const metadata: Metadata = { title: { default: 'Account', template: '%s | Octillion' } };

/** The customer portal works on the user's active Clerk organization (switchable in the sidebar). */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const { orgId } = await auth.protect();
  if (!orgId) {
    // Octillion staff with no customer account of their own belong in the admin panel, not on "No Octillion account yet".
    const s = await serverApi<{ is_platform_admin: boolean }>('/admin/session').catch(() => null);
    if (s?.body?.is_platform_admin) redirect('/admin');
    return <NoOrganization />;
  }
  return <AreaShell area='portal' groups={portalNav}>{children}</AreaShell>;
}
