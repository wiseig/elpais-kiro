import type { ReactNode } from 'react';
import { cx } from '../cx';

export type Tone = 'primary' | 'success' | 'warning' | 'danger' | 'neutral';

export function Chip({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={cx('chip', `chip--${tone}`)} title={title}>
      {children}
    </span>
  );
}

export function BoolChip({ value, yes = 'Sí', no = 'No', invert = false }: { value: boolean | undefined; yes?: string; no?: string; invert?: boolean }) {
  const positive = invert ? !value : Boolean(value);
  return <Chip tone={positive ? 'success' : 'neutral'}>{value ? yes : no}</Chip>;
}
