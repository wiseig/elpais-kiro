import { useCallback, useEffect, useRef, useState } from 'react';
import type { Answer, NoticeCode } from '@pelp/domain';
import type { ConsentTextResponse, MeResponse } from '@pelp/domain/api';
import type { ApiClient } from '../lib/api';
import { describeError, describeSaveError } from '../lib/errors';
import { prefersReducedMotion } from '../lib/format';
import { loadHistory, saveHistory, type ChatItem } from '../lib/history';
import { getToken } from '../lib/session';
import { AnswerCard } from './AnswerCard';
import { Composer } from './Composer';
import { ConsentGate, type GateDecision } from './ConsentGate';
import { Footer, Header } from './Header';
import { Spinner } from './Icons';
import { Settings } from './Settings';

export const MAX_QUESTION_LENGTH = 500;

interface Props {
  api: ApiClient;
  me: MeResponse;
  consent: ConsentTextResponse;
  suggestions: string[];
  onMeChange: (me: MeResponse) => void;
  /** Se llama después de `DELETE /v1/me`: la app pide una sesión nueva y remonta el chat. */
  onDeleted: () => Promise<void>;
}

function hasNotice(answer: Answer, code: NoticeCode): boolean {
  return answer.blocks.some((block) => block.type === 'notice' && block.code === code);
}

export function Chat({ api, me, consent, suggestions, onMeChange, onDeleted }: Props) {
  const token = getToken();
  const [snapshot] = useState(() => loadHistory(token));
  const [items, setItems] = useState<ChatItem[]>(snapshot.items);
  const conversationRef = useRef<string | undefined>(snapshot.conversationId);
  const [loading, setLoading] = useState(false);
  const [gateOpen, setGateOpen] = useState(me.needsConsent);
  const [consentBusy, setConsentBusy] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const idPrefix = useRef(Date.now().toString(36));
  const idCounter = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);

  const newId = () => {
    idCounter.current += 1;
    return `${idPrefix.current}-${idCounter.current}`;
  };

  useEffect(() => {
    saveHistory(getToken(), { items, conversationId: conversationRef.current });
  }, [items]);

  useEffect(() => {
    if (items.length === 0 && !loading) return;
    endRef.current?.scrollIntoView({ block: 'end', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [items, loading]);

  const refreshMe = useCallback(() => {
    api
      .getMe()
      .then(onMeChange)
      .catch(() => undefined);
  }, [api, onMeChange]);

  const send = useCallback(
    async (raw: string, retryOfId?: string) => {
      const question = raw.trim();
      if (!question || loading) return;
      if (me.needsConsent) {
        setGateOpen(true);
        return;
      }
      if (retryOfId) {
        setItems((prev) => prev.filter((item) => item.id !== retryOfId));
      } else {
        setItems((prev) => [...prev, { kind: 'user', id: newId(), text: question }]);
      }
      setLoading(true);
      try {
        const answer = await api.ask({ question, conversationId: conversationRef.current });
        if (answer.conversationId) conversationRef.current = answer.conversationId;
        setItems((prev) => [...prev, { kind: 'answer', id: newId(), answer }]);
        if (hasNotice(answer, 'consent_required')) {
          setGateOpen(true);
          refreshMe();
        }
      } catch (err) {
        const friendly = describeError(err);
        setItems((prev) => [
          ...prev,
          {
            kind: 'error',
            id: newId(),
            message: friendly.message,
            retryText: friendly.retryable ? question : null,
          },
        ]);
        if (friendly.code === 'consent_required') {
          setGateOpen(true);
          refreshMe();
        }
      } finally {
        setLoading(false);
      }
    },
    [api, loading, me.needsConsent, refreshMe],
  );

  function resetConversation() {
    conversationRef.current = undefined;
    setItems([]);
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }

  async function decide(decision: GateDecision, ageConfirmed: boolean) {
    setConsentBusy(true);
    setConsentError(null);
    try {
      const next = await api.postConsent({
        decision,
        textVersion: consent.textVersion,
        ageConfirmed: decision === 'personalize' ? ageConfirmed : undefined,
        locale: 'es-UY',
      });
      onMeChange(next);
      setGateOpen(false);
    } catch (err) {
      setConsentError(describeSaveError(err));
    } finally {
      setConsentBusy(false);
    }
  }

  async function changeMode(mode: 'personalized' | 'neutral', ageConfirmed?: boolean) {
    const next = await api.patchMe({ mode, textVersion: consent.textVersion, ageConfirmed });
    onMeChange(next);
  }

  async function deleteData() {
    await api.deleteMe();
    await onDeleted();
  }

  const modalOpen = gateOpen || settingsOpen;
  const consentMissing = me.needsConsent && !gateOpen;
  const showEmpty = items.length === 0 && !loading;

  return (
    <>
      <div className="app-shell" aria-hidden={modalOpen ? true : undefined}>
        <Header
          onOpenSettings={() => setSettingsOpen(true)}
          onNewConversation={items.length > 0 ? resetConversation : undefined}
          settingsOpen={settingsOpen}
        />

        <main className="main">
          {showEmpty ? (
            <section className="empty">
              <h2 className="empty-title">¿Qué querés saber?</h2>
              <p className="empty-text">
                Preguntá sobre la actualidad. Respondemos usando únicamente notas publicadas por El País y
                te mostramos las fuentes.
              </p>
              {suggestions.length > 0 ? (
                <div className="empty-suggestions">
                  <p className="chips-title">Preguntas sugeridas</p>
                  <div className="chips">
                    {suggestions.map((question) => (
                      <button
                        type="button"
                        className="chip"
                        key={question}
                        onClick={() => void send(question)}
                      >
                        {question}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}

          <ol className="messages" aria-live="polite" aria-relevant="additions" aria-busy={loading}>
            {items.map((item) => {
              if (item.kind === 'user') {
                return (
                  <li key={item.id} className="msg msg--user">
                    <div className="bubble-user">{item.text}</div>
                  </li>
                );
              }
              if (item.kind === 'answer') {
                return (
                  <li key={item.id} className="msg msg--answer">
                    <AnswerCard
                      answer={item.answer}
                      api={api}
                      busy={loading}
                      onSuggestion={(question) => void send(question)}
                      onConsentRequired={() => setGateOpen(true)}
                    />
                  </li>
                );
              }
              return (
                <li key={item.id} className="msg msg--error">
                  <div className="notice notice--danger">
                    <p className="notice-text">{item.message}</p>
                    {item.retryText !== null ? (
                      <button
                        type="button"
                        className="btn btn-small btn-secondary"
                        disabled={loading}
                        onClick={() => void send(item.retryText ?? '', item.id)}
                      >
                        Reintentar
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
            {loading ? (
              <li className="msg msg--answer" aria-busy="true">
                <div className="answer answer--loading">
                  <div className="skeleton" aria-hidden="true">
                    <span className="skeleton-line w-40" />
                    <span className="skeleton-line" />
                    <span className="skeleton-line w-80" />
                  </div>
                  <p className="loading-text" role="status">
                    <Spinner /> Buscando en las notas de El País…
                  </p>
                </div>
              </li>
            ) : null}
          </ol>
          <div ref={endRef} className="scroll-anchor" aria-hidden="true" />
        </main>

        <div className="composer-wrap">
          <div className="composer-inner">
            {consentMissing ? (
              <div className="notice notice--warn consent-missing" role="status">
                <p className="notice-text">Para preguntar tenés que elegir una opción.</p>
                <button type="button" className="btn btn-small btn-primary" onClick={() => setGateOpen(true)}>
                  Elegir una opción
                </button>
              </div>
            ) : null}
            <Composer
              disabled={me.needsConsent}
              loading={loading}
              maxLength={MAX_QUESTION_LENGTH}
              onSend={(question) => void send(question)}
            />
          </div>
          <Footer />
        </div>
      </div>

      {gateOpen ? (
        <ConsentGate
          consent={consent}
          busy={consentBusy}
          error={consentError}
          onDecide={(decision, ageConfirmed) => void decide(decision, ageConfirmed)}
          onClose={() => setGateOpen(false)}
        />
      ) : null}

      {settingsOpen ? (
        <Settings
          me={me}
          consent={consent}
          onClose={() => setSettingsOpen(false)}
          onOpenGate={() => setGateOpen(true)}
          onChangeMode={changeMode}
          onDelete={deleteData}
        />
      ) : null}
    </>
  );
}
