import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AuthorStatistics, BookStatistics } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { audioFiles, bookSeriesEntries, books } from '../../db/schema.js';
import { isReleased } from './monitoring.js';

// Book and author statistics (design 4.4), from the books rows and their `audio_files`.

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type AudiobookDb = Db | Tx;

const percent = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 1000) / 10 : 0);

/** Statistics per book id (every id gets an entry). */
export function bookStatistics(db: AudiobookDb, bookIds: readonly number[]): Map<number, BookStatistics> {
  const out = new Map<number, BookStatistics>();
  for (const id of bookIds) out.set(id, { fileCount: 0, sizeOnDisk: 0, durationMs: null });
  if (bookIds.length === 0) return out;
  const rows = db
    .select({
      bookId: audioFiles.bookId,
      files: sql<number>`count(*)`,
      size: sql<number>`coalesce(sum(${audioFiles.sizeBytes}), 0)`,
      duration: sql<number | null>`sum(${audioFiles.durationMs})`,
    })
    .from(audioFiles)
    .where(and(eq(audioFiles.mediaType, 'audiobook'), inArray(audioFiles.bookId, [...bookIds])))
    .groupBy(audioFiles.bookId)
    .all();
  for (const r of rows) {
    const s = r.bookId !== null ? out.get(r.bookId) : undefined;
    if (!s) continue;
    s.fileCount = Number(r.files);
    s.sizeOnDisk = Number(r.size);
    s.durationMs = r.duration === null ? null : Number(r.duration);
  }
  return out;
}

function emptyAuthor(): AuthorStatistics {
  return {
    bookCount: 0,
    monitoredBookCount: 0,
    availableBookCount: 0,
    missingBookCount: 0,
    fileCount: 0,
    sizeOnDisk: 0,
    seriesCount: 0,
    percentOfBooks: 0,
  };
}

/**
 * Statistics per author id (every id gets an entry), over the books the author owns. A book is
 * available when it has a file; missing when monitored, released and without a file.
 */
export function authorStatistics(db: AudiobookDb, authorIds: readonly number[], now: Date = new Date()): Map<number, AuthorStatistics> {
  const out = new Map<number, AuthorStatistics>();
  for (const id of authorIds) out.set(id, emptyAuthor());
  if (authorIds.length === 0) return out;
  const ids = [...authorIds];
  const bookRows = db
    .select({ id: books.id, authorId: books.authorId, monitored: books.monitored, hasFile: books.hasFile, releaseDate: books.releaseDate })
    .from(books)
    .where(inArray(books.authorId, ids))
    .all();
  const availableMonitored = new Map<number, number>();
  for (const b of bookRows) {
    const s = out.get(b.authorId);
    if (!s) continue;
    s.bookCount++;
    if (b.monitored) s.monitoredBookCount++;
    if (b.hasFile) s.availableBookCount++;
    if (b.monitored && b.hasFile) availableMonitored.set(b.authorId, (availableMonitored.get(b.authorId) ?? 0) + 1);
    if (b.monitored && !b.hasFile && isReleased(b.releaseDate, now)) s.missingBookCount++;
  }
  const files = db
    .select({ authorId: audioFiles.authorId, n: sql<number>`count(*)`, size: sql<number>`coalesce(sum(${audioFiles.sizeBytes}), 0)` })
    .from(audioFiles)
    .where(and(eq(audioFiles.mediaType, 'audiobook'), inArray(audioFiles.authorId, ids)))
    .groupBy(audioFiles.authorId)
    .all();
  for (const f of files) {
    const s = f.authorId !== null ? out.get(f.authorId) : undefined;
    if (!s) continue;
    s.fileCount = Number(f.n);
    s.sizeOnDisk = Number(f.size);
  }
  const series = db
    .select({ authorId: books.authorId, n: sql<number>`count(distinct ${bookSeriesEntries.seriesId})` })
    .from(bookSeriesEntries)
    .innerJoin(books, eq(bookSeriesEntries.bookId, books.id))
    .where(inArray(books.authorId, ids))
    .groupBy(books.authorId)
    .all();
  for (const r of series) {
    const s = out.get(r.authorId);
    if (s) s.seriesCount = Number(r.n);
  }
  for (const [id, s] of out) s.percentOfBooks = percent(availableMonitored.get(id) ?? 0, s.monitoredBookCount);
  return out;
}
