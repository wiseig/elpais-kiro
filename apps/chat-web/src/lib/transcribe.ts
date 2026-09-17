import { EventStreamCodec } from '@smithy/eventstream-codec';
import type { ApiClient } from './api';
import type { ListenHandlers } from './listen';

/**
 * Dictado contra Amazon Transcribe en streaming. El motor firma la URL; el navegador captura el
 * micrófono, lo baja a PCM de 16 kHz y lo manda por WebSocket en mensajes del protocolo de
 * eventos de AWS. Misma interfaz que el dictado del navegador (`startListening`), así el chat
 * cambia de uno a otro sin enterarse.
 *
 * El corte por silencio lo maneja esta función y no el servicio, igual que con el navegador:
 * tras una pausa se cierra y se manda lo entendido.
 */
const SILENCE_MS = 1600;
const NO_SPEECH_MS = 7000;
const MAX_MS = 25000;

const toUtf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const fromUtf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const codec = new EventStreamCodec(toUtf8, fromUtf8);

function audioEvent(payload: Uint8Array): Uint8Array {
  return codec.encode({
    headers: {
      ':message-type': { type: 'string', value: 'event' },
      ':event-type': { type: 'string', value: 'AudioEvent' },
      ':content-type': { type: 'string', value: 'application/octet-stream' },
    },
    body: payload,
  });
}

/** Baja la señal a la tasa pedida y la deja en enteros de 16 bits, que es lo que come Transcribe. */
function toPcm16(input: Float32Array, fromRate: number, toRate: number): Uint8Array {
  const ratio = fromRate / toRate;
  const length = Math.floor(input.length / ratio);
  const out = new DataView(new ArrayBuffer(length * 2));
  for (let i = 0; i < length; i += 1) {
    const sample = input[Math.floor(i * ratio)] ?? 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    out.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return new Uint8Array(out.buffer);
}

interface TranscriptMessage {
  Transcript?: { Results?: { IsPartial?: boolean; Alternatives?: { Transcript?: string }[] }[] };
  Message?: string;
}

export function startTranscribe(api: ApiClient, handlers: ListenHandlers): () => void {
  let cerrado = false;
  let ws: WebSocket | null = null;
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  let silencio: ReturnType<typeof setTimeout> | undefined;
  let final = '';
  let ultimoParcial = '';

  const limpiar = () => {
    if (silencio) clearTimeout(silencio);
    silencio = undefined;
  };

  const soltarAudio = () => {
    processor?.disconnect();
    processor = null;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    void context?.close();
    context = null;
  };

  const cerrar = (entregar: boolean) => {
    if (cerrado) return;
    cerrado = true;
    limpiar();
    clearTimeout(tope);
    soltarAudio();
    try {
      // Un AudioEvent vacío le dice al servicio que no hay más audio.
      if (ws?.readyState === WebSocket.OPEN) ws.send(audioEvent(new Uint8Array(0)));
      ws?.close();
    } catch {
      // Cerrar no puede fallar hacia afuera.
    }
    if (entregar) {
      const texto = (final || ultimoParcial).trim();
      if (texto) handlers.onFinal(texto);
    }
    handlers.onEnd?.();
  };

  const fallar = (motivo: string) => {
    if (cerrado) return;
    cerrado = true;
    limpiar();
    clearTimeout(tope);
    soltarAudio();
    try {
      ws?.close();
    } catch {
      // idem
    }
    handlers.onError?.(motivo);
  };

  const rearmar = (ms: number) => {
    limpiar();
    silencio = setTimeout(() => cerrar(true), ms);
  };

  const tope = setTimeout(() => cerrar(true), MAX_MS);

  void (async () => {
    try {
      const [firma, mic] = await Promise.all([api.transcribeUrl(), navigator.mediaDevices.getUserMedia({ audio: true })]);
      if (cerrado) {
        for (const track of mic.getTracks()) track.stop();
        return;
      }
      stream = mic;
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) throw new Error('sin AudioContext');
      // Se pide la tasa del servicio; si el navegador no la respeta, se baja a mano en toPcm16.
      context = new Ctor({ sampleRate: firma.sampleRate });
      const source = context.createMediaStreamSource(mic);
      processor = context.createScriptProcessor(4096, 1, 1);
      const fromRate = context.sampleRate;

      ws = new WebSocket(firma.url);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        if (!context || !processor) return;
        processor.onaudioprocess = (event) => {
          if (ws?.readyState !== WebSocket.OPEN) return;
          ws.send(audioEvent(toPcm16(event.inputBuffer.getChannelData(0), fromRate, firma.sampleRate)));
        };
        source.connect(processor);
        processor.connect(context.destination);
        rearmar(NO_SPEECH_MS);
      };

      ws.onmessage = (event) => {
        const message = codec.decode(new Uint8Array(event.data as ArrayBuffer));
        const tipo = message.headers[':message-type']?.value;
        const cuerpo = JSON.parse(toUtf8(message.body)) as TranscriptMessage;
        if (tipo === 'exception') {
          fallar(cuerpo.Message ?? 'transcribe');
          return;
        }
        const results = cuerpo.Transcript?.Results ?? [];
        if (!results.length) return;
        let parcial = '';
        for (const result of results) {
          const texto = result.Alternatives?.[0]?.Transcript ?? '';
          if (!texto) continue;
          if (result.IsPartial === false) final = `${final} ${texto}`.trim();
          else parcial = texto;
        }
        const visible = `${final} ${parcial}`.trim();
        if (visible) {
          ultimoParcial = visible;
          handlers.onPartial?.(visible);
        }
        rearmar(SILENCE_MS);
      };

      ws.onerror = () => fallar('websocket');
      ws.onclose = () => {
        if (!cerrado) cerrar(true);
      };
    } catch (error) {
      fallar(error instanceof DOMException && error.name === 'NotAllowedError' ? 'not-allowed' : 'start_failed');
    }
  })();

  return () => {
    // Cortar a mano no manda la pregunta.
    if (cerrado) return;
    cerrado = true;
    limpiar();
    clearTimeout(tope);
    soltarAudio();
    try {
      ws?.close();
    } catch {
      // idem
    }
    handlers.onEnd?.();
  };
}
