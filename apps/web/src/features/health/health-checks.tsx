import type { HealthCheck } from '@arclight/shared';
import { Badge, toneFor } from '../../components/badge.js';
import { Card } from '../../components/card.js';
import { EmptyState } from '../../components/empty-state.js';
import { LoadingBlock } from '../../components/spinner.js';
import { ErrorView } from '../../components/error-boundary.js';
import { useHealth } from '../../hooks/system.js';

export function HealthChecksList({ checks, showLinks = false }: { checks: readonly HealthCheck[]; showLinks?: boolean }) {
  if (checks.length === 0) return <EmptyState title="No issues">Every health check is passing.</EmptyState>;
  return (
    <ul className="health-list">
      {checks.map((c) => (
        <li key={`${c.source}:${c.message}`} className="health-item">
          <Badge tone={toneFor(c.status)}>{c.status}</Badge>
          <div>
            <strong>{c.source}</strong>
            <div className="muted">{c.message}</div>
            {showLinks && c.wikiUrl ? (
              <a href={c.wikiUrl} target="_blank" rel="noreferrer">
                More info
              </a>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Dashboard card: overall status + current checks, kept live by the `health` event. */
export function HealthCard() {
  const health = useHealth();
  return (
    <Card
      title={
        <>
          Health{' '}
          {health.data ? <Badge tone={toneFor(health.data.status)}>{health.data.status}</Badge> : null}
        </>
      }
    >
      {health.isPending ? (
        <LoadingBlock />
      ) : health.isError ? (
        <ErrorView error={health.error} onRetry={() => void health.refetch()} />
      ) : (
        <HealthChecksList checks={health.data.checks} />
      )}
    </Card>
  );
}
