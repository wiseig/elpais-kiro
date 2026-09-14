import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ModalProps {
  labelledBy: string;
  children: ReactNode;
  onClose?: () => void;
  closeOnBackdrop?: boolean;
  className?: string;
  /** 'drawer' se ancla al borde derecho en escritorio (Ajustes, Historial); 'dialog' queda centrado. */
  variant?: 'dialog' | 'drawer';
}

/** Diálogo modal accesible: bloquea el scroll del body, atrapa el foco y cierra con Escape. */
export function Modal({
  labelledBy,
  children,
  onClose,
  closeOnBackdrop = true,
  className,
  variant = 'dialog',
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.classList.add('modal-open');
    dialogRef.current?.focus();
    return () => {
      document.body.classList.remove('modal-open');
      previous?.focus();
    };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      if (onClose) {
        event.stopPropagation();
        onClose();
      }
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleBackdrop(event: MouseEvent<HTMLDivElement>) {
    if (closeOnBackdrop && onClose && event.target === event.currentTarget) onClose();
  }

  const backdropClass = variant === 'drawer' ? 'modal-backdrop modal-backdrop--drawer' : 'modal-backdrop';
  const dialogClass = [variant === 'drawer' ? 'modal modal--drawer' : 'modal', className].filter(Boolean).join(' ');

  return (
    <div className={backdropClass} onMouseDown={handleBackdrop}>
      <div
        ref={dialogRef}
        className={dialogClass}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        {children}
      </div>
    </div>
  );
}
