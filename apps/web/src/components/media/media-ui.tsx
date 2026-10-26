import { useState, type ReactNode } from 'react';
import type { Episode, QualityModel, Tag } from '@arclight/shared';
import { cx } from '../../lib/cx.js';
import { Badge } from '../badge.js';
import { EPISODE_STATUS_META, episodeStatus } from './episode-status.js';
import './media.css';

/** Poster image with a title placeholder when there is no image (or it fails to load). */
export function Poster({ url, title, size = 'md' }: { url?: string | undefined; title: string; size?: 'sm' | 'md' | 'lg' }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={cx('poster', `poster-${size}`)}>
      {url && !failed ? (
        <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <span className="poster-fallback" aria-hidden="true">
          {title}
        </span>
      )}
    </div>
  );
}

export function ProgressBar({ value, total, label }: { value: number; total: number; label?: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
  const tone = total === 0 ? 'empty' : value >= total ? 'complete' : 'partial';
  return (
    <div
      className={cx('progress', `progress-${tone}`)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={value}
      aria-label={label ?? 'Progress'}
      title={`${value} / ${total}`}
    >
      <div className="progress-fill" style={{ width: `${pct}%` }} />
      <span className="progress-text">
        {value} / {total}
      </span>
    </div>
  );
}

/** Bookmark-style monitored toggle. */
export function MonitorToggle({
  monitored,
  onChange,
  disabled = false,
  label,
}: {
  monitored: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  const text = label ?? (monitored ? 'Monitored' : 'Unmonitored');
  return (
    <button
      type="button"
      className={cx('monitor-toggle', monitored && 'monitor-toggle-on')}
      aria-pressed={monitored}
      aria-label={text}
      title={monitored ? 'Monitored: click to unmonitor' : 'Unmonitored: click to monitor'}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!monitored);
      }}
    >
      {monitored ? '★' : '☆'}
    </button>
  );
}

export function EpisodeStatusChip({ episode, seriesMonitored = true }: { episode: Episode; seriesMonitored?: boolean }) {
  const meta = EPISODE_STATUS_META[episodeStatus(episode, { seriesMonitored })];
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export function QualityBadge({ quality }: { quality: QualityModel | null | undefined }) {
  if (!quality) return <span className="muted">—</span>;
  const rev = quality.revision.version > 1 ? (quality.revision.isRepack ? ' REPACK' : ' PROPER') : '';
  return <Badge tone="info">{`${quality.quality.name}${rev}`}</Badge>;
}

export function TagList({ ids, tags }: { ids: readonly number[]; tags: readonly Tag[] | undefined }) {
  if (ids.length === 0) return null;
  return (
    <span className="tag-list">
      {ids.map((id) => (
        <span key={id} className="tag-chip">
          {tags?.find((t) => t.id === id)?.label ?? `#${id}`}
        </span>
      ))}
    </span>
  );
}

/** Label/value pairs for detail headers. */
export function Facts({ items }: { items: ReadonlyArray<[string, ReactNode]> }) {
  return (
    <dl className="facts">
      {items.map(([k, v]) => (
        <div key={k} className="fact">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A disabled button that explains why (feature waiting on a parallel api module). */
export function PendingButton({ children, reason, size = 'sm' }: { children: ReactNode; reason: string; size?: 'sm' | 'md' }) {
  return (
    <button type="button" className={`btn btn-secondary btn-${size}`} disabled title={reason} aria-description={reason}>
      {children}
    </button>
  );
}
