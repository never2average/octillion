'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Icons } from '../icons';
import { useNav } from './nav-context';

/** Docs, next to the search box at the top right: this area's guide (/app/docs, or the internal /admin/docs). */
export function DocsButton() {
  const pathname = usePathname();
  const { area } = useNav();
  const href = area === 'admin' ? '/admin/docs' : '/app/docs';
  const active = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Button variant={active ? 'secondary' : 'outline'} size='sm' className='gap-1.5' aria-current={active ? 'page' : undefined}
      render={<Link href={href} aria-label={area === 'admin' ? 'Internal docs' : 'Documentation'} />}>
      <Icons.book /> Docs
    </Button>
  );
}
