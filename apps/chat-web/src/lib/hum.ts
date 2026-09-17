/**
 * El "mmm" de mientras piensa. Se sintetiza con el Web Audio API en vez de traer un archivo: son
 * dos osciladores graves con un vibrato suave, así que no hay nada que descargar ni que hostear y
 * el volumen queda bien por debajo de la voz.
 */

let context: AudioContext | null = null;
let stop: (() => void) | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  context ??= new Ctor();
  return context;
}

/**
 * Crea y despierta el contexto dentro de un toque. En iOS un AudioContext creado fuera de un gesto
 * nace suspendido y `resume()` no lo levanta: el "mmm" no sonaba.
 */
export function primeHum(): void {
  const ctx = audioContext();
  if (ctx && ctx.state === 'suspended') void ctx.resume();
}

export function startHum(): void {
  if (stop) return;
  const ctx = audioContext();
  if (!ctx) return;
  void ctx.resume();

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, ctx.currentTime);
  // Entra de a poco: un zumbido que aparece de golpe se siente un error del navegador.
  gain.gain.linearRampToValueAtTime(0.045, ctx.currentTime + 0.5);
  gain.connect(ctx.destination);

  // Dos voces muy cercanas dan el batido que hace que suene tibio y no a tono de prueba.
  const voices = [110, 110.6].map((frequency) => {
    const oscillator = ctx.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    oscillator.start();
    return oscillator;
  });

  // Vibrato lento: lo que hace que se lea como un "mmm" y no como un zumbido de máquina.
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.7;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 2.5;
  lfo.connect(lfoGain);
  for (const voice of voices) lfoGain.connect(voice.frequency);
  lfo.start();

  stop = () => {
    const end = ctx.currentTime + 0.35;
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, end);
    for (const voice of voices) voice.stop(end);
    lfo.stop(end);
  };
}

export function stopHum(): void {
  stop?.();
  stop = null;
}
