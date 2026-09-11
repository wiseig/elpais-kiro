import type { SyncRunRecord } from '@pelp/domain';
import { lastDays } from '@pelp/domain';
import { logger } from '@pelp/engine/core';
import { CorpusUpsertError, startIngestion, upsertArticles } from './lib/corpus';
import { DailyBriefClient } from './lib/dailybrief';
import { runtime } from './lib/runtime';

/** reconcile-api (5.3): diario 01:00 Montevideo, agrega lo que el feed no trajo (ayer y hoy). */
export async function runReconcile(days = 2): Promise<void> {
  const { engine, corpus } = runtime();
  const startedAt = engine.now().toISOString();
  const base: Omit<SyncRunRecord, 'PK' | 'SK' | 'type'> = { job: 'reconcile-api', startedAt, status: 'running', fetched: 0, written: 0, unchanged: 0 };
  let fetched = 0;
  let written = 0;
  let unchanged = 0;
  await engine.store.putSyncRun(base);
  try {
    const config = await engine.config.get();
    if (!config.corpus.reconcileDaily) {
      await engine.store.putSyncRun({ ...base, status: 'ok', finishedAt: engine.now().toISOString(), error: 'reconcileDaily=false' });
      return;
    }
    const client = await DailyBriefClient.fromSecret();
    for (const day of lastDays(days, engine.now())) {
      const listed = await client.listByDate(day);
      fetched += listed.length;
      const missing = [];
      for (const item of listed) {
        const indexed = await engine.store.getCorpusIndex(item.articleId);
        if (!indexed || indexed.removed) missing.push(item);
      }
      unchanged += listed.length - missing.length;
      if (!missing.length) continue;
      const articles = await client.fetchFull(missing, day, 'dailybrief-api');
      const result = await upsertArticles(corpus, articles);
      written += result.written;
      unchanged += result.unchanged;
    }
    const ingestionJobId = await startIngestion(engine.store, config, `reconcile-api ${startedAt}: ${written} notas`);
    await engine.store.putSyncRun({ ...base, status: 'ok', finishedAt: engine.now().toISOString(), fetched, written, unchanged, ...(ingestionJobId ? { ingestionJobId } : {}) });
    logger.info('reconcile.ok', { fetched, written, unchanged, ingestionJobId });
    logger.metric('ReconcileFailed', 0);
  } catch (error) {
    const partial = error instanceof CorpusUpsertError ? error.result : undefined;
    await engine.store.putSyncRun({
      ...base,
      status: 'failed',
      finishedAt: engine.now().toISOString(),
      fetched,
      written: written + (partial?.written ?? 0),
      unchanged: unchanged + (partial?.unchanged ?? 0),
      error: String(error).slice(0, 500),
    });
    logger.error('reconcile.failed', { error: String(error) });
    logger.metric('ReconcileFailed', 1);
    throw error;
  }
}

export async function handler(): Promise<{ ok: boolean }> {
  await runReconcile();
  return { ok: true };
}
