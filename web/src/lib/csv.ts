// CSV and JSON downloads for exports. RFC 4180 cells, CRLF lines and a UTF-8 BOM so Excel opens accents correctly.
export type CsvValue = string | number | boolean | null | undefined;

export const csvCell = (v: CsvValue): string => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(header: string[], rows: CsvValue[][]): string {
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function downloadText(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  // revoke on the next tick: some browsers start the download asynchronously
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export const downloadCsv = (filename: string, header: string[], rows: CsvValue[][]) =>
  downloadText(filename, toCsv(header, rows), 'text/csv;charset=utf-8');

export const downloadJson = (filename: string, obj: unknown) =>
  downloadText(filename, JSON.stringify(obj, null, 2), 'application/json');

/** YYYY-MM-DD, for file names. */
export const today = () => new Date().toISOString().slice(0, 10);
