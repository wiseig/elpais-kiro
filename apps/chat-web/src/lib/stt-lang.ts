/**
 * Con qué variante de español escucha el reconocimiento del navegador. Vive en este navegador,
 * como el tema y la voz. Está para probar: no hay forma de medir desde el código cuál entiende
 * mejor en cada teléfono, y el modelo de Google detrás de cada código no es el mismo.
 */
export type SttLang = 'es-UY' | 'es-AR' | 'es-419' | 'es-MX' | 'es-ES' | 'es-US';

export const STT_LANG_OPTIONS: { value: SttLang; label: string }[] = [
  { value: 'es-UY', label: 'Uruguay' },
  { value: 'es-AR', label: 'Argentina' },
  { value: 'es-419', label: 'Latinoamérica' },
  { value: 'es-MX', label: 'México' },
  { value: 'es-US', label: 'EE. UU.' },
  { value: 'es-ES', label: 'España' },
];

const STORAGE_KEY = 'pelp.stt-lang';

function isSttLang(value: unknown): value is SttLang {
  return STT_LANG_OPTIONS.some((option) => option.value === value);
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

let current: SttLang = (() => {
  const stored = storage()?.getItem(STORAGE_KEY) ?? null;
  return isSttLang(stored) ? stored : 'es-UY';
})();

const listeners = new Set<() => void>();

export function getSttLang(): SttLang {
  return current;
}

export function setSttLang(value: SttLang): void {
  current = value;
  try {
    storage()?.setItem(STORAGE_KEY, value);
  } catch {
    // Sin almacenamiento vale para esta pestaña y nada más.
  }
  for (const listener of listeners) listener();
}

export function subscribeSttLang(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
