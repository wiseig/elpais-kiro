import { useEffect, useRef, type RefObject } from 'react';
import { approach, stateEnergy, type NumberRef, type OrbState } from './orb-state';
import { observeActivity } from './use-in-view';

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * Publica el nivel en variables CSS para que el orbe lo lea cuadro a cuadro. Si hay micrófono
 * usa lo que entra; si no, una animación propia según el estado.
 */
export const useOrbLevel = (ref: RefObject<HTMLElement | null>, state: OrbState, levelRef?: NumberRef) => {
  const smoothedRef = useRef(0);
  const clockRef = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const name of ['--orb-level', '--orb-bass', '--orb-mid', '--orb-treble']) el.style.setProperty(name, '0');
      return undefined;
    }

    let raf = 0;
    let last: number | null = null;
    let active = true;

    const frame = (now: number) => {
      raf = 0;
      const dt = last === null ? 0 : Math.min((now - last) / 1000, 0.1);
      last = now;
      clockRef.current += dt;
      const live = levelRef?.current;
      const hasLive = typeof live === 'number' && live >= 0;
      const target = hasLive ? live : stateEnergy(state, clockRef.current);
      smoothedRef.current = approach(smoothedRef.current, target, 7.7, dt);
      const level = smoothedRef.current;
      const t = clockRef.current;
      el.style.setProperty('--orb-level', level.toFixed(3));
      el.style.setProperty('--orb-bass', clamp01(level * (0.78 + 0.22 * Math.sin(t * 2.3))).toFixed(3));
      el.style.setProperty('--orb-mid', clamp01(level * (0.78 + 0.22 * Math.sin(t * 3.4 + 2.1))).toFixed(3));
      el.style.setProperty('--orb-treble', clamp01(level * (0.78 + 0.22 * Math.sin(t * 4.6 + 4.2))).toFixed(3));
      if (active) raf = requestAnimationFrame(frame);
      else last = null;
    };

    const wake = () => {
      if (raf === 0) raf = requestAnimationFrame(frame);
    };
    const halt = () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      raf = 0;
      last = null;
    };

    const unobserve = observeActivity(el, (next) => {
      active = next;
      if (next) wake();
      else halt();
    });
    wake();

    return () => {
      halt();
      unobserve();
    };
  }, [ref, state, levelRef]);
};
