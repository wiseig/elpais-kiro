import type { Config, EvalCaseRecord, EvalCaseResult, EvalRunRecord } from '@pelp/domain';
import { montevideoDay, ulid } from '@pelp/domain';
import { GOLDEN_SET } from '@pelp/testing';
import { generateCanonical, logger, sumCost, type EngineDeps } from '@pelp/engine/core';
import { runtime } from './lib/runtime';

function normalizeUrl(url: string): string {
  return url.trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '').split('?')[0] ?? '';
}

export function scoreCitations(actual: string[], expected: string[]): { precision: number; recall: number } {
  const expectedSet = new Set(expected.map(normalizeUrl));
  const actualSet = new Set(actual.map(normalizeUrl));
  if (!expectedSet.size) return { precision: actualSet.size ? 0 : 1, recall: 1 };
  let hits = 0;
  for (const url of actualSet) if (expectedSet.has(url)) hits += 1;
  return { precision: actualSet.size ? hits / actualSet.size : 0, recall: hits / expectedSet.size };
}

export async function seedGoldenCases(deps: EngineDeps): Promise<EvalCaseRecord[]> {
  const existing = await deps.store.listEvalCases();
  if (existing.length) return existing;
  const now = deps.now().toISOString();
  for (const item of GOLDEN_SET.cases) {
    await deps.store.putEvalCase({ ...item, createdAt: now, createdBy: 'golden-set', source: 'golden' });
  }
  return deps.store.listEvalCases();
}

export async function runCase(deps: EngineDeps, config: Config, item: EvalCaseRecord): Promise<EvalCaseResult> {
  const started = Date.now();
  try {
    const outcome = await generateCanonical(
      { models: deps.models, retriever: deps.retriever, guard: deps.guard, log: deps.log },
      { question: item.question, today: montevideoDay(deps.now()), model: config.answering.model, config, now: deps.now() },
    );
    const urls = outcome.sources.map((source) => source.url);
    // Los casos que dependen del día traen patrón: si una fuente lo cumple, se da por citado.
    const pattern = 'expectedUrlPattern' in item && typeof item.expectedUrlPattern === 'string' ? item.expectedUrlPattern : undefined;
    const citations = pattern && urls.some((url) => new RegExp(pattern).test(url)) ? { precision: 1, recall: 1 } : scoreCitations(urls, item.expectedUrls);
    const lower = outcome.answer.toLowerCase();
    const mentionsOk = (item.mustMention ?? []).every((phrase) => lower.includes(phrase.toLowerCase()));
    const forbiddenOk = (item.mustNotMention ?? []).every((phrase) => !lower.includes(phrase.toLowerCase()));
    const coverageOk = outcome.hadCoverage === item.expectedCoverage;
    const citationsOk = !item.expectedCoverage || citations.recall > 0;
    // Un pie "no pude verificar el resumen" trae fuentes y cobertura, así que pasaría todos los
    // controles sin haber respondido nada. Para el set dorado es una falla.
    const passed = coverageOk && citationsOk && mentionsOk && forbiddenOk && !outcome.unverified;
    return {
      caseId: item.id,
      question: item.question,
      passed,
      hadCoverage: outcome.hadCoverage,
      expectedCoverage: item.expectedCoverage,
      citationPrecision: citations.precision,
      citationRecall: citations.recall,
      ...(outcome.groundingScore !== undefined ? { groundingScore: outcome.groundingScore } : {}),
      groundingFailed: outcome.groundingFailed,
      mentionsOk,
      forbiddenOk,
      latencyMs: Date.now() - started,
      costUsd: sumCost(outcome.calls),
      answer: outcome.answer,
      sources: outcome.sources,
    };
  } catch (error) {
    return {
      caseId: item.id,
      question: item.question,
      passed: false,
      hadCoverage: false,
      expectedCoverage: item.expectedCoverage,
      citationPrecision: 0,
      citationRecall: 0,
      groundingFailed: false,
      mentionsOk: false,
      forbiddenOk: true,
      latencyMs: Date.now() - started,
      costUsd: 0,
      answer: '',
      sources: [],
      error: String(error).slice(0, 300),
    };
  }
}

/** Corrida del set dorado (Calidad, sección 11). */
export async function runEvals(deps: EngineDeps, trigger: 'nightly' | 'manual'): Promise<EvalRunRecord> {
  const config = await deps.config.get();
  const cases = await seedGoldenCases(deps);
  const startedAt = deps.now().toISOString();
  const results: EvalCaseResult[] = [];
  for (const item of cases) results.push(await runCase(deps, config, item));
  const total = results.length;
  const passed = results.filter((result) => result.passed).length;
  const withCoverage = results.filter((result) => result.expectedCoverage);
  const run: Omit<EvalRunRecord, 'PK' | 'SK' | 'type'> = {
    runId: ulid(),
    startedAt,
    finishedAt: deps.now().toISOString(),
    total,
    passed,
    coverageAccuracy: total ? results.filter((result) => result.hadCoverage === result.expectedCoverage).length / total : 0,
    citationPrecision: withCoverage.length ? withCoverage.reduce((acc, result) => acc + result.citationPrecision, 0) / withCoverage.length : 0,
    citationRecall: withCoverage.length ? withCoverage.reduce((acc, result) => acc + result.citationRecall, 0) / withCoverage.length : 0,
    groundingFailureRate: total ? results.filter((result) => result.groundingFailed).length / total : 0,
    noCoverageRate: total ? results.filter((result) => !result.hadCoverage).length / total : 0,
    costUsd: Math.round(results.reduce((acc, result) => acc + result.costUsd, 0) * 1e6) / 1e6,
    results,
    trigger,
  };
  await deps.store.putEvalRun(run);
  await deps.store.addCost(montevideoDay(deps.now()), config.answering.model, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, run.costUsd, 'jobs').catch(() => undefined);
  logger.metric('EvalPassRate', total ? passed / total : 0, 'None');
  logger.info('evals.done', { total, passed, trigger, costUsd: run.costUsd });
  return { ...run, PK: '', SK: '', type: 'EvalRun' };
}

export async function handler(event: { trigger?: 'nightly' | 'manual' } = {}): Promise<{ total: number; passed: number }> {
  const { engine } = runtime();
  const run = await runEvals(engine, event.trigger ?? 'nightly');
  return { total: run.total, passed: run.passed };
}
