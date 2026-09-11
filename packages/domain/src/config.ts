import { z } from 'zod';

/**
 * Configuración global (spec v2, sección 13). Un solo JSON, versionado,
 * editable desde el backoffice. La Lambda lo cachea 60 segundos.
 */

const modelId = z.string().min(3);

export const ConfigSchema = z.object({
  version: z.number().int().nonnegative(),
  service: z.object({
    enabled: z.boolean(),
    maintenanceMessage: z.string().min(1),
  }),
  consent: z.object({
    /** sha256 del texto vigente del Apéndice A.1. */
    textVersion: z.string().min(8),
    mode: z.enum(['single', 'split']),
    termsUrl: z.string().min(1),
    reshowOnVersionChange: z.boolean(),
    minAgePersonalization: z.number().int().min(13).max(21),
  }),
  answering: z.object({
    model: modelId,
    fallbackModel: modelId,
    maxSources: z.number().int().min(1).max(10),
    maxParagraphs: z.number().int().min(1).max(6),
    retrieval: z.object({
      topK: z.number().int().min(1).max(50),
      recentDaysFirst: z.number().int().min(1).max(3650),
      minScore: z.number().min(0).max(1),
      recencyWeight: z.number().min(0).max(1),
      maxChunksPerArticle: z.number().int().min(1).max(10),
      /** Días en los que la recencia decae linealmente a 0. */
      recencyHorizonDays: z.number().int().min(1).max(3650).default(365),
      /** Mínimo de resultados con score >= minScore antes de ampliar sin filtro de fecha. */
      minResultsBeforeWiden: z.number().int().min(1).max(20).default(3),
    }),
    groundingThreshold: z.number().min(0).max(1),
    relevanceThreshold: z.number().min(0).max(1),
    cacheTtlMinutes: z.number().int().min(0).max(24 * 60 * 30),
    queryRewrite: z.object({
      enabled: z.boolean(),
      model: modelId,
    }),
    /** Turnos de conversación que se conservan para la reescritura. */
    memoryTurns: z.number().int().min(0).max(20).default(6),
    ctaText: z.string().default('Leé la cobertura completa en El País'),
    ctaUrl: z.string().url().default('https://www.elpais.com.uy/'),
  }),
  personalization: z.object({
    enabled: z.boolean(),
    intensity: z.number().min(0).max(1),
    hardMax: z.number().min(0).max(1),
    dimensions: z.object({
      topics: z.number().min(0).max(1),
      frames: z.number().min(0).max(1),
      politicalLean: z.number().min(0).max(1),
      style: z.number().min(0).max(1),
    }),
    minEvidence: z.number().int().min(1),
    minConfidence: z.number().min(0).max(1),
    profileDecayDays: z.number().int().min(1),
    requireConsent: z.boolean(),
    rolloutPercent: z.number().int().min(0).max(100),
    channels: z.array(z.string()),
    adaptationModel: modelId,
    verifierModel: modelId,
    autoLowered: z.boolean(),
    /** Último valor de intensidad con reporte de sesgo limpio (para la auto-bajada). */
    lastCleanIntensity: z.number().min(0).max(1).default(0),
    /** Preguntas nuevas desde el último perfil que disparan ProfileDue. */
    profileEveryQuestions: z.number().int().min(1).default(5),
  }),
  guardrails: z.object({
    bedrockGuardrailId: z.string(),
    bedrockGuardrailVersion: z.string(),
    maxQuestionChars: z.number().int().min(20).max(5000),
    deniedTopics: z.array(z.string()),
    blockedWords: z.array(z.string()),
    offTopicClassifier: z.object({
      enabled: z.boolean(),
      threshold: z.number().min(0).max(1),
      model: modelId.default('anthropic.claude-haiku-4-5-20251001-v1:0'),
    }),
    allowedUrlHosts: z.array(z.string()),
  }),
  limits: z.object({
    perReaderPerHour: z.number().int().min(1),
    perIpPerMinute: z.number().int().min(1),
    dailyBudgetUsd: z.number().min(0),
    budgetSoftPercent: z.number().int().min(1).max(100),
    onBudgetExceeded: z.enum(['fallback', 'pause']),
  }),
  corpus: z.object({
    syncEveryMinutes: z.number().int().min(5),
    reconcileDaily: z.boolean(),
    /** ingestionJobId del último sync exitoso. Forma parte de la clave de caché. */
    version: z.string(),
    knowledgeBaseId: z.string(),
    dataSourceId: z.string(),
  }),
  pricing: z.record(
    z.string(),
    z.object({
      inputPerMTok: z.number().min(0),
      outputPerMTok: z.number().min(0),
      /** Multiplicadores de caché (Bedrock cobra ~10 % la lectura y ~125 % la escritura). */
      cacheReadFactor: z.number().min(0).default(0.1),
      cacheWriteFactor: z.number().min(0).default(1.25),
    }),
  ),
  prompts: z.object({
    canonical: z.string(),
    adaptation: z.string(),
    verifier: z.string(),
    profiler: z.string(),
    rewrite: z.string().default('v1'),
    offTopic: z.string().default('v1'),
    biasJudge: z.string().default('v1'),
  }),
  suggestions: z
    .object({
      days: z.number().int().min(1).max(30).default(7),
      max: z.number().int().min(1).max(12).default(6),
      fallback: z.array(z.string()).default([]),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;

export const MODEL_SONNET = 'us.anthropic.claude-sonnet-4-6';
export const MODEL_HAIKU = 'anthropic.claude-haiku-4-5-20251001-v1:0';
export const MODEL_TITAN_EMBED = 'amazon.titan-embed-text-v2:0';

export const DEFAULT_SUGGESTIONS = [
  '¿Qué pasó hoy en Uruguay?',
  '¿Cómo cerró el dólar?',
  '¿Qué se discute en el Parlamento esta semana?',
  '¿Cómo viene el pronóstico para el fin de semana?',
  '¿Qué novedades hay sobre el transporte en Montevideo?',
  '¿Cómo le fue a Peñarol y a Nacional?',
];

/**
 * Configuración por defecto (sección 13). Personalización apagada:
 * se prende desde el backoffice cuando el reporte de sesgo esté verde.
 * `consent.textVersion` se completa con el hash del texto vigente (ver consent/index.ts).
 */
export function defaultConfig(consentTextVersion: string, termsUrl = '/terminos'): Config {
  return ConfigSchema.parse({
    version: 1,
    service: {
      enabled: true,
      maintenanceMessage: 'Estamos actualizando el servicio. Volvé en unos minutos.',
    },
    consent: {
      textVersion: consentTextVersion,
      mode: 'single',
      termsUrl,
      reshowOnVersionChange: true,
      minAgePersonalization: 18,
    },
    answering: {
      model: MODEL_SONNET,
      fallbackModel: MODEL_HAIKU,
      maxSources: 5,
      maxParagraphs: 3,
      retrieval: {
        topK: 8,
        recentDaysFirst: 30,
        minScore: 0.45,
        recencyWeight: 0.3,
        maxChunksPerArticle: 3,
        recencyHorizonDays: 365,
        minResultsBeforeWiden: 3,
      },
      groundingThreshold: 0.7,
      relevanceThreshold: 0.5,
      cacheTtlMinutes: 60,
      queryRewrite: { enabled: true, model: MODEL_HAIKU },
      memoryTurns: 6,
      ctaText: 'Leé la cobertura completa en El País',
      ctaUrl: 'https://www.elpais.com.uy/',
    },
    personalization: {
      enabled: false,
      intensity: 0,
      hardMax: 0.7,
      dimensions: { topics: 1, frames: 1, politicalLean: 0.5, style: 1 },
      minEvidence: 8,
      minConfidence: 0.6,
      profileDecayDays: 90,
      requireConsent: true,
      rolloutPercent: 0,
      channels: ['web'],
      adaptationModel: MODEL_HAIKU,
      verifierModel: MODEL_HAIKU,
      autoLowered: false,
      lastCleanIntensity: 0,
      profileEveryQuestions: 5,
    },
    guardrails: {
      bedrockGuardrailId: '',
      bedrockGuardrailVersion: '',
      maxQuestionChars: 500,
      deniedTopics: ['apuestas', 'diagnóstico médico personal', 'asesoría legal o financiera personal'],
      blockedWords: [],
      offTopicClassifier: { enabled: true, threshold: 0.7, model: MODEL_HAIKU },
      allowedUrlHosts: ['www.elpais.com.uy', 'elpais.com.uy'],
    },
    limits: {
      perReaderPerHour: 30,
      perIpPerMinute: 10,
      dailyBudgetUsd: 25,
      budgetSoftPercent: 80,
      onBudgetExceeded: 'fallback',
    },
    corpus: {
      syncEveryMinutes: 60,
      reconcileDaily: true,
      version: 'initial',
      knowledgeBaseId: '',
      dataSourceId: '',
    },
    pricing: {
      [MODEL_SONNET]: { inputPerMTok: 3.0, outputPerMTok: 15.0, cacheReadFactor: 0.1, cacheWriteFactor: 1.25 },
      [MODEL_HAIKU]: { inputPerMTok: 1.0, outputPerMTok: 5.0, cacheReadFactor: 0.1, cacheWriteFactor: 1.25 },
      [MODEL_TITAN_EMBED]: { inputPerMTok: 0.02, outputPerMTok: 0, cacheReadFactor: 1, cacheWriteFactor: 1 },
    },
    prompts: {
      canonical: 'v1',
      adaptation: 'v1',
      verifier: 'v1',
      profiler: 'v1',
      rewrite: 'v1',
      offTopic: 'v1',
      biasJudge: 'v1',
    },
    suggestions: { days: 7, max: 6, fallback: DEFAULT_SUGGESTIONS },
  } satisfies ConfigInput);
}

export interface ConfigValidation {
  ok: boolean;
  config?: Config;
  errors: string[];
  warnings: string[];
}

/** Valida un JSON de configuración y devuelve errores legibles para el backoffice. */
export function validateConfig(input: unknown): ConfigValidation {
  const parsed = ConfigSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(raíz)'}: ${issue.message}`),
      warnings: [],
    };
  }
  const config = parsed.data;
  const warnings: string[] = [];
  if (config.personalization.intensity > config.personalization.hardMax) {
    warnings.push(
      `personalization.intensity (${config.personalization.intensity}) supera hardMax (${config.personalization.hardMax}): requiere confirmación explícita.`,
    );
  }
  if (config.personalization.enabled && config.personalization.rolloutPercent === 0) {
    warnings.push('La personalización está habilitada pero rolloutPercent es 0: ningún lector entra a la cohorte.');
  }
  if (!config.pricing[config.answering.model]) {
    warnings.push(`No hay precio configurado para ${config.answering.model}; el costo se estimará en 0.`);
  }
  if (config.answering.groundingThreshold < 0.6) {
    warnings.push('groundingThreshold por debajo de 0,6 debilita el objetivo O1.');
  }
  return { ok: true, config, errors: [], warnings };
}

/** Intensidad efectiva por eje: intensity × dimensions.<eje>, sin superar hardMax. */
export function effectiveIntensity(config: Config, axis: keyof Config['personalization']['dimensions']): number {
  const raw = config.personalization.intensity * config.personalization.dimensions[axis];
  return Math.min(raw, config.personalization.hardMax);
}

export type IntensityLevel = 0 | 1 | 2 | 3;

/** Niveles de la sección 9.2. */
export function intensityLevel(intensity: number): IntensityLevel {
  if (intensity <= 0) return 0;
  if (intensity <= 0.33) return 1;
  if (intensity <= 0.66) return 2;
  return 3;
}
