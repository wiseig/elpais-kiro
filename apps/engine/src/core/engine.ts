import type {
  Answer,
  AnswerBlock,
  BlockKind,
  Config,
  ConversationRecord,
  ConversationTurn,
  InboundMessage,
  ModelCall,
  NoticeCode,
  ReaderRecord,
  SourceItem,
  VerifierVerdict,
} from '@pelp/domain';
import { CURRENT_CONSENT_TEXT, cleanQuestion, hourKey, montevideoDay, needsRewrite, normalizeQuestion, ulid } from '@pelp/domain';
import { questionHash } from '@pelp/domain/node';
import { costUsd, parseJsonObject } from '@pelp/bedrock';
import { buildOffTopicUserMessage, buildRewriteUserMessage, getOffTopicPrompt, getPrompt } from '@pelp/prompts';
import { budgetState, noteSpend } from './budget';
import { generateCanonical, sumCost, sumUsage } from './canonical';
import type { ConfigSource } from './config';
import type { EventPublisher, GuardrailGateway, ModelGateway, RetrieverGateway } from './gateways';
import type { Logger } from './log';
import { adaptAndVerify, evaluateEligibility } from './personalization';
import { needsConsent, profileSummary, readerMode, resolveReader } from './readers';
import type { Store } from './store';
import { suggestions } from './suggestions';

export interface EngineDeps {
  store: Store;
  config: ConfigSource;
  models: ModelGateway;
  retriever: RetrieverGateway;
  guard: GuardrailGateway;
  events: EventPublisher;
  log: Logger;
  now: () => Date;
}

export interface EngineResult {
  answer: Answer;
  /** Código HTTP sugerido para canales síncronos. */
  httpStatus: number;
  notice?: NoticeCode;
  reader?: ReaderRecord;
}

export const CANNED = {
  blocked: 'Sobre esto no puedo ayudarte. Podés leer la cobertura de El País en elpais.com.uy.',
  offTopic:
    'Solo respondo preguntas sobre la actualidad publicada por El País. Probá, por ejemplo: «¿Qué pasó hoy en Uruguay?» o «¿Cómo cerró el dólar?».',
  rateLimited: 'Hiciste muchas preguntas en poco tiempo. Esperá unos minutos y volvé a intentar.',
  tooLong: (max: number) => `La pregunta no puede superar los ${max} caracteres.`,
  consent: CURRENT_CONSENT_TEXT,
} as const;

interface Conversation extends ConversationRecord {
  turnsData?: ConversationTurn[];
}

interface CanonicalView {
  answer: string;
  hadCoverage: boolean;
  sources: SourceItem[];
  groundingScore?: number;
  relevanceScore?: number;
  cached: boolean;
  model: string;
  chunksText: string[];
}

function notice(conversationId: string, text: string, code: NoticeCode, httpStatus: number, startedAt: number, reader?: ReaderRecord): EngineResult {
  const answer: Answer = {
    answerId: ulid(),
    conversationId,
    blocks: [{ type: 'notice', text, code }],
    hadCoverage: false,
    personalized: false,
    latencyMs: Date.now() - startedAt,
  };
  return { answer, httpStatus, notice: code, ...(reader ? { reader } : {}) };
}

async function recordBlock(deps: EngineDeps, channel: string, kind: BlockKind, sample: string, detail?: string): Promise<void> {
  const at = deps.now().toISOString();
  await deps.store.putBlock({ id: ulid(deps.now().getTime()), at, channel, kind, sampleMasked: sample.slice(0, 200), ...(detail ? { detail } : {}) }).catch((error: unknown) => {
    deps.log.error('block.persist_failed', { error: String(error) });
  });
  deps.log.metric('Blocked', 1, 'Count', { Kind: kind });
}

async function loadConversation(deps: EngineDeps, reader: ReaderRecord, inbound: InboundMessage, now: Date): Promise<Conversation> {
  if (inbound.conversationId) {
    const existing = (await deps.store.getConversation(reader.profile.readerId, inbound.conversationId)) as Conversation | undefined;
    if (existing) return existing;
  }
  return deps.store.newConversation(reader.profile.readerId, inbound.channel, now);
}

interface RewriteOutcome {
  question: string;
  calls: ModelCall[];
}

async function rewriteQuestion(deps: EngineDeps, config: Config, question: string, turns: ConversationTurn[]): Promise<RewriteOutcome> {
  if (!config.answering.queryRewrite.enabled || !needsRewrite(question, turns.length > 0)) return { question, calls: [] };
  const model = config.answering.queryRewrite.model;
  try {
    const result = await deps.models.converse({
      modelId: model,
      system: getPrompt('rewrite', config.prompts.rewrite),
      userText: buildRewriteUserMessage(turns, question),
      maxTokens: 200,
      temperature: 0,
      cacheSystem: true,
    });
    const call: ModelCall = { model, purpose: 'rewrite', usage: result.usage, costUsd: costUsd(config.pricing, model, result.usage), latencyMs: result.latencyMs };
    const parsed = parseJsonObject<{ question?: unknown }>(result.text);
    const rewritten = typeof parsed?.question === 'string' ? cleanQuestion(parsed.question) : '';
    return { question: rewritten && rewritten.length <= 400 ? rewritten : question, calls: [call] };
  } catch (error) {
    deps.log.warn('rewrite.failed', { error: String(error) });
    return { question, calls: [] };
  }
}

interface ClassifyOutcome {
  offTopic: boolean;
  deniedTopic?: string;
  calls: ModelCall[];
}

async function classify(deps: EngineDeps, config: Config, question: string): Promise<ClassifyOutcome> {
  const classifier = config.guardrails.offTopicClassifier;
  if (!classifier.enabled) return { offTopic: false, calls: [] };
  const model = classifier.model;
  try {
    const result = await deps.models.converse({
      modelId: model,
      system: getOffTopicPrompt(config.prompts.offTopic, config.guardrails.deniedTopics),
      userText: buildOffTopicUserMessage(question),
      maxTokens: 150,
      temperature: 0,
      cacheSystem: true,
    });
    const call: ModelCall = { model, purpose: 'classifier', usage: result.usage, costUsd: costUsd(config.pricing, model, result.usage), latencyMs: result.latencyMs };
    const parsed = parseJsonObject<{ offTopic?: unknown; confidence?: unknown; deniedTopic?: unknown }>(result.text);
    const confidence = typeof parsed?.confidence === 'number' ? parsed.confidence : 0;
    const offTopic = parsed?.offTopic === true && confidence >= classifier.threshold;
    const deniedTopic = typeof parsed?.deniedTopic === 'string' && parsed.deniedTopic.trim() ? parsed.deniedTopic.trim() : undefined;
    return { offTopic, ...(deniedTopic ? { deniedTopic } : {}), calls: [call] };
  } catch (error) {
    deps.log.warn('classifier.failed', { error: String(error) });
    return { offTopic: false, calls: [] };
  }
}

function blockedWordHit(question: string, words: string[]): string | undefined {
  const lower = question.toLowerCase();
  return words.find((word) => word.trim() && lower.includes(word.trim().toLowerCase()));
}

async function recordCosts(deps: EngineDeps, calls: ModelCall[], day: string, channel: string): Promise<void> {
  const byModel = new Map<string, ModelCall[]>();
  for (const call of calls) byModel.set(call.model, [...(byModel.get(call.model) ?? []), call]);
  for (const [model, modelCalls] of byModel) {
    const usage = sumUsage(modelCalls);
    const cost = sumCost(modelCalls);
    await deps.store.addCost(day, model, usage, cost, channel).catch((error: unknown) => deps.log.error('cost.persist_failed', { error: String(error) }));
    noteSpend(day, cost);
  }
}

/**
 * Flujo de una pregunta (6.1). Devuelve siempre un Answer; los avisos (consentimiento,
 * bloqueos, límites) van como bloque `notice` con su código.
 */
export async function askQuestion(deps: EngineDeps, inbound: InboundMessage): Promise<EngineResult> {
  const startedAt = Date.now();
  const now = deps.now();
  const config = await deps.config.get();
  const channel = inbound.channel;
  const day = montevideoDay(now);
  const conversationIdHint = inbound.conversationId ?? '';

  if (!config.service.enabled) {
    return notice(conversationIdHint, config.service.maintenanceMessage, 'service_paused', 503, startedAt);
  }

  const question = cleanQuestion(inbound.text);
  if (!question) return notice(conversationIdHint, 'Escribí una pregunta para empezar.', 'too_long', 400, startedAt);
  if (question.length > config.guardrails.maxQuestionChars) {
    await recordBlock(deps, channel, 'too_long', question);
    return notice(conversationIdHint, CANNED.tooLong(config.guardrails.maxQuestionChars), 'too_long', 400, startedAt);
  }

  const reader = await resolveReader(deps.store, channel, inbound.channelUserId, now, config);
  if (needsConsent(reader, config)) {
    return notice(conversationIdHint, CANNED.consent, 'consent_required', 200, startedAt, reader);
  }

  const count = await deps.store.incrementRateLimit(reader.profile.readerId, hourKey(now), now);
  if (count > config.limits.perReaderPerHour) {
    await recordBlock(deps, channel, 'rate_limited', '');
    return notice(conversationIdHint, CANNED.rateLimited, 'rate_limited', 429, startedAt, reader);
  }

  const budget = await budgetState(deps.store, config, day);
  if (budget.paused) {
    await recordBlock(deps, channel, 'budget_paused', '');
    deps.log.metric('BudgetPercent', budget.percent, 'None');
    return notice(conversationIdHint, config.service.maintenanceMessage, 'budget_paused', 503, startedAt, reader);
  }

  const guardrail = { id: config.guardrails.bedrockGuardrailId, version: config.guardrails.bedrockGuardrailVersion };
  let masked = question;
  try {
    const check = await deps.guard.checkInput(guardrail, question);
    if (check.action === 'block') {
      await recordBlock(deps, channel, check.kinds[0] ?? 'content', question, check.detail);
      return notice(conversationIdHint, CANNED.blocked, 'blocked', 200, startedAt, reader);
    }
    masked = check.text;
  } catch (error) {
    deps.log.error('guardrail.input_failed', { error: String(error) });
  }

  const blockedWord = blockedWordHit(masked, config.guardrails.blockedWords);
  if (blockedWord) {
    await recordBlock(deps, channel, 'blocked_word', masked, blockedWord);
    return notice(conversationIdHint, CANNED.blocked, 'blocked', 200, startedAt, reader);
  }

  const calls: ModelCall[] = [];
  const classification = await classify(deps, config, masked);
  calls.push(...classification.calls);
  if (classification.deniedTopic) {
    await recordBlock(deps, channel, 'denied_topic', masked, classification.deniedTopic);
    await recordCosts(deps, calls, day, channel);
    return notice(conversationIdHint, CANNED.blocked, 'blocked', 200, startedAt, reader);
  }
  if (classification.offTopic) {
    await recordBlock(deps, channel, 'off_topic', masked);
    await recordCosts(deps, calls, day, channel);
    return notice(conversationIdHint, CANNED.offTopic, 'off_topic', 200, startedAt, reader);
  }

  const conversation = await loadConversation(deps, reader, inbound, now);
  const turns = (conversation.turnsData ?? []).slice(-config.answering.memoryTurns * 2);
  const rewrite = await rewriteQuestion(deps, config, masked, turns);
  calls.push(...rewrite.calls);
  const standalone = rewrite.question;

  const qHash = questionHash(standalone);
  const corpusVersion = config.corpus.version || 'initial';
  let canonical: CanonicalView;
  const cachedRecord = await deps.store.getCache(qHash, corpusVersion, now);
  if (cachedRecord) {
    canonical = { answer: cachedRecord.answer, hadCoverage: cachedRecord.hadCoverage, sources: cachedRecord.sources, cached: true, model: cachedRecord.model, chunksText: [], ...(cachedRecord.groundingScore !== undefined ? { groundingScore: cachedRecord.groundingScore } : {}), ...(cachedRecord.relevanceScore !== undefined ? { relevanceScore: cachedRecord.relevanceScore } : {}) };
    void deps.store.bumpCacheHit(qHash, corpusVersion);
    deps.log.metric('CacheHit', 1);
  } else {
    const generated = await generateCanonical(
      { models: deps.models, retriever: deps.retriever, guard: deps.guard, log: deps.log },
      { question: standalone, today: day, model: budget.model, config, now },
    );
    calls.push(...generated.calls);
    canonical = {
      answer: generated.answer,
      hadCoverage: generated.hadCoverage,
      sources: generated.sources,
      cached: false,
      model: budget.model,
      chunksText: generated.chunks.map((chunk) => chunk.text),
      ...(generated.groundingScore !== undefined ? { groundingScore: generated.groundingScore } : {}),
      ...(generated.relevanceScore !== undefined ? { relevanceScore: generated.relevanceScore } : {}),
    };
    deps.log.metric('CacheHit', 0);
    if (generated.groundingFailed) deps.log.metric('GroundingRetried', 1);
    await deps.store
      .putCache(qHash, corpusVersion, { answer: generated.answer, hadCoverage: generated.hadCoverage, sources: generated.sources, usedChunks: generated.usedChunks, model: budget.model, createdAt: now.toISOString(), ...(generated.groundingScore !== undefined ? { groundingScore: generated.groundingScore } : {}), ...(generated.relevanceScore !== undefined ? { relevanceScore: generated.relevanceScore } : {}) }, config.answering.cacheTtlMinutes, now)
      .catch((error: unknown) => deps.log.error('cache.persist_failed', { error: String(error) }));
  }

  const msgId = ulid(now.getTime());
  const at = new Date(Date.parse(now.toISOString())).toISOString();
  let finalText = canonical.answer;
  let personalized = false;
  let explain: string | undefined;
  let adaptedSuggestions: string[] = [];
  let verifierVerdict: VerifierVerdict | undefined;

  const eligibility = evaluateEligibility(config, reader, channel, canonical.hadCoverage, now);
  if (eligibility.eligible && eligibility.profile) {
    const outcome = await adaptAndVerify(deps.models, deps.log, {
      question: standalone,
      canonical: canonical.answer,
      sources: canonical.sources,
      profile: eligibility.profile,
      intensity: eligibility.intensity,
      config,
    });
    calls.push(...outcome.calls);
    verifierVerdict = outcome.verdict;
    if (outcome.adapted) {
      finalText = outcome.adapted.answer;
      personalized = true;
      explain = outcome.adapted.explain ?? profileSummary(reader.profile);
      adaptedSuggestions = outcome.adapted.suggestions;
    } else if (outcome.rejectedReason === 'verificador' && outcome.verdict) {
      deps.log.metric('PersonalizationRejected', 1);
      await deps.store
        .putIncident({ id: ulid(now.getTime()), at: now.toISOString(), kind: 'PersonalizationRejected', readerId: reader.profile.readerId, msgId, canonicalAnswer: canonical.answer, adaptedAnswer: '', verdict: outcome.verdict })
        .catch((error: unknown) => deps.log.error('incident.persist_failed', { error: String(error) }));
    }
  }

  const blocks: AnswerBlock[] = [{ type: 'text', text: finalText }];
  if (canonical.sources.length) blocks.push({ type: 'sources', items: canonical.sources });
  if (canonical.hadCoverage) blocks.push({ type: 'cta', text: config.answering.ctaText, url: canonical.sources[0]?.url ?? config.answering.ctaUrl });
  if (adaptedSuggestions.length) blocks.push({ type: 'suggestions', items: adaptedSuggestions });
  else if (!canonical.hadCoverage) {
    const trending = await suggestions(deps.store, config, now).catch(() => [] as string[]);
    if (trending.length) blocks.push({ type: 'suggestions', items: trending.slice(0, 3) });
  }
  if (personalized) blocks.push({ type: 'notice', text: 'Adaptada a tus intereses. Podés ver la versión neutral.', code: 'personalized' });

  const latencyMs = Date.now() - startedAt;
  const answer: Answer = {
    answerId: msgId,
    conversationId: conversation.convId,
    blocks,
    hadCoverage: canonical.hadCoverage,
    personalized,
    ...(explain ? { explain } : {}),
    ...(personalized ? { neutralAnswerId: msgId } : {}),
    latencyMs,
  };

  await persist(deps, {
    config,
    reader,
    conversation,
    turns,
    inbound,
    question: masked,
    standalone,
    canonical,
    finalText,
    personalized,
    explain,
    verifierVerdict,
    msgId,
    at,
    day,
    calls,
    latencyMs,
    qHash,
    corpusVersion,
  });

  deps.log.info('question.answered', {
    readerId: reader.profile.readerId,
    channel,
    latencyMs,
    hadCoverage: canonical.hadCoverage,
    cached: canonical.cached,
    personalized,
    tokens: sumUsage(calls),
    costUsd: sumCost(calls),
    model: canonical.model,
  });
  deps.log.metric('Questions', 1, 'Count', { Channel: channel });
  deps.log.metric('Coverage', canonical.hadCoverage ? 1 : 0);
  deps.log.metric('Latency', latencyMs, 'Milliseconds');
  deps.log.metric('CostUsd', sumCost(calls), 'None');

  return { answer, httpStatus: 200, reader };
}

interface PersistInput {
  config: Config;
  reader: ReaderRecord;
  conversation: Conversation;
  turns: ConversationTurn[];
  inbound: InboundMessage;
  question: string;
  standalone: string;
  canonical: CanonicalView;
  finalText: string;
  personalized: boolean;
  explain?: string;
  verifierVerdict?: VerifierVerdict;
  msgId: string;
  at: string;
  day: string;
  calls: ModelCall[];
  latencyMs: number;
  qHash: string;
  corpusVersion: string;
}

async function persist(deps: EngineDeps, input: PersistInput): Promise<void> {
  const { config, reader, inbound } = input;
  const now = deps.now();
  const mode = readerMode(reader);
  const personalizedMode = mode === 'personalized';
  const messageTtl = personalizedMode ? 90 * 86_400 : 86_400;
  const readerId = reader.profile.readerId;
  const topics = [...new Set(input.canonical.sources.map((source) => source.section.split('/')[0] ?? '').filter(Boolean))];

  const newTurns: ConversationTurn[] = [
    { role: 'user', text: input.question, at: input.at },
    { role: 'assistant', text: input.canonical.answer.slice(0, 600), at: input.at },
  ];
  const conversation: Conversation = {
    ...input.conversation,
    lastAt: input.at,
    turns: input.conversation.turns + 1,
    turnsData: [...input.turns, ...newTurns].slice(-config.answering.memoryTurns * 2),
  };
  await Promise.all([
    deps.store.saveConversation(readerId, conversation, now, 86_400),
    deps.store.putMessage(
      {
        msgId: input.msgId,
        convId: conversation.convId,
        ...(personalizedMode ? { readerId } : {}),
        channel: inbound.channel,
        at: input.at,
        questionMasked: input.question,
        ...(input.standalone !== input.question ? { rewrittenQuestion: input.standalone } : {}),
        canonicalAnswer: input.canonical.answer,
        ...(input.personalized ? { adaptedAnswer: input.finalText } : {}),
        personalized: input.personalized,
        hadCoverage: input.canonical.hadCoverage,
        sources: input.canonical.sources,
        ...(input.explain ? { explain: input.explain } : {}),
        ...(input.verifierVerdict ? { verifierVerdict: input.verifierVerdict } : {}),
      },
      messageTtl,
      now,
    ),
    deps.store.putQuestionLog({
      msgId: input.msgId,
      convId: conversation.convId,
      ...(personalizedMode ? { readerId } : {}),
      channel: inbound.channel,
      day: input.day,
      at: input.at,
      questionMasked: input.question,
      questionNormalized: normalizeQuestion(input.standalone),
      qnormHash: input.qHash,
      hadCoverage: input.canonical.hadCoverage,
      personalized: input.personalized,
      ...(personalizedMode && reader.cohort ? { cohort: reader.cohort } : {}),
      cached: input.canonical.cached,
      sources: input.canonical.sources,
      canonicalAnswer: input.canonical.answer,
      topics,
      latencyMs: input.latencyMs,
      usage: sumUsage(input.calls),
      costUsd: sumCost(input.calls),
      model: input.canonical.model,
      corpusVersion: input.corpusVersion,
      ...(input.canonical.groundingScore !== undefined ? { groundingScore: input.canonical.groundingScore } : {}),
      ...(input.canonical.relevanceScore !== undefined ? { relevanceScore: input.canonical.relevanceScore } : {}),
      turn: conversation.turns,
    }),
    recordCosts(deps, input.calls, input.day, inbound.channel),
  ]);

  const touched = await deps.store.touchReader(readerId, inbound.channel, now, { questions: 1 }).catch(() => undefined);
  if (personalizedMode && touched && touched.questionsSinceProfile >= config.personalization.profileEveryQuestions) {
    await deps.events.publish('ProfileDue', inbound.channel, { readerId, questionCount: touched.questionCount }).catch((error: unknown) => deps.log.warn('event.publish_failed', { error: String(error) }));
  }
}
