import { relative } from 'node:path';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import type { AuthorInfo, BookInfo, MediaFileInfo, MediaImage, MediaInfo, NotificationEvent, ReleaseInfo } from '@arclight/notifications';
import type { AudioFile } from '@arclight/shared';
import type { AppContext } from './app.js';
import { authors, books, bookSeries, bookSeriesEntries, downloadClients, tags as tagsTable, trackedDownloads } from './db/schema.js';
import { dataValue, historyServiceFor } from './modules/history/index.js';
import type { AudiobookImportedEvent } from './modules/imports/index.js';
import { releaseFrom } from './modules/notifications/index.js';

// Audiobook imports in the pipeline wiring (wiring.ts re-exports these): one history record and
// one "Author – Title (narrated by X)" notification per imported book. The media-server refresh
// for the book folder goes through `importsDeps(ctx).mediaServers.refreshPath` like music.

/** imports' AudiobookImportedEvent -> history.recordImport with an audiobook target (one record per book). */
export function recordAudiobookImportInHistory(ctx: AppContext, event: AudiobookImportedEvent): void {
  const history = historyServiceFor(ctx);
  const grabbed = event.downloadId ? history.mostRecentForDownloadId(event.downloadId, 'grabbed') : null;
  const downloadClient = grabbed ? dataValue(grabbed.data, 'downloadClient') : undefined;
  const downloadClientName = grabbed ? dataValue(grabbed.data, 'downloadClientName') : undefined;
  const first = event.files[0];
  history.recordImport({
    target: { mediaType: 'audiobook', authorId: event.authorId, bookIds: event.bookIds },
    quality: event.quality,
    languages: [],
    sceneName: event.sourceTitle,
    droppedPath: event.sourcePath,
    importedPath: event.bookFolder,
    ...(first ? { fileId: first.id } : {}),
    downloadId: event.downloadId,
    size: event.files.reduce((n, f) => n + f.sizeBytes, 0),
    ...(first?.releaseGroup ? { releaseGroup: first.releaseGroup } : {}),
    ...(downloadClient ? { downloadClient } : {}),
    ...(downloadClientName ? { downloadClientName } : {}),
    ...(grabbed && grabbed.customFormatScore !== 0 ? { customFormatScore: grabbed.customFormatScore } : {}),
  });
}

const AUTHOR_IMAGE_TYPES: Record<string, MediaImage['coverType'] | undefined> = {
  headshot: 'poster',
  cover: 'poster',
  fanart: 'fanart',
  banner: 'banner',
};

const httpUrl = (img: { url: string; remoteUrl?: string | null | undefined }): string | undefined =>
  /^https?:\/\//.test(img.url) ? img.url : (img.remoteUrl ?? undefined);

/**
 * Notification context of an audiobook item: the author as `MediaInfo` (audiobook headlines read
 * "Author – Title (narrated by X)"), plus author and book details (narrators, primary series and
 * position, runtime). Null when the author is gone. Shared by the audiobook grab and import
 * notifications.
 */
export function audiobookNotificationContext(
  ctx: AppContext,
  authorId: number,
  bookId?: number,
): { media: MediaInfo; author: AuthorInfo; book?: BookInfo } | null {
  const db = ctx.db;
  const author = db.select().from(authors).where(eq(authors.id, authorId)).get();
  if (!author) return null;
  const book = bookId !== undefined ? db.select().from(books).where(eq(books.id, bookId)).get() : undefined;
  const tagLabels = author.tags.length ? db.select().from(tagsTable).where(inArray(tagsTable.id, author.tags)).all().map((t) => t.label) : [];
  // The book cover first (what a reader recognises), then the author's own images.
  const images: MediaImage[] = [];
  const bookCover = book?.images.find((i) => i.coverType === 'cover');
  const coverUrl = bookCover ? httpUrl(bookCover) : undefined;
  if (coverUrl) images.push({ coverType: 'poster', url: coverUrl });
  for (const img of author.images) {
    const coverType = AUTHOR_IMAGE_TYPES[img.coverType];
    const url = httpUrl(img);
    if (coverType && url && !images.some((i) => i.coverType === coverType)) images.push({ coverType, url });
  }
  const media: MediaInfo = {
    id: author.id,
    mediaType: 'audiobook',
    title: author.name,
    year: book?.year ?? 0,
    tmdbId: 0,
    path: author.path,
    ...(author.overview ? { overview: author.overview } : {}),
    genres: author.genres,
    tags: tagLabels,
    images,
  };
  const authorInfo: AuthorInfo = { id: author.id, name: author.name, ...(author.asin ? { asin: author.asin } : {}), path: author.path };
  if (!book) return { media, author: authorInfo };
  const series = db
    .select({ name: bookSeries.name, position: bookSeriesEntries.position })
    .from(bookSeriesEntries)
    .innerJoin(bookSeries, eq(bookSeriesEntries.seriesId, bookSeries.id))
    .where(eq(bookSeriesEntries.bookId, book.id))
    .orderBy(desc(bookSeriesEntries.isPrimary), asc(bookSeriesEntries.positionSort))
    .get();
  const bookInfo: BookInfo = {
    id: book.id,
    title: book.title,
    ...(book.subtitle ? { subtitle: book.subtitle } : {}),
    narrators: book.narrators,
    ...(series ? { seriesTitle: series.name } : {}),
    ...(series?.position ? { seriesPosition: series.position } : {}),
    ...(book.asin ? { asin: book.asin } : {}),
    ...(book.isbn13 ? { isbn: book.isbn13 } : {}),
    ...(book.releaseDate ? { releaseDate: book.releaseDate } : {}),
    ...(book.runtimeMinutes ? { runtimeMs: book.runtimeMinutes * 60_000 } : {}),
    ...(book.path ? { path: book.path } : {}),
  };
  return { media, author: authorInfo, book: bookInfo };
}

function audioFileInfoFrom(file: AudioFile): MediaFileInfo {
  return {
    id: file.id,
    path: file.path,
    relativePath: file.relativePath,
    quality: file.quality.quality.name,
    qualityVersion: file.quality.revision.version,
    ...(file.releaseGroup ? { releaseGroup: file.releaseGroup } : {}),
    size: file.sizeBytes,
    dateAdded: file.dateAdded,
    languages: [],
  };
}

/** An `import` (or `upgrade`) notification for one imported book. */
export function buildAudiobookImportNotification(ctx: AppContext, event: AudiobookImportedEvent): NotificationEvent | null {
  const context = audiobookNotificationContext(ctx, event.authorId, event.bookId);
  const firstFile = event.files[0];
  if (!context || !firstFile) return null;
  const db = ctx.db;
  const authorPath = context.author.path ?? event.bookFolder;
  // The book as one "file": its folder, total size and best quality.
  const file: MediaFileInfo = {
    id: firstFile.id,
    path: event.bookFolder,
    relativePath: relative(authorPath, event.bookFolder),
    quality: event.quality.quality.name,
    qualityVersion: event.quality.revision.version,
    ...(firstFile.releaseGroup ? { releaseGroup: firstFile.releaseGroup } : {}),
    size: event.files.reduce((n, f) => n + f.sizeBytes, 0),
    dateAdded: firstFile.dateAdded,
    languages: [],
    sourcePath: event.sourcePath,
  };
  const tracked = event.downloadId
    ? db
        .select({ row: trackedDownloads, clientName: downloadClients.name, clientType: downloadClients.implementation })
        .from(trackedDownloads)
        .leftJoin(downloadClients, eq(trackedDownloads.clientId, downloadClients.id))
        .where(eq(trackedDownloads.downloadId, event.downloadId))
        .orderBy(desc(trackedDownloads.id))
        .get()
    : undefined;
  const release: ReleaseInfo | undefined = tracked ? releaseFrom(event.sourceTitle, tracked.row.grabbedRelease, tracked.row.size) : undefined;
  const common = {
    instanceName: 'Arclight',
    timestamp: new Date().toISOString(),
    media: context.media,
    author: context.author,
    ...(context.book ? { book: { ...context.book, path: event.bookFolder } } : {}),
    file,
    ...(release ? { release } : {}),
    ...(tracked?.clientName ? { downloadClient: tracked.clientName } : {}),
    ...(tracked?.clientType ? { downloadClientType: tracked.clientType } : {}),
    ...(event.downloadId ? { downloadId: event.downloadId } : {}),
  };
  if (event.isUpgrade && event.replacedFiles.length > 0) {
    return { ...common, type: 'upgrade', oldFiles: event.replacedFiles.map(audioFileInfoFrom) };
  }
  return { ...common, type: 'import' };
}
