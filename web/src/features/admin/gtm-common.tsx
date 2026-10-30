'use client';
// Shared by the GTM tabs (Campaigns, Prospects, Companies, Deals, Activation, Attribution): the tab strip, the period and filters in the URL
// (as Analytics keeps them, so a filtered view can be shared), and small formatters.
import { useMemo, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { IconFilter } from '@tabler/icons-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { last30, rangeQuery, type DateRange } from '@/components/layout/date-range-picker';
import { Icons } from '@/components/icons';
import PageContainer from '@/components/layout/page-container';
import { useAdminRole } from './role';
import { Notice } from './ui';
import { cn } from '@/lib/utils';

export const GTM_TABS = [
  { href: '/admin/gtm/campaigns', label: 'Campaigns' },
  { href: '/admin/gtm/prospects', label: 'Prospects' },
  { href: '/admin/gtm/companies', label: 'Companies' },
  { href: '/admin/gtm/deals', label: 'Deals' },
  { href: '/admin/gtm/activation', label: 'Activation' },
  { href: '/admin/gtm/attribution', label: 'Attribution' }
] as const;
export const DIRECT = 'direct/unknown';
/** The GTM tabs that show people (addresses, names, owners): only with the campaigns permission. */
const PERSONAL: string[] = ['/admin/gtm/prospects', '/admin/gtm/companies', '/admin/gtm/deals'];

/** A page of personal data opened without the campaigns permission: the tabs and a notice, nothing fetched. */
export function NeedsCampaigns({ children }: { children: ReactNode }) {
  const { can, needs } = useAdminRole();
  if (can('campaigns')) return <>{children}</>;
  return (
    <PageContainer>
      <div className='flex min-w-0 flex-col gap-4'>
        <GtmTabs />
        <Notice>This page shows people&apos;s contact details: it needs the {needs('campaigns')} role. Ask an Owner on the Admins page.</Notice>
      </div>
    </PageContainer>
  );
}

/** The GTM tabs: one route each under the sidebar's single GTM entry, with the page's controls on the right. */
export function GtmTabs({ right }: { right?: ReactNode }) {
  const path = usePathname()?.replace(/\/$/, '');
  // Prospects, Companies and Deals hold personal data: their tabs are the campaigns permission's (the server refuses the rest).
  const { can } = useAdminRole();
  const tabs = GTM_TABS.filter((t) => can('campaigns') || !PERSONAL.includes(t.href));
  return (
    <div className='flex shrink-0 flex-wrap items-end gap-x-6 gap-y-2 border-b'>
      <nav className='flex gap-6 text-sm' aria-label='GTM sections'>
        {tabs.map((t) => (
          <Link key={t.href} href={t.href} aria-current={path === t.href ? 'page' : undefined}
            className={cn('-mb-px border-b-2 pb-2 font-medium', path === t.href ? 'border-foreground text-foreground' : 'text-muted-foreground hover:text-foreground border-transparent')}>
            {t.label}
          </Link>
        ))}
      </nav>
      {right && <div className='ml-auto min-w-0 pb-2'>{right}</div>}
    </div>
  );
}

const LISTS = [{ key: 'plan', label: 'Plan' }, { key: 'utm_source', label: 'UTM source' }, { key: 'utm_campaign', label: 'UTM campaign' }] as const;
export type GtmListKey = (typeof LISTS)[number]['key'];
const split = (v: string | null) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);

/** Period and filters from the URL; writes replace the entry so Back leaves the page instead of undoing a filter. */
export function useGtmParams() {
  const params = useSearchParams(), router = useRouter(), pathname = usePathname();
  const s = params.toString();
  const { range, filters } = useMemo(() => {
    const p = new URLSearchParams(s);
    const from = p.get('from'), to = p.get('to');
    const range: DateRange = from && to && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) ? { from, to } : last30();
    const filters = Object.fromEntries(LISTS.map((l) => [l.key, split(p.get(l.key))])) as Record<GtmListKey, string[]>;
    return { range, filters };
  }, [s]);
  const write = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(s);
    for (const [k, v] of Object.entries(patch)) (v ? p.set(k, v) : p.delete(k));
    const qs = p.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const setList = (k: GtmListKey, v: string[]) => write({ [k]: v.length ? v.join(',') : null });
  const setRange = (r: DateRange) => write({ from: r.from, to: r.to });
  const clear = () => write(Object.fromEntries(LISTS.map((l) => [l.key, null])));
  const active = LISTS.reduce((n, l) => n + filters[l.key].length, 0);
  const query = rangeQuery(range) + LISTS.filter((l) => filters[l.key].length).map((l) => `&${l.key}=${encodeURIComponent(filters[l.key].join(','))}`).join('');
  return { range, filters, setList, setRange, clear, active, query, rangeOnly: rangeQuery(range), open: (k: string) => params.get(k), write };
}
export type GtmParams = ReturnType<typeof useGtmParams>;

/** The Filters popover: plan, UTM source and campaign, each value with how many accounts and requests have it. */
export function GtmFilters({ p, facets }: { p: GtmParams; facets: Record<GtmListKey, Record<string, number>> | undefined }) {
  return (
    <Popover>
      <PopoverTrigger render={<Button variant='outline' className={cn(p.active && 'text-primary')} />}>
        <IconFilter /> Filters {p.active > 0 && <Badge className='h-5 min-w-5 px-1.5 text-xs leading-none'>{p.active}</Badge>}
      </PopoverTrigger>
      <PopoverContent align='end' className='flex max-h-[75svh] w-80 flex-col gap-4 overflow-y-auto'>
        {LISTS.map((l) => {
          const counts = facets?.[l.key] ?? {}, value = p.filters[l.key];
          const options = [...Object.keys(counts), ...value.filter((v) => !(v in counts))];
          return (
            <div key={l.key} className='flex flex-col gap-1.5'>
              <div className='flex items-center justify-between text-xs leading-none font-medium'>
                {l.label}
                {value.length > 0 && <Button variant='link' size='xs' className='text-muted-foreground h-auto p-0 font-normal' onClick={() => p.setList(l.key, [])}>Clear</Button>}
              </div>
              <ul className='flex max-h-40 flex-col gap-0.5 overflow-y-auto'>
                {!options.length && <li className='text-muted-foreground py-1 text-xs leading-none'>None yet.</li>}
                {options.map((o) => (
                  <li key={o}>
                    <label className='hover:bg-muted flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm leading-none'>
                      <Checkbox checked={value.includes(o)} onCheckedChange={(c) => p.setList(l.key, c ? [...value, o] : value.filter((v) => v !== o))} />
                      <span className='min-w-0 flex-1 truncate'>{o}</span>
                      {counts[o] != null && <span className='text-muted-foreground shrink-0 text-xs tabular-nums'>{counts[o]}</span>}
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {p.active > 0 && <Button variant='ghost' size='sm' className='self-start' onClick={p.clear}>Clear all</Button>}
      </PopoverContent>
    </Popover>
  );
}

/** One chip per active filter value, each with a labelled Remove; then Clear all. Nothing when no filter is on. */
export function GtmChips({ p }: { p: GtmParams }) {
  if (!p.active) return null;
  return (
    <div className='flex min-h-8 shrink-0 flex-wrap items-center gap-1.5'>
      {LISTS.flatMap((l) => p.filters[l.key].map((v) => (
        <span key={`${l.key}:${v}`} className='border-primary/40 bg-primary/10 text-primary flex h-7 items-center gap-1 rounded-full border pr-1 pl-2.5 text-xs leading-none'>
          <span className='max-w-72 truncate'><span className='font-medium'>{l.label}:</span> {v}</span>
          <Button variant='ghost' size='xs' className='h-5 px-1.5 text-xs' onClick={() => p.setList(l.key, p.filters[l.key].filter((x) => x !== v))}>
            <Icons.close className='size-3' /> Remove
          </Button>
        </span>
      )))}
      <Button variant='ghost' size='xs' className='text-muted-foreground' onClick={p.clear}>Clear all</Button>
    </div>
  );
}

/** "3h", "2.5d": a median time between steps. */
export function hours(h: number | null | undefined) {
  if (h == null) return '—';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${Math.round(h * 10) / 10}h`;
  return `${Math.round((h / 24) * 10) / 10}d`;
}
export const pctText = (p: number | null | undefined) => (p == null ? '—' : `${p}%`);
export const usd0 = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n % 1 ? 2 : 0 });
/** "newsletter / email · spring-launch", or direct/unknown. */
export const utmText = (u: { source?: string; medium?: string; campaign?: string; utm_source?: string; utm_medium?: string; utm_campaign?: string }) => {
  const s = u.source ?? u.utm_source ?? DIRECT, m = u.medium ?? u.utm_medium ?? '', c = u.campaign ?? u.utm_campaign ?? '';
  return s === DIRECT && !m && !c ? DIRECT : `${s}${m ? ` / ${m}` : ''}${c ? ` · ${c}` : ''}`;
};
