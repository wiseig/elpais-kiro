import type { ReactNode } from 'react';
import { cx } from '../cx';
import type { Tone } from './Chip';

interface StatProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  children?: ReactNode;
}

export function Stat({ label, value, hint, tone, children }: StatProps) {
  return (
    <div className={cx('stat', tone && `stat--${tone}`)}>
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
      {hint && <span className="stat__hint">{hint}</span>}
      {children}
    </div>
  );
}

/** Barra de progreso 0–100 coloreada según umbrales (80 % aviso, 100 % peligro). */
export function Progress({ percent, label, soft = 80 }: { percent: number; label?: string; soft?: number }) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const tone: Tone = percent >= 100 ? 'danger' : percent >= soft ? 'warning' : 'primary';
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      aria-label={label}
    >
      <span className={cx('progress__fill', `progress__fill--${tone}`)} style={{ width: `${clamped}%` }} />
    </div>
  );
}
