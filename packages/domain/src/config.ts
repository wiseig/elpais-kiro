import { z } from 'zod';
import { CONSENT_TEXT_VERSIONS } from './consent/index';
import { DEFAULT_DIGEST_SECTIONS, DEFAULT_INTENT_WORDS } from './normalize';

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
    textVersion: z.string().min(8).refine((version) => CONSENT_TEXT_VERSIONS[version] !== undefined, 'versión de consentimiento desconocida'),
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
      recencyHorizonDays: z.number().int().min(1).max(3650).default(90),
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
    /**
     * Modelo del perfilador. Venía pegado al de la reescritura por herencia, así que no se podía
     * tocar uno sin el otro; y ubicar a alguien en un eje político a partir de lo que escribió es
     * bastante más difícil que reescribir una repregunta.
     */
    profilerModel: modelId.default('us.amazon.nova-lite-v1:0'),
    /**
     * Contexto político uruguayo para el perfilador. No cambia la BASE de la inferencia —sigue
     * siendo solo lo que el lector dice explícitamente— sino la capacidad del modelo de entender
     * de qué le están hablando: sin saber quién gobierna, "¿por qué insisten con el presupuesto?"
     * es una pregunta cualquiera. Se edita desde el backoffice porque esto envejece.
     */
    politicalContext: z
      .object({
        enabled: z.boolean().default(true),
        /** Quién gobierna hoy y desde cuándo, en una o dos líneas. */
        government: z.string().default(''),
        /** Partidos y coaliciones, con las formas en que la gente los nombra. */
        parties: z.array(z.string()).default([]),
        /** Cargos y figuras que aparecen seguido. Envejece rápido: revisar cada tanto. */
        figures: z.array(z.string()).default([]),
        /** Cualquier aclaración extra para el modelo. */
        notes: z.string().default(''),
      })
      .default({}),
    autoLowered: z.boolean(),
    /**
     * Cuánto tolera el reporte de sesgo antes de bajar la intensidad. Exigir cero divergencias
     * sobre 90 comparaciones hechas por un modelo chico no se cumple nunca: el 13/9/2026 una sola
     * muestra con una opinión dejó la personalización en 0.
     */
    biasTolerance: z
      .object({
        /** Proporción máxima de muestras con divergencia de hechos. */
        factDivergenceRate: z.number().min(0).max(1).default(0.15),
        /** Proporción máxima de muestras con opinión detectada. */
        opinionRate: z.number().min(0).max(1).default(0.1),
        /** Muestras mínimas para que el reporte pueda bajar la intensidad. */
        minSamples: z.number().int().min(1).max(100).default(10),
      })
      .default({}),
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
      model: modelId.default('us.amazon.nova-lite-v1:0'),
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
    /** Días de notas que se conservan. Lo más viejo se borra del bucket, del índice y de la
     *  base de conocimiento para que el costo de almacenamiento no crezca sin techo (ADR 0007). */
    retentionDays: z.number().int().min(7).max(3650).default(90),
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
    offTopic: z.string().default('v2'),
    biasJudge: z.string().default('v1'),
  }),
  /**
   * Cómo se leen las consultas antes de buscar. Son listas de palabras, no expresiones: la
   * redacción agrega formas nuevas desde el backoffice y el motor las toma en menos de un minuto.
   */
  intents: z
    .object({
      /** Marcan que la consulta ya es una pregunta o un pedido; sin ninguna se trata como tema. */
      questionMarkers: z.array(z.string()).default([...DEFAULT_INTENT_WORDS.questionMarkers]),
      /** Hasta cuántas palabras se envuelve como tema ("¿Qué publicó El País sobre X?"). */
      topicMaxWords: z.number().int().min(1).max(20).default(DEFAULT_INTENT_WORDS.topicMaxWords),
      /** Saludos sueltos: se contestan con una bienvenida y sugerencias, sin gastar una consulta. */
      greetings: z.array(z.string()).default([...DEFAULT_INTENT_WORDS.greetings]),
      /** El texto de esa bienvenida. */
      greetingReply: z
        .string()
        .default(
          'Hola. Soy el asistente de El País: contesto con notas publicadas por el diario. Preguntame por un tema, ' +
            'una persona o pedime el panorama del día.',
        ),
      digest: z
        .object({
          words: z.array(z.string()).default([...DEFAULT_INTENT_WORDS.digestWords]),
          today: z.array(z.string()).default([...DEFAULT_INTENT_WORDS.digestToday]),
          standalone: z.array(z.string()).default([...DEFAULT_INTENT_WORDS.digestStandalone]),
          maxWords: z.number().int().min(1).max(12).default(DEFAULT_INTENT_WORDS.digestMaxWords),
          /** Palabras que no cuentan como tema propio al decidir si es un panorama. */
          filler: z.array(z.string()).default([...DEFAULT_INTENT_WORDS.digestFiller]),
          /** Cuántas notas del día se le pasan al modelo para armar el panorama. */
          notes: z.number().int().min(3).max(20).default(8),
          /** Secciones que no entran en un panorama (el horóscopo se llevaba medio resumen). */
          skipSections: z.array(z.string()).default(['horoscopo', 'feng-shui', 'numerologia', 'suplementos-especiales', 'tvshow']),
          /** Orden editorial; lo que no está acá va después, alfabético. */
          sectionOrder: z
            .array(z.string())
            .default(['informacion', 'politica', 'economia-y-mercado', 'negocios', 'mundo', 'ovacion', 'opinion']),
          /**
           * Secciones que el lector puede pedir por su nombre ("resumen de judiciales"):
           * `names` es cómo las escribe y `match`, los prefijos de categoría del corpus.
           */
          sections: z
            .array(z.object({ names: z.array(z.string()).min(1), match: z.array(z.string()).min(1) }))
            .default(() => DEFAULT_DIGEST_SECTIONS.map((section) => ({ names: [...section.names], match: [...section.match] }))),
          /**
           * Hasta cuántos días atrás se juntan notas para el panorama de una sección. Judiciales
           * o Sindicales no publican todos los días y "no hay nada" sería falso. Si en la ventana
           * hay más notas que el tope de la consulta, se quedan las más nuevas, que es lo que un
           * panorama quiere.
           */
          sectionDays: z.number().int().min(1).max(60).default(14),
        })
        .default({}),
    })
    .default({}),
  suggestions: z
    .object({
      days: z.number().int().min(1).max(30).default(7),
      max: z.number().int().min(1).max(12).default(6),
      /** Días de vida de una nota para servir de sugerencia en la portada. */
      freshDays: z.number().int().min(1).max(30).default(3),
      fallback: z.array(z.string()).default([]),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;

export const MODEL_SONNET = 'us.anthropic.claude-sonnet-4-6';
export const MODEL_HAIKU = 'anthropic.claude-haiku-4-5-20251001-v1:0';
/** Amazon Nova: los únicos modelos generativos invocables en la cuenta 178042202224 (cuenta de programa de canal, ADR 0006). */
export const MODEL_NOVA_PRO = 'us.amazon.nova-pro-v1:0';
export const MODEL_NOVA_LITE = 'us.amazon.nova-lite-v1:0';
export const MODEL_NOVA_PREMIER = 'us.amazon.nova-premier-v1:0';
export const MODEL_TITAN_EMBED = 'amazon.titan-embed-text-v2:0';
/** Modelos por defecto. Cuando la cuenta obtenga acceso a Anthropic, basta cambiar la config (sección 6.6). */
export const DEFAULT_MODEL_CANONICAL = MODEL_NOVA_PRO;
export const DEFAULT_MODEL_LIGHT = MODEL_NOVA_LITE;

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
      model: DEFAULT_MODEL_CANONICAL,
      fallbackModel: DEFAULT_MODEL_LIGHT,
      maxSources: 5,
      maxParagraphs: 3,
      retrieval: {
        topK: 8,
        recentDaysFirst: 30,
        minScore: 0.45,
        recencyWeight: 0.3,
        maxChunksPerArticle: 3,
        recencyHorizonDays: 90,
        minResultsBeforeWiden: 3,
      },
      groundingThreshold: 0.7,
      relevanceThreshold: 0.5,
      cacheTtlMinutes: 60,
      queryRewrite: { enabled: true, model: DEFAULT_MODEL_LIGHT },
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
      adaptationModel: DEFAULT_MODEL_LIGHT,
      verifierModel: DEFAULT_MODEL_LIGHT,
      profilerModel: DEFAULT_MODEL_LIGHT,
      // Se siembra vacío a propósito: los nombres los carga la redacción, que sabe y mantiene.
      politicalContext: { enabled: true, government: '', parties: [], figures: [], notes: '' },
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
      offTopicClassifier: { enabled: true, threshold: 0.7, model: DEFAULT_MODEL_LIGHT },
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
      retentionDays: 90,
      version: 'initial',
      knowledgeBaseId: '',
      dataSourceId: '',
    },
    pricing: {
      [MODEL_SONNET]: { inputPerMTok: 3.0, outputPerMTok: 15.0, cacheReadFactor: 0.1, cacheWriteFactor: 1.25 },
      [MODEL_HAIKU]: { inputPerMTok: 1.0, outputPerMTok: 5.0, cacheReadFactor: 0.1, cacheWriteFactor: 1.25 },
      [MODEL_TITAN_EMBED]: { inputPerMTok: 0.02, outputPerMTok: 0, cacheReadFactor: 1, cacheWriteFactor: 1 },
      'amazon.nova-pro-v1:0': { inputPerMTok: 0.8, outputPerMTok: 3.2, cacheReadFactor: 0.25, cacheWriteFactor: 1 },
      'amazon.nova-lite-v1:0': { inputPerMTok: 0.06, outputPerMTok: 0.24, cacheReadFactor: 0.25, cacheWriteFactor: 1 },
      'amazon.nova-micro-v1:0': { inputPerMTok: 0.035, outputPerMTok: 0.14, cacheReadFactor: 0.25, cacheWriteFactor: 1 },
      'amazon.nova-premier-v1:0': { inputPerMTok: 2.5, outputPerMTok: 12.5, cacheReadFactor: 0.25, cacheWriteFactor: 1 },
    },
    prompts: {
      canonical: 'v4',
      adaptation: 'v1',
      verifier: 'v1',
      profiler: 'v1',
      rewrite: 'v3',
      offTopic: 'v2',
      biasJudge: 'v1',
    },
    suggestions: { days: 7, max: 6, freshDays: 3, fallback: DEFAULT_SUGGESTIONS },
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
