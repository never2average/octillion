'use client';
// "Ask AI" in the Cmd+K bar: with a question of a few words typed, the first result asks the API for a short answer
// from the docs (src/docs-answers.ts: the customer guide in /app, the internal docs too in /admin). The answer opens in
// a dialog: markdown with numbered citations that open the cited sections, the sources under it, and what to do when
// there is no AI summary (a limit, or no model answered): the matching sections still show.
import { useQuery } from '@tanstack/react-query';
import { useKBar, useRegisterActions } from 'kbar';
import Link from 'next/link';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { IconSparkles } from '@tabler/icons-react';
import { useNav } from '@/components/layout/nav-context';
import { Markdown } from '@/components/markdown';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { adminApi, appApi } from '@/lib/api-client';

interface DocsSource { n: number; title: string; heading: string | null; href: string }
interface DocsAnswer {
  answer: string | null; covered: boolean | null; sources: DocsSource[]; model: string | null;
  reason: 'no_match' | 'daily_cap' | 'rate_limited' | 'unavailable' | null;
}

/** A question worth asking: two words or more (or one ending in "?"), at least 6 characters. */
const askable = (q: string) => q.trim().length >= 6 && (q.trim().split(/\s+/).length >= 2 || q.trim().endsWith('?'));

const AskCtx = createContext<(question: string) => void>(() => {});
export const useAskAi = () => useContext(AskCtx);

/** Holds the dialog; children (the Cmd+K bar) open it with useAskAi(). */
export function AskAiProvider({ children }: { children: ReactNode }) {
  const [question, setQuestion] = useState<string | null>(null);
  return (
    <AskCtx.Provider value={setQuestion}>
      {children}
      <AskAiDialog question={question} onQuestion={setQuestion} />
    </AskCtx.Provider>
  );
}

/** Registers the "Ask AI: <query>" action for whatever is typed, above every other section. */
export function AskAiAction() {
  const { search } = useKBar((s) => ({ search: s.searchQuery }));
  const ask = useAskAi();
  const q = search.trim();
  const actions = useMemo(() => (askable(q) ? [{
    id: 'ask-ai', name: `Ask AI: ${q}`, keywords: q, priority: 10,
    section: { name: 'Ask AI', priority: 10 }, subtitle: 'A short answer from the docs, with its sources',
    icon: <IconSparkles className='text-primary size-4' />, perform: () => ask(q)
  }] : []), [q, ask]);
  useRegisterActions(actions, [actions]);
  return null;
}

const UNAVAILABLE: Record<Exclude<DocsAnswer['reason'], null | 'no_match'>, string> = {
  unavailable: 'AI summary unavailable. These are the sections that match best.',
  daily_cap: "AI summary unavailable: today's limit for AI answers is reached. These are the sections that match best.",
  rate_limited: 'AI summary unavailable: that was a lot of questions in a minute, try again shortly. These are the sections that match best.'
};

/** The answer's [n] citations as links to the cited sections. */
const linked = (md: string, sources: DocsSource[]) =>
  md.replace(/\[(\d{1,2})\](?!\()/g, (m, n) => {
    const s = sources.find((x) => x.n === Number(n));
    return s ? `[\\[${n}\\]](${s.href})` : m;
  });

function AskAiDialog({ question, onQuestion }: { question: string | null; onQuestion: (q: string | null) => void }) {
  const { area } = useNav();
  const q = question ?? '';
  // Asking the same question again reads the cached answer: no second model call.
  const { data, error, isFetching } = useQuery({
    queryKey: ['docs-answer', area, q],
    queryFn: () => (area === 'admin' ? adminApi<DocsAnswer>('POST', '/docs/answer', { question: q }) : appApi<DocsAnswer>('POST', '/docs/answer', { question: q })),
    enabled: !!question, staleTime: Infinity, gcTime: 30 * 60_000, retry: false
  });
  const close = () => onQuestion(null);
  // A link in the answer or the sources opens the page: the dialog goes away.
  const onLinkClick = (e: React.MouseEvent) => { if ((e.target as HTMLElement).closest('a')) close(); };

  return (
    <Dialog open={!!question} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className='max-h-[85svh] gap-0 overflow-y-auto p-0 sm:max-w-xl'>
        <DialogHeader className='border-b p-4 pr-12'>
          <DialogTitle className='flex items-center gap-2'><IconSparkles className='text-primary size-4' /> Ask AI</DialogTitle>
          <DialogDescription>An answer from the {area === 'admin' ? 'internal and customer docs' : 'docs'}, with its sources.</DialogDescription>
          <form className='mt-2' onSubmit={(e) => {
            e.preventDefault();
            const next = String(new FormData(e.currentTarget).get('question') ?? '').trim();
            if (next.length >= 3) onQuestion(next);
          }}>
            <Input key={q} name='question' defaultValue={q} aria-label='Your question' maxLength={400} placeholder='Ask a question about Octillion' />
          </form>
        </DialogHeader>

        <div className='flex flex-col gap-4 p-4' onClick={onLinkClick}>
          {isFetching ? (
            <div className='text-muted-foreground flex items-center gap-2 py-6 text-sm' role='status'><Spinner className='size-4' /> Reading the docs…</div>
          ) : error ? (
            <p className='text-destructive text-sm'>{(error as Error).message}</p>
          ) : data ? (
            <>
              {data.answer ? (
                <div className='flex flex-col gap-2'>
                  <Markdown className='max-w-none text-sm [&_a]:no-underline [&_p]:my-2 [&_p]:leading-6 [&_ul]:my-2'>{linked(data.answer, data.sources)}</Markdown>
                  <p className='text-muted-foreground text-xs'>AI summary from the docs — may be imperfect{data.model ? ` (${data.model})` : ''}.</p>
                </div>
              ) : data.reason === 'no_match' ? (
                <p className='text-muted-foreground text-sm'>Nothing in the docs matches this question. Try other words, or browse the Docs section of the search bar.</p>
              ) : (
                <p className='text-muted-foreground text-sm'>{UNAVAILABLE[data.reason ?? 'unavailable']}</p>
              )}
              {data.sources.length > 0 && (
                <div className='flex flex-col gap-2 border-t pt-3'>
                  <span className='text-muted-foreground text-xs font-medium tracking-wider uppercase'>Sources</span>
                  <ol className='flex flex-col gap-1'>
                    {data.sources.map((s) => (
                      <li key={s.n} className='flex gap-2 text-sm'>
                        <span className='text-muted-foreground w-5 shrink-0 text-right tabular-nums'>{s.n}.</span>
                        <Link href={s.href} className='hover:text-primary min-w-0 transition-colors'>
                          {s.title}{s.heading && <span className='text-muted-foreground'> › {s.heading}</span>}
                        </Link>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
