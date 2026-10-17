import { AreaShell } from '@/components/layout/area-shell';
import { portalNav } from '@/config/nav-config';
import { auth } from '@clerk/nextjs/server';
import type { Metadata } from 'next';
import { NoOrganization } from '@/features/portal/no-organization';

export const metadata: Metadata = { title: { default: 'Account', template: '%s | Octillion' } };

/** The customer portal works on the user's active Clerk organization (switchable in the sidebar). */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const { orgId } = await auth.protect();
  if (!orgId) return <NoOrganization />;
  return <AreaShell area='portal' groups={portalNav}>{children}</AreaShell>;
}
