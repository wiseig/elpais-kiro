import { FormEvent, useRef, useState } from 'react';
import { askElPais, type AskResponse } from './api';

const SUGGESTIONS = [
  '¿Qué pasó en Uruguay en los últimos días?',
  '¿Cuáles son las principales novedades económicas?',
  '¿Qué informó El País sobre deportes?',
];

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

export default function App() {
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<AskResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  async function submit(nextQuestion: string) {
    const normalized = nextQuestion.trim();
    if (!normalized || loading) return;

    setQuestion(normalized);
    setLoading(true);
    setError('');
    setResult(null);

    try {
      setResult(await askElPais(normalized));
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'No pudimos consultar las noticias. Probá de nuevo.',
      );
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit(question);
  }

  function retry() {
    void submit(question);
  }

  return (
    <div className="site-shell">
      <header className="masthead">
        <div className="masthead__inner">
          <a className="brand" href="https://www.elpais.com.uy/" aria-label="Ir a El País">
            EL PAÍS
          </a>
          <span className="prototype-label">Prototipo editorial</span>
        </div>
      </header>

      <main>
        <section className="hero" aria-labelledby="page-title">
          <p className="eyebrow">Noticias de los últimos 14 días</p>
          <h1 id="page-title">Preguntale a El País</h1>
          <p className="hero__intro">
            Consultá sobre la actualidad y recibí una respuesta breve, respaldada únicamente
            por notas publicadas en El País.
          </p>

          <form className="ask-form" onSubmit={handleSubmit}>
            <label htmlFor="question">¿Qué querés saber?</label>
            <div className="ask-form__controls">
              <textarea
                ref={inputRef}
                id="question"
                name="question"
                rows={3}
                maxLength={600}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="Por ejemplo: ¿Qué medidas económicas se anunciaron esta semana?"
                disabled={loading}
                required
              />
              <button type="submit" disabled={loading || !question.trim()}>
                {loading ? 'Buscando…' : 'Preguntar'}
              </button>
            </div>
            <div className="suggestions" aria-label="Preguntas sugeridas">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  type="button"
                  className="suggestion"
                  key={suggestion}
                  disabled={loading}
                  onClick={() => void submit(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </form>
        </section>

        <section className="results" aria-live="polite" aria-busy={loading}>
          {loading && (
            <div className="status-card status-card--loading" role="status">
              <span className="loader" aria-hidden="true" />
              <div>
                <strong>Buscando en las notas de El País</strong>
                <p>Revisamos la cobertura reciente para responder sin inventar.</p>
              </div>
            </div>
          )}

          {error && (
            <div className="status-card status-card--error" role="alert">
              <div>
                <strong>No pudimos completar la consulta</strong>
                <p>{error}</p>
              </div>
              <button type="button" className="secondary-button" onClick={retry}>
                Reintentar
              </button>
            </div>
          )}

          {result && (
            <article className="answer-card">
              <p className="eyebrow">Respuesta</p>
              <div className="answer-copy">
                {result.answer
                  .split(/\n\s*\n/)
                  .filter(Boolean)
                  .map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
              </div>

              {result.sources.length > 0 && (
                <div className="sources">
                  <h2>Notas que respaldan esta respuesta</h2>
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
                        <span>Leer la nota completa <span aria-hidden="true">↗</span></span>
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </article>
          )}
        </section>
      </main>

      <footer>
        <p>
          Las respuestas se elaboran solamente con notas recientes de El País. Ante dudas,
          consultá siempre la publicación original.
        </p>
      </footer>
    </div>
  );
}
