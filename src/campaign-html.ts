/**
 * HTML campaign emails (a step with format "html", src/campaigns.ts): the admin's HTML through an allowlist sanitizer
 * (sanitize-html), on save and again at render, then a plain-text part generated from it.
 *
 *   allowed     layout and text tags only (tables, div / span / p, headings, lists, links, images, font, center);
 *               a small attribute list; inline styles only (no <style> blocks, no scripts, iframes, forms or inputs,
 *               no event handlers). Links: https and mailto only; images: https only (no data: URLs). CSS: no
 *               expression(), behavior, -moz-binding, @import, escapes, or url() other than https.
 *   variables   put in HTML-escaped BEFORE sanitizing (so a value can never become markup), with a zero-width
 *               non-joiner after each dot so a mail client does not auto-link a value that reads like a domain.
 *   size        at most HTML_MAX_BYTES (100 KB) of HTML, refused, never truncated.
 */
import sanitizeHtml from "sanitize-html";

export const HTML_MAX_BYTES = 100_000;

const TAGS = ["table", "tr", "td", "th", "tbody", "thead", "div", "span", "p", "br", "hr", "h1", "h2", "h3", "h4", "strong", "em", "b", "i", "u",
  "ul", "ol", "li", "a", "img", "blockquote", "center", "font"];
const COMMON = ["style", "align", "valign", "bgcolor", "width", "height", "border", "role"];
const ATTRS: Record<string, string[]> = {
  "*": COMMON,
  a: [...COMMON, "href", "target", "rel"],
  img: [...COMMON, "src", "alt"],
  table: [...COMMON, "cellpadding", "cellspacing"],
  td: [...COMMON, "colspan", "rowspan"],
  th: [...COMMON, "colspan", "rowspan"],
  font: [...COMMON, "color", "face", "size"],
};
/** Dropped with everything inside them (not just the tag). */
const DROP_WITH_CONTENT = ["script", "style", "textarea", "option", "title", "head", "noscript", "svg", "math", "template", "object", "select", "iframe", "frameset", "noembed", "xmp"];
const allowedAttr = (tag: string, a: string) => (ATTRS[tag] ?? ATTRS["*"]).includes(a);

/** One CSS declaration list, filtered: unsafe declarations dropped (and reported). */
export function filterStyle(style: string, warn: (w: string) => void): string {
  const out: string[] = [];
  // No CSS comments or escapes: both are ways to hide "expression(" or "javascript:" from a filter.
  for (const raw of style.replace(/\/\*[\s\S]*?\*\//g, " ").split(";")) {
    const d = raw.trim();
    if (!d) continue;
    const m = /^([a-zA-Z-]+)\s*:\s*([\s\S]+)$/.exec(d);
    if (!m) { warn(`removed an unreadable style "${d.slice(0, 40)}"`); continue; }
    const prop = m[1].toLowerCase(), value = m[2].trim();
    const lower = value.toLowerCase();
    const urls = [...lower.matchAll(/url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/g)].map((u) => u[2].trim());
    const bad = /[\\<>]/.test(value) || /expression\s*\(|javascript:|vbscript:|data:|@import|behavior|binding/.test(lower) || prop === "behavior" || prop.startsWith("-moz-binding")
      || (/url\s*\(/.test(lower) && (!urls.length || urls.some((u) => !u.startsWith("https://"))));
    if (bad) { warn(`removed the style "${prop}: ${value.slice(0, 60)}"`); continue; }
    out.push(`${prop}: ${value}`);
  }
  return out.join("; ");
}

/** The body of a full document as a div (its style and colours kept, through the same allowlist); a fragment as is. */
function bodyOf(html: string): string {
  const m = /<body\b([^>]*)>([\s\S]*?)(?:<\/body\s*>|$)/i.exec(html);
  if (!m) return /<html\b|<head\b|<!doctype/i.test(html) ? html.replace(/<head\b[\s\S]*?<\/head\s*>/i, "") : html;
  return `<div${m[1]}>${m[2]}</div>`;
}

/** The admin's HTML, sanitized: { html (a fragment), warnings (what was stripped, deduplicated) }. */
export function sanitizeEmailHtml(input: string): { html: string; warnings: string[] } {
  const warnings = new Set<string>();
  const warn = (w: string) => { if (warnings.size < 50) warnings.add(w); };
  if (/<!--/.test(input)) warn("removed HTML comments");
  if (/<style\b/i.test(input)) warn("removed <style> blocks: use inline style attributes");
  const html = sanitizeHtml(bodyOf(input), {
    allowedTags: TAGS,
    allowedAttributes: ATTRS,
    allowedSchemes: ["https", "mailto"],
    allowedSchemesByTag: { img: ["https"] },
    allowedSchemesAppliedToAttributes: ["href", "src"],
    allowProtocolRelative: false,
    allowedClasses: {},
    parseStyleAttributes: false,
    disallowedTagsMode: "discard",
    nonTextTags: DROP_WITH_CONTENT,
    onOpenTag(name, attribs) {
      if (!TAGS.includes(name)) { if (!["html", "body"].includes(name)) warn(`removed <${name}>`); return; }
      for (const a of Object.keys(attribs)) if (!allowedAttr(name, a)) warn(/^on/i.test(a) ? `removed the event handler ${a}` : `removed the attribute ${a} on <${name}>`);
    },
    transformTags: {
      "*": (tagName, attribs) => {
        const out: Record<string, string> = { ...attribs };
        if (out.style != null) { const s = filterStyle(out.style, warn); if (s) out.style = s; else delete out.style; }
        if (out.href != null && !/^(https:\/\/|mailto:)/i.test(out.href.trim())) { warn(`removed the link "${out.href.trim().slice(0, 60)}" (https and mailto only)`); delete out.href; }
        if (out.src != null && !/^https:\/\//i.test(out.src.trim())) {
          warn(/^data:/i.test(out.src.trim()) ? "removed an embedded (data:) image: host it on https" : `removed the image "${out.src.trim().slice(0, 60)}" (https only)`);
          delete out.src;
        }
        if (tagName === "a") {
          if (out.target != null) { out.target = "_blank"; out.rel = "noopener noreferrer"; } else delete out.rel;
        }
        return { tagName, attribs: out };
      },
    },
  });
  return { html: html.trim(), warnings: [...warnings] };
}

/** A sanitized fragment as a minimal email document. */
export function wrapDocument(fragment: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0">
${fragment}
</body></html>`;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
  if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ""; }
  return ENTITIES[e.toLowerCase()] ?? m;
});
const BLOCK = "p|div|h[1-6]|table|tbody|thead|tr|ul|ol|blockquote|center|hr";

/** The plain-text part of (sanitized) HTML: links as "text (url)", block elements as line breaks. */
export function htmlToText(html: string): string {
  let s = html.replace(/^[\s\S]*?<body\b[^>]*>/i, "").replace(/<\/body\s*>[\s\S]*$/i, "");
  s = s.replace(/<a\b[^>]*?\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, href: string, inner: string) => {
    const url = decode(href), text = decode(inner.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    const shown = url.replace(/^mailto:/i, "");
    return !text || text === url || text === shown ? shown : `${text} (${shown})`;
  });
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<li\b[^>]*>/gi, "\n- ").replace(/<\/(td|th)\s*>/gi, " ")
    .replace(new RegExp(`<\\/?(?:${BLOCK})\\b[^>]*>`, "gi"), "\n").replace(/<[^>]+>/g, "");
  return decode(s).replace(/‌/g, "").replace(/[ \t ]+/g, " ").split("\n").map((l) => l.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const escapeHtml = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * {{variables}} into HTML: each value escaped, with a zero-width non-joiner after each dot (no auto-linking). Done
 * before sanitizing, so whatever a value holds stays text.
 */
export function substituteHtml(t: string, values: Record<string, string>, pattern: RegExp): string {
  return t.replace(pattern, (_m, k: string) => escapeHtml(values[k] ?? "").replace(/\./g, ".&#8204;"));
}

/** The footer (plain text from src/campaigns.ts) as small, muted HTML, its links made links. */
export function footerHtml(footerText: string): string {
  const body = escapeHtml(footerText.replace(/^\s*--[ \t]*\n/, "").trim())
    .replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (u) => `<a href="${u}" style="color:#6b7280;text-decoration:underline">${u}</a>`).replace(/\n/g, "<br>");
  return `<div style="max-width:560px;margin:24px auto 0;padding:12px 16px 24px;border-top:1px solid #e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#6b7280">${body}</div>`;
}

/**
 * An html step's email: variables in (escaped), sanitized, wrapped in a document, the footer inside it before
 * </body>; and the text part generated from it, the footer after. The footer goes in after sanitizing: its
 * unsubscribe link is ours (and on a development server is http).
 */
export function composeHtml(body: string, values: Record<string, string>, pattern: RegExp, footerText: string): { html: string; text: string; warnings: string[] } {
  const { html: fragment, warnings } = sanitizeEmailHtml(substituteHtml(body, values, pattern));
  const html = wrapDocument(fragment).replace(/<\/body>(?![\s\S]*<\/body>)/, `${footerHtml(footerText)}\n</body>`);
  return { html, text: htmlToText(fragment) + footerText, warnings };
}
