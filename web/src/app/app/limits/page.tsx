import { redirect } from 'next/navigation';

// Limits moved under Billing.
export default function Page() {
  redirect('/app/billing/limits');
}
