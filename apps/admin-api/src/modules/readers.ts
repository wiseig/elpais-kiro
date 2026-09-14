import type { Cohort, QuestionLogRecord, ReaderRecord } from '@pelp/domain';
import { lastDays } from '@pelp/domain';
import type { CohortMetrics, ReaderDetail, ReaderListItem, ReadersSummary } from '@pelp/domain/api';
import { deleteReader, profileSummary, readerMode } from '@pelp/engine/core';
import { HttpError, audit, type AdminContext } from '../context';
import { collectLogs, toListItem } from './questions';

export const K_ANONYMITY = 20;

async function channelIds(ctx: AdminContext): Promise<string[]> {
  const registry = await ctx.store.getChannels().catch(() => undefined);
  const ids = new Set<string>(['web', 'whatsapp', 'discord']);
  for (const item of registry?.items ?? []) ids.add(item.id);
  return [...ids];
}

export async function allReaders(ctx: AdminContext, channel?: string, limit = 2000): Promise<ReaderRecord[]> {
  const channels = channel ? [channel] : await channelIds(ctx);
  const out: ReaderRecord[] = [];
  for (const id of channels) out.push(...(await ctx.store.listReadersByChannel(id, limit)));
  return out.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)).slice(0, limit);
}

function suppress(counts: Record<string, number>, k: number): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).filter(([, count]) => count >= k));
}

function isoWeek(at: string): string {
  const date = new Date(at);
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day);
  return date.toISOString().slice(0, 10);
}

function emptyCohort(): CohortMetrics {
  return { readers: 0, questions: 0, followUpRate: 0, clicks: 0, thumbsUp: 0, thumbsDown: 0, sessionsPerReader: 0 };
}

/** Panel agregado (8.5): ninguna celda con menos de K_ANONYMITY lectores. */
export async function readersSummary(ctx: AdminContext, days: number): Promise<ReadersSummary> {
  const readers = await allReaders(ctx);
  const byChannel: Record<string, number> = {};
  const byMode: Record<string, number> = {};
  const topics: Record<string, number> = {};
  const frames: Record<string, number> = {};
  const style: Record<string, number> = {};
  const politicalLean: Record<string, number> = {};
  const frameByTopic: Record<string, Record<string, number>> = {};
  let consented = 0;
  for (const reader of readers) {
    byChannel[reader.lastChannel] = (byChannel[reader.lastChannel] ?? 0) + 1;
    const mode = readerMode(reader);
    byMode[mode] = (byMode[mode] ?? 0) + 1;
    if (mode !== 'personalized') continue;
    consented += 1;
    const topTopic = reader.profile.topics[0]?.id;
    if (topTopic) topics[topTopic] = (topics[topTopic] ?? 0) + 1;
    for (const frame of reader.profile.frames.filter((item) => item.weight >= 0.3)) {
      frames[frame.id] = (frames[frame.id] ?? 0) + 1;
      if (topTopic) {
        frameByTopic[topTopic] ??= {};
        frameByTopic[topTopic]![frame.id] = (frameByTopic[topTopic]![frame.id] ?? 0) + 1;
      }
    }
    style[reader.profile.style.length] = (style[reader.profile.style.length] ?? 0) + 1;
    const bucket = reader.profile.politicalLean?.bucket ?? 'sin-señal';
    politicalLean[bucket] = (politicalLean[bucket] ?? 0) + 1;
  }
  const logs = (await collectLogs(ctx, { days })).filter((log) => !log.blocked);
  const weekly = new Map<string, { readers: Set<string>; questions: number }>();
  const cohorts: Record<Cohort, CohortMetrics> = { personalized: emptyCohort(), control: emptyCohort() };
  const cohortReaders: Record<Cohort, Set<string>> = { personalized: new Set(), control: new Set() };
  const cohortConvs: Record<Cohort, Set<string>> = { personalized: new Set(), control: new Set() };
  const followUps: Record<Cohort, number> = { personalized: 0, control: 0 };
  for (const log of logs) {
    const week = weekly.get(isoWeek(log.at)) ?? { readers: new Set<string>(), questions: 0 };
    week.questions += 1;
    if (log.readerId) week.readers.add(log.readerId);
    weekly.set(isoWeek(log.at), week);
    if (!log.cohort || !log.readerId) continue;
    const cohort = cohorts[log.cohort];
    cohort.questions += 1;
    cohortReaders[log.cohort].add(log.readerId);
    cohortConvs[log.cohort].add(log.convId);
    if (log.turn > 1) followUps[log.cohort] += 1;
    if (log.feedback?.vote === 'up') cohort.thumbsUp += 1;
    if (log.feedback?.vote === 'down') cohort.thumbsDown += 1;
  }
  const since = lastDays(days, ctx.now).at(-1) ?? '';
  for (const cohort of ['personalized', 'control'] as Cohort[]) {
    const metrics = cohorts[cohort];
    metrics.readers = cohortReaders[cohort].size;
    metrics.followUpRate = metrics.questions ? followUps[cohort] / metrics.questions : 0;
    metrics.sessionsPerReader = metrics.readers ? cohortConvs[cohort].size / metrics.readers : 0;
    let clicks = 0;
    for (const readerId of [...cohortReaders[cohort]].slice(0, 300)) {
      const items = await ctx.store.listClicks(readerId, 100).catch(() => []);
      clicks += items.filter((click) => click.at.slice(0, 10) >= since).length;
    }
    metrics.clicks = clicks;
  }
  const k = K_ANONYMITY;
  return {
    days,
    readers: readers.length,
    k,
    byChannel: suppress(byChannel, k),
    byMode: suppress(byMode, k),
    topics: suppress(topics, k),
    frames: suppress(frames, k),
    style: suppress(style, k),
    politicalLean: consented >= k ? suppress(politicalLean, k) : {},
    cohorts: {
      personalized: cohorts.personalized.readers >= k ? cohorts.personalized : { ...emptyCohort(), readers: cohorts.personalized.readers },
      control: cohorts.control.readers >= k ? cohorts.control : { ...emptyCohort(), readers: cohorts.control.readers },
    },
    weekly: [...weekly.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, value]) => ({ week, readers: value.readers.size, questions: value.questions })),
    frameByTopic: Object.fromEntries(Object.entries(frameByTopic).map(([topic, cells]) => [topic, suppress(cells, k)]).filter(([, cells]) => Object.keys(cells as Record<string, number>).length)),
  };
}

function toReaderItem(reader: ReaderRecord): ReaderListItem {
  return {
    readerId: reader.profile.readerId,
    channel: reader.lastChannel,
    questionCount: reader.questionCount,
    lastActivityAt: reader.lastActivityAt,
    mode: readerMode(reader),
    summary: profileSummary(reader.profile) ?? 'Sin perfil inferido.',
  };
}

/** Lista individual (solo admin; cada acceso se audita). */
export async function listReaders(ctx: AdminContext, channel: string | undefined, limit: number): Promise<{ items: ReaderListItem[] }> {
  const readers = await allReaders(ctx, channel, limit);
  await audit(ctx, 'readers.list', channel ?? 'all', { after: { count: readers.length } });
  return { items: readers.map(toReaderItem) };
}

export async function readerDetail(ctx: AdminContext, readerId: string): Promise<ReaderDetail> {
  const reader = await ctx.store.getReader(readerId);
  if (!reader) throw new HttpError(404, 'Lector no encontrado.', 'not_found');
  await audit(ctx, 'readers.read', readerId);
  const [versions, consents, conversations] = await Promise.all([
    ctx.store.listProfileVersions(readerId, 20),
    ctx.store.listConsents(readerId),
    ctx.store.listConversations(readerId),
  ]);
  const logs: QuestionLogRecord[] = [];
  for (const conversation of conversations.slice(-10)) {
    const messages = await ctx.store.listMessages(conversation.convId);
    for (const message of messages) {
      const log = await ctx.store.getQuestionLog(message.msgId).catch(() => undefined);
      if (log) logs.push(log);
    }
  }
  return {
    reader: toReaderItem(reader),
    profile: reader.profile,
    profileVersions: versions.map((version) => ({ at: version.SK.replace('PROFILEV#', ''), profile: version.profile })),
    consents: consents.map((consent) => ({ at: consent.at, decision: consent.decision, textVersion: consent.textVersion, channel: consent.channel })),
    questions: logs.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50).map((log) => toListItem(log)),
  };
}

export async function removeReader(ctx: AdminContext, readerId: string, reason: string | undefined): Promise<{ deleted: true }> {
  if (!reason?.trim()) throw new HttpError(400, 'El motivo es obligatorio.', 'reason_required');
  const reader = await ctx.store.getReader(readerId);
  if (!reader) throw new HttpError(404, 'Lector no encontrado.', 'not_found');
  const result = await deleteReader(ctx.store, reader, reader.identities ?? [], ctx.now);
  await audit(ctx, 'readers.delete', readerId, { reason, after: result });
  return { deleted: true };
}
