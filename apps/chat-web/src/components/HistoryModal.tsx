import { useEffect, useId, useRef, useState } from 'react';
import type { ConversationSummary } from '../lib/history';
import { formatRelativeDay } from '../lib/format';
import { ChatBubbleIcon, CloseIcon, TrashIcon } from './Icons';
import { Modal } from './Modal';

interface Props {
  conversations: ConversationSummary[];
  activeId: string;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onClearAll: () => void;
  onClose: () => void;
}

const CONFIRM_TIMEOUT_MS = 3000;

function questionCountLabel(count: number): string {
  if (count <= 0) return '';
  return count === 1 ? '1 pregunta' : `${count} preguntas`;
}

/** Panel con todas las conversaciones guardadas en este navegador: abrir una o borrarla (esta es la vista de gestión; "Recientes" en el riel es solo el atajo). */
export function HistoryModal({ conversations, activeId, onSelect, onRemove, onClearAll, onClose }: Props) {
  const titleId = useId();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const revertTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (revertTimeout.current) clearTimeout(revertTimeout.current);
    },
    [],
  );

  function askConfirm(id: string) {
    if (revertTimeout.current) clearTimeout(revertTimeout.current);
    setConfirmId(id);
    revertTimeout.current = setTimeout(() => setConfirmId(null), CONFIRM_TIMEOUT_MS);
  }

  function confirmRemove(id: string) {
    if (revertTimeout.current) clearTimeout(revertTimeout.current);
    setConfirmId(null);
    onRemove(id);
  }

  return (
    <Modal labelledBy={titleId} onClose={onClose} className="modal--history" variant="drawer">
      <div className="modal-header">
        <h2 id={titleId} className="modal-title">
          Historial
        </h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar historial">
          <CloseIcon />
        </button>
      </div>
      <div className="modal-body">
        {conversations.length === 0 ? (
          <p className="muted">Todavía no tenés conversaciones guardadas en este navegador.</p>
        ) : (
          <ul className="history-list">
            {conversations.map((conversation) => {
              const meta = [formatRelativeDay(conversation.updatedAt), questionCountLabel(conversation.questionCount)]
                .filter(Boolean)
                .join(' · ');
              return (
                <li
                  key={conversation.id}
                  className={
                    conversation.id === activeId ? 'history-item history-item--active' : 'history-item'
                  }
                >
                  <button type="button" className="history-item-button" onClick={() => onSelect(conversation.id)}>
                    <ChatBubbleIcon width={16} height={16} />
                    <span className="history-item-text">
                      <span className="history-item-title">{conversation.title}</span>
                      <span className="history-item-date">{meta}</span>
                    </span>
                  </button>
                  {confirmId === conversation.id ? (
                    <span className="history-item-confirm">
                      <span className="history-item-confirm-label">¿Borrar?</span>
                      <button
                        type="button"
                        className="btn btn-danger btn-tiny"
                        onClick={() => confirmRemove(conversation.id)}
                      >
                        Sí
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="icon-btn icon-btn--small"
                      aria-label={`Borrar conversación: ${conversation.title}`}
                      onClick={() => askConfirm(conversation.id)}
                    >
                      <TrashIcon width={16} height={16} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {conversations.length > 0 ? (
        <div className="modal-actions">
          {confirmAll ? (
            <div className="confirm-box" role="group" aria-label="Confirmar borrado de todo el historial">
              <p>¿Seguro que querés borrar todo el historial? Esta acción no se puede deshacer.</p>
              <div className="btn-row">
                <button type="button" className="btn btn-danger btn-small" onClick={onClearAll}>
                  Sí, borrar todo
                </button>
                <button type="button" className="btn btn-ghost btn-small" onClick={() => setConfirmAll(false)}>
                  Cancelar
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn btn-danger-outline btn-small" onClick={() => setConfirmAll(true)}>
              Borrar todo el historial
            </button>
          )}
        </div>
      ) : null}
    </Modal>
  );
}
