import type { MediaChips } from '@arclight/shared';
import { cx } from '../../../arclight/cx.js';
import { useT } from '../../../i18n/index.js';
import { chipLabels } from './chips.js';

// The info line (redesign spec §4.2): year · [boxed rating] · runtime or "N seasons" · genres ·
// chips. Only here (heroes, detail, pause screen), never over a tile. It wraps on phones.

export interface MetaLineProps {
  year?: number | null | undefined;
  /** Boxed rating; falls back to chips.certification. */
  cert?: string | null | undefined;
  runtimeMinutes?: number | null | undefined;
  /** Series: seasons with files ("3 Seasons" in place of the runtime). */
  seasons?: number | null | undefined;
  genres?: readonly string[] | undefined;
  chips?: MediaChips | null | undefined;
  className?: string | undefined;
}

/** "2h 8m", "47m" (the template's left()). */
export function useRuntimeLabel() {
  const t = useT();
  return (minutes: number) => {
    const m = Math.max(1, Math.round(minutes));
    return m >= 60 ? t('player.redesign.duration.hm', { h: Math.floor(m / 60), m: m % 60 }) : t('player.redesign.duration.m', { m });
  };
}

export function MetaLine({ year, cert, runtimeMinutes, seasons, genres, chips, className }: MetaLineProps) {
  const t = useT();
  const runtime = useRuntimeLabel();
  const rating = cert ?? chips?.certification ?? null;
  const labels = chipLabels(chips, t);
  const parts: Array<{ k: string; text: string; kind: 'plain' | 'boxed' | 'chip' }> = [];
  if (year) parts.push({ k: 'year', text: String(year), kind: 'plain' });
  if (rating) parts.push({ k: 'cert', text: rating, kind: 'boxed' });
  if (seasons) parts.push({ k: 'len', text: t('player.redesign.meta.seasons', { count: seasons }), kind: 'plain' });
  else if (runtimeMinutes) parts.push({ k: 'len', text: runtime(runtimeMinutes), kind: 'plain' });
  if (genres && genres.length) parts.push({ k: 'genres', text: genres.join(', '), kind: 'plain' });
  labels.forEach((text, i) => parts.push({ k: `chip-${i}`, text, kind: 'chip' }));
  if (!parts.length) return null;
  return (
    <div className={cx('rd-meta', className)}>
      {parts.map((p) => (
        <span key={p.k} className={p.kind === 'boxed' ? 'rd-meta__cert' : p.kind === 'chip' ? 'rd-meta__chip' : undefined}>
          {p.text}
        </span>
      ))}
    </div>
  );
}
