import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { SendIcon, Spinner } from './Icons';

interface Props {
  /** true mientras falta decidir el consentimiento: el campo queda deshabilitado. */
  disabled: boolean;
  loading: boolean;
  maxLength: number;
  onSend: (text: string) => void;
}

const MAX_HEIGHT = 200;
const WARN_UNDER = 60;

/** Barra de mensaje ancoada abajo: pill auto-expansible, contador y disclaimer legal. */
export function Composer({ disabled, loading, maxLength, onSend }: Props) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();
  const counterId = `${inputId}-count`;

  // Auto-alto: se recalcula al escribir y también al cambiar el ancho de la ventana (rotación,
  // redimensión), porque el texto/placeholder envuelto puede dejar una altura vieja.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const fit = () => {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
      el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden';
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [value]);

  const trimmed = value.trim();
  const canSend = !disabled && !loading && trimmed.length > 0 && trimmed.length <= maxLength;
  const remaining = maxLength - value.length;

  function send() {
    if (!canSend) return;
    onSend(trimmed);
    setValue('');
    textareaRef.current?.focus();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    send();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  }

  return (
    <div className="composer-dock">
      <form className="composer-form" onSubmit={handleSubmit}>
        <div className={disabled ? 'composer composer--disabled' : 'composer'}>
          <label htmlFor={inputId} className="sr-only">
            Tu pregunta
          </label>
          <textarea
            id={inputId}
            ref={textareaRef}
            rows={1}
            value={value}
            maxLength={maxLength}
            placeholder={disabled ? 'Elegí una opción para empezar a preguntar' : 'Preguntá sobre la actualidad…'}
            disabled={disabled}
            aria-describedby={counterId}
            enterKeyHint="send"
            autoComplete="off"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <span id={counterId} className={remaining < WARN_UNDER ? 'counter counter--warn' : 'counter'}>
            {value.length}/{maxLength}
          </span>
          <button type="submit" className="send-btn" aria-label="Enviar pregunta" disabled={!canSend}>
            {loading ? <Spinner /> : <SendIcon />}
          </button>
        </div>
      </form>
      <p className="composer-disclaimer">
        Las respuestas se elaboran únicamente con notas de El País y pueden contener errores. Verificá en la
        nota original. <Link to="/terminos">Términos y privacidad</Link>
      </p>
    </div>
  );
}
