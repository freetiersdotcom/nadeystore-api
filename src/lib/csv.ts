// Small CSV reader/writer (RFC 4180): quoted cells, doubled quotes, line breaks inside quotes, BOM.
// The delimiter is detected from the header line, because Excel in a French locale saves with ";".

export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const count = (ch: string) => firstLine.split(ch).length - 1;
  const delim = count(';') > count(',') && count(';') >= count('\t') ? ';' : count('\t') > count(',') ? '\t' : ',';

  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += ch;
  }
  if (quoted) throw new Error('A quoted cell is never closed (a " is missing).');
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Rows as objects keyed by the (lower-cased, trimmed) header. `line` is the 1-based line in the file. */
export function parseCsvObjects(input: string, aliases: Record<string, string> = {}): { headers: string[]; rows: Array<{ line: number; data: Record<string, string> }> } {
  const table = parseCsv(input);
  if (!table.length) return { headers: [], rows: [] };
  const headers = table[0].map((h) => {
    const k = h.trim().toLowerCase().replace(/[\s-]+/g, '_');
    return aliases[k] ?? k;
  });
  const rows = table.slice(1).map((cells, i) => {
    const data: Record<string, string> = {};
    headers.forEach((h, j) => { if (h && !(h in data)) data[h] = (cells[j] ?? '').trim(); });
    return { line: i + 2, data };
  });
  return { headers, rows };
}

/** Text that a spreadsheet would run as a formula is defused with a leading apostrophe (CSV injection). */
export function safeText(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export function toCsv(headers: string[], rows: Array<Array<string | number | null | undefined>>): string {
  const cell = (v: string | number | null | undefined) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // BOM so Excel opens accents correctly.
  return '﻿' + [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
