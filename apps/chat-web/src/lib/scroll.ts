/**
 * Utilidades del comportamiento "pegado al final" (9.x). El scroll vive en el panel de la
 * conversación (`.scroll-area`), no en la ventana: así el riel, el encabezado y el composer
 * quedan quietos y solo se mueve la charla.
 */

const DEFAULT_THRESHOLD_PX = 120;

/** Píxeles que faltan para llegar al final (negativo con el rebote elástico). */
export function distanceFromBottom(el: HTMLElement | null): number {
  if (!el) return 0;
  return el.scrollHeight - (el.scrollTop + el.clientHeight);
}

/** true si el panel está a menos de `thresholdPx` del final. */
export function isNearBottom(el: HTMLElement | null, thresholdPx: number = DEFAULT_THRESHOLD_PX): boolean {
  if (!el) return true;
  return distanceFromBottom(el) <= thresholdPx;
}

/**
 * Lleva el panel al final. Si ya está al final no hace nada: llamarlo igual cortaba el rebote
 * elástico del trackpad y la página parecía moverse sola.
 */
export function scrollToBottom(el: HTMLElement | null, behavior: ScrollBehavior): void {
  if (!el) return;
  if (distanceFromBottom(el) <= 2) return;
  el.scrollTo({ top: el.scrollHeight, behavior });
}

/** Vuelve al principio (conversación nueva o cambio de conversación). */
export function scrollToTop(el: HTMLElement | null, behavior: ScrollBehavior): void {
  if (!el) return;
  el.scrollTo({ top: 0, behavior });
}
