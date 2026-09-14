import { frameById, type ReaderProfile } from '@pelp/domain';
import { fmtDateTime, fmtInt, fmtPercent } from '../format';
import { Chip } from './Chip';
import { Empty } from './Empty';

/**
 * El perfil en JSON crudo no se puede leer de un vistazo, y es justo lo que hay que mirar para
 * saber si la personalización está haciendo algo sensato. Se muestra como lo que es: qué le
 * importa a este lector, con cuánta confianza y con qué evidencia detrás.
 */
const ESTILO: Record<string, Record<string, string>> = {
  length: { corta: 'respuestas cortas', media: 'respuestas de largo medio', larga: 'respuestas largas' },
  dataAffinity: { baja: 'poca afinidad con los datos', media: 'afinidad media con los datos', alta: 'pide cifras' },
  tone: { directo: 'tono directo', narrativo: 'tono narrativo' },
};

const CONFIANZA: { label: string; key: 'topics' | 'frames' | 'style' }[] = [
  { label: 'Temas', key: 'topics' },
  { label: 'Encuadres', key: 'frames' },
  { label: 'Estilo', key: 'style' },
];

function Barras({ items, label }: { items: { id: string; weight: number }[]; label: (id: string) => string }) {
  if (!items.length) return <Empty text="Todavía sin señal." />;
  const max = Math.max(...items.map((item) => item.weight), 0.01);
  return (
    <ul className="weights">
      {items.map((item) => (
        <li key={item.id} className="weights__item">
          <span className="weights__label" title={item.id}>
            {label(item.id)}
          </span>
          <span className="weights__bar" aria-hidden="true">
            <span className="weights__fill" style={{ width: `${Math.round((item.weight / max) * 100)}%` }} />
          </span>
          <span className="weights__value">{item.weight.toFixed(1)}</span>
        </li>
      ))}
    </ul>
  );
}

function isProfile(value: unknown): value is ReaderProfile {
  return Boolean(value) && typeof value === 'object' && 'topics' in (value as Record<string, unknown>);
}

export function ReaderProfileView({ profile }: { profile: unknown }) {
  if (!isProfile(profile)) return <Empty text="Este lector todavía no tiene perfil." />;
  const lean = profile.politicalLean;
  const consent = profile.consent;

  return (
    <div className="profile">
      <div className="profile__cards">
        <div className="profile-card">
          <h4 className="profile-card__title">Temas</h4>
          <Barras items={profile.topics ?? []} label={(id) => id.replace(/-/g, ' ')} />
        </div>
        <div className="profile-card">
          <h4 className="profile-card__title">Encuadres</h4>
          <p className="muted small">Desde qué ángulo le interesan las noticias.</p>
          <Barras items={profile.frames ?? []} label={(id) => frameById(id)?.label ?? id.replace(/-/g, ' ')} />
        </div>
      </div>

      <div className="profile__cards">
        <div className="profile-card">
          <h4 className="profile-card__title">Cómo prefiere leer</h4>
          <div className="chips-row">
            {(['length', 'dataAffinity', 'tone'] as const).map((key) => {
              const value = profile.style?.[key];
              return value ? <Chip key={key}>{ESTILO[key]?.[value] ?? value}</Chip> : null;
            })}
          </div>
        </div>
        <div className="profile-card">
          <h4 className="profile-card__title">Confianza del perfil</h4>
          <p className="muted small">Cuánta evidencia hay detrás de cada dimensión. Por debajo del umbral no se usa para adaptar.</p>
          <dl className="kv">
            {CONFIANZA.map(({ label, key }) => (
              <div key={key} className="profile-card__row">
                <dt>{label}</dt>
                <dd>{fmtPercent(profile.confidence?.[key] ?? 0, 0)}</dd>
              </div>
            ))}
            <div className="profile-card__row">
              <dt>Evidencia</dt>
              <dd>{fmtInt(profile.evidenceCount ?? 0)} preguntas</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="profile-card">
        <h4 className="profile-card__title">Orientación política</h4>
        {!consent?.sensitiveInference ? (
          <p className="muted">El lector no dio permiso para inferirla, así que ni se calcula.</p>
        ) : !lean || lean.bucket === 'sin-señal' ? (
          <p className="muted">
            Sin señal. Solo se infiere de posturas que el lector expresa con sus propias palabras, nunca de los temas que
            consulta, y hacen falta al menos cinco expresiones explícitas. Preguntar por economía o por política no cuenta.
          </p>
        ) : (
          <div className="chips-row">
            <Chip tone="warning">{lean.bucket}</Chip>
            <Chip>score {lean.score.toFixed(2)}</Chip>
            <Chip>confianza {fmtPercent(lean.confidence, 0)}</Chip>
          </div>
        )}
      </div>

      <div className="profile-card">
        <h4 className="profile-card__title">Consentimiento</h4>
        <div className="chips-row">
          <Chip tone={consent?.personalization ? 'success' : 'neutral'}>
            {consent?.personalization ? 'personalización aceptada' : 'modo neutral'}
          </Chip>
          <Chip tone={consent?.sensitiveInference ? 'warning' : 'neutral'}>
            {consent?.sensitiveInference ? 'inferencia sensible permitida' : 'sin inferencia sensible'}
          </Chip>
          {consent?.at && <Chip>{fmtDateTime(consent.at)}</Chip>}
        </div>
      </div>

      <p className="muted small">
        Perfil versión {fmtInt(profile.version ?? 0)} · actualizado {fmtDateTime(profile.updatedAt)}
      </p>
    </div>
  );
}
