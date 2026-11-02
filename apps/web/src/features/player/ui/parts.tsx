import { useMemo, useRef, useState, type CSSProperties } from 'react';
import { cx, Mark } from '../../../arclight/index.js';
import { t } from '../../../i18n/index.js';
import { formatClock } from '../format.js';

// Small pieces shared by the mini-player and the now-playing view.

/** Cover art, or a quiet placeholder tile when there is none (or it fails to load). */
export function Artwork({ url, size, className }: { url: string | null | undefined; size?: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  const style: CSSProperties | undefined = size ? { width: size, height: size } : undefined;
  if (!url || broken) {
    return (
      <span className={cx('pl-art', 'pl-art--empty', className)} style={style} aria-hidden="true">
        <Mark size={size ? Math.max(16, Math.round(size * 0.4)) : 40} />
      </span>
    );
  }
  return <img className={cx('pl-art', className)} style={style} src={url} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />;
}

/** A stable pseudo-random bar pattern per item: decoration for the waveform-style seek bar. */
export function barHeights(seed: string, count: number): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    const r = ((h >>> 0) % 1000) / 1000;
    // Softly shaped: louder in the middle, quieter at the ends.
    const envelope = 0.55 + 0.45 * Math.sin((Math.PI * (i + 0.5)) / count);
    out.push(Math.max(0.12, Math.min(1, r * envelope + 0.18)));
  }
  return out;
}

export interface SeekBarProps {
  /** Range shown by the bar (ms on the item timeline). */
  startMs?: number;
  endMs: number;
  positionMs: number;
  onSeek: (ms: number) => void;
  label: string;
  /** Draw the waveform-style bars (music). */
  waveform?: string | null;
  /** Bookmark ticks (ms on the item timeline). */
  marks?: readonly number[];
  className?: string;
  disabled?: boolean;
}

/**
 * Seek bar over a native range input (keyboard and screen readers get a real slider); the
 * value is announced as "1:02 of 3:40". Dragging previews locally and seeks on release.
 */
export function SeekBar({ startMs = 0, endMs, positionMs, onSeek, label, waveform, marks, className, disabled }: SeekBarProps) {
  const [drag, setDrag] = useState<number | null>(null);
  const dragging = useRef(false);
  const span = Math.max(1, endMs - startMs);
  const value = Math.min(endMs, Math.max(startMs, drag ?? positionMs));
  const pct = ((value - startMs) / span) * 100;
  const bars = useMemo(() => (waveform ? barHeights(waveform, 72) : null), [waveform]);
  const commit = (ms: number) => {
    setDrag(null);
    onSeek(ms);
  };
  return (
    <div className={cx('pl-seek', bars && 'pl-seek--wave', className)} style={{ '--pl-p': `${pct}%` } as CSSProperties}>
      {bars ? (
        <div className="pl-seek__bars" aria-hidden="true">
          {bars.map((b, i) => (
            <span key={i} className={cx('pl-seek__bar', (i + 0.5) / bars.length <= pct / 100 && 'is-played')} style={{ height: `${Math.round(b * 100)}%` }} />
          ))}
        </div>
      ) : (
        <div className="pl-seek__track" aria-hidden="true">
          <span className="pl-seek__fill" />
        </div>
      )}
      {marks?.length ? (
        <div className="pl-seek__marks" aria-hidden="true">
          {marks
            .filter((m) => m >= startMs && m <= endMs)
            .map((m) => (
              <span key={m} className="pl-seek__mark" style={{ left: `${((m - startMs) / span) * 100}%` }} />
            ))}
        </div>
      ) : null}
      <input
        type="range"
        className="pl-seek__input"
        min={startMs}
        max={endMs}
        step={1000}
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={t('player.seek.valueText', { position: formatClock(value - startMs), duration: formatClock(span) })}
        onChange={(e) => {
          const v = Number(e.currentTarget.value);
          // Pointer drags preview and seek on release; keyboard steps seek at once.
          if (dragging.current) setDrag(v);
          else commit(v);
        }}
        onPointerDown={() => {
          dragging.current = true;
          setDrag(value);
        }}
        onPointerUp={(e) => {
          dragging.current = false;
          commit(Number(e.currentTarget.value));
        }}
        onPointerCancel={() => {
          dragging.current = false;
          setDrag(null);
        }}
      />
    </div>
  );
}
