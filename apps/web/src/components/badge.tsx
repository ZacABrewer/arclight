import type { ReactNode } from 'react';
import type { HealthStatus, JobStatus } from '@media-tron/shared';

export type BadgeTone = 'neutral' | 'info' | 'ok' | 'warning' | 'error';

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

const STATUS_TONES: Record<JobStatus | HealthStatus, BadgeTone> = {
  ok: 'ok',
  completed: 'ok',
  warning: 'warning',
  queued: 'info',
  running: 'info',
  error: 'error',
  failed: 'error',
  cancelled: 'neutral',
};

export function toneFor(status: JobStatus | HealthStatus): BadgeTone {
  return STATUS_TONES[status];
}
