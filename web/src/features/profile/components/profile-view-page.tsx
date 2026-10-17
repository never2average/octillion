import { UserProfile } from '@clerk/nextjs';
import PageContainer from '@/components/layout/page-container';

// Clerk's profile, flattened into the page: no card, shadow or border of its own, full width, the theme's colours.
const none = { boxShadow: 'none', border: 0, borderRadius: 0, background: 'transparent' };
const flat = {
  elements: {
    rootBox: { width: '100%' },
    cardBox: { ...none, width: '100%', maxWidth: 'none' },
    card: none,
    scrollBox: none,
    navbar: { ...none, borderRight: '1px solid var(--border)', paddingLeft: 0 },
    navbarMobileMenuRow: { background: 'transparent' },
    pageScrollBox: { paddingTop: 0 },
    footer: { display: 'none' }
  },
  variables: { colorBackground: 'var(--background)', colorText: 'var(--foreground)', colorPrimary: 'var(--primary)', borderRadius: '0.5rem' }
};

export default function ProfileViewPage() {
  return (
    <PageContainer pageTitle='Profile' pageDescription='Your name, sign-in methods and security.'>
      <UserProfile routing='hash' appearance={flat} />
    </PageContainer>
  );
}
