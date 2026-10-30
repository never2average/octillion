'use client';
// GTM › Prospects (src/gtm-crm.ts, src/gtm-apollo.ts): the people outbound may write to. The list (status filter,
// search, bulk enrich / status / tags / owner / delete / start a campaign), a prospect in the peek (fields, status,
// notes, the timeline, deals), and three panels in place of the list: CSV import, Find people (Apollo) and Add one.
// Owners change prospects; everyone reads.
import { Suspense, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { StatStrip } from '@/components/layout/section';
import { RecordView, type RecordCol, type RowAction } from '@/components/layout/record-view';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { adminApi } from '@/lib/api-client';
import { post, useAdmin, useAdminAction } from './lib';
import { Chips, DataList, ErrorBox, FormRow, Notice, Section, StatusBadge, When, type Tone } from './ui';
import { Gate, useAdminRole } from './role';
import { GtmTabs, useGtmParams } from './gtm-common';
import { CsvImport, type ImportField, type ImportResult } from './gtm-import';

export const STATUS_LABEL: Record<string, string> = { new: 'New', contacted: 'Contacted', replied: 'Replied', interested: 'Interested', not_interested: 'Not interested', customer: 'Customer', bad_email: 'Bad email' };
export const STATUS_TONE: Record<string, Tone> = { new: 'neutral', contacted: 'info', replied: 'ok', interested: 'ok', not_interested: 'neutral', customer: 'ok', bad_email: 'bad' };
export const BASIS_LABEL: Record<string, string> = { legitimate_interest: 'Legitimate interest (B2B)', consent: 'Consent', contract: 'Contract' };
const EMAIL_TONE: Record<string, Tone> = { verified: 'ok', likely_to_engage: 'info', unverified: 'warn', extrapolated: 'warn', unavailable: 'neutral', invalid: 'bad', unknown: 'neutral' };

export interface Prospect {
  id: number; first_name: string | null; last_name: string | null; title: string | null; seniority: string | null; email: string | null; email_status: string; linkedin_url: string | null;
  country: string | null; time_zone: string | null; status: string; owner: string | null; tags: string[]; source: string; lawful_basis: string; basis_note: string | null;
  org_id: number | null; org_slug: string | null; request_id: number | null; linked_at: string | null; enriched_at: string | null; enrichment_source: string | null;
  created_at: string; updated_at: string; company_id: number | null; company: string | null; company_domain: string | null; industry: string | null; company_size: string | null;
  company_org_id: number | null; campaigns: number; last_emailed_at: string | null; in_sequence: boolean; suppressed: boolean; restricted: boolean;
}
interface List { statuses: string[]; bases: string[]; email_statuses: string[]; sizes: string[]; prospects: Prospect[] }
interface TimelineItem { at: string; type: string; text: string; detail?: string | null; actor?: string | null }
interface Detail { prospect: Prospect & { org_name?: string | null }; timeline: TimelineItem[]; deals: { id: number; name: string; stage_label: string; kind: string; value: number; currency: string }[] }
interface ApolloStatus { connected: boolean; message: string | null; reenrich_days: number; credits_30d: number; credits_today: number; requests_30d: number; rate_limits: Record<string, number>; seniorities: string[] }
interface Found { apollo_id: string | null; first_name: string | null; last_name: string | null; title: string | null; company: string | null; domain: string | null; country: string | null; has_email: boolean | null; already: boolean }

export const personName = (p: { first_name: string | null; last_name: string | null; email?: string | null }) =>
  [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email?.split('@')[0] || '—';
const uncsv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const STATUS_FILTERS = ['all', 'new', 'contacted', 'replied', 'interested', 'not_interested', 'customer', 'bad_email'];

const IMPORT_FIELDS: ImportField[] = [
  { key: 'email', label: 'Email', aliases: ['e-mail', 'email address', 'work email'] },
  { key: 'first_name', label: 'First name', aliases: ['firstname', 'given name'] },
  { key: 'last_name', label: 'Last name', aliases: ['lastname', 'surname', 'family name'] },
  { key: 'name', label: 'Full name', aliases: ['name', 'person', 'contact'] },
  { key: 'title', label: 'Title', aliases: ['job title', 'position', 'role'] },
  { key: 'seniority', label: 'Seniority' },
  { key: 'company', label: 'Company', aliases: ['company name', 'organization', 'account'] },
  { key: 'domain', label: 'Company domain', aliases: ['domain', 'company_domain'] },
  { key: 'website', label: 'Website', aliases: ['company website', 'url'] },
  { key: 'industry', label: 'Industry' },
  { key: 'size', label: 'Company size', aliases: ['size', 'employees', 'headcount', 'company_size'] },
  { key: 'country', label: 'Country', aliases: ['country code'] },
  { key: 'time_zone', label: 'Time zone', aliases: ['timezone', 'tz'] },
  { key: 'linkedin_url', label: 'LinkedIn URL', aliases: ['linkedin', 'linkedin profile'] },
  { key: 'tags', label: 'Tags' },
  { key: 'lawful_basis', label: 'Lawful basis', aliases: ['basis', 'legal basis'] },
  { key: 'basis_note', label: 'Basis note' },
  { key: 'owner', label: 'Owner' }
];

export function AdminProspects() {
  return <Suspense fallback={<PageContainer><Skeleton className='h-72 rounded-lg' /></PageContainer>}><ProspectsPage /></Suspense>;
}

function ProspectsPage() {
  const p = useGtmParams();
  const router = useRouter();
  const { data, error, isLoading } = useAdmin<List>('/gtm/prospects', { refetchInterval: 60_000 });
  const panel = p.open('panel');
  const status = p.open('status') ?? 'all';
  const open = p.open('open');
  const all = data?.prospects ?? [];
  const rows = status === 'all' ? all : all.filter((x) => x.status === status);
  const count = (s: string) => all.filter((x) => x.status === s).length;
  const enrich = useAdminAction((v: { ids: number[]; force?: boolean }) => post<{ enriched: number; matched: number; skipped_fresh: number; credits: number }>('/gtm/apollo/enrich/prospects', v),
    { success: (r) => `Enriched ${r.enriched} (${r.matched} matched, ${r.skipped_fresh} fresh skipped, ${r.credits} credits)` });
  const bulk = useAdminAction((v: Record<string, unknown>) => post('/gtm/prospects/bulk', v), { success: 'Updated' });
  const remove = useAdminAction((ids: number[]) => post<{ deleted: number }>('/gtm/prospects/delete', { ids }), { success: (r) => `${r.deleted} deleted` });
  const startCampaign = useAdminAction((ids: number[]) => post<{ campaign: { id: number } }>('/gtm/campaigns', {
    name: `Outbound to ${ids.length} prospect${ids.length === 1 ? '' : 's'}`, conversion_days: 30,
    audience: { include: 'prospects', prospects: { prospect_ids: ids, statuses: ['new', 'contacted'], email_statuses: ['verified'] } },
    steps: [{ subject: 'A question about {{product}}', body: 'Hi {{first_name}},\n\n…\n', delay_days: 0 }]
  }), { success: 'Outbound campaign drafted: choose its sender identity and write the emails' });
  const { lock } = useAdminRole();

  const cols: RecordCol<Prospect>[] = [
    { key: 'name', label: 'Prospect', title: true, keep: true, type: 'text', className: 'min-w-52', value: (x) => personName(x),
      render: (x) => <span className='flex flex-col gap-0.5'><span className='font-medium'>{personName(x)}</span><span className='text-muted-foreground text-xs'>{x.email ?? 'no address yet'}</span></span> },
    { key: 'company', label: 'Company', type: 'text', value: (x) => x.company ?? '', render: (x) => <span className='flex flex-col gap-0.5'><span>{x.company ?? '—'}</span>{x.company_domain && <span className='text-muted-foreground text-xs'>{x.company_domain}</span>}</span> },
    { key: 'title', label: 'Title', type: 'text', value: (x) => x.title ?? '', render: (x) => <span className='text-sm'>{x.title ?? '—'}</span> },
    { key: 'status', label: 'Status', type: 'select', keep: true, value: (x) => x.status, options: (data?.statuses ?? []).map((s) => ({ value: s, label: STATUS_LABEL[s] ?? s })),
      render: (x) => <span className='flex flex-wrap gap-1'><StatusBadge tone={STATUS_TONE[x.status]}>{STATUS_LABEL[x.status] ?? x.status}</StatusBadge>
        {x.suppressed && <StatusBadge tone='bad'>suppressed</StatusBadge>}{x.in_sequence && <StatusBadge tone='info'>in a sequence</StatusBadge>}
        {x.restricted && <StatusBadge tone='warn' title='EU / EEA / UK / CH or no country: only campaigns that allow them'>restricted</StatusBadge>}</span> },
    { key: 'email_status', label: 'Email status', type: 'select', value: (x) => x.email_status, render: (x) => <StatusBadge tone={EMAIL_TONE[x.email_status]}>{x.email_status.replace(/_/g, ' ')}</StatusBadge> },
    { key: 'email', label: 'Email', type: 'text', hidden: true, value: (x) => x.email ?? '', render: (x) => x.email ?? '—' },
    { key: 'first_name', label: 'First name', type: 'text', hidden: true, value: (x) => x.first_name ?? '', render: (x) => x.first_name ?? '—' },
    { key: 'last_name', label: 'Last name', type: 'text', hidden: true, value: (x) => x.last_name ?? '', render: (x) => x.last_name ?? '—' },
    { key: 'company_domain', label: 'Company domain', type: 'text', hidden: true, value: (x) => x.company_domain ?? '', render: (x) => x.company_domain ?? '—' },
    { key: 'country', label: 'Country', type: 'select', value: (x) => x.country ?? '', render: (x) => <span className='text-sm'>{x.country ?? '—'}</span> },
    { key: 'owner', label: 'Owner', type: 'select', value: (x) => x.owner ?? '', render: (x) => <span className='text-sm'>{x.owner ?? '—'}</span> },
    { key: 'tags', label: 'Tags', type: 'text', value: (x) => x.tags.join(', '), render: (x) => <Chips items={x.tags} max={3} oneLine /> },
    { key: 'source', label: 'Source', type: 'select', value: (x) => x.source, render: (x) => <span className='text-sm'>{x.source}</span> },
    { key: 'lawful_basis', label: 'Lawful basis', type: 'select', value: (x) => x.lawful_basis, render: (x) => <span className='text-muted-foreground text-xs'>{BASIS_LABEL[x.lawful_basis] ?? x.lawful_basis}</span> },
    { key: 'campaigns', label: 'Campaigns', type: 'number', value: (x) => x.campaigns, render: (x) => <span className='tabular-nums'>{x.campaigns}</span> },
    { key: 'last_emailed_at', label: 'Last emailed', type: 'date', value: (x) => x.last_emailed_at, render: (x) => <When d={x.last_emailed_at} className='text-muted-foreground text-sm' /> },
    { key: 'updated_at', label: 'Updated', type: 'date', hidden: true, value: (x) => x.updated_at, render: (x) => <When d={x.updated_at} className='text-muted-foreground text-sm' /> }
  ];
  const back = () => p.write({ panel: null });
  const ask = (q: string) => { const v = window.prompt(q); return v == null ? null : v.trim(); };

  return (
    <PageContainer>
      <div className='flex min-w-0 flex-col gap-4'>
        <GtmTabs />
        <ErrorBox error={error} />
        {panel === 'import' ? <ImportPanel onBack={back} />
          : panel === 'find' ? <FindPanel onBack={back} />
          : panel === 'new' ? <NewProspect onBack={back} onMade={(id) => p.write({ panel: null, open: String(id) })} />
          : (<>
            <div className='flex flex-wrap items-center gap-1' role='group' aria-label='Status'>
              {STATUS_FILTERS.map((s) => (
                <Button key={s} size='sm' variant={status === s ? 'secondary' : 'ghost'} aria-pressed={status === s} onClick={() => p.write({ status: s === 'all' ? null : s, open: null })}>
                  {s === 'all' ? `All (${all.length})` : `${STATUS_LABEL[s]} (${count(s)})`}
                </Button>
              ))}
            </div>
            <RecordView<Prospect>
              id='gtm-prospects' noun='prospects' exportName='prospects' compact stacked loading={isLoading}
              rows={rows} rowKey={(x) => String(x.id)} cols={cols} openKey={open} onOpenChange={(k) => p.write({ open: k })}
              defaultSort={[{ key: 'updated_at', dir: 'desc' }]}
              searchText={(x) => `${personName(x)} ${x.email ?? ''} ${x.company ?? ''} ${x.company_domain ?? ''} ${x.title ?? ''} ${x.tags.join(' ')} ${x.owner ?? ''} ${x.country ?? ''}`}
              searchPlaceholder='Search prospects by name, email, company, title, tag, owner or country'
              onImport={() => p.write({ panel: 'import', open: null })} importLabel='Import CSV'
              primary={<span className='flex flex-wrap gap-2'>
                <Gate need='campaigns'><Button variant='outline' onClick={() => p.write({ panel: 'find', open: null })}><Icons.search /> Find people (Apollo)</Button></Gate>
                <Gate need='campaigns'><Button onClick={() => p.write({ panel: 'new', open: null })}><Icons.add /> Add prospect</Button></Gate>
              </span>}
              bulk={(sel, clear) => {
                const ids = sel.map((x) => x.id);
                const acts: RowAction[] = [
                  { label: `Enrich ${ids.length} with Apollo`, onSelect: () => enrich.mutate({ ids }, { onSuccess: clear }) },
                  { label: 'Enrich again (ignore freshness)', onSelect: () => enrich.mutate({ ids, force: true }, { onSuccess: clear }) },
                  { label: 'Start an outbound campaign', separator: true, onSelect: () => startCampaign.mutate(ids, { onSuccess: (r) => router.push(`/admin/gtm/campaigns?open=${r.campaign.id}`) }) },
                  ...(['new', 'interested', 'not_interested'] as const).map((s, i) => ({ label: `Set status: ${STATUS_LABEL[s]}`, separator: i === 0, onSelect: () => bulk.mutate({ ids, status: s }, { onSuccess: clear }) })),
                  { label: 'Add a tag…', onSelect: () => { const t = ask('Tag to add'); if (t) bulk.mutate({ ids, add_tags: [t] }, { onSuccess: clear }); } },
                  { label: 'Set owner…', onSelect: () => { const o = ask('Owner (empty: nobody)'); if (o != null) bulk.mutate({ ids, owner: o }, { onSuccess: clear }); } },
                  { label: `Delete ${ids.length}`, destructive: true, separator: true, onSelect: () => { if (window.confirm(`Delete ${ids.length} prospects? Their timelines go too; suppressions stay.`)) remove.mutate(ids, { onSuccess: clear }); } }
                ];
                return acts.map((a) => lock(a, 'campaigns'));
              }}
              empty='No prospects yet. Import a CSV or find people with Apollo.'
              summary={data && (
                <StatStrip items={[
                  { label: 'Prospects', value: all.length, hint: `${all.filter((x) => x.email).length} with an address` },
                  { label: 'Verified address', value: all.filter((x) => x.email_status === 'verified').length },
                  { label: 'Contacted', value: count('contacted'), hint: `${all.filter((x) => x.in_sequence).length} in a sequence now` },
                  { label: 'Replied', value: count('replied') + count('interested'), hint: `${count('interested')} interested` },
                  { label: 'Customers', value: count('customer'), hint: 'linked to an account' }
                ]} />
              )}
              detailTitle={(x) => <span className='flex items-center gap-2'>{personName(x)}<StatusBadge tone={STATUS_TONE[x.status]}>{STATUS_LABEL[x.status]}</StatusBadge></span>}
              detail={(x, close) => <ProspectPeek id={x.id} statuses={data?.statuses ?? []} bases={data?.bases ?? []} onDeleted={close} />}
            />
          </>)}
      </div>
    </PageContainer>
  );
}

// ---------- one prospect ----------

function ProspectPeek({ id, statuses, bases, onDeleted }: { id: number; statuses: string[]; bases: string[]; onDeleted: () => void }) {
  const { data: d, error } = useAdmin<Detail>(`/gtm/prospects/${id}`);
  const setStatus = useAdminAction((status: string) => adminApi('PUT', `/gtm/prospects/${id}`, { status }), { success: 'Status changed' });
  const enrich = useAdminAction((force: boolean) => post<{ matched: number; skipped_fresh: number; credits: number }>('/gtm/apollo/enrich/prospects', { ids: [id], force }),
    { success: (r) => (r.skipped_fresh ? 'Enriched recently: use Enrich again to spend a credit anyway' : r.matched ? `Enriched (${r.credits} credits)` : 'Apollo found no match') });
  const deal = useAdminAction(() => post<{ deal: { name: string } }>('/gtm/deals', { prospect_id: id }), { success: (r) => `Deal created: ${r.deal.name}` });
  const remove = useAdminAction(() => post('/gtm/prospects/delete', { ids: [id] }), { success: 'Prospect deleted' });
  if (error) return <ErrorBox error={error} />;
  if (!d) return <Skeleton className='h-96 rounded-lg' />;
  const x = d.prospect;
  return (
    <div className='flex flex-col gap-8'>
      <div className='flex flex-col gap-3'>
        {x.suppressed && <Notice>This address is on the suppression list: no campaign writes to it.</Notice>}
        {x.restricted && <Notice tone='info'>EU / EEA / UK / CH (or no country): only outbound campaigns that allow these prospects write to them, on the recorded basis ({BASIS_LABEL[x.lawful_basis]}).</Notice>}
        {(x.org_slug || x.company_org_id) && <Notice tone='ok'>{x.org_slug ? `Linked to the account ${x.org_name ?? x.org_slug}` : 'Their company is a customer'}: outbound never writes to them.</Notice>}
        <div className='flex flex-wrap items-center gap-2'>
          {statuses.filter((s) => s !== x.status).map((s) => (
            <Gate key={s} need='campaigns'><Button size='sm' variant='outline' disabled={setStatus.isPending} onClick={() => setStatus.mutate(s)}>Mark {STATUS_LABEL[s]?.toLowerCase() ?? s}</Button></Gate>
          ))}
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <Gate need='campaigns'><Button size='sm' variant='outline' disabled={enrich.isPending} onClick={() => enrich.mutate(false)}><Icons.sparkles /> Enrich with Apollo</Button></Gate>
          <Gate need='campaigns'><Button size='sm' variant='ghost' disabled={enrich.isPending} onClick={() => enrich.mutate(true)}><Icons.refresh /> Enrich again</Button></Gate>
          <Gate need='campaigns'><Button size='sm' variant='outline' disabled={deal.isPending} onClick={() => deal.mutate()}><Icons.add /> Create deal</Button></Gate>
          <Gate need='campaigns'><Button size='sm' variant='ghost' className='text-destructive' onClick={() => { if (window.confirm('Delete this prospect and their timeline?')) remove.mutate(undefined, { onSuccess: onDeleted }); }}><Icons.trash /> Delete</Button></Gate>
        </div>
        <p className='text-muted-foreground text-xs'>
          Added <When d={x.created_at} /> from {x.source}{x.enriched_at ? <> · enriched <When d={x.enriched_at} /> ({x.enrichment_source})</> : null}{x.linked_at ? <> · linked <When d={x.linked_at} /></> : null}
        </p>
      </div>
      <ProspectEditor key={`${x.id}:${x.updated_at}`} x={x} bases={bases} />
      <NoteBox id={id} />
      {d.deals.length > 0 && (
        <Section title='Deals'>
          <div className='border'>
            <DataList noun='deals' minWidth={420} rows={d.deals} empty='No deals.' cols={[
              { label: 'Deal', render: (r) => <span className='font-medium'>{r.name}</span> },
              { label: 'Stage', render: (r) => <StatusBadge tone={r.kind === 'won' ? 'ok' : r.kind === 'lost' ? 'neutral' : 'info'}>{r.stage_label}</StatusBadge> },
              { label: 'Value', render: (r) => <span className='tabular-nums'>{r.value.toLocaleString()} {r.currency}</span> }
            ]} />
          </div>
        </Section>
      )}
      <Section title='Timeline' description='Emails sent, opened and replied to, notes, status changes, enrichment and links to an account.'>
        <ol className='flex flex-col gap-3'>
          {!d.timeline.length && <li className='text-muted-foreground text-sm'>Nothing yet.</li>}
          {d.timeline.map((t, i) => (
            <li key={i} className='border-l-2 pl-3'>
              <div className='flex flex-wrap items-baseline gap-x-2 text-sm'><span className='font-medium'>{t.text}</span><When d={t.at} className='text-muted-foreground text-xs' />{t.actor && <span className='text-muted-foreground text-xs'>by {t.actor}</span>}</div>
              {t.detail && <p className='text-muted-foreground mt-0.5 text-sm whitespace-pre-wrap'>{t.detail}</p>}
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}

function ProspectEditor({ x, bases }: { x: Detail['prospect']; bases: string[] }) {
  const { can } = useAdminRole();
  const init = { email: x.email ?? '', first_name: x.first_name ?? '', last_name: x.last_name ?? '', title: x.title ?? '', linkedin_url: x.linkedin_url ?? '', country: x.country ?? '',
    time_zone: x.time_zone ?? '', owner: x.owner ?? '', tags: x.tags.join(', '), lawful_basis: x.lawful_basis, basis_note: x.basis_note ?? '' };
  const [f, setF] = useState(init);
  const dirty = JSON.stringify(f) !== JSON.stringify(init);
  const save = useAdminAction(() => adminApi('PUT', `/gtm/prospects/${x.id}`, { ...f, tags: uncsv(f.tags) }), { success: 'Saved' });
  const field = (k: keyof typeof f, label: string, hint?: string) => (
    <FormRow id={`p-${x.id}-${k}`} label={label} hint={hint}><Input id={`p-${x.id}-${k}`} disabled={!can('campaigns')} value={f[k]} onChange={(e) => setF((v) => ({ ...v, [k]: e.target.value }))} /></FormRow>
  );
  return (
    <Section title='Details' action={can('campaigns') && <Button size='sm' disabled={!dirty || save.isPending} onClick={() => save.mutate()}><Icons.check /> Save changes</Button>}>
      <div className='grid gap-4 sm:grid-cols-2'>
        {field('email', 'Email')}{field('title', 'Title')}
        {field('first_name', 'First name')}{field('last_name', 'Last name')}
        {field('country', 'Country', 'Two letters, e.g. DE')}{field('time_zone', 'Time zone', 'e.g. Europe/Berlin')}
        {field('owner', 'Owner')}{field('tags', 'Tags', 'Comma-separated')}
        {field('linkedin_url', 'LinkedIn URL', 'Kept as text; nothing visits it')}
        <FormRow id={`p-${x.id}-basis`} label='Lawful basis'>
          <NativeSelect id={`p-${x.id}-basis`} className='w-full' disabled={!can('campaigns')} value={f.lawful_basis} onChange={(e) => setF((v) => ({ ...v, lawful_basis: e.target.value }))}>
            {bases.map((b) => <NativeSelectOption key={b} value={b}>{BASIS_LABEL[b] ?? b}</NativeSelectOption>)}
          </NativeSelect>
        </FormRow>
        {field('basis_note', 'Basis note', 'Why this basis applies')}
      </div>
    </Section>
  );
}

function NoteBox({ id }: { id: number }) {
  const [text, setText] = useState('');
  const add = useAdminAction(() => post(`/gtm/prospects/${id}/notes`, { text }), { success: 'Note added' });
  return (
    <Section title='Add a note'>
      <form className='grid gap-2' onSubmit={(e) => { e.preventDefault(); add.mutate(undefined, { onSuccess: () => setText('') }); }}>
        <Textarea aria-label='Note' rows={3} value={text} placeholder='What happened, what is next' onChange={(e) => setText(e.target.value)} />
        <Gate need='campaigns'><Button type='submit' size='sm' variant='outline' className='self-start' disabled={!text.trim() || add.isPending}><Icons.add /> Add note</Button></Gate>
      </form>
    </Section>
  );
}

// ---------- the panels ----------

/** The import-wide lawful basis, its note, the EU / EEA / UK / CH checkbox and tags: shared by CSV import and Apollo. */
export function BasisFields({ v, set, idp }: { v: { basis: string; note: string; restricted: boolean; tags: string }; set: (patch: Partial<{ basis: string; note: string; restricted: boolean; tags: string }>) => void; idp: string }) {
  return (
    <div className='grid gap-4 rounded-lg border p-4 sm:grid-cols-2'>
      <FormRow id={`${idp}-basis`} label='Lawful basis (required)' hint='Rows with no basis of their own get this one. Rows without any basis are refused.'>
        <NativeSelect id={`${idp}-basis`} className='w-full' value={v.basis} onChange={(e) => set({ basis: e.target.value })}>
          <NativeSelectOption value=''>Choose a basis</NativeSelectOption>
          <NativeSelectOption value='legitimate_interest'>Legitimate interest (B2B outreach about their role)</NativeSelectOption>
          <NativeSelectOption value='consent'>Consent</NativeSelectOption>
          <NativeSelectOption value='contract'>Contract</NativeSelectOption>
        </NativeSelect>
      </FormRow>
      <FormRow id={`${idp}-note`} label='Basis note' hint='Why it applies, e.g. "CTOs of developer-tools companies".'>
        <Input id={`${idp}-note`} value={v.note} onChange={(e) => set({ note: e.target.value })} />
      </FormRow>
      <FormRow id={`${idp}-tags`} label='Tags for everyone imported' hint='Comma-separated.'>
        <Input id={`${idp}-tags`} value={v.tags} onChange={(e) => set({ tags: e.target.value })} />
      </FormRow>
      <label className='flex items-start gap-2 text-sm'>
        <Checkbox checked={v.restricted} onCheckedChange={(c) => set({ restricted: !!c })} />
        <span><span className='font-medium'>This basis also covers people in the EU / EEA / UK / CH</span>
          <span className='text-muted-foreground block text-xs'>Off: people there need a basis of their own in the file, else they are refused. Either way, only campaigns that allow them write to them.</span></span>
      </label>
    </div>
  );
}

function ImportPanel({ onBack }: { onBack: () => void }) {
  const [v, setV] = useState({ basis: '', note: '', restricted: false, tags: '' });
  return (
    <CsvImport fields={IMPORT_FIELDS} noun='prospects' onBack={onBack} ready={!!v.basis}
      settings={<BasisFields idp='imp' v={v} set={(patch) => setV((x) => ({ ...x, ...patch }))} />}
      run={(rows, dry) => post<ImportResult>('/gtm/prospects/import', { rows, dry_run: dry, lawful_basis: v.basis || undefined, basis_note: v.note, explicit_restricted: v.restricted, tags: uncsv(v.tags) })}
      onDone={(r) => toast.success(`Imported: ${r.summary.create} new, ${r.summary.update} filled in, ${r.summary.refuse} refused`)} />
  );
}

function FindPanel({ onBack }: { onBack: () => void }) {
  const { data: st, error } = useAdmin<ApolloStatus>('/gtm/apollo');
  const [q, setQ] = useState({ titles: '', domains: '', seniorities: [] as string[], locations: '', industries: '' });
  const [res, setRes] = useState<{ total: number; cached: boolean; people: Found[]; query: unknown } | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [v, setV] = useState({ basis: '', note: '', restricted: false, tags: '' });
  const [enrich, setEnrich] = useState(false);
  const query = { titles: uncsv(q.titles), domains: uncsv(q.domains), seniorities: q.seniorities, locations: uncsv(q.locations), industries: uncsv(q.industries), per_page: 50 };
  const search = useAdminAction((force: boolean) => post<NonNullable<typeof res>>('/gtm/apollo/search', { ...query, force }), { invalidate: ['admin', '/gtm/apollo'] });
  const imp = useAdminAction(() => post<ImportResult & { enriched: { matched: number; credits: number } | null }>('/gtm/apollo/import',
    { query, apollo_ids: [...sel], lawful_basis: v.basis, basis_note: v.note, explicit_restricted: v.restricted, tags: uncsv(v.tags), enrich }),
    { success: (r) => `Imported ${r.summary.create} new, ${r.summary.update} already there, ${r.summary.refuse} refused${r.enriched ? `; enriched ${r.enriched.matched} (${r.enriched.credits} credits)` : ''}` });
  const run = (force = false) => search.mutate(force, { onSuccess: (r) => { setRes(r); setSel(new Set()); } });
  return (
    <div className='flex flex-col gap-6'>
      <div><Button variant='outline' onClick={onBack}><Icons.chevronLeft /> Back to prospects</Button></div>
      <ErrorBox error={error} />
      {st && !st.connected && <Notice>{st.message ?? 'Apollo is not connected.'} Search and enrichment are off until then; everything else in GTM works.</Notice>}
      {st && (
        <StatStrip items={[
          { label: 'Apollo', value: st.connected ? 'Connected' : 'Off', hint: 'key vault provider apollo' },
          { label: 'Credits used', value: st.credits_30d, hint: `${st.credits_today} today (30 days)` },
          { label: 'Requests', value: st.requests_30d, hint: 'last 30 days' },
          { label: 'Left this minute', value: st.rate_limits['minute-requests-left'] ?? '—', hint: st.rate_limits['24-hour-requests-left'] != null ? `${st.rate_limits['24-hour-requests-left']} left today` : 'shown after a request' },
          { label: 'Re-enrich after', value: `${st.reenrich_days}d`, hint: 'unless forced' }
        ]} />
      )}
      <Section title='Find people' description="Apollo's people search: no credits, and no addresses (they come with enrichment, which uses credits).">
        <form className='grid gap-4' onSubmit={(e) => { e.preventDefault(); run(); }}>
          <div className='grid gap-4 sm:grid-cols-2'>
            <FormRow id='f-titles' label='Titles' hint='Comma-separated, e.g. CTO, VP Engineering'><Input id='f-titles' value={q.titles} onChange={(e) => setQ((x) => ({ ...x, titles: e.target.value }))} /></FormRow>
            <FormRow id='f-domains' label='Company domains' hint='Comma-separated, e.g. example.com'><Input id='f-domains' value={q.domains} onChange={(e) => setQ((x) => ({ ...x, domains: e.target.value }))} /></FormRow>
            <FormRow id='f-loc' label='Locations' hint='Where the person is, e.g. United States, Germany'><Input id='f-loc' value={q.locations} onChange={(e) => setQ((x) => ({ ...x, locations: e.target.value }))} /></FormRow>
            <FormRow id='f-ind' label='Industries' hint="Apollo's industry names, e.g. computer software"><Input id='f-ind' value={q.industries} onChange={(e) => setQ((x) => ({ ...x, industries: e.target.value }))} /></FormRow>
          </div>
          <div className='grid gap-1.5'>
            <span className='text-sm leading-none font-medium'>Seniority</span>
            <div className='flex flex-wrap gap-x-4 gap-y-2'>
              {(st?.seniorities ?? []).map((s) => (
                <label key={s} className='flex items-center gap-2 text-sm leading-none'>
                  <Checkbox checked={q.seniorities.includes(s)} onCheckedChange={(on) => setQ((x) => ({ ...x, seniorities: on ? [...x.seniorities, s] : x.seniorities.filter((y) => y !== s) }))} />{s.replace(/_/g, ' ')}
                </label>
              ))}
            </div>
          </div>
          <div className='flex flex-wrap gap-2'>
            <Gate need='campaigns'><Button type='submit' disabled={!st?.connected || search.isPending}><Icons.search /> {search.isPending ? 'Searching…' : 'Search'}</Button></Gate>
            {res?.cached && <Gate need='campaigns'><Button type='button' variant='ghost' onClick={() => run(true)}><Icons.refresh /> Search again (skip the day's cache)</Button></Gate>}
          </div>
        </form>
      </Section>
      {res && (
        <Section title={`${res.total} people match${res.cached ? ' (cached today)' : ''}`} description='Tick who to import. Already a prospect: imported again only fills in what is missing.'>
          <div className='flex flex-col gap-4'>
            <div className='flex flex-wrap gap-2'>
              <Button size='sm' variant='outline' onClick={() => setSel(new Set(res.people.filter((x) => x.apollo_id && !x.already).map((x) => x.apollo_id!)))}><Icons.checks /> Tick everyone new</Button>
              <Button size='sm' variant='ghost' onClick={() => setSel(new Set())}><Icons.close /> Clear</Button>
            </div>
            <div className='border'>
              <DataList<Found> noun='people' minWidth={720} height='h-[24rem]' rows={res.people} empty='Nobody matched: loosen the filters.'
                cols={[
                  { label: 'Import', className: 'w-16', render: (x) => x.apollo_id ? <Checkbox aria-label={`Import ${x.first_name ?? ''}`} checked={sel.has(x.apollo_id)} onCheckedChange={(on) => setSel((s) => { const n = new Set(s); if (on) n.add(x.apollo_id!); else n.delete(x.apollo_id!); return n; })} /> : null },
                  { label: 'Person', render: (x) => <span className='font-medium'>{[x.first_name, x.last_name].filter(Boolean).join(' ') || '—'}</span> },
                  { label: 'Title', render: (x) => <span className='text-sm'>{x.title ?? '—'}</span> },
                  { label: 'Company', render: (x) => <span className='text-sm'>{x.company ?? '—'}</span> },
                  { label: 'Country', render: (x) => <span className='text-muted-foreground text-xs'>{x.country ?? '—'}</span> },
                  { label: '', render: (x) => (x.already ? <StatusBadge tone='info'>already a prospect</StatusBadge> : x.has_email ? <StatusBadge tone='neutral'>has an address</StatusBadge> : null) }
                ]} />
            </div>
            <BasisFields idp='apo' v={v} set={(patch) => setV((x) => ({ ...x, ...patch }))} />
            <label className='flex items-center gap-2 text-sm'><Switch checked={enrich} onCheckedChange={setEnrich} /> Enrich after import (uses credits: one per person found)</label>
            <Gate need='campaigns'><Button className='self-start' disabled={!sel.size || !v.basis || imp.isPending} onClick={() => imp.mutate()}><Icons.download /> Import {sel.size} as prospects</Button></Gate>
          </div>
        </Section>
      )}
    </div>
  );
}

function NewProspect({ onBack, onMade }: { onBack: () => void; onMade: (id: number) => void }) {
  const [f, setF] = useState({ email: '', first_name: '', last_name: '', title: '', company: '', domain: '', country: '', linkedin_url: '', lawful_basis: 'legitimate_interest', basis_note: '' });
  const make = useAdminAction(() => post<Detail>('/gtm/prospects', f), { success: 'Prospect added' });
  const field = (k: keyof typeof f, label: string, hint?: string) => (
    <FormRow id={`n-${k}`} label={label} hint={hint}><Input id={`n-${k}`} value={f[k]} onChange={(e) => setF((v) => ({ ...v, [k]: e.target.value }))} /></FormRow>
  );
  return (
    <div className='flex flex-col gap-6'>
      <div><Button variant='outline' onClick={onBack}><Icons.chevronLeft /> Back to prospects</Button></div>
      <Section title='Add a prospect' description='One person. A lawful basis is required; an address on the suppression list is refused.'>
        <form className='grid gap-4' onSubmit={(e) => { e.preventDefault(); make.mutate(undefined, { onSuccess: (r) => onMade(r.prospect.id) }); }}>
          <div className='grid gap-4 sm:grid-cols-2'>
            {field('email', 'Email')}{field('title', 'Title')}{field('first_name', 'First name')}{field('last_name', 'Last name')}
            {field('company', 'Company')}{field('domain', 'Company domain', 'e.g. example.com; from the address when empty')}
            {field('country', 'Country', 'Two letters, e.g. US')}{field('linkedin_url', 'LinkedIn URL')}
            <FormRow id='n-basis' label='Lawful basis'>
              <NativeSelect id='n-basis' className='w-full' value={f.lawful_basis} onChange={(e) => setF((v) => ({ ...v, lawful_basis: e.target.value }))}>
                {Object.entries(BASIS_LABEL).map(([k, l]) => <NativeSelectOption key={k} value={k}>{l}</NativeSelectOption>)}
              </NativeSelect>
            </FormRow>
            {field('basis_note', 'Basis note')}
          </div>
          <Gate need='campaigns'><Button type='submit' className='self-start' disabled={make.isPending || !(f.email || (f.first_name && f.domain))}><Icons.add /> Add prospect</Button></Gate>
        </form>
      </Section>
    </div>
  );
}
