import type { Metadata } from 'next';
import { LegalPage, TERMS } from '@/features/site/legal';

export const metadata: Metadata = { title: 'Terms of Service', description: 'The terms for using Octillion.' };

export default function TermsPage() {
  return <LegalPage title='Terms of Service' intro={TERMS.intro} sections={TERMS.sections} />;
}
