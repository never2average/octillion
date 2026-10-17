'use client';
import { useState } from 'react';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';

export function CopyField({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  const copy = () => navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); });
  return (
    <div className='bg-muted flex items-center gap-2 rounded-lg border p-1.5 pl-3'>
      <code className='min-w-0 flex-1 truncate font-mono text-sm'>{value}</code>
      <Button type='button' size='sm' variant='outline' onClick={copy} aria-label='Copy connector URL'>
        {done ? <IconCheck /> : <IconCopy />} {done ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}
