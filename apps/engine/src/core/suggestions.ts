import type { Config, CorpusIndexRecord, QuestionLogRecord, SourceItem } from '@pelp/domain';
import { daysAgo, isFollowUp, lastDays, montevideoDay, neutralizeSourceFrame, normalizeQuestion } from '@pelp/domain';
import type { SuggestionCard, SuggestionsResponse } from '@pelp/domain/api';
import { GOLDEN_SET } from '@pelp/testing';
import type { Store } from './store';

// La caché guarda el día además del momento: aunque la Lambda siga caliente, la portada se
// rearma al cambiar el día y nunca se queda con las notas de ayer.
let cached: { at: number; day: string; items: string[] } | undefined;
let cachedCards: { at: number; day: string; version: string; cards: SuggestionCard[] } | undefined;

/**
 * Las preguntas del set dorado entran al log como cualquier otra —el smoke test las dispara
 * contra la API real— y se repiten en cada corrida, así que encabezaban las tendencias y
 * terminaban ofrecidas en la portada. No son preguntas de lectores: se apartan.
 */
let cachedControl: { at: number; keys: Set<string> } | undefined;

async function controlKeys(store: Store, ttlMs = 10 * 60_000): Promise<Set<string>> {
  if (cachedControl && Date.now() - cachedControl.at < ttlMs) return cachedControl.keys;
  const cases = await store.listEvalCases().catch(() => []);
  const keys = new Set<string>();
  // El set dorado del repo es el que dispara el smoke test: borrar un caso desde Calidad no lo
  // saca de las corridas, así que se miran las dos fuentes.
  for (const item of GOLDEN_SET.cases) {
    const key = normalizeQuestion(item.question);
    if (key) keys.add(key);
  }
  for (const item of cases) {
    if (item.source !== 'golden') continue;
    const key = normalizeQuestion(item.question);
    if (key) keys.add(key);
  }
  cachedControl = { at: Date.now(), keys };
  return keys;
}

/** Una nota sirve de sugerencia mientras esté dentro de la ventana de frescura. */
function freshFrom(config: Config, now: Date): string {
  return montevideoDay(daysAgo(config.suggestions.freshDays, now));
}

function sourceFromCorpus(record: CorpusIndexRecord): SourceItem {
  return {
    title: record.title,
    url: record.url,
    date: record.date,
    section: record.section,
    ...(record.imageUrl ? { imageUrl: record.imageUrl } : {}),
    ...(record.deck ? { deck: record.deck } : {}),
  };
}

/** Pregunta natural a partir de un título de nota (para tarjetas "reciente"): cita el título, sin cortar palabras. */
export function questionFromTitle(title: string): string {
  const clean = title.replace(/\s+/g, ' ').replace(/[“”"«»]/g, '').trim();
  const head = (clean.split(/:|\||\?/)[0] ?? clean).trim().replace(/[.,;]+$/, '');
  let short = head;
  if (short.length > 90) {
    const cut = short.slice(0, 90);
    short = cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : 90).trim();
  }
  // Sin el diario de sujeto: "¿Qué dice El País sobre…?" le costaba la relevancia del guardrail a
  // una respuesta correcta (15/9/2026). Misma forma que el envoltorio de temas sueltos.
  return `¿Qué se sabe sobre "${short}"?`;
}

/** Notas que salen todos los días con el mismo molde: no son novedad para una tarjeta. */
const DAILY_FIXTURE = /horoscopo|efemerides|tiempo de hoy|cotizaci[oó]n del d[oó]lar hoy|unidad indexada hoy/i;

/** Lo más nuevo primero: por día, y dentro del día por hora de publicación. */
function newerFirst(a: CorpusIndexRecord, b: CorpusIndexRecord): number {
  if (a.date !== b.date) return b.date.localeCompare(a.date);
  return (b.publishedAt ?? b.updatedAt).localeCompare(a.publishedAt ?? a.updatedAt);
}

/**
 * Tarjetas de portada (10.2): las cuatro notas más recientes con foto. Hasta el 15/9/2026 se
 * armaban con las preguntas más repetidas de los últimos días y un relleno de notas recientes;
 * se pidió que fueran solo actualidad, sin ningún modelo en el medio, y que se renueven con cada
 * sync. La caché se ata a la versión del corpus, que cambia cuando la ingestión de un sync
 * termina: ese es el momento en que las notas nuevas ya se pueden buscar, así ninguna tarjeta
 * ofrece una pregunta que la búsqueda todavía no puede contestar. Solo con foto: la tarjeta es
 * mitad imagen y sin ella se ve rota.
 */
export async function suggestionCards(store: Store, config: Config, now: Date, ttlMs = 60 * 60_000): Promise<SuggestionCard[]> {
  const today = montevideoDay(now);
  const version = config.corpus.version || 'initial';
  if (cachedCards && cachedCards.day === today && cachedCards.version === version && Date.now() - cachedCards.at < ttlMs) {
    return cachedCards.cards;
  }
  let recent: CorpusIndexRecord[] = [];
  try {
    recent = await store.listCorpusByDate(montevideoDay(daysAgo(7, now)), today, 300);
  } catch {
    recent = [];
  }
  const usedUrls = new Set<string>();
  const cards: SuggestionCard[] = [];
  for (const record of recent.filter((item) => !item.removed && item.imageUrl && !DAILY_FIXTURE.test(`${item.section} ${item.title}`)).sort(newerFirst)) {
    if (usedUrls.has(record.url)) continue;
    usedUrls.add(record.url);
    cards.push({ question: questionFromTitle(record.title), kind: 'recent', source: sourceFromCorpus(record) });
    if (cards.length >= 4) break;
  }
  cachedCards = { at: Date.now(), day: today, version, cards };
  return cards;
}

export async function suggestionsResponse(store: Store, config: Config, now: Date): Promise<SuggestionsResponse> {
  const [items, cards] = await Promise.all([suggestions(store, config, now), suggestionCards(store, config, now)]);
  return { items, cards };
}

/** Preguntas sugeridas (10.2): tendencias con cobertura de los últimos días, con lista de respaldo. */
export async function suggestions(store: Store, config: Config, now: Date, ttlMs = 10 * 60_000): Promise<string[]> {
  const today = montevideoDay(now);
  if (cached && cached.day === today && Date.now() - cached.at < ttlMs) return cached.items;
  const fresh = freshFrom(config, now);
  const control = await controlKeys(store);
  const counts = new Map<string, { count: number; sample: string }>();
  for (const day of lastDays(config.suggestions.days, now)) {
    let logs: QuestionLogRecord[] = [];
    try {
      logs = await store.listQuestionLogs(day, 500);
    } catch {
      logs = [];
    }
    for (const log of logs) {
      if (!log.hadCoverage || log.blocked || !log.questionMasked) continue;
      if (control.has(normalizeQuestion(log.questionMasked))) continue;
      // Una repregunta ofrecida suelta no se entiende: "¿Y en Uruguay?" sin el turno anterior.
      if (isFollowUp(log.questionMasked)) continue;
      // Solo trascienden las preguntas que se apoyan en notas de la ventana de frescura.
      if (!log.sources.some((source) => source.date >= fresh)) continue;
      // La tendencia se ofrece con la redacción que el motor va a usar de verdad: si el lector
      // escribió "¿Qué dice El País sobre…?", el chip no repite la forma que el guardrail castiga.
      const entry = counts.get(log.qnormHash) ?? { count: 0, sample: neutralizeSourceFrame(log.questionMasked) };
      entry.count += 1;
      counts.set(log.qnormHash, entry);
    }
  }
  const trending = [...counts.values()]
    .filter((entry) => entry.count >= 2)
    .sort((a, b) => b.count - a.count)
    .map((entry) => entry.sample)
    .slice(0, config.suggestions.max);
  const fallback = config.suggestions.fallback.filter((item) => !trending.includes(item));
  const items = [...trending, ...fallback].slice(0, config.suggestions.max);
  cached = { at: Date.now(), day: today, items };
  return items;
}

export function resetSuggestionsCache(): void {
  cachedControl = undefined;
  cached = undefined;
  cachedCards = undefined;
}
