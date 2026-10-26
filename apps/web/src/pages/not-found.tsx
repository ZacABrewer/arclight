import { Link } from '@tanstack/react-router';
import { Card } from '../components/card.js';
import { EmptyState } from '../components/empty-state.js';
import { Page } from '../components/page.js';

export function NotFoundPage() {
  return (
    <Page title="Not found">
      <Card>
        <EmptyState
          title="There is nothing at this address"
          action={
            <Link to="/" className="btn btn-primary btn-md">
              Back to the dashboard
            </Link>
          }
        >
          <p className="muted">
            <code>{typeof location === 'undefined' ? '' : location.pathname}</code>
          </p>
        </EmptyState>
      </Card>
    </Page>
  );
}
