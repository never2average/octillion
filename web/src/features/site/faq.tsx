'use client';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';

const FAQ = [
  ['What is APO?', 'Agentic Preference Optimization: measuring and improving how often AI coding agents choose your product while they do real work.'],
  ['How is it different from SEO or GEO?', 'SEO is for people reading search results, GEO for chatbots answering questions. APO is for agents writing code, where the outcome is an install, not a link.'],
  ['Do the agents know about my product?', 'No. They get blind, realistic tasks in real repos. Your product is used only to score the transcript afterwards.'],
  ['Does Octillion change the models?', 'No. No paid placement, no prompt injection. You improve docs, examples and SDKs; Octillion measures whether preference moved.'],
  ['How much does it cost?', 'We’re in early access. Pricing depends on scenarios, models and runs. Request access and talk to us.']
];

export function Faq() {
  return (
    <Accordion className='divide-y border-y'>
      {FAQ.map(([q, a]) => (
        <AccordionItem key={q} value={q} className='px-0'>
          <AccordionTrigger className='py-4 text-left text-base font-medium'>{q}</AccordionTrigger>
          <AccordionContent className='text-muted-foreground pb-4'>{a}</AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}
