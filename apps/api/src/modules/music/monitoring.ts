import type { ArtistStatus, MonitorNewAlbums, MusicMonitorOption } from '@arclight/shared';

// Monitoring rules for albums (design 4.3), pure. Release dates are MusicBrainz dates: full
// (`YYYY-MM-DD`) or partial (`YYYY`, `YYYY-MM`). A partial date counts from the start of its
// period, so an album dated only "2026" counts as released once 2026 begins.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the period a (possibly partial) date names, in ms; null when absent or unreadable. */
export function releaseDateMs(date: string | null | undefined): number | null {
  if (!date) return null;
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(date);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), m[2] ? Number(m[2]) - 1 : 0, m[3] ? Number(m[3]) : 1);
  return Number.isNaN(ms) ? null : ms;
}

/** Released on or before `now`. Undated albums are not known to be released. */
export function isReleased(date: string | null | undefined, now: Date): boolean {
  const ms = releaseDateMs(date);
  return ms !== null && ms <= now.getTime();
}

export interface MonitorCandidate {
  id: number;
  releaseDate: string | null;
  /** At least one track of the album has a file. */
  hasFiles: boolean;
}

/**
 * Which albums a monitor option monitors. `latest` / `first` pick by release date among the
 * released albums (falling back to all albums when none is released yet); `future` keeps
 * albums not yet released, undated ones included.
 */
export function albumsToMonitor(option: MusicMonitorOption, albums: readonly MonitorCandidate[], now: Date): Set<number> {
  const out = new Set<number>();
  const byDate = (pool: readonly MonitorCandidate[], pick: 'latest' | 'first') => {
    const dated = pool.filter((a) => releaseDateMs(a.releaseDate) !== null);
    if (dated.length === 0) return;
    const sorted = [...dated].sort((a, b) => releaseDateMs(a.releaseDate)! - releaseDateMs(b.releaseDate)! || a.id - b.id);
    out.add((pick === 'latest' ? sorted[sorted.length - 1] : sorted[0])!.id);
  };
  switch (option) {
    case 'all':
      for (const a of albums) out.add(a.id);
      break;
    case 'none':
      break;
    case 'future':
      for (const a of albums) if (!isReleased(a.releaseDate, now)) out.add(a.id);
      break;
    case 'missing':
      for (const a of albums) if (!a.hasFiles) out.add(a.id);
      break;
    case 'existing':
      for (const a of albums) if (a.hasFiles) out.add(a.id);
      break;
    case 'latest':
    case 'first': {
      const released = albums.filter((a) => isReleased(a.releaseDate, now));
      byDate(released.length > 0 ? released : albums, option);
      break;
    }
  }
  return out;
}

/** Whether a release group that appeared on refresh starts monitored. */
export function monitorNewAlbum(mode: MonitorNewAlbums, releaseDate: string | null, now: Date): boolean {
  switch (mode) {
    case 'all':
      return true;
    case 'none':
      return false;
    case 'future':
      return !isReleased(releaseDate, now);
  }
}

/**
 * When the artist is due for its next scheduled refresh (design 5.3): one day when an album was
 * released in the last 90 days or is upcoming, seven days for a continuing artist, thirty for an
 * ended one.
 */
export function nextRefreshAt(status: ArtistStatus, releaseDates: ReadonlyArray<string | null>, now: Date): string {
  const t = now.getTime();
  const active = releaseDates.some((d) => {
    const ms = releaseDateMs(d);
    return ms !== null && ms >= t - 90 * DAY_MS;
  });
  const days = active ? 1 : status === 'ended' ? 30 : 7;
  return new Date(t + days * DAY_MS).toISOString();
}
