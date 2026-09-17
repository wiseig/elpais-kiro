/**
 * El orbe del modo voz. Tres manchas de color girando a distinta velocidad dentro de un círculo:
 * escuchando late al ritmo de lo que entra, pensando gira más rápido y hablando ondula despacio.
 * Es CSS puro —sin canvas ni librería— y se queda quieto con `prefers-reduced-motion`.
 */
export type OrbState = 'listening' | 'thinking' | 'speaking';

const LABEL: Record<OrbState, string> = {
  listening: 'Te escucho…',
  thinking: 'Pensando…',
  speaking: 'Respondiendo…',
};

export function VoiceOrb({ state, level = 0 }: { state: OrbState; level?: number }) {
  // El nivel del micrófono ensancha el halo: da la sensación de que reacciona a la voz.
  const scale = state === 'listening' ? 1 + Math.min(0.35, level * 0.45) : 1;
  return (
    <div className={`orb orb--${state}`} role="status" aria-live="polite">
      <div className="orb-ring" style={{ transform: `scale(${scale.toFixed(3)})` }}>
        <span className="orb-blob orb-blob--1" />
        <span className="orb-blob orb-blob--2" />
        <span className="orb-blob orb-blob--3" />
      </div>
      <p className="orb-label">{LABEL[state]}</p>
    </div>
  );
}
