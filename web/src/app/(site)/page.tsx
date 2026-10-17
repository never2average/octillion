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
      <Section id='faq' eyebrow='FAQ' title='Questions.'>
        <div className='max-w-3xl'><Faq /></div>
      </Section>
      <Section id='access' eyebrow='Early access' title='Get your APO baseline.' lead='Tell us your product. We’ll show where agents pick you, and where they don’t.'>
        <div className='max-w-2xl'><AccessForm /></div>
      </Section>
    </>
  );
}
