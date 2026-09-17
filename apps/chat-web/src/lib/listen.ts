/**
 * Dictado con el reconocimiento de voz del navegador. Como la lectura, es del lado del cliente:
 * no manda audio a ningún lado y no cuesta nada. Chrome y Safari lo traen; Firefox no, y ahí el
 * botón del micrófono no aparece.
 */

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
}

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
  recognition.lang = 'es-UY';
  recognition.continuous = false;
  recognition.interimResults = true;

  let final = '';
  recognition.onresult = (event) => {
    let partial = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = result?.[0]?.transcript ?? '';
      if (result?.isFinal) final += text;
      else partial += text;
    }
    if (partial) handlers.onPartial?.((final + partial).trim());
  };
  recognition.onerror = (event) => handlers.onError?.(event.error ?? 'error');
  recognition.onend = () => {
    const text = final.trim();
    if (text) handlers.onFinal(text);
    handlers.onEnd?.();
  };

  try {
    recognition.start();
  } catch {
    handlers.onError?.('start_failed');
  }
  return () => recognition.abort();
}
