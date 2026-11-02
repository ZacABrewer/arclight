import { describe, expect, it } from 'vitest';
import type { BooksCalendarEntry } from '@arclight/shared';
import { booksToEntry, mergeBooksEntries, type CalendarEntry } from './calendar-math.js';

const now = new Date('2026-06-15T12:00:00Z');
const item = (over: Partial<BooksCalendarEntry>): BooksCalendarEntry =>
  ({ kind: 'ebook', id: 7, parentId: 3, parentTitle: 'Ada Example', title: 'First Light', date: '2026-06-10', hasFile: false, monitored: true, coverUrl: null, ...over }) as BooksCalendarEntry;

describe('book calendar entries', () => {
  it('maps an ebook to its author page', () => {
    const e = booksToEntry(item({}), now);
    expect(e).toMatchObject({ key: 'eb7', kind: 'ebook', title: 'Ada Example', detail: 'First Light', status: 'wanted', books: { kind: 'ebook', id: 7 } });
    expect(e?.link).toEqual({ to: '/library/books/authors/$id', params: { id: '3' } });
  });

  it('maps a comic issue to its series and derives the status', () => {
    expect(booksToEntry(item({ kind: 'comic', id: 9, date: '2026-07-01' }), now)).toMatchObject({ key: 'ci9', status: 'unaired', link: { to: '/library/books/comics/$id' } });
    expect(booksToEntry(item({ hasFile: true }), now)?.status).toBe('downloaded');
    expect(booksToEntry(item({ monitored: false }), now)?.status).toBe('missing');
    expect(booksToEntry(item({ date: 'nope' }), now)).toBeNull();
  });

  it('merges into existing days without changing the input', () => {
    const base = new Map<string, CalendarEntry[]>();
    expect(mergeBooksEntries(base, undefined, now)).toBe(base);
    const merged = mergeBooksEntries(base, [item({}), item({ id: 8, title: 'Second' })], now);
    expect(base.size).toBe(0);
    expect([...merged.values()].flat()).toHaveLength(2);
  });
});
