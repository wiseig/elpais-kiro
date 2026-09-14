import { logger } from '@pelp/engine/core';
import { getIngestionState, startIngestion } from './lib/corpus';
import { runtime } from './lib/runtime';

/**
 * Helper breve para una Lambda periódica: consulta el job activo una vez y, si terminó
 * con generaciones posteriores pendientes, inicia el siguiente sin hacer polling con sleeps.
 */
export async function runIngestionStatus(): Promise<{ ingestionJobId?: string; pending: boolean }> {
  const { engine } = runtime();
  const config = await engine.config.get();
  try {
    const ingestionJobId = await startIngestion(engine.store, config, `ingestion-status ${engine.now().toISOString()}`);
    engine.config.invalidate();
    const state = await getIngestionState(engine.store);
    return {
      ...(ingestionJobId ? { ingestionJobId } : {}),
      pending: state.generation > state.completedGeneration,
    };
  } catch (error) {
    logger.error('ingestion-status.failed', { error: String(error) });
    logger.metric('IngestionFailed', 1);
    throw error;
  }
}

export async function handler(): Promise<{ ingestionJobId?: string; pending: boolean }> {
  return runIngestionStatus();
}
