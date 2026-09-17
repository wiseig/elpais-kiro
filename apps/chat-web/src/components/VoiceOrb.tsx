import { useEffect, useRef, useState } from 'react';
import { startMicLevel } from '../lib/mic-level';

/**
 * El orbe del modo voz. Aparece apenas se toca el micrófono y acompaña los tres momentos:
 * escuchando late con la voz de quien habla, pensando gira más rápido y respondiendo ondula
 * despacio. Es CSS puro —sin canvas ni librería— y se queda quieto con `prefers-reduced-motion`.
 *
 * Va por encima de la conversación y no dentro del flujo: metido arriba de la barra de escribir
 * la empujaba fuera de la pantalla (medido, 223 px de alto en una ventana chica).
 */
export type OrbState = 'listening' | 'thinking' | 'speaking';

const LABEL: Record<OrbState, string> = {
  listening: 'Te escucho…',
  thinking: 'Pensando…',
  speaking: 'Respondiendo…',
};

export function VoiceOrb({ state, onCancel }: { state: OrbState; onCancel: () => void }) {
  const [level, setLevel] = useState(0);
  const frameRef = useRef<number | null>(null);

  // El micrófono se mide solo mientras escucha: el audio no se graba ni sale del dispositivo.
  useEffect(() => {
    if (state !== 'listening') {
      setLevel(0);
      return undefined;
    }
    let cancelled = false;
    let mic: Awaited<ReturnType<typeof startMicLevel>> = null;
    void startMicLevel().then((result) => {
      if (cancelled) {
        result?.stop();
        return;
      }
      mic = result;
      if (!mic) return;
      const tick = () => {
        if (cancelled || !mic) return;
        setLevel(mic.read());
        frameRef.current = requestAnimationFrame(tick);
      };
      tick();
    });
    return () => {
      cancelled = true;
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      mic?.stop();
    };
  }, [state]);

  const scale = state === 'listening' ? 1 + Math.min(0.4, level * 0.5) : 1;
  return (
    <div className="voice-overlay">
      <div className={`orb orb--${state}`} role="status" aria-live="polite">
        <div className="orb-ring" style={{ transform: `scale(${scale.toFixed(3)})` }}>
          <span className="orb-blob orb-blob--1" />
          <span className="orb-blob orb-blob--2" />
          <span className="orb-blob orb-blob--3" />
        </div>
        <p className="orb-label">{LABEL[state]}</p>
        <button type="button" className="orb-cancel" onClick={onCancel}>
          Cortar
        </button>
      </div>
    </div>
  );
}
