import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { askElPais, isDemoMode, type AskResponse } from './api';
import ResultView from './components/ResultView';
import ErrorCard from './components/ErrorCard';
import LoadingState from './components/LoadingState';

const MAX_LENGTH = 600;
const MIN_LENGTH = 8;

type TopicIconName = 'economy' | 'politics' | 'sports' | 'weather';

interface TopicGroup {
  label: string;
  icon: TopicIconName;
  questions: string[];
}

const TOPIC_GROUPS: TopicGroup[] = [
  {
    label: 'Economía',
    icon: 'economy',
    questions: [
      '¿Qué medidas económicas se anunciaron esta semana?',
      '¿Cómo cerró el dólar en los últimos días?',
      '¿Qué se sabe del nuevo presupuesto?',
    ],
  },
  {
    label: 'Política',
    icon: 'politics',
    questions: [
      '¿Qué proyectos de ley se están tratando en el Parlamento?',
      '¿Qué dijo el Gobierno sobre las reformas?',
    ],
  },
  {
    label: 'Deportes',
    icon: 'sports',
    questions: [
      '¿Cómo le fue a la selección en las eliminatorias?',
      '¿Cómo va el campeonato local?',
    ],
  },
  {
    label: 'El tiempo',
    icon: 'weather',
    questions: ['¿Qué pronóstico hay para los próximos días?'],
  },
];

const QUICK_SUGGESTIONS = [
  '¿Qué pasó en Uruguay en los últimos días?',
  '¿Cuáles son las novedades económicas?',
  '¿Qué informó El País sobre deportes?',
];

// En el prototipo son estáticos; luego pueden alimentarse desde GET /trending.
const TRENDING = [
  'Presupuesto quinquenal',
  'Dólar y precios',
  'Eliminatorias',
  'Parlamento',
  'Pronóstico del tiempo',
];

function TopicIcon({ name }: { name: TopicIconName }) {
  const paths: Record<TopicIconName, JSX.Element> = {
    economy: (
      <>
        <path d="M4 17 10 11l4 4 6-8" />
        <path d="M15 7h5v5" />
      </>
    ),
    politics: (
      <>
        <path d="m3 10 9-5 9 5" />
        <path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 19h18" />
      </>
    ),
    sports: (
      <>
        <path d="M8 4h8v5a4 4 0 0 1-8 0V4Z" />
        <path d="M8 6H5v2a3 3 0 0 0 3 3M16 6h3v2a3 3 0 0 1-3 3M12 13v4M8 20h8M9 17h6" />
      </>
    ),
    weather: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </>
    ),
  };

  return (
    <svg className="topic-card__icon" viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function App() {
  const [question, setQuestion] = useState('');
  const [submittedQuestion, setSubmittedQuestion] = useState('');
  const [result, setResult] = useState<AskResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [logoOk, setLogoOk] = useState(true);
  const [touched, setTouched] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const resultsRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;

    input.style.height = '0px';
    input.style.height = `${Math.min(Math.max(input.scrollHeight, 28), 168)}px`;
  }, [question]);

  useEffect(() => {
    if (!loading || !submittedQuestion) return;

    const frame = window.requestAnimationFrame(() => {
      resultsRef.current?.scrollIntoView({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        block: 'start',
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [loading, submittedQuestion]);

  async function submit(nextQuestion: string) {
    const normalized = nextQuestion.trim();
    setTouched(true);

    if (!normalized || normalized.length < MIN_LENGTH || loading) {
      inputRef.current?.focus();
      return;
    }

    setQuestion(normalized);
    setSubmittedQuestion(normalized);
    setLoading(true);
    setError(null);
    setResult(null);
    inputRef.current?.blur();

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
    void submit(question);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void submit(question);
    }
  }

  function pick(nextQuestion: string) {
    setQuestion(nextQuestion);
    setTouched(false);
    void submit(nextQuestion);
  }

  function retry() {
    void submit(submittedQuestion || question);
  }

  function resetSearch() {
    setQuestion('');
    setSubmittedQuestion('');
    setResult(null);
    setError(null);
    setTouched(false);

    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.scrollIntoView({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        block: 'center',
      });
    });
  }

  const trimmedLength = question.trim().length;
  const remaining = MAX_LENGTH - question.length;
  const tooShort = trimmedLength > 0 && trimmedLength < MIN_LENGTH;
  const showLengthHint = touched && tooShort;
  const canSubmit = !loading && trimmedLength >= MIN_LENGTH;
  const hasActivity = loading || result != null || error != null;

  return (
    <div className={`site-shell${hasActivity ? ' site-shell--active' : ''}`}>
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
          <span className="prototype-label">
            <span className="prototype-label__dot" aria-hidden="true" />
            Prototipo editorial
          </span>
        </div>
      </header>

      <main>
        <section className="hero" aria-labelledby="page-title">
          <p className="eyebrow">Noticias de los últimos 14 días</p>
          <h1 id="page-title">Preguntale a El País</h1>
          <p className="hero__intro">
            Una respuesta breve sobre la actualidad, construida únicamente con periodismo
            publicado por El País y con fuentes para seguir leyendo.
          </p>

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
                onKeyDown={handleKeyDown}
                onBlur={() => setTouched(true)}
                placeholder="Preguntá sobre la actualidad…"
                disabled={loading}
                aria-invalid={showLengthHint}
                aria-describedby="question-hint"
                required
              />
              <button className="ask-form__submit" type="submit" disabled={!canSubmit}>
                <span>{loading ? 'Buscando' : 'Preguntar'}</span>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m5 12 7-7 7 7M12 5v14" />
                </svg>
              </button>
            </div>
            <div className="ask-form__meta" id="question-hint">
              {showLengthHint ? (
                <span className="input-hint input-hint--warn" role="status">
                  Escribí una pregunta un poco más completa.
                </span>
              ) : (
                <span className="input-hint ask-form__shortcut">
                  Enter para enviar · Shift + Enter para una nueva línea
                </span>
              )}
              <span
                className={`char-count${remaining <= 60 ? ' char-count--warn' : ''}`}
                aria-live="polite"
              >
                {remaining}
              </span>
            </div>
          </form>

          <div className="suggestions quick-suggestions" aria-label="Preguntas sugeridas">
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

          <div className="trust-row" aria-label="Características de las respuestas">
            <span><b aria-hidden="true">✓</b> Solo notas de El País</span>
            <span><b aria-hidden="true">✓</b> Fuentes verificables</span>
            <span><b aria-hidden="true">✓</b> Cobertura reciente</span>
          </div>

          <div className="hero__disclosures">
            {isDemoMode && (
              <p className="demo-banner" role="note">
                <span className="demo-banner__dot" aria-hidden="true" />
                Modo demo · respuestas con datos de ejemplo
              </p>
            )}

            <details className="methodology">
              <summary>
                <span className="methodology__info" aria-hidden="true">i</span>
                <span>Cómo se construyen las respuestas</span>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m8 10 4 4 4-4" />
                </svg>
              </summary>
              <div className="methodology__content">
                <div className="methodology__step">
                  <span>01</span>
                  <div>
                    <strong>Busca</strong>
                    <p>Encuentra las notas más relevantes de la cobertura reciente.</p>
                  </div>
                </div>
                <div className="methodology__step">
                  <span>02</span>
                  <div>
                    <strong>Contrasta</strong>
                    <p>Responde únicamente cuando la información publicada es suficiente.</p>
                  </div>
                </div>
                <div className="methodology__step">
                  <span>03</span>
                  <div>
                    <strong>Cita</strong>
                    <p>Incluye las fuentes originales para que puedas seguir leyendo.</p>
                  </div>
                </div>
              </div>
            </details>
          </div>
        </section>

        <section
          ref={resultsRef}
          className={`results${hasActivity ? ' results--active' : ''}`}
          aria-live="polite"
          aria-busy={loading}
        >
          {loading && <LoadingState question={submittedQuestion} />}

          {!loading && error != null && (
            <ErrorCard error={error} onRetry={retry} onNewQuestion={resetSearch} />
          )}

          {!loading && error == null && result && (
            <ResultView
              result={result}
              question={submittedQuestion}
              suggestions={QUICK_SUGGESTIONS}
              onPick={pick}
              onReset={resetSearch}
            />
          )}

          {!loading && error == null && !result && (
            <div className="explore">
              <div className="section-heading">
                <p className="eyebrow">Descubrí qué está pasando</p>
                <h2>Explorá la actualidad</h2>
                <p>Elegí un tema o empezá con una de estas búsquedas.</p>
              </div>

              <div className="trending">
                <span className="trending__label">Ahora</span>
                <div className="trending__chips">
                  {TRENDING.map((topic) => (
                    <button
                      type="button"
                      className="trending__chip"
                      key={topic}
                      onClick={() => pick(`¿Qué informó El País sobre ${topic.toLowerCase()}?`)}
                    >
                      <span aria-hidden="true">#</span>{topic}
                    </button>
                  ))}
                </div>
              </div>

              <div className="topic-grid">
                {TOPIC_GROUPS.map((group) => (
                  <article className="topic-card" key={group.label}>
                    <div className="topic-card__heading">
                      <span className="topic-card__icon-wrap">
                        <TopicIcon name={group.icon} />
                      </span>
                      <div>
                        <h3>{group.label}</h3>
                        <span>{group.questions.length} preguntas</span>
                      </div>
                    </div>
                    <ul>
                      {group.questions.map((item) => (
                        <li key={item}>
                          <button type="button" onClick={() => pick(item)}>
                            <span>{item}</span>
                            <span className="topic-card__arrow" aria-hidden="true">→</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </article>
                ))}
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
