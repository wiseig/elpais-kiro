import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
  actions?: ReactNode;
}

export function PageHeader({ title, description, onRefresh, refreshing = false, actions }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div className="page-header__text">
        <h1 className="page-header__title">{title}</h1>
        {description && <p className="page-header__description">{description}</p>}
      </div>
      <div className="page-header__actions">
        {actions}
        {onRefresh && (
          <button type="button" className="btn" onClick={onRefresh} disabled={refreshing} aria-busy={refreshing}>
            {refreshing ? 'Actualizando…' : 'Actualizar'}
          </button>
        )}
      </div>
    </header>
  );
}
