import Link from 'next/link';
import {
  IconArrowRight, IconBolt, IconChartBar, IconChartPie, IconEye, IconFileSearch, IconGitCompare, IconMessages,
  IconRefresh, IconSparkles, IconTerminal2, IconUsers
} from '@tabler/icons-react';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/** Section wrapper: anchor target, eyebrow, title and lead. */
export function Section({ id, eyebrow, title, lead, children, className }: {
  id?: string; eyebrow?: string; title: React.ReactNode; lead?: React.ReactNode; children?: React.ReactNode; className?: string;
}) {
  return (
    <section id={id} className={cn('scroll-mt-20 border-t py-16 sm:py-24', className)}>
      <div className='mx-auto max-w-6xl px-4 sm:px-6'>
        <div className='max-w-3xl'>
          {eyebrow && <p className='text-primary text-sm font-semibold tracking-wide uppercase'>{eyebrow}</p>}
          <h2 className='mt-2 text-3xl font-semibold tracking-tight text-balance sm:text-4xl'>{title}</h2>
          {lead && <p className='text-muted-foreground mt-4 text-lg text-pretty'>{lead}</p>}
        </div>
        {children && <div className='mt-10 sm:mt-12'>{children}</div>}
      </div>
    </section>
  );
}

// ---------- hero ----------

const SAMPLE_RUNS = [
  { model: 'claude-code', verdict: 'Adopted', kind: 'good', body: '$ npm install yourdb' },
  { model: 'cursor', verdict: 'Recommended', kind: 'good', body: '“YourDB fits: serverless driver, branching.”' },
  { model: 'codex', verdict: 'Competitor', kind: 'bad', body: '$ npm install otherdb' },
  { model: 'gemini-cli', verdict: 'Mentioned', kind: 'meh', body: '“…or YourDB.” Used SQLite.' }
] as const;

const VERDICT_STYLE = {
  good: 'bg-primary/15 text-primary border-transparent',
  bad: 'bg-destructive/15 text-destructive border-transparent',
  meh: 'bg-muted text-muted-foreground border-transparent'
};

const AGENTS = ['Claude Code', 'Codex', 'Cursor', 'Gemini CLI', 'GitHub Copilot', 'OpenCode', 'Cline'];

const HOW = [
  { n: '01', title: 'Run real tasks', body: 'Sandboxed agents build in real repos, across models.' },
  { n: '02', title: 'Measure the pick', body: 'Adopted, recommended, or skipped for a competitor.' },
  { n: '03', title: 'Read the why', body: 'Transcripts show what to fix, reruns show if it worked.' }
];

export function Hero() {
  return (
    <section className='relative overflow-hidden'>
      <div aria-hidden='true' className='pointer-events-none absolute inset-0 [mask-image:radial-gradient(70%_60%_at_50%_0%,black,transparent)] bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] bg-[size:56px_56px] opacity-60' />
      <div aria-hidden='true' className='pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[900px] max-w-full -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--primary)_22%,transparent),transparent)] blur-2xl' />

      <div className='relative mx-auto max-w-6xl px-4 pt-16 pb-14 sm:px-6 sm:pt-24 sm:pb-20'>
        <div className='grid gap-12 lg:grid-cols-[1.1fr_1fr] lg:items-center'>
          <div className='min-w-0'>
            <Link href='/#apo' className='border-primary/30 bg-primary/10 text-primary hover:bg-primary/15 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition-colors'>
              <IconSparkles className='size-3.5' /> Introducing APO · Agentic Preference Optimization <IconArrowRight className='size-3.5' />
            </Link>
            <h1 className='mt-6 text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-[3.6rem] lg:leading-[1.05]'>
              SEO got you found by people.
              <span className='text-primary block'>APO gets you picked by agents.</span>
            </h1>
            <p className='text-muted-foreground mt-6 max-w-xl text-lg text-pretty'>
              Coding agents now choose the database, the queue and the auth library. Octillion measures how often they choose yours,
              shows the transcripts that explain why, and tells you whether your fix worked.
            </p>
            <div className='mt-8 flex flex-wrap gap-3'>
              <Link href='/#access' className={buttonVariants({ size: 'lg' })}>Get your APO baseline <IconArrowRight /></Link>
              <Link href='/#apo' className={buttonVariants({ size: 'lg', variant: 'outline' })}>What is APO?</Link>
            </div>
          </div>
          <SampleCard />
        </div>

        <div className='mt-16'>
          <p className='text-muted-foreground text-xs font-medium tracking-wider uppercase'>Measures the agents your users already run</p>
          <ul className='mt-4 flex flex-wrap gap-x-8 gap-y-3'>
            {AGENTS.map((a) => <li key={a} className='text-foreground/70 font-mono text-sm'>{a}</li>)}
          </ul>
        </div>

        <ol className='mt-12 grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-3'>
          {HOW.map((s) => (
            <li key={s.n} className='bg-background p-5'>
              <span className='text-primary font-mono text-xs'>{s.n}</span>
              <p className='mt-2 font-medium'>{s.title}</p>
              <p className='text-muted-foreground mt-1 text-sm'>{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function SampleCard() {
  return (
    <figure className='bg-card min-w-0 overflow-hidden rounded-xl border shadow-2xl shadow-black/40'>
      <div className='flex items-center gap-1.5 border-b px-4 py-3'>
        <span className='size-2.5 rounded-full bg-white/15' /><span className='size-2.5 rounded-full bg-white/15' /><span className='size-2.5 rounded-full bg-white/15' />
        <span className='text-muted-foreground ml-3 truncate font-mono text-xs'>octillion · APO baseline · YourDB</span>
      </div>
      <div className='space-y-5 p-5'>
        <div>
          <p className='text-muted-foreground font-mono text-xs'>task</p>
          <p className='mt-1 font-medium'>“Add persistent storage to this Next.js app”</p>
        </div>
        <div>
          <div className='flex items-baseline gap-3'>
            <span className='text-primary text-5xl font-semibold tabular-nums'>58%</span>
            <span className='text-muted-foreground text-sm'>of 12 runs picked YourDB</span>
          </div>
          <div className='bg-muted mt-3 h-1.5 overflow-hidden rounded-full'><div className='bg-primary h-full w-[58%] rounded-full' /></div>
        </div>
        <ul className='divide-y rounded-lg border'>
          {SAMPLE_RUNS.map((r) => (
            <li key={r.model} className='grid grid-cols-[6.5rem_auto_1fr] items-center gap-3 px-3 py-2.5 max-sm:grid-cols-[auto_1fr]'>
              <span className='text-muted-foreground truncate font-mono text-xs max-sm:col-span-2'>{r.model}</span>
              <Badge className={cn('w-fit', VERDICT_STYLE[r.kind])}>{r.verdict}</Badge>
              <span className='min-w-0 truncate font-mono text-xs'>{r.body}</span>
            </li>
          ))}
        </ul>
      </div>
      <figcaption className='text-muted-foreground border-t px-5 py-3 text-xs'>Illustrative sample. Product, competitor and numbers are placeholders.</figcaption>
    </figure>
  );
}

// ---------- why now ----------

const SESSION = [
  ['comment', '# developer, 11:42pm'],
  ['prompt', '> add background jobs to this app'],
  ['agent', 'agent ▸ reading package.json, src/…'],
  ['agent', 'agent ▸ I\'ll use SomeQueue — it fits this stack.'],
  ['cmd', 'agent ▸ $ npm install somequeue'],
  ['agent', 'agent ▸ created src/jobs/worker.ts'],
  ['ok', 'agent ▸ ✓ done. 3 files changed.'],
  ['comment', '# was your product considered?'],
  ['comment', '# you\'ll never see this session.']
] as const;

const REASONS = [
  { icon: IconEye, title: 'The decision is invisible', body: 'It happens inside a private session on someone else\'s laptop. No click, no referrer, no signup funnel to measure.' },
  { icon: IconGitCompare, title: 'Every model decides differently', body: 'Each model, version and harness has its own defaults. What one agent installs, another never mentions.' },
  { icon: IconMessages, title: 'Asking a chatbot isn\'t the same', body: '“What\'s the best queue?” in a chat window tells you little about what an agent does mid-task in a real repo with real constraints. You need to watch the work.' }
];

export function WhyNow() {
  return (
    <Section id='why' eyebrow='Why APO, why now' title='Developers stopped picking tools. Their agents do it now.'
      lead='A developer types “add background jobs” into Claude Code, Codex or Cursor and accepts the diff. The agent chose the queue, installed the package and wrote the config. Nobody compared vendors. Nobody read your landing page.'>
      <div className='grid gap-6 lg:grid-cols-[1.1fr_1fr] lg:items-start'>
        <div className='overflow-hidden rounded-xl border bg-zinc-950 text-zinc-100 shadow-lg'>
          <div className='flex items-center gap-1.5 border-b border-white/10 px-4 py-3'>
            <span className='size-2.5 rounded-full bg-white/20' /><span className='size-2.5 rounded-full bg-white/20' /><span className='size-2.5 rounded-full bg-white/20' />
            <IconTerminal2 className='ml-2 size-4 text-white/50' />
          </div>
          <pre className='overflow-x-auto p-4 font-mono text-[13px] leading-6 whitespace-pre-wrap'>
            {SESSION.map(([k, line], i) => (
              <div key={i} className={cn(k === 'comment' && 'text-white/45', k === 'prompt' && 'text-white', k === 'cmd' && 'text-amber-300', k === 'ok' && 'text-emerald-400', k === 'agent' && 'text-white/80')}>{line}</div>
            ))}
          </pre>
        </div>
        <div className='grid gap-4'>
          {REASONS.map((r) => (
            <Card key={r.title} size='sm'>
              <CardContent className='flex gap-4'>
                <div className='bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-lg'><r.icon className='size-5' /></div>
                <div><h3 className='font-semibold'>{r.title}</h3><p className='text-muted-foreground mt-1 text-sm'>{r.body}</p></div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </Section>
  );
}

// ---------- what is APO ----------

const COMPARE = [
  { short: 'SEO', long: 'Search engine optimization', who: 'A person scanning search results', win: 'A click to your site', measure: 'Rankings and traffic' },
  { short: 'GEO', long: 'Generative engine optimization', who: 'A chatbot answering a question', win: 'A mention or citation in the answer', measure: 'Mentions in chat replies' },
  { short: 'APO', long: 'Agentic preference optimization', who: 'A coding agent in the middle of a task', win: 'Your package installed and wired into the code', measure: 'Adoption in real agent transcripts', highlight: true }
];

const LOOP = [
  { title: 'Profile your product', body: 'Give a one-paragraph pitch, your site and your docs. Octillion researches them and builds the profile: names, real package names, competitors and the developer personas you sell to.', tag: 'name: YourDB · pkgs: yourdb, @yourdb/client · vs: OtherDB' },
  { title: 'Pose blind problems', body: 'Realistic tasks your buyers hand to agents, like “set up auth for this FastAPI service”, that never name you or a competitor. The agent has to arrive at you on its own.', tag: 'scenario × starter repo × persona' },
  { title: 'Run the real agent mix', body: 'Claude Code, Codex, Cursor, OpenCode and more work each task in isolated sandboxes, in proportion to how developers actually use them, until the code is really done. A simulated developer answers their questions in persona.', tag: 'agent mix ∝ developer usage · full transcripts' },
  { title: 'Score, fix, re-run', body: 'Every run gets a verdict with transcript evidence. See where you lose and why, improve your docs, examples, SDK or packaging, then re-run the same tasks to prove preference moved.', tag: 'verdict → evidence → fix → re-measure' }
];

export function WhatIsApo() {
  return (
    <Section id='apo' eyebrow='What is APO' title='Agentic Preference Optimization, defined.'
      lead='APO is the practice of measuring and improving how often AI coding agents choose your product while they do real work. It is to coding agents what SEO is to search engines: you can’t buy the decision, but you can earn it, and you can’t improve what you don’t measure.'>
      <div className='grid gap-4 md:grid-cols-3'>
        {COMPARE.map((c) => (
          <Card key={c.short} className={cn(c.highlight && 'ring-primary ring-2')}>
            <CardHeader>
              <div className='flex items-center gap-2'>
                <span className={cn('text-2xl font-semibold', c.highlight && 'text-primary')}>{c.short}</span>
                {c.highlight && <Badge>Octillion</Badge>}
              </div>
              <p className='text-muted-foreground text-sm'>{c.long}</p>
            </CardHeader>
            <CardContent>
              <dl className='grid gap-3 text-sm'>
                <div><dt className='text-muted-foreground text-xs font-medium uppercase'>Who decides</dt><dd className='mt-0.5'>{c.who}</dd></div>
                <div><dt className='text-muted-foreground text-xs font-medium uppercase'>The win</dt><dd className='mt-0.5'>{c.win}</dd></div>
                <div><dt className='text-muted-foreground text-xs font-medium uppercase'>You measure</dt><dd className='mt-0.5'>{c.measure}</dd></div>
              </dl>
            </CardContent>
          </Card>
        ))}
      </div>
      <h3 className='mt-16 text-xl font-semibold'>The APO loop, run by Octillion</h3>
      <ol className='mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
        {LOOP.map((s, i) => (
          <li key={s.title}>
            <Card className='h-full'>
              <CardContent className='flex h-full flex-col gap-3'>
                <span className='bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-full text-sm font-semibold'>{i + 1}</span>
                <h4 className='font-semibold'>{s.title}</h4>
                <p className='text-muted-foreground flex-1 text-sm'>{s.body}</p>
                <code className='bg-muted text-muted-foreground rounded-md px-2 py-1.5 font-mono text-[11px] break-words'>{s.tag}</code>
              </CardContent>
            </Card>
          </li>
        ))}
      </ol>
    </Section>
  );
}

// ---------- scorecard ----------

const FEATURES = [
  { icon: IconChartBar, title: 'Preference rate', body: 'The share of runs where an agent adopted or recommended your product, overall and per scenario. Your headline APO number.' },
  { icon: IconChartPie, title: 'Share of voice vs competitors', body: 'How often agents choose you versus each named competitor, and where you lose head-to-head.' },
  { icon: IconUsers, title: 'By model and by scenario', body: 'Find the model that never picks you, or the use case where you\'re invisible, and know exactly where to focus.' },
  { icon: IconRefresh, title: 'Proof your fixes worked', body: 'Re-run the same scenarios as new models ship and as you change docs, examples, SDKs or packaging. See whether preference moves, model by model.' },
  { icon: IconFileSearch, title: 'Full, searchable transcripts', body: 'Every run\'s raw transcript: the reasoning, the commands, the files. Search across all of them for any package or phrase.' },
  { icon: IconBolt, title: 'Verdict evidence', body: 'No black-box scores. Each verdict points to the install command, import or sentence that earned it, so you can check it yourself.' }
];

const VERDICTS = [
  { name: 'Adopted', body: 'Installed, imported or configured your product in the code.', cls: VERDICT_STYLE.good },
  { name: 'Recommended', body: 'Explicitly advised using your product, without wiring it in.', cls: VERDICT_STYLE.good },
  { name: 'Mentioned', body: 'Named you in passing, as one option among others.', cls: VERDICT_STYLE.meh },
  { name: 'Competitor', body: 'Picked a competitor you configured instead.', cls: VERDICT_STYLE.bad },
  { name: 'None', body: 'You never came up. Built it another way.', cls: 'bg-secondary text-secondary-foreground border-transparent' }
];

export function Scorecard() {
  return (
    <Section id='features' eyebrow='Your APO scorecard' title='A measurable answer to “do agents prefer us?”'
      lead='Numbers you can track, broken down the way you’d actually act on them, each one traceable to its source.'>
      <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
        {FEATURES.map((f) => (
          <Card key={f.title}>
            <CardContent className='space-y-3'>
              <div className='bg-primary/10 text-primary flex size-10 items-center justify-center rounded-lg'><f.icon className='size-5' /></div>
              <h3 className='font-semibold'>{f.title}</h3>
              <p className='text-muted-foreground text-sm'>{f.body}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <div className='mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-5'>
        {VERDICTS.map((v) => (
          <div key={v.name} className='rounded-lg border p-4'>
            <Badge className={v.cls}>{v.name}</Badge>
            <p className='text-muted-foreground mt-2 text-sm'>{v.body}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ---------- Claude & ChatGPT ----------

export function WhereYouWork() {
  return (
    <Section id='claude' eyebrow='APO where you already work' title='No new dashboard to learn. Just ask.'
      lead='Octillion is an MCP server with an interactive dashboard. Add it as a connector in Claude desktop or ChatGPT desktop, then configure products, launch simulations and dig into results in plain language.'>
      <div className='grid gap-8 lg:grid-cols-[1fr_1.15fr] lg:items-start'>
        <ul className='space-y-4'>
          {[
            ['Configure by talking.', '“Add OtherDB and FastDB as competitors.”'],
            ['Launch from chat.', '“Run the queue-setup scenarios on every model tonight.”'],
            ['Explore interactively.', 'Charts, breakdowns and transcripts render right in the conversation.']
          ].map(([t, b]) => (
            <li key={t} className='flex gap-3'>
              <IconSparkles className='text-primary mt-0.5 size-5 shrink-0' />
              <p><span className='font-semibold'>{t}</span> <span className='text-muted-foreground'>{b}</span></p>
            </li>
          ))}
          <li className='pt-2'><Link href='/app' className={buttonVariants({ variant: 'outline' })}>Set it up in your account <IconArrowRight /></Link></li>
        </ul>
        <ChatMock />
      </div>
    </Section>
  );
}

function ChatMock() {
  return (
    <Card className='shadow-lg'>
      <CardContent className='space-y-4'>
        <div className='bg-muted ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm px-4 py-2.5 text-sm'>How often does model-b pick us over OtherQueue for queue setup?</div>
        <div className='flex items-center gap-2 rounded-lg border px-3 py-2 font-mono text-xs'>
          <IconBolt className='text-primary size-4 shrink-0' />
          <span className='font-semibold'>Octillion</span>
          <span className='text-muted-foreground truncate'>get_share_of_voice · scenario: queue-setup · model: model-b</span>
        </div>
        <p className='text-sm'>
          Across the last batch of queue-setup runs on model-b, YourQueue was adopted or recommended more often than OtherQueue, but
          lost on the Python worker scenario. Want the transcripts where it chose OtherQueue?
        </p>
        <div className='space-y-2 rounded-lg border p-3'>
          {[['YourQueue', 'w-[64%]', 'bg-primary'], ['OtherQueue', 'w-[36%]', 'bg-muted-foreground/40']].map(([n, w, c]) => (
            <div key={n} className='grid grid-cols-[90px_1fr] items-center gap-3 text-xs'>
              <span className='text-muted-foreground'>{n}</span>
              <div className='bg-muted h-2.5 rounded-full'><div className={cn('h-full rounded-full', w, c)} /></div>
            </div>
          ))}
          <p className='text-muted-foreground text-[11px]'>sample</p>
        </div>
        <div className='bg-muted ml-auto w-fit rounded-2xl rounded-br-sm px-4 py-2.5 text-sm'>Yes, show me the evidence.</div>
        <p className='text-muted-foreground text-center text-xs'>Illustrative conversation · placeholder names and values</p>
      </CardContent>
    </Card>
  );
}
