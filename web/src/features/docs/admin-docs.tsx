// /admin/docs: the internal docs (../docs/**/*.md), bundled at build time by scripts/sync-docs.mjs into
// src/content/admin-docs.generated.ts. Server components only: the markdown never ships to the browser as data (the
// navigation's client part gets titles and headings).
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Markdown } from '@/components/markdown';
import { Icons } from '@/components/icons';
import { ADMIN_DOCS, type AdminDoc } from '@/content/admin-docs.generated';
import { DocsLayout } from './docs-layout';
import { markdownHeadings, slugify, splitLead, type DocNavGroup } from './docs-data';

/**
 * The left navigation's groups. A doc in a folder (docs/case-studies/…) takes its group from the folder; a top-level doc
 * is a spec (…-spec.md), a guide (a guide or walkthrough) or architecture.
 */
const GROUP_ORDER = ['Guides', 'Architecture', 'Specs', 'Case studies'];
const titleCase = (s: string) => s.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
const groupOf = (d: AdminDoc) =>
  d.group ? titleCase(d.group) : d.slug.endsWith('-spec') ? 'Specs' : /guide|walkthrough/.test(d.slug) ? 'Guides' : 'Architecture';

const HOME = '/admin/docs';
const href = (d: AdminDoc) => `${HOME}/${d.slug}`;
/** A doc's markdown without its leading `# Title` (the layout shows the title). */
const bodyOf = (d: AdminDoc) => d.body.replace(/^\s*#\s+.+\n/, '');

/** Titles, hrefs and headings only: this is what goes to the browser for the navigation and its filter. */
function nav(): DocNavGroup[] {
  const groups = [...new Set([...GROUP_ORDER, ...ADMIN_DOCS.map(groupOf)])];
  return [
    { title: 'Overview', pages: [{ title: 'All docs', href: HOME, headings: [] }] },
    ...groups.map((g) => ({
      title: g,
      pages: ADMIN_DOCS.filter((d) => groupOf(d) === g).map((d) => ({ title: d.title, href: href(d), headings: markdownHeadings(bodyOf(d)) }))
    })).filter((g) => g.pages.length)
  ];
}

/** The same, for the Cmd+K bar's Docs section: passed down from the admin layout, so it reaches admins only. */
export const adminDocsNav = () => nav();

export const findAdminDoc = (slug: string): AdminDoc | undefined => ADMIN_DOCS.find((d) => d.slug === slug);

/** A relative link between docs (e.g. `journeys.md`, `../beta-guide.md`) opens that doc here; other repo paths render as text. */
function resolver(doc: AdminDoc) {
  return (href: string): string | null => {
    const [file, hash] = href.split('#');
    if (!file) return hash ? `#${hash}` : null;
    const parts = doc.path.split('/').slice(0, -1);
    for (const seg of file.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg && seg !== '.') parts.push(seg);
    }
    const target = ADMIN_DOCS.find((d) => d.path === parts.join('/'));
    return target ? `/admin/docs/${target.slug}${hash ? `#${hash}` : ''}` : null;
  };
}

export function AdminDocsIndex() {
  const groups = nav().slice(1);
  return (
    <DocsLayout nav={nav()} title='Internal docs'
      description='Internal Octillion documentation: how accounts, budgets, compute, credentials and storage work, plus specs and case studies.'
      headings={groups.map((g) => ({ id: slugify(g.title), text: g.title, depth: 2 as const }))}
      meta={<span>{ADMIN_DOCS.length} docs, from <code className='font-mono'>docs/</code> in the repository.</span>}>
      <div className='flex flex-col gap-10'>
        {groups.map((g) => (
          <section key={g.title} aria-labelledby={slugify(g.title)} className='flex flex-col gap-3'>
            <h2 id={slugify(g.title)} className='scroll-mt-24 text-xl font-semibold tracking-tight'>{g.title}</h2>
            <ul className='grid gap-3 sm:grid-cols-2'>
              {ADMIN_DOCS.filter((d) => groupOf(d) === g.title).map((d) => (
                <li key={d.slug} className='flex'>
                  <Link href={href(d)} className='group hover:border-primary/50 hover:bg-muted/40 flex w-full flex-col gap-2 rounded-xl border p-4 transition-colors'>
                    <span className='flex items-start gap-2'>
                      <Icons.page className='text-muted-foreground group-hover:text-primary mt-0.5 size-4 shrink-0 transition-colors' />
                      <span className='group-hover:text-primary font-medium leading-snug transition-colors'>{d.title}</span>
                    </span>
                    {d.summary && <span className='text-muted-foreground line-clamp-3 text-sm leading-relaxed'>{d.summary}</span>}
                    <code className='text-muted-foreground mt-auto pt-1 font-mono text-[11px]'>docs/{d.path}</code>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </DocsLayout>
  );
}

export function AdminDocPage({ slug }: { slug: string }) {
  const doc = findAdminDoc(slug);
  if (!doc) notFound();
  const { lead, rest } = splitLead(bodyOf(doc));
  const resolve = resolver(doc);
  return (
    <DocsLayout nav={nav()} title={doc.title} headings={markdownHeadings(rest)}
      description={lead ? <Markdown resolveHref={resolve} className='text-muted-foreground max-w-none text-lg [&_p]:my-0 [&_p]:leading-relaxed'>{lead}</Markdown> : undefined}
      meta={<span>Source: <code className='font-mono'>docs/{doc.path}</code></span>}>
      <Markdown resolveHref={resolve} className='max-w-none'>{rest}</Markdown>
    </DocsLayout>
  );
}
