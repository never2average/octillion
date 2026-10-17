'use client';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';

const FAQ = [
  ['What is APO?', 'Agentic Preference Optimization is the practice of measuring and improving how often AI coding agents choose your product while they do real work: installing your package, importing your SDK, or recommending you to the developer. Octillion is the platform for it.'],
  ['How is APO different from SEO or GEO?', 'SEO optimizes for people reading search results. GEO optimizes for chatbots answering questions. APO optimizes for agents making decisions mid-task, in a real repo with real constraints, where the outcome is code rather than a link or a mention. A brand that chatbots mention can still lose when an agent actually writes the code, so APO measures what agents do, not what they say.'],
  ['Does Octillion change what the models do?', 'No. Octillion never pays for placement, injects prompts or touches the models. Agents get blind tasks that don\'t name you. You improve the things agents actually learn from and act on, such as your docs, quickstarts, examples, SDK ergonomics, package metadata and error messages, and Octillion measures whether those changes moved agent preference.'],
  ['Which models and agents do you test?', 'Octillion runs scenarios across multiple frontier coding models, so you can compare how each one behaves on the same task. The exact model lineup evolves as new models ship; tell us which ones matter to your users and we\'ll cover them during early access.'],
  ['What counts as a “recommendation”?', 'We separate it into verdicts. Adopted means the agent actually installed, imported or configured your product. Recommended means it explicitly advised using you. Mentioned is a passing reference. Competitor means it chose one of the alternatives you configured. Your recommendation rate counts Adopted and Recommended, and every verdict links to the transcript lines behind it.'],
  ['Are the agents told about my product?', 'No. Agents are blind to who is asking. They get a realistic task and a real repo, the same way a developer would hand them work. Your product context is used only to score the transcript afterwards, never to prompt the agent.'],
  ['How are transcripts stored?', 'Each run\'s raw transcript is recorded and kept with its verdict so you can audit any result. Transcripts are scoped to your organization\'s account. Ask us during onboarding if you have specific retention or data-handling requirements.'],
  ['Can I bring my own scenarios and repos?', 'Yes. Scenarios should mirror what your buyers really ask agents to do. We\'ll help you shape a starting set during onboarding.'],
  ['How much does it cost?', 'We\'re in early access. Pricing depends on how many scenarios, models and runs you need. Request access and talk to us.']
];

export function Faq() {
  return (
    <Accordion className='divide-y rounded-xl border'>
      {FAQ.map(([q, a]) => (
        <AccordionItem key={q} value={q} className='px-4 sm:px-6'>
          <AccordionTrigger className='py-4 text-left text-base font-medium'>{q}</AccordionTrigger>
          <AccordionContent className='text-muted-foreground pb-4'>{a}</AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}
