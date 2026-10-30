'use client';
// GTM › Deals (src/gtm-deals.ts): the pipeline. A board (a column per stage, drag a card to move it) and a table, a
// deal in the peek, a New deal form and the pipeline's stages (rename, reorder, open / won / lost). A won deal linked
// to an account shows that account's Stripe revenue now. Owners change deals; everyone reads.
import { Suspense, useState, type DragEvent } from 'react';
import Link from 'next/link';
import { DetailMeta, DetailTabs, KeyValueTable } from '@/components/layout/detail';
import PageContainer from '@/components/layout/page-container';
import { StatStrip } from '@/components/layout/section';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Icons } from '@/components/icons';
import { adminApi } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { accountHref, post, useAdmin, useAdminAction } from './lib';
import { ConfirmButton, ErrorBox, FormRow, Notice, Section, StatusBadge, When } from './ui';
import { TextDialog } from './gtm-dialogs';
import { Gate, useAdminRole } from './role';
import { formKV, GtmTabs, usd0, useGtmParams, NeedsCampaigns } from './gtm-common';

interface Stage { id: string; label: string; position: number; kind: 'open' | 'won' | 'lost' }
interface Deal {
  id: number; name: string; stage: string; kind: Stage['kind']; company_id: number | null; company: string | null; company_domain: string | null; prospect_id: number | null; prospect: string | null;
  org_id: number | null; org_slug: string | null; org_name: string | null; campaign_id: number | null; campaign: string | null; reply_id: number | null; value: number; currency: string;
  expected_close: string | null; owner: string | null; lost_reason: string | null; position: number; source: string | null; created_at: string; updated_at: string; closed_at: string | null;
  revenue: { paying: boolean; mrr_usd: number; plan: string } | null;
}
interface List { stages: Stage[]; deals: Deal[]; stripe_error: string | null; totals: { open: number; won: number; lost: number; count: number; won_mrr_usd: number } }

const money = (v: number, cur: string) => v.toLocaleString('en-US', { style: 'currency', currency: cur, maximumFractionDigits: v % 1 ? 2 : 0 });
const KIND_TONE = { open: 'info', won: 'ok', lost: 'neutral' } as const;

export function AdminDeals() {
  return <NeedsCampaigns><Suspense fallback={<PageContainer><Skeleton className='h-72 rounded-lg' /></PageContainer>}><DealsPage /></Suspense></NeedsCampaigns>;
}

function DealsPage() {
  const p = useGtmParams();
  const { data, error, isLoading } = useAdmin<List>('/gtm/deals', { refetchInterval: 60_000 });
  const view = p.open('view') === 'table' ? 'table' : p.open('view') === 'stages' ? 'stages' : 'board';
  const panel = p.open('panel');
  const open = p.open('open');
  const stages = data?.stages ?? [];
  const deals = data?.deals ?? [];
  const t = data?.totals;
  const views = (
    <div className='flex items-center gap-1' role='group' aria-label='Deals views'>
      <Button size='sm' variant={view === 'board' ? 'secondary' : 'ghost'} aria-pressed={view === 'board'} onClick={() => p.write({ view: null, panel: null })}><Icons.kanban /> Board</Button>
      <Button size='sm' variant={view === 'table' ? 'secondary' : 'ghost'} aria-pressed={view === 'table'} onClick={() => p.write({ view: 'table', panel: null })}><Icons.dashboard /> Table</Button>
      <Button size='sm' variant={view === 'stages' ? 'secondary' : 'ghost'} aria-pressed={view === 'stages'} onClick={() => p.write({ view: 'stages', panel: null, open: null })}><Icons.settings /> Pipeline stages</Button>
    </div>
  );
  const cols: RecordCol<Deal>[] = [
    { key: 'name', label: 'Deal', title: true, keep: true, type: 'text', className: 'min-w-48', value: (d) => d.name, render: (d) => <span className='font-medium'>{d.name}</span> },
    { key: 'stage', label: 'Stage', type: 'select', keep: true, value: (d) => d.stage, options: stages.map((s) => ({ value: s.id, label: s.label })),
      render: (d) => <StatusBadge tone={KIND_TONE[d.kind]}>{stages.find((s) => s.id === d.stage)?.label ?? d.stage}</StatusBadge> },
    { key: 'value', label: 'Value', type: 'number', value: (d) => d.value, render: (d) => <span className='tabular-nums'>{money(d.value, d.currency)}</span> },
    { key: 'company', label: 'Company', type: 'text', value: (d) => d.company ?? '', render: (d) => <span className='text-sm'>{d.company ?? '—'}</span> },
    { key: 'prospect', label: 'Prospect', type: 'text', value: (d) => d.prospect ?? '', render: (d) => (d.prospect_id ? <Link className='text-sm hover:underline' href={`/admin/gtm/prospects?open=${d.prospect_id}`}>{d.prospect ?? `#${d.prospect_id}`}</Link> : <span className='text-muted-foreground'>—</span>) },
    { key: 'account', label: 'Account', type: 'text', value: (d) => d.org_slug ?? '', render: (d) => (d.org_slug ? <Link className='text-sm hover:underline' href={accountHref(d.org_slug)}>{d.org_name ?? d.org_slug}</Link> : <span className='text-muted-foreground'>—</span>) },
    { key: 'mrr', label: 'MRR now', name: 'Stripe MRR now (USD)', type: 'number', value: (d) => d.revenue?.mrr_usd ?? 0, render: (d) => (d.revenue ? <span className='tabular-nums'>{usd0(d.revenue.mrr_usd)}</span> : <span className='text-muted-foreground'>—</span>) },
    { key: 'campaign', label: 'Campaign', type: 'select', value: (d) => d.campaign ?? '', render: (d) => <span className='text-sm'>{d.campaign ?? '—'}</span> },
    { key: 'source', label: 'Source', type: 'select', hidden: true, value: (d) => d.source ?? '', render: (d) => d.source ?? '—' },
    { key: 'owner', label: 'Owner', type: 'select', value: (d) => d.owner ?? '', render: (d) => <span className='text-sm'>{d.owner ?? '—'}</span> },
    { key: 'expected_close', label: 'Expected close', type: 'date', value: (d) => d.expected_close, render: (d) => <span className='text-sm'>{d.expected_close ?? '—'}</span> },
    { key: 'lost_reason', label: 'Lost reason', type: 'text', hidden: true, value: (d) => d.lost_reason ?? '', render: (d) => d.lost_reason ?? '—' },
    { key: 'updated_at', label: 'Updated', type: 'date', value: (d) => d.updated_at, render: (d) => <When d={d.updated_at} className='text-muted-foreground text-sm' /> }
  ];
  return (
    <PageContainer>
      <div className='flex min-w-0 flex-col gap-4'>
        <GtmTabs right={views} />
        <ErrorBox error={error} />
        {data?.stripe_error && <Notice>Stripe: {data.stripe_error} (revenue may be missing)</Notice>}
        {t && view !== 'stages' && (
          <StatStrip items={[
            { label: 'Open pipeline', value: usd0(t.open), hint: `${deals.filter((d) => d.kind === 'open').length} deals` },
            { label: 'Won', value: usd0(t.won), hint: `${deals.filter((d) => d.kind === 'won').length} deals` },
            { label: 'Lost', value: usd0(t.lost), hint: `${deals.filter((d) => d.kind === 'lost').length} deals` },
            { label: 'Won accounts MRR', value: usd0(t.won_mrr_usd), hint: 'from Stripe, now' }
          ]} />
        )}
        {panel === 'new' ? <NewDeal stages={stages} onBack={() => p.write({ panel: null })} onMade={(id) => p.write({ panel: null, view: 'table', open: String(id) })} />
          : view === 'stages' ? <StagesEditor key={JSON.stringify(stages)} stages={stages} />
          : view === 'board' ? (<>
            <div className='flex justify-end'><Gate need='campaigns'><Button onClick={() => p.write({ panel: 'new' })}><Icons.add /> New deal</Button></Gate></div>
            {isLoading ? <Skeleton className='h-96 rounded-lg' /> : <Board stages={stages} deals={deals} onOpen={(id) => p.write({ view: 'table', open: String(id) })} />}
          </>) : (
            <RecordView<Deal>
              id='gtm-deals' noun='deals' exportName='deals' compact stacked loading={isLoading}
              rows={deals} rowKey={(d) => String(d.id)} cols={cols} openKey={open} onOpenChange={(k) => p.write({ open: k })}
              defaultSort={[{ key: 'updated_at', dir: 'desc' }]}
              searchText={(d) => `${d.name} ${d.company ?? ''} ${d.prospect ?? ''} ${d.org_name ?? ''} ${d.campaign ?? ''} ${d.owner ?? ''} ${d.stage}`}
              searchPlaceholder='Search deals by name, company, prospect, account, campaign or owner'
              primary={<Gate need='campaigns'><Button onClick={() => p.write({ panel: 'new' })}><Icons.add /> New deal</Button></Gate>}
              empty='No deals yet. Make one from a reply or a prospect in one click, or here.'
              detailTitle={() => 'Deal'}
              detail={(d, close) => <DealEditor key={`${d.id}:${d.updated_at}`} d={d} stages={stages} onDeleted={close} />}
            />
          )}
      </div>
    </PageContainer>
  );
}

/** A column per stage; a card is dragged (HTML5 drag and drop) onto a column, or before another card. */
function Board({ stages, deals, onOpen }: { stages: Stage[]; deals: Deal[]; onOpen: (id: number) => void }) {
  const { can } = useAdminRole();
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [lost, setLost] = useState<{ id: number; stage: string; before: number | null; name: string } | null>(null);
  const move = useAdminAction((v: { id: number; stage: string; before: number | null; lost_reason?: string }) => post(`/gtm/deals/${v.id}/move`, v), { success: 'Deal moved' });
  const drop = (e: DragEvent, stage: Stage, before: number | null) => {
    e.preventDefault(); e.stopPropagation();
    const id = Number(e.dataTransfer.getData('text/plain')) || drag;
    setOver(null); setDrag(null);
    if (!id) return;
    const d = deals.find((x) => x.id === id);
    if (!d || (d.stage === stage.id && before === null && deals.filter((x) => x.stage === stage.id).at(-1)?.id === id)) return;
    // Into a lost stage: ask why first (optional), in a dialog.
    if (stage.kind === 'lost' && d.stage !== stage.id) { setLost({ id, stage: stage.id, before, name: d.name }); return; }
    move.mutate({ id, stage: stage.id, before });
  };
  return (
    <div className='flex gap-3 overflow-x-auto pb-2'>
      <TextDialog open={!!lost} title={`Why was ${lost?.name ?? 'this deal'} lost?`} description='Optional: it shows on the deal and helps the next one.' label='Lost reason'
        placeholder='e.g. chose a competitor' submitLabel='Move to lost' onSubmit={(why) => lost && move.mutate({ id: lost.id, stage: lost.stage, before: lost.before, lost_reason: why || undefined })}
        onClose={() => setLost(null)} />
      {stages.map((s) => {
        const col = deals.filter((d) => d.stage === s.id).sort((a, b) => a.position - b.position || a.id - b.id);
        const sum = col.reduce((t, d) => t + d.value, 0);
        return (
          <div key={s.id} aria-label={`${s.label} column`}
            className={cn('bg-muted/30 flex w-72 shrink-0 flex-col gap-2 rounded-lg border p-2', over === s.id && 'ring-primary ring-2')}
            onDragOver={(e) => { if (can('campaigns')) { e.preventDefault(); setOver(s.id); } }} onDragLeave={() => setOver((o) => (o === s.id ? null : o))} onDrop={(e) => drop(e, s, null)}>
            <div className='flex items-baseline justify-between gap-2 px-1'>
              <span className='text-sm font-medium'>{s.label} <span className='text-muted-foreground font-normal'>· {col.length}</span></span>
              <span className='text-muted-foreground text-xs tabular-nums'>{usd0(sum)}</span>
            </div>
            <div className='flex max-h-[60svh] min-h-24 flex-col gap-2 overflow-y-auto'>
              {!col.length && <p className='text-muted-foreground px-1 py-4 text-center text-xs'>{can('campaigns') ? 'Drop a deal here' : 'No deals'}</p>}
              {col.map((d) => (
                <div key={d.id} draggable={can('campaigns')} onDragStart={(e) => { e.dataTransfer.setData('text/plain', String(d.id)); e.dataTransfer.effectAllowed = 'move'; setDrag(d.id); }}
                  onDragEnd={() => { setDrag(null); setOver(null); }} onDragOver={(e) => { if (can('campaigns')) e.preventDefault(); }} onDrop={(e) => drop(e, s, d.id)}
                  className={cn('bg-background flex flex-col gap-1 rounded-md border p-3 text-sm shadow-xs', can('campaigns') && 'cursor-grab', drag === d.id && 'opacity-50')}>
                  <span className='font-medium'>{d.name}</span>
                  {(d.company || d.prospect) && <span className='text-muted-foreground text-xs'>{[d.company, d.prospect].filter(Boolean).join(' · ')}</span>}
                  <span className='flex flex-wrap items-baseline justify-between gap-2'>
                    <span className='tabular-nums'>{money(d.value, d.currency)}</span>
                    {d.expected_close && <span className='text-muted-foreground text-xs'>close {d.expected_close}</span>}
                  </span>
                  {d.owner && <span className='text-muted-foreground text-xs'>{d.owner}</span>}
                  {d.kind === 'won' && (d.org_slug
                    ? <span className='text-xs'><Link className='hover:underline' href={accountHref(d.org_slug)}>{d.org_name ?? d.org_slug}</Link>{d.revenue ? ` · ${d.revenue.paying ? `${usd0(d.revenue.mrr_usd)}/mo in Stripe` : 'not paying yet'}` : ''}</span>
                    : <span className='text-muted-foreground text-xs'>No account linked</span>)}
                  {d.kind === 'lost' && d.lost_reason && <span className='text-muted-foreground text-xs'>Lost: {d.lost_reason}</span>}
                  <Button size='xs' variant='ghost' className='self-start' onClick={() => onOpen(d.id)}><Icons.edit /> Open</Button>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DealEditor({ d, stages, onDeleted }: { d: Deal; stages: Stage[]; onDeleted: () => void }) {
  const { can } = useAdminRole();
  const init = { name: d.name, stage: d.stage, value: String(d.value), currency: d.currency, expected_close: d.expected_close ?? '', owner: d.owner ?? '', org: d.org_slug ?? '', lost_reason: d.lost_reason ?? '' };
  const [f, setF] = useState(init);
  const save = useAdminAction(() => adminApi('PUT', `/gtm/deals/${d.id}`, { ...f, value: Number(f.value) || 0 }), { success: 'Saved' });
  const remove = useAdminAction(() => adminApi('DELETE', `/gtm/deals/${d.id}`), { success: 'Deal deleted' });
  const dis = !can('campaigns');
  const field = (k: keyof typeof f, label: string, type = 'text', hint?: string, hidden?: boolean) =>
    formKV(`d-${d.id}-${k}`, label, <Input id={`d-${d.id}-${k}`} type={type} disabled={dis} value={f[k]} onChange={(e) => setF((v) => ({ ...v, [k]: e.target.value }))} />, hint, hidden);
  const kind = stages.find((s) => s.id === f.stage)?.kind;
  return (
    <div className='flex flex-col gap-4'>
      <DetailMeta
        title={d.name}
        badges={<StatusBadge tone={KIND_TONE[d.kind]}>{stages.find((s) => s.id === d.stage)?.label ?? d.stage}</StatusBadge>}
        actions={<>
          {!dis && <Button size='sm' disabled={JSON.stringify(f) === JSON.stringify(init) || save.isPending} onClick={() => save.mutate()}><Icons.check /> Save changes</Button>}
          <Gate need='campaigns'>
            <ConfirmButton variant='destructive' label={<><Icons.trash /> Delete deal</>} title={`Delete ${d.name}?`} confirmLabel='Delete'
              description='The deal goes from the pipeline and from Attribution.' onConfirm={() => remove.mutate(undefined, { onSuccess: onDeleted })} />
          </Gate>
        </>}
        facts={[
          { label: 'Value', value: <span className='tabular-nums'>{money(d.value, d.currency)}</span> },
          { label: 'Company', value: d.company, hint: d.company_domain ?? undefined },
          { label: 'Prospect', value: d.prospect_id ? <Link className='hover:underline' href={`/admin/gtm/prospects?open=${d.prospect_id}`}>{d.prospect ?? `#${d.prospect_id}`}</Link> : null },
          { label: 'Account', value: d.org_slug ? <Link className='hover:underline' href={accountHref(d.org_slug)}>{d.org_name ?? d.org_slug}</Link> : null },
          { label: 'MRR now', value: d.revenue ? <span className='tabular-nums'>{usd0(d.revenue.mrr_usd)}</span> : null, hint: d.revenue ? (d.revenue.paying ? `${d.revenue.plan}, Stripe` : 'not paying yet') : undefined },
          { label: 'Campaign', value: d.campaign },
          { label: 'Source', value: d.source },
          { label: 'Owner', value: d.owner },
          { label: 'Expected close', value: d.expected_close },
          { label: 'Created', value: <When d={d.created_at} /> },
          { label: 'Closed', value: d.closed_at ? <When d={d.closed_at} /> : null, hidden: !d.closed_at },
          { label: 'Lost reason', value: d.lost_reason, hidden: d.kind !== 'lost' || !d.lost_reason }
        ]}
      >
        {d.kind === 'won' && d.revenue && <Notice tone='ok'>{d.org_name ?? d.org_slug}: {d.revenue.paying ? `${usd0(d.revenue.mrr_usd)} a month on ${d.revenue.plan} (Stripe, now)` : 'not paying in Stripe yet'}.</Notice>}
      </DetailMeta>
      <DetailTabs tabs={[
        { id: 'details', label: 'Details', content: (
          <KeyValueTable rows={[
            field('name', 'Name'),
            formKV(`d-${d.id}-stage`, 'Stage', (
              <NativeSelect id={`d-${d.id}-stage`} className='w-full' disabled={dis} value={f.stage} onChange={(e) => setF((v) => ({ ...v, stage: e.target.value }))}>
                {stages.map((s) => <NativeSelectOption key={s.id} value={s.id}>{s.label}</NativeSelectOption>)}
              </NativeSelect>
            )),
            field('value', 'Value', 'number'), field('currency', 'Currency', 'text', 'Three letters, e.g. USD'),
            field('expected_close', 'Expected close', 'date'), field('owner', 'Owner'),
            field('org', 'Account (slug)', 'text', 'The Octillion account it is about; a won deal links its company’s or prospect’s account itself.'),
            field('lost_reason', 'Lost reason', 'text', undefined, kind !== 'lost')
          ]} />
        ) }
      ]} />
    </div>
  );
}

function NewDeal({ stages, onBack, onMade }: { stages: Stage[]; onBack: () => void; onMade: (id: number) => void }) {
  const [f, setF] = useState({ name: '', stage: '', value: '', currency: 'USD', expected_close: '', owner: '', company_id: '', prospect_id: '', org: '' });
  const make = useAdminAction(() => post<{ deal: { id: number } }>('/gtm/deals', { ...f, value: Number(f.value) || 0, stage: f.stage || undefined,
    company_id: f.company_id || undefined, prospect_id: f.prospect_id || undefined, org: f.org || undefined, name: f.name || undefined }), { success: 'Deal created' });
  const field = (k: keyof typeof f, label: string, type = 'text', hint?: string) => (
    <FormRow id={`nd-${k}`} label={label} hint={hint}><Input id={`nd-${k}`} type={type} value={f[k]} onChange={(e) => setF((v) => ({ ...v, [k]: e.target.value }))} /></FormRow>
  );
  return (
    <div className='flex flex-col gap-6'>
      <div><Button variant='outline' onClick={onBack}><Icons.chevronLeft /> Back to deals</Button></div>
      <Section title='New deal' description='Give a name, or a prospect or company to name it after (a prospect also brings the outbound campaign that reached them first).'>
        <form className='grid gap-4 sm:grid-cols-2' onSubmit={(e) => { e.preventDefault(); make.mutate(undefined, { onSuccess: (r) => onMade(r.deal.id) }); }}>
          {field('name', 'Name')}
          <FormRow id='nd-stage' label='Stage'>
            <NativeSelect id='nd-stage' className='w-full' value={f.stage} onChange={(e) => setF((v) => ({ ...v, stage: e.target.value }))}>
              <NativeSelectOption value=''>The first open stage</NativeSelectOption>
              {stages.map((s) => <NativeSelectOption key={s.id} value={s.id}>{s.label}</NativeSelectOption>)}
            </NativeSelect>
          </FormRow>
          {field('value', 'Value', 'number')}{field('currency', 'Currency')}{field('expected_close', 'Expected close', 'date')}{field('owner', 'Owner', 'text', 'Empty: you')}
          {field('prospect_id', 'Prospect id', 'number', 'Optional')}{field('company_id', 'Company id', 'number', 'Optional')}{field('org', 'Account (slug)', 'text', 'Optional')}
          <div className='sm:col-span-2'><Gate need='campaigns'><Button type='submit' disabled={make.isPending || !(f.name.trim() || f.prospect_id || f.company_id)}><Icons.add /> Create deal</Button></Gate></div>
        </form>
      </Section>
    </div>
  );
}

/** The pipeline's stages in order: rename, open / won / lost, move up or down, add, remove (only when empty). */
function StagesEditor({ stages }: { stages: Stage[] }) {
  const { can } = useAdminRole();
  const [list, setList] = useState(stages.map((s) => ({ id: s.id, label: s.label, kind: s.kind })));
  const save = useAdminAction(() => adminApi('PUT', '/gtm/deal-stages', { stages: list }), { success: 'Pipeline saved' });
  const set = (i: number, patch: Partial<(typeof list)[number]>) => setList((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const swap = (i: number, j: number) => setList((xs) => { const n = [...xs]; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const dis = !can('campaigns');
  return (
    <Section title='Pipeline stages' description='In board order. At least one open, one won and one lost stage; a stage with deals cannot be removed (move them first).'
      action={!dis && <Button size='sm' disabled={save.isPending || JSON.stringify(list) === JSON.stringify(stages.map((s) => ({ id: s.id, label: s.label, kind: s.kind })))} onClick={() => save.mutate()}><Icons.check /> Save pipeline</Button>}>
      <div className='flex flex-col gap-2'>
        {list.map((s, i) => (
          <div key={`${s.id}:${i}`} className='flex flex-wrap items-center gap-2 rounded-md border p-2'>
            <span className='text-muted-foreground w-6 text-sm tabular-nums'>{i + 1}</span>
            <Input aria-label={`Name of stage ${i + 1}`} className='h-8 w-48' disabled={dis} value={s.label} onChange={(e) => set(i, { label: e.target.value })} />
            <NativeSelect aria-label={`Kind of stage ${i + 1}`} className='h-8' disabled={dis} value={s.kind} onChange={(e) => set(i, { kind: e.target.value as Stage['kind'] })}>
              <NativeSelectOption value='open'>Open</NativeSelectOption><NativeSelectOption value='won'>Won</NativeSelectOption><NativeSelectOption value='lost'>Lost</NativeSelectOption>
            </NativeSelect>
            <span className='text-muted-foreground text-xs'>{s.id || 'new'}</span>
            <span className='ml-auto flex gap-1'>
              <Button size='sm' variant='ghost' disabled={dis || i === 0} onClick={() => swap(i, i - 1)}><Icons.chevronUp /> Up</Button>
              <Button size='sm' variant='ghost' disabled={dis || i === list.length - 1} onClick={() => swap(i, i + 1)}><Icons.chevronDown /> Down</Button>
              <Button size='sm' variant='ghost' className='text-destructive' disabled={dis || list.length <= 3} onClick={() => setList((xs) => xs.filter((_, j) => j !== i))}><Icons.trash /> Remove</Button>
            </span>
          </div>
        ))}
        {!dis && list.length < 20 && <Button size='sm' variant='outline' className='self-start' onClick={() => setList((xs) => [...xs, { id: '', label: 'New stage', kind: 'open' }])}><Icons.add /> Add a stage</Button>}
      </div>
    </Section>
  );
}
