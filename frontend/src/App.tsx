import { FormEvent, useRef, useState } from 'react';
import { askElPais, isDemoMode, type AskResponse } from './api';
import ResultView from './components/ResultView';
import ErrorCard from './components/ErrorCard';

const MAX_LENGTH = 600;
const MIN_LENGTH = 8;

interface TopicGroup {
  label: string;
  emoji: string;
  questions: string[];
}

const TOPIC_GROUPS: TopicGroup[] = [
  {
    label: 'Economía',
    emoji: '📈',
    questions: [
      '¿Qué medidas económicas se anunciaron esta semana?',
      '¿Cómo cerró el dólar en los últimos días?',
      '¿Qué se sabe del nuevo presupuesto?',
    ],
  },
  {
    label: 'Política',
    emoji: '🏛️',
    questions: [
      '¿Qué proyectos de ley se están tratando en el Parlamento?',
      '¿Qué dijo el Gobierno sobre las reformas?',
    ],
  },
  {
    label: 'Deportes',
    emoji: '⚽',
    questions: [
      '¿Cómo le fue a la selección en las eliminatorias?',
      '¿Cómo va el campeonato local?',
    ],
  },
  {
    label: 'El tiempo',
    emoji: '🌤️',
    questions: ['¿Qué pronóstico hay para los próximos días?'],
  },
];

// Preguntas destacadas que se muestran como chips rápidos bajo el buscador.
const QUICK_SUGGESTIONS = [
  '¿Qué pasó en Uruguay en los últimos días?',
  '¿Cuáles son las novedades económicas?',
  '¿Qué informó El País sobre deportes?',
];

// Temas del momento, a modo de "trending". En el prototipo son estáticos;
// cuando exista GET /trending se pueden alimentar desde la API.
const TRENDING = [
  'Presupuesto quinquenal',
  'Dólar y precios',
  'Eliminatorias',
  'Parlamento',
  'Pronóstico del tiempo',
];

export default function App() {
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<AskResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [logoOk, setLogoOk] = useState(true);
  const [touched, setTouched] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  async function submit(nextQuestion: string) {
    const normalized = nextQuestion.trim();
    if (!normalized || normalized.length < MIN_LENGTH || loading) return;

    setQuestion(normalized);
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      setResult(await askElPais(normalized));
    } catch (requestError) {
      setError(requestError);
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched(true);
    void submit(question);
  }

  function pick(nextQuestion: string) {
    setQuestion(nextQuestion);
    inputRef.current?.focus();
    void submit(nextQuestion);
  }

  function retry() {
    void submit(question);
  }

  const trimmedLength = question.trim().length;
  const remaining = MAX_LENGTH - question.length;
  const tooShort = trimmedLength > 0 && trimmedLength < MIN_LENGTH;
  const showLengthHint = touched && tooShort;
  const canSubmit = !loading && trimmedLength >= MIN_LENGTH;

  return (
    <div className="site-shell">
      <header className="masthead">
        <div className="masthead__inner">
          <a
            className="brand"
            href="https://www.elpais.com.uy/"
            target="_blank"
            rel="noreferrer"
            aria-label="Ir a El País (abre en una pestaña nueva)"
          >
            {logoOk ? (
              <span className="brand__logo-frame" role="img" aria-label="El País">
                <img
                  className="brand__logo"
                  src="/logo.jpg"
                  alt=""
                  onError={() => setLogoOk(false)}
                />
              </span>
            ) : (
              <span className="brand__text">EL PAÍS</span>
            )}
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
            por notas publicadas en El País. Cada afirmación viene con su fuente.
          </p>

          {isDemoMode && (
            <p className="demo-banner" role="note">
              <span className="demo-banner__dot" aria-hidden="true" />
              Modo demostración: las respuestas se generan con datos de ejemplo mientras
              se conecta la API real.
            </p>
          )}

          <form className="ask-form" onSubmit={handleSubmit} noValidate>
            <label htmlFor="question">¿Qué querés saber?</label>
            <div className="ask-form__controls">
              <textarea
                ref={inputRef}
                id="question"
                name="question"
                rows={1}
                maxLength={MAX_LENGTH}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onBlur={() => setTouched(true)}
                placeholder="Preguntá sobre la actualidad…"
                disabled={loading}
                aria-invalid={showLengthHint}
                aria-describedby="question-hint"
                required
              />
              <button type="submit" disabled={!canSubmit}>
                {loading ? 'Buscando…' : 'Preguntar'}
              </button>
            </div>
            <div className="ask-form__meta" id="question-hint">
              {showLengthHint ? (
                <span className="input-hint input-hint--warn" role="status">
                  Escribí una pregunta un poco más completa.
                </span>
              ) : (
                <span aria-hidden="true" />
              )}
              <span
                className={`char-count${remaining <= 60 ? ' char-count--warn' : ''}`}
                aria-live="polite"
              >
                {remaining} caracteres restantes
              </span>
            </div>
            <div className="suggestions" aria-label="Preguntas sugeridas">
              {QUICK_SUGGESTIONS.map((suggestion) => (
                <button
                  type="button"
                  className="suggestion"
                  key={suggestion}
                  disabled={loading}
                  onClick={() => pick(suggestion)}
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
              <div className="status-card__body">
                <strong>Buscando en las notas de El País</strong>
                <p>Revisamos la cobertura reciente para responder sin inventar.</p>
              </div>
            </div>
          )}

          {!loading && error != null && <ErrorCard error={error} onRetry={retry} />}

          {!loading && error == null && result && (
            <ResultView result={result} suggestions={QUICK_SUGGESTIONS} onPick={pick} />
          )}

          {!loading && error == null && !result && (
            <div className="explore">
              <div className="trending">
                <p className="eyebrow">Temas del momento</p>
                <div className="trending__chips">
                  {TRENDING.map((topic) => (
                    <button
                      type="button"
                      className="trending__chip"
                      key={topic}
                      onClick={() => pick(`¿Qué informó El País sobre ${topic.toLowerCase()}?`)}
                    >
                      {topic}
                    </button>
                  ))}
                </div>
              </div>

              <div className="topics">
                <p className="eyebrow">Explorá por tema</p>
                <div className="topic-grid">
                  {TOPIC_GROUPS.map((group) => (
                    <div className="topic-card" key={group.label}>
                      <h2>
                        <span aria-hidden="true">{group.emoji}</span> {group.label}
                      </h2>
                      <ul>
                        {group.questions.map((q) => (
                          <li key={q}>
                            <button type="button" onClick={() => pick(q)}>
                              {q}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            </div>
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
