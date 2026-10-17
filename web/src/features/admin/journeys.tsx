'use client';
// Journeys live in PostHog Workflows; Octillion delivers their in-chat and /app tips. Status, recipes, delivery, manual tips.
import { useEffect, useRef, useState } from 'react';
import PageContainer from '@/components/layout/page-container';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { adminApi } from '@/lib/api-client';
import { toast } from 'sonner';
import { post, useAdmin, useAdminAction } from './lib';
import { ConfirmButton, copyText, CopyField, DataList, ErrorBox, Mono, Section, StatusBadge, When } from './ui';

interface Step { step: string; when: string; channels: string[]; message: string; prompt?: string; link?: string; body: string }
interface Recipe { id: string; name: string; goal: string; trigger: string; steps: Step[] }
interface JourneyView {
  configured: boolean;
  posthog: boolean;
  webhook_url: string;
  interval_hours: number;
  max_chat_shows: number;
  muted: number;
  steps: { journey: string; step: string; queued: number; shown: number; dismissed: number; active: number; last: string }[];
  recent: any[];
  recipes: Recipe[];
}

export function AdminJourneys() {
  const { data: j, error, isLoading } = useAdmin<JourneyView>('/journeys');
  const { data: orgs } = useAdmin<{ orgs: { slug: string; name: string }[] }>('/orgs');
  const [org, setOrg] = useState('');
  const [user, setUser] = useState('');
  const [journey, setJourney] = useState('manual');
  const [step, setStep] = useState('announcement');
  const [message, setMessage] = useState('');
  const [prompt, setPrompt] = useState('');
  const formRef = useRef<HTMLDivElement>(null);
  const account = org || orgs?.orgs[0]?.slug || '';
  const { data: detail } = useAdmin<{ members: any[] }>(account ? `/orgs/${encodeURIComponent(account)}` : null);
  const members = (detail?.members ?? []).filter((m) => m.status === 'active');
  useEffect(() => setUser(''), [account]);

  const send = useAdminAction(
    () => post('/journeys/nudges', { org_slug: account, user_id: user || undefined, journey, step, message, prompt: prompt || undefined }),
    { success: 'Tip queued' }
  );
  const remove = useAdminAction((id: number) => adminApi('DELETE', `/journeys/nudges/${id}`), { success: 'Removed' });
  const tryStep = (r: Recipe, x: Step) => {
    setJourney(r.id);
    setStep(x.step);
    setMessage(x.message);
    setPrompt(x.prompt || '');
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast.info('Pick an account and press Queue tip');
  };

  return (
    <PageContainer
      pageTitle='Journeys'
      pageDescription='Built in PostHog Workflows (triggers, waits, branches, email, Slack). Octillion delivers the in-chat and /app steps: a tip after the next tool call (at most one a day), in get_started, and on /app.'
    >
      <ErrorBox error={error} />
      {isLoading || !j ? (
        <div className='grid gap-4 lg:grid-cols-2'>
          <Skeleton className='h-64' />
          <Skeleton className='h-64' />
        </div>
      ) : (
        <div className='flex max-w-6xl flex-col gap-8'>
          <div className='grid gap-8 lg:grid-cols-2 lg:gap-12'>
            <Section title='Connection'>
              <div className='grid gap-3 text-sm'>
                <div className='flex items-center gap-2'>
                  <span className='w-36 font-medium'>PostHog events</span>
                  <StatusBadge tone={j.posthog ? 'ok' : 'neutral'}>{j.posthog ? 'on' : 'off'}</StatusBadge>
                  {!j.posthog && <span className='text-muted-foreground text-xs'>set <Mono>POSTHOG_API_KEY</Mono></span>}
                </div>
                <div className='flex items-center gap-2'>
                  <span className='w-36 font-medium'>Journey webhook</span>
                  <StatusBadge tone={j.configured ? 'ok' : 'neutral'}>{j.configured ? 'on' : 'off'}</StatusBadge>
                  {!j.configured && <span className='text-muted-foreground text-xs'>set <Mono>OCTILLION_JOURNEY_SECRET</Mono></span>}
                </div>
                <div className='grid gap-1.5'>
                  <Label>Webhook URL (POST, JSON)</Label>
                  <CopyField value={j.webhook_url} />
                </div>
                <p className='text-muted-foreground text-xs'>
                  Send the secret as <Mono>Authorization: Bearer &lt;secret&gt;</Mono>, or append it to the URL (<Mono>…/nudges/&lt;secret&gt;</Mono>) if the step cannot set headers.
                  At most one tip per person every {j.interval_hours} hours in chat; each tip shows in chat up to {j.max_chat_shows} times. {j.muted} people turned tips off.
                </p>
              </div>
            </Section>
            <div ref={formRef}>
              <Section title='Send a tip now' description='A one-off announcement, or try a journey step before building it.'>
                <form
                  className='grid gap-3'
                  onSubmit={(e) => {
                    e.preventDefault();
                    send.mutate(undefined, {
                      onSuccess: () => {
                        setMessage('');
                        setPrompt('');
                      }
                    });
                  }}
                >
                  <div className='grid gap-3 sm:grid-cols-2'>
                    <div className='grid gap-1.5'>
                      <Label htmlFor='tip-org'>Account</Label>
                      <NativeSelect id='tip-org' className='w-full' required value={account} onChange={(e) => setOrg(e.target.value)}>
                        {(orgs?.orgs ?? []).map((o) => (
                          <NativeSelectOption key={o.slug} value={o.slug}>
                            {o.name}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>
                    <div className='grid gap-1.5'>
                      <Label htmlFor='tip-user'>Person (optional)</Label>
                      <NativeSelect id='tip-user' className='w-full' value={user} onChange={(e) => setUser(e.target.value)}>
                        <NativeSelectOption value=''>Everyone in the account</NativeSelectOption>
                        {members.map((m) => (
                          <NativeSelectOption key={m.user_id} value={m.user_id}>
                            {m.email || m.user_id}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>
                    <div className='grid gap-1.5'>
                      <Label htmlFor='tip-journey'>Journey</Label>
                      <Input id='tip-journey' value={journey} onChange={(e) => setJourney(e.target.value)} />
                    </div>
                    <div className='grid gap-1.5'>
                      <Label htmlFor='tip-step'>Step</Label>
                      <Input id='tip-step' value={step} onChange={(e) => setStep(e.target.value)} />
                    </div>
                  </div>
                  <div className='grid gap-1.5'>
                    <Label htmlFor='tip-msg'>Message <span className='text-muted-foreground font-normal'>({message.length}/280)</span></Label>
                    <Textarea id='tip-msg' maxLength={280} required rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
                  </div>
                  <div className='grid gap-1.5'>
                    <Label htmlFor='tip-prompt'>Prompt to try (optional)</Label>
                    <Input id='tip-prompt' maxLength={300} placeholder='e.g. Show my visibility report.' value={prompt} onChange={(e) => setPrompt(e.target.value)} />
                  </div>
                  <div>
                    <Button type='submit' disabled={send.isPending || !account}>
                      Queue tip
                    </Button>
                  </div>
                </form>
              </Section>
            </div>
          </div>

          <Section title='Steps delivered'>
            <DataList
              rows={j.steps}
              empty='No tips yet. Build a journey in PostHog, or send one above.'
              minWidth={560}
              cols={[
                { label: 'Journey', render: (r) => <Mono>{r.journey}</Mono> },
                { label: 'Step', render: (r) => <Mono>{r.step}</Mono> },
                { label: 'Queued', render: (r) => r.queued },
                { label: 'Shown', render: (r) => r.shown },
                { label: 'Dismissed', render: (r) => r.dismissed },
                { label: 'Active', render: (r) => r.active },
                { label: 'Last', render: (r) => <When d={r.last} /> }
              ]}
            />
          </Section>

          <Section
            title='Recommended journeys'
            description='Build each in PostHog: Workflows → New workflow, set the trigger, add the waits, and for a chat or app step add a webhook step with the body shown (POST to the URL above).'
          >
            <div className='divide-y'>
              {j.recipes.map((r) => (
                <Collapsible key={r.id} className='py-3'>
                  <CollapsibleTrigger className='group hover:bg-muted/50 -mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-md px-2 py-1 text-left'>
                    <Icons.chevronRight className='size-4 shrink-0 transition-transform group-data-panel-open:rotate-90' />
                    <span className='font-medium'>{r.name}</span>
                    <span className='text-muted-foreground truncate text-xs'>goal: {r.goal}</span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <p className='mt-2 text-sm'>
                      <span className='font-medium'>Trigger:</span> {r.trigger}
                    </p>
                    {r.steps.map((x, i) => (
                      <div key={i} className='mt-3 border-l-2 py-1 pl-4'>
                        <div className='flex flex-wrap items-center gap-2'>
                          <Mono>{x.step}</Mono>
                          {x.channels.map((c) => (
                            <StatusBadge key={c} tone={c === 'chat' || c === 'app' ? 'info' : 'neutral'}>
                              {c}
                            </StatusBadge>
                          ))}
                          <span className='text-muted-foreground text-xs'>{x.when}</span>
                        </div>
                        <p className='mt-2 text-sm'>{x.message}</p>
                        {x.channels.some((c) => c === 'chat' || c === 'app') && (
                          <>
                            <pre className='bg-muted mt-2 max-h-48 overflow-auto rounded-md p-3 font-mono text-xs'>{x.body}</pre>
                            <div className='mt-2 flex flex-wrap gap-2'>
                              <Button variant='outline' size='sm' onClick={() => copyText(x.body, 'Webhook body copied')}>
                                Copy webhook body
                              </Button>
                              <Button variant='outline' size='sm' onClick={() => tryStep(r, x)}>
                                Send to an account now
                              </Button>
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
          </Section>

          <Section title='Recent tips'>
            <DataList
              rows={j.recent}
              empty='Nothing yet.'
              minWidth={820}
              cols={[
                { label: 'When', render: (r) => <When d={r.created_at} /> },
                { label: 'Account', render: (r) => r.org_name },
                {
                  label: 'To',
                  render: (r) =>
                    r.user_id ? r.email ? r.email : <span className='font-mono text-xs' title='Not a current member'>{r.user_id}</span> : <span className='text-muted-foreground'>everyone</span>
                },
                {
                  label: 'Journey / step',
                  render: (r) => (
                    <span className='inline-flex flex-wrap items-center gap-1.5'>
                      <Mono>
                        {r.journey} / {r.step}
                      </Mono>
                      {r.source === 'admin' && <StatusBadge>manual</StatusBadge>}
                    </span>
                  )
                },
                { label: 'Message', render: (r) => <span className='text-sm'>{r.message}</span> },
                {
                  label: 'Status',
                  render: (r) =>
                    r.dismissed_at ? (
                      <StatusBadge>dismissed</StatusBadge>
                    ) : new Date(r.expires_at) < new Date() ? (
                      <StatusBadge>expired</StatusBadge>
                    ) : r.shown_count ? (
                      <StatusBadge tone='ok'>shown {r.shown_count}×</StatusBadge>
                    ) : (
                      <StatusBadge tone='info'>waiting</StatusBadge>
                    )
                },
                {
                  label: '',
                  key: 'rm',
                  className: 'text-right',
                  render: (r) => (
                    <ConfirmButton label='Remove' variant='destructive' title='Remove this tip?' description='It will no longer be shown.' confirmLabel='Remove' onConfirm={() => remove.mutate(r.id)} />
                  )
                }
              ]}
            />
          </Section>
        </div>
      )}
    </PageContainer>
  );
}
