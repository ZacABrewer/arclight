import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { PendingReason, PendingRelease } from '@media-tron/shared';
import { Badge, type BadgeTone } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { Card } from '../../components/card.js';
import { EmptyState } from '../../components/empty-state.js';
import { ErrorView } from '../../components/error-boundary.js';
import { Page } from '../../components/page.js';
import { Table, type Column } from '../../components/table.js';
import { useToast } from '../../components/toast.js';
import { useMovieList, useSeriesList } from '../../hooks/library.js';
import { useGrabPending, usePendingReleases, useRemovePending } from '../../hooks/releases.js';
import { formatDateTime } from '../../lib/format.js';
import { formatBytes } from './activity-shared.js';

const REASON_LABELS: Record<PendingReason, string> = {
  delay: 'Delay profile',
  fallback: 'Waiting for preferred protocol',
  downloadClientUnavailable: 'Download client unavailable',
};
const REASON_TONES: Record<PendingReason, BadgeTone> = { delay: 'info', fallback: 'neutral', downloadClientUnavailable: 'warning' };

/** Time until `eligibleAt` as `1d 02:03:04` / `02:03:04`; "due" once it has passed. */
export function formatCountdown(eligibleAt: string, now: number): string {
  const ms = new Date(eligibleAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'due';
  const total = Math.ceil(ms / 1000);
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  const clock = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return d > 0 ? `${d}d ${clock}` : clock;
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
      <Link to="/library/series/$id" params={{ id: String(p.seriesId) }}>
        {seriesTitles.get(p.seriesId) ?? `Series ${p.seriesId}`}
      </Link>
    );
  }
  if (p.movieId !== undefined) {
    return (
      <Link to="/library/movie/$id" params={{ id: String(p.movieId) }}>
        {movieTitles.get(p.movieId) ?? `Movie ${p.movieId}`}
      </Link>
    );
  }
  return <span className="muted">—</span>;
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
    { key: 'title', header: 'Release', sortValue: (p) => p.title, cell: (p) => <span className="break">{p.title}</span> },
    { key: 'media', header: 'Item', cell: (p) => <MediaCell p={p} seriesTitles={seriesTitles} movieTitles={movieTitles} /> },
    { key: 'quality', header: 'Quality', sortValue: (p) => p.quality.quality.weight, cell: (p) => <Badge>{p.quality.quality.name}</Badge> },
    { key: 'indexer', header: 'Indexer', sortValue: (p) => p.indexerName, cell: (p) => p.indexerName },
    { key: 'protocol', header: 'Protocol', sortValue: (p) => p.protocol, cell: (p) => <Badge tone={p.protocol === 'torrent' ? 'info' : 'neutral'}>{p.protocol}</Badge> },
    { key: 'size', header: 'Size', align: 'right', sortValue: (p) => p.size, cell: (p) => formatBytes(p.size) },
    { key: 'reason', header: 'Reason', sortValue: (p) => p.reason, cell: (p) => <Badge tone={REASON_TONES[p.reason]}>{REASON_LABELS[p.reason]}</Badge> },
    {
      key: 'eligible',
      header: 'Grabs in',
      align: 'right',
      sortValue: (p) => p.eligibleAt,
      cell: (p) => (
        <time dateTime={p.eligibleAt} title={formatDateTime(p.eligibleAt)} className="mono">
          {formatCountdown(p.eligibleAt, now)}
        </time>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (p) => (
        <span className="nowrap">
          <Button
            size="sm"
            variant="ghost"
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
    <Page title="Pending releases" subtitle={pending.data ? `${pending.data.length} held back` : null}>
      <Card flush>
        {pending.isError ? (
          <ErrorView error={pending.error} onRetry={() => void pending.refetch()} />
        ) : (
          <Table
            caption="Pending releases"
            columns={columns}
            rows={pending.data}
            rowKey={(p) => p.id}
            loading={pending.isPending}
            defaultSort={{ key: 'eligible', direction: 'asc' }}
            empty={<EmptyState title="Nothing pending">Releases held back by a delay profile or an unavailable download client wait here.</EmptyState>}
          />
        )}
      </Card>
    </Page>
  );
}
