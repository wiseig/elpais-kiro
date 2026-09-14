import type { BiasReportRecord, BiasSample, Config, ModelCall, QuestionLogRecord } from '@pelp/domain';
import { isDigestRequest, montevideoDay, normalizeQuestion } from '@pelp/domain';
import { costUsd, parseJsonObject } from '@pelp/bedrock';
import { buildBiasJudgeUserMessage, getPrompt } from '@pelp/prompts';
import { GOLDEN_SET, SYNTHETIC_PROFILES } from '@pelp/testing';
import { adaptAndVerify, logger, type EngineDeps, type Store } from '@pelp/engine/core';
import { runtime } from './lib/runtime';

interface JudgeJson {
  frameDivergence?: unknown;
  opinion?: unknown;
}

/** Perfiles sintéticos → ProfileForPrompt. */
function promptProfiles() {
  return SYNTHETIC_PROFILES.map((profile) => ({
    label: profile.readerId.replace('synthetic-', ''),
    profile: { topics: profile.topics, frames: profile.frames, style: profile.style, politicalLean: profile.politicalLean },
  }));
}

export async function evaluateSample(deps: EngineDeps, config: Config, log: QuestionLogRecord, intensity: number): Promise<{ sample: BiasSample; calls: ModelCall[] }> {
  const calls: ModelCall[] = [];
  const versions: { label: string; text: string }[] = [];
  let factDivergence = 0;
  let citationsEqual = true;
  let opinionDetected = false;
  for (const { label, profile } of promptProfiles()) {
    const outcome = await adaptAndVerify(deps.models, deps.log, {
      question: log.questionMasked,
      canonical: log.canonicalAnswer,
      sources: log.sources,
      profile,
      intensity,
      config,
    });
    calls.push(...outcome.calls);
    if (outcome.verdict) {
      if (outcome.verdict.missingFacts.length || outcome.verdict.newFacts.length) factDivergence += 1;
      if (!outcome.verdict.citationsEqual) citationsEqual = false;
      if (outcome.verdict.opinionDetected) opinionDetected = true;
    }
    versions.push({ label, text: outcome.adapted?.answer ?? log.canonicalAnswer });
  }
  let frameDivergence = 0;
  const judgeModel = config.personalization.verifierModel;
  try {
    const judged = await deps.models.converse({
      modelId: judgeModel,
      system: getPrompt('biasJudge', config.prompts.biasJudge),
      userText: buildBiasJudgeUserMessage(versions),
      maxTokens: 500,
      temperature: 0,
      cacheSystem: true,
    });
    calls.push({ model: judgeModel, purpose: 'judge', usage: judged.usage, costUsd: costUsd(config.pricing, judgeModel, judged.usage), latencyMs: judged.latencyMs });
    const json = parseJsonObject<JudgeJson>(judged.text);
    frameDivergence = Math.min(1, Math.max(0, Number(json?.frameDivergence) || 0));
    if (Array.isArray(json?.opinion) && json.opinion.length) opinionDetected = true;
  } catch (error) {
    logger.warn('bias.judge_failed', { error: String(error) });
  }
  return {
    sample: { msgId: log.msgId, questionMasked: log.questionMasked.slice(0, 200), factDivergence, citationsEqual, frameDivergence, opinionDetected, profiles: versions.map((version) => version.label) },
    calls,
  };
}

/** Preguntas de control: el set dorado del repo más los casos golden guardados. */
async function controlKeys(store: Store): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const item of GOLDEN_SET.cases) {
    const key = normalizeQuestion(item.question);
    if (key) keys.add(key);
  }
  const cases = await store.listEvalCases().catch(() => []);
  for (const item of cases) {
    if (item.source !== 'golden') continue;
    const key = normalizeQuestion(item.question);
    if (key) keys.add(key);
  }
  return keys;
}

/** Reporte de sesgo nocturno (9.6) con auto-bajada de intensidad. */
export async function runBiasReport(deps: EngineDeps, maxSamples = 30, dryRun = false): Promise<BiasReportRecord> {
  const config = await deps.config.get();
  const now = deps.now();
  const day = montevideoDay(new Date(now.getTime() - 3 * 3600_000));
  const control = await controlKeys(deps.store);
  const logs = (await deps.store.listQuestionLogs(day, 500)).filter((log) => {
    if (!log.hadCoverage || log.blocked || !log.canonicalAnswer) return false;
    // Las corridas de control no son lectores, y un panorama del día es una lista de notas
    // sueltas: adaptarlo al perfil obliga a dejar cosas afuera y eso cuenta como divergencia.
    if (control.has(normalizeQuestion(log.questionMasked))) return false;
    if (isDigestRequest(log.questionMasked)) return false;
    return true;
  });
  const sampled = logs.sort(() => Math.random() - 0.5).slice(0, maxSamples);
  const intensity = config.personalization.intensity > 0 ? Math.min(config.personalization.intensity, config.personalization.hardMax) : 0.5;
  const details: BiasSample[] = [];
  const calls: ModelCall[] = [];
  for (const log of sampled) {
    const { sample, calls: sampleCalls } = await evaluateSample(deps, config, log, intensity);
    details.push(sample);
    calls.push(...sampleCalls);
  }
  const factDivergenceTotal = details.reduce((acc, sample) => acc + sample.factDivergence, 0);
  const opinionCount = details.filter((sample) => sample.opinionDetected).length;
  // Se mide por proporción de muestras, no por total: con cero absoluto el reporte nunca daba
  // limpio y bajaba la intensidad todas las noches.
  const tolerance = config.personalization.biasTolerance;
  const divergentSamples = details.filter((sample) => sample.factDivergence > 0).length;
  const divergenceRate = details.length ? divergentSamples / details.length : 0;
  const opinionRate = details.length ? opinionCount / details.length : 0;
  const clean = divergenceRate <= tolerance.factDivergenceRate && opinionRate <= tolerance.opinionRate;
  const enoughSamples = details.length >= tolerance.minSamples;
  const totalCost = Math.round(calls.reduce((acc, call) => acc + call.costUsd, 0) * 1e6) / 1e6;
  let autoLowered = false;
  let loweredTo: number | undefined;
  if (!clean && enoughSamples && !dryRun && config.personalization.enabled && config.personalization.intensity > 0) {
    loweredTo = config.personalization.lastCleanIntensity;
    await deps.store.putConfig(
      { ...config, personalization: { ...config.personalization, intensity: loweredTo, autoLowered: true } },
      'bias-report',
      `auto-bajada: ${divergentSamples}/${details.length} muestras con divergencia, ${opinionCount} con opinión`,
    );
    deps.config.invalidate();
    autoLowered = true;
  } else if (clean && !dryRun && enoughSamples && config.personalization.intensity > config.personalization.lastCleanIntensity) {
    await deps.store.putConfig({ ...config, personalization: { ...config.personalization, lastCleanIntensity: config.personalization.intensity } }, 'bias-report', 'reporte limpio');
    deps.config.invalidate();
  }
  const report: Omit<BiasReportRecord, 'PK' | 'SK' | 'type'> = {
    day,
    at: now.toISOString(),
    intensity,
    samples: details.length,
    factDivergenceTotal,
    citationEqualityRate: details.length ? details.filter((sample) => sample.citationsEqual).length / details.length : 1,
    frameDivergenceAvg: details.length ? details.reduce((acc, sample) => acc + sample.frameDivergence, 0) / details.length : 0,
    opinionCount,
    clean,
    autoLowered,
    ...(loweredTo !== undefined ? { loweredTo } : {}),
    details,
    costUsd: totalCost,
  };
  await deps.store.putBiasReport(report);
  await deps.store.addCost(montevideoDay(now), config.personalization.adaptationModel, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, totalCost, 'jobs').catch(() => undefined);
  logger.metric('BiasFactDivergence', factDivergenceTotal);
  logger.metric('BiasOpinion', opinionCount);
  logger.info('bias.done', { day, samples: details.length, factDivergenceTotal, opinionCount, autoLowered, costUsd: totalCost });
  return { ...report, PK: '', SK: '', type: 'BiasReport' };
}

export async function handler(event?: { dryRun?: boolean }): Promise<{ samples: number; clean: boolean; dryRun: boolean }> {
  const { engine } = runtime();
  // `dryRun` audita y guarda el reporte sin tocar la intensidad: sirve para medir un cambio de
  // prompt sin apagarle la personalización a los lectores.
  const dryRun = event?.dryRun === true;
  const report = await runBiasReport(engine, 30, dryRun);
  return { samples: report.samples, clean: report.clean, dryRun };
}
