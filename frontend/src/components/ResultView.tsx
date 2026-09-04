import type { AskResponse } from '../api';

interface Props {
  result: AskResponse;
  question: string;
  suggestions: string[];
  onPick: (question: string) => void;
  onReset: () => void;
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
        .map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
    </>
  );
}

function ResultHeader({ question, onReset }: Pick<Props, 'question' | 'onReset'>) {
  return (
    <header className="result-header">
      <div>
        <span className="result-header__label">Tu consulta</span>
        <p className="result-header__question">{question}</p>
      </div>
      <button type="button" className="ghost-button" onClick={onReset}>
        <span aria-hidden="true">＋</span>
        Nueva pregunta
      </button>
    </header>
  );
}

function SourceList({ result }: { result: AskResponse }) {
  if (result.sources.length === 0) return null;

  const heading = result.kind === 'no_coverage'
    ? 'Notas relacionadas'
    : 'Fuentes de esta respuesta';

  return (
    <div className="sources">
      <div className="sources__heading">
        <h2>{heading}</h2>
        <span>{result.sources.length} {result.sources.length === 1 ? 'nota' : 'notas'}</span>
      </div>
      <div className="source-list">
        {result.sources.map((source, index) => (
          <a
            className="source-card"
            href={source.url}
            key={source.url}
            target="_blank"
            rel="noreferrer"
            style={{ animationDelay: `${80 + index * 70}ms` }}
          >
            <div className="source-card__meta">
              <span>El País</span>
              {source.date && <time>{formatDate(source.date)}</time>}
            </div>
            <h3>{source.title}</h3>
            {source.snippet && <p>{source.snippet}</p>}
            <span className="source-card__cta">
              Leer nota
              <span aria-hidden="true">↗</span>
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}

function NoticeIcon({ kind }: { kind: 'off-topic' | 'no-coverage' }) {
  return (
    <span className="notice-card__icon" aria-hidden="true">
      {kind === 'off-topic' ? (
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" />
          <path d="m15.5 8.5-2.1 4.9-4.9 2.1 2.1-4.9 4.9-2.1Z" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24">
          <path d="M6 3h12v18H6z" />
          <path d="M9 7h6M9 11h6M9 15h4" />
        </svg>
      )}
    </span>
  );
}

function SuggestionActions({ suggestions, onPick }: Pick<Props, 'suggestions' | 'onPick'>) {
  return (
    <div className="notice-card__suggestions">
      <span className="notice-card__hint">Probá con una de estas preguntas</span>
      <div className="suggestions suggestions--centered">
        {suggestions.map((suggestion) => (
          <button
            type="button"
            className="suggestion"
            key={suggestion}
            onClick={() => onPick(suggestion)}
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

function OffTopic(props: Props) {
  return (
    <article className="notice-card notice-card--off-topic result-enter">
      <ResultHeader question={props.question} onReset={props.onReset} />
      <div className="notice-card__body">
        <NoticeIcon kind="off-topic" />
        <p className="eyebrow">Fuera de cobertura editorial</p>
        <h2>Probemos con una pregunta sobre la actualidad</h2>
        <p>{props.result.answer}</p>
      </div>
      <SuggestionActions suggestions={props.suggestions} onPick={props.onPick} />
    </article>
  );
}

function NoCoverage(props: Props) {
  return (
    <article className="notice-card notice-card--no-coverage result-enter">
      <ResultHeader question={props.question} onReset={props.onReset} />
      <div className="notice-card__body">
        <NoticeIcon kind="no-coverage" />
        <p className="eyebrow">Cobertura insuficiente</p>
        <h2>No encontramos una respuesta respaldada</h2>
        <div className="answer-copy answer-copy--compact">
          <Paragraphs text={props.result.answer} />
        </div>
      </div>
      <SourceList result={props.result} />
      <SuggestionActions suggestions={props.suggestions} onPick={props.onPick} />
    </article>
  );
}

function Answer({ result, question, onReset }: Pick<Props, 'result' | 'question' | 'onReset'>) {
  return (
    <article className="answer-card result-enter">
      <ResultHeader question={question} onReset={onReset} />
      <div className="answer-card__body">
        <p className="eyebrow">Respuesta basada en la cobertura de El País</p>
        <div className="answer-copy">
          <Paragraphs text={result.answer} />
        </div>
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
      return (
        <Answer
          result={props.result}
          question={props.question}
          onReset={props.onReset}
        />
      );
  }
}
