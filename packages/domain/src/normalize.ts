/**
 * Normalización de preguntas para caché y tendencias (6.5). Sin dependencias de Node.
 * Mantiene acentos y eñes: son parte del español y distinguen preguntas.
 */
export function normalizeQuestion(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[¿¡]/g, '')
    .replace(/[?!.,;:'"“”‘’«»()[\]{}]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Recorta y colapsa espacios sin cambiar el contenido. */
export function cleanQuestion(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const AMBIGUOUS_PRONOUNS =
  /\b(él|ella|ellos|ellas|eso|esto|aquello|le|les)\b|\b(ese|esa|esos|esas|este|esta|estos|estas|aquel|aquella)\b(?!\s+\p{L})|^\s*¿?\s*y\b/iu;

/**
 * Regla de 6.4: la reescritura se salta cuando no hay turnos previos y la pregunta
 * tiene más de 6 palabras sin pronombres ambiguos.
 */
export function needsRewrite(question: string, hasHistory: boolean): boolean {
  if (hasHistory) return true;
  const words = question.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 6) return true;
  return AMBIGUOUS_PRONOUNS.test(question.trim());
}

/** Fecha calendario en America/Montevideo (YYYY-MM-DD). */
export function montevideoDay(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Montevideo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Clave de hora UTC para rate limit: YYYY-MM-DD-HH. */
export function hourKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 13).replace('T', '-');
}

export function daysAgo(n: number, from: Date = new Date()): Date {
  return new Date(from.getTime() - n * 24 * 60 * 60 * 1000);
}

export function epochSeconds(date: Date = new Date()): number {
  return Math.floor(date.getTime() / 1000);
}

/** epoch (segundos) a partir de un YYYY-MM-DD interpretado a las 00:00 de Montevideo (UTC-3). */
export function dayToEpoch(day: string): number {
  const parsed = Date.parse(`${day}T00:00:00-03:00`);
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
}

/** Lista de fechas (YYYY-MM-DD, Montevideo) hacia atrás incluyendo hoy. */
export function lastDays(n: number, from: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) out.push(montevideoDay(daysAgo(i, from)));
  return out;
}
