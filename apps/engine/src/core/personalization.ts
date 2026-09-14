import type { Config, ModelCall, ReaderRecord, SourceItem, VerifierVerdict } from '@pelp/domain';
import { effectiveIntensity, hasMetaTalk, validateAnswerText } from '@pelp/domain';
import { costUsd, parseJsonObject } from '@pelp/bedrock';
import { buildAdaptationUserMessage, buildVerifierUserMessage, getPrompt, type ProfileForPrompt } from '@pelp/prompts';
import type { ModelGateway } from './gateways';
import type { Logger } from './log';
import { personalizationActive } from './readers';

export interface Eligibility {
  eligible: boolean;
  reason: string;
  intensity: number;
  profile?: ProfileForPrompt;
}

/** Umbrales de 8.3 y 9.2: perfil apto, cohorte, canal, consentimiento e intensidad > 0. */
export function evaluateEligibility(config: Config, reader: ReaderRecord, channel: string, hadCoverage: boolean, now: Date): Eligibility {
  const p = config.personalization;
  const base = { intensity: p.intensity };
  if (!hadCoverage) return { ...base, eligible: false, reason: 'sin_cobertura' };
  if (!personalizationActive(reader, config)) return { ...base, eligible: false, reason: 'inactiva' };
  if (!p.channels.includes(channel)) return { ...base, eligible: false, reason: 'canal_excluido' };
  if (p.requireConsent && !reader.profile.consent.personalization) return { ...base, eligible: false, reason: 'sin_consentimiento' };
  const profile = reader.profile;
  if (profile.evidenceCount < p.minEvidence) return { ...base, eligible: false, reason: 'evidencia_insuficiente' };
  const ageDays = (now.getTime() - Date.parse(profile.updatedAt)) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays > p.profileDecayDays) return { ...base, eligible: false, reason: 'perfil_vencido' };

  const confidence = profile.confidence ?? { topics: 0, frames: 0, style: 0 };
  const forPrompt: ProfileForPrompt = {
    topics: effectiveIntensity(config, 'topics') > 0 && confidence.topics >= p.minConfidence ? profile.topics : [],
    frames: effectiveIntensity(config, 'frames') > 0 && confidence.frames >= p.minConfidence ? profile.frames : [],
    style: effectiveIntensity(config, 'style') > 0 && confidence.style >= p.minConfidence ? profile.style : { length: 'media', dataAffinity: 'media', tone: 'directo' },
  };
  if (
    profile.politicalLean &&
    profile.consent.sensitiveInference &&
    effectiveIntensity(config, 'politicalLean') > 0 &&
    profile.politicalLean.bucket !== 'sin-señal' &&
    profile.politicalLean.confidence >= Math.max(0.7, p.minConfidence)
  ) {
    forPrompt.politicalLean = profile.politicalLean;
  }
  if (!forPrompt.topics.length && !forPrompt.frames.length) return { ...base, eligible: false, reason: 'confianza_insuficiente' };
  return { eligible: true, reason: 'ok', intensity: Math.min(p.intensity, p.hardMax), profile: forPrompt };
}

export interface AdaptationInput {
  question: string;
  canonical: string;
  sources: SourceItem[];
  profile: ProfileForPrompt;
  intensity: number;
  config: Config;
  abortSignal?: AbortSignal;
}

export interface AdaptationOutcome {
  adapted?: { answer: string; explain?: string; suggestions: string[] };
  /** Texto que produjo la adaptación cuando no se llegó a servir: sin él el rechazo no se puede auditar. */
  candidate?: string;
  verdict?: VerifierVerdict;
  calls: ModelCall[];
  rejectedReason?: string;
}

interface AdaptationJson {
  answer?: unknown;
  changed?: unknown;
  explain?: unknown;
  suggestions?: unknown;
}

interface VerifierJson {
  ok?: unknown;
  missingFacts?: unknown;
  newFacts?: unknown;
  citationsEqual?: unknown;
  opinionDetected?: unknown;
  notes?: unknown;
}

function stringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()).slice(0, max);
}

/**
 * El modelo mete en el texto la cláusula de relevancia y las repreguntas por más que el prompt las
 * mande a sus propios campos. El verificador las lee como afirmaciones nuevas —y a la cláusula,
 * por interpretativa, como opinión— y tira la adaptación entera. En vez de confiar en que obedezca,
 * se sacan del texto y se mueven a donde corresponden: el lector las ve igual.
 */
const WHY_CLAUSE = /(^|[.\n])\s*((por qu[eé]|esto|esta situaci[oó]n|este tema)?\s*(te puede importar|te puede interesar|puede interesarte|te interesa|te importa|importa)\b[^.\n]*\.)/i;

function isQuestion(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('¿') || trimmed.endsWith('?');
}

/** Separa el texto en oraciones conservando el signo final. */
function sentences(text: string): string[] {
  return text.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((part) => part.trim()).filter(Boolean) ?? [];
}

export interface NormalizedAdaptation {
  answer: string;
  /** Repreguntas que venían dentro del texto y pasan al bloque de sugerencias. */
  suggestions: string[];
  /** Cláusula de relevancia que venía dentro del texto y pasa al "por qué veo esto". */
  why?: string;
}

export function normalizeAdaptation(answer: string, suggestions: string[]): NormalizedAdaptation {
  const kept: string[] = [];
  const questions: string[] = [];
  for (const sentence of sentences(answer)) {
    if (isQuestion(sentence)) questions.push(sentence);
    else kept.push(sentence);
  }
  let text = kept.join(' ').replace(/\s+/g, ' ').trim();

  let why: string | undefined;
  const match = WHY_CLAUSE.exec(text);
  if (match?.[2]) {
    why = match[2].trim();
    text = (text.slice(0, match.index) + (match[1] === '\n' ? '' : match[1] ?? '') + text.slice(match.index + match[0].length)).replace(/\s+/g, ' ').trim();
  }

  const merged = [...suggestions];
  for (const question of questions) if (!merged.some((item) => item.trim() === question)) merged.push(question);
  return { answer: text || answer.trim(), suggestions: merged.slice(0, 3), ...(why ? { why } : {}) };
}

/** Dos pasadas (9.3): adaptación con Haiku y verificador de hechos invariantes. */
export async function adaptAndVerify(models: ModelGateway, log: Logger, input: AdaptationInput): Promise<AdaptationOutcome> {
  const { config } = input;
  const calls: ModelCall[] = [];
  const adaptationModel = config.personalization.adaptationModel;
  const adaptation = await models.converse({
    modelId: adaptationModel,
    system: getPrompt('adaptation', config.prompts.adaptation),
    userText: buildAdaptationUserMessage({ question: input.question, canonical: input.canonical, sources: input.sources, profile: input.profile, intensity: input.intensity }),
    maxTokens: 900,
    temperature: 0.2,
    cacheSystem: true,
    abortSignal: input.abortSignal,
  });
  calls.push({ model: adaptationModel, purpose: 'adaptation', usage: adaptation.usage, costUsd: costUsd(config.pricing, adaptationModel, adaptation.usage), latencyMs: adaptation.latencyMs });
  const parsed = parseJsonObject<AdaptationJson>(adaptation.text);
  if (!parsed || typeof parsed.answer !== 'string' || !parsed.answer.trim()) {
    return { calls, rejectedReason: 'adaptacion_invalida' };
  }
  // Lo que el modelo dejó fuera de lugar se mueve antes de verificar: si no, el verificador lee
  // la cláusula de relevancia y las repreguntas como afirmaciones nuevas y tira todo.
  const normalized = normalizeAdaptation(parsed.answer.trim(), stringList(parsed.suggestions, 3));
  const adaptedAnswer = normalized.answer;
  if (parsed.changed === false || adaptedAnswer === input.canonical.trim()) {
    return { calls, rejectedReason: 'sin_cambios' };
  }
  const issues = validateAnswerText(adaptedAnswer, { maxParagraphs: config.answering.maxParagraphs, allowedUrlHosts: config.guardrails.allowedUrlHosts });
  if (issues.length || hasMetaTalk(adaptedAnswer)) {
    log.warn('adaptation.format_issues', { issues: issues.map((issue) => issue.code) });
    return { calls, candidate: adaptedAnswer, rejectedReason: 'formato' };
  }

  const verifierModel = config.personalization.verifierModel;
  const verification = await models.converse({
    modelId: verifierModel,
    system: getPrompt('verifier', config.prompts.verifier),
    userText: buildVerifierUserMessage({ canonical: input.canonical, adapted: adaptedAnswer, canonicalSources: input.sources, adaptedSources: input.sources }),
    maxTokens: 700,
    temperature: 0,
    cacheSystem: true,
    abortSignal: input.abortSignal,
  });
  calls.push({ model: verifierModel, purpose: 'verifier', usage: verification.usage, costUsd: costUsd(config.pricing, verifierModel, verification.usage), latencyMs: verification.latencyMs });
  const verdictJson = parseJsonObject<VerifierJson>(verification.text);
  const verdict: VerifierVerdict = {
    ok: verdictJson?.ok === true,
    missingFacts: stringList(verdictJson?.missingFacts, 20),
    newFacts: stringList(verdictJson?.newFacts, 20),
    citationsEqual: verdictJson?.citationsEqual !== false,
    opinionDetected: verdictJson?.opinionDetected === true,
    ...(typeof verdictJson?.notes === 'string' ? { notes: verdictJson.notes.slice(0, 500) } : {}),
  };
  const passes = verdict.ok && verdict.missingFacts.length === 0 && verdict.newFacts.length === 0 && verdict.citationsEqual && !verdict.opinionDetected;
  if (!passes) {
    return { calls, candidate: adaptedAnswer, verdict, rejectedReason: 'verificador' };
  }
  const explain = typeof parsed.explain === 'string' && parsed.explain.trim() ? parsed.explain.trim() : normalized.why;
  return {
    adapted: {
      answer: adaptedAnswer,
      ...(explain ? { explain: explain.slice(0, 300) } : {}),
      suggestions: normalized.suggestions,
    },
    verdict,
    calls,
  };
}
