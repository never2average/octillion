'use client';
// Overview: the onboarding funnel across every account, who needs a person, and which integrations are on.
import type { ReactNode } from 'react';
import PageContainer from '@/components/layout/page-container';
import { Icons } from '@/components/icons';
import { usd } from '@/lib/octillion-format';
import { useAdmin } from './lib';
import { Rule, StatStrip } from '@/components/layout/section';
import { ErrorBox, LoadingCards, Mono, Notice, Section, StatusBadge, When } from './ui';

interface Overview {
  public_url: string;
  stripe_error?: string;
  requests: { pending: number; approved: number; declined: number; oldest_pending: string | null };
  funnel: { id: string; label: string; reached: number }[];
  attention: { slug: string; name: string; stage_label: string; attention: string[] }[];
  active_7d: number;
  paying: number;
  trialing: number;
  orgs: number;
  integrations: {
    clerk?: boolean;
    clerk_frontend_api?: string | null;
    oauth_on_mcp: boolean;
    stripe: boolean;
    stripe_test_mode: boolean;
    spend_meter: string | null;
    require_subscription: boolean;
    default_budget_usd: number;
  };
}

function IntRow({ label, on, env, children }: { label: string; on: boolean; env?: string; children: ReactNode }) {
  return (
    <div className='flex flex-col gap-1 border-b py-3 last:border-0 sm:flex-row sm:items-center sm:gap-4'>
      <div className='flex w-48 shrink-0 items-center gap-2 font-medium'>
        {label}
        <StatusBadge tone={on ? 'ok' : 'neutral'}>{on ? 'on' : 'off'}</StatusBadge>
      </div>
      <div className='text-muted-foreground flex-1 text-sm'>{children}</div>
      {!on && env && (
        <div className='text-muted-foreground text-xs'>
          Set <Mono>{env}</Mono>
        </div>
      )}
    </div>
  );
}

export function AdminOverview() {
  const { data: o, error, isLoading } = useAdmin<Overview>('/overview');
  const reported = o ? o.funnel[o.funnel.length - 1]?.reached ?? 0 : 0;
  const max = o ? Math.max(1, o.funnel[0]?.reached ?? 1) : 1;
  const i = o?.integrations;
  return (
    <PageContainer pageTitle='Onboarding' pageDescription='From access request to first report, across every account.'>
      <ErrorBox error={error} />
      {isLoading || !o ? (
        <LoadingCards count={5} />
      ) : (
        <div className='flex max-w-6xl flex-col gap-8'>
          {o.stripe_error && <Notice>Stripe: {o.stripe_error}</Notice>}
          <StatStrip
            items={[
              { label: 'Pending requests', value: o.requests.pending, href: '/admin/requests',
                hint: o.requests.oldest_pending ? <>oldest <When d={o.requests.oldest_pending} /></> : 'inbox clear' },
              { label: 'Accounts', value: o.orgs, hint: `${o.requests.approved} approved, ${o.requests.declined} declined` },
              { label: 'Active in 7 days', value: o.active_7d, hint: 'called a tool' },
              { label: 'Paying', value: o.paying, hint: `${o.trialing || 0} trialing` },
              { label: 'Reached a report', value: reported, hint: o.orgs ? `${Math.round((reported / o.orgs) * 100)}% of accounts` : '' }
            ]}
          />

          <div className='grid gap-8 lg:grid-cols-2 lg:gap-12'>
            <Section title='Funnel' description='Accounts that reached each step.'>
              <ol className='grid gap-2.5'>
                {o.funnel.map((f, idx) => {
                  const prev = idx ? o.funnel[idx - 1].reached : f.reached;
                  const drop = idx && prev ? Math.round(((prev - f.reached) / prev) * 100) : 0;
                  return (
                    <li key={f.id} className='grid grid-cols-[minmax(0,9rem)_1fr_3rem] items-center gap-3 text-sm'>
                      <span className='truncate'>{f.label}</span>
                      <div className='bg-muted h-6 overflow-hidden rounded-md'>
                        <div className='bg-primary/85 h-full rounded-md transition-all' style={{ width: `${(f.reached / max) * 100}%` }} />
                      </div>
                      <span className='text-right tabular-nums' title={drop > 0 ? `${drop}% drop from the step before` : undefined}>
                        {f.reached}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </Section>

            <Section title='Needs attention' description='Accounts where a person should step in.'>
              {o.attention.length ? (
                <ul className='divide-y'>
                  {o.attention.map((a) => (
                    <li key={a.slug}>
                      <div className='py-2.5'>
                        <div className='flex items-center gap-2'>
                          <span className='font-medium'>{a.name}</span>
                          <StatusBadge>{a.stage_label}</StatusBadge>
                        </div>
                        <ul className='mt-1 list-disc pl-5 text-xs text-amber-700 dark:text-amber-400'>
                          {a.attention.map((x) => (
                            <li key={x}>{x}</li>
                          ))}
                        </ul>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className='text-muted-foreground py-8 text-center text-sm'>Nobody is stuck.</p>
              )}
            </Section>
          </div>

          {i && <Rule />}
          {i && (
            <Section title='Integrations' description={<>Connector: <Mono>{o.public_url}/mcp</Mono></>}>
              <IntRow label='Clerk (people)' on={Boolean(i.clerk)} env='CLERK_SECRET_KEY'>
                Organizations, users, invitations and roles live in Clerk; it sends the invitation emails.
              </IntRow>
              <IntRow label='Sign-in on /mcp' on={i.oauth_on_mcp} env='CLERK_PUBLISHABLE_KEY'>
                {i.oauth_on_mcp ? (
                  <>
                    Clerk OAuth{i.clerk_frontend_api ? <> at <Mono>{i.clerk_frontend_api}</Mono></> : null}: clients sign people in, no secret links.
                  </>
                ) : (
                  'Without it, people connect with a secret key link.'
                )}
              </IntRow>
              <IntRow label='Stripe (billing)' on={i.stripe} env='STRIPE_SECRET_KEY'>
                {i.stripe ? (
                  <>
                    {i.stripe_test_mode && <StatusBadge tone='warn' className='mr-1.5'>test mode</StatusBadge>}
                    Plans, subscriptions, invoices and cards live in Stripe.
                  </>
                ) : (
                  'Every account gets the default budget.'
                )}
              </IntRow>
              <IntRow label='Usage meter' on={Boolean(i.spend_meter)} env='STRIPE_SPEND_METER'>
                {i.spend_meter ? <>Agent model spend reported to meter <Mono>{i.spend_meter}</Mono>.</> : 'Model spend is not reported to Stripe.'}
              </IntRow>
              <IntRow label='Plan required' on={i.require_subscription} env='OCTILLION_REQUIRE_SUBSCRIPTION=1'>
                {i.require_subscription ? 'Accounts without an active or trialing plan cannot start simulations.' : 'Accounts can run without a plan.'}
              </IntRow>
              <IntRow label='Default budget' on>
                {usd(i.default_budget_usd)} a month of model spend for accounts whose plan sets none (<Mono>OCTILLION_ORG_MONTHLY_BUDGET_USD</Mono>)
              </IntRow>
            </Section>
          )}
        </div>
      )}
    </PageContainer>
  );
}
