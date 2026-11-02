import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import type { SearchRequest } from '@arclight/indexers';
import type { BooksFormat, BooksGrabResult, BooksKind, ReleaseResource } from '@arclight/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import type { GrabRequest, TrackingInfo } from '../download-clients/service.js';
import type { ReleaseDownload, SearchOptions } from '../indexers/service.js';
import { BooksError } from './errors.js';
import { bookGrabs, type BookGrabRow } from './schema.js';

// Sending a book or comic release to a download client (docs/books.md "Downloads"). The
// release goes to the indexer's download client (or the client picked by protocol), with the
// .torrent / .nzb fetched through the indexer like every other grab. Each grab is recorded in
// `book_grabs` by the client's download id; that row is how the import and failure listeners
// recognise a books download, and its failed rows are the books blocklist.

/** What the books module needs of the indexers service (a fake in tests). */
export interface BooksIndexersPort {
  search(request: SearchRequest, opts: SearchOptions): Promise<ReleaseResource[]>;
  downloadRelease(indexerId: number, url: string): Promise<ReleaseDownload>;
  /** The download client the indexer is tied to, or null for "pick by protocol". */
  downloadClientIdOf(indexerId: number): number | null;
}

/** What the books module needs of the download-clients service (a fake in tests). */
export interface BooksDownloadsPort {
  grab(clientId: number | null, request: GrabRequest, tracking: TrackingInfo): Promise<{ downloadId: string; title: string }>;
}

/** Marker in `grabbedRelease`, so other listeners can tell a books download apart. */
export interface BooksGrabbedRelease {
  source: 'books';
  kind: BooksKind;
  targetId: number;
  guid: string;
  indexerId: number;
  title: string;
}

export function isBooksGrabbedRelease(value: unknown): value is BooksGrabbedRelease {
  return typeof value === 'object' && value !== null && (value as { source?: unknown }).source === 'books';
}

type Payload = { magnet: string } | { torrentFile: Uint8Array } | { nzb: Uint8Array };

/** Magnet passthrough, else the .torrent / .nzb through the indexer (magnet fallback for torrents). */
export async function releasePayload(indexers: BooksIndexersPort, release: ReleaseResource): Promise<Payload> {
  if (release.protocol === 'torrent' && release.downloadUrl.startsWith('magnet:')) return { magnet: release.downloadUrl };
  const url = release.downloadUrl || release.magnetUrl;
  if (!url) throw new BooksError('VALIDATION', `${release.title} has no download link`);
  try {
    const result = await indexers.downloadRelease(release.indexerId, url);
    if (result.kind === 'magnet') {
      if (release.protocol === 'usenet') throw new BooksError('UNAVAILABLE', 'the indexer redirected a usenet release to a magnet link');
      return { magnet: result.magnetUrl };
    }
    return release.protocol === 'usenet' ? { nzb: result.data } : { torrentFile: result.data };
  } catch (err) {
    if (release.protocol === 'torrent' && release.magnetUrl) return { magnet: release.magnetUrl };
    if (err instanceof BooksError) throw err;
    throw new BooksError('UNAVAILABLE', `downloading the release failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

export interface GrabInput {
  kind: BooksKind;
  /** Ebook id or comic issue id. */
  targetId: number;
  release: ReleaseResource;
  format: BooksFormat | null;
  releaseGroup: string | null;
  tags?: readonly number[];
}

/** Sends the release to a download client and records the grab. */
export async function grabRelease(
  deps: { db: Db; indexers: BooksIndexersPort; downloads: BooksDownloadsPort; log: Logger; now?: () => Date },
  input: GrabInput,
): Promise<BooksGrabResult> {
  const { release } = input;
  const payload = await releasePayload(deps.indexers, release);
  const marker: BooksGrabbedRelease = { source: 'books', kind: input.kind, targetId: input.targetId, guid: release.guid, indexerId: release.indexerId, title: release.title };
  let tracked: { downloadId: string; title: string };
  try {
    tracked = await deps.downloads.grab(
      deps.indexers.downloadClientIdOf(release.indexerId),
      { title: release.title, protocol: release.protocol, isRecent: release.age <= 14, ...payload, ...(release.size > 0 ? { sizeBytes: release.size } : {}) },
      { grabbedRelease: marker, ...(input.tags && input.tags.length > 0 ? { tags: [...input.tags] } : {}) },
    );
  } catch (err) {
    throw new BooksError('UNAVAILABLE', `the download client did not take the release: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const at = (deps.now?.() ?? new Date()).toISOString();
  deps.db
    .insert(bookGrabs)
    .values({
      kind: input.kind,
      ebookId: input.kind === 'ebook' ? input.targetId : null,
      comicIssueId: input.kind === 'comic' ? input.targetId : null,
      downloadId: tracked.downloadId,
      guid: release.guid,
      indexerId: release.indexerId,
      indexerName: release.indexerName,
      title: release.title,
      protocol: release.protocol,
      sizeBytes: Math.max(0, release.size),
      format: input.format,
      releaseGroup: input.releaseGroup,
      status: 'grabbed',
      grabbedAt: at,
      updatedAt: at,
    })
    .run();
  deps.log.info({ title: release.title, kind: input.kind, target: input.targetId }, 'book release sent to the download client');
  return { title: release.title, downloadId: tracked.downloadId };
}

/** The open grab of a download (status `grabbed`), newest first. */
export function grabForDownload(db: Db, downloadId: string): BookGrabRow | undefined {
  return db.select().from(bookGrabs).where(eq(bookGrabs.downloadId, downloadId)).orderBy(desc(bookGrabs.id)).get();
}

/** A pending grab reached its client: the `pending:` id becomes the client's id. */
export function renameGrabDownloadId(db: Db, pendingId: string, downloadId: string, now: Date = new Date()): void {
  db.update(bookGrabs).set({ downloadId, updatedAt: now.toISOString() }).where(eq(bookGrabs.downloadId, pendingId)).run();
}

export function setGrabStatus(db: Db, downloadId: string, status: BookGrabRow['status'], message: string | null, now: Date = new Date()): void {
  db.update(bookGrabs).set({ status, message, updatedAt: now.toISOString() }).where(eq(bookGrabs.downloadId, downloadId)).run();
}

/** Guids that failed for these targets (or anywhere, when no ids are given). */
export function blockedGuids(db: Db, kind: BooksKind, targetIds?: readonly number[]): Set<string> {
  const column = kind === 'ebook' ? bookGrabs.ebookId : bookGrabs.comicIssueId;
  const where = targetIds && targetIds.length > 0 ? and(eq(bookGrabs.status, 'failed'), inArray(column, [...targetIds])) : eq(bookGrabs.status, 'failed');
  return new Set(db.select({ guid: bookGrabs.guid }).from(bookGrabs).where(where).all().map((r) => r.guid));
}

/** Grabs older than this no longer hold back automatic searches (the download was likely removed). */
export const ACTIVE_GRAB_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** Whether a target has a recent download in flight (grabbed, not yet imported or failed). */
export function hasActiveGrab(db: Db, kind: BooksKind, targetId: number, now: Date = new Date()): boolean {
  const column = kind === 'ebook' ? bookGrabs.ebookId : bookGrabs.comicIssueId;
  const since = new Date(now.getTime() - ACTIVE_GRAB_WINDOW_MS).toISOString();
  return (
    db
      .select({ id: bookGrabs.id })
      .from(bookGrabs)
      .where(and(eq(column, targetId), eq(bookGrabs.status, 'grabbed'), gte(bookGrabs.grabbedAt, since)))
      .limit(1)
      .get() !== undefined
  );
}
