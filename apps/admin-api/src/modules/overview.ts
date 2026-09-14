import type { AdminOverview } from '@pelp/domain/api';
import { montevideoDay } from '@pelp/domain';
import type { AdminContext } from '../context';
import { splitControl } from './questions';

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export async function overview(ctx: AdminContext): Promise<AdminOverview> {
  const config = await ctx.config.get();
  const day = montevideoDay(ctx.now);
  const [logs, blocks, costs, runs] = await Promise.all([
    ctx.store.listQuestionLogs(day),
    ctx.store.listBlocks(day),
    ctx.store.listCosts(day),
    ctx.store.listSyncRuns(5),
  ]);
  // Las preguntas de control no son tráfico: contarlas movía cobertura, latencia y caché.
  const { readers } = await splitControl(ctx, logs);
  const answered = readers.filter((log) => !log.blocked);
  const costToday = costs.reduce((acc, record) => acc + (record.costUsd ?? 0), 0);
  const budgetPercent = config.limits.dailyBudgetUsd > 0 ? (costToday / config.limits.dailyBudgetUsd) * 100 : 0;
  const lastSync = runs.find((run) => run.job === 'sync-feed') ?? runs[0];
  const alerts: string[] = [];
  if (!config.service.enabled) alerts.push('El servicio está pausado (kill switch).');
  if (budgetPercent >= 100) alerts.push(`Presupuesto diario superado (${budgetPercent.toFixed(0)} %). Modo: ${config.limits.onBudgetExceeded}.`);
  else if (budgetPercent >= config.limits.budgetSoftPercent) alerts.push(`Presupuesto al ${budgetPercent.toFixed(0)} %: la canónica usa el modelo económico.`);
  if (lastSync?.status === 'failed') alerts.push(`Último sync fallido: ${lastSync.error ?? 'sin detalle'} (${lastSync.consecutiveFailures ?? 1} seguidos).`);
  if (config.personalization.autoLowered) alerts.push('La intensidad de personalización fue bajada automáticamente por el reporte de sesgo.');
  if (config.personalization.intensity > config.personalization.hardMax) alerts.push('La intensidad supera el techo (hardMax).');
  const groundingFailures = answered.filter((log) => log.groundingScore !== undefined && log.groundingScore < config.answering.groundingThreshold).length;
  if (answered.length >= 10 && groundingFailures / answered.length > 0.1) alerts.push('Más del 10 % de las respuestas fallaron grounding hoy.');
  return {
    day,
    questionsToday: readers.length,
    coverageRate: answered.length ? answered.filter((log) => log.hadCoverage).length / answered.length : 0,
    latencyP95Ms: percentile(answered.map((log) => log.latencyMs), 95),
    costTodayUsd: Math.round(costToday * 1e4) / 1e4,
    dailyBudgetUsd: config.limits.dailyBudgetUsd,
    budgetPercent: Math.round(budgetPercent * 10) / 10,
    blockedToday: blocks.length,
    personalizedToday: answered.filter((log) => log.personalized).length,
    cachedRate: answered.length ? answered.filter((log) => log.cached).length / answered.length : 0,
    ...(lastSync ? { lastSync } : {}),
    corpusVersion: config.corpus.version,
    serviceEnabled: config.service.enabled,
    personalizationEnabled: config.personalization.enabled,
    personalizationIntensity: config.personalization.intensity,
    autoLowered: config.personalization.autoLowered,
    alerts,
  };
}
