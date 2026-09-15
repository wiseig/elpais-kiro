import type {
  Answer,
  AnswerBlock,
  BlockKind,
  Config,
  ConversationRecord,
  ConversationTurn,
  CorpusIndexRecord,
  DigestSection,
  InboundMessage,
  IntentWords,
  ModelCall,
  NoticeCode,
  ReaderRecord,
  RetrievedChunk,
  SourceItem,
  VerifierVerdict,
} from '@pelp/domain';
import {
  CONSENT_TEXT_VERSIONS,
  DEFAULT_INTENT_WORDS,
  addDays,
  cleanQuestion,
  dayToEpoch,
  describeDay,
  digestSection,
  digestWindowDays,
  hourKey,
  isAnswerableSuggestion,
  isDigestRequest,
  isGreeting,
  montevideoDay,
  needsRewrite,
  normalizeQuestion,
  sectionFromUrl,
  ulid,
  wordListRegex,
} from '@pelp/domain';
import { questionHash } from '@pelp/domain/node';
import { costUsd, parseJsonObject } from '@pelp/bedrock';
import { buildOffTopicUserMessage, buildRewriteUserMessage, getDeniedTopicPrompt, getOffTopicPrompt, getPrompt } from '@pelp/prompts';
import { budgetState, noteSpend } from './budget';
import { generateCanonical, sumCost, sumUsage } from './canonical';
import type { ConfigSource } from './config';
import type { CorpusBodyGateway, EventPublisher, GuardrailGateway, ModelGateway, RetrieverGateway } from './gateways';
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
  /** Cuerpo de las notas para el panorama. Sin esto se cae al título y la bajada. */
  corpusBody?: CorpusBodyGateway;
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
  /** Hay cobertura pero el resumen no pasó el verificador de sustento. */
  unverified?: boolean;
  /** El resumen descartado, para poder revisarlo desde el backoffice. */
  unverifiedAnswer?: string;
}

function notice(
  conversationId: string,
  text: string,
  code: NoticeCode,
  httpStatus: number,
  startedAt: number,
  reader?: ReaderRecord,
  consentTextVersion?: string,
  consentMinAge?: number,
): EngineResult {
  const answer: Answer = {
    answerId: ulid(),
    conversationId,
    blocks: [{ type: 'notice', text, code }],
    hadCoverage: false,
    personalized: false,
    ...(consentTextVersion ? { consentTextVersion } : {}),
    ...(consentMinAge !== undefined ? { consentMinAge } : {}),
    latencyMs: Date.now() - startedAt,
  };
  return { answer, httpStatus, notice: code, ...(reader ? { reader } : {}) };
}

interface BlockedNoticeInput {
  config: Config;
  reader: ReaderRecord;
  inbound: InboundMessage;
  question: string;
  kind: BlockKind;
  text: string;
  code: NoticeCode;
  day: string;
  startedAt: number;
  calls: ModelCall[];
}

/**
 * Aviso por bloqueo que además queda en el log de preguntas (con `blocked`), para que el lector
 * pueda puntuarlo y el backoffice lo vea entre las preguntas del día.
 */
async function blockedNotice(deps: EngineDeps, input: BlockedNoticeInput): Promise<EngineResult> {
  const now = deps.now();
  const msgId = ulid(now.getTime());
  const at = new Date(Date.parse(now.toISOString())).toISOString();
  const personalizedMode = readerMode(input.reader) === 'personalized';
  const latencyMs = Date.now() - input.startedAt;
  await deps.store
    .putQuestionLog({
      msgId,
      convId: input.inbound.conversationId ?? 'sin-conversacion',
      ...(personalizedMode ? { readerId: input.reader.profile.readerId } : {}),
      channel: input.inbound.channel,
      day: input.day,
      at,
      questionMasked: input.question,
      questionNormalized: normalizeQuestion(input.question),
      qnormHash: questionHash(input.question),
      hadCoverage: false,
      personalized: false,
      cached: false,
      sources: [],
      canonicalAnswer: input.text,
      topics: [],
      latencyMs,
      usage: sumUsage(input.calls),
      costUsd: sumCost(input.calls),
      model: input.config.answering.model,
      corpusVersion: input.config.corpus.version || 'initial',
      blocked: input.kind,
      turn: 0,
    })
    .catch((error: unknown) => deps.log.error('block.log_failed', { error: String(error) }));
  const answer: Answer = {
    answerId: msgId,
    conversationId: input.inbound.conversationId ?? '',
    blocks: [{ type: 'notice', text: input.text, code: input.code }],
    hadCoverage: false,
    personalized: false,
    latencyMs,
  };
  return { answer, httpStatus: 200, notice: input.code, reader: input.reader };
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
  /** Cita textual de la pregunta con la que el clasificador justificó el tema vedado. */
  evidence?: string;
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
      maxTokens: 220,
      temperature: 0,
      cacheSystem: true,
    });
    const call: ModelCall = { model, purpose: 'classifier', usage: result.usage, costUsd: costUsd(config.pricing, model, result.usage), latencyMs: result.latencyMs };
    const parsed = parseJsonObject<{ offTopic?: unknown; confidence?: unknown; deniedTopic?: unknown; evidence?: unknown }>(result.text);
    const confidence = typeof parsed?.confidence === 'number' ? parsed.confidence : 0;
    const offTopic = parsed?.offTopic === true && confidence >= classifier.threshold;
    const candidate = matchDeniedTopic(parsed?.deniedTopic, config.guardrails.deniedTopics);
    const evidence = typeof parsed?.evidence === 'string' ? parsed.evidence.trim().slice(0, 160) : undefined;
    const calls = [call];
    if (!candidate) return { offTopic, calls };

    const confirmation = await confirmDeniedTopic(deps, config, question, candidate);
    if (confirmation.call) calls.push(confirmation.call);
    if (!confirmation.match) {
      deps.log.warn('classifier.denied_topic_rejected', { topic: candidate, evidence: evidence ?? null });
      return { offTopic, calls };
    }
    deps.log.info('classifier.denied_topic', { topic: candidate, evidence: evidence ?? null });
    return { offTopic, deniedTopic: candidate, ...(evidence ? { evidence } : {}), calls };
  } catch (error) {
    deps.log.warn('classifier.failed', { error: String(error) });
    return { offTopic: false, calls: [] };
  }
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Los lectores escriben temas sueltos ("Valentina Cancela", "Ataque Facultad Medicina"). Sin
 * forma de pregunta, el modelo canónico contestaba "El País no publicó sobre esto" y el filtro
 * de relevancia del guardrail puntuaba bajísimo. Se convierte en pregunta explícita para
 * responder y medir relevancia; el texto original se guarda en el log y es lo que va al índice.
 *
 * La forma importa. El envoltorio era "¿Qué publicó El País sobre X?" y el 15/9/2026 se midió que
 * arruinaba las dos cosas: en el índice vectorial, "El País" pesaba más que el tema y "El País
 * cumple 108 años" salía primera o segunda para clima, tiempo hoy, Frigorífico Tacuarembó, Expo
 * Prado y dólar; y en el filtro de relevancia, un pronóstico correcto daba 0,02 contra esa
 * pregunta (espera una respuesta sobre publicaciones) y 1,0 contra "¿Qué se sabe sobre clima?".
 * Peor: para pasar la relevancia el modelo abría con "El País publicó pronósticos para los días
 * 13, 14 y 15", que ninguna nota afirma, y el sustento caía de 0,86 a 0,13.
 */
export function asExplicitQuestion(text: string, words: IntentWords = DEFAULT_INTENT_WORDS): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return trimmed;
  if (trimmed.includes('?') || trimmed.includes('¿')) return trimmed;
  // Un tema suelto son pocas palabras. Con el límite en 12 se envolvían pedidos enteros
  // ("Haceme un resumen de las noticias del día de hoy" salía como "¿Qué publicó El País
  // sobre haceme un resumen…?", que no significa nada y no recuperaba nada útil).
  if (trimmed.split(' ').length > words.topicMaxWords) return trimmed;
  if (wordListRegex(words.questionMarkers)?.test(normalizeForMatch(trimmed))) return trimmed;
  return `¿Qué se sabe sobre ${trimmed.replace(/[.;,]+$/, '')}?`;
}

/** Formas en que los modelos suelen decir "ninguno" en vez de devolver null. */
const NO_TOPIC_SENTINELS = new Set([
  'no', 'none', 'null', 'nil', 'na', 'n/a', 'ninguno', 'ninguna', 'nada', 'false', 'undefined', 'no aplica', 'sin tema', 'not applicable',
]);

function matchWords(value: string): string[] {
  return value.split(/[^a-z0-9]+/).filter((word) => word.length >= 5);
}

/**
 * El clasificador solo puede vedar temas de la lista configurada: si devuelve otra cosa
 * (por ejemplo "receta") o un "ninguno" disfrazado, se ignora y la pregunta sigue el camino
 * normal. Compara la frase completa o palabras enteras de al menos 5 letras, sin acentos.
 */
export function matchDeniedTopic(candidate: unknown, configured: readonly string[]): string | undefined {
  if (typeof candidate !== 'string') return undefined;
  const wanted = normalizeForMatch(candidate).replace(/\s+/g, ' ').trim();
  if (wanted.length < 4 || NO_TOPIC_SENTINELS.has(wanted)) return undefined;
  const wantedWords = new Set(matchWords(wanted));
  for (const topic of configured) {
    const normalizedTopic = normalizeForMatch(topic).replace(/\s+/g, ' ').trim();
    if (!normalizedTopic) continue;
    if (wanted === normalizedTopic || wanted.includes(normalizedTopic)) return topic;
    if (matchWords(normalizedTopic).some((word) => wantedWords.has(word))) return topic;
  }
  return undefined;
}

/**
 * Segunda pasada antes de vedar un tema: el clasificador de alcance propone y esta pregunta
 * cerrada confirma. Nova Lite rellenaba `deniedTopic` con el primer tema de la lista ante
 * cualquier pregunta rara (marcó "apuestas" en preguntas sobre ajedrez o sobre Apple), y la
 * cita textual no alcanzaba porque copiaba cualquier fragmento. Si la confirmación falla, la
 * pregunta sigue el camino normal: el guardrail de Bedrock es la capa base (ADR 0004).
 */
async function confirmDeniedTopic(
  deps: EngineDeps,
  config: Config,
  question: string,
  topic: string,
): Promise<{ match: boolean; call?: ModelCall }> {
  const model = config.guardrails.offTopicClassifier.model;
  try {
    const result = await deps.models.converse({
      modelId: model,
      system: getDeniedTopicPrompt(config.prompts.offTopic, topic),
      userText: buildOffTopicUserMessage(question),
      maxTokens: 120,
      temperature: 0,
    });
    const call: ModelCall = {
      model,
      purpose: 'classifier',
      usage: result.usage,
      costUsd: costUsd(config.pricing, model, result.usage),
      latencyMs: result.latencyMs,
    };
    const parsed = parseJsonObject<{ match?: unknown }>(result.text);
    return { match: parsed?.match === true, call };
  } catch (error) {
    deps.log.warn('classifier.denied_topic_confirm_failed', { error: String(error), topic });
    return { match: false };
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
 * La Knowledge Base guarda solo lo que la búsqueda necesita: la foto y la bajada de cada nota
 * salen del índice del corpus (S3 Vectors corta la metadata filtrable en ~1 KB y descartaba
 * las notas con URL de imagen larga). Falla en silencio: sin foto, la fuente se ve igual.
 */
/** Opciones del panorama, tal como vienen de la configuración. */
type DigestOptions = Config['intents']['digest'];

/** Las listas de la configuración, con la forma que esperan los detectores del dominio. */
export function intentWords(config: Config): IntentWords {
  const { intents } = config;
  return {
    questionMarkers: intents.questionMarkers,
    topicMaxWords: intents.topicMaxWords,
    digestWords: intents.digest.words,
    digestToday: intents.digest.today,
    digestStandalone: intents.digest.standalone,
    digestMaxWords: intents.digest.maxWords,
    digestFiller: intents.digest.filler,
    digestSections: intents.digest.sections,
    greetings: intents.greetings,
  };
}

/** "opinion/la-clave" es sección "opinion" a efectos de agrupar. */
function baseSection(section: string): string {
  return section.split('/')[0] ?? section;
}

/**
 * Una ronda por sección en orden editorial, así ninguna copa el panorama. El índice guarda las
 * notas por fecha, no por hora, de modo que "las más nuevas" sería un recorte arbitrario.
 */
export function pickForDigest(records: CorpusIndexRecord[], options: DigestOptions): CorpusIndexRecord[] {
  const { notes: limit, skipSections, sectionOrder } = options;
  const skip = new Set(skipSections.map((section) => baseSection(section)));
  const usable = records.filter((record) => !skip.has(baseSection(record.section)));
  const pool = usable.length ? usable : records;
  const bySection = new Map<string, CorpusIndexRecord[]>();
  for (const record of pool) {
    const key = baseSection(record.section);
    const list = bySection.get(key);
    if (list) list.push(record);
    else bySection.set(key, [record]);
  }
  const sections = [...bySection.keys()].sort((a, b) => {
    const rankA = sectionOrder.indexOf(a);
    const rankB = sectionOrder.indexOf(b);
    if (rankA !== rankB) return (rankA === -1 ? sectionOrder.length : rankA) - (rankB === -1 ? sectionOrder.length : rankB);
    return a.localeCompare(b, 'es');
  });

  const picked: CorpusIndexRecord[] = [];
  for (let round = 0; picked.length < limit; round += 1) {
    let added = false;
    for (const section of sections) {
      const record = bySection.get(section)?.[round];
      if (!record) continue;
      picked.push(record);
      added = true;
      if (picked.length === limit) break;
    }
    if (!added) break;
  }
  return picked;
}

/** "informacion/judiciales" entra por el prefijo "informacion/judiciales" y por "informacion". */
function inSection(record: CorpusIndexRecord, section: DigestSection): boolean {
  // Se mira la sección guardada y la que dice la URL: el feed manda solo el primer segmento, así
  // que sin lo segundo ninguna subsección de "informacion" se puede pedir por su nombre.
  const candidates = [record.section, sectionFromUrl(record.url, record.section)];
  return section.match.some((prefix) => candidates.some((value) => value === prefix || value.startsWith(`${prefix}/`)));
}

/**
 * Fragmentos para un pedido de panorama: las notas que El País publicó hoy, sacadas del índice
 * por fecha. Si todavía no hay nada de hoy (madrugada), se cae al día anterior y el aviso lo
 * dice, para que la respuesta no fecha mal lo que cuenta.
 *
 * Cuando el pedido nombra una sección ("resumen de judiciales") se toman solo sus notas y se
 * mira más atrás: una sección chica puede no publicar nada en el día y contestar "no hay nada"
 * sería falso.
 */
async function digestForDay(
  deps: EngineDeps,
  day: string,
  options: DigestOptions,
  section?: DigestSection,
  windowDays = 1,
): Promise<{ chunks: RetrievedChunk[]; notice: string } | undefined> {
  const fromIndex = async (from: string, to: string) =>
    (await deps.store.listCorpusByDate(from, to, section ? 500 : 200).catch((error: unknown) => {
      deps.log.warn('digest.index_failed', { error: String(error) });
      return [] as CorpusIndexRecord[];
    })).filter((record) => !record.removed);

  if (section) return digestForSection(deps, day, options, section, fromIndex);

  // "Uruguay esta semana" mira para atrás; "hoy", solo hoy.
  if (windowDays > 1) {
    const from = addDays(day, -(windowDays - 1));
    const records = await fromIndex(from, day);
    if (!records.length) return undefined;
    const chunks = await digestChunks(deps, pickForDigest(records, options));
    return {
      chunks,
      notice:
        `Los fragmentos son ${chunks.length} de las ${records.length} notas que El País publicó entre el ` +
        `${describeDay(from)} y el ${describeDay(day)}, una selección por sección. Escribí las noticias del período: ` +
        `abrí con una oración que nombre el tema y traiga el hecho más importante, y tocá al menos ` +
        `${Math.min(5, chunks.length)} de las ${chunks.length} notas, una o dos oraciones cada una, ubicando cada hecho ` +
        `en su día. No abras describiendo el conjunto ni te metas adentro de una nota: de cada una contá lo que pasó.`,
    };
  }

  let target = day;
  let records = await fromIndex(target, target);
  if (!records.length) {
    target = addDays(day, -1);
    records = await fromIndex(target, target);
  }
  if (!records.length) return undefined;

  const chunks = await digestChunks(deps, pickForDigest(records, options));
  const notice =
    target === day
      ? `Los fragmentos son ${chunks.length} de las ${records.length} notas que El País publicó el ${describeDay(day)}, una selección por sección. Escribí las noticias del día: abrí con una oración que nombre el tema y traiga el hecho más importante, y tocá al menos ${Math.min(5, chunks.length)} de las ${chunks.length} notas, una o dos oraciones cada una. No abras describiendo el conjunto ni te metas adentro de una nota: de cada una contá lo que pasó.`
      : `Hoy es ${describeDay(day)} y todavía no hay notas publicadas, así que los fragmentos son ${chunks.length} del ${describeDay(target)}. Escribí esas noticias, abriendo con la más importante, y decí adentro del texto que son del ${describeDay(target)}.`;
  return { chunks, notice };
}

/**
 * El texto que el modelo y el guardrail van a ver de cada nota. El cuerpo se recorta: un
 * panorama de ocho notas no entra entero y la entrada es donde está lo que la nota afirma.
 */
const DIGEST_BODY_CHARS = 500;

export function digestBody(markdown: string): string {
  // El .md guardado abre con el título, una lista de metadatos y la bajada citada; el cuerpo
  // empieza después. Sin sacarlos, el fragmento se llena de "- URL: ..." y no de la noticia.
  const lines = markdown.split('\n');
  const body: string[] = [];
  for (const line of lines) {
    const text = line.trim();
    if (!text || text.startsWith('#') || text.startsWith('- ') || text.startsWith('> ')) {
      if (body.length) body.push('');
      continue;
    }
    body.push(text);
    if (body.join(' ').length >= DIGEST_BODY_CHARS) break;
  }
  return body.join(' ').replace(/\s+/g, ' ').trim().slice(0, DIGEST_BODY_CHARS);
}

/**
 * Las notas del índice como fragmentos, en el orden en que se las va a citar. Se trae el cuerpo
 * de cada una: con el titular solo, el modelo completa los cargos y los nombres de memoria y el
 * verificador de sustento tira la respuesta entera.
 */
async function digestChunks(deps: EngineDeps, records: CorpusIndexRecord[]): Promise<RetrievedChunk[]> {
  const bodies = await Promise.all(
    records.map(async (record) => {
      if (!deps.corpusBody) return undefined;
      const markdown = await deps.corpusBody.read(record.s3Key).catch(() => undefined);
      return markdown ? digestBody(markdown) : undefined;
    }),
  );
  return records.map((record, position) => ({
    // Sin cuerpo en el índice: el título y la bajada alcanzan para un panorama y son lo que
    // el guardrail va a usar para medir sustento. La fecha va adentro del texto porque el aviso
    // le pide al modelo que diga de cuándo son las notas, y el 15/9/2026 ese era justamente el
    // dato que ninguna fuente respaldaba: la misma respuesta medía 0,31 sin la fecha en la
    // fuente y 0,82 con ella, y el lector recibía "no pude armar un resumen" sobre un resumen
    // correcto.
    text: [
      `Nota publicada el ${describeDay(record.date)}.`,
      record.title,
      record.deck ?? '',
      bodies[position] ?? '',
    ]
      .filter(Boolean)
      .join(' '),
    score: 1,
    articleId: record.articleId,
    title: record.title,
    url: record.url,
    date: record.date,
    dateEpoch: dayToEpoch(record.date) || 0,
    section: record.section,
    ...(record.imageUrl ? { imageUrl: record.imageUrl } : {}),
    ...(record.deck ? { deck: record.deck } : {}),
    index: position + 1,
  }));
}

/**
 * Panorama de una sección. La lista negra de secciones no se aplica: si el lector pidió
 * Espectáculos, quiere Espectáculos. Las más nuevas primero, y el aviso dice desde cuándo son
 * para que la respuesta no presente como de hoy una nota de hace tres días.
 */
async function digestForSection(
  deps: EngineDeps,
  day: string,
  options: DigestOptions,
  section: DigestSection,
  fromIndex: (from: string, to: string) => Promise<CorpusIndexRecord[]>,
): Promise<{ chunks: RetrievedChunk[]; notice: string } | undefined> {
  const since = addDays(day, -(options.sectionDays - 1));
  const records = (await fromIndex(since, day))
    .filter((record) => inSection(record, section))
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!records.length) return undefined;

  const name = section.names[0] ?? '';
  const picked = records.slice(0, options.notes);
  const chunks = await digestChunks(deps, picked);
  const oldest = picked[picked.length - 1]?.date ?? day;
  const newest = picked[0]?.date ?? day;
  const when =
    newest === day
      ? `publicadas el ${describeDay(day)}${oldest === newest ? '' : ` y días anteriores, la más vieja del ${describeDay(oldest)}`}`
      : `publicadas entre el ${describeDay(oldest)} y el ${describeDay(newest)}: hoy es ${describeDay(day)} y la sección no tiene notas de hoy`;
  return {
    chunks,
    // El aviso no se describe a sí mismo: el modelo copia su encuadre, y cuando el aviso decía
    // "el panorama de la sección X", abría con "el panorama de la sección X incluye:". Medido el
    // 15/9/2026, esa apertura costaba 0,09 de sustento y 0,16 de relevancia, que era justo el
    // margen que faltaba para pasar.
    notice: `Los fragmentos son ${chunks.length} de las ${records.length} notas de ${name} que El País publicó, ${when}. Escribí las noticias: abrí con una oración que nombre el tema y traiga el hecho más importante, y tocá al menos ${Math.min(5, chunks.length)} de las ${chunks.length} notas, una o dos oraciones cada una, con los nombres y cargos tal como figuran en los fragmentos y ubicando cada hecho en su día. No abras describiendo el conjunto, la sección ni las fechas. No te metas adentro de una nota ni copies enumeraciones que traiga: de cada una contá lo que pasó, no su letra chica.`,
  };
}

/**
 * El índice del corpus en DynamoDB lo escribe el sync en el momento; la metadata del índice
 * vectorial espera a que termine la ingestión. Cuando no coinciden, manda la base: es la que
 * tiene la fecha, el título y la sección de verdad.
 */
async function enrichChunks(deps: EngineDeps, chunks: RetrievedChunk[]): Promise<RetrievedChunk[]> {
  if (!chunks.length) return chunks;
  return Promise.all(
    chunks.map(async (chunk) => {
      const record = await deps.store.getCorpusIndex(chunk.articleId).catch((error: unknown) => {
        deps.log.warn('corpus.enrich_failed', { error: String(error) });
        return undefined;
      });
      if (!record || record.removed) return chunk;
      if (record.date !== chunk.date) {
        deps.log.info('corpus.stale_chunk_date', { articleId: chunk.articleId, index: chunk.date, corpus: record.date });
      }
      return {
        ...chunk,
        date: record.date,
        // `dayToEpoch` da segundos, que es lo que usa el resto: el peso por recencia divide por 86400.
        dateEpoch: dayToEpoch(record.date) || chunk.dateEpoch,
        title: record.title || chunk.title,
        section: record.section || chunk.section,
        ...(record.imageUrl ? { imageUrl: record.imageUrl } : {}),
        ...(record.deck ? { deck: record.deck } : {}),
      };
    }),
  );
}

async function withCorpusExtras(deps: EngineDeps, sources: SourceItem[], chunks: RetrievedChunk[]): Promise<SourceItem[]> {
  if (!sources.length) return sources;
  const articleIdByUrl = new Map(chunks.map((chunk) => [chunk.url, chunk.articleId]));
  return Promise.all(
    sources.map(async (source) => {
      if (source.imageUrl && source.deck) return source;
      const articleId = articleIdByUrl.get(source.url);
      if (!articleId) return source;
      const record = await deps.store.getCorpusIndex(articleId).catch((error: unknown) => {
        deps.log.warn('corpus.extras_failed', { error: String(error) });
        return undefined;
      });
      if (!record) return source;
      return {
        ...source,
        ...(!source.imageUrl && record.imageUrl ? { imageUrl: record.imageUrl } : {}),
        ...(!source.deck && record.deck ? { deck: record.deck } : {}),
      };
    }),
  );
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
    const consentText = CONSENT_TEXT_VERSIONS[config.consent.textVersion];
    if (!consentText) throw new Error(`Versión de consentimiento no desplegada: ${config.consent.textVersion}`);
    return notice(
      conversationIdHint,
      consentText,
      'consent_required',
      200,
      startedAt,
      reader,
      config.consent.textVersion,
      config.consent.minAgePersonalization,
    );
  }

  const count = await deps.store.incrementRateLimit(reader.profile.readerId, hourKey(now), now);
  if (count > config.limits.perReaderPerHour) {
    await recordBlock(deps, channel, 'rate_limited', '');
    return notice(conversationIdHint, CANNED.rateLimited, 'rate_limited', 429, startedAt, reader);
  }

  const budget = await budgetState(deps.store, config, day);
  deps.log.metric('BudgetPercent', Math.round(budget.percent * 10) / 10, 'None');
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
      return blockedNotice(deps, { config, reader, inbound, question, kind: check.kinds[0] ?? 'content', text: CANNED.blocked, code: 'blocked', day, startedAt, calls: [] });
    }
    masked = check.text;
  } catch (error) {
    deps.log.error('guardrail.input_failed', { error: String(error) });
  }

  const blockedWord = blockedWordHit(masked, config.guardrails.blockedWords);
  if (blockedWord) {
    await recordBlock(deps, channel, 'blocked_word', masked, blockedWord);
    return blockedNotice(deps, { config, reader, inbound, question: masked, kind: 'blocked_word', text: CANNED.blocked, code: 'blocked', day, startedAt, calls: [] });
  }

  const intents = intentWords(config);
  // Un saludo suelto no es una consulta al corpus. Antes caía en la búsqueda y volvía como "El
  // País no publicó sobre 'hola'", que es el peor primer turno posible. Se contesta acá, sin
  // gastar un modelo y sin ensuciar la cobertura con una pregunta que nadie hizo.
  if (isGreeting(masked, intents)) {
    deps.log.metric('Greeting', 1);
    const items = await suggestions(deps.store, config, now).catch(() => [] as string[]);
    const blocks: AnswerBlock[] = [{ type: 'text', text: config.intents.greetingReply }];
    if (items.length) blocks.push({ type: 'suggestions', items: items.slice(0, 4) });
    const conversation = await loadConversation(deps, reader, inbound, now);
    return {
      answer: {
        answerId: ulid(now.getTime()),
        conversationId: conversation.convId,
        blocks,
        hadCoverage: false,
        kind: 'greeting',
        personalized: false,
        latencyMs: Date.now() - startedAt,
      },
      httpStatus: 200,
      reader,
    };
  }

  // Los temas sueltos se convierten en pregunta antes de clasificar: el clasificador marcaba
  // "FMED" o "Valentina Cancela" como fuera de alcance por no tener forma de pregunta.
  const scoped = asExplicitQuestion(masked, intents);

  const calls: ModelCall[] = [];
  const classification = await classify(deps, config, scoped);
  calls.push(...classification.calls);
  if (classification.deniedTopic) {
    await recordBlock(deps, channel, 'denied_topic', masked, `${classification.deniedTopic} · evidencia: "${classification.evidence ?? ''}"`);
    await recordCosts(deps, calls, day, channel);
    return blockedNotice(deps, { config, reader, inbound, question: masked, kind: 'denied_topic', text: CANNED.blocked, code: 'blocked', day, startedAt, calls });
  }
  if (classification.offTopic) {
    await recordBlock(deps, channel, 'off_topic', masked);
    await recordCosts(deps, calls, day, channel);
    return blockedNotice(deps, { config, reader, inbound, question: masked, kind: 'off_topic', text: CANNED.offTopic, code: 'off_topic', day, startedAt, calls });
  }

  const conversation = await loadConversation(deps, reader, inbound, now);
  const turns = (conversation.turnsData ?? []).slice(-config.answering.memoryTurns * 2);
  // La reescritura recibe lo que escribió el lector, no el texto envuelto: con "En uruguay" el
  // envoltorio le entregaba "¿Qué se sabe sobre En uruguay?", que parece una pregunta
  // completa, así que la daba por autónoma y se perdía el turno anterior (14/9/2026).
  const rewrite = await rewriteQuestion(deps, config, masked, turns);
  calls.push(...rewrite.calls);
  // La intención se mide sobre lo que escribió el lector, no sobre el texto ya envuelto: con
  // "titulares" el envoltorio sumaba "qué se sabe sobre…" y la frase dejaba de entrar
  // por corta. Se mira también la reescritura, por si el panorama aparece en una repregunta.
  const wantsDigest = isDigestRequest(masked, intents) || isDigestRequest(rewrite.question, intents);
  // "Resumen de judiciales" pide una sección entera, no un tema: se arma con sus notas en vez
  // de mandar el nombre de la sección al índice vectorial, que traía cualquier cosa.
  const section = digestSection(masked, intents) ?? digestSection(rewrite.question, intents);
  // Y con el panorama la pregunta viaja sin envolver: preguntarle al modelo por "Portada" como
  // tema lo hacía arrancar con "no publicó sobre Portada" antes del resumen.
  const standalone = wantsDigest ? cleanQuestion(masked) : asExplicitQuestion(rewrite.question, intents);
  // Al índice va el tema tal como lo escribió el lector (o su reescritura), nunca envuelto: el
  // envoltorio, cuando decía "¿Qué publicó El País sobre…?", arrastraba las notas que hablan del diario. Ver
  // CanonicalInput.retrievalQuery.
  const retrievalQuery = cleanQuestion(rewrite.question);

  const qHash = questionHash(standalone);
  const corpusVersion = config.corpus.version || 'initial';
  let canonical: CanonicalView;
  const cachedRecord = await deps.store.getCache(qHash, corpusVersion, now);
  if (cachedRecord) {
    canonical = { answer: cachedRecord.answer, hadCoverage: cachedRecord.hadCoverage, sources: cachedRecord.sources, cached: true, model: cachedRecord.model, chunksText: [], ...(cachedRecord.groundingScore !== undefined ? { groundingScore: cachedRecord.groundingScore } : {}), ...(cachedRecord.relevanceScore !== undefined ? { relevanceScore: cachedRecord.relevanceScore } : {}) };
    void deps.store.bumpCacheHit(qHash, corpusVersion);
    deps.log.metric('CacheHit', 1);
  } else {
    const digest = wantsDigest
      ? await digestForDay(deps, day, config.intents.digest, section, digestWindowDays(masked))
      : undefined;
    if (digest) deps.log.info('canonical.digest', { notes: digest.chunks.length, section: section?.names[0] ?? null });
    const generated = await generateCanonical(
      {
        models: deps.models,
        retriever: deps.retriever,
        guard: deps.guard,
        log: deps.log,
        enrichChunks: (chunks) => enrichChunks(deps, chunks),
      },
      { question: standalone, retrievalQuery, today: day, model: budget.model, config, now, ...(digest ? { digest } : {}) },
    );
    calls.push(...generated.calls);
    const sources = await withCorpusExtras(deps, generated.sources, generated.chunks);
    canonical = {
      answer: generated.answer,
      hadCoverage: generated.hadCoverage,
      sources,
      cached: false,
      model: budget.model,
      chunksText: generated.chunks.map((chunk) => chunk.text),
      ...(generated.unverified ? { unverified: true } : {}),
      ...(generated.unverifiedAnswer ? { unverifiedAnswer: generated.unverifiedAnswer } : {}),
      ...(generated.groundingScore !== undefined ? { groundingScore: generated.groundingScore } : {}),
      ...(generated.relevanceScore !== undefined ? { relevanceScore: generated.relevanceScore } : {}),
    };
    deps.log.metric('CacheHit', 0);
    if (generated.groundingFailed) deps.log.metric('GroundingRetried', 1);
    // Un pie sin verificar no se cachea: el intento siguiente puede salir bien y nadie querría
    // quedarse una hora con "no pude armar un resumen".
    if (!generated.unverified) {
      await deps.store
        .putCache(qHash, corpusVersion, { answer: generated.answer, hadCoverage: generated.hadCoverage, sources, usedChunks: generated.usedChunks, model: budget.model, createdAt: now.toISOString(), ...(generated.groundingScore !== undefined ? { groundingScore: generated.groundingScore } : {}), ...(generated.relevanceScore !== undefined ? { relevanceScore: generated.relevanceScore } : {}) }, config.answering.cacheTtlMinutes, now)
        .catch((error: unknown) => deps.log.error('cache.persist_failed', { error: String(error) }));
    }
  }

  const msgId = ulid(now.getTime());
  const at = new Date(Date.parse(now.toISOString())).toISOString();
  let finalText = canonical.answer;
  let personalized = false;
  let explain: string | undefined;
  let adaptedSuggestions: string[] = [];
  let verifierVerdict: VerifierVerdict | undefined;

  // Adaptar "no pude verificar el resumen" al perfil del lector no tiene sentido.
  const eligibility = evaluateEligibility(config, reader, channel, canonical.hadCoverage && !canonical.unverified, now);
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
        .putIncident({ id: ulid(now.getTime()), at: now.toISOString(), kind: 'PersonalizationRejected', readerId: reader.profile.readerId, msgId, questionMasked: masked, canonicalAnswer: canonical.answer, adaptedAnswer: outcome.candidate ?? '', verdict: outcome.verdict })
        .catch((error: unknown) => deps.log.error('incident.persist_failed', { error: String(error) }));
    }
  }

  const blocks: AnswerBlock[] = [{ type: 'text', text: finalText }];
  if (canonical.sources.length) blocks.push({ type: 'sources', items: canonical.sources });
  if (canonical.hadCoverage) blocks.push({ type: 'cta', text: config.answering.ctaText, url: canonical.sources[0]?.url ?? config.answering.ctaUrl });
  // Las repreguntas adaptadas se filtran y, si quedan pocas, se completan con las que ya sabemos
  // que tienen respuesta. Nunca se le ofrece al lector una pregunta que después vamos a rechazar.
  const usableSuggestions = adaptedSuggestions.filter((item) => isAnswerableSuggestion(item));
  if (usableSuggestions.length < adaptedSuggestions.length) {
    deps.log.info('suggestions.filtered', { descartadas: adaptedSuggestions.length - usableSuggestions.length });
  }
  // El relleno es solo para la respuesta adaptada: si nunca hubo repreguntas, no las inventamos.
  if (adaptedSuggestions.length && usableSuggestions.length < 2) {
    const trending = await suggestions(deps.store, config, now).catch(() => [] as string[]);
    for (const item of trending) {
      if (usableSuggestions.length >= 3) break;
      if (!usableSuggestions.includes(item)) usableSuggestions.push(item);
    }
  }
  if (usableSuggestions.length) blocks.push({ type: 'suggestions', items: usableSuggestions.slice(0, 3) });
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
      ...(input.canonical.unverifiedAnswer ? { unverifiedAnswer: input.canonical.unverifiedAnswer } : {}),
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
