/**
 * Token de sesión anónimo (10.2): se guarda en localStorage bajo `pelp.session`.
 * Si localStorage no está disponible (modo privado, iframes restringidos) se usa memoria.
 */
import type { SessionResponse } from '@pelp/domain/api';

export const SESSION_STORAGE_KEY = 'pelp.session';

let memoryToken: string | null = null;

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function getToken(): string | null {
  const store = storage();
  if (store) {
    try {
      const stored = store.getItem(SESSION_STORAGE_KEY);
      if (stored) return stored;
    } catch {
      // Sin acceso al almacenamiento: seguimos con memoria.
    }
  }
  return memoryToken;
}

export function setToken(token: string): void {
  memoryToken = token;
  const store = storage();
  if (!store) return;
  try {
    store.setItem(SESSION_STORAGE_KEY, token);
  } catch {
    // Cuota llena o almacenamiento bloqueado: el token queda solo en memoria.
  }
}

export function clearToken(): void {
  memoryToken = null;
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Nada que hacer.
  }
}

function isSessionResponse(value: unknown): value is SessionResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { token?: unknown }).token === 'string' &&
    (value as { token: string }).token.length > 0
  );
}

/** Error al crear la sesión (red o respuesta inválida). */
export class SessionError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'SessionError';
    this.status = status;
  }
}

/** Una sola creación en vuelo por origen: evita sesiones duplicadas al arrancar en paralelo. */
const inflight = new Map<string, Promise<string>>();

async function createSession(baseUrl: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{}',
    });
  } catch {
    throw new SessionError('No se pudo conectar para crear la sesión', null);
  }
  if (!res.ok) throw new SessionError('No se pudo crear la sesión', res.status);
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new SessionError('Respuesta de sesión inválida', res.status);
  }
  if (!isSessionResponse(data)) throw new SessionError('Respuesta de sesión inválida', res.status);
  setToken(data.token);
  return data.token;
}

/** Devuelve el token vigente o crea uno nuevo. */
export function ensureSession(baseUrl: string): Promise<string> {
  const existing = getToken();
  if (existing) return Promise.resolve(existing);
  return refreshSession(baseUrl, null);
}

/**
 * Reemplaza el token `stale` por uno nuevo. Si otra llamada ya lo reemplazó,
 * devuelve el vigente sin volver a pedir sesión.
 */
export function refreshSession(baseUrl: string, stale: string | null): Promise<string> {
  const current = getToken();
  if (current && current !== stale) return Promise.resolve(current);
  if (stale !== null) clearToken();
  const running = inflight.get(baseUrl);
  if (running) return running;
  const promise = createSession(baseUrl).finally(() => {
    inflight.delete(baseUrl);
  });
  inflight.set(baseUrl, promise);
  return promise;
}
