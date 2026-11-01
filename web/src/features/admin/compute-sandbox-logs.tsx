'use client';

// "Sandbox logs": the last 64 KB of what happened inside a Vercel sandbox (an orchestrator's log and supervisor; a worker
// session's setup log, harness error logs and run files), read on demand through GET /compute/sandbox-logs
// (src/sandbox-diagnostics.ts: fixed read-only scripts, platform admins only, secrets redacted).
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Icons } from '@/components/icons';
import { LongText } from '@/components/layout/detail';
import { useAdmin } from './lib';
import { ErrorBox, Mono } from './ui';

interface SandboxLogs { kind: 'orchestrator' | 'session'; sandbox: string; kb: number; at: string; output: string; exit_code: number | null }

export function SandboxLogsButton({ orchestrator, session, label = 'Sandbox logs' }: { orchestrator?: number; session?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const q = orchestrator != null ? `orchestrator=${orchestrator}` : `session=${encodeURIComponent(session ?? '')}`;
  const { data, error, isFetching, refetch } = useAdmin<SandboxLogs>(open ? `/compute/sandbox-logs?${q}&kb=64` : null);
  return (
    <>
      <Button variant='outline' size='sm' onClick={() => setOpen(true)}><Icons.code /> {label}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className='sm:max-w-4xl'>
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>
              {orchestrator != null ? 'The orchestrator log and supervisor state' : 'The setup log, harness error logs and run files'}, read from inside the
              sandbox just now (last 64 KB, secrets redacted).{data && <> <Mono>{data.sandbox}</Mono></>}
            </DialogDescription>
          </DialogHeader>
          <ErrorBox error={error} />
          {isFetching && !data ? <Skeleton className='h-60 w-full' /> : data && (
            <div className='bg-muted/40 rounded-md border p-3'>
              <LongText mono>{data.output || '(nothing)'}</LongText>
            </div>
          )}
          <div className='flex justify-end'>
            <Button variant='outline' size='sm' disabled={isFetching} onClick={() => void refetch()}>{isFetching ? 'Reading…' : 'Read again'}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
