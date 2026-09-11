import type { Config } from '@pelp/domain';
import type { Store } from './store';

export interface BudgetState {
  spentUsd: number;
  percent: number;
  /** Modelo para la canónica según el presupuesto (sección 7, fila Costo). */
  model: string;
  paused: boolean;
  economyMode: boolean;
}

const cache = new Map<string, { at: number; spent: number }>();

export async function budgetState(store: Store, config: Config, day: string, ttlMs = 60_000): Promise<BudgetState> {
  const cached = cache.get(day);
  let spent: number;
  if (cached && Date.now() - cached.at < ttlMs) {
    spent = cached.spent;
  } else {
    const costs = await store.listCosts(day);
    spent = costs.reduce((acc, record) => acc + (record.costUsd ?? 0), 0);
    cache.set(day, { at: Date.now(), spent });
  }
  const budget = config.limits.dailyBudgetUsd;
  const percent = budget > 0 ? (spent / budget) * 100 : 0;
  const over = budget > 0 && percent >= 100;
  const soft = budget > 0 && percent >= config.limits.budgetSoftPercent;
  return {
    spentUsd: spent,
    percent,
    model: soft || over ? config.answering.fallbackModel : config.answering.model,
    paused: over && config.limits.onBudgetExceeded === 'pause',
    economyMode: soft || over,
  };
}

export function noteSpend(day: string, usd: number): void {
  const cached = cache.get(day);
  if (cached) cached.spent += usd;
}

export function resetBudgetCache(): void {
  cache.clear();
}
