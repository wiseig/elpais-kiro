/**
 * Lectura en voz con la voz del propio navegador: no cuesta nada, no manda el texto a ningún
 * lado y no necesita infraestructura. Es la calidad más baja de las disponibles, que es el
 * escalón del plan base; la voz buena se sintetiza en el servidor y llega como MP3.
 */

export type SpeechState = 'idle' | 'loading' | 'speaking' | 'unsupported' | 'error';

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';
}

/** La voz en español más parecida a la de acá, o la que haya. */
function pickVoice(): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  const spanish = voices.filter((voice) => voice.lang.toLowerCase().startsWith('es'));
  if (!spanish.length) return undefined;
  const orden = ['es-uy', 'es-ar', 'es-419', 'es-mx', 'es-us', 'es-cl'];
  for (const lang of orden) {
    const match = spanish.find((voice) => voice.lang.toLowerCase().replace('_', '-') === lang);
    if (match) return match;
  }
  return spanish[0];
}

/**
 * Cada lectura lleva su número. Cancelar dispara el error de todas las frases que quedaban en
 * cola, así que sin esto detener a propósito se mostraba como "no se pudo leer".
 */
let generation = 0;

export function stopSpeaking(): void {
  generation += 1;
  if (speechSupported()) window.speechSynthesis.cancel();
}

/**
 * Dice el texto y avisa cuando termina. Los navegadores cortan los textos largos, así que se
 * parte por oraciones y se encolan: una nota entera en una sola orden se interrumpe sola.
 */
export function speak(text: string, handlers: { onEnd?: () => void; onError?: () => void } = {}): void {
  if (!speechSupported()) {
    handlers.onError?.();
    return;
  }
  stopSpeaking();
  const mine = generation;
  const vigente = () => mine === generation;
  const voice = pickVoice();
  const pieces = text
    .split(/\n{2,}|(?<=[.!?])\s+/)
    .map((piece) => piece.trim())
    .filter(Boolean);
  if (!pieces.length) {
    handlers.onEnd?.();
    return;
  }
  pieces.forEach((piece, index) => {
    const utterance = new SpeechSynthesisUtterance(piece);
    utterance.lang = voice?.lang ?? 'es-419';
    if (voice) utterance.voice = voice;
    utterance.rate = 1;
    if (index === pieces.length - 1) utterance.onend = () => { if (vigente()) handlers.onEnd?.(); };
    utterance.onerror = () => { if (vigente()) handlers.onError?.(); };
    window.speechSynthesis.speak(utterance);
  });
}

/** Frena la lectura donde está, para seguirla después con `resumeSpeaking`. */
export function pauseSpeaking(): boolean {
  if (!speechSupported() || !window.speechSynthesis.speaking) return false;
  window.speechSynthesis.pause();
  return true;
}

/** Sigue una lectura frenada. Devuelve si había algo que seguir. */
export function resumeSpeaking(): boolean {
  if (!speechSupported() || !window.speechSynthesis.paused) return false;
  window.speechSynthesis.resume();
  return true;
}
