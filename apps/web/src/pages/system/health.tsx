import type { HealthCheck } from '@arclight/shared';
import { Button, Chip, EmptyState, ErrorBlock, Pane, Skeleton } from '../../arclight/index.js';
import { useHealth } from '../../hooks/system.js';
import { SystemHeader } from './system-header.js';
import { t } from '../../i18n/index.js';

const ORDER = { error: 0, warning: 1, ok: 2 } as const;

/** One issue row: tone chip, the cause (the check's message), its source and a fix link. */
function IssueRow({ check }: { check: HealthCheck }) {
  return (
    <li className="sys-issue" data-status={check.status}>
      {check.status === 'error' ? <Chip tone="danger">{t('status.failed')}</Chip> : check.status === 'warning' ? <Chip tone="warn">{t('system.health.needsAttention')}</Chip> : <Chip tone="accent">{t('system.health.ok')}</Chip>}
      <div className="sys-issue__text">
        <span className="sys-issue__cause">{check.message}</span>
        <span className="sys-muted">{check.source}</span>
      </div>
      {check.wikiUrl ? (
        // In-app docs (/docs/system/health#…) open in place; external links in a new tab.
        <a className="al-link sys-issue__fix" href={check.wikiUrl} {...(check.wikiUrl.startsWith('/') ? {} : { target: '_blank', rel: 'noreferrer' })}>
          {t('system.health.howToFix')}
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
        title={t('system.health.health')}
        subtitle={
          health.data ? (
            issues ? (
              <>
                <span className="al-num">{issues}</span> {t('system.health.issues', { issues })}
              </>
            ) : (
              t('system.health.everyCheckPasses')
            )
          ) : null
        }
        actions={
          <Button variant="secondary" onClick={() => void health.refetch()} loading={health.isFetching}>
            {t('system.health.runChecks')}
          </Button>
        }
      />
      <Pane title={t('system.health.checks')} flush>
        {health.isPending ? (
          <div className="sys-pad">
            <Skeleton lines={3} />
          </div>
        ) : health.isError ? (
          <div className="sys-pad">
            <ErrorBlock title={t('system.health.couldntRunHealthChecks')} onRetry={() => void health.refetch()} />
          </div>
        ) : checks.length === 0 ? (
          <div className="sys-pad">
            <EmptyState title={t('system.health.noIssues')}>{t('system.health.everyHealthCheckPasses')}</EmptyState>
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
