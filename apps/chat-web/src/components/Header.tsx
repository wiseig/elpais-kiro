import { useState } from 'react';
import { Link } from 'react-router-dom';
import { GearIcon, PlusIcon } from './Icons';

interface Props {
  onOpenSettings?: () => void;
  onNewConversation?: () => void;
  settingsOpen?: boolean;
}

/** Logo de El País con texto de respaldo si la imagen no carga. */
export function Logo() {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="logo logo--text" aria-hidden="true">
        EL PAÍS
      </span>
    );
  }
  return (
    <img
      className="logo"
      src="/logo.jpg"
      alt=""
      width={40}
      height={40}
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

export function Header({ onOpenSettings, onNewConversation, settingsOpen = false }: Props) {
  return (
    <header className="header">
      <div className="header-inner">
        <Link to="/" className="brand" aria-label="Preguntale a El País, inicio">
          <Logo />
          <span className="brand-text">
            <span className="brand-title">Preguntale a El País</span>
            <span className="brand-subtitle">Respuestas con las notas de El País</span>
          </span>
        </Link>
        <div className="header-actions">
          {onNewConversation ? (
            <button type="button" className="btn btn-ghost" onClick={onNewConversation}>
              <PlusIcon />
              <span className="btn-label">Nueva conversación</span>
            </button>
          ) : null}
          {onOpenSettings ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={onOpenSettings}
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
            >
              <GearIcon />
              <span className="btn-label">Ajustes</span>
            </button>
          ) : null}
        </div>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <p>
        Las respuestas se elaboran únicamente con notas de El País. Verificá siempre en la nota
        original. <Link to="/terminos">Términos de uso y privacidad</Link>
      </p>
    </footer>
  );
}
