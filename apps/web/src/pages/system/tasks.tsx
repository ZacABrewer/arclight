import type { Job, JobStatus, MediaAnalysisQueueSummary, ScheduledJob } from '@arclight/shared';
import { Link } from '@tanstack/react-router';
import { Button, Chip, EmptyState, ErrorBlock, LiveDot, Pane, Table, type ChipTone, type Column } from '../../arclight/index.js';
import { useAnalysisQueue } from '../../hooks/media-analysis.js';
import { useJobs, useRunJob, useScheduledJobs } from '../../hooks/jobs.js';
import { relativeTime } from '../../lib/format.js';
import { formatSpan, formatStamp } from './format.js';
import { SystemHeader } from './system-header.js';
import './tasks.css';
import { t } from '../../i18n/index.js';

const JOB_TONE: Record<JobStatus, ChipTone> = { queued: 'neutral', running: 'default', completed: 'accent', failed: 'danger', cancelled: 'muted' };
const JOB_LABEL: Record<JobStatus, string> = { get queued() { return t('status.queued'); }, get running() { return t('common.running'); }, get completed() { return t('common.completed'); }, get failed() { return t('status.failed'); }, get cancelled() { return t('system.tasks.cancelled'); } };

/** "Failed · <cause>": failures always say why. */
export function jobStatusLabel(job: Pick<Job, 'status' | 'message'>): string {
  return job.status === 'failed' ? t('system.tasks.failedValue', { value: job.message?.trim() || 'no reason given' }) : JOB_LABEL[job.status];
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
    { key: 'name', header: t('system.tasks.task'), cell: (s) => s.name, sortValue: (s) => s.name },
    { key: 'interval', header: t('common.interval'), mono: true, cell: (s) => s.interval },
    { key: 'enabled', header: t('common.state'), cell: (s) => (s.enabled ? <Chip tone="accent">{t('common.enabled')}</Chip> : <Chip tone="muted">{t('common.disabled')}</Chip>), sortValue: (s) => s.enabled },
    { key: 'lastRun', header: t('system.tasks.lastRun'), mono: true, cell: (s) => <When iso={s.lastRun} />, sortValue: (s) => s.lastRun },
    { key: 'nextRun', header: t('system.tasks.nextRun'), mono: true, cell: (s) => <When iso={s.nextRun} />, sortValue: (s) => s.nextRun },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      cell: (s) => (
        <Button size="sm" variant="secondary" loading={run.isPending && run.variables === s.name} disabled={run.isPending} onClick={() => run.mutate(s.name)}>
          {t('system.tasks.runNow')}
        </Button>
      ),
    },
  ];
  if (scheduled.isError) return <ErrorBlock title={t('system.tasks.couldntLoadScheduledTasks')} onRetry={() => void scheduled.refetch()} />;
  return (
    <Table
      caption={t('system.tasks.scheduledTasks')}
      columns={columns}
      rows={scheduled.data}
      rowKey={(s) => s.name}
      loading={scheduled.isPending}
      defaultSort={{ key: 'name', direction: 'asc' }}
      empty={<EmptyState title={t('system.tasks.noScheduledTasks')} />}
    />
  );
}

function HistoryTable() {
  const jobs = useJobs();
  const columns: Column<Job>[] = [
    { key: 'name', header: t('system.tasks.task'), cell: (j) => j.name, sortValue: (j) => j.name },
    { key: 'status', header: t('common.status'), cell: (j) => <Chip tone={JOB_TONE[j.status]}>{jobStatusLabel(j)}</Chip>, sortValue: (j) => j.status },
    { key: 'trigger', header: t('system.tasks.trigger'), muted: true, cell: (j) => j.trigger.charAt(0).toUpperCase() + j.trigger.slice(1), sortValue: (j) => j.trigger },
    { key: 'queuedAt', header: t('status.queued'), mono: true, cell: (j) => <When iso={j.queuedAt} />, sortValue: (j) => j.queuedAt },
    { key: 'duration', header: t('system.tasks.duration'), mono: true, align: 'right', cell: (j) => formatSpan(j.durationMs), sortValue: (j) => j.durationMs },
    { key: 'message', header: t('system.tasks.message'), muted: true, cell: (j) => (j.status === 'failed' ? '' : (j.message ?? '')) },
  ];
  if (jobs.isError) return <ErrorBlock title={t('system.tasks.couldntLoadTaskHistory')} onRetry={() => void jobs.refetch()} />;
  return <Table caption={t('system.tasks.taskHistory')} columns={columns} rows={jobs.data} rowKey={(j) => j.id} loading={jobs.isPending} empty={<EmptyState title={t('system.tasks.noRunsYet')} />} />;
}

/** "3 pending · 2 running · 1 failed", or "Idle" when nothing waits. */
export function analysisQueueText(q: Pick<MediaAnalysisQueueSummary, 'pending' | 'running' | 'failed'>): string {
  const parts = [q.pending ? `${q.pending} pending` : '', q.running ? `${q.running} running` : '', q.failed ? `${q.failed} failed` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : t('system.tasks.idle');
}

/** Small indicator for the ffprobe analysis queue (AnalyzeMedia job). */
export function AnalysisQueueLine() {
  const queue = useAnalysisQueue();
  if (queue.isPending || queue.isError) return null;
  const q = queue.data;
  const busy = q.running > 0;
  return (
    <section className="sys-analysis" aria-label={t('system.tasks.mediaAnalysisQueue')}>
      <span className="al-label">{t('system.tasks.mediaAnalysis')}</span>
      <span className="sys-analysis__state" role="status">
        {busy ? <LiveDot /> : null}
        <span className="al-num">{analysisQueueText(q)}</span>
      </span>
      {q.ffprobePath ? (
        <span className="al-caption al-num" title={t('system.tasks.ffprobePath')}>
          {t('system.tasks.ffprobepathConcurrencyAtATime', { ffprobePath: q.ffprobePath, concurrency: q.concurrency })}
        </span>
      ) : (
        <span className="sys-analysis__warn">
          {t('system.tasks.ffprobeNotFoundFilesStay')}
          <Link className="al-link" to="/docs/system/health" hash="ffprobe-missing">
            {t('common.fix')}
          </Link>
        </span>
      )}
      {q.recentFailures[0] ? (
        <span className="al-caption sys-analysis__fail" title={q.recentFailures[0].error}>
          {t('system.tasks.lastFailure')} <span className="al-num">{q.recentFailures[0].path ?? t('system.tasks.fileMediafileid', { mediaFileId: q.recentFailures[0].mediaFileId })}</span> · {q.recentFailures[0].error}
        </span>
      ) : null}
    </section>
  );
}

export function SystemTasksPage() {
  return (
    <>
      <SystemHeader title={t('common.tasks')} />
      <div className="sys-stack">
        <AnalysisQueueLine />
        <Pane title={t('system.tasks.scheduled')} flush>
          <ScheduledTable />
        </Pane>
        <Pane title={t('common.history')} flush>
          <HistoryTable />
        </Pane>
      </div>
    </>
  );
}
