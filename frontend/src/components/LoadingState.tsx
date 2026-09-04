interface Props {
  question: string;
}

const STEPS = [
  'Buscando notas relevantes',
  'Contrastando la información',
  'Preparando una respuesta clara',
];

export default function LoadingState({ question }: Props) {
  return (
    <div className="loading-card result-enter" role="status">
      <div className="loading-card__visual" aria-hidden="true">
        <span className="loading-card__ring loading-card__ring--outer" />
        <span className="loading-card__ring loading-card__ring--inner" />
        <span className="loading-card__mark">EP</span>
      </div>
      <div className="loading-card__content">
        <p className="eyebrow">Consultando el archivo</p>
        <h2>Estamos revisando la cobertura</h2>
        <p className="loading-card__question">“{question}”</p>
        <div className="loading-steps" aria-hidden="true">
          {STEPS.map((step, index) => (
            <span className="loading-step" key={step} style={{ animationDelay: `${index * 240}ms` }}>
              <i />
              {step}
            </span>
          ))}
        </div>
        <span className="loading-card__progress" aria-hidden="true"><i /></span>
      </div>
    </div>
  );
}
