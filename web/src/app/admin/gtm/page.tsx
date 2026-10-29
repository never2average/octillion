import { redirect } from 'next/navigation';

/** GTM opens on Activation; Campaigns and Attribution are its other two tabs. */
export default function Page() {
  redirect('/admin/gtm/activation');
}
