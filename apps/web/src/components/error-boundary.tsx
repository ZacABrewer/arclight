import { Component, type ErrorInfo, type ReactNode } from 'react';
import { errorMessage } from '../api/client.js';
import { Button } from './button.js';

/** Panel shown for a crashed page or a failed route load. */
export function ErrorView({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="error-view" role="alert">
      <h2>Something went wrong</h2>
      <p className="muted">{errorMessage(error)}</p>
      {onRetry ? (
        <Button variant="primary" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

interface State {
  error: unknown;
}

/**
 * Last-resort boundary around the whole app. Route-level render errors are caught earlier
 * by the router's errorComponent so the shell stays usable.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; fallback?: (error: unknown, reset: () => void) => ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    // Surface in the devtools console; there is no client-side log sink yet.
    console.error('Unhandled UI error', error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  override render() {
    if (this.state.error !== null) {
      return this.props.fallback ? this.props.fallback(this.state.error, this.reset) : <ErrorView error={this.state.error} onRetry={this.reset} />;
    }
    return this.props.children;
  }
}
