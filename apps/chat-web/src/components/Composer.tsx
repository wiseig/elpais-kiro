import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { SendIcon, Spinner } from './Icons';

interface Props {
  /** true mientras falta decidir el consentimiento: el campo queda deshabilitado. */
  disabled: boolean;
  loading: boolean;
  maxLength: number;
  onSend: (text: string) => void;
}

const MAX_HEIGHT = 160;

export function Composer({ disabled, loading, maxLength, onSend }: Props) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();
  const counterId = `${inputId}-count`;

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden';
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
          placeholder={disabled ? 'Elegí una opción para empezar a preguntar' : 'Escribí tu pregunta…'}
          disabled={disabled}
          aria-describedby={counterId}
          enterKeyHint="send"
          autoComplete="off"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button type="submit" className="send-btn" aria-label="Enviar pregunta" disabled={!canSend}>
          {loading ? <Spinner /> : <SendIcon />}
        </button>
      </div>
      <div className="composer-meta">
        <span id={counterId} className={remaining <= 50 ? 'counter counter--warn' : 'counter'}>
          {value.length}/{maxLength}
        </span>
        <span className="composer-hint">Enter envía · Shift+Enter agrega una línea</span>
      </div>
    </form>
  );
}
