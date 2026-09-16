import type { QuestionLogRecord } from '@pelp/domain';
import { lastDays, ulid } from '@pelp/domain';
import type { QuestionDetail, QuestionListItem, QuestionsQuery } from '@pelp/domain/api';
import { HttpError, audit, type AdminContext } from '../context';
import { controlQuestions, isControlQuestion } from './control';

export function toListItem(log: QuestionLogRecord, control = false): QuestionListItem {
  return {
    ...(control ? { isControl: true } : {}),
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
    ...(log.evalMarked ? { evalMarked: true } : {}),
    topics: log.topics,
    sourceCount: log.sources.length,
  };
}

export async function collectLogs(ctx: AdminContext, params: { day?: string; days?: number }): Promise<QuestionLogRecord[]> {
  const days = params.day ? [params.day] : lastDays(Math.min(Math.max(params.days ?? 1, 1), 30), ctx.now);
  const out: QuestionLogRecord[] = [];
  for (const day of days) out.push(...(await ctx.store.listQuestionLogs(day)));
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** Separa el tráfico de lectores del de las corridas de control. */
export async function splitControl(
  ctx: AdminContext,
  logs: QuestionLogRecord[],
): Promise<{ readers: QuestionLogRecord[]; control: QuestionLogRecord[] }> {
  const keys = await controlQuestions(ctx);
  const readers: QuestionLogRecord[] = [];
  const control: QuestionLogRecord[] = [];
  for (const log of logs) (isControlQuestion(log.questionMasked, keys) ? control : readers).push(log);
  return { readers, control };
}

export async function listQuestions(
  ctx: AdminContext,
  query: QuestionsQuery & Record<string, string | number | undefined>,
): Promise<{ items: QuestionListItem[]; controlExcluded: number }> {
  const days = query.days ? Number(query.days) : undefined;
  let logs = await collectLogs(ctx, { ...(query.day ? { day: String(query.day) } : {}), ...(days ? { days } : {}) });
  if (query.channel) logs = logs.filter((log) => log.channel === query.channel);
  if (query.coverage === 'yes') logs = logs.filter((log) => log.hadCoverage);
  if (query.coverage === 'no') logs = logs.filter((log) => !log.hadCoverage);
  if (query.personalized === 'yes') logs = logs.filter((log) => log.personalized);
  if (query.personalized === 'no') logs = logs.filter((log) => !log.personalized);
  if (query.q) {
    const needle = String(query.q).toLowerCase();
    logs = logs.filter((log) => log.questionMasked.toLowerCase().includes(needle) || log.canonicalAnswer.toLowerCase().includes(needle));
  }
  // Las de control se apartan salvo que se pidan: si no, tapan el tráfico real de cada día.
  const { readers, control } = await splitControl(ctx, logs);
  const visible = query.includeControl === 'yes' ? [...readers, ...control].sort((a, b) => b.at.localeCompare(a.at)) : readers;
  const controlKeys = await controlQuestions(ctx);
  const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 1000);
  return {
    items: visible.slice(0, limit).map((log) => toListItem(log, isControlQuestion(log.questionMasked, controlKeys))),
    controlExcluded: query.includeControl === 'yes' ? 0 : control.length,
  };
}

export async function questionDetail(ctx: AdminContext, msgId: string): Promise<QuestionDetail> {
  const log = await ctx.store.getQuestionLog(msgId);
  if (!log) throw new HttpError(404, 'Pregunta no encontrada.', 'not_found');
  const message = await ctx.store.getMessage(log.convId, msgId).catch(() => undefined);
  // Los mensajes anteriores al 16/9/2026 no guardaban la adaptación rechazada: se busca en el
  // incidente del día, que sí la tiene.
  const rejectedAdaptation =
    message?.rejectedAdaptation ??
    (message?.verifierVerdict && !message.verifierVerdict.ok
      ? (await ctx.store.listIncidents(log.day).catch(() => [])).find((incident) => incident.msgId === msgId)?.adaptedAnswer
      : undefined);
  return {
    log,
    ...(message?.adaptedAnswer ? { adaptedAnswer: message.adaptedAnswer } : {}),
    ...(rejectedAdaptation ? { rejectedAdaptation } : {}),
    ...(message?.explain ? { explain: message.explain } : {}),
    ...(message?.verifierVerdict ? { verifier: message.verifierVerdict } : {}),
  };
}

/** Marca una pregunta para el set de evaluación: crea un caso con las fuentes actuales como esperadas. */
export async function markForEval(ctx: AdminContext, msgId: string): Promise<{ ok: true; caseId: string }> {
  const log = await ctx.store.getQuestionLog(msgId);
  if (!log) throw new HttpError(404, 'Pregunta no encontrada.', 'not_found');
  const caseId = `bo-${ulid(ctx.now.getTime())}`;
  await ctx.store.putEvalCase({
    id: caseId,
    question: log.questionMasked,
    expectedUrls: log.sources.map((source) => source.url),
    expectedCoverage: log.hadCoverage,
    mustMention: [],
    mustNotMention: [],
    tags: log.topics,
    createdAt: ctx.now.toISOString(),
    createdBy: ctx.actor,
    source: 'backoffice',
  });
  await ctx.store.updateQuestionLog(msgId, { evalMarked: true, evalCaseId: caseId });
  await audit(ctx, 'evals.mark', caseId, { after: { msgId } });
  return { ok: true, caseId };
}

/** Saca la pregunta del set: borra el caso creado y limpia la marca del log. */
export async function unmarkForEval(ctx: AdminContext, msgId: string): Promise<{ ok: true }> {
  const log = await ctx.store.getQuestionLog(msgId);
  if (!log) throw new HttpError(404, 'Pregunta no encontrada.', 'not_found');
  // Las marcadas antes de que se guardara el id se encuentran por su texto.
  let caseId = log.evalCaseId;
  if (!caseId) {
    const cases = await ctx.store.listEvalCases();
    caseId = cases.find((item) => item.source === 'backoffice' && item.question === log.questionMasked)?.id;
  }
  if (caseId) await ctx.store.deleteEvalCase(caseId);
  await ctx.store.updateQuestionLog(msgId, { evalMarked: false, evalCaseId: '' });
  await audit(ctx, 'evals.unmark', caseId ?? msgId, { before: { msgId } });
  return { ok: true };
}
