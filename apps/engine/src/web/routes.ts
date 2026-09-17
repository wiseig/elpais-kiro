import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { AnswerBlock, ReaderRecord } from '@pelp/domain';
import { CONSENT_BUTTONS, CURRENT_CONSENT_TEXT, isAllowedUrl, isAudioMode, isAudioPlan, isUlid, ulid } from '@pelp/domain';
import type {
  ArticleAudioResponse,
  ClientEventRequest,
  ConsentRequest,
  ConsentTextResponse,
  FeedbackRequest,
  NeutralAnswerResponse,
  PatchMeRequest,
  SessionResponse,
} from '@pelp/domain/api';
import { AudioError, answerAudio, articleAudio } from '../core/audio';
import type { AudioStoreGateway, SpeechGateway } from '../core/gateways';
import type { EngineDeps } from '../core/engine';
import { askQuestion } from '../core/engine';
import { ConsentError, deleteReader, meResponse, readerMode, recordDecision, resolveReader } from '../core/readers';
import { suggestionsResponse } from '../core/suggestions';
import { resolvePreview } from '../core/preview';
import { WebAdapter, requestEvidence, type WebRequest } from './adapter';
import { issueSession } from './session';

export interface WebDeps extends EngineDeps {
  secret: string;
  allowedOrigin?: string;
  /** Guardado y firma del audio ya sintetizado. */
  audioStore?: AudioStoreGateway | undefined;
  speech?: SpeechGateway | undefined;
}

const MAX_BODY_BYTES = 16 * 1024;

function corsHeaders(origin: string): Record<string, string> {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-max-age': '3600',
  };
}

export function json(status: number, body: unknown, origin = '*'): APIGatewayProxyResult {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders(origin) },
    body: JSON.stringify(body),
  };
}

function parseBody(event: APIGatewayProxyEvent): Record<string, unknown> {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) throw new HttpError(413, 'Cuerpo demasiado grande.', 'too_large');
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'El cuerpo debe ser JSON válido.', 'invalid_json');
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export function routePath(event: APIGatewayProxyEvent): string {
  let path = event.path || '/';
  const stage = event.requestContext?.stage;
  if (stage && path.startsWith(`/${stage}/`)) path = path.slice(stage.length + 1);
  return path.replace(/\/+$/, '') || '/';
}

async function requireReader(deps: WebDeps, adapter: WebAdapter, event: APIGatewayProxyEvent, now: Date): Promise<{ reader: ReaderRecord; hash: string }> {
  const sid = adapter.sessionId({ event, body: {}, now });
  if (!sid) throw new HttpError(401, 'Sesión requerida.', 'session_required');
  const hash = adapter.identityHash(sid);
  const config = await deps.config.get();
  const reader = await resolveReader(deps.store, 'web', hash, now, config);
  return { reader, hash };
}

function neutralBlocks(text: string, sources: NeutralAnswerResponse['blocks']): AnswerBlock[] {
  return [{ type: 'text', text }, ...sources];
}

/** Rutas públicas de la sección 14. */
export async function handleHttp(deps: WebDeps, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const origin = deps.allowedOrigin ?? '*';
  const method = event.httpMethod.toUpperCase();
  const path = routePath(event);
  const now = deps.now();
  const adapter = new WebAdapter(deps.secret);

  try {
    if (method === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(origin), body: '' };

    if (method === 'POST' && path === '/v1/session') {
      const body: SessionResponse = { token: issueSession(deps.secret, now) };
      return json(200, body, origin);
    }

    if (method === 'GET' && path === '/v1/consent/text') {
      const config = await deps.config.get();
      const body: ConsentTextResponse = {
        text: CURRENT_CONSENT_TEXT,
        textVersion: config.consent.textVersion,
        mode: config.consent.mode,
        termsUrl: config.consent.termsUrl,
        minAgePersonalization: config.consent.minAgePersonalization,
        buttons: { ...CONSENT_BUTTONS },
      };
      return json(200, body, origin);
    }

    if (method === 'GET' && path === '/v1/suggestions') {
      const config = await deps.config.get();
      return json(200, await suggestionsResponse(deps.store, config, now), origin);
    }

    /**
     * Lectura en voz de una nota. Pública a propósito: el destino es un botón de "escuchar" en el
     * portal, que no es un cliente del chat y no tiene sesión. El límite de abuso lo pone el WAF.
     */
    const audioMatch = /^\/v1\/notes\/([A-Za-z0-9_-]{8,80})\/audio$/.exec(path);
    if (method === 'GET' && audioMatch) {
      const config = await deps.config.get();
      const query = event.queryStringParameters ?? {};
      const plan = isAudioPlan(query.plan) ? query.plan : config.audio.defaultPlan;
      const mode = isAudioMode(query.mode) ? query.mode : 'audio';
      try {
        const result = await articleAudio(
          { store: deps.store, corpusBody: deps.corpusBody, audioStore: deps.audioStore, speech: deps.speech, log: deps.log },
          config,
          { articleId: audioMatch[1] ?? '', plan, mode },
        );
        const body: ArticleAudioResponse = result;
        // El guion no cambia mientras no cambie la nota; el enlace firmado caduca antes que el caché.
        const maxAge = mode === 'script' ? 3600 : Math.max(60, config.audio.urlTtlMinutes * 60 - 300);
        return {
          ...json(200, body, origin),
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${maxAge}`, ...corsHeaders(origin) },
        };
      } catch (error) {
        if (error instanceof AudioError) throw new HttpError(error.status, error.message, error.code);
        throw error;
      }
    }

    if (method === 'POST' && path === '/v1/ask') {
      const body = parseBody(event);
      const request: WebRequest = { event, body, now };
      if (!adapter.verify(request)) return json(401, { error: 'Sesión requerida.', code: 'session_required' }, origin);
      const [inbound] = adapter.parse(request);
      if (!inbound) return json(401, { error: 'Sesión requerida.', code: 'session_required' }, origin);
      if (typeof body.question !== 'string') return json(400, { error: 'Falta la pregunta.', code: 'invalid_question' }, origin);
      const result = await askQuestion(deps, inbound);
      if (result.httpStatus >= 400) {
        const block = result.answer.blocks[0];
        return json(result.httpStatus, { error: block && block.type === 'notice' ? block.text : 'No se pudo responder.', code: result.notice }, origin);
      }
      return json(200, result.answer, origin);
    }

    const { reader, hash } = await requireReader(deps, adapter, event, now);
    const config = await deps.config.get();

    if (method === 'POST' && path === '/v1/consent') {
      const body = parseBody(event) as Partial<ConsentRequest>;
      if (body.decision !== 'personalize' && body.decision !== 'neutral') throw new HttpError(400, 'Decisión inválida.', 'invalid_decision');
      if (typeof body.textVersion !== 'string') throw new HttpError(400, 'Falta textVersion.', 'invalid_text_version');
      const evidence = requestEvidence(event, deps.secret);
      const updated = await recordDecision(
        deps.store,
        reader,
        body.decision,
        body.textVersion,
        { channel: 'web', ...evidence, ...(typeof body.locale === 'string' ? { locale: body.locale } : {}), ageConfirmed: body.ageConfirmed === true },
        config,
        now,
      );
      return json(200, meResponse(updated, config), origin);
    }

    if (method === 'GET' && path === '/v1/me') return json(200, meResponse(reader, config), origin);

    if (method === 'PATCH' && path === '/v1/me') {
      const body = parseBody(event) as Partial<PatchMeRequest>;
      if (body.mode !== 'personalized' && body.mode !== 'neutral') throw new HttpError(400, 'Modo inválido.', 'invalid_mode');
      if (typeof body.textVersion !== 'string') throw new HttpError(400, 'Falta textVersion.', 'invalid_text_version');
      const evidence = requestEvidence(event, deps.secret);
      const updated = await recordDecision(
        deps.store,
        reader,
        body.mode === 'personalized' ? 'personalize' : 'neutral',
        body.textVersion,
        { channel: 'web', ...evidence, ageConfirmed: body.ageConfirmed === true },
        config,
        now,
      );
      return json(200, meResponse(updated, config), origin);
    }

    if (method === 'DELETE' && path === '/v1/me') {
      const identities = reader.identities?.length ? reader.identities : [{ channel: 'web', hash }];
      const result = await deleteReader(deps.store, reader, identities, now);
      deps.log.info('reader.deleted', { readerId: reader.profile.readerId, ...result });
      return json(200, { deleted: true }, origin);
    }

    if (method === 'GET' && path === '/v1/preview') {
      const url = (event.queryStringParameters?.url ?? '').trim();
      if (!url) throw new HttpError(400, 'Falta url.', 'invalid_url');
      if (!isAllowedUrl(url, config.guardrails.allowedUrlHosts)) throw new HttpError(400, 'Solo se previsualizan notas de El País.', 'host_not_allowed');
      const preview = await resolvePreview({ store: deps.store, now: deps.now }, config, url);
      return {
        ...json(200, preview, origin),
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=3600', ...corsHeaders(origin) },
      };
    }

    const neutralMatch = /^\/v1\/answers\/([A-Za-z0-9]+)\/neutral$/.exec(path);
    if (method === 'GET' && neutralMatch) {
      const answerId = neutralMatch[1] ?? '';
      if (!isUlid(answerId)) throw new HttpError(404, 'Respuesta no encontrada.', 'not_found');
      const log = await deps.store.getQuestionLog(answerId);
      if (!log) throw new HttpError(404, 'Respuesta no encontrada.', 'not_found');
      const owns = await deps.store.getConversation(reader.profile.readerId, log.convId);
      if (!owns) throw new HttpError(404, 'Respuesta no encontrada.', 'not_found');
      const body: NeutralAnswerResponse = {
        answerId,
        blocks: neutralBlocks(log.canonicalAnswer, log.sources.length ? [{ type: 'sources', items: log.sources }] : []),
        hadCoverage: log.hadCoverage,
      };
      return json(200, body, origin);
    }

    /** Lectura en voz de una respuesta. Solo para quien la recibió: misma puerta que /neutral. */
    const answerAudioMatch = /^\/v1\/answers\/([A-Za-z0-9]+)\/audio$/.exec(path);
    if (method === 'GET' && answerAudioMatch) {
      const answerId = answerAudioMatch[1] ?? '';
      if (!isUlid(answerId)) throw new HttpError(404, 'Respuesta no encontrada.', 'not_found');
      const log = await deps.store.getQuestionLog(answerId);
      if (!log) throw new HttpError(404, 'Respuesta no encontrada.', 'not_found');
      const owns = await deps.store.getConversation(reader.profile.readerId, log.convId);
      if (!owns) throw new HttpError(404, 'Respuesta no encontrada.', 'not_found');
      // Se lee lo que el lector tiene delante: la adaptada si la hubo, si no la canónica.
      const message = await deps.store.getMessage(log.convId, answerId).catch(() => undefined);
      const query = event.queryStringParameters ?? {};
      const plan = isAudioPlan(query.plan) ? query.plan : config.audio.defaultPlan;
      try {
        const result = await answerAudio(
          { store: deps.store, corpusBody: deps.corpusBody, audioStore: deps.audioStore, speech: deps.speech, log: deps.log },
          config,
          { answerId, text: message?.adaptedAnswer || log.canonicalAnswer, plan, mode: isAudioMode(query.mode) ? query.mode : 'audio' },
        );
        return json(200, result, origin);
      } catch (error) {
        if (error instanceof AudioError) throw new HttpError(error.status, error.message, error.code);
        throw error;
      }
    }

    if (method === 'POST' && path === '/v1/feedback') {
      const body = parseBody(event) as Partial<FeedbackRequest>;
      if (typeof body.answerId !== 'string' || !isUlid(body.answerId)) throw new HttpError(400, 'answerId inválido.', 'invalid_answer');
      if (body.vote !== 'up' && body.vote !== 'down') throw new HttpError(400, 'vote inválido.', 'invalid_vote');
      const log = await deps.store.getQuestionLog(body.answerId);
      if (!log) throw new HttpError(404, 'Respuesta no encontrada.', 'not_found');
      // Los avisos por bloqueo no tienen conversación: se aceptan sin verificar pertenencia.
      const owns = log.blocked ? true : Boolean(await deps.store.getConversation(reader.profile.readerId, log.convId));
      if (!owns) throw new HttpError(404, 'Respuesta no encontrada.', 'not_found');
      let comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 500) : '';
      if (comment) {
        const check = await deps.guard
          .checkInput({ id: config.guardrails.bedrockGuardrailId, version: config.guardrails.bedrockGuardrailVersion }, comment)
          .catch(() => ({ action: 'pass' as const, text: comment, kinds: [] }));
        comment = check.action === 'block' ? '' : check.text;
      }
      await deps.store.updateQuestionLog(body.answerId, { feedback: { vote: body.vote, ...(comment ? { comment } : {}), at: now.toISOString() } });
      deps.log.metric(body.vote === 'up' ? 'ThumbsUp' : 'ThumbsDown', 1);
      return json(200, { ok: true }, origin);
    }

    if (method === 'POST' && path === '/v1/events') {
      const body = parseBody(event) as Partial<ClientEventRequest>;
      if (body.type !== 'SourceClicked' || typeof body.answerId !== 'string' || typeof body.url !== 'string') {
        throw new HttpError(400, 'Evento inválido.', 'invalid_event');
      }
      deps.log.metric('SourceClicked', 1);
      if (readerMode(reader) === 'personalized' && isUlid(body.answerId)) {
        const log = await deps.store.getQuestionLog(body.answerId);
        const source = log?.sources.find((item) => item.url === body.url);
        await deps.store.putClick(
          reader.profile.readerId,
          { id: ulid(now.getTime()), at: now.toISOString(), answerId: body.answerId, url: body.url.slice(0, 500), ...(source ? { title: source.title, section: source.section } : {}) },
          now,
        );
      }
      return json(200, { ok: true }, origin);
    }

    throw new HttpError(404, 'Ruta no encontrada.', 'not_found');
  } catch (error) {
    if (error instanceof HttpError) return json(error.status, { error: error.message, code: error.code }, origin);
    if (error instanceof ConsentError) return json(400, { error: error.message, code: error.code }, origin);
    deps.log.error('http.unhandled', { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error), path, method });
    return json(502, { error: 'No pudimos consultar las notas en este momento. Probá de nuevo en unos segundos.', code: 'upstream' }, origin);
  }
}
