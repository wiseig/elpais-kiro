/**
 * Desbloqueo del audio en el teléfono. iOS —y Android en parte— solo deja sonar lo que arranca
 * dentro de un toque de la persona, y la voz de la respuesta llega varios segundos después del
 * toque, al final de una cadena asíncrona: el navegador la rechazaba en silencio y no se oía
 * nada (17/9/2026). La salida es la de siempre: un único reproductor que se pone a sonar, mudo,
 * en el momento del toque, y que después se reutiliza para cada respuesta. Un elemento que ya
 * sonó por un gesto puede seguir sonando sin gesto.
 */

/** Un WAV de un cuadro en silencio: alcanza para que el toque cuente como reproducción. */
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';

let element: HTMLAudioElement | null = null;

/** El reproductor compartido del modo voz. */
export function voiceAudioElement(): HTMLAudioElement {
  if (!element) {
    element = new Audio();
    element.preload = 'auto';
    // Que suene por el parlante aunque la página esté en un teléfono en silencio de notificaciones.
    element.setAttribute('playsinline', 'true');
  }
  return element;
}

/**
 * Llamar solo desde un manejador de toque o clic. Deja el reproductor y la síntesis del
 * navegador habilitados para sonar más tarde sin otro gesto.
 */
export function unlockAudio(): void {
  const audio = voiceAudioElement();
  // Una respuesta frenada a medio camino (pausa) o cargada y quieta no se toca: cambiarle la
  // fuente la perdía y al reanudar el modo voz volvía a escuchar en vez de seguirla (18/9/2026).
  // El reproductor ya sonó por un gesto, así que sigue habilitado igual.
  const frenada = audio.paused && !audio.ended && Boolean(audio.src) && audio.src !== SILENT_WAV;
  if (audio.paused && !frenada) {
    audio.src = SILENT_WAV;
    void audio.play().catch(() => {
      // Si ni esto se puede, la reproducción posterior va a fallar y el chat cae a la voz del
      // navegador o queda mudo: no hay más que se pueda hacer sin un gesto.
    });
  }
  // La voz del navegador también necesita haber hablado una vez dentro de un gesto en iOS.
  if (typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function') {
    const utterance = new SpeechSynthesisUtterance(' ');
    utterance.volume = 0;
    window.speechSynthesis.speak(utterance);
  }
}
