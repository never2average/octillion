'use client';
// /admin/connect: connect an AI client (Claude Code, Cursor, Claude Desktop) to the admin MCP server (src/admin-mcp.ts,
// /admin/mcp). Clients sign in with Clerk like the customer connector; only platform admins get in, and each tool
// needs the role its panel button needs. The URL and the tool list come from GET /mcp, so they match the server.
import { useState } from 'react';
import PageContainer from '@/components/layout/page-container';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';
import { useAdmin } from './lib';
import { useAdminRole, ROLE_LABEL, type AdminRole } from './role';
import { CopyField, DataList, ErrorBox, LoadingCards, Section, StatusBadge, copyText } from './ui';

interface Tool { name: string; title: string; needs: AdminRole; needs_label: string; changes: boolean; destructive: boolean }
/** A skill: a playbook shipped as an MCP prompt, a slash command in the client (src/admin-mcp.ts ADMIN_SKILLS). */
interface Skill { name: string; title: string; description: string; args: string[] }
const ORDER: AdminRole[] = ['viewer', 'support', 'operator', 'owner'];

/** Each client's way in: a command, or a config file and its snippet. */
function clients(url: string) {
  return [
    { id: 'claude-code', label: 'Claude Code', steps: 'Run this, then /mcp in Claude Code and pick octillion-admin to sign in.',
      command: `claude mcp add --transport http octillion-admin ${url}` },
    { id: 'cursor', label: 'Cursor', steps: 'Add it to ~/.cursor/mcp.json (or .cursor/mcp.json in a project). Cursor opens the sign-in when it first connects.',
      file: '~/.cursor/mcp.json', snippet: JSON.stringify({ mcpServers: { 'octillion-admin': { url } } }, null, 2) },
    { id: 'claude-desktop', label: 'Claude Desktop', steps: 'Settings › Connectors › Add custom connector, name it Octillion admin and paste the URL. Or, without connectors, add it to claude_desktop_config.json:',
      file: 'claude_desktop_config.json', snippet: JSON.stringify({ mcpServers: { 'octillion-admin': { command: 'npx', args: ['-y', 'mcp-remote', url] } } }, null, 2) }
  ];
}

export function AdminConnect() {
  const { data, error, isLoading } = useAdmin<{ url: string; tools: Tool[]; skills?: Skill[] }>('/mcp');
  const { role, label } = useAdminRole();
  const [pick, setPick] = useState('claude-code');
  // The server's public URL, as on the customer setup page: the OAuth metadata names the same resource.
  const url = data?.url ?? '';
  const list = clients(url);
  const c = list.find((x) => x.id === pick) ?? list[0];
  const mine = (t: Tool) => role != null && ORDER.indexOf(role) >= ORDER.indexOf(t.needs);
  return (
    <PageContainer>
      <ErrorBox error={error} />
      {isLoading || !data ? <LoadingCards count={2} /> : (
        <div className='flex max-w-4xl flex-col gap-8'>
          <Section title='Connect an AI client' description='Ask Claude or Cursor about accounts, access requests, compute health, FinOps and settings, and make the same changes your role allows here. Your client signs you in with your Octillion admin account.'>
            <div className='flex flex-col gap-4'>
              <CopyField value={url} />
              <div className='flex flex-wrap gap-2' role='tablist' aria-label='Your AI client'>
                {list.map((x) => (
                  <Button key={x.id} size='sm' role='tab' aria-selected={x.id === c.id} variant={x.id === c.id ? 'default' : 'outline'} onClick={() => setPick(x.id)}>{x.label}</Button>
                ))}
              </div>
              <div className='flex flex-col gap-2 text-sm'>
                <p className='text-muted-foreground'>{c.steps}</p>
                {c.command && <Snippet text={c.command} />}
                {c.snippet && <>{c.file && <div className='text-muted-foreground text-xs'>In <code className='font-mono'>{c.file}</code></div>}<Snippet text={c.snippet} /></>}
              </div>
              <p className='text-muted-foreground text-xs'>
                Every call is in the admin access log, and every change in the admin log under your name{label ? `, as ${label}` : ''}. Ask your client to confirm before it changes anything.
              </p>
            </div>
          </Section>
          {!!data.skills?.length && (
            <Section title='Skills' description='Ready-made playbooks that chain the tools, shipped with the server: type / in your client to run one. They read, then ask before changing anything.'>
              <DataList<Skill> rows={data.skills} noun='skills' empty='No skills.' minWidth={520} cols={[
                { label: 'Skill', className: 'w-56', render: (k) => <span className='flex flex-col gap-1'><span className='font-medium'>{k.title}</span><code className='text-muted-foreground font-mono text-xs'>/{k.name}</code></span> },
                { label: 'What it does', render: (k) => <span className='text-sm'>{k.description}{k.args.length ? <span className='text-muted-foreground block text-xs'>Asks for: {k.args.join(', ')}</span> : null}</span> }
              ]} />
            </Section>
          )}
          <Section title='Tools' description={role ? `You are ${ROLE_LABEL[role]}: the tools marked as needing a higher role are refused.` : undefined}>
            <DataList<Tool> rows={data.tools} noun='tools' empty='No tools.' minWidth={520} cols={[
              { label: 'Tool', render: (t) => <span className='flex flex-col gap-1'><span className='font-medium'>{t.title}</span><code className='text-muted-foreground font-mono text-xs'>{t.name}</code></span> },
              { label: 'Kind', className: 'w-28', render: (t) => (t.destructive ? <StatusBadge tone='bad'>destructive</StatusBadge> : t.changes ? <StatusBadge tone='warn'>changes</StatusBadge> : <StatusBadge tone='neutral'>read</StatusBadge>) },
              { label: 'Needs', className: 'w-32', render: (t) => <span className={cn(!mine(t) && 'text-muted-foreground line-through')} title={mine(t) ? undefined : 'Your role cannot use this tool'}>{t.needs_label}</span> }
            ]} />
          </Section>
        </div>
      )}
    </PageContainer>
  );
}

function Snippet({ text }: { text: string }) {
  return (
    <div className='relative'>
      <pre className='bg-background overflow-x-auto rounded-md border p-2.5 pr-20 font-mono text-xs whitespace-pre-wrap break-all'>{text}</pre>
      <div className='absolute top-1 right-1'>
        <Button variant='ghost' size='sm' onClick={() => copyText(text)}><Icons.page className='size-3.5' /> Copy</Button>
      </div>
    </div>
  );
}
