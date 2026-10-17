import { AccessForm } from '@/features/site/access-form';
import { Faq } from '@/features/site/faq';
import { Hero, Scorecard, Section, WhatIsApo, WhereYouWork, WhyNow } from '@/features/site/sections';

export default function LandingPage() {
  return (
    <>
      <Hero />
      <WhyNow />
      <WhatIsApo />
      <Scorecard />
      <WhereYouWork />
      <Section id='faq' eyebrow='FAQ' title='Questions, answered.'>
        <div className='max-w-3xl'><Faq /></div>
      </Section>
      <Section id='access' eyebrow='Early access' title='Start with your APO baseline.'
        lead='We’re onboarding developer-tool teams now: databases, auth, queues, hosting, observability and more. Tell us about your product and we’ll measure where coding agents prefer you today, where you lose, and why.'>
        <div className='max-w-2xl'><AccessForm /></div>
      </Section>
    </>
  );
}
