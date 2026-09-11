/** Fechas en español rioplatense (es-UY). */

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parsea una fecha; "YYYY-MM-DD" se interpreta como día local para no correrse un día. */
export function parseDate(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = ISO_DAY.exec(trimmed);
  const date = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

const longDate = new Intl.DateTimeFormat('es-UY', { day: 'numeric', month: 'long', year: 'numeric' });

/** "11 de septiembre de 2026". Si no se puede parsear devuelve el texto original. */
export function formatDate(value: string): string | null {
  const date = parseDate(value);
  if (date) return longDate.format(date);
  const trimmed = value.trim();
  return trimmed || null;
}

/** Valor para el atributo `datetime` de <time>. */
export function toIsoDate(value: string): string | null {
  const date = parseDate(value);
  if (!date) return null;
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
