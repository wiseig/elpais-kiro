import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '../lib/format';

interface Props {
  /** Sugerencias del día (`GET /v1/suggestions`); si viene vacía usamos `FALLBACK_ITEMS`. */
  items: string[];
  onSend: (question: string) => void;
}

/** Ritmo de la máquina de escribir, en milisegundos. */
const TYPE_MS = 38;
const DELETE_MS = 16;
const HOLD_MS = 1900;
const NEXT_MS = 320;

export const FALLBACK_ITEMS = [
  '¿Cómo abrió el dólar hoy?',
  '¿Qué pasó en el puerto?',
  '¿Cuándo cambia la reforma del transporte?',
  '¿Cómo le fue a la selección?',
];

/**
 * Línea de la portada que escribe y borra preguntas de ejemplo, tipo máquina de escribir.
 * Se pausa mientras la pestaña está oculta y, con "menos movimiento" activado, muestra una
 * sola pregunta fija. El botón siempre envía la pregunta completa, aunque se vea a medias.
 */
export function RotatingPrompt({ items, onSend }: Props) {
  const list = items.length > 0 ? items : FALLBACK_ITEMS;
  const reduced = prefersReducedMotion();
  const [index, setIndex] = useState(0);
  // Arranca con la primera pregunta entera: si la animación no corre (pestaña en segundo
  // plano, temporizadores frenados por el navegador) igual se lee una pregunta completa.
  const [typed, setTyped] = useState(list[0] ?? '');
  const listRef = useRef(list);
  listRef.current = list;
  /** Identidad estable de la lista: evita reiniciar el ciclo en cada render. */
  const listKey = list.join('|');

  useEffect(() => {
    const first = listRef.current[0] ?? '';
    setIndex(0);
    setTyped(first);
    if (reduced || listRef.current.length <= 1) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current = 0;
    let chars = first.length;
    let deleting = true;

    const clear = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };

    const tick = () => {
      if (cancelled) return;
      const full = listRef.current[current] ?? '';
      if (deleting) {
        chars = Math.max(chars - 1, 0);
        setTyped(full.slice(0, chars));
        if (chars === 0) {
          deleting = false;
          current = (current + 1) % listRef.current.length;
          setIndex(current);
          timer = setTimeout(tick, NEXT_MS);
          return;
        }
        timer = setTimeout(tick, DELETE_MS);
        return;
      }
      chars = Math.min(chars + 1, full.length);
      setTyped(full.slice(0, chars));
      if (chars >= full.length) {
        deleting = true;
        timer = setTimeout(tick, HOLD_MS);
        return;
      }
      timer = setTimeout(tick, TYPE_MS);
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        // En segundo plano se deja la pregunta entera, no una a medio escribir.
        clear();
        const full = listRef.current[current] ?? '';
        chars = full.length;
        deleting = true;
        setTyped(full);
        return;
      }
      if (timer === undefined) timer = setTimeout(tick, HOLD_MS);
    };

    if (document.visibilityState !== 'hidden') timer = setTimeout(tick, HOLD_MS);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      cancelled = true;
      clear();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [listKey, reduced]);

  const full = list[index] ?? list[0] ?? '';

  return (
    <div className="home-rotator">
      <p className="home-rotator-lead">¿Qué querés saber?</p>
      {/* Renglón propio y con alto reservado: si compartiera línea con el texto de arriba,
          este se movería cada vez que la pregunta crece y salta de renglón. */}
      <p className="home-rotator-line">
        <button
          type="button"
          className="home-rotator-item"
          aria-label={full}
          onClick={() => onSend(full)}
        >
          <span aria-hidden="true">{reduced ? full : typed}</span>
          {reduced ? null : <span className="home-rotator-caret" aria-hidden="true" />}
        </button>
      </p>
    </div>
  );
}
