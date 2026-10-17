'use client';
// Profile on one flat page (no nested Account/Security tabs): details, email, connected sign-ins, password and active
// sessions, all read and written through Clerk's user object. Clerk stays the system of record for people.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession, useUser } from '@clerk/nextjs';
import type { SessionWithActivitiesResource } from '@clerk/shared/types';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { Section } from '@/components/layout/section';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

/** Clerk errors carry a list of messages; show the first one a person can act on. */
const clerkMessage = (e: unknown) =>
  (e as { errors?: { longMessage?: string; message?: string }[] })?.errors?.[0]?.longMessage ??
  (e as { errors?: { message?: string }[] })?.errors?.[0]?.message ?? (e as Error)?.message ?? 'Something went wrong';
const fail = (e: unknown) => toast.error(clerkMessage(e));
const providerName = (p: string) => p.replace(/^oauth_/, '').replace(/^\w/, (c) => c.toUpperCase());

export default function ProfileViewPage() {
  const { user, isLoaded } = useUser();
  return (
    <PageContainer pageTitle='Profile' pageDescription='Your name, how you sign in, and where you are signed in.'>
      {!isLoaded || !user ? <div className='flex max-w-3xl flex-col gap-4'><Skeleton className='h-24' /><Skeleton className='h-40' /></div> : (
        <div className='flex max-w-3xl flex-col gap-10'>
          <Details />
          <SignIn />
          <Password />
          <Sessions />
        </div>
      )}
    </PageContainer>
  );
}

function Details() {
  const { user } = useUser();
  const [f, setF] = useState({ firstName: user?.firstName ?? '', lastName: user?.lastName ?? '' });
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  if (!user) return null;
  const save = (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    user.update({ firstName: f.firstName.trim(), lastName: f.lastName.trim() }).then(() => toast.success('Name saved')).catch(fail).finally(() => setBusy(false));
  };
  const upload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const pic = e.target.files?.[0]; if (!pic) return;
    user.setProfileImage({ file: pic }).then(() => user.reload()).then(() => toast.success('Photo updated')).catch(fail);
  };
  const initials = `${user.firstName?.[0] ?? ''}${user.lastName?.[0] ?? ''}` || (user.primaryEmailAddress?.emailAddress?.[0] ?? '?');
  return (
    <Section title='Details' description='How you appear to your team and in invitations.'>
      <form onSubmit={save} className='flex flex-col gap-5 border-t pt-5'>
        <div className='flex items-center gap-4'>
          <Avatar className='size-14'><AvatarImage src={user.imageUrl} alt='' /><AvatarFallback>{initials.toUpperCase()}</AvatarFallback></Avatar>
          <input ref={file} type='file' accept='image/png,image/jpeg,image/webp,image/gif' className='hidden' onChange={upload} />
          <Button type='button' variant='outline' size='sm' onClick={() => file.current?.click()}>Change photo</Button>
        </div>
        <div className='grid gap-4 sm:grid-cols-2'>
          <div className='grid gap-1.5'><Label htmlFor='pFirst'>First name</Label><Input id='pFirst' maxLength={100} value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} /></div>
          <div className='grid gap-1.5'><Label htmlFor='pLast'>Last name</Label><Input id='pLast' maxLength={100} value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} /></div>
        </div>
        <div><Button type='submit' disabled={busy}>Save name</Button></div>
      </form>
    </Section>
  );
}

function SignIn() {
  const { user } = useUser();
  if (!user) return null;
  return (
    <Section title='Sign-in' description='The email and accounts you can sign in with.'>
      <ul className='divide-y border-y'>
        {user.emailAddresses.map((e) => (
          <li key={e.id} className='flex flex-wrap items-center gap-2 py-3 text-sm'>
            <span className='font-medium'>{e.emailAddress}</span>
            {user.primaryEmailAddressId === e.id && <Badge variant='secondary'>Primary</Badge>}
            {e.verification?.status === 'verified' ? <Badge variant='outline'>Verified</Badge> : <Badge variant='outline'>Unverified</Badge>}
          </li>
        ))}
        {user.externalAccounts.map((a) => (
          <li key={a.id} className='flex flex-wrap items-center gap-2 py-3 text-sm'>
            <span className='font-medium'>{providerName(a.provider)}</span>
            <span className='text-muted-foreground'>{a.emailAddress}</span>
            <Badge variant='outline'>Connected</Badge>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Password() {
  const { user } = useUser();
  const [f, setF] = useState({ current: '', next: '' });
  const [busy, setBusy] = useState(false);
  if (!user) return null;
  const has = user.passwordEnabled;
  const save = (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    user.updatePassword({ newPassword: f.next, ...(has ? { currentPassword: f.current } : {}), signOutOfOtherSessions: true })
      .then(() => { toast.success(has ? 'Password changed; other devices signed out' : 'Password set'); setF({ current: '', next: '' }); })
      .catch(fail).finally(() => setBusy(false));
  };
  return (
    <Section title='Password' description={has ? 'Changing it signs you out everywhere else.' : 'You sign in with a connected account. Add a password to sign in with your email too.'}>
      <form onSubmit={save} className='grid gap-4 border-t pt-5 sm:grid-cols-2'>
        {has && <div className='grid gap-1.5'><Label htmlFor='pwCur'>Current password</Label><Input id='pwCur' type='password' autoComplete='current-password' required value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></div>}
        <div className='grid gap-1.5'><Label htmlFor='pwNew'>New password</Label><Input id='pwNew' type='password' autoComplete='new-password' minLength={8} required value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></div>
        <div className='sm:col-span-2'><Button type='submit' disabled={busy}>{has ? 'Change password' : 'Set password'}</Button></div>
      </form>
    </Section>
  );
}

function Sessions() {
  const { user } = useUser();
  const { session } = useSession();
  const [list, setList] = useState<SessionWithActivitiesResource[] | null>(null);
  const load = useCallback(() => { user?.getSessions().then(setList).catch(fail); }, [user]);
  useEffect(() => { load(); }, [load]);
  const revoke = (s: SessionWithActivitiesResource) => s.revoke().then(() => { toast.success('Signed out of that device'); load(); }).catch(fail);
  return (
    <Section title='Where you’re signed in' description='Sign out of any device you don’t recognise.'>
      {!list ? <Skeleton className='h-16' /> : (
        <ul className='divide-y border-y'>
          {list.map((s) => {
            const a = s.latestActivity;
            const here = s.id === session?.id;
            return (
              <li key={s.id} className='flex flex-wrap items-center gap-x-3 gap-y-1 py-3 text-sm'>
                <span className='font-medium'>{[a?.browserName, a?.deviceType].filter(Boolean).join(' on ') || 'Unknown device'}</span>
                {here && <Badge variant='secondary'>This device</Badge>}
                <span className='text-muted-foreground'>{[a?.city, a?.country].filter(Boolean).join(', ')}{a?.ipAddress ? ` · ${a.ipAddress}` : ''}</span>
                <span className='text-muted-foreground ml-auto text-xs'>active {s.lastActiveAt.toLocaleString()}</span>
                {!here && <Button variant='ghost' size='sm' className='text-destructive' onClick={() => revoke(s)}>Sign out</Button>}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
