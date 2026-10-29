import type { AudiobookMonitorOption, MonitorNewBooks } from '@arclight/shared';
import { albumsToMonitor, isReleased, releaseDateMs } from '../music/monitoring.js';

// Monitoring rules for books (design 4.4, 5.3), pure. Release dates are `YYYY-MM-DD` or `YYYY`;
// a partial date counts from the start of its period, like album dates (music/monitoring.ts).

const DAY_MS = 24 * 60 * 60 * 1000;

export { isReleased, releaseDateMs };

export interface BookMonitorCandidate {
  id: number;
  releaseDate: string | null;
  /** The book has at least one file. */
  hasFiles: boolean;
  /** The book belongs to at least one series. */
  inSeries: boolean;
}

/**
 * Which books a monitor option monitors. Everything but `inSeries` follows the album rules
 * (`latest` / `first` by release date among released books, `future` keeps undated books).
 */
export function booksToMonitor(option: AudiobookMonitorOption, books: readonly BookMonitorCandidate[], now: Date): Set<number> {
  if (option === 'inSeries') return new Set(books.filter((b) => b.inSeries).map((b) => b.id));
  return albumsToMonitor(option, books, now);
}

/** Whether a book that appeared on refresh starts monitored. */
export function monitorNewBook(mode: MonitorNewBooks, inSeries: boolean): boolean {
  switch (mode) {
    case 'all':
      return true;
    case 'none':
      return false;
    case 'inSeries':
      return inSeries;
  }
}

/**
 * When the author is due for the next scheduled refresh (design 5.3): one day while a monitored
 * book is still to be released, seven days otherwise.
 */
export function nextAuthorRefreshAt(books: ReadonlyArray<{ releaseDate: string | null; monitored: boolean }>, now: Date): string {
  const t = now.getTime();
  const upcoming = books.some((b) => {
    const ms = releaseDateMs(b.releaseDate);
    return b.monitored && ms !== null && ms > t;
  });
  return new Date(t + (upcoming ? 1 : 7) * DAY_MS).toISOString();
}

/** Numeric sort key of a series position: `3` → 3, `2.5` → 2.5, `1-6` → 1, `Prequel` → null. */
export function positionSortOf(position: string | null | undefined): number | null {
  if (!position) return null;
  const m = /\d+(?:\.\d+)?/.exec(position);
  return m ? Number(m[0]) : null;
}
