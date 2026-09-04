import type { AskResponse } from '../api';

interface Props {
  result: AskResponse;
  suggestions: string[];
  onPick: (question: string) => void;
}

function formatDate(value: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('es-UY', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/\n\s*\n/)
        .filter(Boolean)
        .map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
    </>
  );
}

function SourceList({ result }: { result: AskResponse }) {
  if (result.sources.length === 0) return null;

  const heading =
    result.kind === 'no_coverage'
      ? 'Notas relacionadas'
      : 'Notas que respaldan esta respuesta';

  return (
    <div className="sources">
      <h2>{heading}</h2>
      <div className="source-list">
        {result.sources.map((source) => (
          <a
            className="source-card"
            href={source.url}
            key={source.url}
            target="_blank"
            rel="noreferrer"
          >
            {source.date && <time>{formatDate(source.date)}</time>}
            <h3>{source.title}</h3>
            {source.snippet && <p>{source.snippet}</p>}
            <span>
              Leer la nota completa <span aria-hidden="true">↗</span>
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}

/** Estado: la pregunta está fuera del dominio del agente. */
function OffTopic({ result, suggestions, onPick }: Props) {
  return (
    <article className="notice-card notice-card--off-topic">
      <span className="notice-card__icon" aria-hidden="true">
        🧭
      </span>
      <h2>Esto queda fuera de lo que puedo responder</h2>
      <p>{result.answer}</p>
      <div className="notice-card__suggestions">
        <span className="notice-card__hint">Probá con algo así:</span>
        <div className="suggestions suggestions--centered">
          {suggestions.map((s) => (
            <button type="button" className="suggestion" key={s} onClick={() => onPick(s)}>
              {s}
            </button>
          ))}
        </div>
      </div>
    </article>
  );
}

/** Estado: El País no cubrió el tema (con notas relacionadas si las hay). */
function NoCoverage({ result, suggestions, onPick }: Props) {
  return (
    <article className="notice-card notice-card--no-coverage">
      <span className="notice-card__icon" aria-hidden="true">
        📰
      </span>
      <h2>Sin cobertura reciente</h2>
      <div className="answer-copy answer-copy--compact">
        <Paragraphs text={result.answer} />
      </div>
      <SourceList result={result} />
      <div className="notice-card__suggestions">
        <span className="notice-card__hint">Quizás te interese preguntar:</span>
        <div className="suggestions suggestions--centered">
          {suggestions.map((s) => (
            <button type="button" className="suggestion" key={s} onClick={() => onPick(s)}>
              {s}
            </button>
          ))}
        </div>
      </div>
    </article>
  );
}

/** Estado normal: respuesta respaldada por notas. */
function Answer({ result }: { result: AskResponse }) {
  return (
    <article className="answer-card">
      <p className="eyebrow">Respuesta</p>
      <div className="answer-copy">
        <Paragraphs text={result.answer} />
      </div>
      <SourceList result={result} />
    </article>
  );
}

export default function ResultView(props: Props) {
  switch (props.result.kind) {
    case 'off_topic':
      return <OffTopic {...props} />;
    case 'no_coverage':
      return <NoCoverage {...props} />;
    default:
      return <Answer result={props.result} />;
  }
}
