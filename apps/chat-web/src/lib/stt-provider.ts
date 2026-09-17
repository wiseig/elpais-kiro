/**
 * Quién reconoce lo que decís: el navegador (gratis, modelo genérico de Google) o El País
 * (Amazon Transcribe en streaming, con vocabulario local). Vive en este navegador, como la voz.
 */
export type SttProvider = 'navegador' | 'transcribe';

export const STT_PROVIDER_OPTIONS: { value: SttProvider; label: string; hint: string }[] = [
  { value: 'navegador', label: 'Navegador', hint: 'El reconocimiento de tu dispositivo. Gratis; el audio va a Google.' },
  { value: 'transcribe', label: 'El País', hint: 'Reconocimiento propio con nombres uruguayos. El audio se queda en nuestra nube.' },
];

const STORAGE_KEY = 'pelp.stt';

function isSttProvider(value: unknown): value is SttProvider {
  return value === 'navegador' || value === 'transcribe';
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

let current: SttProvider = (() => {
  const stored = storage()?.getItem(STORAGE_KEY) ?? null;
  return isSttProvider(stored) ? stored : 'navegador';
})();

const listeners = new Set<() => void>();

export function getSttProvider(): SttProvider {
  return current;
}

export function setSttProvider(value: SttProvider): void {
  current = value;
  try {
    storage()?.setItem(STORAGE_KEY, value);
  } catch {
    // Sin almacenamiento vale para esta pestaña y nada más.
  }
  for (const listener of listeners) listener();
}

export function subscribeSttProvider(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
