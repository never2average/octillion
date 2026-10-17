'use client';
// /app Limits: account admins split the plan's monthly model budget across teams and people (shared pool, even split
// with adjustments, or custom caps), choose who may launch simulations, and cap throughput. Everyone sees their allowance.
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { PageTabs } from '@/components/layout/page-tabs';
import { BILLING_TABS } from './billing';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Rule, Section, StatStrip } from '@/components/layout/section';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Icons } from '@/components/icons';
import { appApi } from '@/lib/api-client';
import { num, usd } from '@/lib/octillion-format';
import { ErrorState, FormRow, LoadingCards, SpendMeter, fail, useOrgLoad } from './shared';

type Mode = 'pool' | 'even' | 'custom';
interface Policy { mode: Mode; reserve_usd: number; default_cap_usd: number | null; new_members_can_run: boolean; max_concurrent_runs: number | null;
  max_sessions_per_run: number | null; updated_at?: string | null; updated_by?: string | null }
interface Team { id: number; name: string; budget_usd: number | null; max_concurrent_runs: number | null; members: number; spent: number }
interface Member { user_id: string; email: string | null; name: string | null; role: string; team_id: number | null; can_run: boolean; adjust_usd: number; cap_usd: number | null;
  max_concurrent_runs: number | null; allowance_usd: number | null; spent: number; tokens_in: number; tokens_out: number; running: number }
interface Limits { policy: Policy; budget_usd: number; plan?: string | null; clerk?: boolean; workos?: boolean; teams: Team[]; members: Member[];
  allocated_usd?: number; unallocated_usd?: number | null; spent_usd?: number; can_manage: boolean; me: string | null }

const HELP: Record<Mode, string> = {
  pool: "Everyone draws from the account's budget (and their team's budget, if it has one) until it runs out.",
  even: 'Each person gets an equal share of what is left after the reserve and team budgets; people in a team with a budget share that budget. Adjust anyone up or down.',
  custom: 'Set a monthly cap per person; people without one get the default cap.'
};
const orNull = (v: string) => (v.trim() === '' ? null : Number(v));
const str = (v: number | null | undefined) => (v == null ? '' : String(v));

export function LimitsPage() {
  const { data: d, error, reload } = useOrgLoad(() => appApi<Limits>('GET', '/limits'));
  const synced = d ? (d.clerk ?? d.workos ?? true) : true;
  const mine = d?.members.find((m) => m.user_id === d.me);
  return (
    <PageContainer pageTitle='Billing' pageDescription="Split the plan's monthly model budget across teams and people, choose who can launch simulations, and cap how much each person runs at once.">
      <PageTabs items={BILLING_TABS} />
      {error ? <ErrorState error={error} /> : !d ? <LoadingCards count={4} /> : (
        <div className='flex max-w-6xl flex-col gap-8'>
          {!synced && <Alert><Icons.info /><AlertDescription>Per-person limits need this account&apos;s team to be set up. Until then everyone shares the account budget.</AlertDescription></Alert>}
          {mine && <MyAllowance d={d} me={mine} />}
          {d.can_manage && synced && <AdminLimits d={d} reload={reload} />}
        </div>
      )}
    </PageContainer>
  );
}

function MyAllowance({ d, me }: { d: Limits; me: Member }) {
  const t = d.teams.find((x) => x.id === me.team_id);
  const conc = me.max_concurrent_runs ?? d.policy.max_concurrent_runs;
  return (
    <Section title='Your allowance this month'
      description={`${me.can_run ? 'You can launch simulations.' : 'Launching simulations is not switched on for you; reports and transcripts stay available.'}${conc != null ? ` Up to ${conc} running at once.` : ''}`}>
      <div className='grid gap-4 sm:grid-cols-3'>
        <div className='sm:col-span-2'>
          {me.allowance_usd == null
            ? <p className='text-muted-foreground text-sm'>No personal cap: you draw from {t && t.budget_usd != null ? `team ${t.name}'s budget` : "the account's budget"}.</p>
            : <SpendMeter spent={me.spent} budget={me.allowance_usd} />}
        </div>
        <div className='text-sm'>
          <div className='text-muted-foreground text-xs'>Tokens this month</div>
          <div className='text-lg font-semibold tabular-nums'>{num(Number(me.tokens_in) + Number(me.tokens_out))}</div>
        </div>
      </div>
    </Section>
  );
}

function AdminLimits({ d, reload }: { d: Limits; reload: () => void }) {
  const p = d.policy;
  const init = () => ({ reserve: p.reserve_usd ? String(p.reserve_usd) : '', defaultCap: str(p.default_cap_usd), newRun: p.new_members_can_run, conc: str(p.max_concurrent_runs), sess: str(p.max_sessions_per_run) });
  const [mode, setMode] = useState<Mode>(p.mode);
  const [f, setF] = useState(init);
  const [busy, setBusy] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setMode(p.mode); setF(init()); }, [p.mode, p.reserve_usd, p.default_cap_usd, p.new_members_can_run, p.max_concurrent_runs, p.max_sessions_per_run]);
  const save = () => {
    setBusy(true);
    appApi('PUT', '/limits/policy', { mode, reserve_usd: orNull(f.reserve) || 0, default_cap_usd: orNull(f.defaultCap), new_members_can_run: f.newRun,
      max_concurrent_runs: orNull(f.conc), max_sessions_per_run: orNull(f.sess) })
      .then(() => { toast.success('Saved'); reload(); }).catch(fail).finally(() => setBusy(false));
  };
  return (<>
    <Rule />
    <StatStrip items={[
      { label: 'Plan budget this month', value: usd(d.budget_usd), hint: d.plan ?? undefined },
      { label: 'Allocated', value: usd(d.allocated_usd) },
      { label: 'Not allocated', value: d.unallocated_usd == null ? '-' : usd(d.unallocated_usd) },
      { label: 'Spent by people', value: usd(d.spent_usd) }
    ]} />
    <div className='grid gap-x-12 gap-y-8 lg:grid-cols-2'>
      <Section title='How the budget is shared' description={HELP[mode]}>
        <div className='grid gap-4'>
          <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
            <TabsList><TabsTrigger value='pool'>Shared pool</TabsTrigger><TabsTrigger value='even'>Split evenly</TabsTrigger><TabsTrigger value='custom'>Custom caps</TabsTrigger></TabsList>
          </Tabs>
          {mode === 'even' && (
            <FormRow label='Keep back as a shared reserve ($)' htmlFor='limReserve'>
              <Input id='limReserve' type='number' min={0} step={1} value={f.reserve} onChange={(e) => setF({ ...f, reserve: e.target.value })} />
            </FormRow>
          )}
          {mode === 'custom' && (
            <FormRow label='Default monthly cap ($)' htmlFor='limDefaultCap' hint='For people without their own cap; empty means no cap.'>
              <Input id='limDefaultCap' type='number' min={0} step={1} value={f.defaultCap} onChange={(e) => setF({ ...f, defaultCap: e.target.value })} />
            </FormRow>
          )}
        </div>
      </Section>
      <Section title='Rollout and throughput' description='Who may launch simulations, and how much runs at once.'>
        <div className='grid gap-4'>
          <label className='flex items-center justify-between gap-3 text-sm'>
            <span>New members can launch simulations</span>
            <Switch checked={f.newRun} onCheckedChange={(v) => setF({ ...f, newRun: Boolean(v) })} />
          </label>
          <div className='grid gap-4 sm:grid-cols-2'>
            <FormRow label='Running at once, per person' htmlFor='limConc' hint='Empty means no limit.'>
              <Input id='limConc' type='number' min={0} step={1} value={f.conc} onChange={(e) => setF({ ...f, conc: e.target.value })} />
            </FormRow>
            <FormRow label='Agent sessions per launch' htmlFor='limSess' hint="Empty means the server's limit.">
              <Input id='limSess' type='number' min={1} step={1} value={f.sess} onChange={(e) => setF({ ...f, sess: e.target.value })} />
            </FormRow>
          </div>
        </div>
      </Section>
    </div>
    <div className='flex flex-wrap items-center gap-3'>
      <Button onClick={save} disabled={busy}>Save sharing and limits</Button>
      {p.updated_at && <span className='text-muted-foreground text-xs'>Last changed {new Date(p.updated_at).toLocaleString()}{p.updated_by ? ` by ${p.updated_by.replace(/^customer:/, '')}` : ''}</span>}
    </div>
    <Rule />
    <Teams d={d} reload={reload} />
    <Rule />
    <People d={d} reload={reload} />
  </>);
}

function Teams({ d, reload }: { d: Limits; reload: () => void }) {
  const [add, setAdd] = useState({ name: '', budget: '', conc: '' });
  const [edit, setEdit] = useState<{ id: number; name: string; budget: string; conc: string } | null>(null);
  const [del, setDel] = useState<Team | null>(null);
  const create = (e: React.FormEvent) => {
    e.preventDefault();
    appApi('POST', '/limits/teams', { name: add.name, budget_usd: orNull(add.budget), max_concurrent_runs: orNull(add.conc) })
      .then(() => { setAdd({ name: '', budget: '', conc: '' }); toast.success('Team added'); reload(); }).catch(fail);
  };
  const saveEdit = (e: React.FormEvent) => {
    e.preventDefault(); if (!edit) return;
    appApi('PUT', `/limits/teams/${edit.id}`, { name: edit.name, budget_usd: orNull(edit.budget), max_concurrent_runs: orNull(edit.conc) })
      .then(() => { setEdit(null); toast.success('Saved'); reload(); }).catch(fail);
  };
  const remove = () => del && appApi('DELETE', `/limits/teams/${del.id}`).then(() => { setDel(null); toast.success('Deleted'); reload(); }).catch(fail);
  return (
    <Section title='Teams' description={"A team's budget is split among its members (in Split evenly) and caps the team's combined spend in every mode."}>
      <div className='overflow-x-auto'>
        {d.teams.length ? (
          <Table>
            <TableHeader><TableRow><TableHead>Team</TableHead><TableHead>Budget</TableHead><TableHead>Spent</TableHead><TableHead>People</TableHead><TableHead>Runs at once</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {d.teams.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className='font-medium'>{t.name}</TableCell>
                  <TableCell>{t.budget_usd == null ? <span className='text-muted-foreground'>no cap</span> : usd(t.budget_usd)}</TableCell>
                  <TableCell className='tabular-nums'>{usd(t.spent)}</TableCell>
                  <TableCell>{t.members}</TableCell>
                  <TableCell>{t.max_concurrent_runs ?? <span className='text-muted-foreground'>-</span>}</TableCell>
                  <TableCell className='text-right'>
                    <div className='flex justify-end gap-1'>
                      <Button variant='ghost' size='sm' onClick={() => setEdit({ id: t.id, name: t.name, budget: str(t.budget_usd), conc: str(t.max_concurrent_runs) })}><Icons.edit /> Edit</Button>
                      <Button variant='ghost' size='sm' onClick={() => setDel(t)} aria-label={`Delete ${t.name}`}><Icons.trash /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : <p className='text-muted-foreground text-sm'>No teams. Everyone shares the account budget.</p>}
      </div>
      <form onSubmit={create} className='grid w-full gap-2 sm:grid-cols-[2fr_1fr_1fr_auto]'>
          <Input placeholder='Team name' required value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} aria-label='Team name' />
          <Input type='number' min={0} step={1} placeholder='Budget $ (optional)' value={add.budget} onChange={(e) => setAdd({ ...add, budget: e.target.value })} aria-label='Monthly budget' />
          <Input type='number' min={0} step={1} placeholder='Runs at once' value={add.conc} onChange={(e) => setAdd({ ...add, conc: e.target.value })} aria-label='Runs at once' />
          <Button type='submit' variant='outline'><Icons.add /> Add team</Button>
      </form>
      <Dialog open={edit !== null} onOpenChange={(o) => { if (!o) setEdit(null); }}>
        <DialogContent>
          {edit && (
            <form onSubmit={saveEdit} className='grid gap-4'>
              <DialogHeader><DialogTitle>Edit team</DialogTitle><DialogDescription>Change the team&apos;s name, monthly budget or concurrency.</DialogDescription></DialogHeader>
              <FormRow label='Team name' htmlFor='teName'><Input id='teName' required value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></FormRow>
              <FormRow label='Monthly budget ($)' htmlFor='teBudget' hint='Empty means no team budget.'>
                <Input id='teBudget' type='number' min={0} step={1} value={edit.budget} onChange={(e) => setEdit({ ...edit, budget: e.target.value })} />
              </FormRow>
              <FormRow label='Simulations running at once, per person' htmlFor='teConc' hint='Empty means the account default.'>
                <Input id='teConc' type='number' min={0} step={1} value={edit.conc} onChange={(e) => setEdit({ ...edit, conc: e.target.value })} />
              </FormRow>
              <DialogFooter><Button type='button' variant='outline' onClick={() => setEdit(null)}>Cancel</Button><Button type='submit'>Save team</Button></DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={del !== null} onOpenChange={(o) => { if (!o) setDel(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Delete team {del?.name}?</DialogTitle><DialogDescription>Its people go back to the shared budget.</DialogDescription></DialogHeader>
          <DialogFooter><Button variant='outline' onClick={() => setDel(null)}>Cancel</Button><Button variant='destructive' onClick={remove}>Delete</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

function People({ d, reload }: { d: Limits; reload: () => void }) {
  const p = d.policy;
  // Per-person settings save as soon as they change (numbers on blur or Enter).
  const put = (uid: string, body: Record<string, unknown>) =>
    appApi('PUT', `/limits/members/${encodeURIComponent(uid)}`, body).then(() => { toast.success('Saved'); reload(); }).catch((e) => { fail(e); reload(); });
  const numField = (m: Member, field: 'adjust_usd' | 'cap_usd' | 'max_concurrent_runs', value: number | null, placeholder: string, min?: number) => (
    <Input key={`${m.user_id}-${field}-${value}`} type='number' step={1} min={min} className='h-8 w-24'
      defaultValue={value == null || (value === 0 && field === 'adjust_usd') ? '' : String(value)} placeholder={placeholder} aria-label={`${field} for ${m.email}`}
      onBlur={(e) => { const v = orNull(e.target.value); if (v !== (field === 'adjust_usd' ? (value || null) : value)) void put(m.user_id, { [field]: v }); }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
  );
  return (
    <Section title='People' description='Changes save as you make them.'>
      <div className='overflow-x-auto'>
        {d.members.length ? (
          <Table className='min-w-[820px]'>
            <TableHeader>
              <TableRow>
                <TableHead>Person</TableHead><TableHead>Team</TableHead><TableHead>Can run</TableHead>
                <TableHead>{p.mode === 'even' ? 'Adjust ±$' : p.mode === 'custom' ? 'Cap $' : 'Cap'}</TableHead>
                <TableHead className='min-w-[170px]'>Allowance</TableHead><TableHead>Runs at once</TableHead><TableHead className='text-right'>Tokens</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.members.map((m) => (
                <TableRow key={m.user_id}>
                  <TableCell>
                    <div className='flex items-center gap-2 font-medium'>{m.name || m.email}{m.role === 'admin' && <Badge variant='outline'>admin</Badge>}</div>
                    {m.name && <div className='text-muted-foreground text-xs'>{m.email}</div>}
                  </TableCell>
                  <TableCell>
                    <NativeSelect size='sm' value={m.team_id ?? ''} aria-label={`Team for ${m.email}`} onChange={(e) => put(m.user_id, { team_id: e.target.value === '' ? null : Number(e.target.value) })}>
                      <NativeSelectOption value=''>No team</NativeSelectOption>
                      {d.teams.map((t) => <NativeSelectOption key={t.id} value={t.id}>{t.name}</NativeSelectOption>)}
                    </NativeSelect>
                  </TableCell>
                  <TableCell><Checkbox checked={m.can_run} aria-label={`Can launch simulations: ${m.email}`} onCheckedChange={(v) => put(m.user_id, { can_run: Boolean(v) })} /></TableCell>
                  <TableCell>
                    {p.mode === 'even' ? numField(m, 'adjust_usd', m.adjust_usd, '0')
                      : p.mode === 'custom' ? numField(m, 'cap_usd', m.cap_usd, p.default_cap_usd == null ? 'no cap' : String(p.default_cap_usd), 0)
                      : <span className='text-muted-foreground text-xs'>shared</span>}
                  </TableCell>
                  <TableCell>{m.allowance_usd == null ? <span className='text-muted-foreground text-xs'>{usd(m.spent)} spent</span> : <SpendMeter spent={m.spent} budget={m.allowance_usd} />}</TableCell>
                  <TableCell>{numField(m, 'max_concurrent_runs', m.max_concurrent_runs, p.max_concurrent_runs == null ? 'any' : String(p.max_concurrent_runs), 0)}</TableCell>
                  <TableCell className='text-right'>
                    <div className='text-muted-foreground text-xs tabular-nums'>{num(Number(m.tokens_in) + Number(m.tokens_out))}</div>
                    {m.running > 0 && <Badge className='mt-1'>{m.running} running</Badge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : <p className='text-muted-foreground text-sm'>No active members.</p>}
      </div>
    </Section>
  );
}
