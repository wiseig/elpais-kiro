import { useRef, type KeyboardEvent } from 'react';
import type { OrbState } from '../lib/orb/orb-state';
import { useAudioLevel } from '../lib/orb/use-audio-level';
import { MicIcon } from './Icons';
import { ParticlesOrb } from './ParticlesOrb';

/**
 * El orbe del modo voz sobre la conversación. Muestra en qué momento está: escuchando, pensando,
 * preparando la voz o respondiendo. El texto de abajo va en la tipografía de las respuestas y es
 * una región viva, así que un lector de pantalla también se entera del cambio de estado.
 *
 * Abajo van los tres controles: pausa, micrófono y cerrar. El micrófono es el que habla: un toque
 * abre, otro toque manda, y mantenerlo apretado habla mientras dura el apretón (soltar manda).
 */
const LABEL: Record<OrbState, string> = {
  idle: 'Tocá el micrófono para preguntar',
  connecting: 'Preparando la voz…',
  listening: 'Te escucho…',
  thinking: 'Buscando en las notas…',
  speaking: 'Respondiendo…',
  error: 'No se pudo escuchar',
  disabled: '',
};

/** Por qué no se pudo escuchar, en palabras de quien habla. Lo demás cae en el genérico. */
const ERROR_LABEL: Record<string, string> = {
  'not-allowed': 'No hay permiso para usar el micrófono',
  'no-connect': 'No se pudo conectar el reconocimiento',
  network: 'Sin conexión para reconocer la voz',
  'audio-capture': 'No se encontró un micrófono',
  unsupported: 'Este navegador no puede escuchar',
};

const ORB = { size: 168, speed: 1, colorFrom: '#818cf8', colorTo: '#22d3ee' } as const;

/** Menos que esto es un toque (el micrófono queda abierto); más, un apretón (soltar manda). */
const HOLD_MS = 350;

function IconPause() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path d="M8 5h3v14H8zM13 5h3v14h-3z" fill="currentColor" />
    </svg>
  );
}
function IconPlay() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path d="M8 5v14l11-7z" fill="currentColor" />
    </svg>
  );
}
function IconClose() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
    </svg>
  );
}
export function VoiceOrb({
  state,
  error,
  transcript,
  paused,
  onTogglePause,
  onTalkStart,
  onTalkEnd,
  onClose,
}: {
  state: OrbState;
  /** Motivo del último error del reconocimiento, cuando `state` es 'error'. */
  error?: string | null;
  transcript?: string;
  /** En pausa el micrófono no se abre solo: se habla con el botón. */
  paused: boolean;
  onTogglePause: () => void;
  /**
   * Toque o apretón del micrófono. Devuelve si abrió el micrófono: solo entonces soltar después
   * de un apretón largo tiene que mandar lo dicho.
   */
  onTalkStart: () => boolean;
  /** Soltar después de un apretón: se manda lo que hay sin esperar el silencio. */
  onTalkEnd: () => void;
  onClose: () => void;
}) {
  // El micrófono solo se mide mientras escucha: el audio anima el orbe y nada más. Si no hay
  // permiso para medirlo, el orbe se anima solo; quién decide si el dictado falló es el
  // reconocimiento, no el medidor, así que acá no se muestra ningún error.
  const { levelRef } = useAudioLevel(state === 'listening');
  const pensando = state === 'thinking';
  const respondiendo = state === 'speaking' || state === 'connecting';
  const escuchando = state === 'listening';

  const apreton = useRef<{ desde: number; abrio: boolean } | null>(null);
  const bajar = () => {
    if (apreton.current) return;
    apreton.current = { desde: Date.now(), abrio: onTalkStart() };
  };
  const subir = () => {
    const actual = apreton.current;
    apreton.current = null;
    if (actual?.abrio && Date.now() - actual.desde >= HOLD_MS) onTalkEnd();
  };
  // Teclado: espacio o Enter mantenidos equivalen a apretar. Sin `onClick`, así la tecla no
  // dispara además el clic sintético del botón.
  const teclaAbajo = (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
      event.preventDefault();
      bajar();
    }
  };
  const teclaArriba = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      subir();
    }
  };

  const etiquetaMic = escuchando
    ? 'Mandar lo dicho'
    : respondiendo
      ? 'Interrumpir y preguntar otra cosa'
      : pensando
        ? 'Esperá la respuesta'
        : 'Hablar';
  const estado = state === 'error' ? ERROR_LABEL[error ?? ''] ?? LABEL.error : state === 'idle' && paused ? 'En pausa' : LABEL[state];
  const pista = respondiendo
    ? 'Tocá el micrófono para interrumpir y preguntar otra cosa'
    : state === 'error'
      ? 'Tocá el micrófono para intentar de nuevo'
      : state === 'idle'
        ? 'Tocá para hablar, o mantené apretado y soltá para mandar'
        : '';

  const orbe = <ParticlesOrb {...ORB} state={state} levelRef={levelRef} label={respondiendo ? '' : 'Asistente de voz'} />;

  return (
    <div className="voice-overlay">
      <div className="voice-panel">
        {respondiendo ? (
          /* Mientras responde o prepara la voz, tocar el orbe también la corta y vuelve a escuchar. */
          <button type="button" className="voice-orb-button" onClick={() => onTalkStart()} aria-label="Interrumpir y preguntar otra cosa">
            {orbe}
          </button>
        ) : (
          orbe
        )}
        <p className="voice-status" role="status" aria-live="polite" aria-atomic="true">
          {estado}
        </p>
        {/* Lo que se va entendiendo, para verlo mientras se habla. En gris: todavía no es la
            pregunta mandada, es lo que el reconocimiento cree escuchar. */}
        {transcript ? <p className="voice-transcript">{transcript}</p> : pista ? <p className="voice-hint">{pista}</p> : null}
        <div className="voice-controls">
          <button
            type="button"
            className="voice-ctl"
            onClick={onTogglePause}
            aria-pressed={paused}
            aria-label={paused ? 'Reanudar: volver a escuchar solo' : 'Pausar: dejar de escuchar'}
            title={paused ? 'Reanudar' : 'Pausar'}
          >
            {paused ? <IconPlay /> : <IconPause />}
          </button>
          <button
            type="button"
            className={escuchando ? 'voice-ctl voice-ctl--talk voice-ctl--talk-on' : 'voice-ctl voice-ctl--talk'}
            onPointerDown={bajar}
            onPointerUp={subir}
            onPointerCancel={subir}
            onPointerLeave={subir}
            onKeyDown={teclaAbajo}
            onKeyUp={teclaArriba}
            onContextMenu={(event) => event.preventDefault()}
            aria-pressed={escuchando}
            aria-disabled={pensando}
            aria-label={etiquetaMic}
            title={etiquetaMic}
          >
            <MicIcon width={30} height={30} strokeWidth={2} />
          </button>
          <button type="button" className="voice-ctl" onClick={onClose} aria-label="Cerrar el modo voz" title="Cerrar">
            <IconClose />
          </button>
        </div>
      </div>
    </div>
  );
}
