import type { ReactNode } from 'react';
import { cx } from '../lib/cx.js';

export interface CardProps {
  title?: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** Remove body padding (e.g. for edge-to-edge tables). */
  flush?: boolean;
  children?: ReactNode;
}

export function Card({ title, actions, className, flush = false, children }: CardProps) {
  return (
    <section className={cx('card', className)}>
      {title || actions ? (
        <header className="card-header">
          {title ? <h2 className="card-title">{title}</h2> : <span />}
          {actions ? <div className="card-actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cx('card-body', flush && 'card-body-flush')}>{children}</div>
    </section>
  );
}
