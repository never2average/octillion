'use client';
// /app Team: one flat page. People live in Clerk (the API server talks to it); account admins invite colleagues, set
// roles, and suspend or restore a person's Octillion access (their AI client and this portal) without removing them.
import { useState } from 'react';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { appApi } from '@/lib/api-client';
import { ErrorState, LoadingCards, When, fail, useOrgLoad } from './shared';

interface Member { id: string; user_id: string; status: string; role: string; created_at: string; email: string | null; name: string | null }
interface Invite { id: string; email: string; state: string; role?: string; created_at: string; expires_at: string }
interface Team { clerk: boolean; error: string | null; members: Member[]; invitations: Invite[]; me: string | null; can_manage: boolean }

/** A titled section without a card around it: the page is the container. */
function Section({ title, description, action, children }: { title: string; description?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className='flex flex-col gap-3'>
      <div className='flex flex-wrap items-end justify-between gap-2'>
        <div>
          <h2 className='text-base font-semibold'>{title}</h2>
          {description && <p className='text-muted-foreground text-sm'>{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function TeamPage() {
  const { data: t, error, reload } = useOrgLoad(() => appApi<Team>('GET', '/team'));
  const [email, setEmail] = useState(''), [role, setRole] = useState('member'), [sending, setSending] = useState(false);
  const [confirm, setConfirm] = useState<Member | null>(null);
  const act = (p: Promise<unknown>, msg: string) => p.then(() => { toast.success(msg); return reload(); }).catch(fail);

  const invite = (e: React.FormEvent) => {
    e.preventDefault();
    setSending(true);
    appApi('POST', '/team/invitations', { email: email.trim(), role })
      .then(() => { toast.success(`Invitation sent to ${email.trim()}`); setEmail(''); return reload(); })
      .catch(fail)
      .finally(() => setSending(false));
  };
  const setAccess = (m: Member, on: boolean) =>
    act(appApi('POST', `/team/members/${encodeURIComponent(m.id)}/${on ? 'reactivate' : 'deactivate'}`), on ? `Access restored for ${m.email}` : `Access suspended for ${m.email}`)
      .finally(() => setConfirm(null));

  return (
    <PageContainer pageTitle='Team' pageDescription='Who can use Octillion in your account. People sign in with Google, Microsoft, GitHub or email.'>
      {error ? <ErrorState error={error} /> : !t ? <LoadingCards count={2} /> : (
        <div className='flex max-w-5xl flex-col gap-8'>
          {t.error && <Alert variant='destructive'><AlertDescription>{t.error}</AlertDescription></Alert>}

          {t.can_manage && (
            <Section title='Invite people' description='They get an email from Clerk and join this account when they accept.'>
              <form onSubmit={invite} className='flex flex-col gap-2 sm:flex-row'>
                <Input type='email' required placeholder='name@company.com' value={email} onChange={(e) => setEmail(e.target.value)} className='sm:max-w-sm' aria-label='Email' />
                <NativeSelect value={role} onChange={(e) => setRole(e.target.value)} aria-label='Role' className='sm:w-40'>
                  <NativeSelectOption value='member'>Member</NativeSelectOption>
                  <NativeSelectOption value='admin'>Admin</NativeSelectOption>
                </NativeSelect>
                <Button type='submit' disabled={sending || !email.trim()}>{sending ? 'Sending…' : 'Send invitation'}</Button>
              </form>
              <p className='text-muted-foreground text-xs'>Admins invite people, set roles and manage limits and billing. Members use Octillion and see their own usage.</p>
            </Section>
          )}

          <Separator />

          <Section title='Members' description={t.can_manage
            ? 'Suspending someone cuts off their AI client and portal access within a minute; they stay in the account and can be restored.'
            : 'Ask an account admin to change roles or access.'}>
            <div className='overflow-x-auto'>
              <Table>
                <TableHeader>
                  <TableRow><TableHead>Person</TableHead><TableHead>Role</TableHead><TableHead>Access</TableHead><TableHead>Joined</TableHead><TableHead className='text-right' /></TableRow>
                </TableHeader>
                <TableBody>
                  {t.members.map((m) => {
                    const self = m.user_id === t.me, active = m.status === 'active';
                    return (
                      <TableRow key={m.id}>
                        <TableCell>
                          <div className='font-medium'>{m.name || m.email}{self && <span className='text-muted-foreground ml-2 text-xs font-normal'>you</span>}</div>
                          {m.name && <div className='text-muted-foreground text-xs'>{m.email}</div>}
                        </TableCell>
                        <TableCell>
                          {t.can_manage && !self ? (
                            <NativeSelect size='sm' value={m.role} aria-label={`Role for ${m.email}`} className='w-28'
                              onChange={(e) => act(appApi('POST', `/team/members/${encodeURIComponent(m.id)}/role`, { role: e.target.value }), `${m.email} is now ${e.target.value === 'admin' ? 'an admin' : 'a member'}`)}>
                              <NativeSelectOption value='member'>Member</NativeSelectOption>
                              <NativeSelectOption value='admin'>Admin</NativeSelectOption>
                            </NativeSelect>
                          ) : <Badge variant={m.role === 'admin' ? 'default' : 'outline'}>{m.role === 'admin' ? 'Admin' : 'Member'}</Badge>}
                        </TableCell>
                        <TableCell><Badge variant={active ? 'secondary' : 'destructive'}>{active ? 'Active' : 'Suspended'}</Badge></TableCell>
                        <TableCell className='text-muted-foreground'><When d={m.created_at} /></TableCell>
                        <TableCell className='text-right'>
                          {t.can_manage && !self && (active
                            ? <Button size='sm' variant='ghost' className='text-destructive' onClick={() => setConfirm(m)}>Suspend</Button>
                            : <Button size='sm' variant='outline' onClick={() => setAccess(m, true)}>Restore</Button>)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </Section>

          {t.invitations.length > 0 && (<>
            <Separator />
            <Section title='Pending invitations'>
              <div className='overflow-x-auto'>
                <Table>
                  <TableHeader><TableRow><TableHead>Email</TableHead><TableHead>Role</TableHead><TableHead>Status</TableHead><TableHead>Sent</TableHead><TableHead className='text-right' /></TableRow></TableHeader>
                  <TableBody>
                    {t.invitations.map((x) => (
                      <TableRow key={x.id}>
                        <TableCell className='font-medium'>{x.email}</TableCell>
                        <TableCell><Badge variant='outline'>{x.role === 'admin' ? 'Admin' : 'Member'}</Badge></TableCell>
                        <TableCell><Badge variant={x.state === 'expired' ? 'destructive' : 'secondary'}>{x.state === 'expired' ? 'Expired' : 'Pending'}</Badge></TableCell>
                        <TableCell className='text-muted-foreground'><When d={x.created_at} /></TableCell>
                        <TableCell className='text-right'>
                          {t.can_manage && (
                            <div className='flex justify-end gap-1'>
                              <Button size='sm' variant='ghost' onClick={() => act(appApi('POST', `/team/invitations/${encodeURIComponent(x.id)}/resend`), `Invitation resent to ${x.email}`)}>Resend</Button>
                              {x.state === 'pending' && <Button size='sm' variant='ghost' className='text-destructive' onClick={() => act(appApi('POST', `/team/invitations/${encodeURIComponent(x.id)}/revoke`), 'Invitation cancelled')}>Cancel</Button>}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Section>
          </>)}
        </div>
      )}

      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Suspend {confirm?.email}?</DialogTitle>
            <DialogDescription>Their AI client and this portal stop working for them within a minute. They stay in the account, and you can restore access any time.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant='outline' onClick={() => setConfirm(null)}>Keep access</Button>
            <Button variant='destructive' onClick={() => confirm && setAccess(confirm, false)}>Suspend</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}
