'use client';
// GTM › CSV import (Prospects and Companies): a file, each field mapped to one of its columns (guessed from the header
// names, so a file exported from here maps itself), a dry run that says what would happen to every row, then the real
// import. The server (src/gtm-crm.ts) decides everything: dedupe, the lawful basis, the suppression list. The real
// import sends the rows the preview would write, CHUNK at a time (each one transaction on the server), with progress;
// a failure stops it and says which rows went in.
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Icons } from '@/components/icons';
import { parseCsv } from '@/lib/csv';
import { DataList, Notice, Section, StatusBadge } from './ui';
import { Gate } from './role';

export interface ImportField { key: string; label: string; aliases?: string[]; required?: boolean }
export interface ImportRow { row: number; action: 'create' | 'update' | 'skip' | 'refuse'; reason: string | null; email?: string | null; name?: string | null; company?: string | null; domain?: string | null; suppressed?: boolean; applied?: boolean }
export interface ImportResult { dry_run: boolean; summary: Record<string, number>; rows: ImportRow[]; error?: string | null; applied?: number[] }
const CHUNK = 200;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const TONE = { create: 'ok', update: 'info', skip: 'neutral', refuse: 'bad' } as const;

/** Guess each field's column: its key, its label, or an alias, compared without case, spaces or punctuation. */
function guess(fields: ImportField[], headers: string[]) {
  const by = new Map(headers.map((h, i) => [norm(h), i]));
  return Object.fromEntries(fields.map((f) => {
    const hit = [f.key, f.label, ...(f.aliases ?? [])].map(norm).find((k) => by.has(k));
    return [f.key, hit != null ? by.get(hit)! : -1];
  })) as Record<string, number>;
}

export function CsvImport({ fields, noun, settings, run, onDone, onBack, ready = true }: {
  fields: ImportField[]; noun: string;
  /** Import-wide choices (the lawful basis, tags): shown above the preview. */
  settings?: ReactNode;
  run: (rows: Record<string, string>[], dryRun: boolean) => Promise<ImportResult>;
  onDone: (r: ImportResult) => void; onBack: () => void;
  /** False while a required import-wide choice is missing. */
  ready?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; headers: string[]; body: string[][] } | null>(null);
  const [map, setMap] = useState<Record<string, number>>({});
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const rows = useMemo(() => (file ? file.body.map((r) => Object.fromEntries(fields.flatMap((f) => (map[f.key] >= 0 && r[map[f.key]] != null && r[map[f.key]].trim() ? [[f.key, r[map[f.key]].trim()]] : [])))) : []), [file, map, fields]);
  const load = async (f: File) => {
    const all = parseCsv((await f.text()).replace(/^﻿/, ''));
    if (!all.length) { setError('The file is empty'); return; }
    const [headers, ...body] = all;
    setFile({ name: f.name, headers, body }); setMap(guess(fields, headers)); setResult(null); setError(null);
  };
  const go = async (dry: boolean) => {
    setBusy(true); setError(null);
    try {
      if (dry) { setResult(await run(rows, true)); return; }
      // Only the rows the preview would write, in chunks; each answer's rows numbered back to the file's.
      const todo = (result?.rows ?? []).filter((r) => r.action === 'create' || r.action === 'update').map((r) => r.row);
      const out: ImportRow[] = (result?.rows ?? []).filter((r) => r.action === 'skip' || r.action === 'refuse');
      const sum: Record<string, number> = { rows: rows.length, create: 0, update: 0, skip: out.filter((r) => r.action === 'skip').length, refuse: out.filter((r) => r.action === 'refuse').length };
      let failed: string | null = null;
      setProgress({ done: 0, total: todo.length });
      for (let k = 0; k < todo.length && !failed; k += CHUNK) {
        const nums = todo.slice(k, k + CHUNK);
        try {
          const r = await run(nums.map((n) => rows[n - 1]), false);
          for (const x of r.rows) out.push({ ...x, row: nums[x.row - 1] });
          sum.create += r.rows.filter((x) => x.action === 'create' && x.applied).length;
          sum.update += r.rows.filter((x) => x.action === 'update' && x.applied).length;
          if (r.error) failed = r.error.replace(/Rows (\d+) to (\d+)/, (_m, a, b) => `Rows ${nums[Number(a) - 1]} to ${nums[Number(b) - 1]}`);
        } catch (e) { failed = `Rows ${nums[0]} to ${nums[nums.length - 1]} were not imported: ${(e as Error).message}`; }
        setProgress({ done: Math.min(k + CHUNK, todo.length), total: todo.length });
      }
      const applied = out.filter((r) => r.applied).map((r) => r.row).sort((a, b) => a - b);
      const done: ImportResult = { dry_run: false, summary: sum, rows: out.sort((a, b) => a.row - b.row), error: failed, applied };
      setResult(done);
      if (failed) setError(`${failed}. ${applied.length} rows went in (marked applied below); run the preview again for the rest.`);
      onDone(done);
    }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); setProgress(null); }
  };
  const missing = fields.filter((f) => f.required && !(map[f.key] >= 0));
  const s = result?.summary;
  return (
    <div className='flex flex-col gap-6'>
      <div className='flex flex-wrap items-center gap-2'>
        <Button variant='outline' onClick={onBack}><Icons.chevronLeft /> Back to {noun}</Button>
        <input ref={fileRef} type='file' accept='.csv,text/csv' className='hidden' onChange={(e) => { const f = e.target.files?.[0]; if (f) void load(f); e.target.value = ''; }} />
        <Button onClick={() => fileRef.current?.click()}><Icons.upload /> {file ? 'Choose another file' : 'Choose a CSV file'}</Button>
        {file && <span className='text-muted-foreground text-sm'>{file.name}: {file.body.length} rows, {file.headers.length} columns</span>}
      </div>
      {error && <Notice>{error}</Notice>}
      {file && (
        <Section title='Columns' description='Which column holds each field. Guessed from the header names; fields left on "Not in the file" are empty.'>
          <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-3'>
            {fields.map((f) => (
              <label key={f.key} className='grid gap-1.5 text-sm'>
                <span className='leading-none font-medium'>{f.label}{f.required ? ' (required)' : ''}</span>
                <NativeSelect className='w-full' value={String(map[f.key] ?? -1)} onChange={(e) => { setMap((m) => ({ ...m, [f.key]: Number(e.target.value) })); setResult(null); }}>
                  <NativeSelectOption value='-1'>Not in the file</NativeSelectOption>
                  {file.headers.map((h, i) => <NativeSelectOption key={i} value={String(i)}>{h || `Column ${i + 1}`}</NativeSelectOption>)}
                </NativeSelect>
              </label>
            ))}
          </div>
        </Section>
      )}
      {file && settings}
      {file && (
        <div className='flex flex-wrap items-center gap-2'>
          <Button variant='outline' disabled={busy || !rows.length || !ready || missing.length > 0} onClick={() => void go(true)}><Icons.eye /> Preview (dry run)</Button>
          <Gate need='campaigns'>
            <Button disabled={busy || !result?.dry_run || !ready || !((s?.create ?? 0) + (s?.update ?? 0))} onClick={() => void go(false)}>
              <Icons.check /> Import {result?.dry_run ? (s?.create ?? 0) + (s?.update ?? 0) : ''} {noun}
            </Button>
          </Gate>
          {progress && <span className='text-muted-foreground text-sm tabular-nums' role='status'>Importing… {progress.done} of {progress.total} rows</span>}
          {missing.length > 0 && <span className='text-destructive text-sm'>Map {missing.map((f) => f.label).join(', ')} first.</span>}
          {!result && rows.length > 0 && <span className='text-muted-foreground text-sm'>Preview first: nothing is written until you import.</span>}
        </div>
      )}
      {result && s && (
        <Section title={result.dry_run ? 'Preview: nothing written yet' : 'Imported'}
          description={`${s.rows} rows: ${s.create} new, ${s.update} already there (filled in), ${s.skip} duplicates skipped, ${s.refuse} refused${s.suppressed ? ` (${s.suppressed} on the suppression list)` : ''}${s.companies_new != null ? `; ${s.companies_new} new companies` : ''}.`}>
          <div className='border'>
            <DataList<ImportRow> noun='rows' minWidth={720} height='h-[28rem]' rows={result.rows} empty='No rows.'
              cols={[
                { label: 'Row', className: 'w-14', render: (r) => <span className='tabular-nums'>{r.row}</span> },
                { label: 'What happens', render: (r) => <span className='flex items-center gap-1'><StatusBadge tone={TONE[r.action]}>{r.action}</StatusBadge>{r.applied && <StatusBadge tone='ok'>applied</StatusBadge>}</span> },
                { label: 'Who', render: (r) => <span className='flex flex-col gap-0.5'><span>{r.name ?? r.company ?? r.domain ?? '—'}</span>{r.email && <span className='text-muted-foreground text-xs'>{r.email}</span>}</span> },
                { label: 'Company', render: (r) => <span className='text-sm'>{r.company ?? r.domain ?? '—'}</span> },
                { label: 'Why', render: (r) => <span className='text-muted-foreground text-sm'>{r.reason ?? '—'}{r.suppressed ? ' · suppressed' : ''}</span> }
              ]} />
          </div>
        </Section>
      )}
    </div>
  );
}
