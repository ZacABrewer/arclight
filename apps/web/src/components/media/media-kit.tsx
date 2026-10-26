import { useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import type { Episode, Movie, QualityModel, Tag as TagModel } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import {
  ErrorBlock,
  QualityTag,
  Skeleton,
  StatusChip,
  SwitchButton,
  Tag,
  useMediaQuery,
  type StatusKey,
} from '../../arclight/index.js';
import { episodeStatus, type EpisodeStatus } from './episode-status.js';
import './media-kit.css';

// Arclight building blocks shared by the media pages (library, calendar, wanted, discover,
// requests). Thin compositions over src/arclight — no new colours, radii or glows.

export const MOBILE_QUERY = '(max-width: 767.98px)';

/** True below the 768px breakpoint (single column, swipe rows). False in jsdom. */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}

/** Failed query: object + cause + Retry (`.al-error`). */
export function QueryError({ error, onRetry, title = 'Could not load this page' }: { error: unknown; onRetry?: (() => void) | undefined; title?: string }) {
  return (
    <ErrorBlock title={title} onRetry={onRetry}>
      {errorMessage(error)}
    </ErrorBlock>
  );
}

/** Skeleton lines while a query loads. */
export function Loading({ lines = 4, label = 'Loading' }: { lines?: number; label?: string }) {
  return (
    <div className="mk-loading" aria-busy="true" aria-label={label} role="status">
      <Skeleton lines={lines} />
    </div>
  );
}

/** Skeleton poster grid. */
export function PosterSkeletons({ count = 12 }: { count?: number }) {
  return (
    <div className="mk-poster-grid" aria-busy="true" aria-label="Loading" role="status">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} shape="poster" />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ status vocabulary */

export interface ChipStatus {
  status: StatusKey;
  label?: string | undefined;
}

/**
 * Episode state → the kit vocabulary. Queue progress (0–1) wins over the file state;
 * a file below the profile cutoff reads "Cutoff unmet".
 */
export function episodeChip(status: EpisodeStatus, extra: { downloading?: number | null | undefined; cutoffUnmet?: boolean | undefined } = {}): ChipStatus {
  if (extra.downloading != null) return { status: 'downloading', label: `Downloading ${Math.round(extra.downloading * 100)}%` };
  switch (status) {
    case 'downloaded':
      return extra.cutoffUnmet ? { status: 'cutoffUnmet' } : { status: 'downloaded' };
    case 'wanted':
      return { status: 'missing' };
    case 'missing':
      return { status: 'unmonitored' };
    case 'unaired':
      return { status: 'unaired' };
    case 'tba':
      return { status: 'waiting' };
  }
}

export function EpisodeChip({
  episode,
  seriesMonitored = true,
  downloading,
  cutoffUnmet,
}: {
  episode: Pick<Episode, 'hasFile' | 'monitored' | 'airDate' | 'airDateUtc'>;
  seriesMonitored?: boolean;
  downloading?: number | null | undefined;
  cutoffUnmet?: boolean | undefined;
}) {
  const c = episodeChip(episodeStatus(episode, { seriesMonitored }), { downloading, cutoffUnmet });
  return <StatusChip status={c.status} label={c.label} />;
}

/** Movie file state in the kit vocabulary. */
export function movieChip(m: Pick<Movie, 'hasFile' | 'monitored' | 'isAvailable'>, downloading?: number | null): ChipStatus {
  if (downloading != null) return { status: 'downloading', label: `Downloading ${Math.round(downloading * 100)}%` };
  if (m.hasFile) return { status: 'downloaded' };
  if (!m.isAvailable) return { status: 'unaired' };
  return m.monitored ? { status: 'missing' } : { status: 'unmonitored' };
}

/* ------------------------------------------------------------------ small pieces */

/** Small monitor switch (accordion headers, rows, poster cards). */
export function MonitorSwitch({ monitored, onChange, label, disabled }: { monitored: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean | undefined }) {
  // The wrapper keeps the click from reaching a clickable row or card underneath.
  return (
    <span className="mk-switch" onClick={(e) => e.stopPropagation()}>
      <SwitchButton size="sm" checked={monitored} aria-label={label} title={monitored ? 'Monitored' : 'Unmonitored'} disabled={disabled} onChange={onChange} />
    </span>
  );
}

export function qualityName(q: QualityModel | null | undefined): string | null {
  if (!q) return null;
  const rev = q.revision.version > 1 ? (q.revision.isRepack ? ' REPACK' : ' PROPER') : '';
  return `${q.quality.name}${rev}`;
}

export function QualityLabel({ quality }: { quality: QualityModel | null | undefined }) {
  const name = qualityName(quality);
  return name ? <QualityTag>{name}</QualityTag> : <span className="mk-dim">—</span>;
}

export function TagChips({ ids, tags }: { ids: readonly number[]; tags: readonly TagModel[] | undefined }) {
  if (ids.length === 0) return null;
  return (
    <span className="mk-tags">
      {ids.map((id) => (
        <Tag key={id}>{tags?.find((t) => t.id === id)?.label ?? `#${id}`}</Tag>
      ))}
    </span>
  );
}

/** Mono number/size/date span. */
export function Num({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={className ? `al-num ${className}` : 'al-num'}>{children}</span>;
}

/* ------------------------------------------------------------------ swipe rows (mobile) */

export interface SwipeRowProps {
  children: ReactNode;
  /** Swipe left reveals Search (cyan). */
  onSearch?: (() => void) | undefined;
  searchLabel?: string | undefined;
  /** Swipe right reveals Delete (danger). */
  onDelete?: (() => void) | undefined;
  deleteLabel?: string | undefined;
  className?: string | undefined;
}

const SWIPE_OPEN = 88;

/**
 * Mobile row with swipe actions (Page 10): drag left to reveal Search (cyan), drag right to
 * reveal Delete (danger). The actions are real buttons, so keyboard and screen-reader users
 * reach them without swiping (they sit in the tab order behind the row).
 */
export function SwipeRow({ children, onSearch, searchLabel = 'Search', onDelete, deleteLabel = 'Delete', className }: SwipeRowProps) {
  const [offset, setOffset] = useState(0);
  const start = useRef<{ x: number; base: number } | null>(null);
  const clamp = (v: number) => Math.max(onSearch ? -SWIPE_OPEN : 0, Math.min(onDelete ? SWIPE_OPEN : 0, v));
  const onDown = (e: ReactPointerEvent) => {
    if (e.pointerType === 'mouse') return;
    start.current = { x: e.clientX, base: offset };
  };
  const onMove = (e: ReactPointerEvent) => {
    if (!start.current) return;
    setOffset(clamp(start.current.base + e.clientX - start.current.x));
  };
  const onUp = () => {
    if (!start.current) return;
    start.current = null;
    setOffset((o) => (o <= -SWIPE_OPEN / 2 ? -SWIPE_OPEN : o >= SWIPE_OPEN / 2 ? SWIPE_OPEN : 0));
  };
  const close = () => setOffset(0);
  return (
    <div className={className ? `mk-swipe ${className}` : 'mk-swipe'} data-open={offset !== 0 || undefined}>
      {onDelete ? (
        <button type="button" className="mk-swipe__action mk-swipe__action--delete" onClick={() => { close(); onDelete(); }}>
          {deleteLabel}
        </button>
      ) : null}
      {onSearch ? (
        <button type="button" className="mk-swipe__action mk-swipe__action--search" onClick={() => { close(); onSearch(); }}>
          {searchLabel}
        </button>
      ) : null}
      <div
        className="mk-swipe__body"
        style={{ transform: offset ? `translateX(${offset}px)` : undefined }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {children}
      </div>
    </div>
  );
}

/** Copy to clipboard; resolves true when it worked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
