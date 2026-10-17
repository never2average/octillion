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
    </>
  );
}
