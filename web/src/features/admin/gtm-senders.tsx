'use client';
// GTM › Campaigns › Senders (src/gtm-outbound.ts): the outbound sender identities. Cold email goes from its own
// subdomain (e.g. outreach.example.com, verified in Resend), never the product's sender domain, so a reputation
// problem there never reaches sign-in or billing email. Each identity has a daily cap that ramps up while it warms.
import { useState } from 'react';
import { StatStrip } from '@/components/layout/section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Icons } from '@/components/icons';
import { adminApi } from '@/lib/api-client';
import { post, useAdmin, useAdminAction } from './lib';
import { ConfirmButton, ErrorBox, FormRow, Notice, Section, StatusBadge } from './ui';
import { Gate, useAdminRole } from './role';

export interface Identity {
  id: number; from_name: string; from_address: string; domain: string; daily_cap: number; warmup_start: string | null; warmup_from: number; warmup_days: number; enabled: boolean;
  cap_today: number; sent_today: number; plan: { day: string; cap: number }[]; on_product_domain: boolean; problem: string | null; subdomain: boolean; active_campaigns: number;
}
export interface Identities { product_domain: string | null; identities: Identity[] }

const blank = { from_name: '', from_address: '', daily_cap: '200', warmup_start: new Date().toISOString().slice(0, 10), warmup_from: '20', warmup_days: '28' };

export function SendersView() {
  const { data, error } = useAdmin<Identities>('/gtm/identities');
  const [adding, setAdding] = useState(false);
  const list = data?.identities ?? [];
  return (
    <div className='flex min-w-0 flex-col gap-6'>
      <ErrorBox error={error} />
      <Notice tone='info'>
        Outbound sends from a subdomain of your main domain, such as outreach.example.com (or outreach.example.co.uk), verified as a sending domain in Resend (SPF, DKIM, DMARC).
        A bare domain, the product&apos;s sender domain{data?.product_domain ? ` (${data.product_domain})` : ''} and any parent of it are refused; lifecycle campaigns keep the product sender.
        {!data?.product_domain && data && ' The product sender (EMAIL_FROM) cannot be read right now, so every identity is refused until it is fixed.'}
      </Notice>
      <StatStrip items={[
        { label: 'Identities', value: list.length, hint: `${list.filter((i) => i.enabled).length} on` },
        { label: 'Cap today', value: list.filter((i) => i.enabled).reduce((t, i) => t + i.cap_today, 0), hint: 'all identities, warm-up applied' },
        { label: 'Sent today', value: list.reduce((t, i) => t + i.sent_today, 0), hint: 'UTC day, every campaign' }
      ]} />
      <div className='flex justify-end'><Gate need='campaigns'><Button onClick={() => setAdding((x) => !x)}><Icons.add /> {adding ? 'Cancel' : 'Add sender identity'}</Button></Gate></div>
      {adding && <IdentityForm onDone={() => setAdding(false)} />}
      {!list.length && !adding && <p className='text-muted-foreground text-sm'>No sender identities yet. Outbound campaigns cannot launch without one.</p>}
      {list.map((i) => <IdentityCard key={`${i.id}:${i.daily_cap}:${i.warmup_start}:${i.enabled}:${i.from_name}`} i={i} />)}
    </div>
  );
}

function IdentityForm({ i, onDone }: { i?: Identity; onDone: () => void }) {
  const [f, setF] = useState(i ? { from_name: i.from_name, from_address: i.from_address, daily_cap: String(i.daily_cap), warmup_start: i.warmup_start ?? '', warmup_from: String(i.warmup_from), warmup_days: String(i.warmup_days) } : blank);
  const body = { ...f, daily_cap: Number(f.daily_cap), warmup_from: Number(f.warmup_from), warmup_days: Number(f.warmup_days), warmup_start: f.warmup_start || null };
  const save = useAdminAction(() => (i ? adminApi('PUT', `/gtm/identities/${i.id}`, body) : post('/gtm/identities', body)), { success: i ? 'Saved' : 'Sender identity added' });
  const field = (k: keyof typeof f, label: string, type = 'text', hint?: string) => (
    <FormRow id={`si-${i?.id ?? 'new'}-${k}`} label={label} hint={hint}><Input id={`si-${i?.id ?? 'new'}-${k}`} type={type} value={f[k]} onChange={(e) => setF((v) => ({ ...v, [k]: e.target.value }))} /></FormRow>
  );
  return (
    <form className='grid gap-4 rounded-lg border p-4 sm:grid-cols-3' onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onDone }); }}>
      {field('from_name', 'From name', 'text', 'e.g. Priya at Octillion')}
      {field('from_address', 'From address', 'email', 'On the outreach subdomain')}
      {field('daily_cap', 'Daily cap once warm', 'number')}
      {field('warmup_start', 'Warm-up starts', 'date', 'Empty: no ramp, the full cap at once')}
      {field('warmup_from', 'First day cap', 'number')}
      {field('warmup_days', 'Ramp length (days)', 'number', 'Rises in a straight line to the daily cap')}
      <div className='flex gap-2 sm:col-span-3'>
        <Gate need='campaigns'><Button type='submit' disabled={save.isPending}><Icons.check /> {i ? 'Save changes' : 'Add identity'}</Button></Gate>
        {i && <Button type='button' variant='ghost' onClick={onDone}><Icons.close /> Cancel</Button>}
      </div>
    </form>
  );
}

function IdentityCard({ i }: { i: Identity }) {
  const { can } = useAdminRole();
  const [editing, setEditing] = useState(false);
  const toggle = useAdminAction((enabled: boolean) => adminApi('PUT', `/gtm/identities/${i.id}`, { enabled }), { success: (_r) => 'Saved' });
  const remove = useAdminAction(() => adminApi('DELETE', `/gtm/identities/${i.id}`), { success: 'Sender identity deleted' });
  const max = Math.max(1, ...i.plan.map((d) => d.cap));
  return (
    <Section title={<span className='flex flex-wrap items-center gap-2'>{i.from_name} &lt;{i.from_address}&gt;
      {!i.enabled && <StatusBadge tone='neutral'>off</StatusBadge>}{i.on_product_domain && <StatusBadge tone='bad'>product domain: refused</StatusBadge>}
      {i.problem && !i.on_product_domain && <StatusBadge tone='bad' title={i.problem}>refused: {i.problem}</StatusBadge>}
      {!i.problem && !i.subdomain && <StatusBadge tone='neutral'>another organisation&apos;s domain than the product&apos;s</StatusBadge>}</span>}
      description={`${i.sent_today} of ${i.cap_today} sent today (UTC) · cap ${i.daily_cap} once warm${i.warmup_start ? ` · warm-up from ${i.warmup_start}: ${i.warmup_from} a day rising over ${i.warmup_days} days` : ' · no warm-up ramp'} · ${i.active_campaigns} active campaign${i.active_campaigns === 1 ? '' : 's'}`}
      action={<span className='flex flex-wrap items-center gap-2'>
        <label className='flex items-center gap-2 text-sm'><Switch disabled={!can('campaigns') || toggle.isPending} checked={i.enabled} onCheckedChange={(v) => toggle.mutate(v)} /> On</label>
        <Gate need='campaigns'><Button size='sm' variant='outline' onClick={() => setEditing((x) => !x)}><Icons.edit /> Edit</Button></Gate>
        <Gate need='campaigns'><ConfirmButton variant='destructive' label={<><Icons.trash /> Delete</>} title={`Delete ${i.from_address}?`} confirmLabel='Delete'
          description='Campaigns using it stop sending until another identity is chosen. A running one must be paused first.' onConfirm={() => remove.mutate()} /></Gate>
      </span>}>
      {editing ? <IdentityForm i={i} onDone={() => setEditing(false)} /> : (
        <div className='flex flex-col gap-1'>
          <span className='text-muted-foreground text-xs'>Daily cap, the next five weeks</span>
          <div className='flex h-20 items-end gap-0.5' role='img' aria-label={`Warm-up: ${i.plan[0]?.cap ?? 0} today to ${i.plan.at(-1)?.cap ?? 0} in five weeks`}>
            {i.plan.map((d) => <div key={d.day} title={`${d.day}: ${d.cap}`} className='bg-primary/70 min-w-1 flex-1 rounded-t-sm' style={{ height: `${Math.max(2, (d.cap / max) * 100)}%` }} />)}
          </div>
          <span className='text-muted-foreground flex justify-between text-xs'><span>{i.plan[0]?.day}: {i.plan[0]?.cap}</span><span>{i.plan.at(-1)?.day}: {i.plan.at(-1)?.cap}</span></span>
        </div>
      )}
    </Section>
  );
}
