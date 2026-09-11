import { useState, type ReactNode } from 'react';
import type { Answer, AnswerBlock } from '@pelp/domain';
import type { NeutralAnswerResponse } from '@pelp/domain/api';
import type { ApiClient } from '../lib/api';
import { renderParagraphs } from '../lib/markdown';
import { Notice } from './Notice';
import { SourceCard } from './SourceCard';
import { ThumbDownIcon, ThumbUpIcon } from './Icons';

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

export function AnswerCard({ answer, api, busy, onSuggestion, onConsentRequired }: Props) {
  const [view, setView] = useState<View>('adapted');
  const [neutral, setNeutral] = useState<NeutralAnswerResponse | null>(null);
  const [neutralState, setNeutralState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [stage, setStage] = useState<FeedbackStage>('idle');
  const [vote, setVote] = useState<'up' | 'down' | null>(null);
  const [comment, setComment] = useState('');

  const showingNeutral = view === 'neutral' && neutral !== null;
  const blocks = showingNeutral ? neutral.blocks : answer.blocks;
  const hadCoverage = showingNeutral ? neutral.hadCoverage : answer.hadCoverage;
  const canToggleNeutral = answer.personalized && Boolean(answer.neutralAnswerId);

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
    } catch {
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
            <ul className="sources-list">
              {block.items.map((item, i) => (
                <SourceCard key={`${item.url}-${i}`} item={item} onOpen={trackSource} />
              ))}
            </ul>
          </section>
        );
      case 'cta':
        return (
          <p className="cta-wrap" key={index}>
            <a className="cta" href={block.url} target="_blank" rel="noreferrer">
              {block.text}
            </a>
          </p>
        );
      case 'suggestions':
        if (block.items.length === 0) return null;
        return (
          <div className="answer-suggestions" key={index}>
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
        return <Notice key={index} text={block.text} code={block.code} onConsent={onConsentRequired} />;
    }
  }

  const cardClass = ['answer', hadCoverage ? '' : 'answer--nocoverage', showingNeutral ? 'answer--neutral' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <article className={cardClass} aria-label="Respuesta de El País">
      <header className="answer-head">
        <span className="answer-from">El País</span>
        {!hadCoverage ? <span className="badge badge--muted">Sin cobertura</span> : null}
        {answer.personalized ? (
          <span className="badge badge--brand">
            {showingNeutral ? 'Versión neutral' : 'Adaptada a tus intereses'}
          </span>
        ) : null}
        {canToggleNeutral ? (
          <button
            type="button"
            className="link-btn"
            onClick={() => void toggleNeutral()}
            disabled={neutralState === 'loading'}
            aria-busy={neutralState === 'loading'}
          >
            {neutralState === 'loading'
              ? 'Cargando…'
              : view === 'neutral'
                ? 'Ver versión adaptada'
                : 'Ver versión neutral'}
          </button>
        ) : null}
      </header>

      {neutralState === 'error' ? (
        <p className="inline-error">No pudimos cargar la versión neutral. Probá de nuevo.</p>
      ) : null}

      <div className="answer-body">{blocks.map((block, index) => renderBlock(block, index))}</div>

      {answer.personalized && answer.explain ? (
        <details className="explain">
          <summary>¿Por qué veo esto?</summary>
          <p>{answer.explain}</p>
        </details>
      ) : null}

      <footer className="feedback">
        {stage === 'done' ? (
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
            {stage === 'error' ? (
              <span className="inline-error">No pudimos enviar tu opinión. Probá de nuevo.</span>
            ) : null}
          </>
        )}
      </footer>

      {stage === 'comment' ? (
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
  );
}
