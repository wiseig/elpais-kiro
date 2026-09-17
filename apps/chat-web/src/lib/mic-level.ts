/**
 * Nivel del micrófono para que el orbe se mueva con la voz. Es solo para la animación: el audio
 * no se graba, no se guarda y no sale del dispositivo; se mide la energía de la señal y se
 * descarta. Si el navegador no da permiso, el orbe sigue animándose solo.
 */
export interface MicLevel {
  /** 0 a 1. Se lee en cada cuadro de la animación. */
  read(): number;
  stop(): void;
}

export async function startMicLevel(): Promise<MicLevel | null> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      for (const track of stream.getTracks()) track.stop();
      return null;
    }
    const context = new Ctor();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const buffer = new Uint8Array(analyser.frequencyBinCount);

    return {
      read() {
        analyser.getByteTimeDomainData(buffer);
        // Energía de la onda respecto del silencio (128): da un número estable para animar.
        let sum = 0;
        for (const sample of buffer) {
          const centered = (sample - 128) / 128;
          sum += centered * centered;
        }
        return Math.min(1, Math.sqrt(sum / buffer.length) * 3.2);
      },
      stop() {
        for (const track of stream.getTracks()) track.stop();
        void context.close();
      },
    };
  } catch {
    return null;
  }
}
