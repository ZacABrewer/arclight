import { useEffect, type ReactNode } from 'react';

export interface PageProps {
  title: string;
  /** Optional line under the title. */
  subtitle?: ReactNode;
  /** Right-aligned header slot: buttons, filters, view toggles. */
  actions?: ReactNode;
  children?: ReactNode;
}

export function Page({ title, subtitle, actions, children }: PageProps) {
  useEffect(() => {
    document.title = `${title} · Media-Tron`;
  }, [title]);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">{title}</h1>
          {subtitle ? <div className="page-subtitle">{subtitle}</div> : null}
        </div>
        {actions ? <div className="page-actions">{actions}</div> : null}
      </header>
      <div className="page-body">{children}</div>
    </div>
  );
}
