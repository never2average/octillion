import Link from 'next/link';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Children, isValidElement, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

const textOf = (n: ReactNode): string =>
  Children.toArray(n).map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : isValidElement<{ children?: ReactNode }>(c) ? textOf(c.props.children) : '')).join('');

/** A heading's text as an anchor id, e.g. "Reading the Pick rate page" -> "reading-the-pick-rate-page". */
export function anchorId(node: ReactNode): string {
  return textOf(node).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Every element but links: they don't depend on the page. */
const ELEMENTS: Components = {
  h1: ({ node: _n, children, ...p }) => <h1 className='mt-2 mb-4 text-3xl font-bold tracking-tight' {...p}>{children}</h1>,
  h2: ({ node: _n, children, ...p }) => <h2 id={anchorId(children)} className='mt-10 mb-3 scroll-mt-20 border-b pb-2 text-xl font-semibold tracking-tight first:mt-0' {...p}>{children}</h2>,
  h3: ({ node: _n, children, ...p }) => <h3 id={anchorId(children)} className='mt-8 mb-2 scroll-mt-20 text-lg font-semibold tracking-tight' {...p}>{children}</h3>,
  h4: ({ node: _n, children, ...p }) => <h4 className='mt-6 mb-2 text-base font-semibold' {...p}>{children}</h4>,
  p: ({ node: _n, ...p }) => <p className='my-3 leading-7' {...p} />,
  ul: ({ node: _n, ...p }) => <ul className='my-3 ml-6 list-disc space-y-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5' {...p} />,
  ol: ({ node: _n, ...p }) => <ol className='my-3 ml-6 list-decimal space-y-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5' {...p} />,
  li: ({ node: _n, ...p }) => <li className='leading-7 [&>p]:my-1' {...p} />,
  blockquote: ({ node: _n, ...p }) => <blockquote className='text-muted-foreground my-4 border-l-2 pl-4 italic' {...p} />,
  hr: () => <hr className='my-8' />,
  strong: ({ node: _n, ...p }) => <strong className='font-semibold' {...p} />,
  pre: ({ node: _n, ...p }) => <pre className='bg-muted/50 my-4 overflow-x-auto rounded-lg border p-3 font-mono text-xs leading-relaxed [&_code]:bg-transparent [&_code]:p-0' {...p} />,
  code: ({ node: _n, className: c, ...p }) => <code className={cn('bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]', c)} {...p} />,
  table: ({ node: _n, ...p }) => <div className='my-4 w-full overflow-x-auto rounded-lg border'><table className='w-full text-sm' {...p} /></div>,
  thead: ({ node: _n, ...p }) => <thead className='bg-muted/50' {...p} />,
  tr: ({ node: _n, ...p }) => <tr className='border-b last:border-0' {...p} />,
  th: ({ node: _n, ...p }) => <th className='px-3 py-2 text-left align-bottom font-medium' {...p} />,
  td: ({ node: _n, ...p }) => <td className='px-3 py-2 align-top' {...p} />
};

/**
 * Markdown as a readable page, styled with the app's own tokens (no typography plugin). Raw HTML in the source shows
 * as text. `resolveHref` maps a link to an in-app URL; returning null renders the link's text only (a repo path that
 * does not exist in the app).
 */
export function Markdown({ children, resolveHref, className }: { children: string; resolveHref?: (href: string) => string | null; className?: string }) {
  const components: Components = {
    ...ELEMENTS,
    a: ({ node: _n, href = '', children: c, ...p }) => {
      const external = /^[a-z][a-z0-9+.-]*:/i.test(href);
      if (external) return <a href={href} target='_blank' rel='noopener noreferrer' className='text-primary underline underline-offset-4' {...p}>{c}</a>;
      if (href.startsWith('#')) return <a href={href} className='text-primary underline underline-offset-4' {...p}>{c}</a>;
      const to = resolveHref ? resolveHref(href) : href;
      return to ? <Link href={to} className='text-primary underline underline-offset-4'>{c}</Link> : <span className='font-medium'>{c}</span>;
    }
  };
  return (
    <div className={cn('text-foreground max-w-3xl text-[15px]', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{children}</ReactMarkdown>
    </div>
  );
}
