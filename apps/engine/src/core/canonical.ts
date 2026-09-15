import type { Config, ModelCall, RetrievedChunk, SourceItem, TokenUsage } from '@pelp/domain';
import {
  NO_COVERAGE_MESSAGE,
  UNVERIFIED_MESSAGE,
  addDays,
  daysBetweenDays,
  describeDay,
  futureDayOffset,
  isTimeSensitive,
  sanitizeSources,
  startsWithNoCoverage,
  validateAnswerText,
  withoutClosingInvitation,
} from '@pelp/domain';
import { costUsd, parseJsonObject, sourcesFromChunks } from '@pelp/bedrock';
import { buildCanonicalUserMessage, getCanonicalStrictSuffix, getPrompt } from '@pelp/prompts';
import type { GroundingCheck, GuardrailGateway, ModelGateway, RetrieverGateway } from './gateways';
import type { Logger } from './log';

export interface CanonicalDeps {
  models: ModelGateway;
  retriever: RetrieverGateway;
  guard: GuardrailGateway;
  log: Logger;
  /**
   * Corrige los fragmentos contra el índice del corpus antes de usarlos. La metadata del índice
   * vectorial es tan fresca como la última ingestión de Bedrock, que es asincrónica: el 14/9/2026
   * una nota corregida a las 23:22 seguía apareciendo con la fecha vieja a las 23:39. Y esa fecha
   * no solo se le muestra al lector: decide el aviso de desfase temporal.
   */
  enrichChunks?: (chunks: RetrievedChunk[]) => Promise<RetrievedChunk[]>;
}

export interface CanonicalInput {
  /** Pregunta autónoma (tras reescritura) que se usa para recuperar y responder. */
  question: string;
  today: string;
  model: string;
  config: Config;
  now: Date;
  abortSignal?: AbortSignal;
  /** Pedido de panorama: fragmentos del día ya elegidos, en vez de búsqueda semántica. */
  digest?: { chunks: RetrievedChunk[]; notice: string };
}

export interface CanonicalOutcome {
  answer: string;
  hadCoverage: boolean;
  sources: SourceItem[];
  usedChunks: number[];
  groundingScore?: number;
  relevanceScore?: number;
  chunks: RetrievedChunk[];
  calls: ModelCall[];
  groundingFailed: boolean;
  retried: boolean;
  widened: boolean;
  /** Hay cobertura pero el resumen no pasó el verificador: se entrega el pie a las notas. */
  unverified?: boolean;
  /** El resumen descartado. Sin esto no hay forma de saber por qué falló el sustento. */
  unverifiedAnswer?: string;
}

interface CanonicalJson {
  answer?: unknown;
  usedChunks?: unknown;
  hadCoverage?: unknown;
}

function asIndexes(value: unknown, max: number): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const item of value) {
    const index = typeof item === 'number' ? item : Number(item);
    if (Number.isInteger(index) && index >= 1 && index <= max && !out.includes(index)) out.push(index);
  }
  return out;
}

export function noCoverageOutcome(chunks: RetrievedChunk[], config: Config, extras: Partial<CanonicalOutcome> = {}): CanonicalOutcome {
  const related = sanitizeSources(sourcesFromChunks(chunks, undefined), config.guardrails.allowedUrlHosts).slice(0, 2);
  return {
    answer: NO_COVERAGE_MESSAGE,
    hadCoverage: false,
    sources: related,
    usedChunks: [],
    chunks,
    calls: [],
    groundingFailed: false,
    retried: false,
    widened: false,
    ...extras,
  };
}


/**
 * Salida cuando el sustento falla dos veces: no es "no publicó". Se nombra la cobertura que sí
 * existe y se entregan las notas, que es lo único que se puede afirmar sin verificar.
 */
export function unverifiedOutcome(chunks: RetrievedChunk[], config: Config, extras: Partial<CanonicalOutcome> = {}): CanonicalOutcome {
  const sources = sanitizeSources(sourcesFromChunks(chunks, undefined), config.guardrails.allowedUrlHosts).slice(0, config.answering.maxSources);
  if (!sources.length) return noCoverageOutcome(chunks, config, extras);
  return {
    answer: UNVERIFIED_MESSAGE,
    hadCoverage: true,
    sources,
    usedChunks: [],
    chunks,
    calls: [],
    groundingFailed: true,
    retried: true,
    widened: false,
    unverified: true,
    ...extras,
  };
}

/** Desfase máximo tolerado (en días) para una pregunta anclada al presente. */
const STALE_DAYS = 1;

/**
 * Aviso para el prompt cuando la pregunta pide algo actual ("el finde", "hoy") y la nota más
 * nueva es vieja: sin esto el modelo daba el pronóstico del 4 de setiembre como si fuera el
 * de hoy. El aviso es un hecho, no una orden: la regla de qué hacer vive en el prompt.
 */
export function staleDateNotice(question: string, chunks: RetrievedChunk[], today: string): string | undefined {
  const dates = chunks.map((chunk) => chunk.date).filter((date): date is string => Boolean(date));
  if (!dates.length) return undefined;
  const newest = dates.reduce((a, b) => (a > b ? a : b));

  // Un día que todavía no llegó: el archivo no puede tenerlo, por más fresca que sea la nota.
  const offset = futureDayOffset(question);
  if (offset !== undefined) {
    const target = addDays(today, offset);
    if (newest < target) {
      // Sin afirmar que falten datos: una nota de hoy puede traer el pronóstico de mañana.
      return `Hoy es ${describeDay(today)} y la pregunta pide el ${describeDay(target)}. La nota más nueva sobre el tema se publicó el ${describeDay(newest)}.`;
    }
    return undefined;
  }

  if (!isTimeSensitive(question)) return undefined;
  const age = daysBetweenDays(today, newest);
  if (age <= STALE_DAYS) return undefined;
  const dias = age === 1 ? 'hace 1 día' : `hace ${age} días`;
  return `Hoy es ${describeDay(today)}. La pregunta pide información actual y la nota más reciente sobre el tema es del ${describeDay(newest)} (${dias}). No hay nada publicado después de esa fecha.`;
}

/**
 * Canónica (6.1, 6.2, 6.3): recuperación con filtro de recencia, generación JSON,
 * validadores de formato, grounding contextual y un reintento estricto.
 */
export async function generateCanonical(deps: CanonicalDeps, input: CanonicalInput): Promise<CanonicalOutcome> {
  const { config } = input;
  const calls: ModelCall[] = [];
  // Un pedido de panorama trae sus propios fragmentos (las notas del día): la búsqueda semántica
  // no sirve para "qué hay de nuevo" y devolvía notas sin relación con la consulta.
  const retrieval = input.digest
    ? { chunks: input.digest.chunks, widened: false }
    : await deps.retriever.retrieve({
        knowledgeBaseId: config.corpus.knowledgeBaseId,
        query: input.question,
        retrieval: config.answering.retrieval,
        maxSources: config.answering.maxSources,
        allowedUrlHosts: config.guardrails.allowedUrlHosts,
        now: input.now,
        abortSignal: input.abortSignal,
      });
  const chunks = deps.enrichChunks ? await deps.enrichChunks(retrieval.chunks) : retrieval.chunks;
  if (!chunks.length) {
    deps.log.info('retrieval.empty', { widened: retrieval.widened });
    return noCoverageOutcome([], config, { widened: retrieval.widened });
  }

  const system = getPrompt('canonical', config.prompts.canonical);
  const dateNotice = staleDateNotice(input.question, chunks, input.today);
  if (dateNotice) deps.log.info('canonical.stale_for_question', { today: input.today });
  const userText = buildCanonicalUserMessage(input.question, chunks, input.today, dateNotice, input.digest?.notice);
  const guardrail = { id: config.guardrails.bedrockGuardrailId, version: config.guardrails.bedrockGuardrailVersion };
  const validation = { maxParagraphs: config.answering.maxParagraphs, allowedUrlHosts: config.guardrails.allowedUrlHosts };

  const generate = async (strict: boolean, formatReminder: boolean) => {
    let systemText = system;
    if (strict) systemText += getCanonicalStrictSuffix(config.prompts.canonical);
    if (formatReminder) systemText += '\n\nRECORDATORIO DE FORMATO: devolvé únicamente el JSON pedido, sin viñetas, con máximo 3 párrafos.';
    const result = await deps.models.converse({
      modelId: input.model,
      system: systemText,
      userText,
      maxTokens: 900,
      temperature: 0,
      cacheSystem: true,
      abortSignal: input.abortSignal,
    });
    calls.push({ model: input.model, purpose: 'canonical', usage: result.usage, costUsd: costUsd(config.pricing, input.model, result.usage), latencyMs: result.latencyMs });
    const parsed = parseJsonObject<CanonicalJson>(result.text);
    if (!parsed || typeof parsed.answer !== 'string' || !parsed.answer.trim()) return undefined;
    return {
      answer: parsed.answer.trim(),
      usedChunks: asIndexes(parsed.usedChunks, chunks.length),
      hadCoverage: parsed.hadCoverage !== false && !startsWithNoCoverage(parsed.answer),
    };
  };

  let draft = await generate(false, false);
  let retried = false;
  if (!draft || validateAnswerText(draft.answer, validation).length) {
    deps.log.warn('canonical.format_retry', { parsed: Boolean(draft) });
    draft = await generate(false, true);
    retried = true;
    if (!draft || validateAnswerText(draft.answer, validation).length) {
      deps.log.warn('canonical.format_failed');
      return noCoverageOutcome(chunks, config, { calls, retried, widened: retrieval.widened });
    }
  }

  if (!draft.hadCoverage) {
    const related = sanitizeSources(sourcesFromChunks(chunks, draft.usedChunks), config.guardrails.allowedUrlHosts).slice(0, 2);
    const answer = startsWithNoCoverage(draft.answer) ? draft.answer : `${NO_COVERAGE_MESSAGE} ${draft.answer}`.trim();
    return { answer, hadCoverage: false, sources: related, usedChunks: draft.usedChunks, chunks, calls, groundingFailed: false, retried, widened: retrieval.widened };
  }

  // El grounding se mide contra TODOS los fragmentos recuperados, no solo los citados: los
  // modelos chicos citan índices de más o de menos y eso hundía el puntaje de respuestas
  // correctas (0,33 vs 0,77 en la misma respuesta). Las fuentes que ve el lector sí salen de
  // los índices citados.
  const groundingSources = () => chunks.map((chunk) => `${chunk.title}\n${chunk.text}`);

  // El cierre de cortesía no está en ninguna fuente y hundía el puntaje (0,97 → 0,63 medido
  // contra el guardrail): se mide el sustento de lo que se afirma, no de la invitación a leer.
  /**
   * El filtro de relevancia pregunta "¿este texto contesta esta pregunta?". Para una pregunta
   * concreta es una buena red; para un panorama es una pregunta mal planteada: se contesta por
   * amplitud y ninguna oración suelta repite el tema. Medido el 15/9/2026 con "Noticias sobre
   * partidos políticos Uruguay", un resumen correcto de cuatro notas dio sustento 0,97 y
   * relevancia 0,03, y el lector se quedaba sin resumen. El sustento, que es el que protege de
   * la invención, sigue mandando en los dos casos.
   */
  const blocked = (check: GroundingCheck): boolean =>
    input.digest ? Boolean(check.groundingBlocked ?? !check.passed) || check.blockedByContent : !check.passed;

  let grounding = await deps.guard.checkGrounding(
    guardrail,
    { question: input.question, answer: withoutClosingInvitation(draft.answer), sources: groundingSources() },
    input.abortSignal,
  );
  let groundingFailed = false;
  if (blocked(grounding)) {
    groundingFailed = true;
    deps.log.warn('canonical.grounding_retry', { grounding: grounding.grounding, relevance: grounding.relevance, blockedByContent: grounding.blockedByContent });
    deps.log.metric('GroundingFailed', 1);
    if (grounding.blockedByContent) return noCoverageOutcome(chunks, config, { calls, retried, groundingFailed, widened: retrieval.widened });
    const strict = await generate(true, false);
    retried = true;
    if (!strict || !strict.hadCoverage || validateAnswerText(strict.answer, validation).length) {
      // Sin cobertura en el reintento sí es "no publicó"; el resto es un resumen que no pudimos
      // respaldar, y ahí lo honesto es entregar las notas.
      return strict && !strict.hadCoverage
        ? noCoverageOutcome(chunks, config, { calls, retried, groundingFailed, widened: retrieval.widened })
        : unverifiedOutcome(chunks, config, { calls, retried, widened: retrieval.widened, unverifiedAnswer: (strict ?? draft).answer });
    }
    grounding = await deps.guard.checkGrounding(
      guardrail,
      { question: input.question, answer: withoutClosingInvitation(strict.answer), sources: groundingSources() },
      input.abortSignal,
    );
    if (blocked(grounding)) {
      // Las dos métricas, no solo el sustento: el guardrail bloquea por cualquiera de las dos y
      // sin la relevancia en el log hay que adivinar cuál fue.
      deps.log.warn('canonical.grounding_failed_twice', { grounding: grounding.grounding, relevance: grounding.relevance });
      return unverifiedOutcome(chunks, config, { calls, retried, widened: retrieval.widened, unverifiedAnswer: strict.answer, ...(grounding.grounding !== undefined ? { groundingScore: grounding.grounding } : {}) });
    }
    draft = strict;
  }

  const sources = sanitizeSources(sourcesFromChunks(chunks, draft.usedChunks), config.guardrails.allowedUrlHosts).slice(0, config.answering.maxSources);
  if (!sources.length) {
    deps.log.warn('canonical.no_sources');
    return noCoverageOutcome(chunks, config, { calls, retried, groundingFailed, widened: retrieval.widened });
  }
  return {
    answer: draft.answer,
    hadCoverage: true,
    sources,
    usedChunks: draft.usedChunks,
    ...(grounding.grounding !== undefined ? { groundingScore: grounding.grounding } : {}),
    ...(grounding.relevance !== undefined ? { relevanceScore: grounding.relevance } : {}),
    chunks,
    calls,
    groundingFailed,
    retried,
    widened: retrieval.widened,
  };
}

export function sumUsage(calls: ModelCall[]): TokenUsage {
  return calls.reduce(
    (acc, call) => ({
      inputTokens: acc.inputTokens + call.usage.inputTokens,
      outputTokens: acc.outputTokens + call.usage.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + call.usage.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + call.usage.cacheWriteTokens,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  );
}

export function sumCost(calls: ModelCall[]): number {
  return Math.round(calls.reduce((acc, call) => acc + call.costUsd, 0) * 1_000_000) / 1_000_000;
}
