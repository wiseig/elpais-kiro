/** Exportación CSV del lado del cliente (Blob + descarga). */

export type CsvCell = string | number | boolean | null | undefined;

function escapeCell(cell: CsvCell): string {
  if (cell === null || cell === undefined) return '';
  const text = typeof cell === 'string' ? cell : String(cell);
  return /[",\r\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers: string[], rows: CsvCell[][]): string {
  return [headers, ...rows].map((row) => row.map(escapeCell).join(',')).join('\r\n');
}

export function downloadCsv(filename: string, csv: string): void {
  // BOM para que Excel reconozca UTF-8 (tildes, eñes).
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function csvFilename(base: string): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `${base}-${stamp}.csv`;
}
