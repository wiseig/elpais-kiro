import type { ReactNode } from 'react';
import { cx } from '../cx';

interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Usar `div` cuando el hijo no es un único control (evita labels ambiguos). */
  as?: 'label' | 'div';
}

/** Etiqueta + control + ayuda. Por defecto envuelve el control en un `<label>`. */
export function Field({ label, hint, children, className, as = 'label' }: FieldProps) {
  const Tag = as;
  return (
    <Tag className={cx('field', className)}>
      <span className="field__label">{label}</span>
      {children}
      {hint && <span className="field__hint">{hint}</span>}
    </Tag>
  );
}

interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  danger?: boolean;
}

export function Toggle({ checked, onChange, label, disabled = false, danger = false }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={cx('toggle', checked && 'toggle--on', danger && 'toggle--danger')}
      onClick={() => onChange(!checked)}
      disabled={disabled}
    >
      <span className="toggle__track" aria-hidden="true">
        <span className="toggle__knob" />
      </span>
      <span className="toggle__label">{label}</span>
    </button>
  );
}
