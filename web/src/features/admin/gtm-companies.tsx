'use client';
// GTM › Companies (src/gtm-crm.ts): one per domain, from CSV, Apollo or by hand, linked to the Octillion account it
// became. The list (bulk enrich with Apollo), a company in the peek (fields, its prospects and deals), a CSV import
// panel and an Add form in place of the list. Owners change companies; everyone reads.
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { StatStrip } from '@/components/layout/section';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Icons } from '@/components/icons';
import { adminApi } from '@/lib/api-client';
import { accountHref, post, useAdmin, useAdminAction } from './lib';
import { ConfirmButton, DataList, ErrorBox, FormRow, Section, StatusBadge, When } from './ui';
import { Gate, useAdminRole } from './role';
import { GtmTabs, usd0, useGtmParams } from './gtm-common';
import { CsvImport, type ImportField, type ImportResult } from './gtm-import';
import { personName, STATUS_LABEL, STATUS_TONE } from './gtm-prospects';

interface Company {
  id: number; domain: string; name: string; industry: string | null; size: string | null; employees: number | null; country: string | null; source: string; owner: string | null;
  org_id: number | null; org_slug: string | null; org_name: string | null; linked_at: string | null; enriched_at: string | null; enrichment_source: string | null;
  created_at: string; updated_at: string; prospects: number; deals: number; pipeline: number;
}
interface List { companies: Company[]; sizes: string[] }
interface Detail {
  company: Company;
  prospects: { id: number; first_name: string | null; last_name: string | null; title: string | null; email: string | null; email_status: string; status: string }[];
  deals: { id: number; name: string; stage_label: string; kind: string; value: number; currency: string }[];
}

const FIELDS: ImportField[] = [
  { key: 'domain', label: 'Domain', aliases: ['company domain', 'company_domain'] },
  { key: 'website', label: 'Website', aliases: ['url', 'company website'] },
  { key: 'name', label: 'Name', aliases: ['company', 'company name', 'organization'] },
  { key: 'industry', label: 'Industry' },
  { key: 'size', label: 'Size', aliases: ['employees', 'headcount', 'company size'] },
  { key: 'country', label: 'Country' },
  { key: 'owner', label: 'Owner' }
];

export function AdminCompanies() {
  return <Suspense fallback={<PageContainer><Skeleton className='h-72 rounded-lg' /></PageContainer>}><CompaniesPage /></Suspense>;
}

function CompaniesPage() {
  const p = useGtmParams();
  const { data, error, isLoading } = useAdmin<List>('/gtm/companies', { refetchInterval: 60_000 });
  const { lock } = useAdminRole();
  const panel = p.open('panel');
  const list = data?.companies ?? [];
  const enrich = useAdminAction((v: { ids: number[]; force?: boolean }) => post<{ enriched: number; found: number; skipped_fresh: number }>('/gtm/apollo/enrich/companies', v),
    { success: (r) => `Enriched ${r.enriched} (${r.found} found, ${r.skipped_fresh} fresh skipped)` });
  const cols: RecordCol<Company>[] = [
    { key: 'name', label: 'Company', title: true, keep: true, type: 'text', className: 'min-w-48', value: (c) => c.name,
      render: (c) => <span className='flex flex-col gap-0.5'><span className='font-medium'>{c.name}</span><span className='text-muted-foreground text-xs'>{c.domain}</span></span> },
    { key: 'domain', label: 'Domain', type: 'text', hidden: true, value: (c) => c.domain, render: (c) => c.domain },
    { key: 'industry', label: 'Industry', type: 'select', value: (c) => c.industry ?? '', render: (c) => <span className='text-sm'>{c.industry ?? '—'}</span> },
    { key: 'size', label: 'Size', type: 'select', value: (c) => c.size ?? '', options: (data?.sizes ?? []).map((s) => ({ value: s })), render: (c) => <span className='text-sm'>{c.size ?? '—'}</span> },
    { key: 'employees', label: 'Employees', type: 'number', hidden: true, value: (c) => c.employees, render: (c) => <span className='tabular-nums'>{c.employees ?? '—'}</span> },
    { key: 'country', label: 'Country', type: 'select', value: (c) => c.country ?? '', render: (c) => <span className='text-sm'>{c.country ?? '—'}</span> },
    { key: 'owner', label: 'Owner', type: 'select', value: (c) => c.owner ?? '', render: (c) => <span className='text-sm'>{c.owner ?? '—'}</span> },
    { key: 'source', label: 'Source', type: 'select', value: (c) => c.source, render: (c) => <span className='text-sm'>{c.source}</span> },
    { key: 'account', label: 'Account', type: 'text', value: (c) => c.org_slug ?? '', render: (c) => (c.org_slug ? <Link className='hover:underline' href={accountHref(c.org_slug)}><StatusBadge tone='ok'>{c.org_name ?? c.org_slug}</StatusBadge></Link> : <span className='text-muted-foreground'>—</span>) },
    { key: 'prospects', label: 'Prospects', type: 'number', value: (c) => c.prospects, render: (c) => <span className='tabular-nums'>{c.prospects}</span> },
    { key: 'deals', label: 'Deals', type: 'number', value: (c) => c.deals, render: (c) => <span className='tabular-nums'>{c.deals}</span> },
    { key: 'pipeline', label: 'Pipeline', type: 'number', value: (c) => c.pipeline, render: (c) => <span className='tabular-nums'>{c.pipeline ? usd0(c.pipeline) : '—'}</span> },
    { key: 'enriched_at', label: 'Enriched', type: 'date', value: (c) => c.enriched_at, render: (c) => <When d={c.enriched_at} className='text-muted-foreground text-sm' /> }
  ];
  const back = () => p.write({ panel: null });
  return (
    <PageContainer>
      <div className='flex min-w-0 flex-col gap-4'>
        <GtmTabs />
        <ErrorBox error={error} />
        {panel === 'import' ? (
          <CsvImport fields={FIELDS} noun='companies' onBack={back}
            run={(rows, dry) => post<ImportResult>('/gtm/companies/import', { rows, dry_run: dry })}
            onDone={(r) => toast.success(`Imported: ${r.summary.create} new, ${r.summary.update} filled in, ${r.summary.refuse} refused`)} />
        ) : panel === 'new' ? <NewCompany sizes={data?.sizes ?? []} onBack={back} onMade={(id) => p.write({ panel: null, open: String(id) })} /> : (
          <RecordView<Company>
            id='gtm-companies' noun='companies' exportName='companies' compact stacked loading={isLoading}
            rows={list} rowKey={(c) => String(c.id)} cols={cols} openKey={p.open('open')} onOpenChange={(k) => p.write({ open: k })}
            defaultSort={[{ key: 'name', dir: 'asc' }]}
            searchText={(c) => `${c.name} ${c.domain} ${c.industry ?? ''} ${c.country ?? ''} ${c.owner ?? ''} ${c.org_name ?? ''}`}
            searchPlaceholder='Search companies by name, domain, industry, country, owner or account'
            onImport={() => p.write({ panel: 'import', open: null })} importLabel='Import CSV'
            primary={<Gate need='campaigns'><Button onClick={() => p.write({ panel: 'new', open: null })}><Icons.add /> Add company</Button></Gate>}
            bulk={(sel, clear) => [
              { label: `Enrich ${sel.length} with Apollo`, onSelect: () => enrich.mutate({ ids: sel.map((c) => c.id) }, { onSuccess: clear }) },
              { label: 'Enrich again (ignore freshness)', onSelect: () => enrich.mutate({ ids: sel.map((c) => c.id), force: true }, { onSuccess: clear }) }
            ].map((a) => lock(a, 'campaigns'))}
            empty='No companies yet. Import a CSV, or they appear as prospects are imported and enriched.'
            summary={data && (
              <StatStrip items={[
                { label: 'Companies', value: list.length, hint: `${list.filter((c) => c.enriched_at).length} enriched` },
                { label: 'Customers', value: list.filter((c) => c.org_id).length, hint: 'linked to an account' },
                { label: 'Prospects', value: list.reduce((t, c) => t + c.prospects, 0) },
                { label: 'Open pipeline', value: usd0(list.reduce((t, c) => t + c.pipeline, 0)) }
              ]} />
            )}
            detailTitle={(c) => c.name}
            detail={(c, close) => <CompanyPeek id={c.id} sizes={data?.sizes ?? []} onDeleted={close} />}
          />
        )}
      </div>
    </PageContainer>
  );
}

function CompanyPeek({ id, sizes, onDeleted }: { id: number; sizes: string[]; onDeleted: () => void }) {
  const { data: d, error } = useAdmin<Detail>(`/gtm/companies/${id}`);
  const remove = useAdminAction(() => adminApi('DELETE', `/gtm/companies/${id}`), { success: 'Company deleted' });
  const enrich = useAdminAction((force: boolean) => post<{ found: number; skipped_fresh: number }>('/gtm/apollo/enrich/companies', { ids: [id], force }),
    { success: (r) => (r.skipped_fresh ? 'Enriched recently: use Enrich again to spend a credit anyway' : r.found ? 'Enriched' : 'Apollo found no match') });
  if (error) return <ErrorBox error={error} />;
  if (!d) return <Skeleton className='h-96 rounded-lg' />;
  const c = d.company;
  return (
    <div className='flex flex-col gap-8'>
      <div className='flex flex-wrap items-center gap-2'>
        <Gate need='campaigns'><Button size='sm' variant='outline' disabled={enrich.isPending} onClick={() => enrich.mutate(false)}><Icons.sparkles /> Enrich with Apollo</Button></Gate>
        <Gate need='campaigns'><Button size='sm' variant='ghost' disabled={enrich.isPending} onClick={() => enrich.mutate(true)}><Icons.refresh /> Enrich again</Button></Gate>
        <Gate need='campaigns'>
          <ConfirmButton variant='destructive' label={<><Icons.trash /> Delete</>} title={`Delete ${c.name}?`} confirmLabel='Delete'
            description='The company goes; its prospects and deals stay, without a company.' onConfirm={() => remove.mutate(undefined, { onSuccess: onDeleted })} />
        </Gate>
      </div>
      <p className='text-muted-foreground text-xs'>Added <When d={c.created_at} /> from {c.source}{c.enriched_at ? <> · enriched <When d={c.enriched_at} /></> : null}{c.org_slug ? <> · account <Link className='hover:underline' href={accountHref(c.org_slug)}>{c.org_name ?? c.org_slug}</Link></> : null}</p>
      <CompanyEditor key={`${c.id}:${c.updated_at}`} c={c} sizes={sizes} />
      <Section title='Prospects'>
        <div className='border'>
          <DataList noun='prospects' minWidth={520} rows={d.prospects} empty='Nobody from this company yet.' cols={[
            { label: 'Person', render: (x) => <Link className='font-medium hover:underline' href={`/admin/gtm/prospects?open=${x.id}`}>{personName(x)}</Link> },
            { label: 'Title', render: (x) => <span className='text-sm'>{x.title ?? '—'}</span> },
            { label: 'Status', render: (x) => <StatusBadge tone={STATUS_TONE[x.status]}>{STATUS_LABEL[x.status] ?? x.status}</StatusBadge> }
          ]} />
        </div>
      </Section>
      <Section title='Deals'>
        <div className='border'>
          <DataList noun='deals' minWidth={420} rows={d.deals} empty='No deals.' cols={[
            { label: 'Deal', render: (x) => <Link className='font-medium hover:underline' href={`/admin/gtm/deals?view=table&open=${x.id}`}>{x.name}</Link> },
            { label: 'Stage', render: (x) => <StatusBadge tone={x.kind === 'won' ? 'ok' : x.kind === 'lost' ? 'neutral' : 'info'}>{x.stage_label}</StatusBadge> },
            { label: 'Value', render: (x) => <span className='tabular-nums'>{x.value.toLocaleString()} {x.currency}</span> }
          ]} />
        </div>
      </Section>
    </div>
  );
}

function CompanyEditor({ c, sizes }: { c: Company; sizes: string[] }) {
  const { can } = useAdminRole();
  const init = { name: c.name, domain: c.domain, industry: c.industry ?? '', size: c.size ?? '', country: c.country ?? '', owner: c.owner ?? '' };
  const [f, setF] = useState(init);
  const save = useAdminAction(() => adminApi('PUT', `/gtm/companies/${c.id}`, f), { success: 'Saved' });
  const dis = !can('campaigns');
  const field = (k: keyof typeof f, label: string, hint?: string) => (
    <FormRow id={`c-${c.id}-${k}`} label={label} hint={hint}><Input id={`c-${c.id}-${k}`} disabled={dis} value={f[k]} onChange={(e) => setF((v) => ({ ...v, [k]: e.target.value }))} /></FormRow>
  );
  return (
    <Section title='Details' action={!dis && <Button size='sm' disabled={JSON.stringify(f) === JSON.stringify(init) || save.isPending} onClick={() => save.mutate()}><Icons.check /> Save changes</Button>}>
      <div className='grid gap-4 sm:grid-cols-2'>
        {field('name', 'Name')}{field('domain', 'Domain')}{field('industry', 'Industry')}
        <FormRow id={`c-${c.id}-size`} label='Size'>
          <NativeSelect id={`c-${c.id}-size`} className='w-full' disabled={dis} value={f.size} onChange={(e) => setF((v) => ({ ...v, size: e.target.value }))}>
            <NativeSelectOption value=''>Unknown</NativeSelectOption>
            {sizes.map((s) => <NativeSelectOption key={s} value={s}>{s}</NativeSelectOption>)}
          </NativeSelect>
        </FormRow>
        {field('country', 'Country', 'Two letters, e.g. US')}{field('owner', 'Owner')}
      </div>
    </Section>
  );
}

function NewCompany({ sizes, onBack, onMade }: { sizes: string[]; onBack: () => void; onMade: (id: number) => void }) {
  const [f, setF] = useState({ domain: '', name: '', industry: '', size: '', country: '' });
  const make = useAdminAction(() => post<Detail>('/gtm/companies', f), { success: 'Company added' });
  return (
    <div className='flex flex-col gap-6'>
      <div><Button variant='outline' onClick={onBack}><Icons.chevronLeft /> Back to companies</Button></div>
      <Section title='Add a company' description='Its domain is the key: one company per domain.'>
        <form className='grid gap-4 sm:grid-cols-2' onSubmit={(e) => { e.preventDefault(); make.mutate(undefined, { onSuccess: (r) => onMade(r.company.id) }); }}>
          {(['domain', 'name', 'industry', 'country'] as const).map((k) => (
            <FormRow key={k} id={`nc-${k}`} label={k[0].toUpperCase() + k.slice(1)}><Input id={`nc-${k}`} value={f[k]} onChange={(e) => setF((v) => ({ ...v, [k]: e.target.value }))} /></FormRow>
          ))}
          <FormRow id='nc-size' label='Size'>
            <NativeSelect id='nc-size' className='w-full' value={f.size} onChange={(e) => setF((v) => ({ ...v, size: e.target.value }))}>
              <NativeSelectOption value=''>Unknown</NativeSelectOption>
              {sizes.map((s) => <NativeSelectOption key={s} value={s}>{s}</NativeSelectOption>)}
            </NativeSelect>
          </FormRow>
          <div className='sm:col-span-2'><Gate need='campaigns'><Button type='submit' disabled={!f.domain.trim() || make.isPending}><Icons.add /> Add company</Button></Gate></div>
        </form>
      </Section>
    </div>
  );
}
