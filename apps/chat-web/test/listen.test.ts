import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startListening } from '../src/lib/listen';

/** Reconocimiento falso: deja disparar a mano lo que el navegador dispararía. */
class FakeRecognition {
  lang = '';
  continuous = false;
  interimResults = false;
  started = false;
  stopped = false;
  aborted = false;
  onresult: ((event: unknown) => void) | null = null;
  onspeechend: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  static last: FakeRecognition | undefined;

  constructor() {
    FakeRecognition.last = this;
  }
  start() {
    this.started = true;
  }
  /** Como el navegador: `stop` entrega lo escuchado y termina. */
  stop() {
    this.stopped = true;
    this.onend?.();
  }
  abort() {
    this.aborted = true;
  }
  emit(transcript: string, isFinal: boolean) {
    this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript }], { isFinal })] });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as unknown as { window: unknown }).window = globalThis;
  (globalThis as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeRecognition;
});

afterEach(() => {
  vi.useRealTimers();
  FakeRecognition.last = undefined;
});

describe('startListening', () => {
  it('cierra solo tras un silencio y entrega lo dicho', () => {
    const onFinal = vi.fn();
    const onEnd = vi.fn();
    startListening({ onFinal, onEnd });
    const recognition = FakeRecognition.last!;
    expect(recognition.started).toBe(true);

    recognition.emit('¿Cómo cerró el dólar?', true);
    // Todavía no: la persona podría seguir hablando.
    vi.advanceTimersByTime(1000);
    expect(onFinal).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(recognition.stopped).toBe(true);
    expect(onFinal).toHaveBeenCalledWith('¿Cómo cerró el dólar?');
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('cada palabra nueva corre el reloj del silencio', () => {
    const onFinal = vi.fn();
    startListening({ onFinal });
    const recognition = FakeRecognition.last!;
    for (let i = 0; i < 5; i += 1) {
      recognition.emit(`palabra ${i} `, false);
      vi.advanceTimersByTime(1200);
      expect(onFinal).not.toHaveBeenCalled();
    }
    vi.advanceTimersByTime(1700);
    expect(onFinal).toHaveBeenCalledTimes(1);
  });

  it('usa lo provisional cuando el navegador nunca marca el final', () => {
    const onFinal = vi.fn();
    startListening({ onFinal });
    const recognition = FakeRecognition.last!;
    recognition.emit('qué pasó hoy', false);
    vi.advanceTimersByTime(1700);
    expect(onFinal).toHaveBeenCalledWith('qué pasó hoy');
  });

  it('si no se escucha nada, se cierra sin mandar pregunta', () => {
    const onFinal = vi.fn();
    const onEnd = vi.fn();
    startListening({ onFinal, onEnd });
    vi.advanceTimersByTime(7100);
    expect(FakeRecognition.last!.stopped).toBe(true);
    expect(onFinal).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('no queda abierto para siempre con ruido de fondo', () => {
    const onFinal = vi.fn();
    startListening({ onFinal });
    const recognition = FakeRecognition.last!;
    // Ruido constante: cada resultado rearma el silencio, así que solo corta el tope duro.
    for (let i = 0; i < 40; i += 1) {
      recognition.emit('mmm ', false);
      vi.advanceTimersByTime(1000);
    }
    expect(recognition.stopped).toBe(true);
  });

  it('cortar a mano no manda la pregunta', () => {
    const onFinal = vi.fn();
    const onEnd = vi.fn();
    const escucha = startListening({ onFinal, onEnd });
    FakeRecognition.last!.emit('algo', true);
    escucha.cancel();
    vi.advanceTimersByTime(5000);
    expect(FakeRecognition.last!.aborted).toBe(true);
    expect(onFinal).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('ignora lo que no pasa el filtro: no rearma el silencio ni se manda', () => {
    const onFinal = vi.fn();
    const onPartial = vi.fn();
    // Solo pasa lo que empieza con "¿": el resto es la charla de al lado.
    startListening({ onFinal, onPartial }, { accept: (text) => text.startsWith('¿') });
    const recognition = FakeRecognition.last!;
    for (let i = 0; i < 5; i += 1) {
      recognition.emit('bla bla de fondo ', false);
      vi.advanceTimersByTime(1000);
    }
    // 5 s de ruido: el reloj de "no se escucha nada" no se movió y cierra a los 7 s sin mandar.
    expect(onPartial).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2100);
    expect(recognition.stopped).toBe(true);
    expect(onFinal).not.toHaveBeenCalled();
  });

  it('un final que no pasa el filtro se descarta aunque el navegador lo marque definitivo', () => {
    const onFinal = vi.fn();
    startListening({ onFinal }, { accept: (text) => text.includes('dólar') });
    const recognition = FakeRecognition.last!;
    recognition.emit('ruido de fondo', true);
    vi.advanceTimersByTime(7100);
    expect(onFinal).not.toHaveBeenCalled();
  });

  it('finish() entrega lo que hay sin esperar el silencio (mantener apretado)', () => {
    const onFinal = vi.fn();
    const escucha = startListening({ onFinal });
    FakeRecognition.last!.emit('¿Cómo cerró el dólar?', false);
    vi.advanceTimersByTime(200);
    escucha.finish();
    expect(onFinal).toHaveBeenCalledWith('¿Cómo cerró el dólar?');
  });

  it('une los finales con espacio: el navegador los entrega pegados', () => {
    const onFinal = vi.fn();
    startListening({ onFinal });
    const recognition = FakeRecognition.last!;
    recognition.emit('¿Cómo cerró', true);
    recognition.emit('el dólar?', true);
    vi.advanceTimersByTime(1700);
    expect(onFinal).toHaveBeenCalledWith('¿Cómo cerró el dólar?');
  });
});
