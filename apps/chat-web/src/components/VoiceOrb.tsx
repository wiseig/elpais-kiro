import type { OrbState } from '../lib/orb/orb-state';
import { useAudioLevel } from '../lib/orb/use-audio-level';
import { ParticlesOrb } from './ParticlesOrb';

/**
 * El orbe del modo voz sobre la conversación. Muestra en qué momento está: escuchando, pensando,
 * preparando la voz o respondiendo. El texto de abajo va en la tipografía de las respuestas y es
 * una región viva, así que un lector de pantalla también se entera del cambio de estado.
 */
const LABEL: Record<OrbState, string> = {
  idle: '',
  connecting: 'Preparando la voz…',
  listening: 'Te escucho…',
  thinking: 'Buscando en las notas…',
  speaking: 'Respondiendo…',
  error: 'No se pudo escuchar',
  disabled: '',
};

export function VoiceOrb({
  state,
  transcript,
  onCancel,
  onInterrupt,
}: {
  state: OrbState;
  transcript?: string;
  onCancel: () => void;
  /** Cortar la respuesta y preguntar otra cosa, sin salir del modo. */
  onInterrupt?: () => void;
}) {
  // El micrófono solo se mide mientras escucha: el audio anima el orbe y nada más. Si no hay
  // permiso para medirlo, el orbe se anima solo; quién decide si el dictado falló es el
  // reconocimiento, no el medidor, así que acá no se muestra ningún error.
  const { levelRef } = useAudioLevel(state === 'listening');
  const visible: OrbState = state;
  const puedeInterrumpir = Boolean(onInterrupt) && (state === 'speaking' || state === 'connecting');

  return (
    <div className="voice-overlay">
      <div className="voice-panel">
        {/* Mientras responde o prepara la voz, tocar el orbe la corta y vuelve a escuchar. En
            pleno "pensando" no: la pregunta anterior sigue en vuelo y una nueva se pisaría. */}
        {puedeInterrumpir ? (
          <button type="button" className="voice-orb-button" onClick={onInterrupt} aria-label="Interrumpir y preguntar otra cosa">
            <ParticlesOrb state={visible} size={168} speed={1} colorFrom="#818cf8" colorTo="#22d3ee" levelRef={levelRef} label="" />
          </button>
        ) : (
          <ParticlesOrb state={visible} size={168} speed={1} colorFrom="#818cf8" colorTo="#22d3ee" levelRef={levelRef} label="Asistente de voz" />
        )}
        <p className="voice-status" role="status" aria-live="polite" aria-atomic="true">
          {LABEL[visible]}
        </p>
        {puedeInterrumpir ? <p className="voice-hint">Tocá el orbe para interrumpir y preguntar otra cosa</p> : null}
        {/* Lo que se va entendiendo, para verlo mientras se habla. En gris: todavía no es la
            pregunta mandada, es lo que el reconocimiento cree escuchar. */}
        {transcript ? <p className="voice-transcript">{transcript}</p> : null}
        <button type="button" className="voice-cancel" onClick={onCancel}>
          Cortar
        </button>
      </div>
    </div>
  );
}
