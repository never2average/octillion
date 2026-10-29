/**
 * Whether a quoted sentence is on a page as fetched (shared by the server, src/research.ts audienceEvidenceIssues, and
 * the research orchestrator, pi-octillion/research.ts audienceStep). Case, whitespace, curly quotes, dashes and
 * Unicode forms are ignored, nothing else: a paraphrase is not a quote.
 */
export const quoteKey = (s: unknown) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/[‘’‛′]/g, "'").replace(/[“”„″]/g, '"')
  .replace(/[‐‑‒–—―]/g, "-").replace(/\s+/g, " ").trim();

export const quotedOn = (pageText: string, quote: string) => quoteKey(quote).length >= 20 && quoteKey(pageText).includes(quoteKey(quote));

/** A fetch_url result ("URL: <final url>\nStatus: ...\n\n<text>\n\nLinks you may fetch: ...") as {url, text}. */
export function readablePage(out: string): { url: string; text: string } | null {
  const m = /^URL: (\S+)/.exec(out);
  if (!m) return null;
  const body = out.slice(out.indexOf("\n\n") + 2);
  const cut = body.lastIndexOf("\n\nLinks you may fetch:\n");
  return { url: m[1]!, text: (cut >= 0 ? body.slice(0, cut) : body).replace(/\n\[truncated\]$/, "") };
}

/** Normalised URL for matching a cited page (no scheme, www, fragment or trailing slash; the path's case and the query
 *  are kept): the server's and the orchestrator's one rule (src/websearch.ts re-exports it). */
export const urlKey = (u: string) => {
  try { const x = new URL(u); return `${x.hostname.toLowerCase().replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "")}${x.search}`; } catch { return u.trim(); }
};
