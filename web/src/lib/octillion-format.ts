export const usd = (n: unknown) => `$${Number(n || 0).toFixed(2)}`;
export const money = (cents: number | null | undefined, currency?: string) =>
  cents == null ? '' : (cents / 100).toLocaleString(undefined, { style: 'currency', currency: (currency || 'usd').toUpperCase(), maximumFractionDigits: 0 });
export const num = (n: unknown) => Number(n || 0).toLocaleString();
/** A filter option's text with how many records it matches: "Active · 12" (the label alone while the count is unknown). */
// Dropdown options read as their label only: item counts are off app-wide (callers still pass the count).
export const counted = (label: string, _n?: number | null) => label;

/** "3h ago"; pair with title={new Date(d).toLocaleString()} for the exact time. */
export function relative(d: string | Date | null | undefined) {
  if (!d) return 'never';
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 0) return `in ${Math.ceil(-s / 86400)}d`;
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}
