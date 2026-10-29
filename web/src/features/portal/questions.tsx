'use client';
// Questions research asks about the account's products (GET /api/app/questions, src/questions.ts): today, whether a
// tool competes with the product or is used with it, when the architecture review could not tell. Until answered the
// tool is left out of scoring; an answer updates the product and rescores its sessions. Shown above Pick rate.
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { appApi } from '@/lib/api-client';
import { fail, useOrgLoad } from './shared';

interface Question { id: string; product: string; subject: string; question: string; options: { id: string; label: string; relation?: string; value?: Record<string, unknown> }[];
  context: { reason?: string; note?: string } | null }

export function ProductQuestions({ onAnswered }: { onAnswered?: () => void }) {
  const { data, reload } = useOrgLoad(() => appApi<{ questions: Question[]; can_answer: boolean }>('GET', '/questions'), []);
  const [busy, setBusy] = useState<string | null>(null);
  if (!data?.questions.length) return null;
  const answer = async (q: Question, option: string) => {
    setBusy(q.id);
    try {
      const r = await appApi<{ effect: string }>('POST', `/questions/${q.id}/answer`, { option });
      toast.success(`${r.effect}. Past sessions are being scored again.`);
      await reload();
      onAnswered?.();
    } catch (e) { fail(e); } finally { setBusy(null); }
  };
  return (
    <section aria-label='Questions about your product' className='mb-4 flex flex-col gap-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4'>
      <div>
        <h2 className='text-sm font-semibold'>{data.questions.length === 1 ? 'One question about your product' : `${data.questions.length} questions about your product`}</h2>
        <p className='text-muted-foreground text-xs'>Research couldn’t settle these on its own. Until you answer, a tool in question is left out of your pick rate, and a question about who can use the product holds back its personas.</p>
      </div>
      <ul className='flex flex-col gap-4'>
        {data.questions.map((q) => (
          <li key={q.id} className='flex flex-col gap-2'>
            <p className='text-sm font-medium'>{q.question} <span className='text-muted-foreground font-normal'>({q.product})</span></p>
            {(q.context?.reason || q.context?.note) && <p className='text-muted-foreground text-xs'>What research found: {q.context.reason ?? q.context.note}</p>}
            <div className='flex flex-wrap gap-2'>
              {q.options.map((o) => (
                <Button key={o.id} size='sm' variant='outline' className='h-auto max-w-full py-1.5 text-left whitespace-normal' disabled={!data.can_answer || busy !== null}
                  onClick={() => answer(q, o.id)}>{o.label}</Button>
              ))}
            </div>
            {!data.can_answer && <p className='text-muted-foreground text-xs'>An editor of this account can answer.</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
