import type { Config, CorpusIndexRecord, QuestionLogRecord, SourceItem } from '@pelp/domain';
import { daysAgo, isFollowUp, lastDays, montevideoDay, normalizeQuestion } from '@pelp/domain';
import type { SuggestionCard, SuggestionsResponse } from '@pelp/domain/api';
import { GOLDEN_SET } from '@pelp/testing';
import type { Store } from './store';

// La caché guarda el día además del momento: aunque la Lambda siga caliente, la portada se
// rearma al cambiar el día y nunca se queda con las notas de ayer.
let cached: { at: number; day: string; items: string[] } | undefined;
let cachedCards: { at: number; day: string; cards: SuggestionCard[] } | undefined;

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
  return `¿Qué dice El País sobre "${short}"?`;
}

/**
 * Tarjetas de portada (10.2): tendencias con cobertura y su nota más citada, completadas con
 * notas recientes del corpus. Máximo 4, sin repetir nota y solo con notas que traen foto:
 * la tarjeta es mitad imagen y sin ella se ve rota.
 */
export async function suggestionCards(store: Store, config: Config, now: Date, ttlMs = 10 * 60_000): Promise<SuggestionCard[]> {
  const today = montevideoDay(now);
  if (cachedCards && cachedCards.day === today && Date.now() - cachedCards.at < ttlMs) return cachedCards.cards;
  const fresh = freshFrom(config, now);
  const control = await controlKeys(store);
  const cards: SuggestionCard[] = [];
  const usedUrls = new Set<string>();
  const counts = new Map<string, { count: number; log: QuestionLogRecord }>();
  for (const day of lastDays(config.suggestions.days, now)) {
    let logs: QuestionLogRecord[] = [];
    try {
      logs = await store.listQuestionLogs(day, 500);
    } catch {
      logs = [];
    }
    for (const log of logs) {
      if (!log.hadCoverage || log.blocked || !log.sources.length) continue;
      if (control.has(normalizeQuestion(log.questionMasked))) continue;
      if (isFollowUp(log.questionMasked)) continue;
      const entry = counts.get(log.qnormHash) ?? { count: 0, log };
      entry.count += 1;
      counts.set(log.qnormHash, entry);
    }
  }
  for (const entry of [...counts.values()].filter((item) => item.count >= 2).sort((a, b) => b.count - a.count)) {
    const source = entry.log.sources[0];
    // Una pregunta muy repetida sobre una nota vieja no es novedad: la portada muestra actualidad.
    // Sin foto la tarjeta queda con un relleno gris, así que esas notas no se ofrecen acá.
    if (!source || !source.imageUrl || source.date < fresh || usedUrls.has(source.url)) continue;
    usedUrls.add(source.url);
    cards.push({ question: entry.log.questionMasked, kind: 'trending', source });
    if (cards.length >= 4) break;
  }
  if (cards.length < 4) {
    let recent: CorpusIndexRecord[] = [];
    try {
      recent = await store.listCorpusByDate(montevideoDay(daysAgo(30, now)), montevideoDay(now), 200);
    } catch {
      recent = [];
    }
    const preferred = recent.filter((record) => !record.removed && record.imageUrl && !usedUrls.has(record.url) && !/horoscopo|efemerides|tiempo de hoy|cotizaci[oó]n del d[oó]lar hoy|unidad indexada hoy/i.test(`${record.section} ${record.title}`));
    // Diversificar por sección.
    const seenSections = new Set<string>();
    for (const record of [...preferred.filter((r) => !seenSections.has(r.section) && seenSections.add(r.section)), ...preferred]) {
      if (cards.length >= 4) break;
      if (usedUrls.has(record.url)) continue;
      usedUrls.add(record.url);
      cards.push({ question: questionFromTitle(record.title), kind: 'recent', source: sourceFromCorpus(record) });
    }
  }
  cachedCards = { at: Date.now(), day: today, cards };
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
      const entry = counts.get(log.qnormHash) ?? { count: 0, sample: log.questionMasked };
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
