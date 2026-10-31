'use client';
// GTM › Activation: the one activation funnel (src/gtm.ts activation) for accounts created in a period, with the time
// each step takes, and every account that needs a person now, with the account peek and a nudge (a tip in their AI
// client, or a one-off email through Campaigns). Period and filters live in the URL. With a pricing experiment chosen
// (FinOps › Experiments; `experiment` and `variant` in the URL) the funnel is also shown split by variant, side by side.
import { Suspense, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { DateRangePicker } from '@/components/layout/date-range-picker';
import { StatStrip } from '@/components/layout/section';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icons } from '@/components/icons';
import { accountHref, post, useAdmin } from './lib';
import { useResult } from './result-dialog';
import { AccountPeek, useAccountActions, type Org } from './account-peek';
import { ErrorBox, FormRow, LoadingCards, Notice, Section, StatusBadge, When } from './ui';
import { Gate } from './role';
import { ExperimentPicker, GtmChips, GtmFilters, GtmTabs, hours, NOT_SHOWN, pctText, useGtmParams, utmText } from './gtm-common';

type Utm = { source: string; medium: string; campaign: string };
interface Step { id: string; label: string; reached: number; pct_of_previous: number | null; pct_of_first: number | null; median_hours: number | null; measured: number }
type AttentionOrg = Org & { utm: Utm; plan: string };
interface Activation {
  range: { from: string; to: string; days: number };
  stripe_error?: string;
  /** Accounts in the cohort that paid, with or without opening a report (the funnel's Paid step is nested). */
  paid_any: number;
  steps: Step[];
  attention: AttentionOrg[];
  cohort: { slug: string; name: string; stage_label: string; plan: string; utm: Utm }[];
  facets: { plans: Record<string, number>; utm_sources: Record<string, number>; utm_campaigns: Record<string, number>; experiments?: Record<string, number>; variants?: Record<string, number> };
  /** Only with a pricing experiment chosen (src/gtm.ts activation). */
  experiment?: {
    id: string; known: boolean; variant: string[]; rule: string; stripe_error: string | null;
    variants: { key: string; name: string; live: boolean; accounts: number }[];
    split: { key: string; name: string; live: boolean; steps: Step[] }[];
  };
}

export function AdminActivation() {
  // useSearchParams (the period and filters) needs a Suspense boundary for the static render.
  return <Suspense fallback={<PageContainer><Skeleton className='h-72 rounded-lg' /></PageContainer>}><ActivationPage /></Suspense>;
}

const dash = <span className='text-muted-foreground'>—</span>;

function ActivationPage() {
  const p = useGtmParams();
  const { data: a, error, isLoading } = useAdmin<Activation>(`/gtm/activation?${p.query}`, { keep: true });
  const { data: ov } = useAdmin<{ integrations: { clerk?: boolean } }>('/overview');
  const result = useResult();
  const ctl = useAccountActions(result.show, Boolean(ov?.integrations.clerk));
  const [nudging, setNudging] = useState<AttentionOrg | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const router = useRouter();
  const facets = a && { plan: a.facets.plans, utm_source: a.facets.utm_sources, utm_campaign: a.facets.utm_campaigns, variant: a.facets.variants ?? {} };
  const variantLabels = a?.experiment && { variant: Object.fromEntries(a.experiment.variants.map((v) => [v.key, v.name])) };
  const step = (id: string) => a?.steps.find((s) => s.id === id);
  const max = Math.max(1, ...(a?.steps ?? []).map((s) => s.reached));

  const cols: RecordCol<AttentionOrg>[] = [
    { key: 'name', label: 'Account', title: true, keep: true, type: 'text', className: 'min-w-56', value: (o) => o.name, render: (o) => <span className='font-medium'>{o.name}</span> },
    { key: 'stage', label: 'Stage', type: 'text', className: 'w-44', keep: true, value: (o) => o.stage_label, render: (o) => <StatusBadge>{o.stage_label}</StatusBadge> },
    { key: 'attention', label: 'Needs', type: 'text', value: (o) => o.attention.join('; '), render: (o) => (
      <Tooltip>
        <TooltipTrigger render={<span className='flex max-w-80 min-w-0 flex-col gap-1 text-sm leading-none text-amber-600 dark:text-amber-400' />}>
          <span className='truncate leading-none'>{o.attention[0]}</span>
          {o.attention.length > 1 && <span className='text-muted-foreground text-xs leading-none'>+{o.attention.length - 1} more</span>}
        </TooltipTrigger>
        <TooltipContent className='block max-w-sm whitespace-pre-line'>{o.attention.join('\n')}</TooltipContent>
      </Tooltip>
    ) },
    { key: 'plan', label: 'Plan', type: 'text', value: (o) => o.plan, render: (o) => (o.plan === 'none' ? dash : o.plan) },
    { key: 'source', label: 'Source', type: 'text', value: (o) => utmText(o.utm), render: (o) => <span className='text-muted-foreground text-sm'>{utmText(o.utm)}</span> },
    { key: 'contact', label: 'Contact', type: 'text', hidden: true, value: (o) => o.contact, render: (o) => o.contact ?? dash },
    { key: 'last_seen', label: 'Last seen', type: 'date', value: (o) => o.last_seen, render: (o) => <When d={o.last_seen} className='text-muted-foreground text-sm' /> }
  ];

  return (
    <PageContainer>
      <div className='flex min-w-0 flex-col gap-6'>
        <GtmTabs right={<div className='flex flex-wrap items-center justify-end gap-2'>
          <ExperimentPicker p={p} experiments={a?.facets.experiments} />
          <GtmFilters p={p} facets={facets} labels={variantLabels || undefined} /><DateRangePicker value={p.range} onChange={p.setRange} />
        </div>} />
        <GtmChips p={p} labels={variantLabels || undefined} />
        <ErrorBox error={error} />
        {a?.stripe_error && <Notice>Stripe: {a.stripe_error} (Paid shows what could be read)</Notice>}
        {isLoading || !a ? <LoadingCards count={4} /> : (<>
          <StatStrip items={[
            { label: 'Access requests', value: step('requested')?.reached ?? 0, hint: 'made in the period' },
            { label: 'New accounts', value: step('created')?.reached ?? 0, hint: `${pctText(step('created')?.pct_of_previous)} of requests` },
            { label: 'Reached a simulation', value: step('simulated')?.reached ?? 0, hint: `${pctText(step('simulated')?.pct_of_first)} of requests` },
            { label: 'Paid', value: step('paid')?.reached ?? 0, hint: `after a report; ${a.paid_any} paid in all` },
            { label: 'Need a person', value: a.attention.length, hint: 'now, any period' }
          ]} />

          <Section title='Funnel' description='Access requests made in the period, then the accounts created in it and the furthest step each reached (the Overview rule). Time is the median from the step before, where both happened.'>
            <div className='overflow-x-auto'>
              <ol className='grid min-w-[40rem] gap-2.5'>
                <li className='text-muted-foreground grid grid-cols-[minmax(0,13rem)_1fr_3.5rem_5rem_5rem_5rem] items-center gap-3 text-xs leading-none font-medium'>
                  <span>Step</span><span /><span className='text-right'>Count</span><span className='text-right'>Of previous</span><span className='text-right'>Of first</span><span className='text-right'>Median time</span>
                </li>
                {a.steps.map((s) => (
                  <li key={s.id} className='grid grid-cols-[minmax(0,13rem)_1fr_3.5rem_5rem_5rem_5rem] items-center gap-3 text-sm leading-none'>
                    <span className='truncate'>{s.label}</span>
                    <div className='bg-muted h-6 overflow-hidden rounded-md'>
                      <div className='bg-primary/85 h-full rounded-md transition-all' style={{ width: `${(s.reached / max) * 100}%` }} />
                    </div>
                    <span className='text-right font-medium tabular-nums'>{s.reached}</span>
                    <span className='text-muted-foreground text-right text-xs tabular-nums'>{s.id === 'requested' ? '' : pctText(s.pct_of_previous)}</span>
                    <span className='text-muted-foreground text-right text-xs tabular-nums'>{s.id === 'requested' ? '' : pctText(s.pct_of_first)}</span>
                    <span className='text-muted-foreground text-right text-xs tabular-nums' title={s.measured ? `${s.measured} account${s.measured === 1 ? '' : 's'} measured` : undefined}>
                      {s.id === 'requested' ? '' : hours(s.median_hours)}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          </Section>

          {a.experiment && <VariantFunnel e={a.experiment} />}

          <Section title='Needs a person' description='Accounts where someone should step in now, with the reasons from Accounts. Plan and UTM filters apply; the period does not.'>
            <RecordView<AttentionOrg>
              id='gtm-activation-attention' noun='accounts' exportName='needs-a-person' compact stacked
              rows={a.attention} rowKey={(o) => o.slug} cols={cols}
              openKey={open} onOpenChange={setOpen}
              defaultSort={[{ key: 'last_seen', dir: 'desc' }]}
              searchText={(o) => `${o.name} ${o.slug} ${o.contact ?? ''} ${o.stage_label} ${o.attention.join(' ')} ${utmText(o.utm)}`}
              searchPlaceholder='Search accounts, contacts or what they need'
              empty='Nobody is stuck.'
              detailTitle={() => 'Account'}
              detail={(o) => <AccountPeek org={o} ctl={ctl} actions={<>
                <Gate need='journeys'><Button variant='outline' size='sm' onClick={() => ctl.open('tip', o)}><Icons.chat /> Send a tip</Button></Gate>
                <Gate need='campaigns'><Button variant='outline' size='sm' onClick={() => setNudging(o)}><Icons.mail /> Email a nudge</Button></Gate>
                <Button variant='outline' size='sm' onClick={() => router.push(accountHref(o.slug))}><Icons.externalLink /> Open account</Button>
              </>} />}
            />
          </Section>
        </>)}
      </div>
      {nudging && <NudgeDialog org={nudging} onClose={() => setNudging(null)} />}
      {ctl.dialogs}
      {result.dialog}
    </PageContainer>
  );
}

/**
 * The funnel split by a pricing experiment's variants, side by side: one column per variant (count, % of the step
 * before), the not-shown column last. The rule for accounts never shown the pricing, and for Paid, is the server's
 * (src/gtm.ts SPLIT_RULE), stated under the title.
 */
function VariantFunnel({ e }: { e: NonNullable<Activation['experiment']> }) {
  const cols = e.split;
  return (
    <Section title={`Funnel by variant: ${e.id}`} description={e.rule}>
      <div className='flex flex-col gap-3'>
        {!e.known && <Notice tone='info'>No account has been shown {e.id} yet, and no live plan is in it: every account is under Not shown pricing.</Notice>}
        {e.stripe_error && <Notice>Stripe: {e.stripe_error} (Paid uses the variant shown where the subscription could not be read)</Notice>}
        <div className='overflow-x-auto rounded-lg border'>
          <table className='w-full min-w-[40rem] text-sm' aria-label={`Activation funnel by variant of ${e.id}`}>
            <thead>
              <tr className='text-muted-foreground border-b text-xs'>
                <th className='px-3 py-2 text-left font-medium'>Step</th>
                {cols.map((c) => (
                  <th key={c.key} className='px-3 py-2 text-right font-medium' title={c.key === NOT_SHOWN ? 'Accounts never shown this experiment on Billing' : c.key}>
                    <span className={c.key === NOT_SHOWN ? 'italic' : 'text-foreground'}>{c.name}</span>
                    {c.key !== NOT_SHOWN && !c.live && <span className='ml-1 font-normal'>(ended)</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(cols[0]?.steps ?? []).map((s, i) => (
                <tr key={s.id} className='border-b last:border-0'>
                  <td className='px-3 py-2'>{s.label}</td>
                  {cols.map((c) => {
                    const x = c.steps[i];
                    return (
                      <td key={c.key} className='px-3 py-2 text-right tabular-nums'>
                        <span className='font-medium'>{x.reached}</span>
                        {i > 0 && <span className='text-muted-foreground ml-1.5 text-xs'>{pctText(x.pct_of_previous)}</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Section>
  );
}

/**
 * A one-off email to an account's people: a one-step campaign (audience: this account), launched and sent at once, so
 * it carries the unsubscribe link and respects the suppression list like any campaign. It stays on Campaigns.
 */
function NudgeDialog({ org, onClose }: { org: AttentionOrg; onClose: () => void }) {
  const router = useRouter();
  const [subject, setSubject] = useState('Anything in your way, {{first_name}}?');
  const [body, setBody] = useState("Hi {{first_name}},\n\nI'm checking in on how {{product}} is going on Octillion. Is anything in the way of the next step? Reply to this email and I'll help.");
  const [busy, setBusy] = useState(false);
  const audience = { include: 'accounts', accounts: [org.slug] };
  const { data: preview } = useQuery({ queryKey: ['admin', 'gtm-preview', org.slug], staleTime: 15_000,
    queryFn: () => post<{ count: number; sendable: number; sample: { email: string }[] }>('/gtm/audience/preview', { audience }) });
  const send = async () => {
    setBusy(true);
    try {
      const c = await post<{ campaign: { id: number } }>('/gtm/campaigns', { name: `Nudge: ${org.name}`, audience, steps: [{ subject, body, delay_days: 0 }] });
      await post(`/gtm/campaigns/${c.campaign.id}/launch`, {});
      // What happened to this campaign's people, not to whatever else a tick sent.
      const r = await post<{ sent: number; suppressed: number; waiting: number; failed: number; skipped: string | null; busy: boolean }>(`/gtm/campaigns/${c.campaign.id}/send-now`);
      const open = { label: 'Open campaign', onClick: () => router.push(`/admin/gtm/campaigns?open=${c.campaign.id}`) };
      const parts = [r.sent && `sent to ${r.sent}`, r.suppressed && `${r.suppressed} suppressed`, r.failed && `${r.failed} failed`, r.waiting && `${r.waiting} queued`].filter(Boolean).join(', ');
      if (r.sent) toast.success(`Nudge ${parts}`, { action: open });
      else toast.warning(`Nudge not sent yet${parts ? ` (${parts})` : ''}${r.skipped ? `: ${r.skipped}` : r.busy ? ': another send is running, it goes out on the next tick' : ''}`, { action: open });
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>Email a nudge to {org.name}</DialogTitle>
          <DialogDescription>
            {preview == null ? 'Finding who to write to…' : preview.count ? `Goes to ${preview.sendable} of ${preview.count} people (${preview.sample.map((s) => s.email).slice(0, 3).join(', ')}${preview.count > 3 ? ', …' : ''}).` : 'Nobody to write to: the account has no member or requester with an email.'}
            {' '}Sent as a one-step campaign, with an unsubscribe link.
          </DialogDescription>
        </DialogHeader>
        <div className='grid gap-4'>
          <FormRow id='nudge-subject' label='Subject'><Input id='nudge-subject' value={subject} onChange={(e) => setSubject(e.target.value)} /></FormRow>
          <FormRow id='nudge-body' label='Email' hint='{{first_name}} and {{product}} are filled in for each person.'>
            <Textarea id='nudge-body' rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
          </FormRow>
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !subject.trim() || !body.trim() || !preview?.sendable} onClick={() => void send()}>{busy ? 'Sending…' : 'Send nudge'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
