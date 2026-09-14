import { Chip } from './Chip';
import { JsonView } from './JsonView';

interface VerifierVerdictShape {
  ok?: boolean;
  missingFacts?: string[];
  newFacts?: string[];
  citationsEqual?: boolean;
  opinionDetected?: boolean;
  notes?: string;
}

/**
 * Las cuatro comprobaciones del verificador, en palabras y con su resultado. Se usa igual en
 * Preguntas y en Personalización para que el mismo dato no se lea de dos formas distintas.
 */
export function VerdictView({ verdict }: { verdict: unknown }) {
  const value = (verdict ?? {}) as VerifierVerdictShape;
  const missing = value.missingFacts ?? [];
  const added = value.newFacts ?? [];
  const checks = [
    { label: 'No se perdió ningún hecho de la original', ok: missing.length === 0, detail: missing },
    { label: 'No se agregó ningún hecho nuevo', ok: added.length === 0, detail: added },
    { label: 'Cita exactamente las mismas notas', ok: value.citationsEqual !== false, detail: [] },
    { label: 'Sin opinión ni juicio de valor', ok: value.opinionDetected !== true, detail: [] },
  ];
  const passed = value.ok === true && checks.every((check) => check.ok);

  return (
    <div className="verdict">
      <p>
        <Chip tone={passed ? 'success' : 'danger'}>{passed ? 'Aprobada' : 'Rechazada'}</Chip>{' '}
        <span className="muted">
          {passed
            ? 'La versión adaptada se le mostró al lector.'
            : 'Se descartó la adaptación y el lector vio la respuesta canónica.'}
        </span>
      </p>
      <ul className="checks">
        {checks.map((check) => (
          <li key={check.label} className={check.ok ? 'checks__item' : 'checks__item checks__item--fail'}>
            <span className="checks__mark" aria-hidden="true">
              {check.ok ? '✓' : '✕'}
            </span>
            <span>
              {check.label}
              {check.detail.length > 0 && (
                <ul className="checks__detail">
                  {check.detail.map((entry, index) => (
                    <li key={`${entry}-${index}`}>{entry}</li>
                  ))}
                </ul>
              )}
            </span>
          </li>
        ))}
      </ul>
      {value.notes && <p className="small muted">{value.notes}</p>}
      <details className="details">
        <summary>Ver el veredicto en crudo</summary>
        <JsonView value={verdict} />
      </details>
    </div>
  );
}
