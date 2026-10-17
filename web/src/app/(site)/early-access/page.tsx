import type { Metadata } from 'next';
import { AccessForm } from '@/features/site/access-form';
import { Section } from '@/features/site/sections';

export const metadata: Metadata = { title: 'Early access', description: 'Request early access to Octillion and get your APO baseline.' };

export default function EarlyAccessPage() {
  return (
    <Section eyebrow='Early access' title='Get your APO baseline.' lead='Tell us your product. We’ll show where agents pick you, and where they don’t.' className='border-t-0'>
      <div className='max-w-2xl'><AccessForm /></div>
    </Section>
  );
}
