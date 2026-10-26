import type { Job, JobStatus, ScheduledJob } from '@arclight/shared';
import { Button, Chip, EmptyState, ErrorBlock, Pane, Table, type ChipTone, type Column } from '../../arclight/index.js';
import { useJobs, useRunJob, useScheduledJobs } from '../../hooks/jobs.js';
import { relativeTime } from '../../lib/format.js';
import { formatSpan, formatStamp } from './format.js';
import { SystemHeader } from './system-header.js';

const JOB_TONE: Record<JobStatus, ChipTone> = { queued: 'neutral', running: 'default', completed: 'accent', failed: 'danger', cancelled: 'muted' };
const JOB_LABEL: Record<JobStatus, string> = { queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' };

/** "Failed · <cause>": failures always say why. */
export function jobStatusLabel(job: Pick<Job, 'status' | 'message'>): string {
  return job.status === 'failed' ? `Failed · ${job.message?.trim() || 'no reason given'}` : JOB_LABEL[job.status];
}

function When({ iso }: { iso: string | null }) {
  if (!iso) return <span className="sys-muted">—</span>;
  return (
    <time dateTime={iso} title={formatStamp(iso)}>
      {relativeTime(iso)}
    </time>
  );
}

function ScheduledTable() {
  const scheduled = useScheduledJobs();
  const run = useRunJob();
  const columns: Column<ScheduledJob>[] = [
    { key: 'name', header: 'Task', cell: (s) => s.name, sortValue: (s) => s.name },
    { key: 'interval', header: 'Interval', mono: true, cell: (s) => s.interval },
    { key: 'enabled', header: 'State', cell: (s) => (s.enabled ? <Chip tone="accent">Enabled</Chip> : <Chip tone="muted">Disabled</Chip>), sortValue: (s) => s.enabled },
    { key: 'lastRun', header: 'Last run', mono: true, cell: (s) => <When iso={s.lastRun} />, sortValue: (s) => s.lastRun },
    { key: 'nextRun', header: 'Next run', mono: true, cell: (s) => <When iso={s.nextRun} />, sortValue: (s) => s.nextRun },
    {
      key: 'actions',
      header: <span className="al-sr-only">Actions</span>,
      align: 'right',
      cell: (s) => (
        <Button size="sm" variant="secondary" loading={run.isPending && run.variables === s.name} disabled={run.isPending} onClick={() => run.mutate(s.name)}>
          Run now
        </Button>
      ),
    },
  ];
  if (scheduled.isError) return <ErrorBlock title="Couldn't load scheduled tasks" onRetry={() => void scheduled.refetch()} />;
  return (
    <Table
      caption="Scheduled tasks"
      columns={columns}
      rows={scheduled.data}
      rowKey={(s) => s.name}
      loading={scheduled.isPending}
      defaultSort={{ key: 'name', direction: 'asc' }}
      empty={<EmptyState title="No scheduled tasks" />}
    />
  );
}

function HistoryTable() {
  const jobs = useJobs();
  const columns: Column<Job>[] = [
    { key: 'name', header: 'Task', cell: (j) => j.name, sortValue: (j) => j.name },
    { key: 'status', header: 'Status', cell: (j) => <Chip tone={JOB_TONE[j.status]}>{jobStatusLabel(j)}</Chip>, sortValue: (j) => j.status },
    { key: 'trigger', header: 'Trigger', muted: true, cell: (j) => j.trigger.charAt(0).toUpperCase() + j.trigger.slice(1), sortValue: (j) => j.trigger },
    { key: 'queuedAt', header: 'Queued', mono: true, cell: (j) => <When iso={j.queuedAt} />, sortValue: (j) => j.queuedAt },
    { key: 'duration', header: 'Duration', mono: true, align: 'right', cell: (j) => formatSpan(j.durationMs), sortValue: (j) => j.durationMs },
    { key: 'message', header: 'Message', muted: true, cell: (j) => (j.status === 'failed' ? '' : (j.message ?? '')) },
  ];
  if (jobs.isError) return <ErrorBlock title="Couldn't load task history" onRetry={() => void jobs.refetch()} />;
  return <Table caption="Task history" columns={columns} rows={jobs.data} rowKey={(j) => j.id} loading={jobs.isPending} empty={<EmptyState title="No runs yet" />} />;
}

export function SystemTasksPage() {
  return (
    <>
      <SystemHeader title="Tasks" />
      <div className="sys-stack">
        <Pane title="Scheduled" flush>
          <ScheduledTable />
        </Pane>
        <Pane title="History" flush>
          <HistoryTable />
        </Pane>
      </div>
    </>
  );
}
