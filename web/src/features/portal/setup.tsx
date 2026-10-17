'use client';
// /app Setup & training. Right column: the connection string (with a live connection test), a journey selector and
// tips. Main column: the selected journey. "Get set up" is the setup timeline and recent problems (workflow coverage
// lives on /app/adoption); the other journeys (managed on /admin, src/playbooks.ts) show their stages, marked from real tool calls.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryState } from 'nuqs';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Section } from '@/components/layout/section';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Icons } from '@/components/icons';
import { appApi } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { CopyButton, ErrorState, LoadingCards, When, copy, fail, useOrgLoad } from './shared';

interface Step { id: string; label: string; done: boolean; at: string | null; help: string; optional?: boolean }
interface Setup {
  steps: Step[]; done: number; total: number; clients: { client: string; last: string }[]; calls: number;
  groups: { id: string; label: string; prompt: string; used: number; total: number }[];
  errors: { at: string; name: string | null; error: string | null; hint: string | null }[];
  connect: { connector_url: string; secret: boolean; clients: Client[] };
  live: { at: string; client: string | null } | null;
}
interface Client {
  id: string; client: string; group: 'chat' | 'agent' | 'editor'; method: 'ui' | 'cli' | 'config' | 'link'; steps: string;
  command?: string; snippet?: string; file?: string; install_url?: string; verified: boolean; share: number | null;
}
interface Stage { id: string; title: string; why: string; prompt: string; tools: string[]; expect: string; manual?: boolean; done: boolean; at: string | null }
interface Journey {
  id: string; name: string; outcome: string; who: string; time: string; example: { title: string; result: string };
  stages: Stage[]; done: number; total: number;
}
interface Tips { muted: boolean; nudges: { id: number; message: string; prompt: string | null; link: string | null }[] }

export function SetupPage() {
  const { data: s, error, reload } = useOrgLoad(() => appApi<Setup>('GET', '/setup'));
  const { data: jr, reload: reloadJourneys } = useOrgLoad(() => appApi<{ journeys: Journey[] }>('GET', '/journeys'));
  const [selected, setSelected] = useQueryState('journey', { defaultValue: 'setup' });
  const next = s?.steps.find((x) => !x.done && !x.optional);
  const journey = jr?.journeys.find((x) => x.id === selected) ?? null;
  return (
    <PageContainer>
      {error ? <ErrorState error={error} /> : !s ? <LoadingCards count={4} /> : (
        <div className='grid max-w-6xl gap-x-10 gap-y-6 lg:grid-cols-5 lg:items-start'>
          <div className='order-2 flex min-w-0 flex-col gap-8 lg:order-1 lg:col-span-3'>
            {selected === 'setup' || !journey ? (<>
              <Timeline s={s} next={next} />
              {s.errors.length > 0 && <Problems errors={s.errors} />}
            </>) : <JourneyView key={journey.id} j={journey} onChanged={reloadJourneys} />}
            <TipsSection />
          </div>
          {/* Two floating panels, pinned while the main column scrolls: the connection string and the journey picker. */}
          <div className='order-1 flex min-w-0 flex-col gap-4 lg:sticky lg:top-[4.5rem] lg:order-2 lg:col-span-2'>
            <ConnectionBox s={s} onConnected={reload} />
            <JourneyPicker setup={{ done: s.done, total: s.total }} journeys={jr?.journeys ?? []} selected={journey ? selected : 'setup'} onSelect={(id) => {
              void setSelected(id === 'setup' ? null : id);
              if (id !== 'setup') void appApi('POST', `/journeys/${encodeURIComponent(id)}/view`).catch(() => {});
            }} />
          </div>
        </div>
      )}
    </PageContainer>
  );
}

/** A floating panel for the pinned right column. */
function FloatPanel({ title, description, className, children }: { title: string; description?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <section className={cn('bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4 shadow-xl shadow-black/30', className)}>
      <div><h2 className='text-sm font-semibold tracking-tight'>{title}</h2>{description && <p className='text-muted-foreground text-xs'>{description}</p>}</div>
      {children}
    </section>
  );
}

/** The connection string, always in view: copy it, then prove the client reaches Octillion. */
function ConnectionBox({ s, onConnected }: { s: Setup; onConnected: () => void }) {
  const [live, setLive] = useState<{ kind: 'wait' | 'ok' | 'bad'; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const clients = s.connect.clients;
  // The client to show: the last one picked here, else one this person already connected from, else Claude.
  const [pick, setPick] = useState<string>(() => {
    try { const saved = localStorage.getItem('oct_client'); if (saved && clients.some((c) => c.id === saved)) return saved; } catch { /* private mode */ }
    const seen = s.clients.map((x) => x.client.toLowerCase());
    return clients.find((c) => seen.some((x) => x.includes(c.id.replace('-cli', '')) || x.includes(c.client.toLowerCase().split(' ')[0])))?.id ?? clients[0]?.id ?? 'claude';
  });
  const choose = (id: string) => { setPick(id); try { localStorage.setItem('oct_client', id); } catch { /* private mode */ } };
  const c = clients.find((x) => x.id === pick) ?? clients[0];
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
            setLive({ kind: 'bad', text: 'Nothing arrived yet. Check the URL, that you signed in when your client asked, and that the Octillion tools are switched on; then try again.' });
          }
        }).catch(() => {});
      }, 3000);
    }).catch(fail);
  };
  const groups: [Client['group'], string][] = [['chat', 'Chat apps'], ['agent', 'Coding agents · by share of developers'], ['editor', 'Editors']];
  return (
    <FloatPanel title='Connection string' description={s.connect.secret ? 'Contains your key: keep it private.' : undefined}>
      <div className='space-y-2.5'>
        <div className='relative'>
          <Input readOnly value={s.connect.connector_url} className='bg-background pr-10 font-mono text-xs' aria-label='Connection string' onFocus={(e) => e.currentTarget.select()} />
          <Button type='button' variant='ghost' size='icon-sm' className='absolute top-1/2 right-1 -translate-y-1/2' aria-label={`Copy the URL and how to add it in ${c?.client ?? 'your client'}`}
            title={`Copy the URL and how to add it in ${c?.client ?? 'your client'}`} onClick={() => copy(c ? setupText(s.connect.connector_url, c) : s.connect.connector_url)}>
            <Icons.page className='size-4' />
          </Button>
        </div>
        <div className='flex gap-2'>
          <NativeSelect id='client-pick' aria-label='Your AI client' value={c?.id} onChange={(e) => choose(e.target.value)} className='bg-background min-w-0 flex-1'>
            {groups.map(([g, label]) => (
              <NativeSelectOptGroup key={g} label={label}>
                {clients.filter((x) => x.group === g).map((x) => (
                  <NativeSelectOption key={x.id} value={x.id}>{x.client}{x.share != null && x.share > 0 ? ` · ${x.share}%` : ''}</NativeSelectOption>
                ))}
              </NativeSelectOptGroup>
            ))}
          </NativeSelect>
          <Button variant='outline' onClick={test} disabled={live?.kind === 'wait'} title='Test my connection'>
            {live?.kind === 'wait' ? <Icons.spinner className='animate-spin' /> : <Icons.plug />} Test
          </Button>
        </div>
        {c && (
          <Dialog>
            <DialogTrigger render={<button type='button' className='text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs font-medium' />}>
              <Icons.help className='size-3.5' /> How to add it in {c.client}
            </DialogTrigger>
            <DialogContent className='sm:max-w-lg'>
              <DialogHeader>
                <DialogTitle>Add Octillion to {c.client}</DialogTitle>
                <DialogDescription>Then press Test to check it reaches us.</DialogDescription>
              </DialogHeader>
              <div className='min-w-0'><ClientSteps c={c} /></div>
            </DialogContent>
          </Dialog>
        )}
        {live && (
          <Alert variant={live.kind === 'bad' ? 'destructive' : 'default'} role='status' aria-live='polite'
            className={cn(live.kind === 'ok' && 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400')}>
            {live.kind === 'ok' ? <Icons.circleCheck /> : live.kind === 'wait' ? <Icons.clock /> : <Icons.warning />}
            <AlertDescription className={cn(live.kind === 'ok' && 'text-emerald-700 dark:text-emerald-400')}>{live.text}</AlertDescription>
          </Alert>
        )}
      </div>
    </FloatPanel>
  );
}

/** Everything to paste into a message or a terminal: the URL plus the selected client's way in. */
function setupText(url: string, c: Client) {
  return [
    `Octillion MCP server: ${url}`,
    '',
    `Add it to ${c.client}:`,
    c.steps,
    c.install_url && `One-click install: ${c.install_url}`,
    c.command && `Command:\n${c.command}`,
    c.snippet && `${c.file ? `${c.command || c.install_url ? 'Or add to' : 'In'} ${c.file}` : 'Config'}:\n${c.snippet}`
  ].filter((x): x is string => typeof x === 'string').join('\n');
}

/** The selected client's way in: one-click install, a command, a config snippet, or steps in its settings. */
function ClientSteps({ c }: { c: Client }) {
  return (
    <div className='space-y-2 text-sm'>
      <p>{c.steps}</p>
      {c.install_url && (
        <Button size='sm' render={<a href={c.install_url} />}><Icons.add /> Add to {c.client}</Button>
      )}
      {c.command && <CodeLine text={c.command} label='Command' />}
      {c.snippet && (
        <div className='space-y-1'>
          {c.file && <div className='text-muted-foreground text-xs'>{c.command || c.install_url ? 'Or add to ' : 'In '}<code className='font-mono'>{c.file}</code></div>}
          <div className='relative'>
            <pre className='bg-background overflow-x-auto rounded-md border p-2.5 pr-10 font-mono text-xs whitespace-pre-wrap break-all'>{c.snippet}</pre>
            <Button variant='ghost' size='icon-sm' className='absolute top-1 right-1' onClick={() => copy(c.snippet!)} aria-label='Copy snippet'><Icons.page /></Button>
          </div>
        </div>
      )}
      {!c.verified && <p className='text-muted-foreground text-xs'>Based on {c.client}&apos;s documented MCP settings; if your version differs, use its “add MCP server” option with the URL above.</p>}
    </div>
  );
}

function CodeLine({ text, label }: { text: string; label: string }) {
  return (
    <div className='flex items-center gap-2'>
      <code className='bg-background min-w-0 flex-1 overflow-x-auto rounded-md border px-2.5 py-2 font-mono text-xs break-all whitespace-pre-wrap' aria-label={label}>{text}</code>
      <CopyButton text={text} />
    </div>
  );
}

/** Pick what the main column shows: getting set up, or one of the journeys, each with its progress. */
/** Journeys beyond this many get a search box. */
const SEARCH_FROM = 6;

function JourneyPicker({ setup, journeys, selected, onSelect }: { setup: { done: number; total: number }; journeys: Journey[]; selected: string; onSelect: (id: string) => void }) {
  const [q, setQ] = useState('');
  const items = [{ id: 'setup', name: 'Get set up', goal: 'Connect your client and try the workflow once', done: setup.done, total: setup.total },
    ...journeys.map((j) => ({ id: j.id, name: j.name, goal: j.outcome, done: j.done, total: j.total }))];
  const needle = q.trim().toLowerCase();
  const [all, setAll] = useState(false);
  const matches = needle ? items.filter((j) => `${j.name} ${j.goal}`.toLowerCase().includes(needle)) : items;
  // Fit the pinned column: past SEARCH_FROM, show the first few (and the selected one) until searched or expanded.
  const shown = needle || all || matches.length <= SEARCH_FROM ? matches
    : [...matches.slice(0, SEARCH_FROM - 1), ...matches.slice(SEARCH_FROM - 1).filter((j) => j.id === selected)];
  return (
    <FloatPanel title='Journeys' description='Real use cases as step-by-step pipelines. Pick one to replicate it.' >
      {items.length > SEARCH_FROM && (
        <div className='relative'>
          <Icons.search className='text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2' />
          <Input type='search' value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${items.length} journeys`} aria-label='Search journeys' className='h-8 pl-8 text-sm' />
        </div>
      )}
      <div role='radiogroup' aria-label='Journey' className='flex flex-col gap-0.5'>
        {shown.length === 0 && <p className='text-muted-foreground px-2 py-3 text-sm'>No journey matches “{q}”.</p>}
        {shown.map((j) => {
          const on = j.id === selected, complete = j.total > 0 && j.done >= j.total;
          return (
            <button key={j.id} type='button' role='radio' aria-checked={on} onClick={() => onSelect(j.id)}
              title={j.goal}
              className={cn('flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
                on ? 'border-primary bg-primary/5' : 'hover:bg-muted/60 border-transparent')}>
              <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-full border-2', complete ? 'border-primary bg-primary text-primary-foreground' : on ? 'border-primary' : 'border-muted-foreground/40')}>
                {complete && <Icons.check className='size-3' />}
              </span>
              <span className='min-w-0 flex-1 truncate text-sm font-medium'>{j.name}</span>
              <span className='text-muted-foreground shrink-0 text-xs tabular-nums'>{j.done}/{j.total}</span>
            </button>
          );
        })}
      </div>
      {!needle && matches.length > shown.length && (
        <button type='button' onClick={() => setAll(true)} className='text-primary self-start px-3 text-xs font-medium hover:underline'>
          Show all {matches.length} journeys
        </button>
      )}
      {!needle && all && matches.length > SEARCH_FROM && (
        <button type='button' onClick={() => setAll(false)} className='text-muted-foreground self-start px-3 text-xs hover:underline'>Show fewer</button>
      )}
    </FloatPanel>
  );
}

/** A use case as a pipeline: what it gets you, a worked example, and each stage's prompt, tool and expected result. */
function JourneyView({ j, onChanged }: { j: Journey; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  // Stages with no tool are marked by hand, for the whole account (and counted in journey analytics).
  const toggle = (id: string, done: boolean) => {
    setBusy(id);
    appApi('POST', `/journeys/${encodeURIComponent(j.id)}/stages/${encodeURIComponent(id)}`, { done })
      .then(() => onChanged()).catch(fail).finally(() => setBusy(null));
  };
  const isDone = (x: Stage) => x.done;
  const done = j.stages.filter(isDone).length;
  const current = j.stages.find((x) => !isDone(x));
  const pct = j.total ? Math.round((done / j.total) * 100) : 0;
  return (
    <Section title={j.name} description={j.outcome} action={<Badge variant={pct === 100 ? 'default' : 'secondary'}>{done} of {j.total} stages</Badge>}>
      <div className='text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs'><span>For: {j.who}</span><span>Takes: {j.time}</span></div>
      <div className='bg-muted h-1.5 overflow-hidden rounded-full'><div className='bg-primary h-full transition-all' style={{ width: `${pct}%` }} /></div>
      <div className='border-primary/40 bg-primary/5 rounded-r-md border-l-2 px-3 py-2 text-sm'>
        <div className='text-xs font-medium'>Worked example · {j.example.title}</div>
        <p className='text-muted-foreground mt-0.5'>{j.example.result}</p>
      </div>
      <ol className='divide-y'>
        {j.stages.map((x, i) => {
          const ok = isDone(x), now = current?.id === x.id;
          return (
            <li key={x.id} className='flex gap-3 py-4'>
              <span className={cn('mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold',
                ok ? 'border-primary bg-primary text-primary-foreground' : now ? 'border-primary text-primary' : 'border-muted-foreground/30 text-muted-foreground')}>
                {ok ? <Icons.check className='size-3.5' /> : i + 1}
              </span>
              <div className='min-w-0 flex-1 space-y-2'>
                <div className='flex flex-wrap items-center gap-2'>
                  <span className='font-medium'>{x.title}</span>
                  {now && <Badge variant='secondary'>next</Badge>}
                  {x.tools.map((t) => <code key={t} className='text-muted-foreground bg-muted rounded px-1.5 py-0.5 font-mono text-[11px]'>{t}</code>)}
                  {x.done && x.at && <span className='text-muted-foreground text-xs'>done <When d={x.at} /></span>}
                </div>
                <p className='text-muted-foreground text-sm'>{x.why}</p>
                {!ok && (x.manual
                  ? <div className='flex flex-wrap items-center gap-2'><span className='text-sm'>{x.prompt}</span><Button size='sm' variant='outline' disabled={busy === x.id} onClick={() => toggle(x.id, true)}>Mark done</Button></div>
                  : <CodeLine text={x.prompt} label='Prompt' />)}
                {x.manual && ok && <Button size='sm' variant='ghost' className='text-muted-foreground' disabled={busy === x.id} onClick={() => toggle(x.id, false)}>Undo</Button>}
                <p className='text-xs'><span className='font-medium'>You’ll see:</span> <span className='text-muted-foreground'>{x.expect}</span></p>
              </div>
            </li>
          );
        })}
      </ol>
      {done >= j.total && <p className='text-muted-foreground text-sm'>Pipeline complete. Run it again after your next change, or pick another journey.</p>}
    </Section>
  );
}

/** Setup as a vertical timeline: every step explained, what is done (and when), what is next, what is optional. */
function Timeline({ s, next }: { s: Setup; next: Step | undefined }) {
  const pct = Math.round((s.done / Math.max(1, s.total)) * 100);
  return (
    <Section title='Get set up' description={`${s.done} of ${s.total} steps done.`}
      action={<Badge variant={pct === 100 ? 'default' : 'secondary'}>{pct}%</Badge>}>
      <div className='bg-muted h-1.5 overflow-hidden rounded-full'><div className='bg-primary h-full rounded-full transition-all' style={{ width: `${pct}%` }} /></div>
      <ol className='mt-3'>
        {s.steps.map((x, i) => {
          const cur = next?.id === x.id;
          const last = i === s.steps.length - 1;
          return (
            <li key={x.id} className='relative flex gap-4 pb-7 last:pb-0'>
              {!last && <span aria-hidden='true' className={cn('absolute top-8 bottom-0 left-[15px] w-px', x.done ? 'bg-primary/60' : 'bg-border')} />}
              <span className={cn('relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold tabular-nums',
                x.done ? 'border-primary bg-primary text-primary-foreground' : cur ? 'border-primary text-primary bg-background ring-primary/20 ring-4' : 'border-border text-muted-foreground bg-background')}>
                {x.done ? <Icons.check className='size-4' /> : i + 1}
              </span>
              <div className={cn('min-w-0 flex-1 pt-1', cur && 'bg-primary/5 -mt-1 rounded-lg px-4 py-3')}>
                <div className='flex flex-wrap items-center gap-2'>
                  <span className={cn('font-medium', x.done && 'text-muted-foreground')}>{x.label.replace(' (team)', '')}</span>
                  {cur && <Badge>up next</Badge>}
                </div>
                <p className={cn('mt-1 text-sm', x.done ? 'text-muted-foreground/70' : 'text-muted-foreground')}>{x.help}</p>
              </div>
            </li>
          );
        })}
      </ol>
      <p className='text-muted-foreground border-t pt-3 text-sm'>
        How much of the workflow your team uses is on <a href='/app/adoption' className='text-primary underline-offset-4 hover:underline'>Adoption</a>.
      </p>
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
