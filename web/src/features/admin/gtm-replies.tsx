'use client';
// GTM › Campaigns › Replies (src/gtm-replies.ts): what people answered. A reply stops that person's sequence; an
// automatic answer (out of office) is kept apart and stops nothing unless the campaign counts it. Every campaign's
// replies here, one campaign's in its peek; owners mark them handled once someone has answered.
import { StatStrip } from '@/components/layout/section';
import { RecordView, type RecordCol, type RecordViewDef } from '@/components/layout/record-view';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { post, useAdmin, useAdminAction } from './lib';
import { DataList, ErrorBox, Notice, StatusBadge, When } from './ui';
import { Gate } from './role';

export interface Reply {
  id: number; campaign_id: number; campaign_name: string; recipient_id: number; email: string; first_name: string | null; kind: 'reply' | 'auto_reply'; auto_reason: string | null;
  from_email: string | null; from_matches: boolean; subject: string | null; snippet: string | null; body: string | null; received_at: string; handled_at: string | null; handled_by: string | null;
  step: number | null; variant: string | null;
}
export interface Replies { inbox: string | null; counts: { open: number; handled: number; auto: number; total: number }; replies: Reply[] }

const VIEWS: RecordViewDef<Reply>[] = [
  { id: 'open', label: 'Open', match: (r) => r.kind === 'reply' && !r.handled_at, sort: [{ key: 'received_at', dir: 'desc' }] },
  { id: 'handled', label: 'Handled', match: (r) => !!r.handled_at, sort: [{ key: 'received_at', dir: 'desc' }] },
  { id: 'auto', label: 'Automatic', match: (r) => r.kind === 'auto_reply', sort: [{ key: 'received_at', dir: 'desc' }] },
  { id: 'all', label: 'All', sort: [{ key: 'received_at', dir: 'desc' }] }
];
const who = (r: Reply) => r.first_name ?? r.email.split('@')[0];

/** Mark handled / open again: a labelled button, owners only. */
export function HandledButton({ r }: { r: Reply }) {
  const set = useAdminAction((handled: boolean) => post(`/gtm/replies/${r.id}/handled`, { handled }), { success: (x: { handled: boolean }) => (x.handled ? 'Marked handled' : 'Opened again') });
  return (
    <Gate need='campaigns'>
      {r.handled_at
        ? <Button size='sm' variant='outline' disabled={set.isPending} onClick={() => set.mutate(false)}><Icons.refresh /> Open again</Button>
        : <Button size='sm' disabled={set.isPending} onClick={() => set.mutate(true)}><Icons.check /> Mark handled</Button>}
    </Gate>
  );
}

/** "Reply" or "Automatic", and handled. */
function KindBadge({ r }: { r: Reply }) {
  if (r.kind === 'auto_reply') return <StatusBadge tone='neutral' title={r.auto_reason ?? undefined}>automatic</StatusBadge>;
  return r.handled_at ? <StatusBadge tone='ok'>handled</StatusBadge> : <StatusBadge tone='info'>open</StatusBadge>;
}

/** One reply in full: who, which email it answers, the words. */
export function ReplyDetail({ r }: { r: Reply }) {
  return (
    <div className='flex flex-col gap-4'>
      <div className='flex flex-wrap items-center gap-2'>
        <KindBadge r={r} />
        <span className='text-muted-foreground text-sm'>Received <When d={r.received_at} />{r.handled_at && <> · handled <When d={r.handled_at} /> by {r.handled_by}</>}</span>
        <span className='ml-auto'><HandledButton r={r} /></span>
      </div>
      <dl className='grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm'>
        <dt className='text-muted-foreground'>From</dt>
        <dd>{r.from_email ?? '—'}{!r.from_matches && r.from_email && <span className='text-muted-foreground'> (not the address it was sent to: {r.email})</span>}</dd>
        <dt className='text-muted-foreground'>Campaign</dt><dd>{r.campaign_name}</dd>
        <dt className='text-muted-foreground'>Answers</dt><dd>{r.step != null ? `Email ${r.step + 1}${r.variant ? `, variant ${r.variant}` : ''}` : '—'}</dd>
        <dt className='text-muted-foreground'>Subject</dt><dd>{r.subject ?? '—'}</dd>
        {r.auto_reason && <><dt className='text-muted-foreground'>Why automatic</dt><dd>{r.auto_reason}</dd></>}
      </dl>
      <pre className='bg-muted/40 max-h-[28rem] overflow-auto rounded-md border p-3 font-sans text-sm whitespace-pre-wrap'>{r.body || r.snippet || '(no text)'}</pre>
    </div>
  );
}

/** A campaign's replies in its peek: the latest, each with its snippet and Mark handled. */
export function CampaignReplies({ replies }: { replies: Replies }) {
  return (
    <div className='border'>
      <DataList<Reply> noun='replies' minWidth={680} height='h-[20rem]' rows={replies.replies} empty={replies.inbox ? 'No replies yet.' : 'Replies are not tracked: set a Replies inbox in Agent configuration (Campaigns).'}
        cols={[
          { label: 'From', render: (r) => <span className='flex flex-col gap-0.5'><span className='font-medium'>{who(r)}</span><span className='text-muted-foreground text-xs'>{r.from_email ?? r.email}</span></span> },
          { label: 'Reply', render: (r) => <span className='line-clamp-2 text-sm'>{r.snippet || r.subject || '—'}</span> },
          { label: 'Status', render: (r) => <KindBadge r={r} /> },
          { label: 'Received', render: (r) => <When d={r.received_at} className='text-muted-foreground text-sm' /> },
          { label: '', render: (r) => (r.kind === 'reply' ? <HandledButton r={r} /> : null) }
        ]} />
    </div>
  );
}

/** Campaigns › Replies: every campaign's inbox. */
export function RepliesView({ open, setOpen }: { open: string | null; setOpen: (k: string | null) => void }) {
  const { data, error, isLoading } = useAdmin<Replies>('/gtm/replies?view=all', { refetchInterval: 30_000 });
  const rows = data?.replies ?? [];
  const cols: RecordCol<Reply>[] = [
    { key: 'from', label: 'From', title: true, keep: true, type: 'text', className: 'min-w-48', value: (r) => `${who(r)} ${r.from_email ?? r.email}`,
      render: (r) => <span className='flex flex-col gap-0.5'><span className='font-medium'>{who(r)}</span><span className='text-muted-foreground text-xs'>{r.from_email ?? r.email}</span></span> },
    { key: 'snippet', label: 'Reply', type: 'text', className: 'min-w-72', value: (r) => r.snippet ?? '', render: (r) => <span className='line-clamp-2 text-sm'>{r.snippet || r.subject || '—'}</span> },
    { key: 'campaign', label: 'Campaign', type: 'select', value: (r) => r.campaign_name, render: (r) => <span className='text-sm'>{r.campaign_name}</span> },
    { key: 'status', label: 'Status', type: 'select', keep: true, value: (r) => (r.kind === 'auto_reply' ? 'automatic' : r.handled_at ? 'handled' : 'open'), render: (r) => <KindBadge r={r} /> },
    { key: 'step', label: 'Answers', type: 'text', hidden: true, value: (r) => (r.step != null ? `Email ${r.step + 1}${r.variant ? ` ${r.variant}` : ''}` : ''), render: (r) => (r.step != null ? `Email ${r.step + 1}${r.variant ? `, ${r.variant}` : ''}` : '—') },
    { key: 'subject', label: 'Subject', type: 'text', hidden: true, value: (r) => r.subject ?? '', render: (r) => r.subject ?? '—' },
    { key: 'received_at', label: 'Received', type: 'date', value: (r) => r.received_at, render: (r) => <When d={r.received_at} className='text-muted-foreground text-sm' /> }
  ];
  return (
    <div className='flex min-w-0 flex-col gap-4'>
      <ErrorBox error={error} />
      {data && !data.inbox && <Notice>Replies are not tracked yet: set Replies inbox (Agent configuration, Campaigns) to an address on a domain receiving in Resend, and point Resend&apos;s email.received webhook at /api/webhooks/resend.</Notice>}
      <RecordView<Reply>
        id='gtm-replies' noun='replies' exportName='campaign-replies' compact stacked loading={isLoading} views={VIEWS}
        rows={rows} rowKey={(r) => String(r.id)} cols={cols} openKey={open} onOpenChange={setOpen}
        defaultSort={[{ key: 'received_at', dir: 'desc' }]}
        searchText={(r) => `${who(r)} ${r.email} ${r.from_email ?? ''} ${r.campaign_name} ${r.subject ?? ''} ${r.snippet ?? ''}`}
        searchPlaceholder='Search replies by person, campaign, subject or words'
        empty={data?.inbox ? 'No replies yet. When someone answers a campaign email, it shows here and their sequence stops.' : 'No replies: replies are not tracked yet.'}
        summary={data && (
          <StatStrip items={[
            { label: 'Open', value: data.counts.open, hint: 'replies nobody has handled' },
            { label: 'Handled', value: data.counts.handled },
            { label: 'Automatic', value: data.counts.auto, hint: 'out of office and the like' },
            { label: 'Inbox', value: data.inbox ? 'On' : 'Off', hint: data.inbox ?? 'set Replies inbox' }
          ]} />
        )}
        detailTitle={(r) => <span className='flex items-center gap-2'>{who(r)}<KindBadge r={r} /></span>}
        detail={(r) => <ReplyDetail r={r} />}
      />
    </div>
  );
}
