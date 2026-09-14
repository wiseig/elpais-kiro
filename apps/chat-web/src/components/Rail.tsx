import { useEffect, useState } from 'react';
import type { ConversationSummary } from '../lib/history';
import { toggleTheme, useTheme } from '../lib/theme';
import { ChatBubbleIcon, CloseIcon, GearIcon, HelpIcon, HistoryIcon, MoonIcon, PlusIcon, SidebarIcon, SunIcon } from './Icons';

interface Props {
  /** Cajón abierto en mobile (<768px); en escritorio el riel siempre está visible. */
  open: boolean;
  onClose: () => void;
  conversations: ConversationSummary[];
  activeId: string;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onOpenHelp: () => void;
  onOpenHistory: () => void;
  onOpenSettings: () => void;
  personalizationActive: boolean;
}

const MAX_RECENT = 8;

/**
 * Riel de navegación (Gemini-like): columna angosta en escritorio que se expande al pasar
 * el mouse o al fijarla con ☰; en mobile es un cajón que se abre desde el header.
 */
export function Rail({
  open,
  onClose,
  conversations,
  activeId,
  onSelectConversation,
  onNewConversation,
  onOpenHelp,
  onOpenHistory,
  onOpenSettings,
  personalizationActive,
}: Props) {
  const [pinned, setPinned] = useState(false);
  const { resolved } = useTheme();
  const recent = conversations.slice(0, MAX_RECENT);

  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  /** En mobile toda acción del riel cierra el cajón; en escritorio `onClose` no hace nada. */
  function run(action: () => void) {
    action();
    onClose();
  }

  return (
    <>
      <div className="rail-backdrop" data-open={open} onClick={onClose} aria-hidden="true" />
      <nav className={pinned ? 'rail rail--pinned' : 'rail'} data-open={open} aria-label="Navegación">
        <div className="rail-top">
          <button
            type="button"
            className="rail-action rail-toggle"
            data-tooltip={pinned ? 'Contraer menú' : 'Fijar menú expandido'}
            aria-label="Expandir o contraer el menú"
            aria-pressed={pinned}
            onClick={() => setPinned((value) => !value)}
          >
            <SidebarIcon />
          </button>
          <button type="button" className="icon-btn rail-mobile-close" aria-label="Cerrar menú" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <button type="button" className="rail-new" data-tooltip="Nueva conversación" aria-label="Nueva conversación" onClick={() => run(onNewConversation)}>
          <span className="rail-new-icon">
            <PlusIcon width={16} height={16} />
          </span>
          <span className="rail-label">Nueva conversación</span>
        </button>

        <div className="rail-recent">
          <p className="rail-section-label">Recientes</p>
          <ul className="rail-recent-list">
            {recent.length === 0 ? (
              <li className="rail-recent-empty">Tus conversaciones van a aparecer acá.</li>
            ) : (
              recent.map((conversation) => (
                <li key={conversation.id}>
                  <button
                    type="button"
                    className={
                      conversation.id === activeId ? 'rail-recent-item rail-recent-item--active' : 'rail-recent-item'
                    }
                    aria-current={conversation.id === activeId ? 'true' : undefined}
                    title={conversation.title}
                    onClick={() => run(() => onSelectConversation(conversation.id))}
                  >
                    <ChatBubbleIcon width={16} height={16} />
                    <span className="rail-label">{conversation.title}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
          {conversations.length > 0 ? (
            <button type="button" className="rail-view-all" onClick={() => run(onOpenHistory)}>
              Ver todo
            </button>
          ) : null}
        </div>

        <div className="rail-bottom">
          <button
            type="button"
            className="rail-action"
            data-tooltip="Tema"
            aria-label={resolved === 'dark' ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}
            onClick={() => run(toggleTheme)}
          >
            {resolved === 'dark' ? <MoonIcon /> : <SunIcon />}
            <span className="rail-label">Tema</span>
          </button>
          <button type="button" className="rail-action" data-tooltip="Ayuda" aria-label="Ayuda" onClick={() => run(onOpenHelp)}>
            <HelpIcon />
            <span className="rail-label">Ayuda</span>
          </button>
          <button type="button" className="rail-action" data-tooltip="Historial" aria-label="Historial" onClick={() => run(onOpenHistory)}>
            <HistoryIcon />
            <span className="rail-label">Historial</span>
          </button>
          <button
            type="button"
            className="rail-action rail-action--settings"
            data-tooltip="Ajustes" aria-label="Ajustes"
            onClick={() => run(onOpenSettings)}
          >
            <GearIcon />
            {personalizationActive ? <span className="rail-dot" aria-hidden="true" /> : null}
            <span className="rail-label">Ajustes</span>
          </button>
        </div>
      </nav>
    </>
  );
}
