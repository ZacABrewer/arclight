import type { ReleaseDecision } from '@arclight/shared';
import type { AudiobookFacts } from '../../../api/audiobook-acquisition.js';
import { positionLabel } from './audiobook-model.js';
import { t } from '../../../i18n/index.js';

// Pure helpers for the audiobook interactive search table.

/** "Jane Doe, John Roe" or null. */
export function narratorsText(f: Pick<AudiobookFacts, 'narrators'>): string | null {
  return f.narrators.length ? f.narrators.join(', ') : null;
}

/** "Book 3" / "Books 1–5", with the series name when the parser read one. */
export function seriesText(f: Pick<AudiobookFacts, 'series' | 'seriesPosition'>): string | null {
  const pos = positionLabel(f.seriesPosition);
  if (f.series && pos) return `${f.series} · ${pos}`;
  return f.series ?? pos;
}

/** "64 kbps" or null. */
export function bitrateText(f: Pick<AudiobookFacts, 'bitrateKbps'>): string | null {
  return f.bitrateKbps !== null ? t('music.search.kbpsValue', { kbps: f.bitrateKbps }) : null;
}

/** Titles of the books a release covers: the matched refs, else the ids resolved through `titles`. */
export function matchedBookTitles(r: Pick<ReleaseDecision, 'books' | 'bookIds'>, titles: ReadonlyMap<number, string>): string[] {
  if (r.books?.length) return r.books.map((b) => b.title);
  return (r.bookIds ?? []).map((id) => titles.get(id) ?? `#${id}`);
}
