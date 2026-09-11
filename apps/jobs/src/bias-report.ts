import type { BiasReportRecord, BiasSample, Config, ModelCall, QuestionLogRecord } from '@pelp/domain';
import { montevideoDay } from '@pelp/domain';
import { costUsd, parseJsonObject } from '@pelp/bedrock';
import { buildBiasJudgeUserMessage, getPrompt } from '@pelp/prompts';
import { SYNTHETIC_PROFILES } from '@pelp/testing';
import { adaptAndVerify, logger, type EngineDeps } from '@pelp/engine/core';
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

/** Reporte de sesgo nocturno (9.6) con auto-bajada de intensidad. */
export async function runBiasReport(deps: EngineDeps, maxSamples = 30): Promise<BiasReportRecord> {
  const config = await deps.config.get();
  const now = deps.now();
  const day = montevideoDay(new Date(now.getTime() - 3 * 3600_000));
  const logs = (await deps.store.listQuestionLogs(day, 500)).filter((log) => log.hadCoverage && !log.blocked && log.canonicalAnswer);
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
  const clean = factDivergenceTotal === 0 && opinionCount === 0;
  const totalCost = Math.round(calls.reduce((acc, call) => acc + call.costUsd, 0) * 1e6) / 1e6;
  let autoLowered = false;
  let loweredTo: number | undefined;
  if (!clean && config.personalization.enabled && config.personalization.intensity > 0) {
    loweredTo = config.personalization.lastCleanIntensity;
    await deps.store.putConfig(
      { ...config, personalization: { ...config.personalization, intensity: loweredTo, autoLowered: true } },
      'bias-report',
      `auto-bajada: divergencia de hechos ${factDivergenceTotal}, opinión ${opinionCount}`,
    );
    deps.config.invalidate();
    autoLowered = true;
  } else if (clean && details.length > 0 && config.personalization.intensity > config.personalization.lastCleanIntensity) {
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

export async function handler(): Promise<{ samples: number; clean: boolean }> {
  const { engine } = runtime();
  const report = await runBiasReport(engine);
  return { samples: report.samples, clean: report.clean };
}
