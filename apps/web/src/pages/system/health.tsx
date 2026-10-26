import { Badge, toneFor } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { Card } from '../../components/card.js';
import { ErrorView } from '../../components/error-boundary.js';
import { Page } from '../../components/page.js';
import { LoadingBlock } from '../../components/spinner.js';
import { HealthChecksList } from '../../features/health/health-checks.js';
import { useHealth } from '../../hooks/system.js';

export function SystemHealthPage() {
  const health = useHealth();
  return (
    <Page
      title="Health"
      subtitle={health.data ? <Badge tone={toneFor(health.data.status)}>{health.data.status}</Badge> : null}
      actions={
        <Button onClick={() => void health.refetch()} loading={health.isFetching}>
          Re-check
        </Button>
      }
    >
      <Card>
        {health.isPending ? (
          <LoadingBlock />
        ) : health.isError ? (
          <ErrorView error={health.error} onRetry={() => void health.refetch()} />
        ) : (
          <HealthChecksList checks={health.data.checks} showLinks />
        )}
      </Card>
    </Page>
  );
}
