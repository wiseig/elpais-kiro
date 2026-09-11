import type { Config, ModelCall, RetrievedChunk, SourceItem, TokenUsage } from '@pelp/domain';
import { NO_COVERAGE_MESSAGE, sanitizeSources, startsWithNoCoverage, validateAnswerText } from '@pelp/domain';
import { costUsd, parseJsonObject, sourcesFromChunks } from '@pelp/bedrock';
import { buildCanonicalUserMessage, getCanonicalStrictSuffix, getPrompt } from '@pelp/prompts';
import type { GuardrailGateway, ModelGateway, RetrieverGateway } from './gateways';
import type { Logger } from './log';

export interface CanonicalDeps {
  models: ModelGateway;
  retriever: RetrieverGateway;
  guard: GuardrailGateway;
  log: Logger;
}

export interface CanonicalInput {
  /** Pregunta autónoma (tras reescritura) que se usa para recuperar y responder. */
  question: string;
  today: string;
  model: string;
  config: Config;
  now: Date;
  abortSignal?: AbortSignal;
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
 * Canónica (6.1, 6.2, 6.3): recuperación con filtro de recencia, generación JSON,
 * validadores de formato, grounding contextual y un reintento estricto.
 */
export async function generateCanonical(deps: CanonicalDeps, input: CanonicalInput): Promise<CanonicalOutcome> {
  const { config } = input;
  const calls: ModelCall[] = [];
  const retrieval = await deps.retriever.retrieve({
    knowledgeBaseId: config.corpus.knowledgeBaseId,
    query: input.question,
    retrieval: config.answering.retrieval,
    maxSources: config.answering.maxSources,
    allowedUrlHosts: config.guardrails.allowedUrlHosts,
    now: input.now,
    abortSignal: input.abortSignal,
  });
  const chunks = retrieval.chunks;
  if (!chunks.length) {
    deps.log.info('retrieval.empty', { widened: retrieval.widened });
    return noCoverageOutcome([], config, { widened: retrieval.widened });
  }

  const system = getPrompt('canonical', config.prompts.canonical);
  const userText = buildCanonicalUserMessage(input.question, chunks, input.today);
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

  const groundingSources = (used: number[]) => {
    const selected = used.length ? chunks.filter((chunk) => used.includes(chunk.index ?? -1)) : chunks;
    return selected.map((chunk) => `${chunk.title}\n${chunk.text}`);
  };

  let grounding = await deps.guard.checkGrounding(guardrail, { question: input.question, answer: draft.answer, sources: groundingSources(draft.usedChunks) }, input.abortSignal);
  let groundingFailed = false;
  if (!grounding.passed) {
    groundingFailed = true;
    deps.log.warn('canonical.grounding_retry', { grounding: grounding.grounding, relevance: grounding.relevance, blockedByContent: grounding.blockedByContent });
    deps.log.metric('GroundingFailed', 1);
    if (grounding.blockedByContent) return noCoverageOutcome(chunks, config, { calls, retried, groundingFailed, widened: retrieval.widened });
    const strict = await generate(true, false);
    retried = true;
    if (!strict || !strict.hadCoverage || validateAnswerText(strict.answer, validation).length) {
      return noCoverageOutcome(chunks, config, { calls, retried, groundingFailed, widened: retrieval.widened });
    }
    grounding = await deps.guard.checkGrounding(guardrail, { question: input.question, answer: strict.answer, sources: groundingSources(strict.usedChunks) }, input.abortSignal);
    if (!grounding.passed) {
      deps.log.warn('canonical.grounding_failed_twice', { grounding: grounding.grounding });
      return noCoverageOutcome(chunks, config, { calls, retried, groundingFailed, widened: retrieval.widened });
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
