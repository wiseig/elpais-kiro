/**
 * Con qué voz se leen las notas. Vive en este navegador, junto al tema: es una preferencia de
 * quien escucha, no del servidor.
 *
 * - `navegador`: la voz del propio navegador. Gratis y la de peor calidad.
 * - `base` y `pro`: se sintetizan en el servidor (Polly estándar y neural) y llegan como MP3.
 *   El audio se guarda una vez por nota, así que escuchar la misma nota de nuevo no cuesta.
 */
export type VoicePreference = 'navegador' | 'base' | 'pro';

export const VOICE_OPTIONS: { value: VoicePreference; label: string; hint: string }[] = [
  { value: 'navegador', label: 'Navegador', hint: 'La voz de tu dispositivo. Gratis y la más básica.' },
  { value: 'base', label: 'Estándar', hint: 'Voz sintetizada por El País. Plan base.' },
  { value: 'pro', label: 'Neural', hint: 'La mejor voz disponible. Plan pro.' },
];

const STORAGE_KEY = 'pelp.voice';

function isVoicePreference(value: unknown): value is VoicePreference {
  return value === 'navegador' || value === 'base' || value === 'pro';
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

let current: VoicePreference = (() => {
  const stored = storage()?.getItem(STORAGE_KEY) ?? null;
  return isVoicePreference(stored) ? stored : 'navegador';
})();

const listeners = new Set<() => void>();

export function getVoicePreference(): VoicePreference {
  return current;
}

export function setVoicePreference(value: VoicePreference): void {
  current = value;
  try {
    storage()?.setItem(STORAGE_KEY, value);
  } catch {
    // Sin almacenamiento la preferencia vale para esta pestaña y nada más.
  }
  for (const listener of listeners) listener();
}

export function subscribeVoice(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
