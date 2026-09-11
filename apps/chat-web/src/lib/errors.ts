/**
 * Traducción de errores técnicos a mensajes para el lector. Nunca se muestra JSON crudo.
 */
import { ApiRequestError, NetworkError } from './api';

export interface FriendlyError {
  message: string;
  code: string | null;
  status: number | null;
  /** true cuando tiene sentido ofrecer "Reintentar". */
  retryable: boolean;
}

export const MESSAGES = {
  network: 'No pudimos conectar. Revisá tu conexión.',
  rateLimited: 'Hiciste muchas preguntas en poco tiempo. Esperá un momento y volvé a intentar.',
  tooLong: 'La pregunta es demasiado larga. Acortala a 500 caracteres como máximo.',
  paused: 'El servicio está pausado por el momento. Probá de nuevo más tarde.',
  consent: 'Para preguntar tenés que elegir una opción.',
  session: 'No pudimos validar tu sesión. Recargá la página e intentá de nuevo.',
  blocked: 'No podemos responder esa pregunta. Probá con otra consulta sobre la actualidad.',
  server: 'Algo salió mal de nuestro lado. Probá de nuevo en unos segundos.',
  generic: 'No pudimos procesar tu pregunta. Probá de nuevo.',
  save: 'No pudimos guardar el cambio. Probá de nuevo.',
} as const;

export function describeError(err: unknown): FriendlyError {
  if (err instanceof NetworkError) {
    return { message: MESSAGES.network, code: 'network', status: null, retryable: true };
  }
  if (err instanceof ApiRequestError) {
    const { status, code } = err;
    if (code === 'rate_limited' || status === 429) {
      return { message: MESSAGES.rateLimited, code: code ?? 'rate_limited', status, retryable: true };
    }
    if (code === 'too_long') return { message: MESSAGES.tooLong, code, status, retryable: false };
    if (code === 'service_paused' || code === 'budget_paused' || status === 503) {
      return { message: MESSAGES.paused, code: code ?? 'service_paused', status, retryable: true };
    }
    if (code === 'consent_required') return { message: MESSAGES.consent, code, status, retryable: false };
    if (status === 401 || code === 'session_required' || code === 'session_failed') {
      return { message: MESSAGES.session, code, status, retryable: true };
    }
    if (code === 'blocked' || code === 'off_topic') return { message: MESSAGES.blocked, code, status, retryable: false };
    if (status >= 500) return { message: MESSAGES.server, code, status, retryable: true };
    return { message: MESSAGES.generic, code, status, retryable: true };
  }
  return { message: MESSAGES.generic, code: null, status: null, retryable: true };
}

/** Mensaje para acciones de guardado (consentimiento, ajustes, borrado). */
export function describeSaveError(err: unknown): string {
  if (err instanceof NetworkError) return MESSAGES.network;
  if (err instanceof ApiRequestError) {
    if (err.status === 429) return MESSAGES.rateLimited;
    if (err.status === 503) return MESSAGES.paused;
    if (err.status === 401) return MESSAGES.session;
  }
  return MESSAGES.save;
}
