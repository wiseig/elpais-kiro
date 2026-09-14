import { useId } from 'react';
import { Link } from 'react-router-dom';
import { Modal } from './Modal';

interface Props {
  onClose: () => void;
}

/** Ayuda breve: qué es el asistente, sus límites y el enlace a los Términos. */
export function HelpModal({ onClose }: Props) {
  const titleId = useId();
  return (
    <Modal labelledBy={titleId} onClose={onClose} className="modal--help">
      <div className="modal-header">
        <h2 id={titleId} className="modal-title">
          ¿Cómo funciona?
        </h2>
        <button type="button" className="link-btn modal-close" onClick={onClose}>
          Cerrar
        </button>
      </div>
      <div className="modal-body">
        <p>
          <strong>Preguntale a El País</strong> responde tus preguntas sobre la actualidad usando
          únicamente notas publicadas por El País (Uruguay) y siempre te muestra de dónde salió cada dato.
        </p>
        <ul className="help-list">
          <li>Si no hay notas suficientes para responder, te lo decimos en vez de inventar algo.</li>
          <li>Las respuestas pueden contener errores: verificá siempre en la nota original.</li>
          <li>
            Con la personalización activada adaptamos el orden y el enfoque a tus intereses; los hechos
            citados nunca cambian.
          </li>
          <li>Podés borrar tu historial y tus datos cuando quieras desde Ajustes.</li>
        </ul>
        <p className="settings-footer">
          <Link to="/terminos" onClick={onClose}>
            Términos de uso y privacidad
          </Link>
        </p>
      </div>
    </Modal>
  );
}
