/**
 * Utilidades que dependen de Node (crypto). No importar desde el navegador.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { normalizeQuestion } from './normalize';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hmacSha256Hex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

/** Identidad de canal seudónima: HMAC-SHA256(secret, canal + ":" + id) (2.6, 8.4). */
export function hashChannelIdentity(secret: string, channel: string, channelUserId: string): string {
  return hmacSha256Hex(secret, `${channel}:${channelUserId}`);
}

/** Hash de la pregunta normalizada: clave de caché y de tendencias. */
export function questionHash(question: string): string {
  return sha256Hex(normalizeQuestion(question));
}

/** Hash de IP truncada a tres octetos (IPv4) o /48 (IPv6) para el registro de consentimiento. */
export function ipPrefixHash(secret: string, ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  let prefix: string;
  if (ip.includes(':')) {
    prefix = ip.split(':').slice(0, 3).join(':');
  } else {
    prefix = ip.split('.').slice(0, 3).join('.');
  }
  return hmacSha256Hex(secret, `ip:${prefix}`);
}

export function uaHash(secret: string, userAgent: string | undefined): string | undefined {
  if (!userAgent) return undefined;
  return hmacSha256Hex(secret, `ua:${userAgent}`);
}

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/** Asignación estable a cohorte por hash de readerId (9.7). */
export function rolloutBucket(readerId: string): number {
  const hex = sha256Hex(`rollout:${readerId}`).slice(0, 8);
  return Number.parseInt(hex, 16) % 100;
}

export function contentHash(title: string, body: string, url: string): string {
  return sha256Hex(`${title}\n${body}\n${url}`);
}
