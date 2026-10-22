'use client';
// /pricing: the live Stripe plans (GET /api/pricing, src/http.ts), with this visitor's variant of each pricing
// experiment (src/experiments.ts visitorPlans). The response sets the oct_vid cookie that keeps the variant for this
// browser and carries it into the account's Billing page. Nothing here is hard-coded: plans come from Stripe.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { IconCheck } from '@tabler/icons-react';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface Plan { id: string; name: string; description: string | null; amount: number | null; currency: string; interval: string | null;
  monthly_budget_usd: number | null; trial_days: number | null; usage: string[] }

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
const usd = (x: number) => `$${x.toLocaleString('en-US')}`;

export function PricingPlans() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    fetch('/api/pricing', { credentials: 'same-origin' }).then((r) => r.json()).then((d) => setPlans(d.plans ?? []), () => setFailed(true));
  }, []);
  if (failed || (plans && !plans.length))
    return (
      <div className='mt-12 rounded-2xl border p-8'>
        <p className='font-medium'>Pricing is tailored during early access.</p>
        <p className='text-muted-foreground mt-1 text-sm'>Tell us about your product and we’ll suggest a plan.</p>
        <Link href='/early-access' className={cn(buttonVariants(), 'mt-5')}>Request early access</Link>
      </div>
    );
  if (!plans) return <div className='mt-12 grid gap-4 md:grid-cols-3'>{[0, 1, 2].map((i) => <Skeleton key={i} className='h-80 rounded-2xl' />)}</div>;
  // The middle plan (of three or more) is the one to point at; with fewer, none.
  const featured = plans.length >= 3 ? Math.floor(plans.length / 2) : -1;
  return (
    <ol className={cn('mt-12 grid gap-4', plans.length === 1 ? 'max-w-md' : plans.length === 2 ? 'md:grid-cols-2' : 'md:grid-cols-3')}>
      {plans.map((p, i) => (
        <li key={p.id} className={cn('flex flex-col gap-5 rounded-2xl border p-6', i === featured ? 'border-primary/50 bg-primary/10 shadow-[0_0_40px_-12px] shadow-primary/40' : 'bg-card/40')}>
          <div>
            <h2 className={cn('text-lg font-semibold', i === featured && 'text-primary')}>{p.name}</h2>
            {p.description && <p className='text-muted-foreground mt-1 text-sm'>{p.description}</p>}
          </div>
          <div className='flex items-baseline gap-1'>
            {p.amount != null && p.amount > 0
              ? <><span className='text-4xl font-semibold tracking-tight tabular-nums'>{money(p.amount, p.currency)}</span>{p.interval && <span className='text-muted-foreground'>/ {p.interval}</span>}</>
              : <span className='text-2xl font-semibold'>Pay as you go</span>}
          </div>
          <ul className='flex flex-col gap-2 text-sm'>
            {p.monthly_budget_usd != null && p.monthly_budget_usd > 0 && <Item>{usd(p.monthly_budget_usd)} of agent model spend included each month</Item>}
            {p.usage.map((u) => <Item key={u}>{u}</Item>)}
            {p.trial_days ? <Item>{p.trial_days}-day free trial</Item> : null}
            <Item>Every agent session’s transcript and verdict</Item>
          </ul>
          <Link href={`/early-access?plan=${encodeURIComponent(p.id)}`} className={cn(buttonVariants({ variant: i === featured ? 'default' : 'outline' }), 'mt-auto')}>
            Request access
          </Link>
        </li>
      ))}
    </ol>
  );
}

function Item({ children }: { children: React.ReactNode }) {
  return <li className='flex gap-2'><IconCheck className='text-primary mt-0.5 size-4 shrink-0' />{children}</li>;
}
