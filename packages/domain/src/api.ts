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

export interface SuggestionsResponse {
  items: string[];
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
> & { sourceCount: number };

export interface QuestionDetail {
  log: QuestionLogRecord;
  adaptedAnswer?: string;
  explain?: string;
  verifier?: unknown;
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
  byKind: Record<string, number>;
  items: BlockRecord[];
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
