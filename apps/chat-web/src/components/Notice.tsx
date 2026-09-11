import type { NoticeCode } from '@pelp/domain';

type Tone = 'info' | 'warn' | 'muted' | 'danger';

const TONES: Record<NoticeCode, Tone> = {
  consent_required: 'warn',
  service_paused: 'muted',
  rate_limited: 'warn',
  blocked: 'danger',
  too_long: 'warn',
  off_topic: 'info',
  budget_paused: 'muted',
  personalized: 'info',
};

interface Props {
  text: string;
  code?: NoticeCode;
  /** Reabre la puerta de consentimiento cuando el aviso es `consent_required`. */
  onConsent?: () => void;
}

/** Banner para bloques `notice` del motor, con estilo según el código. */
export function Notice({ text, code, onConsent }: Props) {
  const tone: Tone = (code && TONES[code]) || 'info';
  return (
    <div className={`notice notice--${tone}`} data-code={code}>
      <p className="notice-text">{text}</p>
      {code === 'consent_required' && onConsent ? (
        <button type="button" className="btn btn-small btn-primary" onClick={onConsent}>
          Elegir una opción
        </button>
      ) : null}
    </div>
  );
}
