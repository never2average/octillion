'use client';
// /app Context: the company's context (admins), the person's own, and product profiles with their coding tasks
// (admins). Company and personal context reach the AI client on every connection; the side card shows what is sent.
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { PageTabs } from '@/components/layout/page-tabs';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { appApi } from '@/lib/api-client';
import { ErrorState, FormRow, LoadingCards, fail, useOrgLoad } from './shared';

interface Company { about: string | null; audience: string | null; competitors: string[]; terms: string | null; notes_for_ai: string | null; updated_at: string | null; updated_by: string | null }
interface Person { title: string | null; focus_product: string | null; interests: string | null; answer_style: string | null; notes: string | null }
interface Ctx { company: Company; person: Person | null; products: { slug: string; name: string }[]; can_manage: boolean; preview: string }
interface Product { slug: string; name: string; category: string | null; description: string | null; website_url: string | null; docs_url: string | null;
  aliases: string[]; packages: string[]; domains: string[]; competitors: { name: string; packages?: string[]; domains?: string[] }[] }
interface Scenario { id: number; title: string; prompt: string; expectation: string; active: boolean }

// Flat layout pieces: titled sections directly on the page, no boxes (same structure as before, so the forms read the same).
type Kids = { children: React.ReactNode; className?: string };
const Card = ({ children, className }: Kids) => <section className={['flex flex-col gap-4', className].filter(Boolean).join(' ')}>{children}</section>;
const CardHeader = ({ children }: Kids) => <div className='flex flex-col gap-1'>{children}</div>;
const CardTitle = ({ children }: Kids) => <h2 className='text-base font-semibold tracking-tight'>{children}</h2>;
const CardDescription = ({ children }: Kids) => <p className='text-muted-foreground text-sm'>{children}</p>;
const CardContent = ({ children, className }: Kids) => <div className={className}>{children}</div>;
const CardFooter = ({ children }: Kids) => <div className='pt-1'>{children}</div>;

/** A section that is a form. */
function FormCard({ onSubmit, children }: { onSubmit: (e: React.FormEvent) => void; children: React.ReactNode }) {
  return <form onSubmit={onSubmit}><Card>{children}</Card></form>;
}

const csv = (xs?: string[] | null) => (xs ?? []).join(', ');
const parseCsv = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
type Tab = 'company' | 'me' | 'products';

export type ContextSection = 'company' | 'me' | 'products';
const CONTEXT_TABS = [
  { href: '/app/context/company', label: 'Company', icon: Icons.building },
  { href: '/app/context/you', label: 'You', icon: Icons.user },
  { href: '/app/context/products', label: 'Products', icon: Icons.product }
];

/** Context: three pages (company, you, products) under one header with route tabs. */
export function ContextPage({ section }: { section: ContextSection }) {
  const { data: d, error, reload } = useOrgLoad(() => appApi<Ctx>('GET', '/context'));
  const shown: ContextSection = section === 'me' && d && !d.person ? 'company' : section;
  return (
    <PageContainer pageTitle='Context' pageDescription='What Octillion and your AI client should know about your company, about you, and about each product.'>
      <PageTabs items={d && !d.person ? CONTEXT_TABS.filter((t) => t.label !== 'You') : CONTEXT_TABS} />
      {error ? <ErrorState error={error} /> : !d ? <LoadingCards count={2} /> : (
        <div className='flex max-w-6xl flex-col gap-6'>
          <div className='grid gap-x-12 gap-y-8 lg:grid-cols-5'>
            <div className='lg:col-span-3'>
              {shown === 'company' ? <CompanyForm key='c' d={d} onSaved={reload} /> : shown === 'me' ? <PersonForm key='m' d={d} onSaved={reload} /> : <Products key='p' d={d} onSaved={reload} />}
            </div>
            <Card className='h-fit lg:col-span-2'>
              <CardHeader>
                <CardTitle>What your AI client is told</CardTitle>
                <CardDescription>Added to Octillion&apos;s instructions whenever you connect, as background. Product details are used by research and scoring.</CardDescription>
              </CardHeader>
              <CardContent>
                <pre className='bg-muted max-h-[480px] overflow-auto rounded-lg p-3 font-mono text-xs whitespace-pre-wrap'>
                  {d.preview ? d.preview.trim() : 'Nothing yet. Fill in the company and your own context.'}
                </pre>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </PageContainer>
  );
}

function CompanyForm({ d, onSaved }: { d: Ctx; onSaved: () => void }) {
  const c = d.company, ro = !d.can_manage;
  const [f, setF] = useState({ about: c.about ?? '', audience: c.audience ?? '', competitors: csv(c.competitors), terms: c.terms ?? '', notes_for_ai: c.notes_for_ai ?? '' });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const save = (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    appApi('PUT', '/context/company', { ...f, competitors: parseCsv(f.competitors) }).then(() => { toast.success('Company context saved'); onSaved(); }).catch(fail).finally(() => setBusy(false));
  };
  return (
    <FormCard onSubmit={save}>
      <CardHeader>
        <CardTitle>Company</CardTitle>
        <CardDescription>
          {ro ? 'Set by your account admins.' : 'Account admins can change this.'}
          {c.updated_at && ` Last changed ${new Date(c.updated_at).toLocaleDateString()}${c.updated_by ? ` by ${c.updated_by.replace(/^customer:/, '')}` : ''}.`}
        </CardDescription>
      </CardHeader>
      <CardContent className='grid gap-4'>
        <FormRow label='What the company does' htmlFor='cAbout'><Textarea id='cAbout' rows={3} maxLength={2000} disabled={ro} value={f.about} onChange={set('about')} /></FormRow>
        <FormRow label='The developers you build for' htmlFor='cAudience'>
          <Textarea id='cAudience' rows={2} maxLength={1000} disabled={ro} value={f.audience} onChange={set('audience')} placeholder='e.g. backend engineers at B2B SaaS companies, mostly Node and Python' />
        </FormRow>
        <FormRow label='Competitors to always track' htmlFor='cComp' hint='Comma-separated.'>
          <Input id='cComp' disabled={ro} value={f.competitors} onChange={set('competitors')} placeholder='e.g. Postmark, SendGrid, Amazon SES' />
        </FormRow>
        <FormRow label='Internal product names and terms' htmlFor='cTerms'><Textarea id='cTerms' rows={2} maxLength={1000} disabled={ro} value={f.terms} onChange={set('terms')} /></FormRow>
        <FormRow label='Anything else your AI client should know' htmlFor='cNotes'><Textarea id='cNotes' rows={2} maxLength={2000} disabled={ro} value={f.notes_for_ai} onChange={set('notes_for_ai')} /></FormRow>
      </CardContent>
      {!ro && <CardFooter><Button type='submit' disabled={busy}>Save company context</Button></CardFooter>}
    </FormCard>
  );
}

function PersonForm({ d, onSaved }: { d: Ctx; onSaved: () => void }) {
  const p = d.person!;
  const [f, setF] = useState({ title: p.title ?? '', focus_product: p.focus_product ?? '', interests: p.interests ?? '', answer_style: p.answer_style ?? '', notes: p.notes ?? '' });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const save = (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    appApi('PUT', '/context/me', { ...f, focus_product: f.focus_product || null, answer_style: f.answer_style || null })
      .then(() => { toast.success('Your context saved'); onSaved(); }).catch(fail).finally(() => setBusy(false));
  };
  return (
    <FormCard onSubmit={save}>
      <CardHeader>
        <CardTitle>You</CardTitle>
        <CardDescription>Only you see and change this. Your AI client uses it to tailor answers to you.</CardDescription>
      </CardHeader>
      <CardContent className='grid gap-4'>
        <div className='grid gap-4 sm:grid-cols-2'>
          <FormRow label='Your role' htmlFor='mTitle'><Input id='mTitle' maxLength={120} value={f.title} onChange={set('title')} placeholder='e.g. Head of DevRel' /></FormRow>
          <FormRow label='Product you work on most' htmlFor='mFocus'>
            <NativeSelect id='mFocus' value={f.focus_product} onChange={set('focus_product')}>
              <NativeSelectOption value=''>None</NativeSelectOption>
              {d.products.map((x) => <NativeSelectOption key={x.slug} value={x.slug}>{x.name}</NativeSelectOption>)}
            </NativeSelect>
          </FormRow>
        </div>
        <FormRow label='What you care about' htmlFor='mInterests'>
          <Textarea id='mInterests' rows={2} maxLength={1000} value={f.interests} onChange={set('interests')} placeholder='e.g. whether Claude Code picks us for queue work, and why we lose to BullMQ' />
        </FormRow>
        <FormRow label='How you like answers' htmlFor='mStyle'>
          <NativeSelect id='mStyle' value={f.answer_style} onChange={set('answer_style')}>
            <NativeSelectOption value=''>No preference</NativeSelectOption>
            <NativeSelectOption value='brief'>Brief</NativeSelectOption>
            <NativeSelectOption value='detailed'>Detailed, with numbers and quotes</NativeSelectOption>
            <NativeSelectOption value='executive'>For an executive</NativeSelectOption>
          </NativeSelect>
        </FormRow>
        <FormRow label='Notes' htmlFor='mNotes'><Textarea id='mNotes' rows={2} maxLength={1000} value={f.notes} onChange={set('notes')} /></FormRow>
      </CardContent>
      <CardFooter><Button type='submit' disabled={busy}>Save my context</Button></CardFooter>
    </FormCard>
  );
}

const EMPTY = { name: '', category: '', website_url: '', docs_url: '', description: '', aliases: '', packages: '', domains: '', competitors: '' };

function Products({ d, onSaved }: { d: Ctx; onSaved: () => void }) {
  const [slug, setSlug] = useState<string>(d.products[0]?.slug ?? (d.can_manage ? '__new' : ''));
  const [f, setF] = useState(EMPTY), [scenarios, setScenarios] = useState<Scenario[]>([]), [busy, setBusy] = useState(false);
  const ro = !d.can_manage, isNew = slug === '__new';
  const load = useCallback((s: string) => {
    if (!s || s === '__new') { setF(EMPTY); setScenarios([]); return; }
    appApi<{ product: Product; scenarios: Scenario[] }>('GET', `/context/products/${encodeURIComponent(s)}`).then((r) => {
      const p = r.product;
      setF({ name: p.name ?? '', category: p.category ?? '', website_url: p.website_url ?? '', docs_url: p.docs_url ?? '', description: p.description ?? '',
        aliases: csv(p.aliases), packages: csv(p.packages), domains: csv(p.domains),
        competitors: (p.competitors ?? []).map((c) => [c.name, csv(c.packages), csv(c.domains)].join(' | ')).join('\n') });
      setScenarios(r.scenarios ?? []);
    }).catch(fail);
  }, []);
  useEffect(() => { load(slug); }, [slug, load]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const save = (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    const body: Record<string, unknown> = { name: f.name.trim(), category: f.category.trim() || undefined, description: f.description.trim() || undefined,
      website_url: f.website_url.trim() || undefined, docs_url: f.docs_url.trim() || undefined };
    if (!isNew) {
      body.aliases = parseCsv(f.aliases); body.packages = parseCsv(f.packages); body.domains = parseCsv(f.domains);
      body.competitors = f.competitors.split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((a) => a[0])
        .map((a) => ({ name: a[0], packages: parseCsv(a[1] ?? ''), domains: parseCsv(a[2] ?? ''), aliases: [] }));
    }
    (isNew ? appApi<{ product: Product }>('POST', '/context/products', body) : appApi<{ product: Product }>('PUT', `/context/products/${encodeURIComponent(slug)}`, body))
      .then((r) => { toast.success('Product saved'); onSaved(); if (isNew && r?.product?.slug) setSlug(r.product.slug); else load(slug); })
      .catch(fail).finally(() => setBusy(false));
  };
  const toggle = (sc: Scenario, active: boolean) =>
    appApi('PUT', `/context/products/${encodeURIComponent(slug)}/scenarios/${sc.id}`, { active })
      .then(() => { toast.success(active ? 'Task back in use' : 'Task retired'); setScenarios((xs) => xs.map((x) => (x.id === sc.id ? { ...x, active } : x))); })
      .catch(fail);
  return (
    <div className='flex flex-col gap-8'>
      <FormCard onSubmit={save}>
        <CardHeader>
          <CardTitle>Product</CardTitle>
          <CardDescription>
            {isNew ? 'A new product starts with its name and links. Fastest: ask your AI client to onboard it, and Octillion researches the rest.'
              : ro ? 'Set by your account admins.' : 'Package names and domains are how Octillion recognises a pick in transcripts: keep them complete.'}
          </CardDescription>
        </CardHeader>
        <CardContent className='grid gap-4'>
          {(d.products.length > 0 || d.can_manage) && (
            <FormRow label='Product' htmlFor='pPick'>
              <NativeSelect id='pPick' value={slug} onChange={(e) => setSlug(e.target.value)}>
                {d.products.map((p) => <NativeSelectOption key={p.slug} value={p.slug}>{p.name}</NativeSelectOption>)}
                {d.can_manage && <NativeSelectOption value='__new'>+ New product</NativeSelectOption>}
              </NativeSelect>
            </FormRow>
          )}
          {!slug ? <p className='text-muted-foreground text-sm'>No products yet.</p> : <>
            <div className='grid gap-4 sm:grid-cols-2'>
              <FormRow label='Name' htmlFor='pName'><Input id='pName' maxLength={120} disabled={ro} required value={f.name} onChange={set('name')} /></FormRow>
              <FormRow label='Category' htmlFor='pCategory'><Input id='pCategory' maxLength={120} disabled={ro} value={f.category} onChange={set('category')} placeholder='e.g. transactional email API' /></FormRow>
              <FormRow label='Website' htmlFor='pWeb'><Input id='pWeb' type='url' disabled={ro} value={f.website_url} onChange={set('website_url')} /></FormRow>
              <FormRow label='Docs' htmlFor='pDocs'><Input id='pDocs' type='url' disabled={ro} value={f.docs_url} onChange={set('docs_url')} /></FormRow>
            </div>
            <FormRow label='Description' htmlFor='pDesc'><Textarea id='pDesc' rows={3} disabled={ro} value={f.description} onChange={set('description')} /></FormRow>
            {!isNew && <>
              <FormRow label='Other names' htmlFor='pAliases' hint='Comma-separated.'><Input id='pAliases' disabled={ro} value={f.aliases} onChange={set('aliases')} /></FormRow>
              <FormRow label='Packages agents would install' htmlFor='pPackages' hint='Comma-separated.'>
                <Input id='pPackages' className='font-mono text-xs' disabled={ro} value={f.packages} onChange={set('packages')} placeholder='npm: resend, pypi: resend' />
              </FormRow>
              <FormRow label='Domains' htmlFor='pDomains' hint='Comma-separated.'><Input id='pDomains' className='font-mono text-xs' disabled={ro} value={f.domains} onChange={set('domains')} /></FormRow>
              <FormRow label='Competitors' htmlFor='pComps' hint='One per line: Name | packages | domains'>
                <Textarea id='pComps' rows={4} className='font-mono text-xs' disabled={ro} value={f.competitors} onChange={set('competitors')} placeholder='Postmark | postmark | postmarkapp.com' />
              </FormRow>
            </>}
          </>}
        </CardContent>
        {!ro && slug && <CardFooter><Button type='submit' disabled={busy}>{isNew ? 'Create product' : 'Save product'}</Button></CardFooter>}
      </FormCard>
      {!isNew && slug && (
        <Card>
          <CardHeader>
            <CardTitle>Coding tasks</CardTitle>
            <CardDescription>The realistic tasks coding agents work on. {d.can_manage ? 'Retire a task to leave it out of new runs.' : ''}</CardDescription>
          </CardHeader>
          <CardContent className='divide-y border-y'>
            {scenarios.length ? scenarios.map((x) => (
              <div key={x.id} className='space-y-1 py-3'>
                <div className='flex flex-wrap items-center gap-2'>
                  <span className='flex-1 font-medium'>{x.title}</span>
                  <Badge variant='outline'>{x.expectation}</Badge>
                  {d.can_manage ? (
                    <label className='text-muted-foreground flex items-center gap-2 text-xs'>
                      <Switch size='sm' checked={x.active} onCheckedChange={(v) => toggle(x, Boolean(v))} /> in use
                    </label>
                  ) : !x.active && <Badge variant='secondary'>retired</Badge>}
                </div>
                <p className='text-muted-foreground text-sm'>{String(x.prompt ?? '').slice(0, 220)}{String(x.prompt ?? '').length > 220 ? '…' : ''}</p>
              </div>
            )) : <p className='text-muted-foreground text-sm'>No tasks yet.</p>}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
