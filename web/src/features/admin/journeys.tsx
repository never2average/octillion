'use client';
// /admin Journeys, one table: the customer journeys (use-case pipelines customers follow on /app; written and promoted
// here) and the tips Octillion delivers in chat and on /app (from PostHog Workflows, or sent by hand). Row actions sit in
// each row's ⋯ menu; the PostHog connection and recommended workflows open from the New journey menu.
import { useEffect, useState } from 'react';
import PageContainer from '@/components/layout/page-container';
import { Field, RecordView, type RecordCol, type RowAction } from '@/components/layout/record-view';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { adminApi } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { Dock } from '@/features/portal/memory';
import { post, useAdmin, useAdminAction } from './lib';
import { blank, Editor, JourneyStats, type Draft, type Playbook } from './playbooks';
import { copyText, CopyField, ErrorBox, Mono, StatusBadge, When } from './ui';

interface Step { step: string; when: string; channels: string[]; message: string; prompt?: string; link?: string; body: string }
interface Recipe { id: string; name: string; goal: string; trigger: string; steps: Step[] }
interface Tip { id: number; created_at: string; expires_at: string; dismissed_at: string | null; shown_count: number; org_name: string; user_id: string | null; email: string | null;
  journey: string; step: string; source: string; message: string; prompt?: string | null }
interface Nudges {
  configured: boolean; posthog: boolean; webhook_url: string; interval_hours: number; max_chat_shows: number; muted: number;
  steps: { journey: string; step: string; queued: number; shown: number; dismissed: number; active: number; last: string }[];
  recent: Tip[]; recipes: Recipe[];
}
type Row = { key: string; kind: 'journey'; p: Playbook } | { key: string; kind: 'tip'; t: Tip };

const tipStatus = (t: Tip) => t.dismissed_at ? { tone: 'neutral' as const, label: 'dismissed' } : new Date(t.expires_at) < new Date() ? { tone: 'neutral' as const, label: 'expired' }
  : t.shown_count ? { tone: 'ok' as const, label: `shown ${t.shown_count}×` } : { tone: 'info' as const, label: 'waiting' };

export function AdminJourneys() {
  const { data: pb, error, isLoading } = useAdmin<{ playbooks: Playbook[]; tools: string[] }>('/playbooks');
  const { data: nj } = useAdmin<Nudges>('/journeys');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tipping, setTipping] = useState<Partial<{ journey: string; step: string; message: string; prompt: string }> | null>(null);
  const [setup, setSetup] = useState(false);
  const promote = useAdminAction((v: { id: string; on: boolean }) => post(`/playbooks/${v.id}/promote`, { promoted: v.on }), { success: 'Saved' });
  const remove = useAdminAction((id: string) => adminApi('DELETE', `/playbooks/${id}`), { success: 'Journey deleted' });
  const removeTip = useAdminAction((id: number) => adminApi('DELETE', `/journeys/nudges/${id}`), { success: 'Tip removed' });
  const edit = (p: Playbook) => setDraft({ ...p, stages: p.stages.map((s) => ({ ...s, tools: [...s.tools] })), example: { ...p.example }, isNew: false });

  const rows: Row[] = [
    ...(pb?.playbooks ?? []).map((p) => ({ key: `j-${p.id}`, kind: 'journey' as const, p })),
    ...(nj?.recent ?? []).map((t) => ({ key: `t-${t.id}`, kind: 'tip' as const, t }))
  ];
  const cols: RecordCol<Row>[] = [
    { key: 'type', label: 'Type', className: 'w-24', keep: true, render: (r) => <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', r.kind === 'journey' ? 'bg-sky-500/15 text-sky-400' : 'bg-amber-500/15 text-amber-400')}>{r.kind}</span> },
    { key: 'name', label: 'Name', keep: true, render: (r) => r.kind === 'journey'
      ? <span className='font-medium'>{r.p.name}</span>
      : <span className='line-clamp-1 text-sm'>{r.t.message}</span> },
    { key: 'status', label: 'Status', className: 'w-28', keep: true, render: (r) => { const st = r.kind === 'journey' ? { tone: (r.p.promoted ? 'ok' : 'neutral') as 'ok' | 'neutral', label: r.p.promoted ? 'promoted' : 'hidden' } : tipStatus(r.t); return <StatusBadge tone={st.tone}>{st.label}</StatusBadge>; } },
    { key: 'who', label: 'Audience', className: 'w-56', render: (r) => r.kind === 'journey'
      ? <span className='text-muted-foreground text-xs'>{r.p.adoption ? `${r.p.adoption.started} started · ${r.p.adoption.completed} finished` : '—'}</span>
      : <span className='text-muted-foreground text-xs'>{r.t.org_name} · {r.t.user_id ? (r.t.email ?? 'one person') : 'everyone'}</span> },
    { key: 'at', label: 'Updated', className: 'w-28', render: (r) => <When d={r.kind === 'journey' ? r.p.updated_at : r.t.created_at} className='text-muted-foreground text-xs' /> }
  ];
  const actions = (r: Row): RowAction[] => r.kind === 'journey' ? [
    { label: r.p.promoted ? 'Hide from customers' : 'Promote to customers', icon: <Icons.check />, onSelect: () => promote.mutate({ id: r.p.id, on: !r.p.promoted }) },
    { label: 'Edit', icon: <Icons.edit />, onSelect: () => edit(r.p) },
    { label: 'Delete', icon: <Icons.trash />, destructive: true, onSelect: () => { if (window.confirm(`Delete ${r.p.name}? Customers stop seeing it at once.`)) remove.mutate(r.p.id); } }
  ] : [
    { label: 'Remove tip', icon: <Icons.trash />, destructive: true, onSelect: () => removeTip.mutate(r.t.id) }
  ];

  return (
    <PageContainer>
      <ErrorBox error={error} />
      <RecordView<Row>
        rows={rows} rowKey={(r) => r.key} cols={cols} actions={actions} loading={isLoading} noun='items'
        searchText={(r) => r.kind === 'journey' ? `journey ${r.p.name} ${r.p.outcome}` : `tip ${r.t.message} ${r.t.org_name} ${r.t.email ?? ''} ${r.t.journey} ${r.t.step}`}
        searchPlaceholder='Search journeys and tips'
        primary={
          <ButtonGroup>
            <Button onClick={() => setDraft(blank())}><Icons.add /> New journey</Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size='icon' aria-label='More journey actions' className='border-primary-foreground/20 border-l' />}><Icons.chevronDown /></DropdownMenuTrigger>
              <DropdownMenuContent align='end' className='w-48'>
                <DropdownMenuItem onClick={() => setTipping({})}><Icons.send /> Send a tip</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setSetup(true)}><Icons.settings /> PostHog setup</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </ButtonGroup>
        }
        empty='No journeys or tips yet.'
        detailTitle={(r) => r.kind === 'journey' ? r.p.name : `Tip · ${r.t.org_name}`}
        detail={(r) => r.kind === 'journey' ? (
          <div className='flex flex-col gap-5'>
            <dl>
              <Field label='Outcome'>{r.p.outcome}</Field>
              {r.p.who && <Field label='For'>{r.p.who}</Field>}
              {r.p.time && <Field label='Takes'>{r.p.time}</Field>}
              <Field label='Customers see it'>{r.p.promoted ? 'Yes, promoted' : 'No, hidden'}</Field>
            </dl>
            {r.p.adoption && <JourneyStats p={r.p} />}
            <ol className='flex flex-col gap-3'>
              {r.p.stages.map((st, k) => (
                <li key={st.id ?? k} className='flex gap-3 leading-none'>
                  <span className='text-muted-foreground w-5 shrink-0 text-xs tabular-nums'>{k + 1}</span>
                  <div className='min-w-0 flex-1 space-y-1.5'>
                    <p className='text-sm font-medium'>{st.title}</p>
                    <code className='bg-muted block rounded px-2 py-1.5 text-xs whitespace-pre-wrap'>{st.prompt}</code>
                    <p className='text-muted-foreground text-xs'>{st.manual || !st.tools.length ? 'Marked by the customer' : `Done by ${st.tools.join(', ')}`}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <dl>
            <Field label='Message'>{r.t.message}</Field>
            {r.t.prompt && <Field label='Prompt'><code className='text-xs'>{r.t.prompt}</code></Field>}
            <Field label='Account'>{r.t.org_name}</Field>
            <Field label='To'>{r.t.user_id ? (r.t.email ?? r.t.user_id) : 'Everyone in the account'}</Field>
            <Field label='Journey / step'><Mono>{r.t.journey} / {r.t.step}</Mono>{r.t.source === 'admin' && <span className='text-muted-foreground'> · sent by hand</span>}</Field>
            <Field label='Status'>{(() => { const st = tipStatus(r.t); return <StatusBadge tone={st.tone}>{st.label}</StatusBadge>; })()}</Field>
            <Field label='Queued'><When d={r.t.created_at} /></Field>
          </dl>
        )}
      />
      {draft && <Editor draft={draft} tools={pb?.tools ?? []} onClose={() => setDraft(null)} />}
      {tipping && <TipDock initial={tipping} onClose={() => setTipping(null)} />}
      {setup && nj && <PostHogSetup j={nj} onClose={() => setSetup(false)} onTry={(r, x) => { setSetup(false); setTipping({ journey: r.id, step: x.step, message: x.message, prompt: x.prompt ?? '' }); }} />}
    </PageContainer>
  );
}

/** Send a tip by hand: an account (and optionally one person), the journey/step it counts as, the message and a prompt. */
function TipDock({ initial, onClose }: { initial: Partial<{ journey: string; step: string; message: string; prompt: string }>; onClose: () => void }) {
  const { data: orgs } = useAdmin<{ orgs: { slug: string; name: string }[] }>('/orgs');
  const [org, setOrg] = useState('');
  const [user, setUser] = useState('');
  const [f, setF] = useState({ journey: initial.journey ?? 'manual', step: initial.step ?? 'announcement', message: initial.message ?? '', prompt: initial.prompt ?? '' });
  const account = org || orgs?.orgs[0]?.slug || '';
  const { data: detail } = useAdmin<{ members: { user_id: string; email: string | null; status: string }[] }>(account ? `/orgs/${encodeURIComponent(account)}` : null);
  useEffect(() => setUser(''), [account]);
  const send = useAdminAction(() => post('/journeys/nudges', { org_slug: account, user_id: user || undefined, journey: f.journey, step: f.step, message: f.message, prompt: f.prompt || undefined }), { success: 'Tip queued' });
  return (
    <Dock title='Send a tip' onClose={onClose}>
      <form className='flex flex-col gap-3 p-4' onSubmit={(e) => { e.preventDefault(); send.mutate(undefined, { onSuccess: onClose }); }}>
        <div className='grid gap-2 sm:grid-cols-2'>
          <NativeSelect aria-label='Account' value={account} onChange={(e) => setOrg(e.target.value)} className='w-full'>
            {(orgs?.orgs ?? []).map((o) => <NativeSelectOption key={o.slug} value={o.slug}>{o.name}</NativeSelectOption>)}
          </NativeSelect>
          <NativeSelect aria-label='Person' value={user} onChange={(e) => setUser(e.target.value)} className='w-full'>
            <NativeSelectOption value=''>Everyone in the account</NativeSelectOption>
            {(detail?.members ?? []).filter((m) => m.status === 'active').map((m) => <NativeSelectOption key={m.user_id} value={m.user_id}>{m.email || m.user_id}</NativeSelectOption>)}
          </NativeSelect>
          <Input aria-label='Journey' placeholder='Journey' value={f.journey} onChange={(e) => setF({ ...f, journey: e.target.value })} />
          <Input aria-label='Step' placeholder='Step' value={f.step} onChange={(e) => setF({ ...f, step: e.target.value })} />
        </div>
        <Textarea aria-label='Message' required maxLength={280} rows={3} placeholder='The tip, up to 280 characters' value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} className='resize-none' />
        <Input aria-label='Prompt' maxLength={300} placeholder='Prompt to try (optional), e.g. Show my visibility report.' value={f.prompt} onChange={(e) => setF({ ...f, prompt: e.target.value })} />
        <div className='flex items-center gap-2 border-t pt-3'>
          <Button type='submit' disabled={send.isPending || !account || !f.message.trim()}>Queue tip</Button>
          <span className='text-muted-foreground ml-auto text-xs tabular-nums'>{f.message.length}/280</span>
        </div>
      </form>
    </Dock>
  );
}

/** The PostHog connection, what has been delivered, and the recommended workflows to build there. */
function PostHogSetup({ j, onClose, onTry }: { j: Nudges; onClose: () => void; onTry: (r: Recipe, x: Step) => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>PostHog setup</DialogTitle>
          <DialogDescription>Tips come from PostHog Workflows: a webhook step posts to Octillion, which shows the tip in chat and on /app.</DialogDescription>
        </DialogHeader>
        <dl>
          <Field label='PostHog events'><StatusBadge tone={j.posthog ? 'ok' : 'neutral'}>{j.posthog ? 'on' : 'off'}</StatusBadge>{!j.posthog && <span className='text-muted-foreground text-xs'> set <Mono>POSTHOG_API_KEY</Mono></span>}</Field>
          <Field label='Journey webhook'><StatusBadge tone={j.configured ? 'ok' : 'neutral'}>{j.configured ? 'on' : 'off'}</StatusBadge>{!j.configured && <span className='text-muted-foreground text-xs'> set <Mono>OCTILLION_JOURNEY_SECRET</Mono></span>}</Field>
          <Field label='Webhook URL'><CopyField value={j.webhook_url} /></Field>
          <Field label='Limits'>One tip per person every {j.interval_hours} h in chat, shown up to {j.max_chat_shows}×; {j.muted} people turned tips off.</Field>
          <Field label='Delivered'>{j.steps.length ? j.steps.map((x) => `${x.journey}/${x.step}: ${x.shown} shown of ${x.queued}`).join(' · ') : 'Nothing yet.'}</Field>
        </dl>
        <div className='space-y-3'>
          <p className='text-sm font-medium'>Recommended workflows</p>
          {j.recipes.map((r) => (
            <details key={r.id} className='group rounded-lg border p-3'>
              <summary className='flex cursor-pointer list-none items-center gap-2 text-sm leading-none'>
                <Icons.chevronRight className='size-4 transition-transform group-open:rotate-90' /><span className='font-medium'>{r.name}</span><span className='text-muted-foreground truncate text-xs'>{r.goal}</span>
              </summary>
              <p className='mt-3 text-sm'><span className='font-medium'>Trigger:</span> {r.trigger}</p>
              {r.steps.filter((x) => x.channels.some((c) => c === 'chat' || c === 'app')).map((x, i) => (
                <div key={i} className='mt-3 space-y-2 border-l-2 pl-3'>
                  <p className='text-xs leading-none'><Mono>{x.step}</Mono> <span className='text-muted-foreground'>{x.when}</span></p>
                  <p className='text-sm'>{x.message}</p>
                  <div className='flex gap-2'>
                    <Button variant='outline' size='sm' onClick={() => copyText(x.body, 'Webhook body copied')}>Copy webhook body</Button>
                    <Button variant='ghost' size='sm' onClick={() => onTry(r, x)}>Send to an account</Button>
                  </div>
                </div>
              ))}
            </details>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
