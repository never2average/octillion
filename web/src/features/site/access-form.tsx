'use client';
import { useState } from 'react';
import { IconArrowRight, IconCircleCheck } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalizeUrl = (v: string) => (!v ? '' : /^https?:\/\//i.test(v) ? v : `https://${v}`);
const AGENTS = ['Claude Code', 'Codex', 'Cursor', 'GitHub Copilot', 'Gemini CLI', 'Windsurf', 'Cline'];
const TEAM = ['1-10', '11-50', '51-200', '201-1000', '1000+'];
/** Where the visitor came from: the referrer, utm_* tags and the page they landed on (first page of the visit). */
function visitSource() {
  try {
    const p = new URLSearchParams(window.location.search), out: Record<string, string> = { landing: sessionStorage.getItem('oc:landing') ?? window.location.pathname, referrer: document.referrer };
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) { const v = p.get(k) ?? sessionStorage.getItem(`oc:${k}`); if (v) out[k] = v; }
    return out;
  } catch { return {}; }
}

/** Landing-page access request: POST /api/access-requests (the API server, through the web app's proxy). */
export function AccessForm() {
  const [v, setV] = useState({ email: '', company: '', product_url: '', message: '', name: '', role: '', team_size: '' });
  const [agents, setAgents] = useState<string[]>([]);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<'idle' | 'sending' | 'done'>('idle');
  const [error, setError] = useState('');
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setV({ ...v, [k]: e.target.value });
    if (errs[k]) setErrs({ ...errs, [k]: '' });
  };

  const validate = () => {
    const e: Record<string, string> = {};
    if (!v.email.trim()) e.email = 'Enter your email.';
    else if (!EMAIL.test(v.email.trim())) e.email = 'Enter a valid email address.';
    if (!v.company.trim()) e.company = 'Enter your company name.';
    if (v.product_url.trim()) {
      let ok = false;
      try { ok = /\./.test(new URL(normalizeUrl(v.product_url.trim())).hostname); } catch { /* invalid */ }
      if (!ok) e.product_url = 'Enter a valid URL, e.g. https://yourproduct.dev';
    }
    setErrs(e);
    const first = Object.keys(e)[0];
    if (first) document.getElementById(`f-${first}`)?.focus();
    return !first;
  };

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setError('');
    if (!validate()) return;
    setStatus('sending');
    try {
      const res = await fetch('/api/access-requests', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email: v.email.trim(), company: v.company.trim(), product_url: normalizeUrl(v.product_url.trim()), message: v.message.trim(),
          name: v.name.trim(), role: v.role.trim(), team_size: v.team_size, agents, source: visitSource() })
      });
      const data = await res.json().catch(() => null);
      if (res.ok) return setStatus('done');
      setError((data && typeof data.error === 'string' && data.error) || (res.status === 429 ? 'Too many requests. Please try again in a minute.' : `Something went wrong (HTTP ${res.status}). Please try again.`));
    } catch {
      setError('Network error. Check your connection and try again.');
    }
    setStatus('idle');
  };

  if (status === 'done') {
    return (
      <div className='flex flex-col items-start gap-3 py-6' role='status' tabIndex={-1}>
          <IconCircleCheck className='text-primary size-10' />
          <h3 className='text-lg font-semibold'>Thanks — we&apos;ll be in touch shortly</h3>
          <p className='text-muted-foreground'>Your request is in. Expect a reply from the Octillion team soon.</p>
      </div>
    );
  }

  const field = (k: 'email' | 'company' | 'product_url' | 'name' | 'role', label: string, props: React.ComponentProps<'input'>) => (
    <div className='space-y-1.5'>
      <Label htmlFor={`f-${k}`}>{label}</Label>
      <Input id={`f-${k}`} name={k} value={v[k]} onChange={set(k)} aria-invalid={Boolean(errs[k]) || undefined} aria-describedby={`e-${k}`} {...props} />
      <p id={`e-${k}`} className='text-destructive min-h-4 text-xs'>{errs[k]}</p>
    </div>
  );

  return (
        <form onSubmit={submit} noValidate className='space-y-2'>
          <div className='grid gap-x-4 sm:grid-cols-2'>
            {field('name', 'Your name', { autoComplete: 'name', maxLength: 120 })}
            {field('role', 'Role (optional)', { autoComplete: 'organization-title', placeholder: 'e.g. Head of DevRel', maxLength: 120 })}
            {field('email', 'Work email', { type: 'email', autoComplete: 'email', placeholder: 'you@company.com', maxLength: 254, required: true })}
            {field('company', 'Company', { autoComplete: 'organization', maxLength: 200, required: true })}
          </div>
          <div className='grid gap-x-4 sm:grid-cols-[1fr_10rem]'>
            {field('product_url', 'Product URL (optional)', { type: 'url', inputMode: 'url', autoComplete: 'url', placeholder: 'https://yourproduct.dev', maxLength: 500 })}
            <div className='space-y-1.5'>
              <Label htmlFor='f-team_size'>Team size (optional)</Label>
              <select id='f-team_size' name='team_size' value={v.team_size} onChange={(e) => setV({ ...v, team_size: e.target.value })}
                className='border-input bg-background h-9 w-full rounded-md border px-3 text-sm'>
                <option value=''>Choose</option>
                {TEAM.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <fieldset className='space-y-2 pb-4'>
            <legend className='text-sm font-medium'>Coding agents you care about (optional)</legend>
            <div className='flex flex-wrap gap-1.5 pt-1.5'>
              {AGENTS.map((a) => {
                const on = agents.includes(a);
                return (
                  <button key={a} type='button' aria-pressed={on} onClick={() => setAgents(on ? agents.filter((x) => x !== a) : [...agents, a])}
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${on ? 'border-primary bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'}`}>{a}</button>
                );
              })}
            </div>
          </fieldset>
          <div className='space-y-1.5'>
            <Label htmlFor='f-message'>What do you want to learn? (optional)</Label>
            <Textarea id='f-message' name='message' rows={3} maxLength={4000} value={v.message} onChange={set('message')}
              placeholder='Competitors you track, scenarios you care about, models your users run…' />
          </div>
          {error && <p className='text-destructive text-sm' role='alert'>{error}</p>}
          <div className='flex flex-col gap-3 pt-3 sm:flex-row sm:items-center'>
            <Button type='submit' size='lg' disabled={status === 'sending'} aria-busy={status === 'sending'}>
              {status === 'sending' ? 'Sending…' : <>Get your APO baseline <IconArrowRight /></>}
            </Button>
            <p className='text-muted-foreground text-xs'>We&apos;ll only use your details to respond to this request.</p>
          </div>
        </form>
  );
}
