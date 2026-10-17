import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { IconDownload } from '@tabler/icons-react';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CopyField } from '@/features/site/copy-field';

export const metadata: Metadata = {
  title: 'Connect Octillion — APO in Claude & ChatGPT',
  description: 'Connect Octillion to Claude or ChatGPT with your connector URL, install the Octillion skill, and run your first agent visibility test.'
};

function Steps({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className='space-y-3'>
      {items.map((it, i) => (
        <li key={i} className='flex gap-3'>
          <span className='bg-primary/15 text-primary flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold'>{i + 1}</span>
          <span className='text-sm leading-6'>{it}</span>
        </li>
      ))}
    </ol>
  );
}

const Kbd = ({ children }: { children: React.ReactNode }) => <strong className='font-semibold'>{children}</strong>;
const C = ({ children }: { children: React.ReactNode }) => <code className='bg-muted rounded px-1.5 py-0.5 font-mono text-xs'>{children}</code>;

export default async function ConnectPage() {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'octillion.example.com';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  const url = `${proto}://${host}/mcp`;
  return (
    <div className='mx-auto max-w-4xl px-4 py-12 sm:px-6 sm:py-16'>
      <p className='text-primary text-sm font-semibold tracking-wide uppercase'>Connect</p>
      <h1 className='mt-2 text-3xl font-semibold tracking-tight sm:text-4xl'>Connect Octillion</h1>
      <p className='text-muted-foreground mt-4 text-lg'>
        Octillion is the APO (Agentic Preference Optimization) platform, and it lives inside Claude and ChatGPT. Add it as a connector,
        sign in with your Octillion account, install the skill, and ask it to onboard your product.
      </p>

      <Card className='mt-8'>
        <CardHeader><CardTitle>Your connector URL</CardTitle></CardHeader>
        <CardContent className='space-y-3'>
          <CopyField value={url} />
          <p className='text-muted-foreground text-sm'>
            There is no secret in it: when your client connects, it asks you to sign in with your Octillion account (the email your
            invitation went to, or Google, Microsoft or GitHub). Don&apos;t have an account yet? <Link href='/#access' className='text-primary underline-offset-4 hover:underline'>Request access</Link>.
          </p>
        </CardContent>
      </Card>

      <div className='mt-8 grid gap-6 md:grid-cols-2'>
        <Card>
          <CardHeader><CardTitle>Claude (web &amp; desktop)</CardTitle></CardHeader>
          <CardContent>
            <Steps items={[
              <>Open <Kbd>Settings → Connectors</Kbd>. On Team and Enterprise plans an owner adds it under <Kbd>Organization settings → Connectors</Kbd>.</>,
              <>Click <Kbd>Add custom connector</Kbd>, name it <C>Octillion</C>, paste your connector URL and save. Sign in when Claude asks.</>,
              <>In a chat, enable Octillion from the tools menu. Results show up as an interactive dashboard.</>,
              <>Optional but recommended: install the <a href='#skill' className='text-primary underline-offset-4 hover:underline'>Octillion skill</a> so Claude knows the workflow and reads results carefully.</>
            ]} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>ChatGPT (web &amp; desktop)</CardTitle></CardHeader>
          <CardContent>
            <Steps items={[
              <>Open <Kbd>Plugins → +</Kbd> and choose <Kbd>Add custom MCP server</Kbd>. On older workspaces this lives under <Kbd>Settings → Apps &amp; Connectors</Kbd> with <Kbd>Developer mode</Kbd> turned on. Business, Enterprise and Edu workspaces may need an admin to allow custom MCP servers.</>,
              <>Name it <C>Octillion</C>, paste your connector URL, choose <Kbd>OAuth</Kbd> and save. Sign in when ChatGPT asks.</>,
              <>In a chat, add Octillion from the <Kbd>+</Kbd> menu. ChatGPT renders the same dashboard.</>
            ]} />
          </CardContent>
        </Card>
      </div>

      <Card className='mt-6'>
        <CardHeader><CardTitle>Claude Code, Cursor and other IDEs</CardTitle></CardHeader>
        <CardContent className='space-y-3 text-sm'>
          <p>Add the connector URL as an HTTP MCP server, then sign in when the client asks. For Claude Code, in <C>.mcp.json</C>:</p>
          <pre className='bg-muted overflow-x-auto rounded-lg border p-3 font-mono text-xs'>{JSON.stringify({ mcpServers: { octillion: { type: 'http', url } } }, null, 2)}</pre>
          <p className='text-muted-foreground'>IDE clients show text results rather than the dashboard.</p>
        </CardContent>
      </Card>

      <section id='skill' className='mt-12 scroll-mt-20'>
        <h2 className='text-2xl font-semibold tracking-tight'>The Octillion skill for Claude</h2>
        <p className='text-muted-foreground mt-2'>The skill teaches Claude the Octillion workflow and how to report results with confidence intervals and transcript evidence.</p>
        <a href='/downloads/octillion-skill.zip' download className={buttonVariants({ className: 'mt-4' })}><IconDownload /> Download octillion-skill.zip</a>
        <div className='mt-6'>
          <Steps items={[
            <>In Claude, open <Kbd>Settings → Capabilities → Skills</Kbd> and click <Kbd>Upload skill</Kbd>.</>,
            <>Select <C>octillion-skill.zip</C>. Claude uses it automatically whenever you ask about agent visibility.</>
          ]} />
        </div>
      </section>

      <section className='mt-12'>
        <h2 className='text-2xl font-semibold tracking-tight'>Your first run</h2>
        <div className='mt-6 grid gap-4 md:grid-cols-3'>
          {[
            ['1. Onboard', '“Onboard my product: <one paragraph>. Website https://…, docs https://…”'],
            ['2. Review', 'Check the package names, competitors and the generated problems. Ask Claude to fix anything that\'s off.'],
            ['3. Read the report', '“Show the visibility report and explain our biggest loss with evidence.”']
          ].map(([t, b]) => (
            <Card key={t} size='sm'><CardContent><h3 className='font-semibold'>{t}</h3><p className='text-muted-foreground mt-1 text-sm'>{b}</p></CardContent></Card>
          ))}
        </div>
        <p className='text-muted-foreground mt-6 text-sm'>Runs use real coding agents in isolated sandboxes, so they take a few minutes. Agents never see your product&apos;s name in a task, which keeps the results honest.</p>
      </section>
    </div>
  );
}
