import type { ScheduledJob } from '@media-tron/shared';
import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { ErrorView } from '../../components/error-boundary.js';
import { EmptyState } from '../../components/empty-state.js';
import { Table, type Column } from '../../components/table.js';
import { useRunJob, useScheduledJobs } from '../../hooks/jobs.js';
import { formatDateTime, relativeTime } from '../../lib/format.js';

/** The schedule board with a "Run now" per job. */
export function ScheduledJobsTable() {
  const scheduled = useScheduledJobs();
  const run = useRunJob();

  const columns: Column<ScheduledJob>[] = [
    { key: 'name', header: 'Job', cell: (s) => s.name, sortValue: (s) => s.name },
    { key: 'interval', header: 'Interval', cell: (s) => <code>{s.interval}</code> },
    {
      key: 'enabled',
      header: 'State',
      cell: (s) => (s.enabled ? <Badge tone="ok">enabled</Badge> : <Badge>disabled</Badge>),
      sortValue: (s) => s.enabled,
    },
    {
      key: 'lastRun',
      header: 'Last run',
      cell: (s) => (s.lastRun ? <time dateTime={s.lastRun} title={formatDateTime(s.lastRun)}>{relativeTime(s.lastRun)}</time> : '—'),
      sortValue: (s) => s.lastRun,
    },
    {
      key: 'nextRun',
      header: 'Next run',
      cell: (s) => (s.nextRun ? <time dateTime={s.nextRun} title={formatDateTime(s.nextRun)}>{relativeTime(s.nextRun)}</time> : '—'),
      sortValue: (s) => s.nextRun,
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (s) => (
        <Button size="sm" loading={run.isPending && run.variables === s.name} disabled={run.isPending} onClick={() => run.mutate(s.name)}>
          Run now
        </Button>
      ),
    },
  ];

  if (scheduled.isError) return <ErrorView error={scheduled.error} onRetry={() => void scheduled.refetch()} />;

  return (
    <Table
      caption="Scheduled jobs"
      columns={columns}
      rows={scheduled.data}
      rowKey={(s) => s.name}
      loading={scheduled.isPending}
      defaultSort={{ key: 'name', direction: 'asc' }}
      empty={<EmptyState title="No scheduled jobs" />}
    />
  );
}
