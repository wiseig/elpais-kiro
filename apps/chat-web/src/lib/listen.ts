/**
 * Dictado con el reconocimiento de voz del navegador. Como la lectura, es del lado del cliente:
 * no manda audio a ningún lado y no cuesta nada. Chrome y Safari lo traen; Firefox no, y ahí el
 * botón del micrófono no aparece.
 */

import { getSttLang } from './stt-lang';

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onspeechend: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
}

/** Silencio que se toma como "ya terminó de hablar". */
const SILENCE_MS = 1600;
/** Si no se escucha nada en todo este rato, se cierra solo en vez de quedar abierto. */
const NO_SPEECH_MS = 7000;
/** Tope duro: ni con ruido de fondo el micrófono se queda abierto para siempre. */
const MAX_MS = 25000;

type RecognitionCtor = new () => RecognitionLike;

function ctor(): RecognitionCtor | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export function recognitionSupported(): boolean {
  return Boolean(ctor());
}

export interface ListenHandlers {
  /** Lo que se va entendiendo, para mostrarlo mientras la persona habla. */
  onPartial?: (text: string) => void;
  /** El texto definitivo. Puede no llegar si se cortó sin decir nada. */
  onFinal: (text: string) => void;
  onEnd?: () => void;
  onError?: (reason: string) => void;
}

/**
 * Empieza a escuchar y devuelve cómo parar. Se para sola cuando la persona deja de hablar; el
 * texto definitivo llega por `onFinal` una sola vez.
 */
export function startListening(handlers: ListenHandlers): () => void {
  const Ctor = ctor();
  if (!Ctor) {
    handlers.onError?.('unsupported');
    return () => undefined;
  }
  const recognition = new Ctor();
  // La variante se elige en Ajustes: cada código va a un modelo distinto y no hay forma de medir
  // desde acá cuál entiende mejor en cada teléfono.
  recognition.lang = getSttLang();
  recognition.continuous = false;
  recognition.interimResults = true;

  let final = '';
  let ultimoParcial = '';
  let cerrado = false;
  let silencio: ReturnType<typeof setTimeout> | undefined;

  const limpiar = () => {
    if (silencio) clearTimeout(silencio);
    silencio = undefined;
  };

  /**
   * El corte lo maneja esta cuenta y no el navegador. Chrome no siempre marca el resultado como
   * final ni dispara el fin cuando hay ruido de fondo, así que el micrófono quedaba abierto para
   * siempre; acá se cierra solo después de un silencio.
   */
  const rearmar = (ms: number) => {
    limpiar();
    silencio = setTimeout(() => {
      try {
        // `stop` entrega lo escuchado; `abort` lo tira. Acá se quiere la pregunta.
        recognition.stop();
      } catch {
        cerrar();
      }
    }, ms);
  };

  const cerrar = () => {
    if (cerrado) return;
    cerrado = true;
    limpiar();
    const texto = (final || ultimoParcial).trim();
    if (texto) handlers.onFinal(texto);
    handlers.onEnd?.();
  };

  const tope = setTimeout(() => {
    try {
      recognition.stop();
    } catch {
      cerrar();
    }
  }, MAX_MS);

  recognition.onresult = (event) => {
    let parcial = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = result?.[0]?.transcript ?? '';
      if (result?.isFinal) final += text;
      else parcial += text;
    }
    const visible = (final + parcial).trim();
    if (visible) {
      ultimoParcial = visible;
      handlers.onPartial?.(visible);
    }
    // Ya se escuchó algo: a partir de acá alcanza con una pausa corta para dar por terminado.
    rearmar(SILENCE_MS);
  };

  recognition.onspeechend = () => rearmar(400);

  recognition.onerror = (event) => {
    const motivo = event.error ?? 'error';
    // "no-speech" no es un error para quien habla: simplemente no dijo nada.
    if (motivo === 'no-speech' || motivo === 'aborted') {
      clearTimeout(tope);
      cerrar();
      return;
    }
    clearTimeout(tope);
    limpiar();
    if (!cerrado) {
      cerrado = true;
      handlers.onError?.(motivo);
    }
  };

  recognition.onend = () => {
    clearTimeout(tope);
    cerrar();
  };

  try {
    recognition.start();
    rearmar(NO_SPEECH_MS);
  } catch {
    clearTimeout(tope);
    handlers.onError?.('start_failed');
  }

  return () => {
    clearTimeout(tope);
    limpiar();
    cerrado = true;
    try {
      recognition.abort();
    } catch {
      // Cortar a mano no puede fallar hacia afuera.
    }
    handlers.onEnd?.();
  };
}
