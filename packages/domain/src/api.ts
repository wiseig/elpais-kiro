/**
 * Contratos HTTP (sección 14). Los comparten el motor, la admin-api y las dos SPAs.
 */
import type { Answer, AnswerBlock, ConsentDecision, ReaderMode, SourceItem, TokenUsage, Cohort } from './types';
import type {
  AuditRecord,
  BiasReportRecord,
  BlockRecord,
  ChannelEntry,
  CorpusIndexRecord,
  EvalCaseRecord,
  EvalRunRecord,
  IncidentRecord,
  QuestionLogRecord,
  SyncRunRecord,
} from './records';
import type { Config } from './config';

/* -------------------------------- Pública -------------------------------- */

export interface SessionResponse {
  token: string;
}

export interface ConsentTextResponse {
  text: string;
  textVersion: string;
  mode: 'single' | 'split';
  termsUrl: string;
  minAgePersonalization: number;
  buttons: { personalize: string; neutral: string };
}

export interface ConsentRequest {
  decision: 'personalize' | 'neutral';
  textVersion: string;
  ageConfirmed?: boolean;
  locale?: string;
}

export interface MeResponse {
  mode: ReaderMode;
  /** true cuando falta decidir o cambió la versión del texto. */
  needsConsent: boolean;
  terms: { accepted: boolean; version: string; at?: string };
  consent: { personalization: boolean; sensitiveInference: boolean; version: string; at?: string };
  /** "Por qué veo esto", en lenguaje llano. */
  profileSummary?: string;
  cohort?: Cohort;
  personalizationActive: boolean;
  questionCount: number;
}

export interface PatchMeRequest {
  mode: 'personalized' | 'neutral';
  textVersion: string;
  ageConfirmed?: boolean;
}

export interface AskRequest {
  question: string;
  conversationId?: string;
}

export type AskResponse = Answer;

export interface NeutralAnswerResponse {
  answerId: string;
  blocks: AnswerBlock[];
  hadCoverage: boolean;
}

export interface FeedbackRequest {
  answerId: string;
  vote: 'up' | 'down';
  comment?: string;
}

export interface ClientEventRequest {
  type: 'SourceClicked';
  answerId: string;
  url: string;
}

/** Tarjeta de sugerencia de la portada: una pregunta y la nota que la respalda. */
export interface SuggestionCard {
  question: string;
  /** "tendencia" (preguntas frecuentes con cobertura) o "reciente" (notas nuevas del corpus). */
  kind: 'trending' | 'recent';
  source?: SourceItem;
}

export interface SuggestionsResponse {
  items: string[];
  cards: SuggestionCard[];
}

/**
 * Lectura en voz de una nota. Con `mode=script` viene el texto y lo dice el navegador (sin costo);
 * con `mode=audio` viene el enlace al MP3 ya sintetizado y guardado.
 */
export interface ArticleAudioResponse {
  articleId: string;
  title: string;
  url: string;
  date: string;
  section: string;
  plan: 'base' | 'pro';
  /** Caracteres que se leen. */
  chars: number;
  /** La nota no entraba entera en el tope configurado. */
  truncated: boolean;
  script?: string;
  audioUrl?: string;
  voice?: string;
  engine?: string;
  /** El MP3 ya existía: no se volvió a generar. */
  cached?: boolean;
}

/** Metadatos Open Graph de una nota de El País (solo hosts permitidos), con caché. */
export interface PreviewResponse {
  url: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  siteName?: string;
  /** true cuando el sitio no respondió y se devuelve lo que había en la metadata. */
  fallback: boolean;
}

export interface ApiError {
  error: string;
  code?: string;
}

/* --------------------------------- Admin --------------------------------- */

export interface AdminOverview {
  day: string;
  questionsToday: number;
  coverageRate: number;
  latencyP95Ms: number;
  costTodayUsd: number;
  dailyBudgetUsd: number;
  budgetPercent: number;
  blockedToday: number;
  personalizedToday: number;
  cachedRate: number;
  lastSync?: SyncRunRecord;
  corpusVersion: string;
  serviceEnabled: boolean;
  personalizationEnabled: boolean;
  personalizationIntensity: number;
  autoLowered: boolean;
  alerts: string[];
}

export interface ConfigResponse {
  config: Config;
  version: number;
  updatedAt: string;
  updatedBy: string;
}

export interface PutConfigRequest {
  config: Config;
  reason?: string;
  /** Requerido cuando intensity > hardMax. */
  confirmAboveHardMax?: boolean;
}

export interface ConfigVersionSummary {
  version: number;
  updatedAt: string;
  updatedBy: string;
  reason?: string;
}

export interface RollbackRequest {
  version: number;
  reason?: string;
}

export interface QuestionsQuery {
  day?: string;
  days?: number;
  channel?: string;
  coverage?: 'yes' | 'no';
  personalized?: 'yes' | 'no';
  q?: string;
  limit?: number;
  /** Incluir las preguntas de control del set dorado, que por defecto quedan afuera. */
  includeControl?: 'yes';
}

export type QuestionListItem = Pick<
  QuestionLogRecord,
  | 'msgId'
  | 'convId'
  | 'channel'
  | 'day'
  | 'at'
  | 'questionMasked'
  | 'hadCoverage'
  | 'personalized'
  | 'cohort'
  | 'cached'
  | 'latencyMs'
  | 'costUsd'
  | 'model'
  | 'feedback'
  | 'blocked'
  | 'evalMarked'
  | 'topics'
> & {
  sourceCount: number;
  /** Pregunta del set dorado disparada por una corrida de control, no por un lector. */
  isControl?: boolean;
};

export interface QuestionDetail {
  log: QuestionLogRecord;
  adaptedAnswer?: string;
  /** Adaptación intentada y rechazada: el lector vio la canónica. */
  rejectedAdaptation?: string;
  explain?: string;
  verifier?: unknown;
}

export interface JobSchedule {
  kind: 'rate' | 'daily' | 'other';
  /** Expresión tal cual la guarda EventBridge. */
  expression: string;
  everyMinutes?: number;
  utcHour?: number;
  utcMinute?: number;
}

export interface JobSummary {
  key: string;
  label: string;
  description: string;
  schedule: JobSchedule;
  enabled: boolean;
  /** Tiene regla programada, así que se le puede cambiar el horario. */
  configurable: boolean;
  /** Se puede disparar a mano desde el backoffice. */
  runnable: boolean;
  lastRunSource: 'sync' | 'evals' | 'bias' | 'ingestion' | 'none';
  lastRunAt?: string;
  lastStatus?: 'ok' | 'failed' | 'running';
  lastDetail?: string;
  nextRunAt?: string;
}

export interface JobsResponse {
  jobs: JobSummary[];
}

export interface UpdateJobRequest {
  everyMinutes?: number;
  utcHour?: number;
  utcMinute?: number;
  enabled?: boolean;
}

export interface TrendingItem {
  questionNormalized: string;
  qnormHash: string;
  count: number;
  coverageRate: number;
  lastAt: string;
  channels: string[];
  topics: string[];
  sample: string;
}

export interface TrendingResponse {
  days: number;
  items: TrendingItem[];
  gaps: TrendingItem[];
  bySection: Record<string, number>;
  /** Preguntas de control apartadas del cálculo, para que se sepa que no se perdió nada. */
  controlExcluded: number;
}

export interface ReadersSummary {
  days: number;
  readers: number;
  /** Celdas con menos de `k` lectores no se muestran. */
  k: number;
  byChannel: Record<string, number>;
  byMode: Record<string, number>;
  topics: Record<string, number>;
  frames: Record<string, number>;
  style: Record<string, number>;
  politicalLean: Record<string, number>;
  cohorts: Record<Cohort, CohortMetrics>;
  weekly: { week: string; readers: number; questions: number }[];
  frameByTopic: Record<string, Record<string, number>>;
}

export interface CohortMetrics {
  readers: number;
  questions: number;
  followUpRate: number;
  clicks: number;
  thumbsUp: number;
  thumbsDown: number;
  sessionsPerReader: number;
}

export interface ReaderListItem {
  readerId: string;
  channel: string;
  questionCount: number;
  lastActivityAt: string;
  mode: ReaderMode;
  summary: string;
}

export interface ReaderDetail {
  reader: ReaderListItem;
  profile: unknown;
  profileVersions: { at: string; profile: unknown }[];
  consents: { at: string; decision: ConsentDecision; textVersion: string; channel: string }[];
  questions: QuestionListItem[];
}

export interface DeleteReaderRequest {
  reason: string;
}

export interface BiasResponse {
  days: number;
  reports: BiasReportRecord[];
}

export interface IncidentsResponse {
  items: IncidentRecord[];
}

export interface EvalCaseInput {
  question: string;
  expectedUrls: string[];
  expectedCoverage: boolean;
  mustMention?: string[];
  mustNotMention?: string[];
  tags?: string[];
}

export interface EvalCasesResponse {
  items: EvalCaseRecord[];
}

export interface EvalRunsResponse {
  items: EvalRunRecord[];
}

export interface IngestionJobSummary {
  id: string;
  status: string;
  startedAt?: string;
  updatedAt?: string;
  scanned?: number;
  indexed?: number;
  modified?: number;
  deleted?: number;
  failed?: number;
}

export interface CorpusStatus {
  knowledgeBaseId: string;
  dataSourceId: string;
  corpusVersion: string;
  byDay: { day: string; count: number }[];
  runs: SyncRunRecord[];
  ingestionJobs: IngestionJobSummary[];
  totalArticles: number;
}

export interface BackfillRequest {
  from: string;
  to: string;
}

export interface CorpusArticleSearchResponse {
  items: CorpusIndexRecord[];
}

export interface BlocksResponse {
  days: number;
  /** Todos los bloqueos del período, incluidas las pruebas. */
  byKind: Record<string, number>;
  /** Los que vinieron de preguntas del set de evaluación (smoke test y corridas de control). */
  evalSetByKind: Record<string, number>;
  items: BlockedItem[];
}

export interface BlockedItem extends BlockRecord {
  /** La muestra coincide con una pregunta del set de evaluación: es tráfico de prueba, no un lector. */
  fromEvalSet?: boolean;
}

export interface JobRunDetail {
  label: string;
  value: string;
}

export interface JobRun {
  at: string;
  status: 'ok' | 'failed' | 'running' | 'warning';
  /** Resultado en una línea, listo para mostrar. */
  headline: string;
  details: JobRunDetail[];
  error?: string;
}

export interface JobRunsResponse {
  key: string;
  runs: JobRun[];
  /** Pantalla del backoffice con el detalle completo. */
  link?: { to: string; label: string };
  /** Explicación cuando el trabajo no deja un registro propio de corridas. */
  note?: string;
}

export interface AdminUser {
  username: string;
  email: string;
  /** Estado en palabras; `rawStatus` guarda el de Cognito por si hace falta el detalle. */
  status: 'activo' | 'invitado' | 'debe_resetear' | 'sin_confirmar' | 'otro';
  rawStatus: string;
  enabled: boolean;
  groups: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface UsersResponse {
  items: AdminUser[];
  /** Grupo que habilita el backoffice. */
  adminGroup: string;
  /** Correo de quien está mirando: el front no le ofrece borrarse ni deshabilitarse. */
  actor: string;
}

export interface MailingSubscription {
  email: string;
  confirmed: boolean;
  /** Solo existe una vez confirmada: SNS no da ARN mientras está pendiente. */
  subscriptionArn?: string;
}

export interface MailingList {
  key: string;
  label: string;
  description: string;
  topicArn: string;
  subscriptions: MailingSubscription[];
}

export interface MailingListsResponse {
  lists: MailingList[];
}

/* -------------------------------- Alertas -------------------------------- */

/** Familia a la que pertenece la alerta; agrupa la tabla del backoffice. */
export type AlertGroup = 'Servicio' | 'Calidad' | 'Costos' | 'Corpus';

/** Qué tan urgente es lo que avisa. No cambia el envío: ordena la lectura. */
export type AlertSeverity = 'critica' | 'importante' | 'aviso';

/** Estado de la alarma en CloudWatch, en castellano. */
export type AlertState = 'ok' | 'alarma' | 'sin_datos' | 'desconocido';

export interface AlertSummary {
  key: string;
  label: string;
  group: AlertGroup;
  severity: AlertSeverity;
  /** Por qué llega: qué mide y qué la dispara, en una frase. */
  why: string;
  /** Qué conviene hacer cuando llega. */
  action: string;
  /** La condición armada con los valores vigentes ("si pasa de 8000 ms en 2 ventanas de 5 min"). */
  condition: string;
  /** Qué mira la métrica, en palabras. */
  metricLabel: string;
  /** Unidad del umbral: se muestra al lado del campo. */
  unit: string;
  /** La misma unidad en singular, para no escribir «1 corridas fallidas». */
  unitOne?: string;
  threshold: number;
  /** Operador tal cual lo guarda CloudWatch (`GreaterThanThreshold`, …). */
  comparisonOperator: string;
  /** El mismo operador en símbolo, para armar frases. */
  comparison: string;
  /** Ventanas de medición que tienen que dar mal seguidas. */
  evaluationPeriods: number;
  datapointsToAlarm: number;
  /** Largo de cada ventana, en minutos. */
  periodMinutes: number;
  state: AlertState;
  /** Explicación que deja CloudWatch del último cambio de estado. */
  stateReason?: string;
  stateChangedAt?: string;
  /** Si está apagado, la alarma sigue midiendo pero no manda correo. */
  notifying: boolean;
  /** Existe en AWS y se le puede tocar el umbral desde acá. */
  configurable: boolean;
  /** Rango que acepta el umbral en el backoffice. */
  minThreshold: number;
  maxThreshold: number;
  stepThreshold: number;
  alarmName: string;
  /** La alarma del catálogo todavía no existe en la cuenta (falta desplegar). */
  missing: boolean;
}

/** Aviso que aparece en Inicio y no sale por correo. El umbral vive en Configuración. */
export interface PanelAlert {
  key: string;
  label: string;
  why: string;
  condition: string;
  /** Ancla de la pantalla de Configuración donde se cambia el umbral, si se puede cambiar. */
  settingLabel?: string;
}

export interface AlertsResponse {
  alerts: AlertSummary[];
  /** Avisos del panel de Inicio, con el umbral que tienen hoy en la configuración. */
  panel: PanelAlert[];
  /** A quién le llegan los correos de alarma (la lista «Alarmas»). */
  recipients: MailingSubscription[];
  alertsTopicArn: string;
  /** Las alarmas del catálogo que todavía no existen en la cuenta. */
  missingCount: number;
  /**
   * Falló leer CloudWatch o SNS. Sin esto una lectura fallida se leería como «no está
   * desplegada» o «no le llega a nadie», que es peor que decir que no se pudo mirar.
   */
  readError?: string;
}

export interface UpdateAlertRequest {
  threshold?: number;
  evaluationPeriods?: number;
  /** Silenciar o volver a habilitar el envío por correo. */
  notifying?: boolean;
}

export interface AlertHistoryEntry {
  at: string;
  kind: 'alarma' | 'ok' | 'sin_datos' | 'configuracion';
  summary: string;
}

export interface AlertHistoryResponse {
  key: string;
  items: AlertHistoryEntry[];
  note?: string;
}

export interface ChannelsResponse {
  items: ChannelEntry[];
  updatedAt?: string;
}

export interface CostsResponse {
  days: number;
  byDay: { day: string; costUsd: number; calls: number; byModel: Record<string, number> }[];
  byModel: Record<string, { inputTokens: number; outputTokens: number; costUsd: number; calls: number }>;
  byChannel: Record<string, number>;
  totalUsd: number;
  projectedMonthUsd: number;
  dailyBudgetUsd: number;
  todayUsd: number;
  todayPercent: number;
}

export interface AuditResponse {
  items: AuditRecord[];
}

export interface SendTrendingRequest {
  days: number;
  onlyGaps?: boolean;
  note?: string;
}

export type { SourceItem, TokenUsage };
