import type { ReactNode } from 'react';
import { cx } from '../cx';
import type { Tone } from './Chip';

interface CardProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  tone?: Tone;
  id?: string;
}

export function Card({ title, description, actions, children, className, tone, id }: CardProps) {
  return (
    <section className={cx('card', tone && `card--${tone}`, className)} id={id}>
      {(title || actions) && (
        <header className="card__header">
          <div>
            {title && <h2 className="card__title">{title}</h2>}
            {description && <p className="card__description">{description}</p>}
          </div>
          {actions && <div className="card__actions">{actions}</div>}
        </header>
      )}
      <div className="card__body">{children}</div>
    </section>
  );
}
