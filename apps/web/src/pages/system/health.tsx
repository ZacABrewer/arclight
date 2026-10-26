import type { HealthCheck } from '@arclight/shared';
import { Button, Chip, EmptyState, ErrorBlock, Pane, Skeleton } from '../../arclight/index.js';
import { useHealth } from '../../hooks/system.js';
import { SystemHeader } from './system-header.js';

const ORDER = { error: 0, warning: 1, ok: 2 } as const;

/** One issue row: tone chip, the cause (the check's message), its source and a fix link. */
function IssueRow({ check }: { check: HealthCheck }) {
  return (
    <li className="sys-issue" data-status={check.status}>
      {check.status === 'error' ? <Chip tone="danger">Failed</Chip> : check.status === 'warning' ? <Chip tone="warn">Needs attention</Chip> : <Chip tone="accent">OK</Chip>}
      <div className="sys-issue__text">
        <span className="sys-issue__cause">{check.message}</span>
        <span className="sys-muted">{check.source}</span>
      </div>
      {check.wikiUrl ? (
        <a className="al-link sys-issue__fix" href={check.wikiUrl} target="_blank" rel="noreferrer">
          How to fix
        </a>
      ) : null}
    </li>
  );
}

export function SystemHealthPage() {
  const health = useHealth();
  const checks = [...(health.data?.checks ?? [])].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  const issues = checks.filter((c) => c.status !== 'ok').length;
  return (
    <>
      <SystemHeader
        title="Health"
        subtitle={
          health.data ? (
            issues ? (
              <>
                <span className="al-num">{issues}</span> {issues === 1 ? 'issue' : 'issues'}
              </>
            ) : (
              'Every check passes'
            )
          ) : null
        }
        actions={
          <Button variant="secondary" onClick={() => void health.refetch()} loading={health.isFetching}>
            Run checks
          </Button>
        }
      />
      <Pane title="Checks" flush>
        {health.isPending ? (
          <div className="sys-pad">
            <Skeleton lines={3} />
          </div>
        ) : health.isError ? (
          <div className="sys-pad">
            <ErrorBlock title="Couldn't run health checks" onRetry={() => void health.refetch()} />
          </div>
        ) : checks.length === 0 ? (
          <div className="sys-pad">
            <EmptyState title="No issues">Every health check passes.</EmptyState>
          </div>
        ) : (
          <ul className="sys-issues">
            {checks.map((c) => (
              <IssueRow key={`${c.source}:${c.message}`} check={c} />
            ))}
          </ul>
        )}
      </Pane>
    </>
  );
}
