/**
 * Pausa del modo voz. En pausa el micrófono no se abre solo después de cada respuesta: se habla
 * tocando el botón del micrófono, como un handy. Es lo que sirve en un lugar ruidoso —una
 * redacción— donde el reconocimiento transcribe la charla de al lado. Se recuerda entre visitas:
 * quien trabaja con ruido no tiene por qué pausar cada vez.
 */
const STORAGE_KEY = 'pelp.voice-paused';

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

let current: boolean = storage()?.getItem(STORAGE_KEY) === '1';

const listeners = new Set<() => void>();

export function getVoicePaused(): boolean {
  return current;
}

export function setVoicePaused(value: boolean): void {
  current = value;
  try {
    storage()?.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    // Sin almacenamiento vale para esta pestaña y nada más.
  }
  for (const listener of listeners) listener();
}

export function subscribeVoicePaused(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
