import { redirect } from 'next/navigation';

// Settings has one page so far: API keys.
export default function Page() {
  redirect('/app/settings/api-keys');
}
