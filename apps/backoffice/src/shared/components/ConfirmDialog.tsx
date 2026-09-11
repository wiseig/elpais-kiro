import { useEffect, useId, useState, type ReactNode } from 'react';
import { Modal } from './Modal';
import { cx } from '../cx';

export type ReasonMode = 'none' | 'optional' | 'required';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** Pide un motivo: opcional u obligatorio. */
  reason?: ReasonMode;
  reasonLabel?: string;
  busy?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  children?: ReactNode;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  danger = false,
  reason = 'none',
  reasonLabel = 'Motivo',
  busy = false,
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps) {
  const [text, setText] = useState('');
  const reasonId = useId();

  useEffect(() => {
    if (open) setText('');
  }, [open]);

  const missingReason = reason === 'required' && text.trim().length === 0;

  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={cx('btn', danger ? 'btn--danger' : 'btn--primary')}
            onClick={() => onConfirm(text.trim())}
            disabled={busy || missingReason}
          >
            {busy ? 'Procesando…' : confirmLabel}
          </button>
        </>
      }
    >
      {message && <div className="confirm__message">{message}</div>}
      {children}
      {reason !== 'none' && (
        <div className="field">
          <label className="field__label" htmlFor={reasonId}>
            {reasonLabel}
            {reason === 'required' ? ' (obligatorio)' : ' (opcional)'}
          </label>
          <textarea
            id={reasonId}
            className="input"
            rows={3}
            value={text}
            onChange={(event) => setText(event.target.value)}
            autoFocus
            placeholder="Contá brevemente por qué se hace este cambio; queda en la auditoría."
          />
        </div>
      )}
    </Modal>
  );
}
