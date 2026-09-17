/**
 * Cliente HTTP tipado con los contratos de `@pelp/domain/api` (sección 14, API pública).
 * Toda llamada lleva `Authorization: Bearer <token>`; ante un 401 se pide una sesión nueva
 * y se reintenta una sola vez.
 */
import type {
  ApiError,
  AskRequest,
  AskResponse,
  ClientEventRequest,
  ConsentRequest,
  ConsentTextResponse,
  FeedbackRequest,
  MeResponse,
  NeutralAnswerResponse,
  PatchMeRequest,
  PreviewResponse,
  SuggestionsResponse,
} from '@pelp/domain/api';
import { ensureSession, refreshSession, SessionError } from './session';

/** No está en el contrato compartido: respuesta de `DELETE /v1/me`. */
export interface DeletedResponse {
  deleted: boolean;
}

/** No está en el contrato compartido: respuesta de `POST /v1/feedback` y `POST /v1/events`. */
export interface OkResponse {
  ok: boolean;
}

/** Falla de red o servidor inalcanzable (fetch rechazado). */
export class NetworkError extends Error {
  constructor(message = 'No se pudo conectar con el servicio') {
    super(message);
    this.name = 'NetworkError';
  }
}

/** Respuesta HTTP no exitosa. `serverMessage` nunca se muestra crudo al lector. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly serverMessage: string | null;

  constructor(status: number, body: ApiError | null) {
    super(body?.error ?? `HTTP ${status}`);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = body?.code ?? null;
    this.serverMessage = body?.error ?? null;
  }
}

function isApiError(value: unknown): value is ApiError {
  return (
    typeof value === 'object' && value !== null && typeof (value as { error?: unknown }).error === 'string'
  );
}

async function readErrorBody(res: Response): Promise<ApiError | null> {
  try {
    const data: unknown = await res.json();
    if (isApiError(data)) return data;
    if (typeof data === 'object' && data !== null) {
      const code = (data as { code?: unknown }).code;
      if (typeof code === 'string') return { error: code, code };
    }
  } catch {
    // Cuerpo vacío o no JSON: alcanza con el status.
  }
  return null;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export class ApiClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /* ------------------------------ Endpoints ------------------------------ */

  getConsentText(): Promise<ConsentTextResponse> {
    return this.request<ConsentTextResponse>('GET', '/v1/consent/text');
  }

  postConsent(body: ConsentRequest): Promise<MeResponse> {
    return this.request<MeResponse>('POST', '/v1/consent', body);
  }

  getMe(): Promise<MeResponse> {
    return this.request<MeResponse>('GET', '/v1/me');
  }

  patchMe(body: PatchMeRequest): Promise<MeResponse> {
    return this.request<MeResponse>('PATCH', '/v1/me', body);
  }

  deleteMe(): Promise<DeletedResponse> {
    return this.request<DeletedResponse>('DELETE', '/v1/me');
  }

  ask(body: AskRequest): Promise<AskResponse> {
    return this.request<AskResponse>('POST', '/v1/ask', body);
  }

  getNeutralAnswer(answerId: string): Promise<NeutralAnswerResponse> {
    return this.request<NeutralAnswerResponse>('GET', `/v1/answers/${encodeURIComponent(answerId)}/neutral`);
  }

  postFeedback(body: FeedbackRequest): Promise<OkResponse> {
    return this.request<OkResponse>('POST', '/v1/feedback', body);
  }

  postEvent(body: ClientEventRequest): Promise<OkResponse> {
    return this.request<OkResponse>('POST', '/v1/events', body);
  }

  getSuggestions(): Promise<SuggestionsResponse> {
    return this.request<SuggestionsResponse>('GET', '/v1/suggestions');
  }

  /** Metadatos (imagen, bajada) de una nota de El País, para previsualizarla como fuente. */
  getPreview(url: string): Promise<PreviewResponse> {
    return this.request<PreviewResponse>('GET', `/v1/preview?url=${encodeURIComponent(url)}`);
  }

  /* ------------------------------- Interno ------------------------------- */

  private async request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const token = await this.withSession(() => ensureSession(this.baseUrl));
    let res = await this.send(method, path, body, token);
    if (res.status === 401) {
      const fresh = await this.withSession(() => refreshSession(this.baseUrl, token));
      res = await this.send(method, path, body, fresh);
    }
    if (!res.ok) throw new ApiRequestError(res.status, await readErrorBody(res));
    if (res.status === 204) return undefined as unknown as T;
    try {
      return (await res.json()) as T;
    } catch {
      throw new ApiRequestError(res.status, { error: 'Respuesta inválida del servidor', code: 'invalid_response' });
    }
  }

  private async send(method: Method, path: string, body: unknown, token: string): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    try {
      return await fetch(`${this.baseUrl}${path}`, init);
    } catch {
      throw new NetworkError();
    }
  }

  private async withSession(run: () => Promise<string>): Promise<string> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof SessionError) {
        if (err.status === null) throw new NetworkError();
        throw new ApiRequestError(err.status, { error: err.message, code: 'session_failed' });
      }
      throw err;
    }
  }
  /**
   * Texto de una nota para leerlo en voz. Se pide el guion y no el audio: lo dice el navegador,
   * que es gratis. El audio sintetizado existe en el mismo endpoint con `mode=audio`.
   */
  async articleScript(articleId: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/v1/notes/${encodeURIComponent(articleId)}/audio?mode=script`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`No se pudo obtener el texto de la nota (${res.status}).`);
    const body = (await res.json()) as { script?: unknown };
    if (typeof body.script !== 'string' || !body.script.trim()) throw new Error('La nota no tiene texto para leer.');
    return body.script;
  }

  /** Enlace al MP3 de una respuesta generada. Se sintetiza una vez y se reutiliza. */
  async answerAudioUrl(answerId: string, plan: 'base' | 'pro'): Promise<string> {
    const body = await this.request<{ audioUrl?: string }>('GET', `/v1/answers/${encodeURIComponent(answerId)}/audio?plan=${plan}`);
    if (!body.audioUrl) throw new Error('El servidor no devolvió audio.');
    return body.audioUrl;
  }

  /** Enlace al MP3 de una nota, sintetizado por el servidor. Se genera una vez y se reutiliza. */
  async articleAudioUrl(articleId: string, plan: 'base' | 'pro'): Promise<string> {
    const res = await fetch(`${this.baseUrl}/v1/notes/${encodeURIComponent(articleId)}/audio?plan=${plan}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`No se pudo generar el audio de la nota (${res.status}).`);
    const body = (await res.json()) as { audioUrl?: unknown };
    if (typeof body.audioUrl !== 'string' || !body.audioUrl) throw new Error('El servidor no devolvió audio.');
    return body.audioUrl;
  }
}
