import type {
  Cohort,
  ConsentDecision,
  ReaderProfile,
  SourceItem,
  TokenUsage,
} from './types';
import type { Config } from './config';

/**
 * Formas de los ítems en DynamoDB (sección 12). Todos llevan PK/SK; los que
 * expiran llevan `expiresAt` (epoch segundos). Los que se listan por canal o
 * pregunta normalizada llevan GSI1PK/GSI1SK y GSI2PK/GSI2SK.
 */

export interface BaseRecord {
  PK: string;
  SK: string;
  type: string;
  expiresAt?: number;
  GSI1PK?: string;
  GSI1SK?: string;
  GSI2PK?: string;
  GSI2SK?: string;
}

export interface ReaderRecord extends BaseRecord {
  type: 'Reader';
  profile: ReaderProfile;
  /** Canal de la última actividad y su timestamp (GSI1 para listar lectores). */
  lastChannel: string;
  lastActivityAt: string;
  createdAt: string;
  questionCount: number;
  /** Preguntas desde el último perfil calculado (dispara ProfileDue al llegar al umbral). */
  questionsSinceProfile: number;
  cohort?: Cohort;
  deleted?: boolean;
  /** Identidades de canal (hash) vinculadas: permite borrarlas todas al eliminar al lector. */
  identities: { channel: string; hash: string }[];
}

export interface ConsentRecord extends BaseRecord {
  type: 'Consent';
  decision: ConsentDecision;
  textVersion: string;
  channel: string;
  at: string;
  locale?: string;
  uaHash?: string;
  ipPrefixHash?: string;
  ageConfirmed?: boolean;
  /** Umbral que la persona declaró cumplir al personalizar. */
  ageThreshold?: number;
  /** Lápida anónima tras el borrado: sin readerId ni evidencia. */
  tombstone?: boolean;
}

export interface IdentityRecord extends BaseRecord {
  type: 'Identity';
  readerId: string;
  channel: string;
  createdAt: string;
}

export interface ConversationRecord extends BaseRecord {
  type: 'Conversation';
  convId: string;
  channel: string;
  startedAt: string;
  lastAt: string;
  turns: number;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

export interface MessageRecord extends BaseRecord {
  type: 'Message';
  msgId: string;
  convId: string;
  readerId?: string;
  channel: string;
  at: string;
  questionMasked: string;
  /** Pregunta autónoma tras la reescritura (si hubo). */
  rewrittenQuestion?: string;
  canonicalAnswer: string;
  adaptedAnswer?: string;
  personalized: boolean;
  hadCoverage: boolean;
  sources: SourceItem[];
  explain?: string;
  verifierVerdict?: VerifierVerdict;
}

export interface QuestionLogRecord extends BaseRecord {
  type: 'QuestionLog';
  msgId: string;
  convId: string;
  /** Ausente en modo neutral (solo canal y día). */
  readerId?: string;
  channel: string;
  day: string;
  at: string;
  questionMasked: string;
  questionNormalized: string;
  qnormHash: string;
  hadCoverage: boolean;
  personalized: boolean;
  cohort?: Cohort;
  cached: boolean;
  sources: SourceItem[];
  canonicalAnswer: string;
  /** Resumen que el verificador de sustento descartó, para poder auditar por qué falló. */
  unverifiedAnswer?: string;
  topics: string[];
  latencyMs: number;
  usage: TokenUsage;
  costUsd: number;
  model: string;
  corpusVersion: string;
  groundingScore?: number;
  relevanceScore?: number;
  blocked?: string;
  feedback?: { vote: 'up' | 'down'; comment?: string; at: string };
  evalMarked?: boolean;
  /** Caso del set de evaluación creado desde el backoffice, para poder sacarlo. */
  evalCaseId?: string;
  /** Turno dentro de la conversación (1 = primera pregunta). */
  turn: number;
}

export interface CacheRecord extends BaseRecord {
  type: 'Cache';
  answer: string;
  hadCoverage: boolean;
  sources: SourceItem[];
  usedChunks: number[];
  groundingScore?: number;
  relevanceScore?: number;
  model: string;
  createdAt: string;
  hits: number;
}

export interface CorpusIndexRecord extends BaseRecord {
  type: 'CorpusIndex';
  articleId: string;
  contentHash: string;
  s3Key: string;
  date: string;
  title: string;
  url: string;
  section: string;
  origin: 'feed' | 'dailybrief-api' | 'backfill';
  updatedAt: string;
  removed?: boolean;
  imageUrl?: string;
  deck?: string;
}

export interface CorpusDayRecord extends BaseRecord {
  type: 'CorpusDay';
  day: string;
  count: number;
}

export interface SyncRunRecord extends BaseRecord {
  type: 'SyncRun';
  job: 'sync-feed' | 'reconcile-api' | 'backfill' | 'prune-corpus';
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'ok' | 'failed';
  fetched: number;
  written: number;
  unchanged: number;
  ingestionJobId?: string;
  error?: string;
  consecutiveFailures?: number;
}

export interface ConfigRecord extends BaseRecord {
  type: 'Config';
  config: Config;
  version: number;
  updatedAt: string;
  updatedBy: string;
  reason?: string;
}

export interface RateLimitRecord extends BaseRecord {
  type: 'RateLimit';
  count: number;
}

export interface BlockRecord extends BaseRecord {
  type: 'Block';
  id: string;
  at: string;
  channel: string;
  kind: BlockKind;
  sampleMasked: string;
  detail?: string;
}

export type BlockKind =
  | 'too_long'
  | 'rate_limited'
  | 'prompt_attack'
  | 'denied_topic'
  | 'blocked_word'
  | 'content'
  | 'off_topic'
  | 'output_content'
  | 'grounding'
  | 'format'
  | 'consent_required'
  | 'service_paused'
  | 'budget_paused';

export interface IncidentRecord extends BaseRecord {
  type: 'Incident';
  id: string;
  at: string;
  kind: 'PersonalizationRejected';
  readerId?: string;
  msgId: string;
  /** Pregunta enmascarada, para que el incidente se pueda leer sin ir a buscar el mensaje. */
  questionMasked?: string;
  canonicalAnswer: string;
  /** La adaptación que el verificador rechazó. Vacía en incidentes anteriores a que se guardara. */
  adaptedAnswer: string;
  verdict: VerifierVerdict;
}

export interface VerifierVerdict {
  ok: boolean;
  missingFacts: string[];
  newFacts: string[];
  citationsEqual: boolean;
  opinionDetected: boolean;
  notes?: string;
}

export interface EvalCaseRecord extends BaseRecord {
  type: 'EvalCase';
  id: string;
  question: string;
  /** Títulos o URLs esperados entre las fuentes. Vacío cuando se espera "sin cobertura". */
  expectedUrls: string[];
  /** Para preguntas del día: expresión regular que alcanza con que cumpla una fuente. */
  expectedUrlPattern?: string;
  expectedCoverage: boolean;
  /** Frases que deben aparecer en la respuesta (opcional). */
  mustMention: string[];
  /** Frases que no pueden aparecer (opcional). */
  mustNotMention: string[];
  tags: string[];
  createdAt: string;
  createdBy: string;
  source: 'golden' | 'backoffice' | 'feedback';
}

export interface EvalCaseResult {
  caseId: string;
  question: string;
  passed: boolean;
  hadCoverage: boolean;
  expectedCoverage: boolean;
  citationPrecision: number;
  citationRecall: number;
  groundingScore?: number;
  groundingFailed: boolean;
  mentionsOk: boolean;
  forbiddenOk: boolean;
  latencyMs: number;
  costUsd: number;
  answer: string;
  sources: SourceItem[];
  error?: string;
}

export interface EvalRunRecord extends BaseRecord {
  type: 'EvalRun';
  runId: string;
  startedAt: string;
  finishedAt: string;
  total: number;
  passed: number;
  coverageAccuracy: number;
  citationPrecision: number;
  citationRecall: number;
  groundingFailureRate: number;
  noCoverageRate: number;
  costUsd: number;
  results: EvalCaseResult[];
  trigger: 'nightly' | 'manual';
}

export interface BiasSample {
  msgId: string;
  questionMasked: string;
  factDivergence: number;
  citationsEqual: boolean;
  frameDivergence: number;
  opinionDetected: boolean;
  profiles: string[];
}

export interface BiasReportRecord extends BaseRecord {
  type: 'BiasReport';
  day: string;
  at: string;
  intensity: number;
  samples: number;
  factDivergenceTotal: number;
  citationEqualityRate: number;
  frameDivergenceAvg: number;
  opinionCount: number;
  clean: boolean;
  autoLowered: boolean;
  loweredTo?: number;
  details: BiasSample[];
  costUsd: number;
}

export interface CostRecord extends BaseRecord {
  type: 'Cost';
  day: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  calls: number;
  costUsd: number;
  byChannel?: Record<string, number>;
}

export interface AuditRecord extends BaseRecord {
  type: 'Audit';
  id: string;
  at: string;
  actor: string;
  action: string;
  target?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

export interface ClickRecord extends BaseRecord {
  type: 'Click';
  id: string;
  at: string;
  answerId: string;
  url: string;
  title?: string;
  section?: string;
}

export interface PreviewRecord extends BaseRecord {
  type: 'Preview';
  url: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  siteName?: string;
  fetchedAt: string;
  ok: boolean;
}

export interface ChannelEntry {
  id: string;
  enabled: boolean;
  webhookUrl?: string;
  /** ARN del secreto en Secrets Manager; nunca el valor. */
  secretArn?: string;
  limits: { perUserPerHour: number; maxMessageChars: number };
  lastMessageAt?: string;
  notes?: string;
}

export interface ChannelsRecord extends BaseRecord {
  type: 'Channels';
  items: ChannelEntry[];
  updatedAt: string;
  updatedBy: string;
}
