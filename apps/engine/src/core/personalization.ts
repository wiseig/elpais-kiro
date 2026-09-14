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

/**
 * Adaptación y verificación. Si el verificador rechaza únicamente porque faltan hechos de la
 * original, se hace una pasada de arreglo con la lista de lo que falta, igual que la canónica
 * reintenta en modo estricto. Es lo único que quedó fallando después de sacar del texto la
 * cláusula de relevancia y las repreguntas (14/9/2026): el modelo reordena para el perfil y
 * pierde dos o tres datos por el camino.
 */
export async function adaptAndVerify(models: ModelGateway, log: Logger, input: AdaptationInput): Promise<AdaptationOutcome> {
  const { config } = input;
  const calls: ModelCall[] = [];
  const adaptationModel = config.personalization.adaptationModel;
  const verifierModel = config.personalization.verifierModel;
  const baseUserText = buildAdaptationUserMessage({
    question: input.question,
    canonical: input.canonical,
    sources: input.sources,
    profile: input.profile,
    intensity: input.intensity,
  });

  const adapt = async (userText: string) => {
    const result = await models.converse({
      modelId: adaptationModel,
      system: getPrompt('adaptation', config.prompts.adaptation),
      userText,
      maxTokens: 900,
      temperature: 0.2,
      cacheSystem: true,
      abortSignal: input.abortSignal,
    });
    calls.push({ model: adaptationModel, purpose: 'adaptation', usage: result.usage, costUsd: costUsd(config.pricing, adaptationModel, result.usage), latencyMs: result.latencyMs });
    return parseJsonObject<AdaptationJson>(result.text);
  };

  const verify = async (answer: string): Promise<VerifierVerdict> => {
    const result = await models.converse({
      modelId: verifierModel,
      system: getPrompt('verifier', config.prompts.verifier),
      userText: buildVerifierUserMessage({ canonical: input.canonical, adapted: answer, canonicalSources: input.sources, adaptedSources: input.sources }),
      maxTokens: 700,
      temperature: 0,
      cacheSystem: true,
      abortSignal: input.abortSignal,
    });
    calls.push({ model: verifierModel, purpose: 'verifier', usage: result.usage, costUsd: costUsd(config.pricing, verifierModel, result.usage), latencyMs: result.latencyMs });
    const json = parseJsonObject<VerifierJson>(result.text);
    return {
      ok: json?.ok === true,
      missingFacts: stringList(json?.missingFacts, 20),
      newFacts: stringList(json?.newFacts, 20),
      citationsEqual: json?.citationsEqual !== false,
      opinionDetected: json?.opinionDetected === true,
      ...(typeof json?.notes === 'string' ? { notes: json.notes.slice(0, 500) } : {}),
    };
  };

  const passes = (verdict: VerifierVerdict): boolean =>
    verdict.ok && verdict.missingFacts.length === 0 && verdict.newFacts.length === 0 && verdict.citationsEqual && !verdict.opinionDetected;

  /** Solo falta contenido: se puede arreglar pidiéndolo. Con opinión o datos nuevos, no. */
  const onlyMissing = (verdict: VerifierVerdict): boolean =>
    verdict.missingFacts.length > 0 && verdict.newFacts.length === 0 && verdict.citationsEqual && !verdict.opinionDetected;

  let parsed = await adapt(baseUserText);
  let attempt = 0;
  let lastVerdict: VerifierVerdict | undefined;
  let lastAnswer: string | undefined;

  while (attempt <= 1) {
    if (!parsed || typeof parsed.answer !== 'string' || !parsed.answer.trim()) {
      return { calls, ...(lastAnswer ? { candidate: lastAnswer } : {}), ...(lastVerdict ? { verdict: lastVerdict } : {}), rejectedReason: 'adaptacion_invalida' };
    }
    // Lo que el modelo dejó fuera de lugar se mueve antes de verificar: si no, el verificador lee
    // la cláusula de relevancia y las repreguntas como afirmaciones nuevas y tira todo.
    const normalized = normalizeAdaptation(parsed.answer.trim(), stringList(parsed.suggestions, 3));
    const adaptedAnswer = normalized.answer;
    lastAnswer = adaptedAnswer;
    if (parsed.changed === false || adaptedAnswer === input.canonical.trim()) {
      return { calls, rejectedReason: 'sin_cambios' };
    }
    const issues = validateAnswerText(adaptedAnswer, { maxParagraphs: config.answering.maxParagraphs, allowedUrlHosts: config.guardrails.allowedUrlHosts });
    if (issues.length || hasMetaTalk(adaptedAnswer)) {
      log.warn('adaptation.format_issues', { issues: issues.map((issue) => issue.code) });
      return { calls, candidate: adaptedAnswer, rejectedReason: 'formato' };
    }

    const verdict = await verify(adaptedAnswer);
    lastVerdict = verdict;
    if (passes(verdict)) {
      const explain = typeof parsed.explain === 'string' && parsed.explain.trim() ? parsed.explain.trim() : normalized.why;
      return {
        adapted: { answer: adaptedAnswer, ...(explain ? { explain: explain.slice(0, 300) } : {}), suggestions: normalized.suggestions },
        verdict,
        calls,
      };
    }
    if (attempt === 1 || !onlyMissing(verdict)) break;

    log.info('adaptation.repair', { missing: verdict.missingFacts.length });
    parsed = await adapt(
      `${baseUserText}

<FALTAN>
Tu versión anterior dejó afuera estos datos de la original. Volvé a escribirla con el mismo criterio de adaptación, pero incluyéndolos todos. Acortá la redacción si hace falta; no saques nada más.
${verdict.missingFacts.map((fact) => `- ${fact}`).join('\n')}
</FALTAN>`,
    );
    attempt += 1;
  }

  return { calls, ...(lastAnswer ? { candidate: lastAnswer } : {}), ...(lastVerdict ? { verdict: lastVerdict } : {}), rejectedReason: 'verificador' };
}
