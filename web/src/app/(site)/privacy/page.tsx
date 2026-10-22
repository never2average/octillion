import type { Metadata } from 'next';
import { LegalPage, PRIVACY } from '@/features/site/legal';

export const metadata: Metadata = { title: 'Privacy Policy', description: 'What data Octillion collects, why, and your choices.' };

export default function PrivacyPage() {
  return <LegalPage title='Privacy Policy' intro={PRIVACY.intro} sections={PRIVACY.sections} />;
}
