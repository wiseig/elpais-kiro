import type { SyncRunRecord } from '@pelp/domain';
import { montevideoDay } from '@pelp/domain';
import { logger } from '@pelp/engine/core';
import { CorpusUpsertError, startIngestion, upsertArticles } from './lib/corpus';
import { feedUrl, fetchFeed, parseFeed } from './lib/feed';
import { runtime } from './lib/runtime';

/**
 * sync-feed (5.3): cada 60 min baja el feed del día, escribe nuevos/cambiados a S3 y
 * lanza la ingestión incremental. Registra la corrida y una métrica de fallo para la alarma.
 */
export async function runSyncFeed(trigger: 'scheduled' | 'manual' = 'scheduled'): Promise<SyncRunRecord> {
  const { engine, corpus } = runtime();
  const startedAt = engine.now().toISOString();
  const previous = await engine.store.listSyncRuns(5).catch(() => []);
  const consecutive = previous.filter((run) => run.job === 'sync-feed').findIndex((run) => run.status === 'ok');
  const failuresBefore = consecutive === -1 ? previous.filter((run) => run.job === 'sync-feed').length : consecutive;
  const base: Omit<SyncRunRecord, 'PK' | 'SK' | 'type'> = { job: 'sync-feed', startedAt, status: 'running', fetched: 0, written: 0, unchanged: 0 };
  let fetched = 0;
  let written = 0;
  let unchanged = 0;
  await engine.store.putSyncRun(base);
  try {
    const config = await engine.config.get();
    const feed = await fetchFeed(await feedUrl());
    const articles = parseFeed(feed, montevideoDay(engine.now()));
    fetched = articles.length;
    const result = await upsertArticles(corpus, articles);
    written = result.written;
    unchanged = result.unchanged;
    const ingestionJobId = await startIngestion(engine.store, config, `sync-feed ${trigger} ${startedAt}: ${result.written} notas`);
    const finished: Omit<SyncRunRecord, 'PK' | 'SK' | 'type'> = {
      ...base,
      status: 'ok',
      finishedAt: engine.now().toISOString(),
      fetched,
      written,
      unchanged,
      ...(ingestionJobId ? { ingestionJobId } : {}),
      consecutiveFailures: 0,
    };
    await engine.store.putSyncRun(finished);
    logger.info('sync-feed.ok', { fetched, written, unchanged, ingestionJobId });
    logger.metric('SyncFailed', 0);
    logger.metric('FeedArticles', articles.length);
    return { ...finished, ...{ PK: '', SK: '', type: 'SyncRun' } } as SyncRunRecord;
  } catch (error) {
    const partial = error instanceof CorpusUpsertError ? error.result : undefined;
    const finished: Omit<SyncRunRecord, 'PK' | 'SK' | 'type'> = {
      ...base,
      status: 'failed',
      finishedAt: engine.now().toISOString(),
      fetched,
      written: written + (partial?.written ?? 0),
      unchanged: unchanged + (partial?.unchanged ?? 0),
      error: String(error).slice(0, 500),
      consecutiveFailures: failuresBefore + 1,
    };
    await engine.store.putSyncRun(finished);
    logger.error('sync-feed.failed', { error: String(error), consecutiveFailures: failuresBefore + 1 });
    logger.metric('SyncFailed', 1);
    throw error;
  }
}

export async function handler(event: { trigger?: 'scheduled' | 'manual' } = {}): Promise<{ ok: boolean }> {
  await runSyncFeed(event.trigger ?? 'scheduled');
  return { ok: true };
}
