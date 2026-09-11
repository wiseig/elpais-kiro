import type { ReactNode } from 'react';
import { cx } from '../cx';
import { fmtInt } from '../format';
import { Empty } from './Empty';
import type { Tone } from './Chip';

export interface BarItem {
  key: string;
  label: ReactNode;
  value: number;
  hint?: string;
}

interface BarsProps {
  items: BarItem[];
  format?: (value: number) => string;
  max?: number;
  tone?: Tone;
  emptyText?: string;
  maxItems?: number;
}

/** Barras horizontales (distribuciones). */
export function Bars({ items, format = fmtInt, max, tone = 'primary', emptyText = 'Sin datos.', maxItems }: BarsProps) {
  const shown = maxItems ? items.slice(0, maxItems) : items;
  if (shown.length === 0) return <Empty text={emptyText} />;
  const top = max ?? (Math.max(0, ...shown.map((item) => item.value)) || 1);
  return (
    <ul className="bars">
      {shown.map((item) => (
        <li key={item.key} className="bars__row">
          <span className="bars__label" title={item.hint}>
            {item.label}
          </span>
          <span className="bars__track" aria-hidden="true">
            <span className={cx('bars__fill', `bars__fill--${tone}`)} style={{ width: `${Math.min(100, (item.value / top) * 100)}%` }} />
          </span>
          <span className="bars__value">{format(item.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Convierte un `Record<string, number>` en ítems ordenados de mayor a menor. */
export function recordToBars(record: Record<string, number> | undefined, labelOf?: (key: string) => string): BarItem[] {
  if (!record) return [];
  return Object.entries(record)
    .map(([key, value]) => ({ key, label: labelOf ? labelOf(key) : key, value, hint: key }))
    .sort((a, b) => b.value - a.value);
}

export interface ColumnItem {
  key: string;
  label: string;
  value: number;
  title?: string;
}

interface ColumnChartProps {
  items: ColumnItem[];
  format?: (value: number) => string;
  tone?: Tone;
  height?: number;
  emptyText?: string;
  /** Umbral de columna que se pinta en rojo (por ejemplo presupuesto diario). */
  threshold?: number;
}

/** Columnas verticales (series por día/semana). */
export function ColumnChart({ items, format = fmtInt, tone = 'primary', height = 120, emptyText = 'Sin datos.', threshold }: ColumnChartProps) {
  if (items.length === 0) return <Empty text={emptyText} />;
  const top = Math.max(0, ...items.map((item) => item.value), threshold ?? 0) || 1;
  const labelEvery = items.length > 16 ? Math.ceil(items.length / 8) : 1;
  return (
    <div className="columns" style={{ height: height + 28 }}>
      {threshold !== undefined && threshold > 0 && (
        <span className="columns__threshold" style={{ bottom: 28 + (threshold / top) * height }} title={`Umbral: ${format(threshold)}`} />
      )}
      {items.map((item, index) => {
        const over = threshold !== undefined && item.value > threshold;
        return (
          <div key={item.key} className="columns__col" title={item.title ?? `${item.label}: ${format(item.value)}`}>
            <span className="columns__value">{format(item.value)}</span>
            <span
              className={cx('columns__bar', `columns__bar--${over ? 'danger' : tone}`)}
              style={{ height: `${Math.max(2, (item.value / top) * height)}px` }}
            />
            <span className="columns__label">{index % labelEvery === 0 ? item.label : ''}</span>
          </div>
        );
      })}
    </div>
  );
}
