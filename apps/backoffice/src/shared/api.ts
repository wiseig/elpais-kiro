/**
 * Cliente tipado de la admin-api (`${apiBaseUrl}/admin/*`).
 * Todas las llamadas envían `Authorization: Bearer <IdToken>`; ante un 401 se
 * renueva el token una vez y se reintenta.
 */
import type {
  AdminOverview,
  AlertHistoryResponse,
  AlertsResponse,
  AuditResponse,
  BackfillRequest,
  BiasResponse,
  BlocksResponse,
  ChannelsResponse,
  ConfigResponse,
  ConfigVersionSummary,
  CorpusArticleSearchResponse,
  CorpusStatus,
  CostsResponse,
  DeleteReaderRequest,
  EvalCaseInput,
  EvalCasesResponse,
  EvalRunsResponse,
  IncidentsResponse,
  MailingListsResponse,
  PutConfigRequest,
  JobRunsResponse,
  JobsResponse,
  QuestionDetail,
  UpdateJobRequest,
  QuestionListItem,
  QuestionsQuery,
  ReaderDetail,
  ReaderListItem,
  ReadersSummary,
  RollbackRequest,
  SendTrendingRequest,
  TrendingResponse,
  UpdateAlertRequest,
  UsersResponse,
} from '@pelp/domain/api';
import type { ChannelEntry, EvalCaseRecord } from '@pelp/domain';
import { ApiError } from './errors';

type QueryValue = string | number | boolean | undefined | null;
type Query = Record<string, QueryValue>;

export interface ApiDeps {
  baseUrl: string;
  /** Devuelve un IdToken vigente (renovándolo si hace falta) o null si no hay sesión. */
  getIdToken: (forceRefresh?: boolean) => Promise<string | null>;
  /** Se llama cuando la API rechaza el token incluso después de renovarlo. */
  onUnauthorized: () => void;
}

export interface OkResponse {
  ok: true;
}

export interface StartedResponse {
  started: boolean;
  detail?: string;
}

export interface DeletedResponse {
  deleted: true;
}

export interface MarkEvalResponse {
  ok: true;
  caseId: string;
}

export interface ChannelTestResponse {
  ok: boolean;
  detail?: string;
}

export interface ListResponse<T> {
  items: T[];
}

/**
 * Una respuesta de configuración tiene que traer el bloque `config`. Sin esto, un cuerpo raro con
 * 200 (un despliegue en curso, un intermediario que responde otra cosa) se guardaba como si fuera
 * la configuración y la pantalla se destruía entera al leer `config.personalization`: el 16/9/2026
 * el backoffice quedó en blanco al guardar Personalización. Reproducido con un PUT sin `config`.
 */
function assertConfigResponse(payload: unknown, path: string): ConfigResponse {
  const record = isRecord(payload) ? payload : undefined;
  if (!record || !isRecord(record.config) || typeof record.version !== 'number') {
    throw new ApiError(502, `El servidor devolvió una respuesta inesperada en ${path}. No se cambió nada en pantalla; probá de nuevo.`, 'bad_payload');
  }
  return payload as ConfigResponse;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SESSION_EXPIRED = 'Sesión vencida. Ingresá de nuevo.';

export class Api {
  private readonly deps: ApiDeps;

  constructor(deps: ApiDeps) {
    this.deps = deps;
  }

  private url(path: string, query?: Query): string {
    const params = new URLSearchParams();
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        params.set(key, String(value));
      }
    }
    const qs = params.toString();
    return `${this.deps.baseUrl}/admin${path}${qs ? `?${qs}` : ''}`;
  }

  private async attempt(method: string, path: string, query: Query | undefined, body: unknown, force: boolean): Promise<Response> {
    const token = await this.deps.getIdToken(force);
    if (!token) {
      this.deps.onUnauthorized();
      throw new ApiError(401, SESSION_EXPIRED, 'unauthorized');
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(this.url(path, query), init);
  }

  private async request<T>(method: string, path: string, options: { query?: Query; body?: unknown } = {}): Promise<T> {
    let res = await this.attempt(method, path, options.query, options.body, false);
    if (res.status === 401) {
      res = await this.attempt(method, path, options.query, options.body, true);
    }
    if (res.status === 401) {
      this.deps.onUnauthorized();
      throw new ApiError(401, SESSION_EXPIRED, 'unauthorized');
    }
    const text = await res.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!res.ok) {
      const record = isRecord(payload) ? payload : {};
      const message =
        typeof record.error === 'string'
          ? record.error
          : typeof record.message === 'string'
            ? record.message
            : `Error HTTP ${res.status}`;
      const code = typeof record.code === 'string' ? record.code : undefined;
      const errors = Array.isArray(record.errors) ? record.errors.filter((e): e is string => typeof e === 'string') : [];
      throw new ApiError(res.status, message, code, errors);
    }
    return payload as T;
  }

  private get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', path, { query });
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, { body });
  }

  private put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, { body });
  }

  private patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, { body });
  }

  private delete<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('DELETE', path, { body });
  }

  /* ------------------------------- Inicio -------------------------------- */

  overview(): Promise<AdminOverview> {
    return this.get('/overview');
  }

  /* ---------------------------- Configuración ---------------------------- */

  async getConfig(): Promise<ConfigResponse> {
    return assertConfigResponse(await this.get('/config'), 'GET /config');
  }

  async putConfig(body: PutConfigRequest): Promise<ConfigResponse> {
    return assertConfigResponse(await this.put('/config', body), 'PUT /config');
  }

  configVersions(): Promise<ListResponse<ConfigVersionSummary>> {
    return this.get('/config/versions');
  }

  async configVersion(version: number): Promise<ConfigResponse> {
    return assertConfigResponse(await this.get(`/config/versions/${encodeURIComponent(String(version))}`), 'GET /config/versions');
  }

  async rollbackConfig(body: RollbackRequest): Promise<ConfigResponse> {
    return assertConfigResponse(await this.post('/config/rollback', body), 'POST /config/rollback');
  }

  /* ------------------------------ Preguntas ------------------------------ */

  questions(query: QuestionsQuery): Promise<ListResponse<QuestionListItem> & { controlExcluded: number }> {
    return this.get('/questions', {
      day: query.day,
      days: query.days,
      channel: query.channel,
      coverage: query.coverage,
      personalized: query.personalized,
      q: query.q,
      limit: query.limit,
      includeControl: query.includeControl,
    });
  }

  question(id: string): Promise<QuestionDetail> {
    return this.get(`/questions/${encodeURIComponent(id)}`);
  }

  markEval(id: string): Promise<MarkEvalResponse> {
    return this.post(`/questions/${encodeURIComponent(id)}/mark-eval`);
  }

  unmarkEval(id: string): Promise<{ ok: true }> {
    return this.delete(`/questions/${encodeURIComponent(id)}/mark-eval`);
  }

  /* ------------------------------- Trabajos ------------------------------ */

  jobs(): Promise<JobsResponse> {
    return this.get('/jobs');
  }

  updateJob(key: string, body: UpdateJobRequest): Promise<JobsResponse> {
    return this.patch(`/jobs/${encodeURIComponent(key)}`, body);
  }

  runJob(key: string): Promise<{ started: boolean }> {
    return this.post(`/jobs/${encodeURIComponent(key)}/run`);
  }

  jobRuns(key: string): Promise<JobRunsResponse> {
    return this.get(`/jobs/${encodeURIComponent(key)}/runs`);
  }

  /* ------------------------------ Tendencias ----------------------------- */

  trending(days: number, coverage: 'yes' | 'no' | 'all' = 'all'): Promise<TrendingResponse> {
    return this.get('/trending', { days, coverage });
  }

  sendTrending(body: SendTrendingRequest): Promise<OkResponse> {
    return this.post('/trending/send', body);
  }

  /* ------------------------------- Lectores ------------------------------ */

  readersSummary(days: number): Promise<ReadersSummary> {
    return this.get('/readers/summary', { days });
  }

  readers(channel?: string, limit?: number): Promise<ListResponse<ReaderListItem>> {
    return this.get('/readers', { channel, limit });
  }

  reader(id: string): Promise<ReaderDetail> {
    return this.get(`/readers/${encodeURIComponent(id)}`);
  }

  deleteReader(id: string, body: DeleteReaderRequest): Promise<DeletedResponse> {
    return this.delete(`/readers/${encodeURIComponent(id)}`, body);
  }

  /* ---------------------------- Personalización -------------------------- */

  bias(days: number): Promise<BiasResponse> {
    return this.get('/bias', { days });
  }

  incidents(days: number): Promise<IncidentsResponse> {
    return this.get('/personalization/incidents', { days });
  }

  /* -------------------------------- Calidad ------------------------------ */

  evalCases(): Promise<EvalCasesResponse> {
    return this.get('/evals/cases');
  }

  createEvalCase(body: EvalCaseInput): Promise<EvalCaseRecord> {
    return this.post('/evals/cases', body);
  }

  updateEvalCase(id: string, body: EvalCaseInput): Promise<EvalCaseRecord> {
    return this.put(`/evals/cases/${encodeURIComponent(id)}`, body);
  }

  deleteEvalCase(id: string): Promise<DeletedResponse> {
    return this.delete(`/evals/cases/${encodeURIComponent(id)}`);
  }

  runEvals(): Promise<StartedResponse> {
    return this.post('/evals/run');
  }

  evalRuns(limit?: number): Promise<EvalRunsResponse> {
    return this.get('/evals/runs', { limit });
  }

  /* -------------------------------- Corpus ------------------------------- */

  corpusStatus(): Promise<CorpusStatus> {
    return this.get('/corpus/status');
  }

  corpusSync(): Promise<StartedResponse> {
    return this.post('/corpus/sync');
  }

  corpusBackfill(body: BackfillRequest): Promise<StartedResponse> {
    return this.post('/corpus/backfill', body);
  }

  corpusArticles(q: string): Promise<CorpusArticleSearchResponse> {
    return this.get('/corpus/articles', { q });
  }

  deleteCorpusArticle(id: string, reason: string): Promise<DeletedResponse> {
    return this.delete(`/corpus/articles/${encodeURIComponent(id)}`, { reason });
  }

  /* ------------------------------ Guardrails ----------------------------- */

  blocks(days: number): Promise<BlocksResponse> {
    return this.get('/guardrails/blocks', { days });
  }

  /* ------------------------------- Usuarios ------------------------------ */

  users(): Promise<UsersResponse> {
    return this.get('/users');
  }

  createUser(email: string): Promise<UsersResponse> {
    return this.post('/users', { email });
  }

  resendInvite(username: string): Promise<UsersResponse> {
    return this.post(`/users/${encodeURIComponent(username)}/resend`);
  }

  resetUserPassword(username: string): Promise<UsersResponse> {
    return this.post(`/users/${encodeURIComponent(username)}/reset`);
  }

  setUserEnabled(username: string, enabled: boolean): Promise<UsersResponse> {
    return this.patch(`/users/${encodeURIComponent(username)}`, { enabled });
  }

  deleteUser(username: string, reason?: string): Promise<UsersResponse> {
    return this.delete(`/users/${encodeURIComponent(username)}`, reason ? { reason } : undefined);
  }

  /* -------------------------------- Alertas ------------------------------ */

  alerts(): Promise<AlertsResponse> {
    return this.get('/alerts');
  }

  updateAlert(key: string, body: UpdateAlertRequest): Promise<AlertsResponse> {
    return this.patch(`/alerts/${encodeURIComponent(key)}`, body);
  }

  alertHistory(key: string): Promise<AlertHistoryResponse> {
    return this.get(`/alerts/${encodeURIComponent(key)}/history`);
  }

  /* ----------------------------- Listas de correo ------------------------ */

  mailingLists(): Promise<MailingListsResponse> {
    return this.get('/mailing');
  }

  subscribeToList(key: string, email: string): Promise<MailingListsResponse> {
    return this.post(`/mailing/${encodeURIComponent(key)}/subscriptions`, { email });
  }

  unsubscribeFromList(key: string, subscriptionArn: string, email: string): Promise<MailingListsResponse> {
    return this.delete(`/mailing/${encodeURIComponent(key)}/subscriptions`, { subscriptionArn, email });
  }

  /* -------------------------------- Canales ------------------------------ */

  channels(): Promise<ChannelsResponse> {
    return this.get('/channels');
  }

  putChannels(items: ChannelEntry[]): Promise<ChannelsResponse> {
    return this.put('/channels', { items });
  }

  testChannel(id: string): Promise<ChannelTestResponse> {
    return this.post(`/channels/${encodeURIComponent(id)}/test`);
  }

  /* -------------------------------- Costos ------------------------------- */

  costs(days: number): Promise<CostsResponse> {
    return this.get('/costs', { days });
  }

  /* ------------------------------- Auditoría ----------------------------- */

  audit(days: number, limit?: number): Promise<AuditResponse> {
    return this.get('/audit', { days, limit });
  }
}
