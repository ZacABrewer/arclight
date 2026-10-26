import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { TranscodeJob, TranscodeJobStatus, TranscodeJobTrigger } from '@arclight/shared';
import { ApiError, errorMessage } from '../../api/client.js';
import { Button, Chip, EmptyState, ErrorBlock, Meter, PageHeader, Pane, Segmented, Table, Tooltip, type ChipTone, type Column } from '../../arclight/index.js';
import { transcodeKeys, useCancelTranscodeJob, useTranscodeJobs } from '../../hooks/transcode.js';
import { formatDateTime, formatSize, relativeTime } from '../../lib/format.js';
import { PendingApiNotice } from '../settings/shared.js';
import { useDocumentTitle } from './activity-shared.js';
import './activity.css';
import { t } from '../../i18n/index.js';

// Activity -> Transcode jobs: GET /transcode/jobs (newest first), polled every 2 s while a job
// is queued or running. Running jobs show a live Meter; queued and running jobs can be cancelled.

export type JobFilter = 'all' | TranscodeJobStatus;

export function jobStatusLabel(status: TranscodeJobStatus): string {
  switch (status) {
    case 'queued':
      return t('status.queued');
    case 'running':
      return t('common.running');
    case 'completed':
      return t('common.completed');
    case 'failed':
      return t('status.failed');
    case 'cancelled':
      return t('activity.transcode.cancelled');
  }
}

const STATUS_TONES: Record<TranscodeJobStatus, ChipTone> = {
  queued: 'neutral',
  running: 'accent',
  completed: 'default',
  failed: 'danger',
  cancelled: 'muted',
};

export function triggerLabel(trigger: TranscodeJobTrigger): string {
  switch (trigger) {
    case 'manual':
      return t('activity.transcode.manual');
    case 'rule':
      return t('activity.transcode.rule');
    case 'import':
      return t('common.import');
  }
}

export const canCancel = (job: Pick<TranscodeJob, 'status'>) => job.status === 'queued' || job.status === 'running';

/** "4.2 GB -> 1.9 GB (-55%)" once both sizes are known. */
export function sizeChange(job: Pick<TranscodeJob, 'sizeBefore' | 'sizeAfter'>): string {
  if (job.sizeBefore === null) return '—';
  if (job.sizeAfter === null) return formatSize(job.sizeBefore);
  const pct = job.sizeBefore > 0 ? Math.round(((job.sizeAfter - job.sizeBefore) / job.sizeBefore) * 100) : 0;
  return `${formatSize(job.sizeBefore)} → ${formatSize(job.sizeAfter)} (${pct > 0 ? '+' : ''}${pct}%)`;
}

function JobProgress({ job }: { job: TranscodeJob }) {
  const value = job.status === 'completed' ? 100 : Math.max(0, Math.min(100, job.progress));
  if (job.status === 'queued' || job.status === 'cancelled') return <span className="al-caption">—</span>;
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 140 }}>
      <Meter
        value={value}
        live={job.status === 'running'}
        tone={job.status === 'failed' ? 'danger' : 'default'}
        label={t('activity.transcode.progressOf', { path: job.path })}
      />
      <span className="al-num">{Math.round(value)}%</span>
    </span>
  );
}

export function TranscodeJobsPage() {
  useDocumentTitle(t('nav.transcodeJobs'));
  const [filter, setFilter] = useState<JobFilter>('all');
  const jobs = useTranscodeJobs(filter === 'all' ? undefined : filter);
  const cancel = useCancelTranscodeJob();
  const qc = useQueryClient();
  const pending = jobs.error instanceof ApiError && jobs.error.status === 404;

  const columns: Column<TranscodeJob>[] = [
    {
      key: 'path',
      header: t('common.file'),
      cell: (j) =>
        j.command ? (
          <Tooltip content={<span className="al-num">{j.command}</span>}>
            <span tabIndex={0} className="al-num al-activity-break">
              {j.path}
            </span>
          </Tooltip>
        ) : (
          <span className="al-num al-activity-break">{j.path}</span>
        ),
    },
    { key: 'rule', header: t('activity.transcode.rule'), muted: true, cell: (j) => j.ruleName ?? '—' },
    { key: 'trigger', header: t('activity.transcode.trigger'), muted: true, cell: (j) => triggerLabel(j.trigger) },
    { key: 'status', header: t('common.status'), cell: (j) => <Chip tone={STATUS_TONES[j.status]}>{jobStatusLabel(j.status)}</Chip> },
    { key: 'progress', header: t('common.progress'), cell: (j) => <JobProgress job={j} /> },
    { key: 'size', header: t('common.size'), mono: true, cell: (j) => sizeChange(j) },
    { key: 'message', header: t('activity.transcode.message'), muted: true, cell: (j) => j.message ?? '' },
    {
      key: 'queued',
      header: t('activity.transcode.queuedAt'),
      mono: true,
      align: 'right',
      cell: (j) => (
        <time dateTime={j.queuedAt} title={formatDateTime(j.queuedAt)}>
          {relativeTime(j.queuedAt)}
        </time>
      ),
    },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      cell: (j) =>
        canCancel(j) ? (
          <Button
            size="sm"
            variant="danger"
            loading={cancel.isPending && cancel.variables === j.id}
            aria-label={t('activity.transcode.cancelJob', { path: j.path })}
            onClick={() => cancel.mutate(j.id)}
          >
            {t('common.cancel')}
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="al-activity">
      <PageHeader
        index="06"
        title={t('nav.transcodeJobs')}
        actions={
          <Button variant="secondary" onClick={() => void qc.invalidateQueries({ queryKey: transcodeKeys.jobsAll })}>
            {t('common.refresh')}
          </Button>
        }
      >
        <Segmented
          variant="soft"
          aria-label={t('activity.transcode.statusFilter')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('common.all') },
            { value: 'queued', label: t('status.queued') },
            { value: 'running', label: t('common.running') },
            { value: 'completed', label: t('common.completed') },
            { value: 'failed', label: t('status.failed') },
            { value: 'cancelled', label: t('activity.transcode.cancelled') },
          ]}
        />
      </PageHeader>
      <Pane flush bare className="al-activity-pane">
        {pending ? (
          <div className="al-activity-pad">
            <PendingApiNotice what={t('nav.transcodeJobs')} />
          </div>
        ) : jobs.isError ? (
          <div className="al-activity-pad">
            <ErrorBlock title={t('activity.transcode.couldNotLoad')} onRetry={() => void jobs.refetch()}>
              {errorMessage(jobs.error)}
            </ErrorBlock>
          </div>
        ) : (
          <Table
            caption={t('nav.transcodeJobs')}
            columns={columns}
            rows={jobs.data}
            rowKey={(j) => j.id}
            loading={jobs.isPending}
            density="rich"
            sortable={false}
            empty={<EmptyState title={t('activity.transcode.empty')}>{t('activity.transcode.emptyBody')}</EmptyState>}
          />
        )}
      </Pane>
    </div>
  );
}
