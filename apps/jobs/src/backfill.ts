import type { SyncRunRecord } from '@pelp/domain';
import { logger } from '@pelp/engine/core';
import { startIngestion, upsertArticles } from './lib/corpus';
import { DailyBriefClient, datesBetween } from './lib/dailybrief';
import { runtime } from './lib/runtime';

export interface BackfillEvent {
  from: string;
  to: string;
  requestedBy?: string;
}

/** backfill (5.3): carga histórica manual por rango de fechas desde la API de Daily Brief. */
export async function runBackfill(event: BackfillEvent): Promise<{ days: number; written: number; unchanged: number }> {
  const { engine, corpus } = runtime();
  const days = datesBetween(event.from, event.to);
  if (!days.length) throw new Error(`Rango inválido: ${event.from}..${event.to}`);
  const startedAt = engine.now().toISOString();
  const base: Omit<SyncRunRecord, 'PK' | 'SK' | 'type'> = { job: 'backfill', startedAt, status: 'running', fetched: 0, written: 0, unchanged: 0 };
  await engine.store.putSyncRun(base);
  try {
    const config = await engine.config.get();
    const client = await DailyBriefClient.fromSecret();
    let fetched = 0;
    let written = 0;
    let unchanged = 0;
    for (const day of days) {
      const listed = await client.listByDate(day);
      fetched += listed.length;
      const pending = [];
      for (const item of listed) {
        const indexed = await engine.store.getCorpusIndex(item.articleId);
        if (!indexed || indexed.removed) pending.push(item);
        else unchanged += 1;
      }
      if (!pending.length) continue;
      const articles = await client.fetchFull(pending, day, 'backfill');
      const result = await upsertArticles(corpus, articles);
      written += result.written;
      unchanged += result.unchanged;
      logger.info('backfill.day', { day, listed: listed.length, written: result.written });
    }
    let ingestionJobId: string | undefined;
    if (written > 0) ingestionJobId = await startIngestion(engine.store, config, `backfill ${event.from}..${event.to}: ${written} notas`);
    await engine.store.putSyncRun({ ...base, status: 'ok', finishedAt: engine.now().toISOString(), fetched, written, unchanged, ...(ingestionJobId ? { ingestionJobId } : {}) });
    return { days: days.length, written, unchanged };
  } catch (error) {
    await engine.store.putSyncRun({ ...base, status: 'failed', finishedAt: engine.now().toISOString(), error: String(error).slice(0, 500) });
    logger.error('backfill.failed', { error: String(error) });
    throw error;
  }
}

export async function handler(event: BackfillEvent): Promise<{ days: number; written: number; unchanged: number }> {
  return runBackfill(event);
}
