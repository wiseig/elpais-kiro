import type { Config, ModelCall, PoliticalBucket, ReaderProfile, ReaderRecord, WeightedId } from '@pelp/domain';
import { FRAME_IDS, NON_POLITICAL_FRAME_IDS, montevideoDay } from '@pelp/domain';
import { costUsd, parseJsonObject } from '@pelp/bedrock';
import { buildPoliticalContext, buildProfilerUserMessage, getProfilerPrompt, type ProfilerEvidence } from '@pelp/prompts';
import { logger, readerMode, type EngineDeps } from '@pelp/engine/core';
import { runtime } from './lib/runtime';

interface ProfilerJson {
  topics?: unknown;
  frames?: unknown;
  style?: { length?: unknown; dataAffinity?: unknown; tone?: unknown };
  politicalLean?: { score?: unknown; bucket?: unknown; confidence?: unknown; explicitStatements?: unknown } | null;
  confidence?: { topics?: unknown; frames?: unknown; style?: unknown };
}

const BUCKETS: PoliticalBucket[] = ['izquierda', 'centro-izquierda', 'centro', 'centro-derecha', 'derecha', 'sin-señal'];

function weighted(value: unknown, allowed?: readonly string[]): WeightedId[] {
  if (!Array.isArray(value)) return [];
  const out: WeightedId[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const id = String((item as { id?: unknown }).id ?? '').trim().toLowerCase();
    const weight = Number((item as { weight?: unknown }).weight);
    if (!id || !Number.isFinite(weight)) continue;
    if (allowed && !allowed.includes(id)) continue;
    out.push({ id, weight: Math.min(1, Math.max(0, weight)) });
  }
  return out.sort((a, b) => b.weight - a.weight).slice(0, 8);
}

function pick<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === 'string' && (options as readonly string[]).includes(value) ? (value as T) : fallback;
}

function clamp01(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** Fusiona el perfil anterior (con decaimiento por antigüedad) con la inferencia nueva. */
export function mergeWeights(previous: WeightedId[], fresh: WeightedId[], decay: number): WeightedId[] {
  const map = new Map<string, number>();
  for (const item of previous) map.set(item.id, item.weight * decay);
  for (const item of fresh) map.set(item.id, Math.max(map.get(item.id) ?? 0, item.weight));
  return [...map.entries()]
    .map(([id, weight]) => ({ id, weight: Math.round(weight * 100) / 100 }))
    .filter((item) => item.weight >= 0.05)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 8);
}

export function decayFactor(previousUpdatedAt: string, now: Date, profileDecayDays: number): number {
  const ageDays = (now.getTime() - Date.parse(previousUpdatedAt)) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays <= 0) return 1;
  return Math.max(0, 1 - ageDays / profileDecayDays);
}

/** Aplica las reglas de 8.2/8.3 a la salida del modelo. */
export function applyProfilerRules(json: ProfilerJson, previous: ReaderProfile, config: Config, now: Date, evidenceCount: number): ReaderProfile {
  const decay = decayFactor(previous.updatedAt, now, config.personalization.profileDecayDays);
  const topics = mergeWeights(previous.topics, weighted(json.topics), decay);
  const frames = mergeWeights(previous.frames, weighted(json.frames, FRAME_IDS), decay);
  const style = {
    length: pick(json.style?.length, ['corta', 'media', 'larga'] as const, previous.style.length),
    dataAffinity: pick(json.style?.dataAffinity, ['baja', 'media', 'alta'] as const, previous.style.dataAffinity),
    tone: pick(json.style?.tone, ['directo', 'narrativo'] as const, previous.style.tone),
  };
  const confidence = {
    topics: clamp01(json.confidence?.topics),
    frames: clamp01(json.confidence?.frames),
    style: clamp01(json.confidence?.style),
  };
  const next: ReaderProfile = {
    ...previous,
    topics,
    frames,
    style,
    confidence,
    evidenceCount,
    updatedAt: now.toISOString(),
    version: previous.version + 1,
  };
  delete next.politicalLean;
  const lean = json.politicalLean;
  const explicit = Number(lean?.explicitStatements ?? 0);
  const leanConfidence = clamp01(lean?.confidence);
  const bucket = pick(lean?.bucket, BUCKETS, 'sin-señal');
  const onlyNonPolitical = frames.length > 0 && frames.every((frame) => NON_POLITICAL_FRAME_IDS.includes(frame.id));
  if (previous.consent.sensitiveInference) {
    // Sin esto, cuando da "sin señal" no hay forma de saber si el modelo no vio posturas o si
    // las vio y no llegó a la vara. Es la diferencia entre un umbral alto y algo roto.
    logger.info('profiler.lean', {
      readerId: previous.readerId,
      bucket,
      explicit,
      confidence: leanConfidence,
      onlyNonPolitical,
      passes: bucket !== 'sin-señal' && explicit >= 5 && leanConfidence >= 0.7 && !onlyNonPolitical,
    });
    if (bucket !== 'sin-señal' && explicit >= 5 && leanConfidence >= 0.7 && !onlyNonPolitical) {
      next.politicalLean = { score: Math.min(1, Math.max(-1, Number(lean?.score) || 0)), bucket, confidence: leanConfidence };
    } else {
      next.politicalLean = { score: 0, bucket: 'sin-señal', confidence: 0 };
    }
  }
  return next;
}

async function evidenceFor(deps: EngineDeps, reader: ReaderRecord): Promise<ProfilerEvidence> {
  const conversations = await deps.store.listConversations(reader.profile.readerId);
  const questions: ProfilerEvidence['questions'] = [];
  const feedback: ProfilerEvidence['feedback'] = [];
  for (const conversation of conversations.slice(-15)) {
    const messages = await deps.store.listMessages(conversation.convId);
    for (const message of messages) {
      questions.push({ at: message.at, text: message.questionMasked });
      const log = await deps.store.getQuestionLog(message.msgId).catch(() => undefined);
      if (log?.feedback) feedback.push({ vote: log.feedback.vote, at: log.feedback.at, ...(log.feedback.comment ? { comment: log.feedback.comment } : {}) });
    }
  }
  questions.sort((a, b) => a.at.localeCompare(b.at));
  const clicks = (await deps.store.listClicks(reader.profile.readerId, 50)).map((click) => ({ at: click.at, ...(click.title ? { title: click.title } : {}), ...(click.section ? { section: click.section } : {}) }));
  return { questions: questions.slice(-30), clicks, feedback: feedback.slice(-20) };
}

/** Perfila a un lector (8.3). Devuelve el costo de la llamada. */
export async function profileReader(deps: EngineDeps, reader: ReaderRecord, config: Config): Promise<ModelCall | undefined> {
  if (readerMode(reader) !== 'personalized') return undefined;
  const evidence = await evidenceFor(deps, reader);
  if (!evidence.questions.length) return undefined;
  const model = config.personalization.profilerModel;
  const result = await deps.models.converse({
    modelId: model,
    system: getProfilerPrompt(config.prompts.profiler, buildPoliticalContext(config.personalization.politicalContext)),
    userText: buildProfilerUserMessage(evidence),
    maxTokens: 800,
    temperature: 0,
    cacheSystem: true,
  });
  const call: ModelCall = { model, purpose: 'profiler', usage: result.usage, costUsd: costUsd(config.pricing, model, result.usage), latencyMs: result.latencyMs };
  const json = parseJsonObject<ProfilerJson>(result.text);
  if (!json) {
    logger.warn('profiler.invalid_json', { readerId: reader.profile.readerId });
    return call;
  }
  const now = deps.now();
  const profile = applyProfilerRules(json, reader.profile, config, now, evidence.questions.length);
  await deps.store.putProfileVersion(reader.profile.readerId, profile, now);
  await deps.store.saveReader({ ...reader, profile, questionsSinceProfile: 0 });
  await deps.store.addCost(montevideoDay(now), model, call.usage, call.costUsd, 'jobs');
  logger.info('profiler.updated', { readerId: reader.profile.readerId, version: profile.version, evidence: evidence.questions.length });
  return call;
}

interface ProfileDueEvent {
  detail?: { readerId?: string };
  'detail-type'?: string;
}

/** Disparo por evento ProfileDue o corrida nocturna sobre lectores con preguntas nuevas. */
export async function handler(event: ProfileDueEvent = {}): Promise<{ profiled: number }> {
  const { engine } = runtime();
  const config = await engine.config.get();
  let profiled = 0;
  if (event.detail?.readerId) {
    const reader = await engine.store.getReader(event.detail.readerId);
    if (reader && (await profileReader(engine, reader, config))) profiled += 1;
    return { profiled };
  }
  const channels = new Set<string>(['web', ...config.personalization.channels]);
  const registry = await engine.store.getChannels().catch(() => undefined);
  for (const channel of registry?.items ?? []) channels.add(channel.id);
  for (const channel of channels) {
    const readers = await engine.store.listReadersByChannel(channel, 500);
    for (const reader of readers) {
      if (reader.questionsSinceProfile <= 0) continue;
      try {
        if (await profileReader(engine, reader, config)) profiled += 1;
      } catch (error) {
        logger.error('profiler.failed', { readerId: reader.profile.readerId, error: String(error) });
      }
    }
  }
  logger.metric('ReadersProfiled', profiled);
  return { profiled };
}
