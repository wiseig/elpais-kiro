/**
 * Contratos del motor y de los canales (spec v2, secciones 8.2 y 10.1).
 * Este archivo es seguro para navegador: no importa nada de Node.
 */

export const TENANT_ID = 'el-pais';
export type TenantId = typeof TENANT_ID;

/** Canales conocidos. Cualquier string es válido: un canal nuevo es un adaptador nuevo. */
export type ChannelId = 'web' | 'whatsapp' | 'discord' | (string & Record<never, never>);

export interface InboundMessage {
  tenantId: string;
  channel: ChannelId;
  /** Identidad de canal ya hasheada (HMAC). El motor nunca ve el id en claro. */
  channelUserId: string;
  conversationId?: string;
  text: string;
  locale?: string;
  receivedAt: string;
  /** Metadatos del adaptador: userAgent, guildId, ipPrefixHash, uaHash… nunca PII en claro. */
  meta?: Record<string, string>;
}

export interface SourceItem {
  title: string;
  url: string;
  date: string;
  section: string;
}

export type NoticeCode =
  | 'consent_required'
  | 'service_paused'
  | 'rate_limited'
  | 'blocked'
  | 'too_long'
  | 'off_topic'
  | 'budget_paused'
  | 'personalized';

export type AnswerBlock =
  | { type: 'text'; text: string }
  | { type: 'sources'; items: SourceItem[] }
  | { type: 'cta'; text: string; url: string }
  | { type: 'suggestions'; items: string[] }
  | { type: 'notice'; text: string; code?: NoticeCode };

export interface Answer {
  answerId: string;
  conversationId: string;
  blocks: AnswerBlock[];
  hadCoverage: boolean;
  personalized: boolean;
  /** "Por qué veo esto", en lenguaje llano. Solo cuando personalized = true. */
  explain?: string;
  /** Id de la canónica, para "ver versión neutral". */
  neutralAnswerId?: string;
  latencyMs: number;
}

/* ------------------------------------------------------------------ */
/* Perfil de lector (8.2)                                              */
/* ------------------------------------------------------------------ */

export type ConsentDecision =
  | 'personalize'
  | 'neutral'
  | 'switch-to-neutral'
  | 'switch-to-personalize'
  | 'delete';

export type ReaderMode = 'personalized' | 'neutral' | 'undecided';

export interface WeightedId {
  id: string;
  weight: number;
}

export type PoliticalBucket =
  | 'izquierda'
  | 'centro-izquierda'
  | 'centro'
  | 'centro-derecha'
  | 'derecha'
  | 'sin-señal';

export interface PoliticalLean {
  /** -1 (izquierda) .. 1 (derecha). Eje genérico, sin partidos. */
  score: number;
  bucket: PoliticalBucket;
  confidence: number;
}

export interface ProfileStyle {
  length: 'corta' | 'media' | 'larga';
  dataAffinity: 'baja' | 'media' | 'alta';
  tone: 'directo' | 'narrativo';
}

export interface ReaderProfile {
  readerId: string;
  tenantId: TenantId;
  terms: { accepted: boolean; version: string; at: string };
  consent: {
    personalization: boolean;
    sensitiveInference: boolean;
    at?: string;
    version: string;
  };
  topics: WeightedId[];
  frames: WeightedId[];
  politicalLean?: PoliticalLean;
  style: ProfileStyle;
  /** Confianza por dimensión que reporta el profiler. */
  confidence?: { topics: number; frames: number; style: number };
  evidenceCount: number;
  updatedAt: string;
  version: number;
}

export const EMPTY_STYLE: ProfileStyle = { length: 'media', dataAffinity: 'media', tone: 'directo' };

/* ------------------------------------------------------------------ */
/* Recuperación y generación                                           */
/* ------------------------------------------------------------------ */

export interface RetrievedChunk {
  text: string;
  score: number;
  articleId: string;
  title: string;
  url: string;
  date: string;
  dateEpoch: number;
  section: string;
  /** Posición 1-based con la que el chunk se presenta al modelo. */
  index?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export interface ModelCall {
  model: string;
  purpose: 'rewrite' | 'canonical' | 'adaptation' | 'verifier' | 'classifier' | 'profiler' | 'judge' | 'eval';
  usage: TokenUsage;
  costUsd: number;
  latencyMs: number;
}

export interface CanonicalAnswer {
  answer: string;
  hadCoverage: boolean;
  sources: SourceItem[];
  usedChunks: number[];
  groundingScore?: number;
  relevanceScore?: number;
  model: string;
  cached: boolean;
  corpusVersion: string;
}

/* ------------------------------------------------------------------ */
/* Cohortes                                                            */
/* ------------------------------------------------------------------ */

export type Cohort = 'personalized' | 'control';
