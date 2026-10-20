// Shapes and helpers shared by the docs layout (server) and its navigation / table of contents (client). Only these
// small structures (titles, hrefs, headings) ever reach the browser as props; a page's markdown body never does.

/** A heading of a page: its anchor id (as components/markdown.tsx renders it), text and level (2 or 3). */
export interface DocHeading { id: string; text: string; depth: 2 | 3 }
export interface DocNavPage { title: string; href: string; headings: DocHeading[] }
export interface DocNavGroup { title: string; pages: DocNavPage[] }
export interface DocCrumb { title: string; href?: string }

/** The same id components/markdown.tsx gives a heading, from its plain text. */
export const slugify = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** A heading's markdown as the text it renders to: links, emphasis, code ticks and escapes dropped. */
export const plainHeading = (md: string) =>
  md.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1').replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(^|\W)[*_](.+?)[*_](?=\W|$)/g, '$1$2').trim();

/** The h2/h3 headings of a markdown page, skipping fenced code. */
export function markdownHeadings(md: string): DocHeading[] {
  const out: DocHeading[] = [];
  let fence = '';
  for (const line of md.split('\n')) {
    const f = line.match(/^\s*(```|~~~)/);
    if (f) { fence = fence ? (fence === f[1] ? '' : fence) : f[1]; continue; }
    if (fence) continue;
    const m = line.match(/^(##|###)\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    const text = plainHeading(m[2]);
    out.push({ id: slugify(text), text, depth: m[1].length as 2 | 3 });
  }
  return out;
}

/** The pages in navigation order, with the one before and after `href`. */
export function neighbours(groups: DocNavGroup[], href: string) {
  const pages = groups.flatMap((g) => g.pages.map((p) => ({ ...p, group: g.title })));
  const i = pages.findIndex((p) => p.href === href);
  return { prev: i > 0 ? pages[i - 1] : undefined, next: i >= 0 && i < pages.length - 1 ? pages[i + 1] : undefined };
}

/**
 * A page's opening paragraph, to show under its title as the summary, and the rest of the body. A paragraph that
 * introduces what follows (ends in ":") stays in the body, as does anything that is not plain prose.
 */
export function splitLead(md: string): { lead: string; rest: string } {
  const body = md.replace(/^\s+/, '');
  const end = body.search(/\n\s*\n/);
  const first = (end < 0 ? body : body.slice(0, end)).trim();
  const rest = end < 0 ? '' : body.slice(end);
  // A page that is one paragraph keeps it as its body.
  if (!first || !rest.trim() || /^([#>|`~<-]|\d+\.\s|[*+]\s|!\[)/.test(first) || first.endsWith(':')) return { lead: '', rest: md };
  return { lead: first, rest };
}
