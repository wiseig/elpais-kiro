import type { ReactNode } from 'react';

export function Empty({ text = 'Sin datos para mostrar.', children }: { text?: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      <p>{text}</p>
      {children}
    </div>
  );
}
