import { acquireSharedAnalyser, releaseSharedAnalyser } from './orb/use-audio-level';

/**
 * Recuerda cuándo sonó voz cerca del micrófono. El reconocimiento transcribe también la charla
 * de fondo, que llega más floja: un resultado se acepta solo si hace poco hubo señal fuerte en la
 * banda de la voz. Si no se puede medir (sin permiso, sin AudioContext) no se filtra nada: mejor
 * un poco de ruido que un micrófono mudo.
 */
const VOICE_MIN_HZ = 85;
const VOICE_MAX_HZ = 3800;
/** Umbral sobre 0..1 del promedio de la banda de voz. La charla a dos metros queda debajo. */
const LOUD = 0.22;

export interface VoiceEnergy {
  /** Hubo voz fuerte en los últimos `windowMs`. Siempre true si no se pudo medir. */
  recentlyLoud(windowMs: number): boolean;
  stop(): void;
}

export function startVoiceEnergy(): VoiceEnergy {
  let lastLoudAt = 0;
  let measuring = false;
  let stopped = false;
  let raf = 0;

  void acquireSharedAnalyser().then(
    (analyser) => {
      if (stopped) return;
      measuring = true;
      const bins = analyser.frequencyBinCount;
      const nyquist = analyser.context.sampleRate / 2;
      const binFor = (hz: number) => Math.min(bins, Math.max(1, Math.round((hz / nyquist) * bins)));
      const lo = binFor(VOICE_MIN_HZ);
      const hi = Math.max(lo + 1, binFor(VOICE_MAX_HZ));
      const data = new Uint8Array(bins);
      const tick = () => {
        if (stopped) return;
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = lo; i < hi; i += 1) sum += data[i] ?? 0;
        if (sum / (hi - lo) / 255 >= LOUD) lastLoudAt = Date.now();
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    },
    () => {
      measuring = false;
    },
  );

  return {
    recentlyLoud: (windowMs) => !measuring || Date.now() - lastLoudAt <= windowMs,
    stop: () => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(raf);
      releaseSharedAnalyser();
    },
  };
}
