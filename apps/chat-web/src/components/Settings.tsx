import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ReaderMode } from '@pelp/domain';
import type { ConsentTextResponse, MeResponse } from '@pelp/domain/api';
import { describeSaveError } from '../lib/errors';
import { CloseIcon } from './Icons';
import { Modal } from './Modal';

interface Props {
  me: MeResponse;
  consent: ConsentTextResponse;
  onClose: () => void;
  onOpenGate: () => void;
  onChangeMode: (mode: 'personalized' | 'neutral', ageConfirmed?: boolean) => Promise<void>;
  onDelete: () => Promise<void>;
}

const MODE_LABEL: Record<ReaderMode, string> = {
  personalized: 'Con personalización',
  neutral: 'Sin personalización',
  undecided: 'Sin decidir',
};

const NO_PROFILE = 'Todavía no hay suficientes preguntas para inferir tus intereses.';

function whySeeThis(me: MeResponse): string {
  if (me.profileSummary) return me.profileSummary;
  if (me.mode === 'neutral') {
    return `${NO_PROFILE} Sin personalización no inferimos nada: todos ven la misma respuesta.`;
  }
  return NO_PROFILE;
}

/** Ajustes (8.4 y 9.5): cambiar de modo, "por qué veo esto" y borrar datos. */
export function Settings({ me, consent, onClose, onOpenGate, onChangeMode, onDelete }: Props) {
  const titleId = useId();
  const [busy, setBusy] = useState<'mode' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function run(kind: 'mode' | 'delete', action: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(describeSaveError(err));
    } finally {
      setBusy(null);
    }
  }

  const locked = busy !== null;

  return (
    <Modal labelledBy={titleId} onClose={onClose} className="modal--settings">
      <div className="modal-header">
        <h2 id={titleId} className="modal-title">
          Ajustes
        </h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar ajustes">
          <CloseIcon />
        </button>
      </div>

      <div className="modal-body settings-body">
        {error ? (
          <p className="inline-error" role="alert">
            {error}
          </p>
        ) : null}

        <section className="settings-section" aria-labelledby={`${titleId}-mode`}>
          <h3 id={`${titleId}-mode`}>Personalización</h3>
          <p>
            Modo actual: <strong className={`mode-pill mode-pill--${me.mode}`}>{MODE_LABEL[me.mode]}</strong>
          </p>

          {me.mode === 'personalized' ? (
            <>
              <p className="muted">
                Adaptamos el orden y el enfoque de las respuestas a tus intereses. Los hechos, las cifras
                y las notas citadas no cambian.
              </p>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={locked}
                onClick={() => void run('mode', () => onChangeMode('neutral'))}
              >
                Desactivar personalización
              </button>
              <p className="hint">Al desactivarla borramos el perfil que habíamos inferido.</p>
            </>
          ) : null}

          {me.mode === 'neutral' ? (
            <>
              <p className="muted">
                Las respuestas son iguales para todos y no guardamos nada vinculado a vos.
              </p>
              <label className="check">
                <input
                  type="checkbox"
                  checked={ageConfirmed}
                  disabled={locked}
                  onChange={(event) => setAgeConfirmed(event.target.checked)}
                />
                <span>Tengo {consent.minAgePersonalization} años o más</span>
              </label>
              <button
                type="button"
                className="btn btn-primary"
                disabled={locked || !ageConfirmed}
                onClick={() => void run('mode', () => onChangeMode('personalized', true))}
              >
                Activar personalización
              </button>
            </>
          ) : null}

          {me.mode === 'undecided' ? (
            <>
              <p className="muted">Todavía no elegiste cómo usar el asistente.</p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  onClose();
                  onOpenGate();
                }}
              >
                Elegir una opción
              </button>
            </>
          ) : null}

          {busy === 'mode' ? (
            <p className="hint" role="status">
              Guardando…
            </p>
          ) : null}
        </section>

        <section className="settings-section" aria-labelledby={`${titleId}-why`}>
          <h3 id={`${titleId}-why`}>¿Por qué veo esto?</h3>
          <p>{whySeeThis(me)}</p>
          {me.mode === 'personalized' ? (
            <p className="hint">Preguntas consideradas: {me.questionCount}</p>
          ) : null}
        </section>

        <section className="settings-section" aria-labelledby={`${titleId}-data`}>
          <h3 id={`${titleId}-data`}>Tus datos</h3>
          <p className="muted">
            Borra tu perfil, tu historial y el registro de tu elección. Después vas a tener que elegir de
            nuevo cómo usar el asistente.
          </p>
          {confirmDelete ? (
            <div className="confirm-box" role="group" aria-label="Confirmar borrado">
              <p>
                <strong>¿Seguro que querés borrar tus datos?</strong> Esta acción no se puede deshacer.
              </p>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={locked}
                  onClick={() => void run('delete', onDelete)}
                >
                  {busy === 'delete' ? 'Borrando…' : 'Sí, borrar mis datos'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={locked}
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancelar
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-danger-outline"
              disabled={locked}
              onClick={() => setConfirmDelete(true)}
            >
              Borrar mis datos
            </button>
          )}
        </section>

        <p className="settings-footer">
          <Link to="/terminos" onClick={onClose}>
            Términos de uso y privacidad
          </Link>
        </p>
      </div>
    </Modal>
  );
}
