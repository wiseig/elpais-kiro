import { useId, useState, type ReactNode } from 'react';
import type { Answer, AnswerBlock, NoticeCode } from '@pelp/domain';
import { startsWithNoCoverage } from '@pelp/domain';
import type { NeutralAnswerResponse } from '@pelp/domain/api';
import { AiMark, Sparkle } from '../brand/Brand';
import { ApiRequestError, type ApiClient } from '../lib/api';
import { renderParagraphs } from '../lib/markdown';
import { Notice } from './Notice';
import { SourcePreviewCard } from './SourcePreview';
import { ChevronDownIcon, InfoIcon, ThumbDownIcon, ThumbUpIcon } from './Icons';

interface Props {
  answer: Answer;
  api: ApiClient;
  /** true mientras hay otra pregunta en curso: deshabilita los chips. */
  busy: boolean;
  onSuggestion: (question: string) => void;
  onConsentRequired: () => void;
}

type View = 'adapted' | 'neutral';
type FeedbackStage = 'idle' | 'comment' | 'sending' | 'done' | 'error';

/* La detección de "sin cobertura" es la misma que usa el motor (`startsWithNoCoverage`): el
   modelo a veces mete el tema en la frase ("El País no publicó sobre Marset…") y con una
   comparación exacta la tarjeta ámbar desaparecía y volvía la insignia gris. */

/**
 * Códigos de notice que son un trámite ("elegí una opción", "esperá", "pausado") y no una
 * respuesta sobre la que tenga sentido preguntar "¿te sirvió?".
 */
const NOTICE_CODES_WITHOUT_FEEDBACK = new Set<NoticeCode>([
  'consent_required',
  'age_confirmation_required',
  'service_paused',
  'budget_paused',
  'rate_limited',
  'too_long',
]);

const FEEDBACK_ERROR_GENERIC = 'No pudimos enviar tu opinión. Probá de nuevo.';
const FEEDBACK_ERROR_NOT_FOUND = 'No se pudo registrar tu opinión';

export function AnswerCard({ answer, api, busy, onSuggestion, onConsentRequired }: Props) {
  const [view, setView] = useState<View>('adapted');
  const [neutral, setNeutral] = useState<NeutralAnswerResponse | null>(null);
  const [neutralState, setNeutralState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [stage, setStage] = useState<FeedbackStage>('idle');
  const [vote, setVote] = useState<'up' | 'down' | null>(null);
  const [comment, setComment] = useState('');
  const [feedbackError, setFeedbackError] = useState<string>(FEEDBACK_ERROR_GENERIC);
  const [noCoverageOpen, setNoCoverageOpen] = useState(false);
  const [explainOpen, setExplainOpen] = useState(false);
  const noCoverageId = useId();
  const explainId = useId();

  const showingNeutral = view === 'neutral' && neutral !== null;
  const blocks = showingNeutral ? neutral.blocks : answer.blocks;
  const hadCoverage = showingNeutral ? neutral.hadCoverage : answer.hadCoverage;
  const canToggleNeutral = answer.personalized && Boolean(answer.neutralAnswerId);

  // "Sin cobertura" con el mensaje estándar del motor: se muestra como una tarjeta ámbar
  // pegada arriba de la respuesta, en vez del badge suelto (que sigue para otros casos).
  const firstTextBlock = blocks.find((block): block is Extract<AnswerBlock, { type: 'text' }> => block.type === 'text');
  const showNoCoverageBanner = !hadCoverage && Boolean(firstTextBlock && startsWithNoCoverage(firstTextBlock.text));

  // El feedback no tiene sentido cuando la única "respuesta" es un trámite (elegí una
  // opción, esperá, pausado): sí se muestra para bloqueadas/fuera de tema (código `blocked`
  // y `off_topic`), que son una respuesta real aunque no tengan contenido de El País.
  const ctaBlock = blocks.find((block): block is Extract<AnswerBlock, { type: 'cta' }> => block.type === 'cta');
  const [onlyBlock] = blocks;
  const onlyNoticeCode: NoticeCode | undefined =
    blocks.length === 1 && onlyBlock?.type === 'notice' ? onlyBlock.code : undefined;
  const showFeedback = (!onlyNoticeCode || !NOTICE_CODES_WITHOUT_FEEDBACK.has(onlyNoticeCode)) && answer.kind !== 'greeting';

  // El badge "Sin cobertura" es para respuestas sobre la actualidad sin notas: cuando la
  // respuesta es solo un aviso (fuera de tema, bloqueada, pausa) el aviso ya lo explica.
  // Un saludo no es una respuesta sobre la actualidad: no lleva badge, ni el destaque de las
  // sugerencias, ni "¿Te sirvió?". No le fallamos a nadie, solo saludamos.
  const isGreeting = answer.kind === 'greeting';
  const showNoCoverageBadge = !hadCoverage && !showNoCoverageBanner && !onlyNoticeCode && !isGreeting;

  function trackSource(url: string) {
    api.postEvent({ type: 'SourceClicked', answerId: answer.answerId, url }).catch(() => undefined);
  }

  async function toggleNeutral() {
    if (view === 'neutral') {
      setView('adapted');
      return;
    }
    if (neutral) {
      setView('neutral');
      return;
    }
    const id = answer.neutralAnswerId;
    if (!id) return;
    setNeutralState('loading');
    try {
      const result = await api.getNeutralAnswer(id);
      setNeutral(result);
      setView('neutral');
      setNeutralState('idle');
    } catch {
      setNeutralState('error');
    }
  }

  async function submitFeedback(choice: 'up' | 'down', text?: string) {
    setVote(choice);
    setStage('sending');
    try {
      const trimmed = text?.trim();
      await api.postFeedback({
        answerId: answer.answerId,
        vote: choice,
        comment: trimmed ? trimmed : undefined,
      });
      setStage('done');
    } catch (err) {
      const notFound = err instanceof ApiRequestError && err.status === 404;
      setFeedbackError(notFound ? FEEDBACK_ERROR_NOT_FOUND : FEEDBACK_ERROR_GENERIC);
      setStage('error');
    }
  }

  function renderBlock(block: AnswerBlock, index: number): ReactNode {
    switch (block.type) {
      case 'text':
        return (
          <div className="answer-text" key={index}>
            {renderParagraphs(block.text)}
          </div>
        );
      case 'sources':
        if (block.items.length === 0) return null;
        return (
          <section className="sources" key={index} aria-label="Fuentes">
            <h3 className="sources-title">Fuentes</h3>
            <ul className="sources-strip">
              {block.items.map((item, i) => (
                <SourcePreviewCard key={`${item.url}-${i}`} item={item} api={api} onOpen={trackSource} />
              ))}
            </ul>
          </section>
        );
      case 'cta':
        // Va en el pie, alineado a la derecha junto al "¿Te sirvió?" (ver más abajo).
        return null;
      case 'suggestions':
        if (block.items.length === 0) return null;
        return (
          <div className={hadCoverage || isGreeting ? 'answer-suggestions' : 'answer-suggestions answer-suggestions--prominent'} key={index}>
            <p className="chips-title">Seguí preguntando</p>
            <div className="chips">
              {block.items.map((question) => (
                <button
                  type="button"
                  className="chip"
                  key={question}
                  disabled={busy}
                  onClick={() => onSuggestion(question)}
                >
                  {question}
                </button>
              ))}
            </div>
          </div>
        );
      case 'notice':
        // La personalización ya se comunica con la insignia del encabezado: no repetirla como banner.
        if (block.code === 'personalized') return null;
        return <Notice key={index} text={block.text} code={block.code} onConsent={onConsentRequired} />;
    }
  }

  const cardClass = ['answer', showNoCoverageBadge ? 'answer--nocoverage' : '', showingNeutral ? 'answer--neutral' : '']
    .filter(Boolean)
    .join(' ');

  const stackClass = [
    'answer-stack',
    showNoCoverageBanner ? 'answer-stack--slip' : '',
    answer.personalized ? 'answer-stack--personalized' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={stackClass}>
      {/* Cinta que asoma por arriba de la respuesta, con el mismo lenguaje que la de sin
          cobertura: dice de dónde sale la adaptación y deja volver a la versión neutral. */}
      {answer.personalized ? (
        <div
          className={
            explainOpen && answer.explain ? 'personalized-slip personalized-slip--open' : 'personalized-slip'
          }
          role="note"
        >
          <div className="personalized-row">
            {answer.explain ? (
              // El porqué de la adaptación se despliega desde la cinta, igual que la ficha ámbar.
              <button
                type="button"
                className="personalized-head"
                aria-expanded={explainOpen}
                aria-controls={explainId}
                onClick={() => setExplainOpen((open) => !open)}
              >
                <span className="personalized-icon" aria-hidden="true">
                  <Sparkle size={15} twin={false} />
                </span>
                <span className="personalized-title">
                  {showingNeutral ? 'Estás viendo la versión neutral' : 'Adaptada a tus intereses'}
                </span>
                <span className="personalized-chevron" aria-hidden="true">
                  <ChevronDownIcon />
                </span>
              </button>
            ) : (
              <span className="personalized-head personalized-head--plain">
                <span className="personalized-icon" aria-hidden="true">
                  <Sparkle size={15} twin={false} />
                </span>
                <span className="personalized-title">
                  {showingNeutral ? 'Estás viendo la versión neutral' : 'Adaptada a tus intereses'}
                </span>
              </span>
            )}
            {canToggleNeutral ? (
              <button
                type="button"
                className="personalized-action"
                onClick={() => void toggleNeutral()}
                disabled={neutralState === 'loading'}
                aria-busy={neutralState === 'loading'}
              >
                {neutralState === 'loading' ? 'Cargando…' : showingNeutral ? 'Ver versión adaptada' : 'Ver versión neutral'}
              </button>
            ) : null}
          </div>
          {answer.explain ? (
            <div className="personalized-detail" id={explainId}>
              <p className="personalized-text">{answer.explain}</p>
            </div>
          ) : null}
        </div>
      ) : null}
      <article className={cardClass} aria-label="Respuesta de El País">
        <header className="answer-head">
          <span className="answer-brand">
            <AiMark size={32} />
            <span className="answer-brand-text">
              <span className="answer-from">El País</span>
              <span className="answer-from-sub">Respuesta generada con IA</span>
            </span>
          </span>
          {showNoCoverageBadge ? <span className="badge badge--muted">Sin cobertura</span> : null}
        </header>

        {neutralState === 'error' ? (
          <p className="inline-error">No pudimos cargar la versión neutral. Probá de nuevo.</p>
        ) : null}

        <div className="answer-body">{blocks.map((block, index) => renderBlock(block, index))}</div>

        {showFeedback || ctaBlock ? (
          <footer className="feedback">
            {!showFeedback ? null : stage === 'done' ? (
              <p className="feedback-thanks" role="status">
                Gracias por tu opinión
              </p>
            ) : (
              <>
                <span className="feedback-label">¿Te sirvió?</span>
                <button
                  type="button"
                  className={vote === 'up' ? 'icon-btn icon-btn--active' : 'icon-btn'}
                  aria-label="Sí, me sirvió"
                  aria-pressed={vote === 'up'}
                  disabled={stage === 'sending'}
                  onClick={() => void submitFeedback('up')}
                >
                  <ThumbUpIcon />
                </button>
                <button
                  type="button"
                  className={vote === 'down' ? 'icon-btn icon-btn--active' : 'icon-btn'}
                  aria-label="No me sirvió"
                  aria-pressed={vote === 'down'}
                  disabled={stage === 'sending'}
                  onClick={() => {
                    setVote('down');
                    setStage('comment');
                  }}
                >
                  <ThumbDownIcon />
                </button>
                {stage === 'sending' ? <span className="hint">Enviando…</span> : null}
                {stage === 'error' ? <span className="inline-error">{feedbackError}</span> : null}
              </>
            )}
            {ctaBlock ? (
              <a className="cta feedback-cta" href={ctaBlock.url} target="_blank" rel="noreferrer">
                {ctaBlock.text}
              </a>
            ) : null}
          </footer>
        ) : null}

        {showFeedback && stage === 'comment' ? (
          <form
            className="feedback-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitFeedback('down', comment);
            }}
          >
            <label htmlFor={`${answer.answerId}-comment`} className="feedback-form-label">
              ¿Qué faltó? <span className="hint">(opcional)</span>
            </label>
            <textarea
              id={`${answer.answerId}-comment`}
              rows={2}
              maxLength={500}
              value={comment}
              placeholder="Contanos qué esperabas encontrar"
              onChange={(event) => setComment(event.target.value)}
            />
            <div className="btn-row">
              <button type="submit" className="btn btn-small btn-primary">
                Enviar
              </button>
              <button
                type="button"
                className="btn btn-small btn-ghost"
                onClick={() => {
                  setStage('idle');
                  setVote(null);
                }}
              >
                Cancelar
              </button>
            </div>
          </form>
        ) : null}
      </article>

      {showNoCoverageBanner ? (
        // Ficha ámbar que asoma por debajo de la respuesta y se despliega al pasar el mouse
        // (o al tocarla/enfocarla en pantallas sin hover).
        <div className={noCoverageOpen ? 'nocoverage-slip nocoverage-slip--open' : 'nocoverage-slip'} role="note">
          <button
            type="button"
            className="nocoverage-head"
            aria-expanded={noCoverageOpen}
            aria-controls={noCoverageId}
            onClick={() => setNoCoverageOpen((open) => !open)}
          >
            <span className="nocoverage-icon" aria-hidden="true">
              <InfoIcon />
            </span>
            <span className="nocoverage-title">No encontramos cobertura reciente</span>
            <span className="nocoverage-chevron" aria-hidden="true">
              <ChevronDownIcon />
            </span>
          </button>
          <div className="nocoverage-detail" id={noCoverageId}>
            <p className="nocoverage-text">
              Respondemos únicamente con notas publicadas por El País. Sobre este tema no hay notas recientes en
              nuestro archivo, así que preferimos no inventar una respuesta. Probá con otra pregunta o con una de
              las sugerencias.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
