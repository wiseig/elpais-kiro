import type { ReactNode } from 'react';
import { cx } from '../cx';

export interface TabItem<K extends string> {
  key: K;
  label: ReactNode;
}

export function Tabs<K extends string>({ items, value, onChange }: { items: TabItem<K>[]; value: K; onChange: (key: K) => void }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={item.key === value}
          className={cx('tabs__tab', item.key === value && 'tabs__tab--active')}
          onClick={() => onChange(item.key)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** Selector de rango en días (1/7/30). */
export function DaysSelector({ value, onChange, options = [1, 7, 30] }: { value: number; onChange: (days: number) => void; options?: number[] }) {
  return (
    <div className="segmented" role="group" aria-label="Rango de días">
      {options.map((days) => (
        <button
          key={days}
          type="button"
          className={cx('segmented__option', days === value && 'segmented__option--active')}
          aria-pressed={days === value}
          onClick={() => onChange(days)}
        >
          {days === 1 ? 'Hoy' : `${days} días`}
        </button>
      ))}
    </div>
  );
}
