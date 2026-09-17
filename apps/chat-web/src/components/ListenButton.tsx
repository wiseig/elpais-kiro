import { useRef, useState, useSyncExternalStore } from 'react';
import type { ApiClient } from '../lib/api';
import { speak, speechSupported, stopSpeaking, type SpeechState } from '../lib/speech';
import { getVoicePreference, subscribeVoice } from '../lib/voice';

interface Props {
  answerId: string;
  /** El texto que el lector tiene delante: es lo que se lee. */
  text: string;
  api: ApiClient;
}

/**
 * "Escuchar" de una respuesta. Con la voz del navegador se dice el texto que ya está en pantalla,
 * sin pedirle nada al servidor; con las voces del servidor se pide el MP3, que se sintetiza la
 * primera vez y después sale del caché.
 */
export function ListenButton({ answerId, text, api }: Props) {
  const [state, setState] = useState<SpeechState>('idle');
  const voice = useSyncExternalStore(subscribeVoice, getVoicePreference, getVoicePreference);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  if (!text.trim() || (voice === 'navegador' && !speechSupported())) return null;

  const detener = () => {
    stopSpeaking();
    audioRef.current?.pause();
    audioRef.current = null;
    setState('idle');
  };

  const escuchar = async () => {
    setState('loading');
    try {
      if (voice === 'navegador') {
        setState('speaking');
        speak(text, { onEnd: () => setState('idle'), onError: () => setState('error') });
        return;
      }
      const url = await api.answerAudioUrl(answerId, voice);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => setState('idle');
      audio.onerror = () => setState('error');
      await audio.play();
      setState('speaking');
    } catch {
      setState('error');
    }
  };

  const hablando = state === 'speaking' || state === 'loading';
  return (
    <button
      type="button"
      className={hablando ? 'answer-listen answer-listen--active' : 'answer-listen'}
      onClick={() => (hablando ? detener() : void escuchar())}
      aria-label={hablando ? 'Dejar de escuchar la respuesta' : 'Escuchar la respuesta'}
    >
      {state === 'loading' ? 'Preparando…' : state === 'speaking' ? 'Detener' : state === 'error' ? 'No se pudo leer' : 'Escuchar'}
    </button>
  );
}
