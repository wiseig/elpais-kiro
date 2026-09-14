import type { ChatItem } from '../lib/history';
import type { ApiClient } from '../lib/api';
import { AiMark } from '../brand/Brand';
import { AnswerCard } from './AnswerCard';
import { Spinner, UserIcon } from './Icons';

interface Props {
  items: ChatItem[];
  loading: boolean;
  api: ApiClient;
  onSuggestion: (question: string) => void;
  onConsentRequired: () => void;
  onRetry: (text: string, id: string) => void;
}

/** Hilo de la conversación activa: turnos de usuario, respuestas y errores. */
export function Conversation({ items, loading, api, onSuggestion, onConsentRequired, onRetry }: Props) {
  return (
    <ol className="conversation" aria-live="polite" aria-relevant="additions" aria-busy={loading}>
      {items.map((item) => {
        if (item.kind === 'user') {
          return (
            <li key={item.id} className="turn turn--user">
              <span className="avatar avatar--user" aria-hidden="true">
                <UserIcon width={15} height={15} />
              </span>
              <p className="turn-text">{item.text}</p>
            </li>
          );
        }
        if (item.kind === 'answer') {
          return (
            <li key={item.id} className="turn turn--answer">
              <AnswerCard
                answer={item.answer}
                api={api}
                busy={loading}
                onSuggestion={onSuggestion}
                onConsentRequired={onConsentRequired}
              />
            </li>
          );
        }
        return (
          <li key={item.id} className="turn turn--error">
            <div className="notice notice--danger">
              <p className="notice-text">{item.message}</p>
              {item.retryText !== null ? (
                <button
                  type="button"
                  className="btn btn-small btn-secondary"
                  disabled={loading}
                  onClick={() => onRetry(item.retryText ?? '', item.id)}
                >
                  Reintentar
                </button>
              ) : null}
            </div>
          </li>
        );
      })}
      {loading ? (
        <li className="turn turn--answer" aria-busy="true">
          <div className="answer answer--loading">
            <div className="answer-head">
              <AiMark size={32} />
            </div>
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
  );
}
