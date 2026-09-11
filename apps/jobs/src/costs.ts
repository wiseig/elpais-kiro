import { lastDays, montevideoDay } from '@pelp/domain';
import { logger } from '@pelp/engine/core';
import { runtime } from './lib/runtime';

/** costs: consolida el gasto del día, publica métricas de presupuesto y proyección mensual. */
export async function runCosts(): Promise<{ day: string; costUsd: number; percent: number; projectedMonthUsd: number }> {
  const { engine } = runtime();
  const config = await engine.config.get();
  const day = montevideoDay(engine.now());
  const today = await engine.store.listCosts(day);
  const costUsd = today.reduce((acc, record) => acc + (record.costUsd ?? 0), 0);
  const percent = config.limits.dailyBudgetUsd > 0 ? (costUsd / config.limits.dailyBudgetUsd) * 100 : 0;
  let weekTotal = 0;
  let weekDays = 0;
  for (const past of lastDays(7, engine.now())) {
    const records = await engine.store.listCosts(past);
    if (!records.length) continue;
    weekTotal += records.reduce((acc, record) => acc + (record.costUsd ?? 0), 0);
    weekDays += 1;
  }
  const projectedMonthUsd = weekDays ? (weekTotal / weekDays) * 30 : 0;
  logger.metric('BudgetPercent', percent, 'None');
  logger.metric('DailyCostUsd', costUsd, 'None');
  logger.metric('ProjectedMonthUsd', projectedMonthUsd, 'None');
  logger.info('costs.rollup', { day, costUsd, percent, projectedMonthUsd, models: today.map((record) => ({ model: record.model, calls: record.calls, costUsd: record.costUsd })) });
  return { day, costUsd, percent, projectedMonthUsd };
}

export async function handler(): Promise<{ ok: boolean }> {
  await runCosts();
  return { ok: true };
}
