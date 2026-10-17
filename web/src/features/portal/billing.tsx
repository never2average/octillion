'use client';
// /app Billing: the plan (from Stripe), this month's model spend against its cap, and Stripe-hosted checkout and portal.
import { useState } from 'react';
import PageContainer from '@/components/layout/page-container';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Icons } from '@/components/icons';
import { Section, StatStrip } from '@/components/layout/section';
import { appApi } from '@/lib/api-client';
import { money, usd } from '@/lib/octillion-format';
import { cn } from '@/lib/utils';
import { ErrorState, LoadingCards, SpendMeter, fail, useOrgLoad } from './shared';

interface Sub { status: string; plan: string | null; renews_at: string | null; cancel_at_period_end: boolean; trial_end: string | null }
interface Plan { price_id: string; name: string; amount: number | null; currency: string; interval: string | null; monthly_budget_usd: number | null }
interface Billing { enabled: boolean; customer: boolean; subscription: Sub | null; budget_usd: number; month_spend_usd: number; plans: Plan[]; can_manage: boolean }

const STATUS: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = { active: 'default', trialing: 'secondary', past_due: 'destructive', unpaid: 'destructive', canceled: 'outline' };

export function BillingPage() {
  const { data: b, error } = useOrgLoad(() => appApi<Billing>('GET', '/billing'));
  const [busy, setBusy] = useState<string | null>(null);
  const go = (path: string, body?: unknown, id = path) => {
    setBusy(id);
    appApi<{ url: string }>('POST', path, body).then((r) => { window.location.href = r.url; }).catch((e) => { setBusy(null); fail(e); });
  };
  const s = b?.subscription;
  const live = s && ['active', 'trialing', 'past_due'].includes(s.status);
  return (
    <PageContainer pageTitle='Billing' pageDescription="Your plan, this month's model spend, invoices and payment details.">
      {error ? <ErrorState error={error} /> : !b ? <LoadingCards count={2} /> : (
        <div className='flex max-w-6xl flex-col gap-8'>
          <StatStrip items={[
            { label: 'Plan', value: <span className='flex flex-wrap items-center gap-2'>{!b.enabled ? 'Beta' : s ? s.plan : 'No plan yet'}
              {b.enabled && (s ? <Badge variant={STATUS[s.status] ?? 'outline'}>{s.status.replace('_', ' ')}</Badge> : <Badge variant='outline'>no plan</Badge>)}</span>,
              hint: !b.enabled ? 'Free during the beta' : s?.renews_at ? `${s.cancel_at_period_end ? 'Ends' : 'Renews'} ${new Date(s.renews_at).toLocaleDateString()}${s.trial_end ? ` · trial until ${new Date(s.trial_end).toLocaleDateString()}` : ''}` : undefined },
            { label: 'Model spend this month', value: usd(b.month_spend_usd), hint: b.budget_usd ? `of ${usd(b.budget_usd)}` : 'no monthly cap' }
          ]} />

          <div className='grid gap-8 lg:grid-cols-2'>
            <Section title='Plan and payment' description={b.enabled && !b.can_manage ? 'Ask an account admin to change the plan.' : undefined}>
              {s && ['past_due', 'unpaid'].includes(s.status) && (
                <Alert variant='destructive'><Icons.warning /><AlertDescription>The last payment failed. Update the card to keep running simulations.</AlertDescription></Alert>
              )}
              {!b.enabled ? <p className='text-muted-foreground text-sm'>Octillion is free during the beta.</p> : b.can_manage && b.customer ? (
                <div className='flex flex-col items-start gap-2'>
                  <Button disabled={busy !== null} onClick={() => go('/billing/portal')}>
                    {busy === '/billing/portal' ? <Icons.spinner className='animate-spin' /> : <Icons.creditCard />} Manage billing
                  </Button>
                  <p className='text-muted-foreground text-xs'>Change plan or card, download invoices, or cancel, in Stripe.</p>
                </div>
              ) : null}
            </Section>
            <Section title='Model spend' description='Simulations pause when the cap is reached; your results stay available.'>
              <SpendMeter spent={b.month_spend_usd} budget={b.budget_usd} className='max-w-md' />
            </Section>
          </div>

          {b.enabled && b.plans.length > 0 && !(live && b.customer) && (
            <Section title='Plans'>
              <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
                {b.plans.map((p) => (
                  <Card key={p.price_id} className={cn(s?.plan === p.name && 'ring-primary ring-2')}>
                    <CardHeader>
                      <CardTitle>{p.name}</CardTitle>
                      <CardDescription>{p.monthly_budget_usd != null ? `${usd(p.monthly_budget_usd)} of model spend a month` : 'Model spend as you go'}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <span className='text-3xl font-semibold tabular-nums'>{money(p.amount, p.currency)}</span>
                      {p.interval && <span className='text-muted-foreground text-sm'> / {p.interval}</span>}
                    </CardContent>
                    {b.can_manage && (
                      <CardFooter className='border-t pt-4'>
                        <Button className='w-full' disabled={busy !== null} onClick={() => go('/billing/checkout', { price_id: p.price_id }, p.price_id)}>
                          {busy === p.price_id && <Icons.spinner className='animate-spin' />} Choose {p.name}
                        </Button>
                      </CardFooter>
                    )}
                  </Card>
                ))}
              </div>
            </Section>
          )}
        </div>
      )}
    </PageContainer>
  );
}
