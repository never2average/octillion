// /admin/docs: the internal docs (../docs/**/*.md), bundled at build time by scripts/sync-docs.mjs into
// src/content/admin-docs.generated.ts. Server components only: the markdown never ships to the browser as data.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import PageContainer from '@/components/layout/page-container';
import { Markdown } from '@/components/markdown';
import { Icons } from '@/components/icons';
import { ADMIN_DOCS, type AdminDoc } from '@/content/admin-docs.generated';

const GROUPS: { id: string; label: string }[] = [
  { id: '', label: 'Guides and specs' },
  { id: 'case-studies', label: 'Case studies' }
];

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
  return (
    <PageContainer pageTitle='Docs' pageDescription='Internal Octillion documentation: how accounts, budgets, compute, credentials and storage work, plus case studies.'>
      <div className='flex max-w-4xl flex-col gap-8'>
        {GROUPS.map((g) => {
          const docs = ADMIN_DOCS.filter((d) => d.group === g.id);
          if (!docs.length) return null;
          return (
            <section key={g.id || 'docs'} className='flex flex-col gap-3'>
              <h2 className='text-muted-foreground text-xs font-medium tracking-wide uppercase'>{g.label}</h2>
              <ul className='divide-y rounded-xl border'>
                {docs.map((d) => (
                  <li key={d.slug}>
                    <Link href={`/admin/docs/${d.slug}`} className='hover:bg-muted/50 flex items-start gap-3 px-4 py-3 transition-colors'>
                      <Icons.page className='text-muted-foreground mt-0.5 size-4 shrink-0' />
                      <span className='min-w-0 flex-1'>
                        <span className='block font-medium'>{d.title}</span>
                        {d.summary && <span className='text-muted-foreground line-clamp-2 block text-sm'>{d.summary}</span>}
                      </span>
                      <code className='text-muted-foreground hidden shrink-0 font-mono text-xs sm:block'>docs/{d.path}</code>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </PageContainer>
  );
}

export function AdminDocPage({ slug }: { slug: string }) {
  const doc = findAdminDoc(slug);
  if (!doc) notFound();
  return (
    <PageContainer>
      <div className='flex flex-col gap-4'>
        <div className='text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-sm'>
          <Link href='/admin/docs' className='hover:text-foreground inline-flex items-center gap-1'><Icons.chevronLeft className='size-4' /> All docs</Link>
          <code className='font-mono text-xs'>docs/{doc.path}</code>
        </div>
        <Markdown resolveHref={resolver(doc)}>{doc.body}</Markdown>
      </div>
    </PageContainer>
  );
}
