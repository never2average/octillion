'use client';
import { OrganizationList, SignOutButton, useUser } from '@clerk/nextjs';

/** Signed in, but no account picked: choose one of your Octillion accounts, or ask your admin for an invitation. */
export function NoOrganization() {
  const { user } = useUser();
  return (
    <main className='flex min-h-screen flex-col items-center justify-center gap-6 p-6'>
      <div className='max-w-md text-center'>
        <h1 className='text-2xl font-semibold'>Choose your account</h1>
        <p className='text-muted-foreground mt-2'>
          Pick the Octillion account to open. Not listed? Ask your account admin to invite {user?.primaryEmailAddress?.emailAddress ?? 'you'}.
        </p>
      </div>
      <OrganizationList hidePersonal afterSelectOrganizationUrl='/app' afterCreateOrganizationUrl='/app' skipInvitationScreen={false} />
      <SignOutButton redirectUrl='/auth/sign-in'><button className='text-muted-foreground text-sm underline'>Sign out</button></SignOutButton>
    </main>
  );
}
