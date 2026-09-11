import { createHmac, timingSafeEqual } from 'node:crypto';
import { ulid } from '@pelp/domain';

/**
 * Token de sesión web (10.2): `v1.<payload>.<firma>`, firmado con HMAC-SHA256.
 * El payload solo lleva un id aleatorio (sid) y la fecha de emisión. Vive en localStorage.
 */
export interface SessionPayload {
  sid: string;
  iat: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function issueSession(secret: string, now: Date = new Date()): string {
  const payload: SessionPayload = { sid: ulid(now.getTime()), iat: Math.floor(now.getTime() / 1000) };
  const body = `v1.${b64url(JSON.stringify(payload))}`;
  return `${body}.${sign(secret, body)}`;
}

export function verifySession(secret: string, token: string | undefined): SessionPayload | undefined {
  if (!token) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return undefined;
  const body = `${parts[0]}.${parts[1]}`;
  const expected = sign(secret, body);
  const given = parts[2] ?? '';
  if (expected.length !== given.length) return undefined;
  try {
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as Partial<SessionPayload>;
    if (typeof payload.sid !== 'string' || typeof payload.iat !== 'number') return undefined;
    return { sid: payload.sid, iat: payload.iat };
  } catch {
    return undefined;
  }
}

export function bearerToken(headers: Record<string, string | undefined> | null | undefined): string | undefined {
  if (!headers) return undefined;
  const raw = headers.authorization ?? headers.Authorization;
  if (!raw) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match?.[1]?.trim();
}
