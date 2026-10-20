'use client';
// /admin/connect: connect an AI client (Claude Code, Cursor, Claude Desktop) to the admin MCP server (src/admin-mcp.ts,
// /admin/mcp). Clients sign in with Clerk like the customer connector; only platform admins get in, and each tool
// needs the role its panel button needs. The URL, skills and tools come from GET /mcp, so they match the server.
import { useState } from 'react';
import PageContainer from '@/components/layout/page-container';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';
import { useAdmin } from './lib';
import { useAdminRole, ROLE_LABEL, type AdminRole } from './role';
import { ErrorBox, LoadingCards, Section, StatusBadge, copyText } from './ui';

interface Tool { name: string; title: string; needs: AdminRole; needs_label: string; changes: boolean; destructive: boolean }
/** A skill: a playbook shipped as an MCP prompt, a slash command in the client (src/admin-mcp.ts ADMIN_SKILLS). */
interface Skill { name: string; title: string; description: string; args: string[] }
const ORDER: AdminRole[] = ['viewer', 'support', 'operator', 'owner'];

/** Each client's way in: one thing to paste. */
function clients(url: string) {
  return [
    { id: 'claude-code', label: 'Claude Code', steps: 'Run this, then /mcp in Claude Code to sign in.', text: `claude mcp add --transport http octillion-admin ${url}` },
    { id: 'cursor', label: 'Cursor', steps: 'Add this to ~/.cursor/mcp.json. Cursor asks you to sign in when it connects.',
      text: JSON.stringify({ mcpServers: { 'octillion-admin': { url } } }, null, 2) },
    { id: 'claude-desktop', label: 'Claude Desktop', steps: 'Settings › Connectors › Add custom connector, and paste this URL.', text: url }
  ];
}

export function AdminConnect() {
  const { data, error, isLoading } = useAdmin<{ url: string; tools: Tool[]; skills?: Skill[] }>('/mcp');
  const { role, label } = useAdminRole();
  const [pick, setPick] = useState('claude-code');
  const list = clients(data?.url ?? '');
  const c = list.find((x) => x.id === pick) ?? list[0];
  const mine = (t: Tool) => role != null && ORDER.indexOf(role) >= ORDER.indexOf(t.needs);
  const kind = (t: Tool) => (t.destructive ? 'destructive' : t.changes ? 'changes' : null);
  return (
    <PageContainer>
      <ErrorBox error={error} />
      {isLoading || !data ? <LoadingCards count={2} /> : (
        <div className='flex max-w-3xl flex-col gap-10'>
          <Section title='Connect an AI client' description={`Use the admin panel from Claude or Cursor. You sign in with your admin account, and every call is logged under your name${label ? ` as ${label}` : ''}.`}>
            <div className='flex flex-col gap-3'>
              <div className='flex flex-wrap gap-1.5' role='tablist' aria-label='Your AI client'>
                {list.map((x) => (
                  <Button key={x.id} size='sm' role='tab' aria-selected={x.id === c.id} variant={x.id === c.id ? 'secondary' : 'ghost'} onClick={() => setPick(x.id)}>{x.label}</Button>
                ))}
              </div>
              <p className='text-muted-foreground text-sm'>{c.steps}</p>
              <Snippet text={c.text} />
            </div>
          </Section>
          {!!data.skills?.length && (
            <Section title='Skills' description='Type / in your client to run one. They ask before changing anything.'>
              <ul className='flex flex-col gap-3'>
                {data.skills.map((k) => (
                  <li key={k.name} className='flex flex-col gap-0.5 text-sm sm:flex-row sm:gap-4'>
                    <code className='w-44 shrink-0 font-mono text-xs leading-5'>/{k.name}</code>
                    <span className='text-muted-foreground'>{k.description}{k.args.length ? ` Asks for ${k.args.join(', ')}.` : ''}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <Section title='Tools' description={role ? `As ${ROLE_LABEL[role]}, tools shown faded are refused.` : undefined}>
            <ul className='grid gap-x-6 gap-y-1.5 sm:grid-cols-2'>
              {data.tools.map((t) => (
                <li key={t.name} title={mine(t) ? t.title : `${t.title}: needs ${t.needs_label}`}
                  className={cn('flex items-center gap-2 text-sm', !mine(t) && 'opacity-45')}>
                  <code className='truncate font-mono text-xs'>{t.name}</code>
                  {kind(t) && <StatusBadge tone={t.destructive ? 'bad' : 'warn'}>{kind(t)}</StatusBadge>}
                </li>
              ))}
            </ul>
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
