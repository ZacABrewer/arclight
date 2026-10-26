import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { PendingReason, PendingRelease } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { Button, Chip, EmptyState, ErrorBlock, Pane, ProtocolBadge, Table, type ChipTone, type Column } from '../../arclight/index.js';
import { useToast } from '../../components/toast.js';
import { useMovieList, useSeriesList } from '../../hooks/library.js';
import { useGrabPending, usePendingReleases, useRemovePending } from '../../hooks/releases.js';
import { formatDateTime } from '../../lib/format.js';
import { ActivityHeader, formatBytes } from './activity-shared.js';

const REASON_LABELS: Record<PendingReason, string> = {
  delay: 'Delay profile',
  fallback: 'Waiting for preferred protocol',
  downloadClientUnavailable: 'Download client unavailable',
};
const REASON_TONES: Record<PendingReason, ChipTone> = { delay: 'default', fallback: 'neutral', downloadClientUnavailable: 'warn' };

const pad = (n: number) => String(n).padStart(2, '0');

function remaining(eligibleAt: string, now: number): number | null {
  const ms = new Date(eligibleAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.ceil(ms / 1000);
}

/** Time until `eligibleAt` as `1d 02:03:04` / `02:03:04`; "due" once it has passed. */
export function formatCountdown(eligibleAt: string, now: number): string {
  const total = remaining(eligibleAt, now);
  if (total === null) return 'due';
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const clock = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return d > 0 ? `${d}d ${clock}` : clock;
}

/** Compact delay for the table: `3d 7h` beyond a day, `00:42:10` under it, "due" once passed. */
export function formatDelay(eligibleAt: string, now: number): string {
  const total = remaining(eligibleAt, now);
  if (total === null) return 'due';
  const d = Math.floor(total / 86_400);
  if (d > 0) return `${d}d ${Math.floor((total % 86_400) / 3600)}h`;
  return formatCountdown(eligibleAt, now);
}

/** Re-renders every `intervalMs` with the current time. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function MediaCell({ p, seriesTitles, movieTitles }: { p: PendingRelease; seriesTitles: Map<number, string>; movieTitles: Map<number, string> }) {
  if (p.mediaType === 'series' && p.seriesId !== undefined) {
    return (
      <Link className="al-link" to="/library/series/$id" params={{ id: String(p.seriesId) }}>
        {seriesTitles.get(p.seriesId) ?? `Series ${p.seriesId}`}
      </Link>
    );
  }
  if (p.movieId !== undefined) {
    return (
      <Link className="al-link" to="/library/movie/$id" params={{ id: String(p.movieId) }}>
        {movieTitles.get(p.movieId) ?? `Movie ${p.movieId}`}
      </Link>
    );
  }
  return <span className="al-activity-muted">—</span>;
}

/** Mono countdown cell; exported for tests. */
export function DelayCountdown({ eligibleAt, now }: { eligibleAt: string; now: number }) {
  return (
    <time dateTime={eligibleAt} title={formatDateTime(eligibleAt)} className="al-num">
      {formatDelay(eligibleAt, now)}
    </time>
  );
}

export function PendingReleasesPage() {
  const pending = usePendingReleases();
  const grab = useGrabPending();
  const remove = useRemovePending();
  const series = useSeriesList();
  const movies = useMovieList();
  const toast = useToast();
  const now = useNow();

  const seriesTitles = new Map((series.data ?? []).map((s) => [s.id, s.title]));
  const movieTitles = new Map((movies.data ?? []).map((m) => [m.id, m.title]));

  const columns: Column<PendingRelease>[] = [
    {
      key: 'title',
      header: 'Release',
      sortValue: (p) => p.title,
      cell: (p) => (
        <div className="al-activity-title">
          <span className="al-activity-title__main" title={p.title}>
            {p.title}
          </span>
          <span className="al-activity-title__sub">
            <MediaCell p={p} seriesTitles={seriesTitles} movieTitles={movieTitles} />
          </span>
        </div>
      ),
    },
    { key: 'quality', header: 'Quality', mono: true, sortValue: (p) => p.quality.quality.weight, cell: (p) => p.quality.quality.name },
    { key: 'indexer', header: 'Indexer', muted: true, sortValue: (p) => p.indexerName, cell: (p) => p.indexerName },
    { key: 'protocol', header: 'Prot', width: '64px', sortValue: (p) => p.protocol, cell: (p) => <ProtocolBadge protocol={p.protocol} /> },
    { key: 'size', header: 'Size', mono: true, align: 'right', sortValue: (p) => p.size, cell: (p) => formatBytes(p.size) },
    { key: 'reason', header: 'Reason', sortValue: (p) => p.reason, cell: (p) => <Chip tone={REASON_TONES[p.reason]}>{REASON_LABELS[p.reason]}</Chip> },
    {
      key: 'eligible',
      header: 'Grabs in',
      align: 'right',
      mono: true,
      sortValue: (p) => p.eligibleAt,
      cell: (p) => <DelayCountdown eligibleAt={p.eligibleAt} now={now} />,
    },
    {
      key: 'actions',
      header: <span className="al-sr-only">Actions</span>,
      align: 'right',
      cell: (p) => (
        <span className="al-activity-actions">
          <Button
            size="sm"
            variant="secondary"
            loading={grab.isPending && grab.variables?.id === p.id}
            onClick={() => grab.mutate(p, { onSuccess: (r) => toast.push({ tone: 'ok', title: 'Grabbed', message: r.title }) })}
          >
            Grab now
          </Button>
          <Button size="sm" variant="ghost" loading={remove.isPending && remove.variables === p.id} onClick={() => remove.mutate(p.id)} aria-label={`Remove ${p.title}`}>
            Remove
          </Button>
        </span>
      ),
    },
  ];

  return (
    <div className="al-activity">
      <ActivityHeader active="pending" />
      <Pane flush bare className="al-activity-pane">
        {pending.isError ? (
          <div className="al-activity-pad">
            <ErrorBlock title="Couldn't load pending releases" onRetry={() => void pending.refetch()}>
              {errorMessage(pending.error)}
            </ErrorBlock>
          </div>
        ) : (
          <Table
            caption="Pending releases"
            density="rich"
            columns={columns}
            rows={pending.data}
            rowKey={(p) => p.id}
            loading={pending.isPending}
            defaultSort={{ key: 'eligible', direction: 'asc' }}
            empty={<EmptyState title="Nothing pending">Releases held back by a delay profile or an unavailable download client wait here.</EmptyState>}
          />
        )}
      </Pane>
    </div>
  );
}
