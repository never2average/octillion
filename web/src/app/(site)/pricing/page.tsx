import type { Metadata } from 'next';
import { HeroBackdrop } from '@/features/site/sections';
import { PricingPlans } from '@/features/site/pricing';

export const metadata: Metadata = { title: 'Pricing', description: 'Octillion plans: a monthly allowance for agent simulations, with usage-based pricing beyond it.' };

export default function PricingPage() {
  return (
    <section className='relative overflow-hidden'>
      <HeroBackdrop />
      <div className='relative mx-auto max-w-6xl px-4 pt-14 pb-20 sm:px-6 sm:pt-20'>
        <p className='text-primary font-mono text-xs tracking-wider uppercase'>Pricing</p>
        <h1 className='mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl'>Pay for the simulations you run.</h1>
        <p className='text-muted-foreground mt-3 max-w-2xl text-lg text-pretty'>
          Every plan includes a monthly allowance for the coding agents we run on your tasks. Plans are invite-only during early access.
        </p>
        <PricingPlans />
      </div>
    </section>
  );
}
