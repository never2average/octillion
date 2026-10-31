/**
 * HTML campaign emails (a step with format "html", src/campaigns.ts): the admin's HTML through an allowlist sanitizer
 * (sanitize-html), on save and again at render, then a plain-text part generated from it.
 *
 *   allowed     layout and text tags only (tables, div / span / p, headings, lists, links, images, font, center);
 *               a small attribute list; inline styles only (no <style> blocks, no scripts, iframes, forms or inputs,
 *               no event handlers). Links: https and mailto only (a mailto keeps only its subject and body);
 *               images: https only (no data: URLs). CSS, parsed declaration by declaration (quotes and parentheses
 *               respected): no escapes, no function but colours, calc and gradients, and url() with https; nothing
 *               that moves, layers or hides (position, z-index, offsets, transform, clip, opacity, visibility,
 *               filter, display:none, negative margins), so the footer and its unsubscribe link can't be covered.
 *   footer      after the sanitized content (itself in a position:relative, overflow:hidden box), in its own table
 *               with explicit visible styles.
 *   variables   text only: a template with {{...}} inside a tag (an attribute) is refused on save. Put in
 *               HTML-escaped BEFORE sanitizing (so a value can never become markup), with a zero-width non-joiner
 *               after each dot so a mail client does not auto-link a value that reads like a domain.
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

/** A style attribute's declarations, split on ";" outside quotes and parentheses; null when unbalanced. */
export function declarations(style: string): string[] | null {
  const out: string[] = [];
  let cur = "", quote: string | null = null, depth = 0;
  for (const ch of style) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") { if (!depth) return null; depth--; }
    else if (ch === ";" && !depth) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (quote || depth) return null;
  out.push(cur);
  return out;
}
/** Properties that move, layer, clip or hide content: what an overlay over the footer would need. */
const HIDING = /^(position|z-index|top|right|bottom|left|inset(-.*)?|transform(-.*)?|translate|rotate|scale|perspective(-.*)?|clip(-path)?|opacity|visibility|filter|backdrop-filter|mask(-.*)?|-webkit-mask(-.*)?|-webkit-transform|-webkit-filter|content|behavior|-moz-binding|zoom)$/;
/** CSS functions that load nothing. url() is allowed only with an https address (checked on its own). */
const SAFE_FUNCTIONS = new Set(["rgb", "rgba", "hsl", "hsla", "calc", "min", "max", "clamp", "linear-gradient", "radial-gradient", "repeating-linear-gradient", "repeating-radial-gradient", "url"]);

/** One CSS declaration list, filtered: unsafe declarations dropped (and reported). */
export function filterStyle(style: string, warn: (w: string) => void): string {
  // No CSS comments: a way to hide "expression(" from a filter.
  const list = declarations(style.replace(/\/\*[\s\S]*?\*\//g, " "));
  if (!list) { warn(`removed an unbalanced style "${style.slice(0, 60)}"`); return ""; }
  const out: string[] = [];
  for (const raw of list) {
    const d = raw.trim();
    if (!d) continue;
    const m = /^([a-zA-Z-]+)\s*:\s*([\s\S]+)$/.exec(d);
    if (!m) { warn(`removed an unreadable style "${d.slice(0, 40)}"`); continue; }
    const prop = m[1].toLowerCase(), value = m[2].trim(), lower = value.toLowerCase();
    const fns = [...lower.matchAll(/([a-z-]+)\s*\(/g)].map((f) => f[1]);
    const urls = [...lower.matchAll(/url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/g)].map((u) => u[2].trim());
    const why =
      /[\\<>]/.test(value) || /javascript:|vbscript:|data:|@import|expression/.test(lower) ? "unsafe" :
      HIDING.test(prop) ? "it can move, layer or hide content" :
      prop === "display" && /\bnone\b/.test(lower) ? "it hides content" :
      /^margin/.test(prop) && /(^|[\s(,])-\s*[\d.]/.test(value) ? "negative margins can overlap content" :
      (lower.match(/\(/g) ?? []).length !== fns.length ? "unsafe" :
      fns.some((f) => !SAFE_FUNCTIONS.has(f)) ? `only colours, calc, gradients and https url() are allowed` :
      fns.filter((f) => f === "url").length !== urls.length || urls.some((u) => !u.startsWith("https://")) ? "url() must be https" : null;
    if (why) { warn(`removed the style "${prop}: ${value.slice(0, 60)}" (${why})`); continue; }
    out.push(`${prop}: ${value}`);
  }
  return out.join("; ");
}

/** A mailto link keeps its address and only its subject and body (no cc, bcc or other headers). */
function cleanMailto(href: string, warn: (w: string) => void): string | null {
  const i = href.indexOf("?"), addr = i < 0 ? href : href.slice(0, i);
  if (/%0[ad]|[\r\n]/i.test(addr)) { warn("removed a mailto link with a line break in its address"); return null; }
  if (i < 0) return href;
  const kept: string[] = [], dropped: string[] = [];
  for (const pair of href.slice(i + 1).split("&")) {
    if (!pair) continue;
    let k = pair.split("=")[0];
    try { k = decodeURIComponent(k); } catch { /* kept as typed */ }
    (/^(subject|body)$/i.test(k.trim()) ? kept : dropped).push(pair);
  }
  if (dropped.length) warn(`removed mailto parameters other than subject and body (${dropped.map((x) => x.split("=")[0]).join(", ").slice(0, 60)})`);
  return addr + (kept.length ? `?${kept.join("&")}` : "");
}

/** The first tag whose attributes hold a {{variable}} (variables are text only), or null. */
export function variableInAttribute(html: string, pattern: RegExp): string | null {
  for (const m of html.matchAll(/<[a-zA-Z][^>]*>/g)) if (new RegExp(pattern.source).test(m[0])) return m[0].slice(0, 80);
  return null;
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
        if (out.href != null && /^mailto:/i.test(out.href.trim())) { const h = cleanMailto(out.href.trim(), warn); if (h) out.href = h; else delete out.href; }
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
    const shown = /^mailto:/i.test(url) ? url.replace(/^mailto:/i, "").split("?")[0] : url;
    return !text || text === url || text === shown ? shown : `${text} (${shown})`;
  });
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<li\b[^>]*>/gi, "\n- ").replace(/<\/(td|th)\s*>/gi, " ")
    .replace(new RegExp(`<\\/?(?:${BLOCK})\\b[^>]*>`, "gi"), "\n").replace(/<[^>]+>/g, "");
  return decode(s).replace(/\u200c/g, "").replace(/[ \t\u00a0]+/g, " ").split("\n").map((l) => l.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const escapeHtml = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * {{variables}} into HTML: each value escaped, with a zero-width non-joiner after each dot (no auto-linking). Done
 * before sanitizing, so whatever a value holds stays text.
 */
export function substituteHtml(t: string, values: Record<string, string>, pattern: RegExp): string {
  // Text only: a {{variable}} inside a tag (refused on save) is dropped, never filled in.
  return t.split(/(<[^>]*>)/).map((part, i) => (i % 2 ? part.replace(pattern, "")
    : part.replace(pattern, (_m, k: string) => escapeHtml(values[k] ?? "").replace(/\./g, ".&#8204;")))).join("");
}

/** The footer (plain text from src/campaigns.ts) as small HTML in its own table, every style explicitly visible. */
export function footerHtml(footerText: string): string {
  const body = escapeHtml(footerText.replace(/^\s*--[ \t]*\n/, "").trim())
    .replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (u) => `<a href="${u}" style="color:#374151;text-decoration:underline;display:inline;opacity:1;visibility:visible">${u}</a>`).replace(/\n/g, "<br>");
  const shown = "display:block;opacity:1;visibility:visible;position:static;transform:none;clip:auto;filter:none";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;opacity:1;visibility:visible;position:static;margin:0;clear:both;background:#ffffff">
<tr><td align="center" style="padding:16px;opacity:1;visibility:visible;background:#ffffff">
<div style="${shown};max-width:560px;margin:0 auto;padding-top:12px;border-top:1px solid #d1d5db;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#374151;background:#ffffff">${body}</div>
</td></tr></table>`;
}

/**
 * An html step's email: variables in (escaped), sanitized, in a contained box in a document, the footer after it
 * before </body>; and the text part generated from it, the footer after. The footer goes in after sanitizing: its
 * unsubscribe link is ours (and on a development server is http).
 */
export function composeHtml(body: string, values: Record<string, string>, pattern: RegExp, footerText: string): { html: string; text: string; warnings: string[] } {
  const { html: fragment, warnings } = sanitizeEmailHtml(substituteHtml(body, values, pattern));
  // The content in a box it cannot escape; the footer after it, inserted by a function (no "$" patterns from the text).
  const html = wrapDocument(`<div style="position:relative;overflow:hidden">${fragment}</div>`).replace(/<\/body>(?![\s\S]*<\/body>)/, () => `${footerHtml(footerText)}\n</body>`);
  return { html, text: htmlToText(fragment) + footerText, warnings };
}
