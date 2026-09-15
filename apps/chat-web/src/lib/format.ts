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

const DAY_MS = 86_400_000;
const shortDate = new Intl.DateTimeFormat('es-UY', { day: 'numeric', month: 'short' });

function startOfDay(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "Hoy" / "Ayer" / "Hace N días" / fecha corta, para el panel de historial. */
export function formatRelativeDay(ms: number): string {
  const diffDays = Math.round((startOfDay(Date.now()) - startOfDay(ms)) / DAY_MS);
  if (diffDays <= 0) return 'Hoy';
  if (diffDays === 1) return 'Ayer';
  if (diffDays < 7) return `Hace ${diffDays} días`;
  return shortDate.format(new Date(ms));
}

/** La etiqueta de sección es la misma en todos los frentes: vive en el dominio. */
export { sectionLabel } from '@pelp/domain';
