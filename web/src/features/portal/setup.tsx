'use client';
// /app Setup & training: the checklist, tips from journeys, the connector guide with a live connection test,
// "use it fully" prompts for the parts of the workflow the team has not tried, and recent problems with fixes.
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Section } from '@/components/layout/section';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Icons } from '@/components/icons';
import { appApi } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { CopyButton, ErrorState, LoadingCards, When, copy, fail, useOrgLoad } from './shared';

interface Step { id: string; label: string; done: boolean; at: string | null; help: string; optional?: boolean }
interface Setup {
  steps: Step[]; done: number; total: number; clients: { client: string; last: string }[]; calls: number;
  groups: { id: string; label: string; prompt: string; used: number; total: number }[];
  errors: { at: string; name: string | null; error: string | null; hint: string | null }[];
  connect: { connector_url: string; secret: boolean; clients: { client: string; steps: string; snippet?: string }[] };
  live: { at: string; client: string | null } | null;
}
interface Tips { muted: boolean; nudges: { id: number; message: string; prompt: string | null; link: string | null }[] }

export function SetupPage() {
  const { data: s, error, reload } = useOrgLoad(() => appApi<Setup>('GET', '/setup'));
  const next = s?.steps.find((x) => !x.done && !x.optional);
  return (
    <PageContainer
      pageTitle='Setup & training'
      pageDescription={!s ? 'Connect your AI client and learn the workflow.' : next ? `Next: ${next.label.replace(' (team)', '')}.` : 'You are set up. Keep exploring the workflow.'}
    >
      {error ? <ErrorState error={error} /> : !s ? <LoadingCards count={4} /> : (
        <div className='grid max-w-6xl gap-x-12 gap-y-8 lg:grid-cols-5'>
          <div className='flex flex-col gap-8 lg:col-span-3'>
            <Checklist s={s} next={next} />
            <ConnectSection s={s} onConnected={reload} />
            {s.errors.length > 0 && <Problems errors={s.errors} />}
          </div>
          <div className='flex flex-col gap-8 lg:col-span-2'>
            <TipsSection />
            <UseItFully groups={s.groups} />
          </div>
        </div>
      )}
    </PageContainer>
  );
}

function Checklist({ s, next }: { s: Setup; next: Step | undefined }) {
  const pct = Math.round((s.done / Math.max(1, s.total)) * 100);
  return (
    <Section title='Checklist' description={`${s.done} of ${s.total} steps done`} action={<Badge variant={pct === 100 ? 'default' : 'secondary'}>{pct}%</Badge>}>
      <div className='space-y-4'>
        <div className='bg-muted h-2 overflow-hidden rounded-full'><div className='bg-primary h-full rounded-full transition-all' style={{ width: `${pct}%` }} /></div>
        <ol className='divide-y'>
          {s.steps.map((x) => {
            const cur = next?.id === x.id;
            return (
              <li key={x.id} className='flex items-start gap-3 py-3 first:pt-0 last:pb-0'>
                <span className={cn('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2',
                  x.done ? 'border-primary bg-primary text-primary-foreground' : cur ? 'border-primary' : 'border-muted-foreground/30')}>
                  {x.done && <Icons.check className='size-3' />}
                </span>
                <div className='min-w-0 flex-1'>
                  <div className='flex flex-wrap items-center gap-2'>
                    <span className={cn('font-medium', x.done && 'text-muted-foreground')}>{x.label}</span>
                    {x.optional && <Badge variant='outline'>optional</Badge>}
                    {cur && <Badge>next</Badge>}
                  </div>
                  {!x.done && (cur || x.optional) && <p className='text-muted-foreground mt-1 text-sm'>{x.help}</p>}
                </div>
                {x.done && x.at && <span className='text-muted-foreground shrink-0 text-xs'><When d={x.at} /></span>}
              </li>
            );
          })}
        </ol>
      </div>
    </Section>
  );
}

function ConnectSection({ s, onConnected }: { s: Setup; onConnected: () => void }) {
  const [live, setLive] = useState<{ kind: 'wait' | 'ok' | 'bad'; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  // Live connection test: watch for this person's next connector request for up to three minutes.
  const test = () => {
    if (timer.current) return;
    appApi<{ since: string }>('POST', '/setup/test').then(({ since }) => {
      const until = Date.now() + 180_000;
      setLive({ kind: 'wait', text: 'Waiting for your client… Open a new chat and type: "Get me started with Octillion."' });
      timer.current = setInterval(() => {
        appApi<Setup>('GET', `/setup?since=${encodeURIComponent(since)}`).then((r) => {
          if (r.live) {
            clearInterval(timer.current!); timer.current = null;
            setLive({ kind: 'ok', text: `Connected${r.live.client ? ` from ${r.live.client}` : ''}. You're all set.` });
            onConnected();
          } else if (Date.now() > until) {
            clearInterval(timer.current!); timer.current = null;
            setLive({ kind: 'bad', text: 'Nothing arrived yet. Check that the connector URL is exactly as shown, that you signed in when your client asked, and that the Octillion tools are switched on; then try again.' });
          }
        }).catch(() => {});
      }, 3000);
    }).catch(fail);
  };
  return (
    <Section title='Connect your AI client'
      description={s.connect.secret ? 'This link contains your key: keep it private.' : 'No secret in it: when your client asks, sign in with your Octillion account (the same sign-in as this page).'}>
      <div className='space-y-4'>
        <div className='flex gap-2'>
          <Input readOnly value={s.connect.connector_url} className='font-mono text-xs' aria-label='Connector URL' />
          <CopyButton text={s.connect.connector_url} />
        </div>
        <Tabs defaultValue='0'>
          <div className='overflow-x-auto'>
            <TabsList>{s.connect.clients.map((c, i) => <TabsTrigger key={c.client} value={String(i)}>{c.client}</TabsTrigger>)}</TabsList>
          </div>
          {s.connect.clients.map((c, i) => (
            <TabsContent key={c.client} value={String(i)} className='space-y-2 pt-2 text-sm'>
              <p>{c.steps}</p>
              {c.snippet && (
                <div className='relative'>
                  <pre className='bg-muted overflow-x-auto rounded-lg p-3 font-mono text-xs whitespace-pre-wrap break-all'>{c.snippet}</pre>
                  <Button variant='ghost' size='icon-sm' className='absolute top-1.5 right-1.5' onClick={() => copy(c.snippet!)} aria-label='Copy snippet'><Icons.page /></Button>
                </div>
              )}
            </TabsContent>
          ))}
        </Tabs>
        <div className='flex flex-wrap items-center gap-3'>
          <Button onClick={test} disabled={live?.kind === 'wait'}>
            {live?.kind === 'wait' ? <Icons.spinner className='animate-spin' /> : <Icons.plug />} Test my connection
          </Button>
          {s.clients.length > 0 && <span className='text-muted-foreground text-xs'>Seen from: {s.clients.map((x) => x.client.split(' ')[0]).join(', ')}</span>}
        </div>
        {live && (
          <Alert variant={live.kind === 'bad' ? 'destructive' : 'default'} role='status' aria-live='polite'
            className={cn(live.kind === 'ok' && 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400')}>
            {live.kind === 'ok' ? <Icons.circleCheck /> : live.kind === 'wait' ? <Icons.clock /> : <Icons.warning />}
            <AlertDescription className={cn(live.kind === 'ok' && 'text-emerald-700 dark:text-emerald-400')}>{live.text}</AlertDescription>
          </Alert>
        )}
      </div>
    </Section>
  );
}

function TipsSection() {
  const [t, setT] = useState<Tips | null>(null);
  const load = useCallback(() => appApi<Tips>('GET', '/nudges').then(setT).catch(() => {}), []);
  useEffect(() => { void load(); }, [load]);
  if (!t || (!t.nudges.length && !t.muted)) return null;
  const setShow = (on: boolean) =>
    appApi('POST', '/nudges/mute', { muted: !on }).then(() => { toast.success(on ? 'Tips on' : 'Tips off in your AI client'); return load(); }).catch(fail);
  const safe = (l: string) => (/^\/app/.test(l) || /^https:\/\//.test(l) ? l : '#');
  return (
    <Section title={<span className='flex items-center gap-2'><Icons.sparkles className='text-primary size-4' /> Tips for you</span>} description='Suggestions to get more out of Octillion.'>
      <div className='space-y-3'>
        <label className='flex items-center justify-between gap-3 text-sm'>
          <span>Show tips in my AI client</span>
          <Switch checked={!t.muted} onCheckedChange={(v) => setShow(Boolean(v))} />
        </label>
        {t.nudges.length ? t.nudges.map((n) => (
          <div key={n.id} className='bg-primary/5 border-primary space-y-2 border-l-2 py-2 pr-2 pl-3 text-sm'>
            <p>{n.message}</p>
            {n.prompt && (
              <div className='flex items-center gap-2'>
                <code className='bg-background flex-1 truncate rounded px-2 py-1 text-xs' title={n.prompt}>{n.prompt}</code>
                <CopyButton text={n.prompt} />
              </div>
            )}
            <div className='flex items-center gap-2'>
              {n.link && <Button variant='link' size='sm' className='px-0' render={<a href={safe(n.link)} />}>Open</Button>}
              <span className='flex-1' />
              <Button variant='ghost' size='sm' onClick={() => appApi('POST', `/nudges/${n.id}/dismiss`).then(load).catch(fail)}>Dismiss</Button>
            </div>
          </div>
        )) : <p className='text-muted-foreground text-sm'>No tips right now.</p>}
      </div>
    </Section>
  );
}

function UseItFully({ groups }: { groups: Setup['groups'] }) {
  const used = groups.filter((g) => g.used).length;
  return (
    <Section title='Use it fully' description={`Your team has used ${used} of ${groups.length} parts of the workflow.`}>
      <div className='divide-y border-y'>
        {groups.map((g) => (
          <div key={g.id} className='space-y-2 py-3'>
            <div className='flex items-center justify-between gap-2'>
              <span className='text-sm font-medium'>{g.label}</span>
              {g.used > 0 ? <Badge variant='secondary'><Icons.check className='size-3' /> in use</Badge> : <Badge variant='outline'>not yet</Badge>}
            </div>
            {!g.used && (
              <div className='flex items-center gap-2'>
                <code className='bg-muted flex-1 truncate rounded px-2 py-1 text-xs' title={g.prompt}>{g.prompt}</code>
                <CopyButton text={g.prompt} />
              </div>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}

function Problems({ errors }: { errors: Setup['errors'] }) {
  return (
    <Section title='Recent problems' description='Errors from your recent tool calls, with what to do about them.'>
      <div className='divide-y border-y'>
        {errors.map((e, i) => (
          <div key={i} className='space-y-1 py-3 text-sm'>
            <div className='flex items-center justify-between gap-2'>
              <code className='text-xs'>{e.name}</code>
              <span className='text-muted-foreground text-xs'><When d={e.at} /></span>
            </div>
            <p className='text-muted-foreground'>{e.error}</p>
            {e.hint && <p><span className='font-medium'>Fix:</span> {e.hint}</p>}
          </div>
        ))}
      </div>
    </Section>
  );
}
