import { useEffect, type ReactNode } from 'react';
import { PageHeader } from '../../arclight/index.js';

/** System pages share the "10" index; the section tabs (Status, Tasks, …) come from the shell. */
export function SystemHeader({ title, subtitle, actions, children }: { title: string; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · System · Arclight`;
  }, [title]);
  return (
    <PageHeader index="10" title={title} subtitle={subtitle} actions={actions}>
      {children}
    </PageHeader>
  );
}
