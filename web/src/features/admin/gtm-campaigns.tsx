'use client';
// GTM › Campaigns (src/campaigns.ts): lifecycle email to people who already gave us their address (account members and
// access requesters; never an imported list). The list, then a campaign in the peek: its numbers, the editor with an
// audience preview, a test send to an address typed in, and who it went to. Owners change campaigns; everyone reads.
// Outbound (src/gtm-outbound.ts): an audience of prospects, sent from a sender identity on the outreach subdomain
// (the Senders view manages them and their warm-up), text only unless the campaign tracks opens.
import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { StatStrip } from '@/components/layout/section';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { DetailMeta, DetailTable, DetailTabs, KeyValueTable, type DetailTab, type KV } from '@/components/layout/detail';
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
import { ConfirmButton, ErrorBox, Notice, StatusBadge, When, type Tone } from './ui';
import { Gate, useAdminRole } from './role';
import { formKV, GtmTabs, useGtmParams } from './gtm-common';
import { CampaignReplies, RepliesView, type Replies } from './gtm-replies';
import { SendersView, type Identities } from './gtm-senders';

type Status = 'draft' | 'scheduled' | 'running' | 'paused' | 'done';
interface ProspectFilter { statuses: string[]; tags: string[]; titles: string[]; sizes: string[]; industries: string[]; countries: string[]; owners: string[]; email_statuses: string[]; prospect_ids: number[] }
interface Audience {
  include: 'accounts' | 'requests' | 'both' | 'prospects'; stages: string[]; attention: string; created_from: string | null; created_to: string | null;
  utm_source: string; utm_medium: string; utm_campaign: string; plans: string[]; request_status: string[]; accounts: string[]; prospects?: ProspectFilter;
}
interface Variant { subject: string; body: string; weight: number }
interface Step { subject: string; body: string; delay_days: number; variants?: Variant[] }
type TriggerType = 'account_created' | 'request_submitted' | 'request_approved' | 'stage_reached' | 'stuck' | 'report_opened' | 'first_payment' | 'attention';
interface Trigger { type: TriggerType; stage: string | null; days: number | null; attention: string; delay_hours: number; reentry: 'once' | 'every'; reentry_days: number }
interface SendWindow { days: number[]; start_hour: number; end_hour: number; time_zone: string }
interface Metrics { recipients: number; suppressed: number; unsubscribed: number; failed: number; waiting: number; reached: number; replied: number; replies_open: number; no_consent: number; uncertain: number; unknown: number; sent: number; delivered: number; bounced: number; complained: number; opened: number; clicked: number }
interface Conversions { days: number; requested: number; activated: number; paid: number }
interface Campaign {
  id: number; name: string; status: Status; audience: Audience; steps: Step[]; rolling: boolean; conversion_days: number; starts_at: string | null;
  owner: string; created_at: string; updated_at: string; launched_at: string | null; finished_at: string | null; metrics?: Metrics; conversions?: Conversions | null;
  trigger: Trigger | null; send_window: SendWindow; requires_opt_in: boolean | null; requires_opt_in_effective: boolean; count_auto_replies: boolean;
  outbound?: boolean; sender_identity_id?: number | null; track_opens?: boolean | null; track_opens_effective?: boolean; allow_restricted?: boolean;
}
interface Setup { postal_address_set: boolean; postal_hint: string | null; replies_inbox: string | null; outbound_postal_warning?: string | null }
interface List { email: { enabled: boolean; connected: boolean; from: string }; setup: Setup; variables: string[]; stages: { id: string; label: string }[]; campaigns: Campaign[] }
interface Recipient {
  id: number; email: string; first_name: string | null; product: string | null; source: 'account' | 'request'; status: string; next_step: number; next_at: string | null;
  first_sent_at: string | null; last_sent_at: string | null; replied_at: string | null; round: number; time_zone: string; country: string | null; consent_basis: string | null;
  account: { slug: string; name: string } | null;
  delivered: boolean; bounced: boolean; opened: boolean; clicked: boolean; requested: boolean; activated: boolean; paid: boolean;
}
interface ZTest { z: number | null; p: number | null; significant: boolean; small: boolean }
interface VariantStat { letter: string; subject: string; weight: number; sent: number; opened: number; clicked: number; replied: number; converted: number; reply_test: ZTest | null; conversion_test: ZTest | null }
interface Detail {
  campaign: Campaign; setup: Setup; conversions: Conversions | null; events: { matched: number; queued: number; enrolled: number; skipped: number } | null;
  steps: (Step & { index: number; sent: number; failed: number; delivered: number; bounced: number; opened: number; clicked: number; variant_stats: VariantStat[] })[];
  recipients: Recipient[]; replies: Replies;
}
interface Preview { count: number; suppressed: number; no_consent: number; sendable: number; requires_opt_in: boolean; by_source: { account: number; request: number; prospect?: number }; blocked?: Record<string, number>;
  sample: { email: string; first_name: string | null; product: string | null; source: string; org_name: string | null; suppressed: boolean; consent: string }[] }

const TRIGGERS: { id: TriggerType; label: string; who: 'account' | 'request' }[] = [
  { id: 'account_created', label: 'Account created', who: 'account' },
  { id: 'request_submitted', label: 'Access request submitted', who: 'request' },
  { id: 'request_approved', label: 'Access request approved', who: 'request' },
  { id: 'stage_reached', label: 'Stage reached', who: 'account' },
  { id: 'stuck', label: 'Stuck at a stage', who: 'account' },
  { id: 'report_opened', label: 'Report opened', who: 'account' },
  { id: 'first_payment', label: 'First payment', who: 'account' },
  { id: 'attention', label: 'Needs attention (a reason appears)', who: 'account' }
];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const LETTERS = ['A', 'B', 'C', 'D'];
const NO_WINDOW: SendWindow = { days: [], start_hour: 9, end_hour: 17, time_zone: 'UTC' };
const CONSENT_LABEL: Record<string, string> = { opt_in: 'opted in', legitimate_interest: 'existing customer', opt_out: 'opt-out basis', needs_opt_in: 'needs opt-in', withdrawn: 'withdrew',
  consent: 'consent', contract: 'contract', customer: 'existing customer: never cold', in_sequence: 'in another sequence', cooling_off: 'emailed recently by another outbound campaign', member_check: 'customers not checked yet', restricted: 'EU / EEA / UK / CH: not allowed', status: 'replied or not interested', no_prospect: 'not a prospect' };
/** Why prospects are left out of an outbound audience (src/gtm-outbound.ts BLOCK_TEXT). */
const BLOCK_LABEL: Record<string, string> = { customer: 'existing customers', in_sequence: 'in another active sequence', cooling_off: 'emailed by another outbound campaign in the last 30 days',
  member_check: 'not checked against customers (Clerk did not answer): not this time', restricted: 'in the EU / EEA / UK / CH (not allowed here)',
  withdrawn: 'withdrew consent', status: 'replied, interested or not interested', no_prospect: 'no longer prospects' };
const PROSPECT_STATUSES = [{ id: 'new', label: 'New' }, { id: 'contacted', label: 'Contacted' }];
const EMAIL_STATUSES = ['verified', 'likely_to_engage', 'unverified', 'extrapolated', 'unknown'];
const SIZES = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5001+'];
const DEFAULT_PROSPECTS: ProspectFilter = { statuses: ['new', 'contacted'], tags: [], titles: [], sizes: [], industries: [], countries: [], owners: [], email_statuses: ['verified'], prospect_ids: [] };
/** Outbound or lifecycle, as a badge. */
const KindBadge = ({ c }: { c: Campaign }) => (c.audience.include === 'prospects' ? <StatusBadge tone='info'>outbound</StatusBadge> : <StatusBadge tone='neutral'>lifecycle</StatusBadge>);

/** "Account created, 2h later": the trigger in a few words. */
function triggerText(t: Trigger | null, stages: { id: string; label: string }[]) {
  if (!t) return null;
  const stage = t.stage ? stages.find((s) => s.id === t.stage)?.label ?? t.stage : null;
  const what = t.type === 'stage_reached' ? `Reached ${stage}` : t.type === 'stuck' ? `Stuck at ${stage} for ${t.days}d` : t.type === 'attention' && t.attention ? `Needs attention: "${t.attention}"`
    : TRIGGERS.find((x) => x.id === t.type)?.label ?? t.type;
  return `${what}${t.delay_hours ? `, ${t.delay_hours}h later` : ''}${t.reentry === 'every' ? `, again after ${t.reentry_days}d` : ''}`;
}

const TONE: Record<Status, Tone> = { draft: 'neutral', scheduled: 'info', running: 'ok', paused: 'warn', done: 'neutral' };
const EDITABLE: Status[] = ['draft', 'scheduled', 'paused'];
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const path = (id: number) => `/gtm/campaigns/${id}`;
const EMPTY_AUDIENCE: Audience = { include: 'accounts', stages: ['onboarded'], attention: '', created_from: null, created_to: null, utm_source: '', utm_medium: '', utm_campaign: '', plans: [], request_status: [], accounts: [] };
const FIRST_STEP: Step = { subject: 'Your first simulation, {{first_name}}', body: 'Hi {{first_name}},\n\n{{product}} is set up on Octillion. The next step is a simulation: ask your AI client to "run a simulation" and you will see how coding agents pick {{product}}.\n\nReply if anything gets in the way.', delay_days: 0 };

/** "Accounts at Product onboarded, from newsletter": the audience in a few words. */
function audienceText(a: Audience, stages: { id: string; label: string }[]) {
  if (a.include === 'prospects') {
    const f = a.prospects ?? DEFAULT_PROSPECTS;
    const bits = [f.prospect_ids.length ? `${f.prospect_ids.length} chosen` : null, f.statuses.length ? f.statuses.join('/') : null, f.titles.length ? `titles ${f.titles.join(', ')}` : null,
      f.tags.length ? `tagged ${f.tags.join(', ')}` : null, f.sizes.length ? `size ${f.sizes.join(', ')}` : null, f.industries.length ? `in ${f.industries.join(', ')}` : null,
      f.countries.length ? `from ${f.countries.join(', ')}` : null, f.email_statuses.length ? `${f.email_statuses.join('/')} address` : null].filter(Boolean);
    return `Prospects${bits.length ? `: ${bits.join(', ')}` : ''}`;
  }
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
  const newOutbound = () => create.mutate({ name: 'Untitled outbound campaign', audience: { ...EMPTY_AUDIENCE, stages: [], include: 'prospects', prospects: DEFAULT_PROSPECTS }, conversion_days: 30,
    steps: [{ subject: 'A question about {{product}}', body: 'Hi {{first_name}},\n\n…', delay_days: 0 }] }, { onSuccess: (r) => setOpen(String(r.campaign.id)) });
  // Import: a campaign exported from here (JSON: name, audience, steps), saved as a new draft. Never a list of people.
  const importFile = async (f: File) => {
    try {
      const j = JSON.parse(await f.text());
      if (Array.isArray(j.recipients) || Array.isArray(j.emails)) throw new Error('Campaigns never import people: the audience is a filter over accounts and access requests');
      create.mutate({ name: j.name ?? f.name.replace(/\.json$/i, ''), audience: j.audience ?? EMPTY_AUDIENCE, steps: j.steps ?? [], rolling: j.rolling, conversion_days: j.conversion_days,
        trigger: j.trigger ?? null, send_window: j.send_window ?? NO_WINDOW, requires_opt_in: j.requires_opt_in ?? null, count_auto_replies: j.count_auto_replies === true },
        { onSuccess: (r) => setOpen(String(r.campaign.id)) });
    } catch (e) { toast.error(`Not a campaign file: ${(e as Error).message}`); }
  };

  const m = (k: keyof Metrics) => (c: Campaign) => c.metrics?.[k] ?? 0;
  const num = (k: keyof Metrics, label: string, hidden = false): RecordCol<Campaign> => ({ key: k, label, type: 'number', hidden, value: m(k), render: (c) => <span className='tabular-nums'>{m(k)(c)}</span> });
  const who = (c: Campaign) => triggerText(c.trigger, stages) ?? audienceText(c.audience, stages);
  const cols: RecordCol<Campaign>[] = [
    { key: 'name', label: 'Campaign', title: true, keep: true, type: 'text', className: 'min-w-56', value: (c) => c.name, render: (c) => <span className='font-medium'>{c.name}</span> },
    { key: 'status', label: 'Status', type: 'select', keep: true, value: (c) => c.status, options: (['draft', 'scheduled', 'running', 'paused', 'done'] as const).map((s) => ({ value: s, label: s })),
      render: (c) => <span className='flex flex-col items-start gap-1'><span className='flex gap-1'><StatusBadge tone={TONE[c.status]}>{c.status}</StatusBadge><KindBadge c={c} /></span>
        {c.status === 'scheduled' && c.starts_at && <span className='text-muted-foreground text-xs'>starts <When d={c.starts_at} /></span>}</span> },
    { key: 'audience', label: 'Audience', type: 'text', value: who, render: (c) => <span className='text-muted-foreground line-clamp-2 text-sm'>{c.trigger ? <><span className='text-foreground font-medium'>Triggered:</span> {who(c)}</> : who(c)}</span> },
    { key: 'steps', label: 'Emails', type: 'number', value: (c) => c.steps.length, render: (c) => <span className='tabular-nums'>{c.steps.length}</span> },
    num('recipients', 'Recipients'), num('sent', 'Sent'),
    { key: 'opened', label: 'Opened', type: 'number', value: m('opened'), render: (c) => <span className='tabular-nums'>{m('opened')(c)}<span className='text-muted-foreground text-xs'> · {pct(m('opened')(c), m('reached')(c))}</span></span> },
    { key: 'replied', label: 'Replied', type: 'number', value: m('replied'), render: (c) => <span className='tabular-nums'>{m('replied')(c)}{m('replies_open')(c) ? <span className='text-primary text-xs'> · {m('replies_open')(c)} open</span> : null}</span> },
    num('clicked', 'Clicked', true), num('delivered', 'Delivered', true), num('bounced', 'Bounced', true), num('unsubscribed', 'Unsubscribed'),
    { key: 'activated', label: 'Activated', name: 'Activated after send', type: 'number', value: (c) => c.conversions?.activated ?? 0, render: (c) => <span className='tabular-nums'>{c.conversions?.activated ?? 0}</span> },
    { key: 'paid', label: 'Paid', name: 'Paid after send', type: 'number', hidden: true, value: (c) => c.conversions?.paid ?? 0, render: (c) => <span className='tabular-nums'>{c.conversions?.paid ?? 0}</span> },
    { key: 'owner', label: 'Owner', type: 'text', hidden: true, value: (c) => c.owner, render: (c) => c.owner },
    { key: 'updated_at', label: 'Updated', type: 'date', value: (c) => c.updated_at, render: (c) => <When d={c.updated_at} className='text-muted-foreground text-sm' /> }
  ];

  // Replies are personal data: the view is the campaigns permission's (the server refuses it to anyone else).
  const { can } = useAdminRole();
  const view = p.open('view') === 'replies' && can('campaigns') ? 'replies' : p.open('view') === 'senders' && can('campaigns') ? 'senders' : 'campaigns';
  const openReplies = list.reduce((t, c) => t + (c.metrics?.replies_open ?? 0), 0);
  // Campaigns and Replies: two views of the Campaigns tab (labelled buttons), kept in the URL like the open peek.
  const subViews = (
    <div className='flex items-center gap-1' role='group' aria-label='Campaigns views'>
      <Button size='sm' variant={view === 'campaigns' ? 'secondary' : 'ghost'} aria-pressed={view === 'campaigns'} onClick={() => p.write({ view: null, open: null })}><Icons.mail /> Campaigns</Button>
      {can('campaigns') && (
        <Button size='sm' variant={view === 'replies' ? 'secondary' : 'ghost'} aria-pressed={view === 'replies'} onClick={() => p.write({ view: 'replies', open: null })}>
          <Icons.inbox /> Replies{openReplies ? ` (${openReplies} open)` : ''}
        </Button>
      )}
      {can('campaigns') && <Button size='sm' variant={view === 'senders' ? 'secondary' : 'ghost'} aria-pressed={view === 'senders'} onClick={() => p.write({ view: 'senders', open: null })}><Icons.send /> Senders</Button>}
    </div>
  );

  return (
    <PageContainer>
      <div className='flex min-w-0 flex-col gap-4'>
        <GtmTabs right={subViews} />
        <ErrorBox error={error} />
        {data && (!data.email.connected || !data.email.enabled) && (
          <Notice>Campaign emails are not going out: {!data.email.connected ? 'add a Resend key on Key vault' : 'turn on Send emails in Agent configuration'}. Drafts and previews still work.</Notice>
        )}
        <input ref={fileRef} type='file' accept='application/json,.json' className='hidden' onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ''; }} />
        {view === 'replies' ? <RepliesView open={open} setOpen={setOpen} /> : view === 'senders' ? <SendersView /> : <RecordView<Campaign>
          id='gtm-campaigns' noun='campaigns' exportName='campaigns' compact stacked loading={isLoading}
          rows={list} rowKey={(c) => String(c.id)} cols={cols}
          openKey={open} onOpenChange={setOpen}
          defaultSort={[{ key: 'updated_at', dir: 'desc' }]}
          searchText={(c) => `${c.name} ${c.status} ${c.owner} ${who(c)} ${c.steps.map((s) => s.subject).join(' ')}`}
          searchPlaceholder='Search campaigns by name, status, owner, audience or subject'
          onImport={() => fileRef.current?.click()} importLabel='Import campaign'
          primary={<span className='flex flex-wrap gap-2'>
            <Gate need='campaigns'><Button variant='outline' disabled={create.isPending} onClick={newOutbound}><Icons.send className='size-4' /> New outbound campaign</Button></Gate>
            <Gate need='campaigns'><Button disabled={create.isPending} onClick={newCampaign}><Icons.add className='size-4' /> New campaign</Button></Gate>
          </span>}
          empty='No campaigns yet. Write one to the people who got stuck at a step.'
          summary={data && (
            <StatStrip items={[
              { label: 'Running', value: list.filter((c) => c.status === 'running').length, hint: `${list.filter((c) => c.status === 'scheduled').length} scheduled` },
              { label: 'Emails sent', value: sum('sent'), hint: `${sum('delivered')} delivered, ${sum('bounced')} bounced` },
              { label: 'Opened', value: pct(sum('opened'), sum('reached')), hint: `${sum('clicked')} clicked` },
              { label: 'Replied', value: pct(sum('replied'), sum('reached')), hint: `${sum('replies_open')} open` },
              { label: 'Activated after', value: conv('activated'), hint: `${conv('requested')} requested access, ${conv('paid')} paid` },
              { label: 'Unsubscribed', value: sum('unsubscribed'), hint: `${sum('suppressed')} suppressed at send` }
            ]} />
          )}
          detailTitle={() => 'Campaign'}
          detail={(c, close) => <CampaignPeek id={c.id} stages={stages} onDeleted={close} />}
        />}
      </div>
    </PageContainer>
  );
}

// ---------- one campaign ----------

const RECIPIENT_TONE = (s: string): Tone => (s === 'done' || s === 'active' || s === 'replied' ? 'ok' : ['unsubscribed', 'bounced', 'failed'].includes(s) ? 'bad' : s === 'suppressed' || s === 'no_consent' ? 'warn' : 'neutral');
const dash = <span className='text-muted-foreground'>—</span>;

/** The campaign's card (its facts, the lifecycle buttons and Save), then a tab per list and per part of the editor. The
 *  editor's state is keyed on the campaign's version (as before); the open tab, the schedule time and the test send
 *  live here, so a save or a refresh keeps them. */
function CampaignPeek({ id, stages, onDeleted }: { id: number; stages: { id: string; label: string }[]; onDeleted: () => void }) {
  const { data: d, error } = useAdmin<Detail>(path(id), { refetchInterval: 30_000 });
  const [tab, setTab] = useState<string | undefined>(undefined);
  const [at, setAt] = useState('');
  const [test, setTest] = useState({ to: '', step: '0', variant: '' });
  // The next record in the peek opens on its first tab, with nothing typed.
  useEffect(() => { setTab(undefined); setAt(''); setTest({ to: '', step: '0', variant: '' }); }, [id]);
  if (error) return <ErrorBox error={error} />;
  if (!d) return <Skeleton className='h-96 rounded-lg' />;
  const c = d.campaign;
  const before: DetailTab[] = [
    { id: 'recipients', label: 'Recipients', count: d.recipients.length, content: <RecipientsTable c={c} rows={d.recipients} /> },
    { id: 'replies', label: 'Replies', count: d.replies.replies.length, hidden: d.replies.hidden, content: <CampaignReplies replies={d.replies} /> },
    { id: 'performance', label: 'By email', hidden: !d.steps.some((s) => s.sent), content: (
      <DetailTable noun='emails' rows={d.steps} rowKey={(s) => String(s.index)} empty='No emails.'
        cols={[
          { key: 'index', label: '#', type: 'number', value: (s) => s.index + 1, className: 'w-10', render: (s) => s.index + 1 },
          { key: 'subject', label: 'Subject', type: 'text', value: (s) => s.subject, className: 'whitespace-normal', render: (s) => <span className='font-medium'>{s.subject}{s.variants?.length ? <span className='text-muted-foreground text-xs font-normal'> · {s.variants.length} variants</span> : null}</span> },
          { key: 'sent', label: 'Sent', type: 'number', value: (s) => s.sent, render: (s) => <span className='tabular-nums'>{s.sent}{s.failed ? <span className='text-destructive text-xs'> · {s.failed} failed</span> : null}</span> },
          { key: 'delivered', label: 'Delivered', type: 'number', value: (s) => s.delivered, render: (s) => <span className='tabular-nums'>{s.delivered}</span> },
          { key: 'opened', label: 'Opened', type: 'number', value: (s) => s.opened, render: (s) => <span className='tabular-nums'>{s.opened} · {pct(s.opened, s.sent)}</span> },
          { key: 'clicked', label: 'Clicked', type: 'number', value: (s) => s.clicked, render: (s) => <span className='tabular-nums'>{s.clicked}</span> }
        ]} />
    ) },
    { id: 'variants', label: 'A/B variants', hidden: !d.steps.some((s) => s.variant_stats.length), content: <VariantsTable c={c} steps={d.steps} /> }
  ];
  const after: DetailTab[] = [
    { id: 'test', label: 'Test send', content: <TestSend c={c} v={test} set={setTest} /> }
  ];
  return (
    <CampaignEditor key={`${c.id}:${c.updated_at}`} c={c} stages={stages} tab={tab} setTab={setTab} before={before} after={after}
      card={(save, editing) => <CampaignMeta d={d} stages={stages} onDeleted={onDeleted} at={at} setAt={setAt} save={save} editing={editing} />} />
  );
}

/** Who it goes to: enrolled when the campaign starts (and as people match, when it keeps enrolling). */
function RecipientsTable({ c, rows }: { c: Campaign; rows: Recipient[] }) {
  return (
    <DetailTable<Recipient> noun='recipients' rows={rows} rowKey={(r) => String(r.id)}
      empty={c.status === 'draft' || c.status === 'scheduled' ? 'Nobody yet: people are enrolled when it starts.' : 'Nobody matched.'}
      search={(r) => `${r.first_name ?? ''} ${r.email} ${r.account?.name ?? ''} ${r.status} ${r.country ?? ''}`} searchPlaceholder='Search recipients by name, email, account or status'
      cols={[
        { key: 'person', label: 'Person', type: 'text', value: (r) => r.first_name ?? r.email, render: (r) => <span className='flex flex-col gap-0.5'><span className='font-medium'>{r.first_name ?? r.email.split('@')[0]}</span><span className='text-muted-foreground text-xs'>{r.email}</span></span> },
        { key: 'from', label: 'From', type: 'text', value: (r) => (r.account ? r.account.name : r.source === 'request' ? 'Access request' : ''), render: (r) => <span className='text-sm'>{r.account ? r.account.name : r.source === 'request' ? 'Access request' : '—'}</span> },
        { key: 'status', label: 'Status', type: 'select', value: (r) => r.status, render: (r) => <span className='flex flex-col gap-0.5'>
          <StatusBadge tone={RECIPIENT_TONE(r.status)}>{r.status}</StatusBadge>
          {r.round > 0 && <span className='text-muted-foreground text-xs'>round {r.round + 1}</span>}</span> },
        { key: 'next', label: 'Next', type: 'date', value: (r) => (r.next_at && ['pending', 'active'].includes(r.status) ? r.next_at : null), render: (r) => (r.next_at && ['pending', 'active'].includes(r.status) ? <span className='text-sm'>Email {r.next_step + 1} <When d={r.next_at} className='text-muted-foreground' /></span> : dash) },
        { key: 'tz', label: 'Time zone', type: 'text', value: (r) => r.time_zone, render: (r) => <span className='text-muted-foreground text-xs'>{r.time_zone}{r.country ? ` · ${r.country}` : ''}</span> },
        { key: 'consent', label: 'Consent', type: 'select', value: (r) => (r.consent_basis ? CONSENT_LABEL[r.consent_basis] ?? r.consent_basis : ''), render: (r) => <span className='text-muted-foreground text-xs'>{r.consent_basis ? CONSENT_LABEL[r.consent_basis] ?? r.consent_basis : '—'}</span> },
        { key: 'last_sent', label: 'Last sent', type: 'date', value: (r) => r.last_sent_at, render: (r) => <When d={r.last_sent_at} className='text-muted-foreground text-sm' /> },
        { key: 'engaged', label: 'Engaged', render: (r) => <span className='text-muted-foreground text-xs'>{[r.delivered && 'delivered', r.opened && 'opened', r.clicked && 'clicked', r.bounced && 'bounced'].filter(Boolean).join(', ') || '—'}</span> },
        { key: 'converted', label: 'Converted', render: (r) => <span className='text-xs'>{[r.requested && 'requested', r.activated && 'activated', r.paid && 'paid'].filter(Boolean).join(', ') || <span className='text-muted-foreground'>—</span>}</span> }
      ]} />
  );
}

/** The card: name, status, the numbers and dates, the notices, and the lifecycle buttons with Save. */
function CampaignMeta({ d, stages, onDeleted, at, setAt, save, editing }: {
  d: Detail; stages: { id: string; label: string }[]; onDeleted: () => void; at: string; setAt: (v: string) => void; save: ReactNode; editing: string;
}) {
  const c = d.campaign, mt = c.metrics;
  const trig = triggerText(c.trigger, stages);
  return (
    <DetailMeta
      title={c.name}
      badges={<><StatusBadge tone={TONE[c.status]}>{c.status}</StatusBadge><KindBadge c={c} /></>}
      subtitle={c.trigger ? <><span className='text-foreground font-medium'>Triggered:</span> {trig}</> : audienceText(c.audience, stages)}
      actions={<><Lifecycle c={c} onDeleted={onDeleted} at={at} setAt={setAt} />{save}</>}
      facts={[
        { label: 'Owner', value: c.owner },
        { label: 'Created', value: <When d={c.created_at} />, hint: <>updated <When d={c.updated_at} /></> },
        { label: 'Starts', value: <When d={c.starts_at} />, hidden: c.status !== 'scheduled' || !c.starts_at },
        { label: 'Started', value: c.launched_at ? <When d={c.launched_at} /> : null, hint: c.finished_at ? <>finished <When d={c.finished_at} /></> : undefined },
        { label: 'Emails', value: <span className='tabular-nums'>{c.steps.length}</span> },
        { label: 'Recipients', value: mt?.recipients, hint: mt ? `${mt.waiting} waiting, ${mt.suppressed} suppressed` : undefined, hidden: !mt },
        { label: 'Sent', value: mt?.sent, hint: mt ? `${mt.delivered} delivered, ${mt.bounced} bounced` : undefined, hidden: !mt },
        { label: 'Opened', value: mt ? pct(mt.opened, mt.reached) : null, hint: mt ? `${mt.clicked} clicked` : undefined, hidden: !mt },
        { label: 'Replied', value: mt?.replied, hint: mt ? (mt.replies_open ? `${mt.replies_open} not handled` : 'all handled') : undefined, hidden: !mt },
        { label: 'Unsubscribed', value: mt?.unsubscribed, hint: mt ? (mt.failed ? `${mt.failed} failed` : 'none failed') : undefined, hidden: !mt },
        { label: 'Requested access', value: d.conversions?.requested, hint: d.conversions ? `within ${d.conversions.days} days of the first email` : undefined, hidden: !d.conversions },
        { label: 'Activated', value: d.conversions?.activated, hint: 'the account’s first simulation', hidden: !d.conversions },
        { label: 'Paid', value: d.conversions?.paid, hint: 'its first payment in Stripe', hidden: !d.conversions },
        { label: 'Events matched', value: d.events?.matched, hint: 'since it started', hidden: !(c.trigger && d.events) },
        { label: 'Waiting for the delay', value: d.events?.queued, hidden: !(c.trigger && d.events) },
        { label: 'Enrolled', value: d.events?.enrolled, hidden: !(c.trigger && d.events) },
        { label: 'Not enrolled', value: d.events?.skipped, hint: 'no consent, re-entry rule or nobody to write to', hidden: !(c.trigger && d.events) },
        { label: 'Replies go to', value: d.setup.replies_inbox, hint: "A reply stops that person's emails (a per-person address).", hidden: d.replies.hidden || !d.setup.replies_inbox, wide: true },
        { label: 'Changes', value: editing, wide: true }
      ]}
    >
      {c.audience.include === 'prospects' && !c.sender_identity_id && <Notice tone='info'>Choose a sender identity before launching (Settings).</Notice>}
      {mt && (mt.uncertain > 0 || mt.unknown > 0) && <UnknownSends c={c} m={mt} />}
      {c.audience.include === 'prospects' && d.setup.outbound_postal_warning
        ? <Notice>{d.setup.outbound_postal_warning} (Agent configuration, Campaigns: Sender postal address). This never stops a send.</Notice>
        : !d.setup.postal_address_set && <Notice tone='info'>{d.setup.postal_hint} (Agent configuration, Campaigns: Sender postal address). Emails still go out without it.</Notice>}
    </DetailMeta>
  );
}

/** Every step's A/B variants in one table: sends, opens, clicks, replies and conversions each, tested against A, and Pick winner. */
function VariantsTable({ c, steps }: { c: Campaign; steps: Detail['steps'] }) {
  const win = useAdminAction((v: { step: number; letter: string }) => post<Detail>(`${path(c.id)}/steps/${v.step}/winner`, { variant: v.letter }), { success: (r) => `Variant chosen for ${r.campaign.name}` });
  type Row = { step: Detail['steps'][number]; v: VariantStat; decided: boolean };
  const rows: Row[] = steps.filter((s) => s.variant_stats.length).flatMap((s) => {
    const decided = s.variant_stats.some((v) => v.weight === 100);
    return s.variant_stats.map((v) => ({ step: s, v, decided }));
  });
  return (
    <DetailTable<Row> noun='variants' rows={rows} rowKey={(r) => `${r.step.index}:${r.v.letter}`} empty='No variants.'
      filters={<span className='text-muted-foreground text-xs'>Each person gets one variant, always the same. Replies and conversions are tested against A (two-proportion z-test).</span>}
      cols={[
        { key: 'email', label: 'Email', type: 'number', value: (r) => r.step.index + 1, render: (r) => `Email ${r.step.index + 1}` },
        { key: 'variant', label: 'Variant', type: 'text', value: (r) => r.v.letter, render: ({ v }) => <span className='flex flex-col gap-0.5'><span className='font-medium'>{v.letter} <span className='text-muted-foreground text-xs font-normal'>· {v.weight}%</span></span><span className='text-muted-foreground line-clamp-1 text-xs'>{v.subject}</span></span> },
        { key: 'sent', label: 'Sent', type: 'number', value: (r) => r.v.sent, render: ({ v }) => <span className='tabular-nums'>{v.sent}</span> },
        { key: 'opened', label: 'Opened', type: 'number', value: (r) => r.v.opened, render: ({ v }) => <span className='tabular-nums'>{v.opened} · {pct(v.opened, v.sent)}</span> },
        { key: 'clicked', label: 'Clicked', type: 'number', value: (r) => r.v.clicked, render: ({ v }) => <span className='tabular-nums'>{v.clicked} · {pct(v.clicked, v.sent)}</span> },
        { key: 'replied', label: 'Replied', type: 'number', value: (r) => r.v.replied, render: ({ v }) => <span className='tabular-nums'>{v.replied} · {pct(v.replied, v.sent)}</span> },
        { key: 'reply_test', label: 'Reply rate vs A', render: ({ v }) => <TestCell t={v.reply_test} /> },
        { key: 'converted', label: 'Converted', type: 'number', value: (r) => r.v.converted, render: ({ v }) => <span className='tabular-nums'>{v.converted} · {pct(v.converted, v.sent)}</span> },
        { key: 'conversion_test', label: 'Conversion vs A', render: ({ v }) => <TestCell t={v.conversion_test} /> },
        { key: 'winner', label: '', render: ({ v, step, decided }) => (v.weight === 100 ? <StatusBadge tone='ok'>winner</StatusBadge> : c.status !== 'done' && (
          <Gate need='campaigns'>
            <ConfirmButton label={<><Icons.check /> Pick winner</>} title={`Send variant ${v.letter} to everyone?`} confirmLabel={`Pick ${v.letter}`} disabled={win.isPending}
              description={`Variant ${v.letter} goes to 100% for email ${step.index + 1}; the others stop being sent (their numbers stay).${decided ? ' This replaces the winner picked before.' : ''}`}
              onConfirm={() => win.mutate({ step: step.index, letter: v.letter })} />
          </Gate>
        )) }
      ]} />
  );
}

/** "p 0.03" with a verdict: significant at 95%, not yet, or too few sends to read. */
function TestCell({ t }: { t: ZTest | null }) {
  if (!t) return <span className='text-muted-foreground text-xs'>control</span>;
  if (t.small) return <span className='text-muted-foreground text-xs' title='Fewer than 30 sends in a variant, or too few replies or conversions expected: wait for more.'>too few to tell</span>;
  return <span className='flex flex-col gap-0.5'>
    <StatusBadge tone={t.significant ? 'ok' : 'neutral'}>{t.significant ? 'significant' : 'not significant'}</StatusBadge>
    <span className='text-muted-foreground text-xs tabular-nums'>z {t.z} · p {t.p}</span>
  </span>;
}


/**
 * Emails Resend may or may not have sent (no answer, a 5xx, a 409, a batch answer missing an id): uncertain ones are
 * replayed as the very same request, so they never go twice; unknown ones are never sent again unless an owner says so.
 */
function UnknownSends({ c, m }: { c: Campaign; m: Metrics }) {
  const resend = useAdminAction(() => post<{ resent: number; requeued: number; skipped: number; uncertain: number }>(`${path(c.id)}/resend-unknown`),
    { success: (r) => `${r.resent} resent${r.requeued ? `, ${r.requeued} back in the queue` : ''}${r.uncertain ? `, ${r.uncertain} uncertain again` : ''}${r.skipped ? `, ${r.skipped} left (replied, unsubscribed or no consent)` : ''}` });
  return (
    <Notice>
      <span className='flex flex-wrap items-center gap-x-3 gap-y-2'>
        <span>
          {m.uncertain > 0 && <>{m.uncertain} email{m.uncertain === 1 ? '' : 's'} with an uncertain outcome: repeated as the very same request on the next tick, so nobody gets two. </>}
          {m.unknown > 0 && <>{m.unknown} email{m.unknown === 1 ? '' : 's'} whose outcome could not be confirmed: Resend may have sent {m.unknown === 1 ? 'it' : 'them'}. Not sent again unless you resend.</>}
        </span>
        {m.unknown > 0 && (
          <Gate need='campaigns'>
            <ConfirmButton label={<><Icons.send /> Resend {m.unknown} (may send a second copy to people who already got it)</>} title={`Resend ${m.unknown} email${m.unknown === 1 ? '' : 's'}?`}
              confirmLabel='Resend anyway' disabled={resend.isPending}
              description='Each goes again now, exactly as it was written, as a new email. Resend may already have delivered some of them: those people would get a second copy. People who replied, unsubscribed or lost consent since are left out.'
              onConfirm={() => resend.mutate()} />
          </Gate>
        )}
      </span>
    </Notice>
  );
}

/** Launch, schedule, pause, resume, end, delete, export: each a labelled button, owners only. */
function Lifecycle({ c, onDeleted, at, setAt }: { c: Campaign; onDeleted: () => void; at: string; setAt: (v: string) => void }) {
  const act = useAdminAction((v: { action: string; body?: unknown }) => post<Detail>(`${path(c.id)}/${v.action}`, v.body ?? {}),
    { success: (r) => `${r.campaign.name}: ${r.campaign.status}` });
  const remove = useAdminAction(() => adminApi('DELETE', path(c.id)), { success: 'Campaign deleted' });
  const tick = useAdminAction(() => post<{ sent_now: number; waiting: number; skipped: string | null; busy: boolean }>(`${path(c.id)}/send-now`),
    { success: (r) => (r.skipped ? `Nothing sent: ${r.skipped}` : r.busy ? 'Another send is running: these go out on the next tick' : `${r.sent_now} sent, ${r.waiting} waiting`) });
  const exportJson = () => downloadJson(`campaign-${c.id}-${c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}.json`,
    { name: c.name, audience: c.audience, steps: c.steps, rolling: c.rolling, conversion_days: c.conversion_days, trigger: c.trigger, send_window: c.send_window,
      requires_opt_in: c.requires_opt_in, count_auto_replies: c.count_auto_replies, track_opens: c.track_opens ?? null, allow_restricted: c.allow_restricted ?? false });
  return (
    <>
      {c.status === 'draft' && (<>
        <Gate need='campaigns'>
          <ConfirmButton variant='default' label={<><Icons.send /> Launch now</>} title={`Launch ${c.name}?`} confirmLabel='Launch'
            description={c.trigger ? 'Nobody is enrolled now: from now on, each time the trigger happens, the people it is about join (after its delay).'
              : 'Everyone the audience matches now is enrolled, and the first email goes out on the next tick (within 5 minutes).'}
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
    </>
  );
}

const csv = (xs: string[]) => xs.join(', ');
const uncsv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
/** A row of checkboxes (stages, statuses, sizes, days) as one KeyValueTable value. */
const Checks = ({ children }: { children: ReactNode }) => <div className='flex flex-wrap gap-x-4 gap-y-2'>{children}</div>;

/**
 * Name, audience (with a live preview), the emails, the settings and the send window: one editor, one Save (on the
 * card), a tab each. Read-only once it runs: pause it to edit. `card` gets the Save button and what editing allows;
 * `before` and `after` are the campaign's other tabs.
 */
function CampaignEditor({ c, stages, tab, setTab, before, after, card }: {
  c: Campaign; stages: { id: string; label: string }[]; tab: string | undefined; setTab: (t: string) => void;
  before: DetailTab[]; after: DetailTab[]; card: (save: ReactNode, editing: string) => ReactNode;
}) {
  const { can } = useAdminRole();
  const editable = EDITABLE.includes(c.status) && can('campaigns');
  const [name, setName] = useState(c.name);
  const [a, setA] = useState<Audience>(c.audience);
  const [steps, setSteps] = useState<Step[]>(c.steps.length ? c.steps : [FIRST_STEP]);
  const [rolling, setRolling] = useState(c.rolling);
  const [days, setDays] = useState(String(c.conversion_days));
  const [plans, setPlans] = useState(csv(c.audience.plans));
  const [accounts, setAccounts] = useState(csv(c.audience.accounts));
  const [trigger, setTrigger] = useState<Trigger | null>(c.trigger);
  // No window yet: 9 to 17 is offered once a day is ticked (the server keeps "any time" as no days).
  const initWin: SendWindow = c.send_window?.days?.length ? c.send_window : { ...NO_WINDOW, time_zone: c.send_window?.time_zone ?? 'UTC' };
  const [win, setWin] = useState<SendWindow>(initWin);
  const [optIn, setOptIn] = useState<boolean | null>(c.requires_opt_in);
  const [countAuto, setCountAuto] = useState(c.count_auto_replies);
  // Outbound: the prospect filter (comma lists as typed), the sender identity, open tracking, EU / EEA / UK / CH.
  const pf0 = c.audience.prospects ?? DEFAULT_PROSPECTS;
  const [pf, setPf] = useState({ statuses: pf0.statuses, sizes: pf0.sizes, email_statuses: pf0.email_statuses, tags: csv(pf0.tags), titles: csv(pf0.titles), industries: csv(pf0.industries),
    countries: csv(pf0.countries), owners: csv(pf0.owners), prospect_ids: pf0.prospect_ids });
  const [identity, setIdentity] = useState<number | null>(c.sender_identity_id ?? null);
  const [trackOpens, setTrackOpens] = useState<boolean | null>(c.track_opens ?? null);
  const [allowRestricted, setAllowRestricted] = useState(c.allow_restricted ?? false);
  const outbound = a.include === 'prospects';
  const { data: ids } = useAdmin<Identities>(outbound && can('campaigns') ? '/gtm/identities' : null);
  const audience = useMemo(() => ({ ...a, plans: uncsv(plans), accounts: uncsv(accounts),
    ...(a.include === 'prospects' ? { prospects: { statuses: pf.statuses, sizes: pf.sizes, email_statuses: pf.email_statuses, tags: uncsv(pf.tags), titles: uncsv(pf.titles),
      industries: uncsv(pf.industries), countries: uncsv(pf.countries), owners: uncsv(pf.owners), prospect_ids: pf.prospect_ids } } : { prospects: undefined }) }), [a, plans, accounts, pf]);
  const current = { name, audience, steps, rolling, days, trigger, win, optIn, countAuto, identity, trackOpens, allowRestricted };
  const dirty = JSON.stringify(current) !== JSON.stringify({ name: c.name, audience: { ...c.audience, prospects: c.audience.include === 'prospects' ? c.audience.prospects : undefined }, steps: c.steps, rolling: c.rolling, days: String(c.conversion_days),
    trigger: c.trigger, win: initWin, optIn: c.requires_opt_in, countAuto: c.count_auto_replies, identity: c.sender_identity_id ?? null, trackOpens: c.track_opens ?? null, allowRestricted: c.allow_restricted ?? false });
  const save = useAdminAction(() => adminApi<Detail>('PUT', path(c.id), { name, audience, steps, rolling, conversion_days: Number(days), trigger: outbound ? null : trigger, send_window: win,
    requires_opt_in: optIn, count_auto_replies: countAuto, sender_identity_id: identity, track_opens: trackOpens, allow_restricted: allowRestricted }), { success: 'Saved' });
  const togglePf = (k: 'statuses' | 'sizes' | 'email_statuses', v: string, on: boolean) => setPf((x) => ({ ...x, [k]: on ? [...x[k], v] : x[k].filter((y) => y !== v) }));
  // The default when not set: on when the campaign can reach access requesters (src/campaigns.ts requiresOptIn).
  const optInDefault = trigger ? TRIGGERS.find((t) => t.id === trigger.type)?.who === 'request' : a.include !== 'accounts';
  const setT = (patch: Partial<Trigger>) => setTrigger((t) => ({ ...(t ?? { type: 'account_created', stage: null, days: null, attention: '', delay_hours: 0, reentry: 'once', reentry_days: 30 }), ...patch }));
  const set = <K extends keyof Audience>(k: K, v: Audience[K]) => setA((x) => ({ ...x, [k]: v }));
  const toggle = (k: 'stages' | 'request_status', v: string, on: boolean) => set(k, on ? [...a[k], v] : a[k].filter((x) => x !== v));
  const setStep = (i: number, patch: Partial<Step>) => setSteps((xs) => xs.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const dis = !editable;
  const locked = (c.metrics?.recipients ?? 0) > 0;
  const editing = editable ? 'Changes apply to whoever has not had an email yet.' : c.status === 'running' ? 'Pause the campaign to change it.' : 'Read only.';
  const saveButton = editable && <Button size='sm' disabled={!dirty || save.isPending} onClick={() => save.mutate()}><Icons.check /> {save.isPending ? 'Saving…' : 'Save changes'}</Button>;
  const triggered = !!trigger && !outbound;
  // Each part of the editor is a Field | Value table inside a fieldset, so a read-only campaign disables every input at once.
  const part = (rows: KV[], top?: ReactNode) => (
    <fieldset disabled={dis} className='flex min-w-0 flex-col gap-3'>
      {top}
      <KeyValueTable rows={rows} />
    </fieldset>
  );

  const settings = part([
    formKV(`c-${c.id}-name`, 'Name', <Input id={`c-${c.id}-name`} disabled={dis} value={name} onChange={(e) => setName(e.target.value)} />),
    formKV(`c-${c.id}-start`, 'Starts', (
      <NativeSelect id={`c-${c.id}-start`} className='w-full' value={trigger && !outbound ? 'trigger' : 'audience'} onChange={(e) => (e.target.value === 'trigger' ? setT({}) : setTrigger(null))}>
        <NativeSelectOption value='audience'>For an audience, at launch or a scheduled time</NativeSelectOption>
        {!outbound && <NativeSelectOption value='trigger'>Triggered by an event</NativeSelectOption>}
      </NativeSelect>
    ), trigger ? 'People join when the event happens after launch; the audience narrows it by UTM tags and plan.' : 'Everyone the audience matches when it starts (and later, with Keep enrolling).'),
    formKV(`c-${c.id}-ttype`, 'When this happens', trigger && (
      <NativeSelect id={`c-${c.id}-ttype`} className='w-full' value={trigger.type}
        onChange={(e) => { const type = e.target.value as TriggerType; setT({ type, stage: type === 'stage_reached' || type === 'stuck' ? trigger.stage ?? stages[5]?.id ?? 'onboarded' : null, days: type === 'stuck' ? trigger.days ?? 3 : null }); }}>
        {TRIGGERS.map((t) => <NativeSelectOption key={t.id} value={t.id}>{t.label}</NativeSelectOption>)}
      </NativeSelect>
    ), undefined, !triggered),
    formKV(`c-${c.id}-tstage`, 'Stage', trigger && (
      <NativeSelect id={`c-${c.id}-tstage`} className='w-full' value={trigger.stage ?? ''} onChange={(e) => setT({ stage: e.target.value })}>
        {stages.map((s) => <NativeSelectOption key={s.id} value={s.id}>{s.label}</NativeSelectOption>)}
      </NativeSelect>
    ), undefined, !triggered || !(trigger?.type === 'stage_reached' || trigger?.type === 'stuck')),
    formKV(`c-${c.id}-tdays`, 'Stuck for (days)', trigger && (
      <Input id={`c-${c.id}-tdays`} type='number' min={1} max={365} value={trigger.days ?? 3} onChange={(e) => setT({ days: Math.max(1, Math.trunc(Number(e.target.value) || 1)) })} />
    ), undefined, !triggered || trigger?.type !== 'stuck'),
    formKV(`c-${c.id}-tatt`, 'Reason contains', trigger && (
      <Input id={`c-${c.id}-tatt`} value={trigger.attention} placeholder='e.g. no simulation' onChange={(e) => setT({ attention: e.target.value })} />
    ), 'Empty: any new reason.', !triggered || trigger?.type !== 'attention'),
    formKV(`c-${c.id}-tdelay`, 'Wait before enrolling (hours)', trigger && (
      <Input id={`c-${c.id}-tdelay`} type='number' min={0} max={2160} step='any' value={trigger.delay_hours} onChange={(e) => setT({ delay_hours: Math.max(0, Number(e.target.value) || 0) })} />
    ), '0: within moments of the event.', !triggered),
    formKV(`c-${c.id}-treentry`, 'Can a person join again?', trigger && (
      <span className='flex items-center gap-2'>
        <NativeSelect id={`c-${c.id}-treentry`} className='w-full' value={trigger.reentry} onChange={(e) => setT({ reentry: e.target.value as Trigger['reentry'] })}>
          <NativeSelectOption value='once'>Once ever</NativeSelectOption>
          <NativeSelectOption value='every'>Again, after a number of days</NativeSelectOption>
        </NativeSelect>
        {trigger.reentry === 'every' && <Input type='number' aria-label='Days before joining again' className='w-24' min={1} max={3650} value={trigger.reentry_days || 30}
          onChange={(e) => setT({ reentry_days: Math.max(1, Math.trunc(Number(e.target.value) || 1)) })} />}
      </span>
    ), undefined, !triggered),
    formKV(`c-${c.id}-identity`, 'Send from', (<>
      <NativeSelect id={`c-${c.id}-identity`} className='w-full' value={identity == null ? '' : String(identity)} onChange={(e) => setIdentity(e.target.value ? Number(e.target.value) : null)}>
        <NativeSelectOption value=''>Choose a sender identity</NativeSelectOption>
        {(ids?.identities ?? []).map((i) => <NativeSelectOption key={i.id} value={String(i.id)} disabled={!i.enabled || i.on_product_domain}>
          {i.from_name} &lt;{i.from_address}&gt; · {i.sent_today}/{i.cap_today} today{!i.enabled ? ' (off)' : ''}{i.on_product_domain ? ' (product domain: refused)' : ''}
        </NativeSelectOption>)}
      </NativeSelect>
      {ids && !ids.identities.length && <Notice>No sender identity yet: add one in Senders (e.g. you@outreach.{ids.product_domain ?? 'example.com'}, verified in Resend). The campaign cannot launch without one.</Notice>}
    </>), `A sender identity on the outreach subdomain (Senders view). Never the product's sender domain${ids?.product_domain ? ` (${ids.product_domain})` : ''}.`, !outbound),
    formKV(`c-${c.id}-opens`, 'Track opens', <Switch id={`c-${c.id}-opens`} disabled={dis} checked={trackOpens ?? false} onCheckedChange={(v) => setTrackOpens(v)} />,
      'Off (the default for outbound): plain text only, no HTML part, so no tracking pixel. Better for deliverability.', !outbound),
    formKV(`c-${c.id}-restricted`, 'Allow prospects in the EU / EEA / UK / CH', <Switch id={`c-${c.id}-restricted`} disabled={dis} checked={allowRestricted} onCheckedChange={setAllowRestricted} />,
      'Off: they (and anyone with no country) are left out. On: they get it on the lawful basis recorded at import.', !outbound),
    formKV(`c-${c.id}-rolling`, 'Keep enrolling', <Switch id={`c-${c.id}-rolling`} disabled={dis} checked={rolling} onCheckedChange={setRolling} />,
      'People who match later join while it runs (checked every 5 minutes).'),
    formKV(`c-${c.id}-days`, 'Count conversions within (days)', <Input id={`c-${c.id}-days`} disabled={dis} type='number' min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} />),
    formKV(`c-${c.id}-optin`, 'Requires opt-in', <Switch id={`c-${c.id}-optin`} disabled={dis} checked={optIn ?? optInDefault} onCheckedChange={(v) => setOptIn(v)} />,
      <>Only people who ticked the marketing box. {optIn == null ? `Default for this audience: ${optInDefault ? 'on' : 'off'}.` : ''} Requesters from the EU, EEA, UK or Switzerland (or an unknown country) always need it.</>, outbound),
    formKV(`c-${c.id}-auto`, 'Count auto-replies as replies', <Switch id={`c-${c.id}-auto`} disabled={dis} checked={countAuto} onCheckedChange={setCountAuto} />,
      'Off: an out-of-office is kept but the emails go on. On: it stops them like a reply.')
  ]);

  const pfLabel = { titles: 'Title contains', tags: 'Tags', industries: 'Industry contains', countries: 'Countries', owners: 'Owners' } as const;
  const audienceTab = part([
    formKV(`c-${c.id}-include`, 'Who', (
      <NativeSelect id={`c-${c.id}-include`} className='w-full' value={a.include} onChange={(e) => { set('include', e.target.value as Audience['include']); if (e.target.value === 'prospects') setTrigger(null); }}>
        {/* Once anyone is enrolled, cold and lifecycle email never trade places (the server refuses it too). */}
        <NativeSelectOption value='accounts' disabled={locked && c.audience.include === 'prospects'}>Accounts</NativeSelectOption>
        <NativeSelectOption value='requests' disabled={locked && c.audience.include === 'prospects'}>Access requesters</NativeSelectOption>
        <NativeSelectOption value='both' disabled={locked && c.audience.include === 'prospects'}>Both</NativeSelectOption>
        <NativeSelectOption value='prospects' disabled={locked && c.audience.include !== 'prospects'}>Prospects (outbound)</NativeSelectOption>
      </NativeSelect>
    ), <>Accounts: their active members (Clerk), else whoever asked for the account. Requesters: the person on the access request.
      {locked && <> This campaign has recipients, so it stays {c.audience.include === 'prospects' ? 'outbound' : 'lifecycle'}: make a new campaign to change that.</>}</>),
    formKV(`c-${c.id}-attention`, 'Needs a person for', <Input id={`c-${c.id}-attention`} value={a.attention} onChange={(e) => set('attention', e.target.value)} placeholder='Any' />,
      'Text an attention reason contains, e.g. "no simulation" or "report never opened".', outbound),
    // Outbound: the prospect filter.
    formKV(undefined, 'Prospect status', <Checks>{PROSPECT_STATUSES.map((s) => <label key={s.id} className='flex items-center gap-2 text-sm leading-none'><Checkbox disabled={dis} checked={pf.statuses.includes(s.id)} onCheckedChange={(on) => togglePf('statuses', s.id, !!on)} />{s.label}</label>)}</Checks>,
      'Customers, replied, interested, not interested and bad addresses are never enrolled.', !outbound),
    formKV(undefined, 'Email status', <Checks>{EMAIL_STATUSES.map((s) => <label key={s} className='flex items-center gap-2 text-sm leading-none'><Checkbox disabled={dis} checked={pf.email_statuses.includes(s)} onCheckedChange={(on) => togglePf('email_statuses', s, !!on)} />{s.replace(/_/g, ' ')}</label>)}</Checks>,
      'Verified only by default.', !outbound),
    formKV(undefined, 'Company size', <Checks>{SIZES.map((s) => <label key={s} className='flex items-center gap-2 text-sm leading-none'><Checkbox disabled={dis} checked={pf.sizes.includes(s)} onCheckedChange={(on) => togglePf('sizes', s, !!on)} />{s}</label>)}</Checks>, undefined, !outbound),
    ...(['titles', 'tags', 'industries', 'countries', 'owners'] as const).map((k) =>
      formKV(`c-${c.id}-pf-${k}`, pfLabel[k], <Input id={`c-${c.id}-pf-${k}`} value={pf[k]} placeholder='Any' onChange={(e) => setPf((x) => ({ ...x, [k]: e.target.value }))} />, 'Comma-separated; empty: any.', !outbound)),
    formKV(undefined, 'Chosen prospects', <span className='flex flex-wrap items-center gap-2'>
      <span className='text-muted-foreground text-xs'>Only the {pf.prospect_ids.length} prospects chosen on the Prospects page (and only those the filter above also matches).</span>
      <Button size='xs' variant='ghost' onClick={() => setPf((x) => ({ ...x, prospect_ids: [] }))}>Use the filter alone</Button>
    </span>, undefined, !outbound || !pf.prospect_ids.length),
    // Lifecycle: accounts and access requesters.
    formKV(undefined, 'Stage (the furthest step reached)', <Checks>{stages.map((s) => (
      <label key={s.id} className='flex items-center gap-2 text-sm leading-none'>
        <Checkbox disabled={dis} checked={a.stages.includes(s.id)} onCheckedChange={(on) => toggle('stages', s.id, !!on)} />{s.label}
      </label>
    ))}</Checks>, undefined, outbound),
    formKV(undefined, 'Request status', <Checks>{['pending', 'approved', 'declined'].map((s) => (
      <label key={s} className='flex items-center gap-2 text-sm leading-none capitalize'>
        <Checkbox disabled={dis} checked={a.request_status.includes(s)} onCheckedChange={(on) => toggle('request_status', s, !!on)} />{s}
      </label>
    ))}</Checks>, undefined, outbound || a.include === 'accounts'),
    formKV(`c-${c.id}-src`, 'utm_source', <Input id={`c-${c.id}-src`} value={a.utm_source} onChange={(e) => set('utm_source', e.target.value)} placeholder='Any' />, undefined, outbound),
    formKV(`c-${c.id}-med`, 'utm_medium', <Input id={`c-${c.id}-med`} value={a.utm_medium} onChange={(e) => set('utm_medium', e.target.value)} placeholder='Any' />, undefined, outbound),
    formKV(`c-${c.id}-camp`, 'utm_campaign', <Input id={`c-${c.id}-camp`} value={a.utm_campaign} onChange={(e) => set('utm_campaign', e.target.value)} placeholder='Any' />, undefined, outbound),
    formKV(`c-${c.id}-from`, 'Created from', <Input id={`c-${c.id}-from`} type='date' value={a.created_from ?? ''} onChange={(e) => set('created_from', e.target.value || null)} />, undefined, outbound),
    formKV(`c-${c.id}-to`, 'Created to', <Input id={`c-${c.id}-to`} type='date' value={a.created_to ?? ''} onChange={(e) => set('created_to', e.target.value || null)} />, undefined, outbound),
    formKV(`c-${c.id}-plans`, 'Plans', <Input id={`c-${c.id}-plans`} value={plans} onChange={(e) => setPlans(e.target.value)} placeholder='Any' />, 'Comma-separated plan names, or none.', outbound),
    formKV(`c-${c.id}-accounts`, 'Only these accounts', <Input id={`c-${c.id}-accounts`} value={accounts} onChange={(e) => setAccounts(e.target.value)} placeholder='Any' />, 'Comma-separated slugs.', outbound),
    { label: 'Triggered', value: <span className='text-muted-foreground text-xs'>The event decides who; only the UTM tags and plans here narrow it.</span>, hidden: !triggered }
  ]);

  const emailsTab = part(steps.map((s, i) => ({
    label: `Email ${i + 1}`,
    value: (
      <div className='grid min-w-0 gap-3'>
        <div className='flex flex-wrap items-center gap-3'>
          <label className='text-muted-foreground flex items-center gap-2 text-sm'>
            {i ? 'days after the one before' : 'days after enrolment'}
            <Input type='number' min={0} max={365} className='h-7 w-20' aria-label={`Delay in days for email ${i + 1}`} value={s.delay_days}
              onChange={(e) => setStep(i, { delay_days: Math.max(0, Math.min(365, Math.trunc(Number(e.target.value) || 0))) })} />
          </label>
          {steps.length > 1 && <Button size='sm' variant='ghost' className='text-destructive ml-auto' onClick={() => setSteps((xs) => xs.filter((_, j) => j !== i))}><Icons.trash /> Remove email</Button>}
        </div>
        {!s.variants?.length ? (<>
          <Input aria-label={`Subject of email ${i + 1}`} placeholder='Subject' value={s.subject} onChange={(e) => setStep(i, { subject: e.target.value })} />
          <Textarea aria-label={`Body of email ${i + 1}`} rows={7} placeholder='Plain text' value={s.body} onChange={(e) => setStep(i, { body: e.target.value })} />
          {editable && <Button size='sm' variant='outline' className='self-start' onClick={() => setStep(i, { variants: [{ subject: s.subject, body: s.body, weight: 50 }, { subject: s.subject, body: '', weight: 50 }] })}>
            <Icons.add /> Add A/B variants</Button>}
        </>) : (
          <VariantsEditor i={i} variants={s.variants} editable={editable}
            onChange={(vs) => setStep(i, vs.length < 2 ? { variants: undefined, subject: vs[0]?.subject ?? s.subject, body: vs[0]?.body ?? s.body } : { variants: vs, subject: vs[0].subject, body: vs[0].body })} />
        )}
      </div>
    )
  })), (
    <div className='flex flex-wrap items-center justify-between gap-2'>
      <span className='text-muted-foreground text-xs'>{'{{first_name}}'} and {'{{product}}'} are filled in for each person; an unsubscribe link is added at the end.</span>
      {editable && steps.length < 10 && (
        <Button size='sm' variant='outline' onClick={() => setSteps((xs) => [...xs, { subject: '', body: '', delay_days: 3 }])}><Icons.add /> Add an email</Button>
      )}
    </div>
  ));

  const windowTab = part([
    formKV(undefined, 'Days', <Checks>{DAYS.map((d, k) => (
      <label key={d} className='flex items-center gap-2 text-sm leading-none'>
        <Checkbox disabled={dis} checked={win.days.includes(k + 1)} onCheckedChange={(on) => setWin((w) => ({ ...w, days: on ? [...w.days, k + 1].sort() : w.days.filter((x) => x !== k + 1) }))} />{d}
      </label>
    ))}</Checks>, 'None ticked: any day and hour.'),
    formKV(`c-${c.id}-wfrom`, 'From (hour, local)', <Input id={`c-${c.id}-wfrom`} type='number' min={0} max={23} value={win.start_hour} onChange={(e) => setWin((w) => ({ ...w, start_hour: Math.min(23, Math.max(0, Math.trunc(Number(e.target.value) || 0))) }))} />, undefined, !win.days.length),
    formKV(`c-${c.id}-wto`, 'Until (hour, local)', <Input id={`c-${c.id}-wto`} type='number' min={1} max={24} value={win.end_hour} onChange={(e) => setWin((w) => ({ ...w, end_hour: Math.min(24, Math.max(1, Math.trunc(Number(e.target.value) || 0))) }))} />, undefined, !win.days.length),
    formKV(`c-${c.id}-wtz`, 'Default time zone', <Input id={`c-${c.id}-wtz`} value={win.time_zone} placeholder='UTC' onChange={(e) => setWin((w) => ({ ...w, time_zone: e.target.value.trim() }))} />,
      "Used when a person's own zone and country are unknown.", !win.days.length),
    { label: 'Hours', value: <span className='text-muted-foreground text-xs'>Hours are each person&apos;s own: their stored time zone, else their access request&apos;s country, else the default. An email due outside the window waits for it to open.</span> }
  ]);

  const tabs: DetailTab[] = [
    ...before,
    { id: 'emails', label: 'Emails', count: steps.length, content: emailsTab },
    { id: 'audience', label: 'Audience', content: audienceTab },
    { id: 'preview', label: 'Who gets it', hidden: triggered, content: <AudiencePreview audience={audience} optIn={optIn} campaignId={c.id} allowRestricted={allowRestricted} /> },
    { id: 'settings', label: 'Settings', content: settings },
    { id: 'window', label: 'Send window', content: windowTab },
    ...after
  ];
  return (
    <div className='flex flex-col gap-4'>
      {card(saveButton, editing)}
      <DetailTabs resetKey={c.id} tabs={tabs} value={tab} onValueChange={setTab} defaultTab={c.status === 'draft' ? 'emails' : 'recipients'} />
    </div>
  );
}

/** A step's 2 to 4 variants: subject and body each (empty: variant A's), and a weight. Fewer than two: a plain email again. */
function VariantsEditor({ i, variants, editable, onChange }: { i: number; variants: Variant[]; editable: boolean; onChange: (vs: Variant[]) => void }) {
  const set = (k: number, patch: Partial<Variant>) => onChange(variants.map((v, n) => (n === k ? { ...v, ...patch } : v)));
  const total = variants.reduce((t, v) => t + (v.weight || 0), 0);
  return (
    <div className='grid gap-3'>
      {variants.map((v, k) => (
        <div key={k} className='grid gap-2 rounded-md border border-dashed p-3'>
          <div className='flex flex-wrap items-center gap-3'>
            <span className='text-sm font-medium'>Variant {LETTERS[k]}</span>
            <label className='text-muted-foreground flex items-center gap-2 text-sm'>
              weight
              <Input type='number' min={0} max={100} className='h-7 w-20' aria-label={`Weight of variant ${LETTERS[k]} in email ${i + 1}`} value={v.weight}
                onChange={(e) => set(k, { weight: Math.max(0, Math.min(100, Math.trunc(Number(e.target.value) || 0))) })} />
              <span className='tabular-nums'>{total ? `${Math.round(((v.weight || 0) / total) * 100)}% of people` : '—'}</span>
            </label>
            {editable && <Button size='sm' variant='ghost' className='text-destructive ml-auto' onClick={() => onChange(variants.filter((_, n) => n !== k))}><Icons.trash /> Remove variant</Button>}
          </div>
          <Input aria-label={`Subject of email ${i + 1}, variant ${LETTERS[k]}`} placeholder={k ? "Subject (empty: variant A's)" : 'Subject'} value={v.subject} onChange={(e) => set(k, { subject: e.target.value })} />
          <Textarea aria-label={`Body of email ${i + 1}, variant ${LETTERS[k]}`} rows={k ? 4 : 7} placeholder={k ? "Plain text (empty: variant A's)" : 'Plain text'} value={v.body} onChange={(e) => set(k, { body: e.target.value })} />
        </div>
      ))}
      {editable && variants.length < 4 && (
        <Button size='sm' variant='outline' className='self-start' onClick={() => onChange([...variants, { subject: '', body: '', weight: 50 }])}><Icons.add /> Add variant {LETTERS[variants.length]}</Button>
      )}
    </div>
  );
}

/** How many the audience matches now, how many are suppressed, and the first few. Refreshes as the filter changes. */
function AudiencePreview({ audience, optIn, campaignId, allowRestricted }: { audience: Audience; optIn: boolean | null; campaignId: number; allowRestricted: boolean }) {
  const [q, setQ] = useState({ audience, optIn, allowRestricted });
  useEffect(() => { const t = setTimeout(() => setQ({ audience, optIn, allowRestricted }), 500); return () => clearTimeout(t); }, [audience, optIn, allowRestricted]);
  const { data, error, isFetching } = useQuery({ queryKey: ['admin', 'gtm-preview', campaignId, JSON.stringify(q)], staleTime: 15_000, retry: false,
    queryFn: () => post<Preview>('/gtm/audience/preview', { audience: q.audience, requires_opt_in: q.optIn, campaign_id: campaignId, allow_restricted: q.allowRestricted }) });
  type Sample = Preview['sample'][number];
  const summary = (
    <div className='grid gap-1'>
      <div className='flex flex-wrap items-baseline gap-x-3 text-sm'>
        <span className='font-medium'>{data ? `${data.sendable} ${data.sendable === 1 ? 'person' : 'people'} would get it` : isFetching ? 'Counting…' : '—'}</span>
        {data && (audience.include === 'prospects'
          ? <span className='text-muted-foreground'>{data.count} prospects match{data.suppressed ? `, ${data.suppressed} suppressed` : ''}{data.no_consent ? `, ${data.no_consent} left out` : ''}</span>
          : <span className='text-muted-foreground'>{data.count} match: {data.by_source.account} from accounts, {data.by_source.request} from requests{data.suppressed ? `, ${data.suppressed} suppressed` : ''}{data.no_consent ? `, ${data.no_consent} without the consent it needs` : ''}</span>)}
      </div>
      {data?.blocked && Object.keys(data.blocked).length > 0 && audience.include === 'prospects' && (
        <p className='text-muted-foreground text-xs'>Left out: {Object.entries(data.blocked).map(([k, v]) => `${v} ${BLOCK_LABEL[k] ?? k}`).join(', ')}.</p>
      )}
      {error && <p className='text-destructive text-sm'>{(error as Error).message}</p>}
    </div>
  );
  return (
    <DetailTable<Sample> noun='people' rows={data?.sample ?? []} loading={!data && isFetching}
      empty={data ? 'Nobody matches yet.' : 'Counting…'} filters={summary}
      search={(s) => `${s.first_name ?? ''} ${s.email} ${s.product ?? ''} ${s.org_name ?? ''}`} searchPlaceholder='Search the first matches'
      cols={[
        { key: 'person', label: 'Person', type: 'text', value: (s) => s.first_name ?? s.email, render: (s) => <span className='flex flex-col gap-0.5'><span>{s.first_name ?? '—'}</span><span className='text-muted-foreground text-xs'>{s.email}</span></span> },
        { key: 'product', label: '{{product}}', type: 'text', value: (s) => s.product ?? '', render: (s) => s.product ?? '—' },
        { key: 'from', label: 'From', type: 'text', value: (s) => s.org_name ?? (s.source === 'request' ? 'Access request' : ''), render: (s) => (s.org_name ?? (s.source === 'request' ? 'Access request' : '—')) },
        { key: 'consent', label: 'Consent', type: 'select', value: (s) => CONSENT_LABEL[s.consent] ?? s.consent, render: (s) => <span className='text-muted-foreground text-xs'>{CONSENT_LABEL[s.consent] ?? s.consent}</span> },
        { key: 'sent', label: '', render: (s) => (s.suppressed ? <StatusBadge tone='warn'>suppressed</StatusBadge> : ['needs_opt_in', 'withdrawn', ...Object.keys(BLOCK_LABEL)].includes(s.consent) ? <StatusBadge tone='neutral'>not sent</StatusBadge> : null) }
      ]} />
  );
}

type TestState = { to: string; step: string; variant: string };

/** One email to an address typed in, rendered for the first match (marked [Test]; its unsubscribe link does nothing). */
function TestSend({ c, v, set }: { c: Campaign; v: TestState; set: (f: (s: TestState) => TestState) => void }) {
  const { to, step, variant } = v;
  const setTo = (to: string) => set((s) => ({ ...s, to }));
  const setVariant = (variant: string) => set((s) => ({ ...s, variant }));
  const setStep = (step: string) => set((s) => ({ ...s, step, variant: '' }));
  const variants = c.steps[Number(step)]?.variants ?? [];
  const send = useAdminAction(() => post<{ status: string; error?: string | null; warnings?: string[] }>(`${path(c.id)}/test`, { to: to.trim(), step: Number(step), variant: variant || undefined }),
    { success: (r) => (r.status === 'sent' ? `Test sent to ${to.trim()}${r.warnings?.length ? `. ${r.warnings.join('. ')}` : ''}` : `Not sent: ${r.error ?? r.status}`) });
  return (
    <form className='flex flex-col gap-3' onSubmit={(e) => { e.preventDefault(); send.mutate(); }}>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <span className='text-muted-foreground text-xs'>Saved content, filled in for the first person the audience matches. The subject starts with [Test].</span>
        <Gate need='campaigns'><Button type='submit' size='sm' variant='outline' disabled={!to.trim() || !c.steps.length || send.isPending}><Icons.send /> Send test</Button></Gate>
      </div>
      <KeyValueTable rows={[
        formKV(`c-${c.id}-test-to`, 'Send a test to', <Input id={`c-${c.id}-test-to`} type='email' required placeholder='you@octillion.dev' value={to} onChange={(e) => setTo(e.target.value)} />),
        formKV(`c-${c.id}-test-step`, 'Which email', (
          <NativeSelect id={`c-${c.id}-test-step`} className='w-full' value={step} onChange={(e) => setStep(e.target.value)}>
            {c.steps.map((s, i) => <NativeSelectOption key={i} value={String(i)}>Email {i + 1}: {s.subject.slice(0, 40)}</NativeSelectOption>)}
          </NativeSelect>
        )),
        formKV(`c-${c.id}-test-variant`, 'Which variant', (
          <NativeSelect id={`c-${c.id}-test-variant`} className='w-full' value={variant} onChange={(e) => setVariant(e.target.value)}>
            {variants.map((_, k) => <NativeSelectOption key={k} value={k ? LETTERS[k] : ''}>Variant {LETTERS[k]}</NativeSelectOption>)}
          </NativeSelect>
        ), undefined, variants.length <= 1)
      ]} />
    </form>
  );
}
