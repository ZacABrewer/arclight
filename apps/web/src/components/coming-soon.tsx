import { Card } from './card.js';
import { EmptyState } from './empty-state.js';
import { Page } from './page.js';

/** Placeholder for routes whose feature has not been built yet, so navigation is complete. */
export function ComingSoon({ title, phase, children }: { title: string; phase?: string; children?: React.ReactNode }) {
  return (
    <Page title={title}>
      <Card>
        <EmptyState title={`${title} is coming soon`}>
          <p className="muted">
            This page is part of {phase ?? 'a later phase'} of the roadmap. The route is in place so navigation is
            complete.
          </p>
          {children}
        </EmptyState>
      </Card>
    </Page>
  );
}
