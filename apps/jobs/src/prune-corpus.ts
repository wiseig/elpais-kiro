import type { SyncRunRecord } from '@pelp/domain';
import { daysAgo, montevideoDay } from '@pelp/domain';
import { logger } from '@pelp/engine/core';
import { pruneCorpus, startIngestion } from './lib/corpus';
import { runtime } from './lib/runtime';

export interface PruneEvent {
  /** Tope de notas por corrida; el resto queda para la siguiente (por defecto 500). */
  limit?: number;
  /** Retención en días; por defecto la de la config (`corpus.retentionDays`). */
  retentionDays?: number;
}

/**
 * prune-corpus (ADR 0007): diario, borra del bucket, del índice y de la base de conocimiento
 * las notas anteriores a la ventana de retención. Mantiene acotado el costo de S3 Vectors,
 * que se cobra por vector guardado.
 */
export async function runPrune(event: PruneEvent = {}): Promise<{ cutoffDay: string; removed: number; more: boolean }> {
  const { engine, corpus } = runtime();
  const startedAt = engine.now().toISOString();
  const base: Omit<SyncRunRecord, 'PK' | 'SK' | 'type'> = { job: 'prune-corpus', startedAt, status: 'running', fetched: 0, written: 0, unchanged: 0 };
  await engine.store.putSyncRun(base);
  try {
    const config = await engine.config.get();
    const retentionDays = event.retentionDays ?? config.corpus.retentionDays;
    const cutoffDay = montevideoDay(daysAgo(retentionDays, engine.now()));
    const result = await pruneCorpus(corpus, { cutoffDay, ...(event.limit ? { limit: event.limit } : {}) });
    const ingestionJobId = result.removed
      ? await startIngestion(engine.store, config, `prune-corpus ${startedAt}: ${result.removed} notas`)
      : undefined;
    await engine.store.putSyncRun({
      ...base,
      status: 'ok',
      finishedAt: engine.now().toISOString(),
      fetched: result.scanned,
      written: result.removed,
      unchanged: result.scanned - result.removed,
      ...(ingestionJobId ? { ingestionJobId } : {}),
    });
    logger.info('prune.ok', { cutoffDay, retentionDays, removed: result.removed, more: result.more, ingestionJobId });
    logger.metric('CorpusPruned', result.removed);
    return { cutoffDay, removed: result.removed, more: result.more };
  } catch (error) {
    await engine.store.putSyncRun({ ...base, status: 'failed', finishedAt: engine.now().toISOString(), error: String(error).slice(0, 500) });
    logger.error('prune.failed', { error: String(error) });
    logger.metric('PruneFailed', 1);
    throw error;
  }
}

export async function handler(event: PruneEvent = {}): Promise<{ ok: boolean; removed: number; more: boolean }> {
  const { removed, more } = await runPrune(event);
  return { ok: true, removed, more };
}
