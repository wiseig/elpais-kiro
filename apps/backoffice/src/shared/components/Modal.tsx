import { useEffect, useId, useRef, type MouseEvent, type ReactNode } from 'react';
import { cx } from '../cx';

interface ModalProps {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg' | 'xl';
  /** Panel lateral (drawer) en lugar de diálogo centrado. */
  side?: boolean;
}

export function Modal({ open, title, onClose, children, footer, size = 'md', side = false }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // onClose suele ser una función nueva en cada render: la guardamos en un ref
  // para que el efecto dependa solo de `open` y no robe el foco al re-renderizar.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const previouslyFocused = document.activeElement;
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [open]);

  if (!open) return null;

  const onOverlay = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <div className={cx('modal-overlay', side && 'modal-overlay--side')} onMouseDown={onOverlay}>
      <div
        ref={ref}
        className={cx('modal', `modal--${size}`, side && 'modal--side')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="modal__header">
          <h2 id={titleId} className="modal__title">
            {title}
          </h2>
          <button type="button" className="btn btn--ghost btn--small" onClick={onClose} aria-label="Cerrar">
            ✕
          </button>
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__footer">{footer}</footer>}
      </div>
    </div>
  );
}
