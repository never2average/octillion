'use client';
// GTM › Campaigns (src/campaigns.ts): lifecycle email to people who already gave us their address (account members and
// access requesters; never an imported list). The list, then a campaign in the peek: its numbers, the editor with an
// audience preview, a test send to an address typed in, and who it went to. Owners change campaigns; everyone reads.
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { StatStrip } from '@/components/layout/section';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { adminApi } from '@/lib/api-client';
import { downloadJson } from '@/lib/csv';
import { post, useAdmin, useAdminAction } from './lib';
import { ConfirmButton, DataList, ErrorBox, FormRow, Notice, Section, StatusBadge, When, type Tone } from './ui';
import { Gate, useAdminRole } from './role';
import { GtmTabs, useGtmParams } from './gtm-common';

type Status = 'draft' | 'scheduled' | 'running' | 'paused' | 'done';
interface Audience {
  include: 'accounts' | 'requests' | 'both'; stages: string[]; attention: string; created_from: string | null; created_to: string | null;
  utm_source: string; utm_medium: string; utm_campaign: string; plans: string[]; request_status: string[]; accounts: string[];
}
interface Step { subject: string; body: string; delay_days: number }
interface Metrics { recipients: number; suppressed: number; unsubscribed: number; failed: number; waiting: number; reached: number; sent: number; delivered: number; bounced: number; complained: number; opened: number; clicked: number }
interface Conversions { days: number; requested: number; activated: number; paid: number }
interface Campaign {
  id: number; name: string; status: Status; audience: Audience; steps: Step[]; rolling: boolean; conversion_days: number; starts_at: string | null;
  owner: string; created_at: string; updated_at: string; launched_at: string | null; finished_at: string | null; metrics?: Metrics; conversions?: Conversions | null;
}
interface List { email: { enabled: boolean; connected: boolean; from: string }; variables: string[]; stages: { id: string; label: string }[]; campaigns: Campaign[] }
interface Recipient {
  id: number; email: string; first_name: string | null; product: string | null; source: 'account' | 'request'; status: string; next_step: number; next_at: string | null;
  first_sent_at: string | null; last_sent_at: string | null; account: { slug: string; name: string } | null;
  delivered: boolean; bounced: boolean; opened: boolean; clicked: boolean; requested: boolean; activated: boolean; paid: boolean;
}
interface Detail { campaign: Campaign; conversions: Conversions | null; steps: (Step & { index: number; sent: number; failed: number; delivered: number; bounced: number; opened: number; clicked: number })[]; recipients: Recipient[] }
interface Preview { count: number; suppressed: number; sendable: number; by_source: { account: number; request: number };
  sample: { email: string; first_name: string | null; product: string | null; source: string; org_name: string | null; suppressed: boolean }[] }

const TONE: Record<Status, Tone> = { draft: 'neutral', scheduled: 'info', running: 'ok', paused: 'warn', done: 'neutral' };
const EDITABLE: Status[] = ['draft', 'scheduled', 'paused'];
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const path = (id: number) => `/gtm/campaigns/${id}`;
const EMPTY_AUDIENCE: Audience = { include: 'accounts', stages: ['onboarded'], attention: '', created_from: null, created_to: null, utm_source: '', utm_medium: '', utm_campaign: '', plans: [], request_status: [], accounts: [] };
const FIRST_STEP: Step = { subject: 'Your first simulation, {{first_name}}', body: 'Hi {{first_name}},\n\n{{product}} is set up on Octillion. The next step is a simulation: ask your AI client to "run a simulation" and you will see how coding agents pick {{product}}.\n\nReply if anything gets in the way.', delay_days: 0 };

/** "Accounts at Product onboarded, from newsletter": the audience in a few words. */
function audienceText(a: Audience, stages: { id: string; label: string }[]) {
  const who = a.include === 'accounts' ? 'Accounts' : a.include === 'requests' ? 'Access requesters' : 'Accounts and requesters';
  const bits = [
    a.accounts.length ? `${a.accounts.length} named account${a.accounts.length === 1 ? '' : 's'}` : null,
    a.stages.length ? `at ${a.stages.map((s) => stages.find((x) => x.id === s)?.label ?? s).join(' or ')}` : null,
    a.attention ? `needing "${a.attention}"` : null,
    a.request_status.length && a.include !== 'accounts' ? `requests ${a.request_status.join('/')}` : null,
    a.utm_campaign ? `campaign ${a.utm_campaign}` : null, a.utm_source ? `from ${a.utm_source}` : null, a.utm_medium ? `via ${a.utm_medium}` : null,
    a.plans.length ? `on ${a.plans.join(', ')}` : null,
    a.created_from || a.created_to ? `created ${a.created_from ?? '…'} to ${a.created_to ?? '…'}` : null
  ].filter(Boolean);
  return `${who}${bits.length ? ` ${bits.join(', ')}` : ''}`;
}

export function AdminCampaigns() {
  return <Suspense fallback={<PageContainer><Skeleton className='h-72 rounded-lg' /></PageContainer>}><CampaignsPage /></Suspense>;
}

function CampaignsPage() {
  const p = useGtmParams();
  const { data, error, isLoading } = useAdmin<List>('/gtm/campaigns', { refetchInterval: 30_000 });
  const open = p.open('open');
  const setOpen = (k: string | null) => p.write({ open: k });
  const fileRef = useRef<HTMLInputElement>(null);
  const create = useAdminAction((body: Record<string, unknown>) => post<Detail>('/gtm/campaigns', body), { success: (r) => `Created ${r.campaign.name}` });
  const stages = data?.stages ?? [];
  const list = data?.campaigns ?? [];
  const sum = (k: keyof Metrics) => list.reduce((t, c) => t + (c.metrics?.[k] ?? 0), 0);
  const conv = (k: keyof Omit<Conversions, 'days'>) => list.reduce((t, c) => t + (c.conversions?.[k] ?? 0), 0);

  const newCampaign = () => create.mutate({ name: 'Untitled campaign', audience: EMPTY_AUDIENCE, steps: [FIRST_STEP], conversion_days: 14 }, { onSuccess: (r) => setOpen(String(r.campaign.id)) });
  // Import: a campaign exported from here (JSON: name, audience, steps), saved as a new draft. Never a list of people.
  const importFile = async (f: File) => {
    try {
      const j = JSON.parse(await f.text());
      if (Array.isArray(j.recipients) || Array.isArray(j.emails)) throw new Error('Campaigns never import people: the audience is a filter over accounts and access requests');
      create.mutate({ name: j.name ?? f.name.replace(/\.json$/i, ''), audience: j.audience ?? EMPTY_AUDIENCE, steps: j.steps ?? [], rolling: j.rolling, conversion_days: j.conversion_days },
        { onSuccess: (r) => setOpen(String(r.campaign.id)) });
    } catch (e) { toast.error(`Not a campaign file: ${(e as Error).message}`); }
  };

  const m = (k: keyof Metrics) => (c: Campaign) => c.metrics?.[k] ?? 0;
  const num = (k: keyof Metrics, label: string, hidden = false): RecordCol<Campaign> => ({ key: k, label, type: 'number', hidden, value: m(k), render: (c) => <span className='tabular-nums'>{m(k)(c)}</span> });
  const cols: RecordCol<Campaign>[] = [
    { key: 'name', label: 'Campaign', title: true, keep: true, type: 'text', className: 'min-w-56', value: (c) => c.name, render: (c) => <span className='font-medium'>{c.name}</span> },
    { key: 'status', label: 'Status', type: 'select', keep: true, value: (c) => c.status, options: (['draft', 'scheduled', 'running', 'paused', 'done'] as const).map((s) => ({ value: s, label: s })),
      render: (c) => <span className='flex flex-col gap-1'><StatusBadge tone={TONE[c.status]}>{c.status}</StatusBadge>
        {c.status === 'scheduled' && c.starts_at && <span className='text-muted-foreground text-xs'>starts <When d={c.starts_at} /></span>}</span> },
    { key: 'audience', label: 'Audience', type: 'text', value: (c) => audienceText(c.audience, stages), render: (c) => <span className='text-muted-foreground line-clamp-2 text-sm'>{audienceText(c.audience, stages)}</span> },
    { key: 'steps', label: 'Emails', type: 'number', value: (c) => c.steps.length, render: (c) => <span className='tabular-nums'>{c.steps.length}</span> },
    num('recipients', 'Recipients'), num('sent', 'Sent'),
    { key: 'opened', label: 'Opened', type: 'number', value: m('opened'), render: (c) => <span className='tabular-nums'>{m('opened')(c)}<span className='text-muted-foreground text-xs'> · {pct(m('opened')(c), m('reached')(c))}</span></span> },
    num('clicked', 'Clicked', true), num('delivered', 'Delivered', true), num('bounced', 'Bounced', true), num('unsubscribed', 'Unsubscribed'),
    { key: 'activated', label: 'Activated', name: 'Activated after send', type: 'number', value: (c) => c.conversions?.activated ?? 0, render: (c) => <span className='tabular-nums'>{c.conversions?.activated ?? 0}</span> },
    { key: 'paid', label: 'Paid', name: 'Paid after send', type: 'number', hidden: true, value: (c) => c.conversions?.paid ?? 0, render: (c) => <span className='tabular-nums'>{c.conversions?.paid ?? 0}</span> },
    { key: 'owner', label: 'Owner', type: 'text', hidden: true, value: (c) => c.owner, render: (c) => c.owner },
    { key: 'updated_at', label: 'Updated', type: 'date', value: (c) => c.updated_at, render: (c) => <When d={c.updated_at} className='text-muted-foreground text-sm' /> }
  ];

  return (
    <PageContainer>
      <div className='flex min-w-0 flex-col gap-4'>
        <GtmTabs />
        <ErrorBox error={error} />
        {data && (!data.email.connected || !data.email.enabled) && (
          <Notice>Campaign emails are not going out: {!data.email.connected ? 'add a Resend key on Key vault' : 'turn on Send emails in Agent configuration'}. Drafts and previews still work.</Notice>
        )}
        <input ref={fileRef} type='file' accept='application/json,.json' className='hidden' onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ''; }} />
        <RecordView<Campaign>
          id='gtm-campaigns' noun='campaigns' exportName='campaigns' compact stacked loading={isLoading}
          rows={list} rowKey={(c) => String(c.id)} cols={cols}
          openKey={open} onOpenChange={setOpen}
          defaultSort={[{ key: 'updated_at', dir: 'desc' }]}
          searchText={(c) => `${c.name} ${c.status} ${c.owner} ${audienceText(c.audience, stages)} ${c.steps.map((s) => s.subject).join(' ')}`}
          searchPlaceholder='Search campaigns by name, status, owner, audience or subject'
          onImport={() => fileRef.current?.click()} importLabel='Import campaign'
          primary={<Gate need='campaigns'><Button disabled={create.isPending} onClick={newCampaign}><Icons.add className='size-4' /> New campaign</Button></Gate>}
          empty='No campaigns yet. Write one to the people who got stuck at a step.'
          summary={data && (
            <StatStrip items={[
              { label: 'Running', value: list.filter((c) => c.status === 'running').length, hint: `${list.filter((c) => c.status === 'scheduled').length} scheduled` },
              { label: 'Emails sent', value: sum('sent'), hint: `${sum('delivered')} delivered, ${sum('bounced')} bounced` },
              { label: 'Opened', value: pct(sum('opened'), sum('reached')), hint: `${sum('clicked')} clicked` },
              { label: 'Activated after', value: conv('activated'), hint: `${conv('requested')} requested access, ${conv('paid')} paid` },
              { label: 'Unsubscribed', value: sum('unsubscribed'), hint: `${sum('suppressed')} suppressed at send` }
            ]} />
          )}
          detailTitle={(c) => <span className='flex items-center gap-2'>{c.name}<StatusBadge tone={TONE[c.status]}>{c.status}</StatusBadge></span>}
          detail={(c, close) => <CampaignPeek id={c.id} stages={stages} onDeleted={close} />}
        />
      </div>
    </PageContainer>
  );
}

// ---------- one campaign ----------

function CampaignPeek({ id, stages, onDeleted }: { id: number; stages: { id: string; label: string }[]; onDeleted: () => void }) {
  const { data: d, error } = useAdmin<Detail>(path(id), { refetchInterval: 30_000 });
  if (error) return <ErrorBox error={error} />;
  if (!d) return <Skeleton className='h-96 rounded-lg' />;
  const c = d.campaign, mt = c.metrics;
  return (
    <div className='flex flex-col gap-8'>
      <Lifecycle c={c} onDeleted={onDeleted} />
      {mt && (
        <StatStrip items={[
          { label: 'Recipients', value: mt.recipients, hint: `${mt.waiting} waiting, ${mt.suppressed} suppressed` },
          { label: 'Sent', value: mt.sent, hint: `${mt.delivered} delivered, ${mt.bounced} bounced` },
          { label: 'Opened', value: pct(mt.opened, mt.reached), hint: `${mt.clicked} clicked` },
          { label: 'Unsubscribed', value: mt.unsubscribed, hint: mt.failed ? `${mt.failed} failed` : 'none failed' }
        ]} />
      )}
      {d.conversions && (
        <Section title={`Conversions within ${d.conversions.days} days of the first email`} description='From Activation: an access request from that address, the account’s first simulation, its first payment in Stripe.'>
          <StatStrip items={[
            { label: 'Requested access', value: d.conversions.requested },
            { label: 'Activated', value: d.conversions.activated },
            { label: 'Paid', value: d.conversions.paid }
          ]} />
        </Section>
      )}
      {d.steps.some((s) => s.sent) && (
        <Section title='By email'>
          <div className='border'>
            <DataList noun='emails' minWidth={560} rows={d.steps} empty='No emails.'
              cols={[
                { label: '#', className: 'w-10', render: (s) => s.index + 1 },
                { label: 'Subject', render: (s) => <span className='font-medium'>{s.subject}</span> },
                { label: 'Sent', render: (s) => <span className='tabular-nums'>{s.sent}{s.failed ? <span className='text-destructive text-xs'> · {s.failed} failed</span> : null}</span> },
                { label: 'Delivered', render: (s) => <span className='tabular-nums'>{s.delivered}</span> },
                { label: 'Opened', render: (s) => <span className='tabular-nums'>{s.opened} · {pct(s.opened, s.sent)}</span> },
                { label: 'Clicked', render: (s) => <span className='tabular-nums'>{s.clicked}</span> }
              ]} />
          </div>
        </Section>
      )}
      <Editor key={`${c.id}:${c.updated_at}`} c={c} stages={stages} />
      <TestSend c={c} />
      <Section title='Recipients' description='Who it goes to: enrolled when the campaign starts (and as people match, when it keeps enrolling).'>
        <div className='border'>
          <DataList<Recipient> noun='recipients' minWidth={760} height='h-[28rem]' rows={d.recipients}
            empty={c.status === 'draft' || c.status === 'scheduled' ? 'Nobody yet: people are enrolled when it starts.' : 'Nobody matched.'}
            cols={[
              { label: 'Person', render: (r) => <span className='flex flex-col gap-0.5'><span className='font-medium'>{r.first_name ?? r.email.split('@')[0]}</span><span className='text-muted-foreground text-xs'>{r.email}</span></span> },
              { label: 'From', render: (r) => <span className='text-sm'>{r.account ? r.account.name : r.source === 'request' ? 'Access request' : '—'}</span> },
              { label: 'Status', render: (r) => <StatusBadge tone={r.status === 'done' || r.status === 'active' ? 'ok' : ['unsubscribed', 'bounced', 'failed'].includes(r.status) ? 'bad' : r.status === 'suppressed' ? 'warn' : 'neutral'}>{r.status}</StatusBadge> },
              { label: 'Next', render: (r) => (r.next_at && ['pending', 'active'].includes(r.status) ? <span className='text-sm'>Email {r.next_step + 1} <When d={r.next_at} className='text-muted-foreground' /></span> : <span className='text-muted-foreground'>—</span>) },
              { label: 'Last sent', render: (r) => <When d={r.last_sent_at} className='text-muted-foreground text-sm' /> },
              { label: 'Engaged', render: (r) => <span className='text-muted-foreground text-xs'>{[r.delivered && 'delivered', r.opened && 'opened', r.clicked && 'clicked', r.bounced && 'bounced'].filter(Boolean).join(', ') || '—'}</span> },
              { label: 'Converted', render: (r) => <span className='text-xs'>{[r.requested && 'requested', r.activated && 'activated', r.paid && 'paid'].filter(Boolean).join(', ') || <span className='text-muted-foreground'>—</span>}</span> }
            ]} />
        </div>
      </Section>
    </div>
  );
}

/** Launch, schedule, pause, resume, end, delete, export: each a labelled button, owners only. */
function Lifecycle({ c, onDeleted }: { c: Campaign; onDeleted: () => void }) {
  const [at, setAt] = useState('');
  const act = useAdminAction((v: { action: string; body?: unknown }) => post<Detail>(`${path(c.id)}/${v.action}`, v.body ?? {}),
    { success: (r) => `${r.campaign.name}: ${r.campaign.status}` });
  const remove = useAdminAction(() => adminApi('DELETE', path(c.id)), { success: 'Campaign deleted' });
  const tick = useAdminAction(() => post<{ sent_now: number; waiting: number; skipped: string | null; busy: boolean }>(`${path(c.id)}/send-now`),
    { success: (r) => (r.skipped ? `Nothing sent: ${r.skipped}` : r.busy ? 'Another send is running: these go out on the next tick' : `${r.sent_now} sent, ${r.waiting} waiting`) });
  const exportJson = () => downloadJson(`campaign-${c.id}-${c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}.json`,
    { name: c.name, audience: c.audience, steps: c.steps, rolling: c.rolling, conversion_days: c.conversion_days });
  return (
    <div className='flex flex-col gap-3'>
      <p className='text-muted-foreground text-sm'>
        Owned by {c.owner}. {c.launched_at ? <>Started <When d={c.launched_at} />. </> : null}{c.finished_at ? <>Finished <When d={c.finished_at} />.</> : null}
      </p>
      <div className='flex flex-wrap items-center gap-2'>
        {c.status === 'draft' && (<>
          <Gate need='campaigns'>
            <ConfirmButton variant='default' label={<><Icons.send /> Launch now</>} title={`Launch ${c.name}?`} confirmLabel='Launch'
              description='Everyone the audience matches now is enrolled, and the first email goes out on the next tick (within 5 minutes).'
              onConfirm={() => act.mutate({ action: 'launch' })} disabled={!c.steps.length || act.isPending} />
          </Gate>
          <Input type='datetime-local' aria-label='Start at' className='h-7 w-52' value={at} onChange={(e) => setAt(e.target.value)} />
          <Gate need='campaigns'>
            <Button size='sm' variant='outline' disabled={!at || act.isPending} onClick={() => act.mutate({ action: 'launch', body: { at: new Date(at).toISOString() } })}><Icons.calendar /> Schedule</Button>
          </Gate>
        </>)}
        {(c.status === 'running' || c.status === 'scheduled') && <Gate need='campaigns'><Button size='sm' variant='outline' onClick={() => act.mutate({ action: 'pause' })}><Icons.clock /> Pause</Button></Gate>}
        {c.status === 'running' && <Gate need='campaigns'><Button size='sm' variant='outline' disabled={tick.isPending} onClick={() => tick.mutate()}><Icons.play /> Send what is due now</Button></Gate>}
        {c.status === 'paused' && <Gate need='campaigns'><Button size='sm' onClick={() => act.mutate({ action: 'resume' })}><Icons.play /> Resume</Button></Gate>}
        {c.status !== 'done' && c.status !== 'draft' && (
          <Gate need='campaigns'>
            <ConfirmButton label={<><Icons.circleX /> End</>} title={`End ${c.name}?`} confirmLabel='End campaign'
              description='Nobody gets another email from it. Its numbers stay.' onConfirm={() => act.mutate({ action: 'end' })} />
          </Gate>
        )}
        <Button size='sm' variant='ghost' onClick={exportJson}><Icons.download /> Export JSON</Button>
        {(c.status === 'draft' || c.status === 'done') && (
          <Gate need='campaigns'>
            <ConfirmButton variant='destructive' label={<><Icons.trash /> Delete</>} title={`Delete ${c.name}?`} confirmLabel='Delete'
              description='The campaign, its recipients and its numbers are deleted. Unsubscribes stay on the suppression list.'
              onConfirm={() => remove.mutate(undefined, { onSuccess: onDeleted })} />
          </Gate>
        )}
      </div>
    </div>
  );
}

const csv = (xs: string[]) => xs.join(', ');
const uncsv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

/** Name, audience (with a live preview) and the emails. Read-only once it runs: pause it to edit. */
function Editor({ c, stages }: { c: Campaign; stages: { id: string; label: string }[] }) {
  const { can } = useAdminRole();
  const editable = EDITABLE.includes(c.status) && can('campaigns');
  const [name, setName] = useState(c.name);
  const [a, setA] = useState<Audience>(c.audience);
  const [steps, setSteps] = useState<Step[]>(c.steps.length ? c.steps : [FIRST_STEP]);
  const [rolling, setRolling] = useState(c.rolling);
  const [days, setDays] = useState(String(c.conversion_days));
  const [plans, setPlans] = useState(csv(c.audience.plans));
  const [accounts, setAccounts] = useState(csv(c.audience.accounts));
  const audience = useMemo(() => ({ ...a, plans: uncsv(plans), accounts: uncsv(accounts) }), [a, plans, accounts]);
  const dirty = JSON.stringify({ name, audience, steps, rolling, days }) !== JSON.stringify({ name: c.name, audience: c.audience, steps: c.steps, rolling: c.rolling, days: String(c.conversion_days) });
  const save = useAdminAction(() => adminApi<Detail>('PUT', path(c.id), { name, audience, steps, rolling, conversion_days: Number(days) }), { success: 'Saved' });
  const set = <K extends keyof Audience>(k: K, v: Audience[K]) => setA((x) => ({ ...x, [k]: v }));
  const toggle = (k: 'stages' | 'request_status', v: string, on: boolean) => set(k, on ? [...a[k], v] : a[k].filter((x) => x !== v));
  const setStep = (i: number, patch: Partial<Step>) => setSteps((xs) => xs.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const dis = !editable;
  return (
    <Section title='Campaign' description={editable ? 'Changes apply to whoever has not had an email yet.' : c.status === 'running' ? 'Pause the campaign to change it.' : 'Read only.'}
      action={editable && <Button size='sm' disabled={!dirty || save.isPending} onClick={() => save.mutate()}><Icons.check /> {save.isPending ? 'Saving…' : 'Save changes'}</Button>}>
      <div className='grid gap-5'>
        <FormRow id={`c-${c.id}-name`} label='Name'><Input id={`c-${c.id}-name`} disabled={dis} value={name} onChange={(e) => setName(e.target.value)} /></FormRow>

        <fieldset className='grid gap-4 rounded-lg border p-4' disabled={dis}>
          <legend className='px-1 text-sm font-medium'>Audience</legend>
          <div className='grid gap-4 sm:grid-cols-2'>
            <FormRow id={`c-${c.id}-include`} label='Who' hint='Accounts: their active members (Clerk), else whoever asked for the account. Requesters: the person on the access request.'>
              <NativeSelect id={`c-${c.id}-include`} className='w-full' value={a.include} onChange={(e) => set('include', e.target.value as Audience['include'])}>
                <NativeSelectOption value='accounts'>Accounts</NativeSelectOption>
                <NativeSelectOption value='requests'>Access requesters</NativeSelectOption>
                <NativeSelectOption value='both'>Both</NativeSelectOption>
              </NativeSelect>
            </FormRow>
            <FormRow id={`c-${c.id}-attention`} label='Needs a person for' hint='Text an attention reason contains, e.g. "no simulation" or "report never opened".'>
              <Input id={`c-${c.id}-attention`} value={a.attention} onChange={(e) => set('attention', e.target.value)} placeholder='Any' />
            </FormRow>
          </div>
          <div className='grid gap-1.5'>
            <span className='text-sm leading-none font-medium'>Stage (the furthest step reached)</span>
            <div className='flex flex-wrap gap-x-4 gap-y-2'>
              {stages.map((s) => (
                <label key={s.id} className='flex items-center gap-2 text-sm leading-none'>
                  <Checkbox disabled={dis} checked={a.stages.includes(s.id)} onCheckedChange={(on) => toggle('stages', s.id, !!on)} />{s.label}
                </label>
              ))}
            </div>
          </div>
          {a.include !== 'accounts' && (
            <div className='grid gap-1.5'>
              <span className='text-sm leading-none font-medium'>Request status</span>
              <div className='flex flex-wrap gap-x-4 gap-y-2'>
                {['pending', 'approved', 'declined'].map((s) => (
                  <label key={s} className='flex items-center gap-2 text-sm leading-none capitalize'>
                    <Checkbox disabled={dis} checked={a.request_status.includes(s)} onCheckedChange={(on) => toggle('request_status', s, !!on)} />{s}
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className='grid gap-4 sm:grid-cols-3'>
            <FormRow id={`c-${c.id}-src`} label='utm_source'><Input id={`c-${c.id}-src`} value={a.utm_source} onChange={(e) => set('utm_source', e.target.value)} placeholder='Any' /></FormRow>
            <FormRow id={`c-${c.id}-med`} label='utm_medium'><Input id={`c-${c.id}-med`} value={a.utm_medium} onChange={(e) => set('utm_medium', e.target.value)} placeholder='Any' /></FormRow>
            <FormRow id={`c-${c.id}-camp`} label='utm_campaign'><Input id={`c-${c.id}-camp`} value={a.utm_campaign} onChange={(e) => set('utm_campaign', e.target.value)} placeholder='Any' /></FormRow>
          </div>
          <div className='grid gap-4 sm:grid-cols-2'>
            <FormRow id={`c-${c.id}-from`} label='Created from'><Input id={`c-${c.id}-from`} type='date' value={a.created_from ?? ''} onChange={(e) => set('created_from', e.target.value || null)} /></FormRow>
            <FormRow id={`c-${c.id}-to`} label='Created to'><Input id={`c-${c.id}-to`} type='date' value={a.created_to ?? ''} onChange={(e) => set('created_to', e.target.value || null)} /></FormRow>
            <FormRow id={`c-${c.id}-plans`} label='Plans' hint='Comma-separated plan names, or none.'><Input id={`c-${c.id}-plans`} value={plans} onChange={(e) => setPlans(e.target.value)} placeholder='Any' /></FormRow>
            <FormRow id={`c-${c.id}-accounts`} label='Only these accounts' hint='Comma-separated slugs.'><Input id={`c-${c.id}-accounts`} value={accounts} onChange={(e) => setAccounts(e.target.value)} placeholder='Any' /></FormRow>
          </div>
          <AudiencePreview audience={audience} />
        </fieldset>

        <fieldset className='grid gap-4' disabled={dis}>
          <legend className='mb-2 text-sm font-medium'>Emails <span className='text-muted-foreground font-normal'>· {'{{first_name}}'} and {'{{product}}'} are filled in for each person; an unsubscribe link is added at the end.</span></legend>
          {steps.map((s, i) => (
            <div key={i} className='grid gap-3 rounded-lg border p-4'>
              <div className='flex flex-wrap items-center gap-3'>
                <span className='text-sm font-medium'>Email {i + 1}</span>
                <label className='text-muted-foreground flex items-center gap-2 text-sm'>
                  {i ? 'days after the one before' : 'days after enrolment'}
                  <Input type='number' min={0} max={365} className='h-7 w-20' aria-label={`Delay in days for email ${i + 1}`} value={s.delay_days}
                    onChange={(e) => setStep(i, { delay_days: Math.max(0, Math.min(365, Math.trunc(Number(e.target.value) || 0))) })} />
                </label>
                {steps.length > 1 && <Button size='sm' variant='ghost' className='text-destructive ml-auto' onClick={() => setSteps((xs) => xs.filter((_, j) => j !== i))}><Icons.trash /> Remove email</Button>}
              </div>
              <Input aria-label={`Subject of email ${i + 1}`} placeholder='Subject' value={s.subject} onChange={(e) => setStep(i, { subject: e.target.value })} />
              <Textarea aria-label={`Body of email ${i + 1}`} rows={7} placeholder='Plain text' value={s.body} onChange={(e) => setStep(i, { body: e.target.value })} />
            </div>
          ))}
          {editable && steps.length < 10 && (
            <Button size='sm' variant='outline' className='self-start' onClick={() => setSteps((xs) => [...xs, { subject: '', body: '', delay_days: 3 }])}><Icons.add /> Add an email</Button>
          )}
        </fieldset>

        <div className='grid gap-4 sm:grid-cols-2'>
          <label htmlFor={`c-${c.id}-rolling`} className='flex items-start justify-between gap-3 text-sm'>
            <span><span className='font-medium'>Keep enrolling</span><span className='text-muted-foreground block text-xs'>People who match later join while it runs (checked every 5 minutes).</span></span>
            <Switch id={`c-${c.id}-rolling`} disabled={dis} checked={rolling} onCheckedChange={setRolling} />
          </label>
          <FormRow id={`c-${c.id}-days`} label='Count conversions within (days)'>
            <Input id={`c-${c.id}-days`} disabled={dis} type='number' min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} />
          </FormRow>
        </div>
      </div>
    </Section>
  );
}

/** How many the audience matches now, how many are suppressed, and the first few. Refreshes as the filter changes. */
function AudiencePreview({ audience }: { audience: Audience }) {
  const [q, setQ] = useState(audience);
  useEffect(() => { const t = setTimeout(() => setQ(audience), 500); return () => clearTimeout(t); }, [audience]);
  const { data, error, isFetching } = useQuery({ queryKey: ['admin', 'gtm-preview', JSON.stringify(q)], staleTime: 15_000, retry: false,
    queryFn: () => post<Preview>('/gtm/audience/preview', { audience: q }) });
  return (
    <div className='grid gap-2'>
      <div className='flex flex-wrap items-baseline gap-x-3 text-sm'>
        <span className='font-medium'>{data ? `${data.sendable} ${data.sendable === 1 ? 'person' : 'people'} would get it` : isFetching ? 'Counting…' : '—'}</span>
        {data && <span className='text-muted-foreground'>{data.count} match: {data.by_source.account} from accounts, {data.by_source.request} from requests{data.suppressed ? `, ${data.suppressed} suppressed` : ''}</span>}
      </div>
      {error && <p className='text-destructive text-sm'>{(error as Error).message}</p>}
      {!!data?.sample.length && (
        <div className='border'>
          <DataList noun='people' minWidth={520} rows={data.sample} empty='Nobody.'
            cols={[
              { label: 'Person', render: (s) => <span className='flex flex-col gap-0.5'><span>{s.first_name ?? '—'}</span><span className='text-muted-foreground text-xs'>{s.email}</span></span> },
              { label: '{{product}}', render: (s) => s.product ?? '—' },
              { label: 'From', render: (s) => (s.org_name ?? (s.source === 'request' ? 'Access request' : '—')) },
              { label: '', render: (s) => (s.suppressed ? <StatusBadge tone='warn'>suppressed</StatusBadge> : null) }
            ]} />
        </div>
      )}
    </div>
  );
}

/** One email to an address typed in, rendered for the first match (marked [Test]; its unsubscribe link does nothing). */
function TestSend({ c }: { c: Campaign }) {
  const [to, setTo] = useState('');
  const [step, setStep] = useState('0');
  const send = useAdminAction(() => post<{ status: string; error?: string | null }>(`${path(c.id)}/test`, { to: to.trim(), step: Number(step) }),
    { success: (r) => (r.status === 'sent' ? `Test sent to ${to.trim()}` : `Not sent: ${r.error ?? r.status}`) });
  return (
    <Section title='Test send' description='Saved content, filled in for the first person the audience matches. The subject starts with [Test].'>
      <form className='flex flex-wrap items-center gap-2' onSubmit={(e) => { e.preventDefault(); send.mutate(); }}>
        <Input type='email' required placeholder='you@octillion.dev' aria-label='Send a test to' className='h-8 max-w-72' value={to} onChange={(e) => setTo(e.target.value)} />
        <NativeSelect aria-label='Which email' className='h-8' value={step} onChange={(e) => setStep(e.target.value)}>
          {c.steps.map((s, i) => <NativeSelectOption key={i} value={String(i)}>Email {i + 1}: {s.subject.slice(0, 40)}</NativeSelectOption>)}
        </NativeSelect>
        <Gate need='campaigns'><Button type='submit' size='sm' variant='outline' disabled={!to.trim() || !c.steps.length || send.isPending}><Icons.send /> Send test</Button></Gate>
      </form>
    </Section>
  );
}
