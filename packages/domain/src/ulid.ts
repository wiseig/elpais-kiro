/**
 * ULID (Crockford base32, 26 caracteres). Sin dependencias; usa WebCrypto,
 * disponible en Node 22 y en navegadores.
 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function encodeTime(time: number): string {
  let out = '';
  let remaining = time;
  for (let i = 0; i < 10; i += 1) {
    out = ENCODING[remaining % 32] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

export function ulid(time: number = Date.now()): string {
  const bytes = randomBytes(16);
  let random = '';
  for (let i = 0; i < 16; i += 1) random += ENCODING[(bytes[i] ?? 0) % 32];
  return encodeTime(time) + random;
}

/** Milisegundos codificados en el prefijo del ULID. */
export function ulidTime(id: string): number {
  let time = 0;
  for (const char of id.slice(0, 10)) {
    const value = ENCODING.indexOf(char.toUpperCase());
    if (value < 0) return Number.NaN;
    time = time * 32 + value;
  }
  return time;
}

export function isUlid(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(value);
}
