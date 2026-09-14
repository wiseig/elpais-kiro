import { ListIngestionJobsCommand } from '@aws-sdk/client-bedrock-agent';
import { daysAgo, montevideoDay } from '@pelp/domain';
import type { BackfillRequest, CorpusArticleSearchResponse, CorpusStatus, IngestionJobSummary } from '@pelp/domain/api';
import { removeArticle, startIngestion } from '@pelp/jobs';
import { HttpError, audit, invokeJob, type AdminContext } from '../context';

async function ingestionJobs(ctx: AdminContext, knowledgeBaseId: string, dataSourceId: string): Promise<IngestionJobSummary[]> {
  if (!knowledgeBaseId || !dataSourceId) return [];
  try {
    const output = await ctx.bedrockAgent.send(new ListIngestionJobsCommand({ knowledgeBaseId, dataSourceId, maxResults: 10, sortBy: { attribute: 'STARTED_AT', order: 'DESCENDING' } }));
    return (output.ingestionJobSummaries ?? []).map((job) => ({
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
  } catch (error) {
    console.warn(JSON.stringify({ level: 'warn', message: 'corpus.ingestion_jobs_failed', error: String(error) }));
    return [];
  }
}

export async function corpusStatus(ctx: AdminContext): Promise<CorpusStatus> {
  const config = await ctx.config.get();
  const [days, runs] = await Promise.all([ctx.store.listCorpusDays(60), ctx.store.listSyncRuns(20)]);
  const byDay = days.map((record) => ({ day: record.day, count: record.count })).sort((a, b) => a.day.localeCompare(b.day));
  return {
    knowledgeBaseId: config.corpus.knowledgeBaseId,
    dataSourceId: config.corpus.dataSourceId,
    corpusVersion: config.corpus.version,
    byDay,
    runs,
    ingestionJobs: await ingestionJobs(ctx, config.corpus.knowledgeBaseId, config.corpus.dataSourceId),
    totalArticles: byDay.reduce((acc, item) => acc + item.count, 0),
  };
}

export async function forceSync(ctx: AdminContext): Promise<{ started: boolean; detail?: string }> {
  const result = await invokeJob(ctx, 'JOB_SYNC_FUNCTION', { trigger: 'manual', requestedBy: ctx.actor });
  await audit(ctx, 'corpus.sync', undefined, { after: result });
  return result;
}

export async function backfill(ctx: AdminContext, body: Partial<BackfillRequest>): Promise<{ started: boolean; detail?: string }> {
  if (!body.from || !body.to || !/^\d{4}-\d{2}-\d{2}$/.test(body.from) || !/^\d{4}-\d{2}-\d{2}$/.test(body.to)) throw new HttpError(400, 'from/to deben ser YYYY-MM-DD.', 'invalid_range');
  const result = await invokeJob(ctx, 'JOB_BACKFILL_FUNCTION', { from: body.from, to: body.to, requestedBy: ctx.actor });
  await audit(ctx, 'corpus.backfill', `${body.from}..${body.to}`, { after: result });
  return result;
}

export async function searchArticles(ctx: AdminContext, q: string): Promise<CorpusArticleSearchResponse> {
  const to = montevideoDay(ctx.now);
  const from = montevideoDay(daysAgo(90, ctx.now));
  const rows = await ctx.store.listCorpusByDate(from, to, 500);
  const needle = q.trim().toLowerCase();
  const items = rows.filter((row) => !row.removed && (!needle || row.title.toLowerCase().includes(needle) || row.url.toLowerCase().includes(needle) || row.articleId === needle)).slice(0, 50);
  return { items };
}

export async function deleteArticle(ctx: AdminContext, articleId: string, reason: string | undefined): Promise<{ deleted: true }> {
  if (!reason?.trim()) throw new HttpError(400, 'El motivo es obligatorio.', 'reason_required');
  const bucket = ctx.env.CORPUS_BUCKET;
  if (!bucket) throw new HttpError(501, 'Falta CORPUS_BUCKET.', 'not_configured');
  const removed = await removeArticle({ store: ctx.store, s3: ctx.s3, bucket, now: () => ctx.now }, articleId);
  if (!removed) throw new HttpError(404, 'Nota no encontrada en el índice.', 'not_found');
  const config = await ctx.config.get();
  await startIngestion(ctx.store, config, `quitar nota ${articleId} (${ctx.actor})`).catch(() => undefined);
  await audit(ctx, 'corpus.article.delete', articleId, { reason, before: { title: removed.title, url: removed.url } });
  return { deleted: true };
}
