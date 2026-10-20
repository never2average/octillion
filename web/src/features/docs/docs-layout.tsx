// The docs frame shared by /app/docs and /admin/docs, inside the app shell (its sidebar and header stay): a sticky
// navigation tree on the left (a drawer button below lg), the article at a reading width in the middle, "On this page"
// on the right from xl up, and previous / next cards under the article. A server component: the article is rendered
// here, and only titles, hrefs and headings go to the client parts (docs-nav.tsx, docs-toc.tsx).
import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { neighbours, type DocCrumb, type DocHeading, type DocNavGroup } from './docs-data';
import { DocsMobileNav, DocsSidebar } from './docs-nav';
import { DocsToc } from './docs-toc';

/** The columns stick under the app header (h-16, h-14 from md) and scroll on their own. */
const STICKY = 'sticky top-14 h-[calc(100svh-3.5rem)] self-start overflow-y-auto overscroll-contain';

export function DocsLayout({ nav, href, crumbs, title, description, headings = [], meta, children }: {
  nav: DocNavGroup[];
  /** This page's href in `nav`: highlighted there, and where previous / next count from. */
  href: string;
  crumbs: DocCrumb[];
  title: string;
  description?: ReactNode;
  /** The article's h2/h3, for "On this page". */
  headings?: DocHeading[];
  /** Real facts about the page (its source file, …), shown under the article. */
  meta?: ReactNode;
  children: ReactNode;
}) {
  const { prev, next } = neighbours(nav, href);
  return (
    <div className='flex w-full min-w-0 flex-1 gap-8 px-4 md:px-6 xl:gap-10'>
      <aside className={`${STICKY} hidden w-60 shrink-0 border-r py-6 pr-4 lg:block`}>
        <DocsSidebar groups={nav} />
      </aside>

      <div className='min-w-0 flex-1 pt-3 pb-16 lg:pt-8'>
        <div className='mb-6 lg:hidden'><DocsMobileNav groups={nav} current={title} /></div>
        <article className='mx-auto w-full max-w-[720px]'>
          <nav aria-label='Breadcrumb' className='mb-3'>
            <ol className='text-muted-foreground flex flex-wrap items-center gap-1 text-sm'>
              {crumbs.map((c, i) => (
                <Fragment key={`${c.title}-${i}`}>
                  {i > 0 && <li aria-hidden><IconChevronRight className='size-3.5 opacity-60' /></li>}
                  <li className={i === crumbs.length - 1 ? 'text-foreground font-medium' : undefined}>
                    {c.href && i < crumbs.length - 1 ? <Link href={c.href} className='hover:text-foreground transition-colors'>{c.title}</Link> : c.title}
                  </li>
                </Fragment>
              ))}
            </ol>
          </nav>
          <header className='mb-8 border-b pb-6'>
            <h1 className='text-3xl font-bold tracking-tight text-balance sm:text-4xl'>{title}</h1>
            {description && <div className='text-muted-foreground mt-3 text-lg leading-relaxed text-pretty'>{description}</div>}
          </header>

          {children}

          {meta && <div className='text-muted-foreground mt-12 flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-4 text-xs'>{meta}</div>}

          {(prev || next) && (
            <nav aria-label='Previous and next page' className='mt-10 grid gap-3 sm:grid-cols-2'>
              {prev ? (
                <Link href={prev.href} className='group hover:border-primary/50 hover:bg-muted/40 flex flex-col gap-1 rounded-xl border p-4 transition-colors'>
                  <span className='text-muted-foreground inline-flex items-center gap-1 text-xs'><IconChevronLeft className='size-3.5' /> Previous</span>
                  <span className='group-hover:text-primary font-medium transition-colors'>{prev.title}</span>
                  <span className='text-muted-foreground text-xs'>{prev.group}</span>
                </Link>
              ) : <span className='hidden sm:block' />}
              {next && (
                <Link href={next.href} className='group hover:border-primary/50 hover:bg-muted/40 flex flex-col items-end gap-1 rounded-xl border p-4 text-right transition-colors'>
                  <span className='text-muted-foreground inline-flex items-center gap-1 text-xs'>Next <IconChevronRight className='size-3.5' /></span>
                  <span className='group-hover:text-primary font-medium transition-colors'>{next.title}</span>
                  <span className='text-muted-foreground text-xs'>{next.group}</span>
                </Link>
              )}
            </nav>
          )}
        </article>
      </div>

      <aside className={`${STICKY} hidden w-52 shrink-0 py-8 xl:block`}>
        <DocsToc headings={headings} />
      </aside>
    </div>
  );
}
