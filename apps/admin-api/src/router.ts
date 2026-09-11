import { ListIngestionJobsCommand, StartIngestionJobCommand } from '@aws-sdk/client-bedrock-agent';
import { PublishCommand } from '@aws-sdk/client-sns';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type {
  AuditRecord,
  ChannelEntry,
  Config,
  ConfigRecord,
  CostRecord,
  EvalCaseRecord,
  QuestionLogRecord,
  ReaderRecord,
} from '@pelp/domain';
import { isUlid, lastDays, montevideoDay, ulid, validateConfig } from '@pelp/domain';
import type {
  AdminOverview,
  BlocksResponse,
  ConfigResponse,
  CorpusStatus,
  CostsResponse,
  EvalCaseInput,
  QuestionDetail,
  QuestionListItem,
  ReaderDetail,
  ReaderListItem,
  ReadersSummary,
  TrendingItem,
  TrendingResponse,
} from '@pelp/domain/api';
import { deleteReader, profileSummary, readerMode } from '@pelp/engine/core';
import { datesBetween } from '../../jobs/src/lib/dailybrief';
import { removeArticle } from '../../jobs/src/lib/corpus';
import { audit, type AdminContext, HttpError, intParam, invokeJob, json, parseBody, query } from './context';

const K_ANONYMITY = 20;
const DEFAULT_CHANNELS = ['web', 'whatsapp', 'discord'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

type Body = Record<string, unknown>;

function response(record: ConfigRecord): ConfigResponse {
  return { config: record.config, version: record.version, updatedAt: record.updatedAt, updatedBy: record.updatedBy };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} es requerido.`, 'invalid_request');
  return value.trim();
}

function routePath(event: APIGatewayProxyEvent): string {
  let path = event.path || '/';
  const stage = event.requestContext?.stage;
  if (stage && stage !== '$default' && path.startsWith(`/${stage}/`)) path = path.slice(stage.length + 1);
  const adminAt = path.indexOf('/admin');
  if (adminAt >= 0) path = path.slice(adminAt + '/admin'.length);
  if (!path.startsWith('/')) path = `/${path}`;
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

function daysFrom(event: APIGatewayProxyEvent, fallback = 7, max = 90): number {
  return intParam(query(event).days, fallback, 1, max);
}

async function logsForDays(ctx: AdminContext, days: number): Promise<QuestionLogRecord[]> {
  const rows = await Promise.all(lastDays(days, ctx.now).map((day) => ctx.store.listQuestionLogs(day)));
  return rows.flat().sort((a, b) => b.at.localeCompare(a.at));
}

function questionItem(log: QuestionLogRecord): QuestionListItem {
  return {
    msgId: log.msgId,
    convId: log.convId,
    channel: log.channel,
    day: log.day,
    at: log.at,
    questionMasked: log.questionMasked,
    hadCoverage: log.hadCoverage,
    personalized: log.personalized,
    ...(log.cohort ? { cohort: log.cohort } : {}),
    cached: log.cached,
    latencyMs: log.latencyMs,
    costUsd: log.costUsd,
    model: log.model,
    ...(log.feedback ? { feedback: log.feedback } : {}),
    ...(log.blocked ? { blocked: log.blocked } : {}),
    ...(log.evalMarked !== undefined ? { evalMarked: log.evalMarked } : {}),
    topics: log.topics,
    sourceCount: log.sources.length,
  };
}

function readerItem(reader: ReaderRecord): ReaderListItem {
  return {
    readerId: reader.profile.readerId,
    channel: reader.lastChannel,
    questionCount: reader.questionCount,
    lastActivityAt: reader.lastActivityAt,
    mode: readerMode(reader),
    summary: profileSummary(reader.profile) ?? 'Sin perfil inferido',
  };
}

async function allReaders(ctx: AdminContext, requestedChannel: string | undefined, limit: number): Promise<ReaderRecord[]> {
  const configured = (await ctx.store.getChannels())?.items.map((item) => item.id) ?? [];
  const channels = requestedChannel ? [requestedChannel] : [...new Set([...DEFAULT_CHANNELS, ...configured])];
  const groups = await Promise.all(channels.map((channel) => ctx.store.listReadersByChannel(channel, limit)));
  const unique = new Map<string, ReaderRecord>();
  for (const reader of groups.flat()) unique.set(reader.profile.readerId, reader);
  return [...unique.values()].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)).slice(0, limit);
}

function percentile95(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

async function getOverview(ctx: AdminContext): Promise<AdminOverview> {
  const day = montevideoDay(ctx.now);
  const [config, logs, costs, blocks, syncRuns] = await Promise.all([
    ctx.config.get(),
    ctx.store.listQuestionLogs(day),
    ctx.store.listCosts(day),
    ctx.store.listBlocks(day),
    ctx.store.listSyncRuns(1),
  ]);
  const answered = logs.filter((item) => !item.blocked);
  const totalCost = costs.reduce((sum, item) => sum + item.costUsd, 0);
  const alerts: string[] = [];
  if (totalCost >= config.limits.dailyBudgetUsd * (config.limits.budgetSoftPercent / 100)) alerts.push('Presupuesto diario cerca del límite.');
  if (!config.service.enabled) alerts.push('El servicio está pausado.');
  if (config.personalization.autoLowered) alerts.push('La intensidad de personalización fue reducida automáticamente.');
  return {
    day,
    questionsToday: logs.length,
    coverageRate: answered.length ? answered.filter((item) => item.hadCoverage).length / answered.length : 0,
    latencyP95Ms: percentile95(answered.map((item) => item.latencyMs)),
    costTodayUsd: totalCost,
    dailyBudgetUsd: config.limits.dailyBudgetUsd,
    budgetPercent: config.limits.dailyBudgetUsd ? (totalCost / config.limits.dailyBudgetUsd) * 100 : 0,
    blockedToday: blocks.length,
    personalizedToday: logs.filter((item) => item.personalized).length,
    cachedRate: answered.length ? answered.filter((item) => item.cached).length / answered.length : 0,
    ...(syncRuns[0] ? { lastSync: syncRuns[0] } : {}),
    corpusVersion: config.corpus.version,
    serviceEnabled: config.service.enabled,
    personalizationEnabled: config.personalization.enabled,
    personalizationIntensity: config.personalization.intensity,
    autoLowered: config.personalization.autoLowered,
    alerts,
  };
}

async function getConfig(ctx: AdminContext): Promise<ConfigResponse> {
  let record = await ctx.store.getConfigRecord();
  if (!record) {
    await ctx.config.get();
    record = await ctx.store.getConfigRecord();
  }
  if (!record) throw new HttpError(500, 'No se pudo inicializar la configuración.', 'config_unavailable');
  return response(record);
}

async function putConfig(ctx: AdminContext, event: APIGatewayProxyEvent): Promise<ConfigResponse> {
  const body = parseBody<Body>(event);
  const validation = validateConfig(body.config);
  if (!validation.ok || !validation.config) throw new HttpError(400, 'Configuración inválida.', 'invalid_config', { errors: validation.errors });
  if (validation.config.personalization.intensity > validation.config.personalization.hardMax && body.confirmAboveHardMax !== true) {
    throw new HttpError(409, 'La intensidad supera el máximo y requiere confirmación.', 'confirm_required', { warnings: validation.warnings });
  }
  const before = await ctx.store.getConfigRecord();
  const reason = typeof body.reason === 'string' ? body.reason.trim() || undefined : undefined;
  const record = await ctx.store.putConfig(validation.config, ctx.actor, reason);
  ctx.config.invalidate();
  await audit(ctx, 'config.update', String(record.version), { before: before?.config, after: record.config, reason });
  return response(record);
}

async function rollbackConfig(ctx: AdminContext, event: APIGatewayProxyEvent): Promise<ConfigResponse> {
  const body = parseBody<Body>(event);
  const version = typeof body.version === 'number' && Number.isInteger(body.version) ? body.version : -1;
  if (version < 1) throw new HttpError(400, 'version debe ser un entero positivo.', 'invalid_request');
  const target = await ctx.store.getConfigVersion(version);
  if (!target) throw new HttpError(404, 'Versión no encontrada.', 'not_found');
  const before = await ctx.store.getConfigRecord();
  const reason = typeof body.reason === 'string' ? body.reason.trim() || undefined : undefined;
  const record = await ctx.store.putConfig(target.config, ctx.actor, reason ?? `Rollback a versión ${version}`);
  ctx.config.invalidate();
  await audit(ctx, 'config.rollback', String(version), { before: before?.config, after: record.config, reason });
  return response(record);
}

async function getQuestions(ctx: AdminContext, event: APIGatewayProxyEvent): Promise<{ items: QuestionListItem[] }> {
  const params = query(event);
  const limit = intParam(params.limit, 100, 1, 500);
  const days = params.day ? 1 : intParam(params.days, 7, 1, 90);
  let logs = params.day && DAY_RE.test(params.day) ? await ctx.store.listQuestionLogs(params.day) : await logsForDays(ctx, days);
  if (params.channel) logs = logs.filter((item) => item.channel === params.channel);
  if (params.coverage === 'yes') logs = logs.filter((item) => item.hadCoverage);
  if (params.coverage === 'no') logs = logs.filter((item) => !item.hadCoverage);
  if (params.personalized === 'yes') logs = logs.filter((item) => item.personalized);
  if (params.personalized === 'no') logs = logs.filter((item) => !item.personalized);
  if (params.q) {
    const needle = params.q.toLocaleLowerCase('es');
    logs = logs.filter((item) => item.questionMasked.toLocaleLowerCase('es').includes(needle) || item.questionNormalized.toLocaleLowerCase('es').includes(needle));
  }
  return { items: logs.slice(0, limit).map(questionItem) };
}

async function getQuestion(ctx: AdminContext, id: string): Promise<QuestionDetail> {
  if (!isUlid(id)) throw new HttpError(404, 'Pregunta no encontrada.', 'not_found');
  const log = await ctx.store.getQuestionLog(id);
  if (!log) throw new HttpError(404, 'Pregunta no encontrada.', 'not_found');
  const message = await ctx.store.getMessage(log.convId, id);
  await audit(ctx, 'question.read', id);
  return {
    log,
    ...(message?.adaptedAnswer ? { adaptedAnswer: message.adaptedAnswer } : {}),
    ...(message?.explain ? { explain: message.explain } : {}),
    ...(message?.verifierVerdict ? { verifier: message.verifierVerdict } : {}),
  };
}

async function createEvalCase(ctx: AdminContext, input: Partial<EvalCaseInput>, existing?: EvalCaseRecord): Promise<EvalCaseRecord> {
  const question = requiredString(input.question, 'question');
  if (!Array.isArray(input.expectedUrls) || input.expectedUrls.some((url) => typeof url !== 'string')) throw new HttpError(400, 'expectedUrls debe ser una lista de strings.', 'invalid_request');
  if (typeof input.expectedCoverage !== 'boolean') throw new HttpError(400, 'expectedCoverage debe ser boolean.', 'invalid_request');
  const stringList = (value: unknown, field: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new HttpError(400, `${field} debe ser una lista de strings.`, 'invalid_request');
    return value.map(String);
  };
  const record: EvalCaseRecord = {
    PK: existing?.PK ?? '',
    SK: existing?.SK ?? '',
    type: 'EvalCase',
    id: existing?.id ?? ulid(ctx.now.getTime()),
    question,
    expectedUrls: input.expectedUrls,
    expectedCoverage: input.expectedCoverage,
    mustMention: stringList(input.mustMention, 'mustMention'),
    mustNotMention: stringList(input.mustNotMention, 'mustNotMention'),
    tags: stringList(input.tags, 'tags'),
    createdAt: existing?.createdAt ?? ctx.now.toISOString(),
    createdBy: existing?.createdBy ?? ctx.actor,
    source: existing?.source ?? 'backoffice',
  };
  await ctx.store.putEvalCase(record);
  return record;
}

async function markEval(ctx: AdminContext, id: string): Promise<{ ok: true; caseId: string }> {
  const log = await ctx.store.getQuestionLog(id);
  if (!log) throw new HttpError(404, 'Pregunta no encontrada.', 'not_found');
  const record = await createEvalCase(ctx, {
    question: log.questionMasked,
    expectedUrls: log.sources.map((source) => source.url),
    expectedCoverage: log.hadCoverage,
    tags: ['marked-from-question'],
  });
  await ctx.store.updateQuestionLog(id, { evalMarked: true });
  await audit(ctx, 'question.mark_eval', id, { after: { caseId: record.id } });
  return { ok: true, caseId: record.id };
}

async function trending(ctx: AdminContext, event: APIGatewayProxyEvent): Promise<TrendingResponse> {
  const params = query(event);
  const days = intParam(params.days, 7, 1, 90);
  let logs = (await logsForDays(ctx, days)).filter((item) => !item.blocked);
  if (params.coverage === 'yes') logs = logs.filter((item) => item.hadCoverage);
  if (params.coverage === 'no') logs = logs.filter((item) => !item.hadCoverage);
  const groups = new Map<string, QuestionLogRecord[]>();
  for (const log of logs) groups.set(log.qnormHash, [...(groups.get(log.qnormHash) ?? []), log]);
  const items: TrendingItem[] = [...groups.entries()].map(([qnormHash, entries]) => {
    const latest = entries[0]!;
    return {
      questionNormalized: latest.questionNormalized,
      qnormHash,
      count: entries.length,
      coverageRate: entries.filter((item) => item.hadCoverage).length / entries.length,
      lastAt: latest.at,
      channels: [...new Set(entries.map((item) => item.channel))].sort(),
      topics: [...new Set(entries.flatMap((item) => item.topics))].sort(),
      sample: latest.questionMasked,
    };
  }).sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt));
  const bySection: Record<string, number> = {};
  for (const log of logs) for (const topic of log.topics) bySection[topic] = (bySection[topic] ?? 0) + 1;
  return { days, items, gaps: items.filter((item) => item.coverageRate < 1), bySection };
}

async function getReaderDetail(ctx: AdminContext, id: string): Promise<ReaderDetail> {
  if (!isUlid(id)) throw new HttpError(404, 'Lector no encontrado.', 'not_found');
  const reader = await ctx.store.getReader(id);
  if (!reader) throw new HttpError(404, 'Lector no encontrado.', 'not_found');
  const [versions, consents, conversations] = await Promise.all([
    ctx.store.listProfileVersions(id),
    ctx.store.listConsents(id),
    ctx.store.listConversations(id),
  ]);
  const messages = (await Promise.all(conversations.map((conversation) => ctx.store.listMessages(conversation.convId)))).flat();
  const logs = (await Promise.all(messages.map((message) => ctx.store.getQuestionLog(message.msgId)))).filter((item): item is QuestionLogRecord => Boolean(item));
  await audit(ctx, 'reader.read', id);
  return {
    reader: readerItem(reader),
    profile: reader.profile,
    profileVersions: versions.map((version) => ({ at: version.SK.slice('PROFILEV#'.length), profile: version.profile })),
    consents: consents.map(({ at, decision, textVersion, channel }) => ({ at, decision, textVersion, channel })),
    questions: logs.sort((a, b) => b.at.localeCompare(a.at)).map(questionItem),
  };
}

function increment(map: Record<string, number>, key: string, amount = 1): void {
  map[key] = (map[key] ?? 0) + amount;
}

function suppressSmall(map: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(map).filter(([, count]) => count >= K_ANONYMITY));
}

function weekOf(at: string): string {
  const date = new Date(at);
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day);
  return date.toISOString().slice(0, 10);
}

async function readersSummary(ctx: AdminContext, event: APIGatewayProxyEvent): Promise<ReadersSummary> {
  const days = daysFrom(event, 30, 90);
  const readers = await allReaders(ctx, undefined, 500);
  const readerIds = new Set(readers.map((item) => item.profile.readerId));
  const logs = (await logsForDays(ctx, days)).filter((item) => item.readerId && readerIds.has(item.readerId));
  const byChannel: Record<string, number> = {};
  const byMode: Record<string, number> = {};
  const topics: Record<string, number> = {};
  const frames: Record<string, number> = {};
  const style: Record<string, number> = {};
  const politicalLean: Record<string, number> = {};
  const frameByTopic: Record<string, Record<string, number>> = {};
  for (const reader of readers) {
    increment(byChannel, reader.lastChannel);
    increment(byMode, readerMode(reader));
    for (const topic of reader.profile.topics) increment(topics, topic.id);
    for (const frame of reader.profile.frames) increment(frames, frame.id);
    increment(style, `length:${reader.profile.style.length}`);
    increment(style, `data:${reader.profile.style.dataAffinity}`);
    increment(style, `tone:${reader.profile.style.tone}`);
    if (reader.profile.politicalLean) increment(politicalLean, reader.profile.politicalLean.bucket);
    for (const topic of reader.profile.topics) {
      frameByTopic[topic.id] ??= {};
      for (const frame of reader.profile.frames) increment(frameByTopic[topic.id]!, frame.id);
    }
  }
  const weeklyMap = new Map<string, { readers: Set<string>; questions: number }>();
  for (const log of logs) {
    const week = weekOf(log.at);
    const entry = weeklyMap.get(week) ?? { readers: new Set<string>(), questions: 0 };
    if (log.readerId) entry.readers.add(log.readerId);
    entry.questions += 1;
    weeklyMap.set(week, entry);
  }
  const cohortNames = ['personalized', 'control'] as const;
  const cohorts = Object.fromEntries(cohortNames.map((cohort) => {
    const members = readers.filter((reader) => reader.cohort === cohort);
    const ids = new Set(members.map((reader) => reader.profile.readerId));
    const cohortLogs = logs.filter((log) => log.readerId && ids.has(log.readerId));
    const sessions = new Set(cohortLogs.map((log) => log.convId)).size;
    return [cohort, {
      readers: members.length,
      questions: cohortLogs.length,
      followUpRate: cohortLogs.length ? cohortLogs.filter((log) => log.turn > 1).length / cohortLogs.length : 0,
      clicks: 0,
      thumbsUp: cohortLogs.filter((log) => log.feedback?.vote === 'up').length,
      thumbsDown: cohortLogs.filter((log) => log.feedback?.vote === 'down').length,
      sessionsPerReader: members.length ? sessions / members.length : 0,
    }];
  })) as ReadersSummary['cohorts'];
  return {
    days,
    readers: readers.length,
    k: K_ANONYMITY,
    byChannel,
    byMode,
    topics: suppressSmall(topics),
    frames: suppressSmall(frames),
    style: suppressSmall(style),
    politicalLean: suppressSmall(politicalLean),
    cohorts,
    weekly: [...weeklyMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, value]) => ({ week, readers: value.readers.size, questions: value.questions })),
    frameByTopic: Object.fromEntries(
      Object.entries(frameByTopic).flatMap(([topic, values]) => {
        const visible = suppressSmall(values);
        return Object.keys(visible).length ? [[topic, visible] as const] : [];
      }),
    ),
  };
}

function validEvalInput(body: Partial<Body>): Partial<EvalCaseInput> {
  return body as Partial<EvalCaseInput>;
}

function validateChannel(entry: unknown): entry is ChannelEntry {
  if (!entry || typeof entry !== 'object') return false;
  const item = entry as Partial<ChannelEntry>;
  return typeof item.id === 'string' && Boolean(item.id.trim()) && typeof item.enabled === 'boolean' && Boolean(item.limits) &&
    typeof item.limits?.perUserPerHour === 'number' && item.limits.perUserPerHour > 0 &&
    typeof item.limits?.maxMessageChars === 'number' && item.limits.maxMessageChars > 0 &&
    (item.secretArn === undefined || typeof item.secretArn === 'string');
}

async function costs(ctx: AdminContext, event: APIGatewayProxyEvent): Promise<CostsResponse> {
  const days = daysFrom(event, 30, 90);
  const config = await ctx.config.get();
  const dayNames = lastDays(days, ctx.now);
  const rows = await Promise.all(dayNames.map((day) => ctx.store.listCosts(day)));
  const byModel: CostsResponse['byModel'] = {};
  const byChannel: Record<string, number> = {};
  const byDay = dayNames.map((day, index) => {
    const records = rows[index] ?? [];
    const dayModels: Record<string, number> = {};
    for (const record of records) {
      dayModels[record.model] = (dayModels[record.model] ?? 0) + record.costUsd;
      const aggregate = byModel[record.model] ?? { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
      aggregate.inputTokens += record.inputTokens;
      aggregate.outputTokens += record.outputTokens;
      aggregate.costUsd += record.costUsd;
      aggregate.calls += record.calls;
      byModel[record.model] = aggregate;
      for (const [channel, amount] of Object.entries(record.byChannel ?? {})) increment(byChannel, channel, amount);
    }
    return { day, costUsd: records.reduce((sum, item) => sum + item.costUsd, 0), calls: records.reduce((sum, item) => sum + item.calls, 0), byModel: dayModels };
  });
  const totalUsd = byDay.reduce((sum, item) => sum + item.costUsd, 0);
  const todayUsd = byDay[0]?.costUsd ?? 0;
  return {
    days,
    byDay,
    byModel,
    byChannel,
    totalUsd,
    projectedMonthUsd: (totalUsd / days) * 30,
    dailyBudgetUsd: config.limits.dailyBudgetUsd,
    todayUsd,
    todayPercent: config.limits.dailyBudgetUsd ? (todayUsd / config.limits.dailyBudgetUsd) * 100 : 0,
  };
}

async function corpusStatus(ctx: AdminContext): Promise<CorpusStatus> {
  const config = await ctx.config.get();
  const [days, runs, ingestion] = await Promise.all([
    ctx.store.listCorpusDays(60),
    ctx.store.listSyncRuns(30),
    config.corpus.knowledgeBaseId && config.corpus.dataSourceId
      ? ctx.bedrockAgent.send(new ListIngestionJobsCommand({ knowledgeBaseId: config.corpus.knowledgeBaseId, dataSourceId: config.corpus.dataSourceId, maxResults: 20 }))
      : Promise.resolve({ ingestionJobSummaries: [] }),
  ]);
  const ingestionJobs = (ingestion.ingestionJobSummaries ?? []).map((job) => ({
    id: job.ingestionJobId ?? '',
    status: job.status ?? 'UNKNOWN',
    ...(job.startedAt ? { startedAt: job.startedAt.toISOString() } : {}),
    ...(job.updatedAt ? { updatedAt: job.updatedAt.toISOString() } : {}),
    ...(job.statistics?.numberOfDocumentsScanned !== undefined ? { scanned: job.statistics.numberOfDocumentsScanned } : {}),
    ...(job.statistics?.numberOfNewDocumentsIndexed !== undefined ? { indexed: job.statistics.numberOfNewDocumentsIndexed } : {}),
    ...(job.statistics?.numberOfModifiedDocumentsIndexed !== undefined ? { modified: job.statistics.numberOfModifiedDocumentsIndexed } : {}),
    ...(job.statistics?.numberOfDocumentsDeleted !== undefined ? { deleted: job.statistics.numberOfDocumentsDeleted } : {}),
    ...(job.statistics?.numberOfDocumentsFailed !== undefined ? { failed: job.statistics.numberOfDocumentsFailed } : {}),
  }));
  return {
    knowledgeBaseId: config.corpus.knowledgeBaseId,
    dataSourceId: config.corpus.dataSourceId,
    corpusVersion: config.corpus.version,
    byDay: days.map(({ day, count }) => ({ day, count })),
    runs,
    ingestionJobs,
    totalArticles: days.reduce((sum, item) => sum + item.count, 0),
  };
}

async function startJob(ctx: AdminContext, envName: string, payload: Record<string, unknown>, action: string): Promise<{ started: true }> {
  const result = await invokeJob(ctx, envName, payload);
  if (!result.started) throw new HttpError(503, result.detail ?? 'Job no configurado.', 'job_unavailable');
  await audit(ctx, action, undefined, { after: payload });
  return { started: true };
}

function safeAudit(record: AuditRecord): AuditRecord {
  return record;
}

/** Despacho puro con contexto inyectable; auth y boundary de errores viven en index.ts. */
export async function handleAdmin(ctx: AdminContext, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const method = event.httpMethod.toUpperCase();
  const path = routePath(event);
  let result: unknown;

  if (method === 'GET' && path === '/overview') result = await getOverview(ctx);
  else if (method === 'GET' && path === '/config') result = await getConfig(ctx);
  else if (method === 'PUT' && path === '/config') result = await putConfig(ctx, event);
  else if (method === 'GET' && path === '/config/versions') {
    result = { items: (await ctx.store.listConfigVersions()).map(({ version, updatedAt, updatedBy, reason }) => ({ version, updatedAt, updatedBy, ...(reason ? { reason } : {}) })) };
  } else if (method === 'GET' && /^\/config\/versions\/\d+$/.test(path)) {
    const version = Number(path.split('/').at(-1));
    const record = await ctx.store.getConfigVersion(version);
    if (!record) throw new HttpError(404, 'Versión no encontrada.', 'not_found');
    await audit(ctx, 'config.version.read', String(version));
    result = response(record);
  } else if (method === 'POST' && path === '/config/rollback') result = await rollbackConfig(ctx, event);
  else if (method === 'GET' && path === '/questions') result = await getQuestions(ctx, event);
  else if (method === 'GET' && /^\/questions\/[^/]+$/.test(path)) result = await getQuestion(ctx, decodeURIComponent(path.split('/').at(-1)!));
  else if (method === 'POST' && /^\/questions\/[^/]+\/mark-eval$/.test(path)) result = await markEval(ctx, decodeURIComponent(path.split('/')[2]!));
  else if (method === 'GET' && path === '/trending') result = await trending(ctx, event);
  else if (method === 'POST' && path === '/trending/send') {
    const body = parseBody<Body>(event);
    const topicArn = ctx.env.TRENDING_TOPIC_ARN;
    if (!topicArn) throw new HttpError(503, 'Falta TRENDING_TOPIC_ARN.', 'job_unavailable');
    const report = await trending(ctx, { ...event, queryStringParameters: { days: String(intParam(String(body.days ?? ''), 7, 1, 90)), coverage: body.onlyGaps === true ? 'no' : 'all' } });
    await ctx.sns.send(new PublishCommand({ TopicArn: topicArn, Subject: 'Tendencias de Preguntale a El País', Message: JSON.stringify({ ...report, note: body.note }) }));
    await audit(ctx, 'trending.send', undefined, { after: { days: report.days, onlyGaps: body.onlyGaps === true } });
    result = { ok: true };
  } else if (method === 'GET' && path === '/readers/summary') result = await readersSummary(ctx, event);
  else if (method === 'GET' && path === '/readers') {
    const params = query(event);
    const limit = intParam(params.limit, 100, 1, 500);
    const readers = await allReaders(ctx, params.channel, limit);
    await audit(ctx, 'readers.list', params.channel, { after: { count: readers.length, limit } });
    result = { items: readers.map(readerItem) };
  } else if (method === 'GET' && /^\/readers\/[^/]+$/.test(path)) result = await getReaderDetail(ctx, decodeURIComponent(path.split('/').at(-1)!));
  else if (method === 'DELETE' && /^\/readers\/[^/]+$/.test(path)) {
    const id = decodeURIComponent(path.split('/').at(-1)!);
    const body = parseBody<Body>(event);
    const reason = requiredString(body.reason, 'reason');
    const reader = await ctx.store.getReader(id);
    if (!reader) throw new HttpError(404, 'Lector no encontrado.', 'not_found');
    const before = { readerId: id, channel: reader.lastChannel, questionCount: reader.questionCount, identities: reader.identities.length };
    const deleted = await deleteReader(ctx.store, reader, reader.identities, ctx.now);
    await audit(ctx, 'reader.delete', id, { before, after: deleted, reason });
    result = { deleted: true };
  } else if (method === 'GET' && path === '/bias') {
    const days = daysFrom(event, 30, 90);
    result = { days, reports: await ctx.store.listBiasReports(days) };
  } else if (method === 'GET' && path === '/personalization/incidents') {
    const rows = await Promise.all(lastDays(daysFrom(event), ctx.now).map((day) => ctx.store.listIncidents(day)));
    result = { items: rows.flat().sort((a, b) => b.at.localeCompare(a.at)) };
  } else if (method === 'GET' && path === '/evals/cases') result = { items: await ctx.store.listEvalCases() };
  else if (method === 'POST' && path === '/evals/cases') {
    const record = await createEvalCase(ctx, validEvalInput(parseBody<Body>(event)));
    await audit(ctx, 'eval_case.create', record.id, { after: record });
    result = record;
  } else if (method === 'PUT' && /^\/evals\/cases\/[^/]+$/.test(path)) {
    const id = decodeURIComponent(path.split('/').at(-1)!);
    const existing = (await ctx.store.listEvalCases()).find((item) => item.id === id);
    if (!existing) throw new HttpError(404, 'Caso no encontrado.', 'not_found');
    const record = await createEvalCase(ctx, validEvalInput(parseBody<Body>(event)), existing);
    await audit(ctx, 'eval_case.update', id, { before: existing, after: record });
    result = record;
  } else if (method === 'DELETE' && /^\/evals\/cases\/[^/]+$/.test(path)) {
    const id = decodeURIComponent(path.split('/').at(-1)!);
    const existing = (await ctx.store.listEvalCases()).find((item) => item.id === id);
    if (!existing) throw new HttpError(404, 'Caso no encontrado.', 'not_found');
    await ctx.store.deleteEvalCase(id);
    await audit(ctx, 'eval_case.delete', id, { before: existing });
    result = { deleted: true };
  } else if (method === 'POST' && path === '/evals/run') result = await startJob(ctx, 'EVALS_FUNCTION_NAME', { trigger: 'manual' }, 'evals.run');
  else if (method === 'GET' && path === '/evals/runs') result = { items: await ctx.store.listEvalRuns(intParam(query(event).limit, 20, 1, 100)) };
  else if (method === 'GET' && path === '/corpus/status') result = await corpusStatus(ctx);
  else if (method === 'POST' && path === '/corpus/sync') result = await startJob(ctx, 'SYNC_FEED_FUNCTION_NAME', { trigger: 'manual' }, 'corpus.sync');
  else if (method === 'POST' && path === '/corpus/backfill') {
    const body = parseBody<Body>(event);
    const from = requiredString(body.from, 'from');
    const to = requiredString(body.to, 'to');
    let dates: string[];
    try { dates = datesBetween(from, to); } catch { throw new HttpError(400, 'Rango de fechas inválido.', 'invalid_request'); }
    if (!dates.length || dates.length > 400) throw new HttpError(400, 'El rango debe contener entre 1 y 400 días.', 'invalid_request');
    result = await startJob(ctx, 'BACKFILL_FUNCTION_NAME', { from, to, requestedBy: ctx.actor }, 'corpus.backfill');
  } else if (method === 'GET' && path === '/corpus/articles') {
    const needle = (query(event).q ?? '').trim().toLocaleLowerCase('es');
    const from = montevideoDay(new Date(ctx.now.getTime() - 10 * 365 * 86_400_000));
    const rows = await ctx.store.listCorpusByDate(from, montevideoDay(ctx.now), 500);
    result = { items: rows.filter((item) => !item.removed && (!needle || `${item.title} ${item.url} ${item.section} ${item.articleId}`.toLocaleLowerCase('es').includes(needle))) };
  } else if (method === 'DELETE' && /^\/corpus\/articles\/[^/]+$/.test(path)) {
    const articleId = decodeURIComponent(path.split('/').at(-1)!);
    const reason = requiredString(parseBody<Body>(event).reason, 'reason');
    const bucket = ctx.env.CORPUS_BUCKET;
    if (!bucket) throw new HttpError(503, 'Falta CORPUS_BUCKET.', 'job_unavailable');
    const existing = await removeArticle({ store: ctx.store, s3: ctx.s3, bucket, now: () => ctx.now }, articleId);
    if (!existing) throw new HttpError(404, 'Artículo no encontrado.', 'not_found');
    const config = await ctx.config.get();
    if (config.corpus.knowledgeBaseId && config.corpus.dataSourceId) {
      await ctx.bedrockAgent.send(new StartIngestionJobCommand({ knowledgeBaseId: config.corpus.knowledgeBaseId, dataSourceId: config.corpus.dataSourceId, description: reason.slice(0, 200) }));
    }
    await audit(ctx, 'corpus.article.delete', articleId, { before: existing, after: { deleted: true }, reason });
    result = { deleted: true };
  } else if (method === 'GET' && path === '/guardrails/blocks') {
    const days = daysFrom(event);
    const rows = await Promise.all(lastDays(days, ctx.now).map((day) => ctx.store.listBlocks(day)));
    const items = rows.flat().sort((a, b) => b.at.localeCompare(a.at));
    const byKind: Record<string, number> = {};
    for (const item of items) increment(byKind, item.kind);
    result = { days, byKind, items } satisfies BlocksResponse;
  } else if (method === 'GET' && path === '/channels') {
    const record = await ctx.store.getChannels();
    result = { items: record?.items ?? [], ...(record?.updatedAt ? { updatedAt: record.updatedAt } : {}) };
  } else if (method === 'PUT' && path === '/channels') {
    const body = parseBody<Body>(event);
    if (!Array.isArray(body.items) || !body.items.every(validateChannel)) throw new HttpError(400, 'Lista de canales inválida.', 'invalid_request');
    const ids = body.items.map((item) => item.id.trim());
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'Los IDs de canal deben ser únicos.', 'invalid_request');
    const before = await ctx.store.getChannels();
    const items = body.items.map((item) => ({ ...item, id: item.id.trim() }));
    const updatedAt = ctx.now.toISOString();
    await ctx.store.putChannels({ items, updatedAt, updatedBy: ctx.actor });
    await audit(ctx, 'channels.update', undefined, { before: before?.items, after: items });
    result = { items, updatedAt };
  } else if (method === 'POST' && /^\/channels\/[^/]+\/test$/.test(path)) {
    const id = decodeURIComponent(path.split('/')[2]!);
    const channels = await ctx.store.getChannels();
    if (!channels?.items.some((item) => item.id === id)) throw new HttpError(404, 'Canal no encontrado.', 'not_found');
    const started = await invokeJob(ctx, 'CHANNEL_TEST_FUNCTION_NAME', { channel: id, requestedBy: ctx.actor });
    if (!started.started) throw new HttpError(503, started.detail ?? 'Prueba de canal no configurada.', 'job_unavailable');
    await audit(ctx, 'channel.test', id);
    result = { ok: true };
  } else if (method === 'GET' && path === '/costs') result = await costs(ctx, event);
  else if (method === 'GET' && path === '/audit') {
    const days = daysFrom(event, 30, 365);
    const dates = lastDays(days, ctx.now);
    const items = await ctx.store.listAudit(`${dates.at(-1)}T00:00:00.000Z`, `${dates[0]}T23:59:59.999Z`, intParam(query(event).limit, 200, 1, 500));
    result = { items: items.map(safeAudit) };
  } else {
    throw new HttpError(404, 'Ruta no encontrada.', 'not_found');
  }

  return json(200, result);
}
