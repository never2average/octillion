import { NavGroup } from '@/types';

/**
 * The modules of each area, shown in the left sidebar and in the Cmd+K bar.
 * /admin: Octillion staff across every account. /app: one account's people (account admins see management controls).
 */
export const adminNav: NavGroup[] = [
  {
    label: 'Onboarding',
    items: [
      { title: 'Overview', url: '/admin', icon: 'dashboard', shortcut: ['g', 'o'], items: [] },
      { title: 'Access requests', url: '/admin/requests', icon: 'inbox', shortcut: ['g', 'r'], items: [] },
      { title: 'Accounts', url: '/admin/accounts', icon: 'building', shortcut: ['g', 'a'], items: [] }
    ]
  },
  {
    label: 'Engagement',
    items: [{ title: 'Journeys', url: '/admin/journeys', icon: 'route', shortcut: ['g', 'j'], items: [] }]
  },
  {
    label: 'Insights',
    items: [{ title: 'Analytics & health', url: '/admin/analytics', icon: 'chartBar', shortcut: ['g', 'h'], items: [] }]
  },
  {
    label: 'Systems of record',
    items: [
      { title: 'Clerk · people', url: 'https://dashboard.clerk.com', icon: 'externalLink', external: true, items: [] },
      { title: 'Stripe · billing', url: 'https://dashboard.stripe.com', icon: 'externalLink', external: true, items: [] },
      { title: 'PostHog · analytics', url: 'https://us.posthog.com', icon: 'externalLink', external: true, items: [] },
      { title: 'New Relic · traces', url: 'https://one.newrelic.com', icon: 'externalLink', external: true, items: [] }
    ]
  }
];

export const portalNav: NavGroup[] = [
  {
    label: 'Get started',
    items: [{ title: 'Setup & training', url: '/app', icon: 'rocket', shortcut: ['g', 's'], items: [] }]
  },
  {
    label: 'Insights',
    items: [{ title: 'Usage', url: '/app/usage', icon: 'chartLine', shortcut: ['g', 'u'], items: [] }]
  },
  {
    label: 'Configuration',
    items: [
      { title: 'Context', url: '/app/context', icon: 'book', shortcut: ['g', 'c'], items: [] }
    ]
  },
  {
    label: 'People',
    items: [{ title: 'Team', url: '/app/team', icon: 'teams', shortcut: ['g', 't'], items: [] }]
  },
  {
    label: 'Account',
    items: [{ title: 'Billing', url: '/app/billing', icon: 'billing', shortcut: ['g', 'b'], items: [] }]
  }
];
