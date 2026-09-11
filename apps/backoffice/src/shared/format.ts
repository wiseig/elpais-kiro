/** Formateo es-UY: fechas en hora de Montevideo, USD, porcentajes. */

const LOCALE = 'es-UY';
const TZ = 'America/Montevideo';

const dateTimeFmt = new Intl.DateTimeFormat(LOCALE, {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: TZ,
});
const dateFmt = new Intl.DateTimeFormat(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: TZ });
const shortDayFmt = new Intl.DateTimeFormat(LOCALE, { day: '2-digit', month: '2-digit', timeZone: TZ });
const isoDayFmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TZ });
const usdFmt = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdPreciseFmt = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const intFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });

function toDate(value: string | number | Date | undefined | null): Date | null {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function fmtDateTime(value: string | number | Date | undefined | null): string {
  const date = toDate(value);
  return date ? dateTimeFmt.format(date) : '—';
}

export function fmtDate(value: string | number | Date | undefined | null): string {
  const date = toDate(value);
  return date ? dateFmt.format(date) : '—';
}

/** `YYYY-MM-DD` → `dd/mm` (sin corrimiento de zona). */
export function fmtDay(day: string | undefined | null): string {
  if (!day) return '—';
  const date = toDate(`${day}T12:00:00Z`);
  return date ? shortDayFmt.format(date) : day;
}

/** Día de hoy en Montevideo como `YYYY-MM-DD`. */
export function todayDay(): string {
  return isoDayFmt.format(new Date());
}

export function daysAgoDay(days: number): string {
  return isoDayFmt.format(new Date(Date.now() - days * 86_400_000));
}

export function fmtUsd(value: number | undefined | null, precise = false): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  return (precise ? usdPreciseFmt : usdFmt).format(value);
}

export function fmtInt(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  return intFmt.format(value);
}

export function fmtNumber(value: number | undefined | null, digits = 2): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(value);
}

/** Tasa 0–1 → porcentaje. */
export function fmtPercent(rate: number | undefined | null, digits = 1): string {
  if (rate === undefined || rate === null || Number.isNaN(rate)) return '—';
  return `${fmtNumber(rate * 100, digits)} %`;
}

/** Valor ya expresado en 0–100 → porcentaje. */
export function fmtPercentValue(percent: number | undefined | null, digits = 0): string {
  if (percent === undefined || percent === null || Number.isNaN(percent)) return '—';
  return `${fmtNumber(percent, digits)} %`;
}

export function fmtMs(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return '—';
  return ms >= 1000 ? `${fmtNumber(ms / 1000, 1)} s` : `${fmtInt(ms)} ms`;
}

/** Tokens en forma compacta (12,3 k / 4,1 M). */
export function fmtTokens(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  if (value >= 1_000_000) return `${fmtNumber(value / 1_000_000, 1)} M`;
  if (value >= 10_000) return `${fmtNumber(value / 1000, 1)} k`;
  return fmtInt(value);
}

export function fmtDuration(startIso: string | undefined, endIso: string | undefined): string {
  const start = toDate(startIso);
  const end = toDate(endIso);
  if (!start || !end) return '—';
  const ms = end.getTime() - start.getTime();
  if (ms < 0) return '—';
  if (ms < 60_000) return `${fmtInt(Math.round(ms / 1000))} s`;
  return `${fmtInt(Math.floor(ms / 60_000))} min ${fmtInt(Math.round((ms % 60_000) / 1000))} s`;
}

export function truncate(text: string | undefined | null, max = 120): string {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function yesNo(value: boolean | undefined | null): string {
  return value ? 'Sí' : 'No';
}

export function prettyJson(value: unknown): string {
  if (value === undefined) return '—';
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
