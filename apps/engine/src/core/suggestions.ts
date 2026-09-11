import type { Config, QuestionLogRecord } from '@pelp/domain';
import { lastDays } from '@pelp/domain';
import type { Store } from './store';

let cached: { at: number; items: string[] } | undefined;

/** Preguntas sugeridas (10.2): tendencias con cobertura de los últimos días, con lista de respaldo. */
export async function suggestions(store: Store, config: Config, now: Date, ttlMs = 10 * 60_000): Promise<string[]> {
  if (cached && Date.now() - cached.at < ttlMs) return cached.items;
  const counts = new Map<string, { count: number; sample: string }>();
  for (const day of lastDays(config.suggestions.days, now)) {
    let logs: QuestionLogRecord[] = [];
    try {
      logs = await store.listQuestionLogs(day, 500);
    } catch {
      logs = [];
    }
    for (const log of logs) {
      if (!log.hadCoverage || log.blocked || !log.questionMasked) continue;
      const entry = counts.get(log.qnormHash) ?? { count: 0, sample: log.questionMasked };
      entry.count += 1;
      counts.set(log.qnormHash, entry);
    }
  }
  const trending = [...counts.values()]
    .filter((entry) => entry.count >= 2)
    .sort((a, b) => b.count - a.count)
    .map((entry) => entry.sample)
    .slice(0, config.suggestions.max);
  const fallback = config.suggestions.fallback.filter((item) => !trending.includes(item));
  const items = [...trending, ...fallback].slice(0, config.suggestions.max);
  cached = { at: Date.now(), items };
  return items;
}

export function resetSuggestionsCache(): void {
  cached = undefined;
}
