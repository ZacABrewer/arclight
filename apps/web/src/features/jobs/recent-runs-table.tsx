import type { Job } from '@media-tron/shared';
import { Badge, toneFor } from '../../components/badge.js';
import { ErrorView } from '../../components/error-boundary.js';
import { EmptyState } from '../../components/empty-state.js';
import { Table, type Column } from '../../components/table.js';
import { useJobs } from '../../hooks/jobs.js';
import { formatDateTime, formatDuration, relativeTime } from '../../lib/format.js';

const columns: Column<Job>[] = [
  { key: 'name', header: 'Job', cell: (j) => j.name, sortValue: (j) => j.name },
  { key: 'status', header: 'Status', cell: (j) => <Badge tone={toneFor(j.status)}>{j.status}</Badge>, sortValue: (j) => j.status },
  { key: 'trigger', header: 'Trigger', cell: (j) => j.trigger, sortValue: (j) => j.trigger },
  {
    key: 'queuedAt',
    header: 'Queued',
    cell: (j) => (
      <time dateTime={j.queuedAt} title={formatDateTime(j.queuedAt)}>
        {relativeTime(j.queuedAt)}
      </time>
    ),
    sortValue: (j) => j.queuedAt,
  },
  { key: 'duration', header: 'Duration', align: 'right', cell: (j) => formatDuration(j.durationMs), sortValue: (j) => j.durationMs },
  { key: 'message', header: 'Message', cell: (j) => <span className="muted">{j.message ?? ''}</span> },
];

/** Recent job runs, newest first; kept live by `job` events. */
export function RecentRunsTable({ limit }: { limit?: number }) {
  const jobs = useJobs();
  if (jobs.isError) return <ErrorView error={jobs.error} onRetry={() => void jobs.refetch()} />;
  const rows = limit && jobs.data ? jobs.data.slice(0, limit) : jobs.data;
  return (
    <Table
      caption="Recent job runs"
      columns={columns}
      rows={rows}
      rowKey={(j) => j.id}
      loading={jobs.isPending}
      empty={<EmptyState title="No runs yet" />}
    />
  );
}
