import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ConsentTextResponse } from '@pelp/domain/api';
import { extractLeadingTitle, renderParagraphs } from '../lib/markdown';
import { Modal } from './Modal';

export type GateDecision = 'personalize' | 'neutral';

interface Props {
  consent: ConsentTextResponse;
  busy: boolean;
  error: string | null;
  onDecide: (decision: GateDecision, ageConfirmed: boolean) => void;
  onClose: () => void;
}

const TERMS_PHRASE = 'Términos de uso y privacidad';
const TERMS_LINKS: Record<string, string> = { [TERMS_PHRASE]: '/terminos' };

/** Puerta de términos y consentimiento (8.4, Apéndice A.1): modal bloqueante antes del primer mensaje. */
export function ConsentGate({ consent, busy, error, onDecide, onClose }: Props) {
  const titleId = useId();
  const hintId = useId();
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const { title, body } = extractLeadingTitle(consent.text);
  const hasInlineTermsLink = body.includes(TERMS_PHRASE);

  return (
    <Modal labelledBy={titleId} onClose={onClose} closeOnBackdrop={false} className="modal--consent">
      <div className="modal-header">
        <h2 id={titleId} className="modal-title">
          {title ?? 'Antes de empezar'}
        </h2>
        <button type="button" className="link-btn modal-close" onClick={onClose} disabled={busy}>
          Cerrar
        </button>
      </div>

      <div className="modal-body consent-body">
        {renderParagraphs(body, { links: TERMS_LINKS })}
        {!hasInlineTermsLink ? (
          <p>
            <Link to="/terminos">{TERMS_PHRASE}</Link>
          </p>
        ) : null}
      </div>

      <div className="modal-actions consent-actions">
        {error ? (
          <p className="inline-error" role="alert">
            {error}
          </p>
        ) : null}
        <label className="check">
          <input
            type="checkbox"
            checked={ageConfirmed}
            disabled={busy}
            aria-describedby={hintId}
            onChange={(event) => setAgeConfirmed(event.target.checked)}
          />
          <span>Tengo {consent.minAgePersonalization} años o más</span>
        </label>
        <p id={hintId} className="hint">
          Necesario solo para activar la personalización.
        </p>
        <div className="consent-buttons">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !ageConfirmed}
            onClick={() => onDecide('personalize', true)}
          >
            {consent.buttons.personalize}
          </button>
          <button
            type="button"
            className="btn btn-dark"
            disabled={busy}
            onClick={() => onDecide('neutral', false)}
          >
            {consent.buttons.neutral}
          </button>
        </div>
        {busy ? (
          <p className="hint" role="status">
            Guardando tu elección…
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
