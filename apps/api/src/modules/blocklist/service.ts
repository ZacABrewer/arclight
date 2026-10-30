import { and, asc, desc, eq, inArray, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  BlocklistAddRequest,
  QUALITIES,
  type BlocklistAddRequestInput,
  type BlocklistListQuery,
  type BlocklistPage,
  type BlocklistRecord,
  type HistoryCustomFormat,
  type AnyMediaType,
  type MediaType,
  type QualityModel,
  type ReleaseProtocol,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { artists, authors, movies, series } from '../../db/schema.js';
import { dataValue, parseProtocol, type DownloadFailedEvent, type HistoryTarget } from '../history/service.js';
import { episodeListSearchColumns, parentTitleSearchColumns } from '../history/search.js';
import { listSearchCondition } from '../../db/list-search.js';
import { blocklist, type BlocklistRow, type NewBlocklistRow } from './schema.js';

// ---- errors -------------------------------------------------------------------------

export type BlocklistErrorCode = 'NOT_FOUND' | 'VALIDATION';

export class BlocklistError extends Error {
  constructor(
    readonly code: BlocklistErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BlocklistError';
  }
}

export function blocklistHttpStatus(code: BlocklistErrorCode): number {
  return code === 'NOT_FOUND' ? 404 : 400;
}

// ---- public types -------------------------------------------------------------------

/** Entries are scoped to one parent; a release blocked for series A is fine for series B. */
export type BlocklistScope = { seriesId: number } | { movieId: number } | { artistId: number } | { authorId: number };

/** The release fields matching needs. */
export interface BlocklistCandidate {
  title: string;
  protocol: ReleaseProtocol;
  indexer?: string | null;
  torrentInfoHash?: string | null;
  size?: number | null;
  /** ISO-8601. */
  publishedDate?: string | null;
}

/** A queue item (tracked download) being blocklisted directly. */
export interface TrackedBlocklistItem {
  title: string;
  downloadId: string;
  protocol: ReleaseProtocol;
  sizeBytes?: number;
  mediaType?: AnyMediaType;
  seriesId?: number;
  episodeIds?: readonly number[];
  movieId?: number;
  artistId?: number;
  albumIds?: readonly number[];
  authorId?: number;
  bookIds?: readonly number[];
  quality?: QualityModel;
  languages?: readonly string[];
  indexer?: string;
}

/** A pending (delayed, never sent) release being blocklisted from the queue (spec 2.2.2). */
export interface PendingBlocklistRelease {
  title: string;
  protocol: ReleaseProtocol;
  indexerName?: string;
  size?: number;
  publishDate?: string;
  infoHash?: string;
}

export type BlocklistCustomFormatResolver = (record: Omit<BlocklistRecord, 'customFormats'>) => HistoryCustomFormat[];

export interface BlocklistServiceOptions {
  db: Db;
  log: Logger;
  now?: () => Date;
  customFormats?: BlocklistCustomFormatResolver;
}

/** Same-NZB tolerances (spec 2.3.3, unified on the movie rule). */
export const PUBLISH_DATE_TOLERANCE_MS = 2 * 60_000;
export const SIZE_TOLERANCE_BYTES = 2 * 1024 * 1024;

const UNKNOWN_QUALITY: QualityModel = {
  quality: { ...QUALITIES.Unknown, mediaTypes: [...QUALITIES.Unknown.mediaTypes] },
  revision: { version: 1, real: 0, isRepack: false },
};

// ---- matching (pure) ----------------------------------------------------------------

function blank(value: string | null | undefined): boolean {
  return value === undefined || value === null || value.trim() === '';
}

function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return !blank(a) && !blank(b) && a!.trim().toLowerCase() === b!.trim().toLowerCase();
}

function timeOf(value: string | null | undefined): number | undefined {
  if (blank(value)) return undefined;
  const t = new Date(value!).getTime();
  return Number.isNaN(t) ? undefined : t;
}

/**
 * Whether one blocklist row blocks the candidate. Title and hash comparisons use
 * case-insensitive equality rather than upstream's substring match (deliberate deviation).
 */
export function matchesBlocklistEntry(
  entry: Pick<BlocklistRecord, 'sourceTitle' | 'protocol' | 'indexer' | 'torrentInfoHash' | 'size' | 'publishedDate'>,
  candidate: BlocklistCandidate,
): boolean {
  if (candidate.protocol === 'torrent') {
    if (!blank(candidate.torrentInfoHash)) {
      // A hash decides on its own; indexer and title are irrelevant.
      return sameText(entry.torrentInfoHash, candidate.torrentInfoHash);
    }
    if (entry.protocol !== 'torrent' || !sameText(entry.sourceTitle, candidate.title)) return false;
    return blank(entry.indexer) || sameText(entry.indexer, candidate.indexer);
  }

  // Usenet: same NZB, possibly reposted on another indexer.
  if (entry.protocol !== 'usenet' || !sameText(entry.sourceTitle, candidate.title)) return false;
  const entryTime = timeOf(entry.publishedDate);
  const candidateTime = timeOf(candidate.publishedDate);
  if (entryTime !== undefined && candidateTime !== undefined && entryTime === candidateTime) return true;

  const differentIndexer = !sameText(entry.indexer, candidate.indexer);
  const withinTime =
    entryTime === undefined ||
    (candidateTime !== undefined && Math.abs(entryTime - candidateTime) <= PUBLISH_DATE_TOLERANCE_MS);
  const entrySize = entry.size ?? 0;
  const withinSize =
    entrySize === 0 ||
    (candidate.size !== undefined && candidate.size !== null && Math.abs(entrySize - candidate.size) <= SIZE_TOLERANCE_BYTES);
  return differentIndexer && withinTime && withinSize;
}

// ---- service ------------------------------------------------------------------------

export class BlocklistService {
  private readonly db: Db;
  private readonly log: Logger;
  private readonly now: () => Date;
  private readonly resolveFormats: BlocklistCustomFormatResolver | undefined;

  constructor(opts: BlocklistServiceOptions) {
    this.db = opts.db;
    this.log = opts.log;
    this.now = opts.now ?? (() => new Date());
    this.resolveFormats = opts.customFormats;
  }

  // ---- creators ---------------------------------------------------------------------

  add(input: BlocklistAddRequestInput): BlocklistRecord {
    const parsed = BlocklistAddRequest.safeParse(input);
    if (!parsed.success) throw new BlocklistError('VALIDATION', parsed.error.issues.map((i) => i.message).join('; '));
    const r = parsed.data;
    const isSeries = r.mediaType === 'series';
    return this.insertRow({
      mediaType: r.mediaType,
      seriesId: isSeries ? (r.seriesId ?? null) : null,
      episodeIds: isSeries ? [...new Set(r.episodeIds)] : [],
      movieId: isSeries ? null : (r.movieId ?? null),
      ...this.fieldColumns(r),
      releaseType: isSeries && !blank(r.releaseType) ? r.releaseType! : null,
    });
  }

  /** Music entries: scoped to the artist, remembering the albums of the blocked grab. */
  private addMusic(scope: { artistId: number; albumIds: readonly number[] }, fields: BlocklistFields): BlocklistRecord {
    return this.insertRow({
      mediaType: 'music',
      seriesId: null,
      episodeIds: [],
      movieId: null,
      artistId: scope.artistId,
      albumIds: [...new Set(scope.albumIds)],
      ...this.fieldColumns({ ...fields, languages: fields.languages ?? [], indexerFlags: fields.indexerFlags ?? [] }),
      releaseType: null,
    });
  }

  /** Audiobook entries: scoped to the author, remembering the books of the blocked grab. */
  private addAudiobook(scope: { authorId: number; bookIds: readonly number[] }, fields: BlocklistFields): BlocklistRecord {
    return this.insertRow({
      mediaType: 'audiobook',
      seriesId: null,
      episodeIds: [],
      movieId: null,
      authorId: scope.authorId,
      bookIds: [...new Set(scope.bookIds)],
      ...this.fieldColumns({ ...fields, languages: fields.languages ?? [], indexerFlags: fields.indexerFlags ?? [] }),
      releaseType: null,
    });
  }

  /** Video goes through the validated request; music and audiobooks have their own columns. */
  private addFor(target: HistoryTarget, fields: BlocklistFields): BlocklistRecord {
    if (target.mediaType === 'music') return this.addMusic(target, fields);
    if (target.mediaType === 'audiobook') return this.addAudiobook(target, fields);
    return this.add({ ...scopeOf(target), ...fields });
  }

  private fieldColumns(r: BlocklistFields & { languages: readonly string[]; indexerFlags: readonly string[] }) {
    return {
      sourceTitle: r.sourceTitle,
      quality: r.quality,
      languages: [...r.languages],
      date: this.now().toISOString(),
      publishedDate: r.publishedDate ? new Date(r.publishedDate).toISOString() : null,
      size: r.size ?? null,
      protocol: r.protocol,
      indexer: blank(r.indexer) ? null : r.indexer!,
      indexerFlags: [...r.indexerFlags],
      message: r.message ?? null,
      torrentInfoHash: r.protocol === 'torrent' && !blank(r.torrentInfoHash) ? r.torrentInfoHash!.trim().toLowerCase() : null,
      source: blank(r.source) ? null : r.source!,
    };
  }

  private insertRow(values: NewBlocklistRow): BlocklistRecord {
    const row = this.db.insert(blocklist).values(values).returning().get();
    this.log.debug({ id: row.id, title: row.sourceTitle }, 'release blocklisted');
    return this.toRecord(row);
  }

  /** Every download-failed event blocklists the release (spec 2.2.1). */
  addFromFailed(event: DownloadFailedEvent): BlocklistRecord {
    const g = event.grabbedData;
    const tracked = event.tracked ?? undefined;
    const grabbedHash = dataValue(g, 'torrentInfoHash');
    const protocol: ReleaseProtocol =
      parseProtocol(dataValue(g, 'protocol')) ?? tracked?.protocol ?? (grabbedHash ? 'torrent' : 'usenet');
    const hash = tracked?.protocol === 'torrent' ? tracked.downloadId : grabbedHash;
    const size = Number.parseInt(dataValue(g, 'size') ?? '0', 10);
    const published = timeOf(dataValue(g, 'publishedDate'));
    const flags = (dataValue(g, 'indexerFlags') ?? '')
      .split(',')
      .map((f) => f.trim())
      .filter((f) => f !== '');
    return this.addFor(event.target, {
      sourceTitle: event.sourceTitle,
      quality: event.quality,
      languages: [...event.languages],
      publishedDate: published === undefined ? null : new Date(published).toISOString(),
      size: Number.isNaN(size) ? 0 : size,
      protocol,
      indexer: dataValue(g, 'indexer') ?? null,
      indexerFlags: flags,
      message: event.message,
      torrentInfoHash: hash ?? null,
      source: event.source ?? null,
      releaseType: dataValue(g, 'releaseType') ?? null,
    });
  }

  /**
   * Blocklist a tracked download directly, using the grabbed history row's data (if any) for
   * fields the client does not know (published date, indexer, protocol).
   */
  addFromTracked(item: TrackedBlocklistItem, message: string, grabbedData: Record<string, string> = {}): BlocklistRecord {
    const target = trackedTarget(item);
    if (!target) throw new BlocklistError('VALIDATION', `download ${item.downloadId} is not linked to a series, movie, artist or author`);
    const published = timeOf(dataValue(grabbedData, 'publishedDate'));
    return this.addFor(target, {
      sourceTitle: item.title,
      quality: item.quality ?? UNKNOWN_QUALITY,
      languages: [...(item.languages ?? [])],
      publishedDate: published === undefined ? null : new Date(published).toISOString(),
      size: item.sizeBytes ?? null,
      protocol: item.protocol,
      indexer: item.indexer ?? dataValue(grabbedData, 'indexer') ?? null,
      message,
      torrentInfoHash: item.protocol === 'torrent' ? item.downloadId : null,
      releaseType: dataValue(grabbedData, 'releaseType') ?? null,
    });
  }

  /** "Pending release manually blocklisted" (spec 2.2.2). */
  addFromPending(
    target: HistoryTarget,
    release: PendingBlocklistRelease,
    parsed: { quality: QualityModel; languages: readonly string[] },
    source?: string,
  ): BlocklistRecord {
    return this.addFor(target, {
      sourceTitle: release.title,
      quality: parsed.quality,
      languages: [...parsed.languages],
      publishedDate: release.publishDate ? new Date(release.publishDate).toISOString() : null,
      size: release.size ?? null,
      protocol: release.protocol,
      indexer: release.indexerName ?? null,
      message: 'Pending release manually blocklisted',
      torrentInfoHash: release.protocol === 'torrent' ? (release.infoHash ?? null) : null,
      source: source ?? null,
    });
  }

  // ---- matching ---------------------------------------------------------------------

  /** The first blocklist row of this parent that blocks the candidate, or null. */
  findMatch(scope: BlocklistScope, candidate: BlocklistCandidate): BlocklistRecord | null {
    const conds: SQL[] = [scopeCond(scope)];
    if (candidate.protocol === 'torrent' && !blank(candidate.torrentInfoHash)) {
      conds.push(sql`lower(${blocklist.torrentInfoHash}) = ${candidate.torrentInfoHash!.trim().toLowerCase()}`);
    } else {
      conds.push(eq(blocklist.protocol, candidate.protocol));
      conds.push(sql`lower(${blocklist.sourceTitle}) = ${candidate.title.trim().toLowerCase()}`);
    }
    const rows = this.db
      .select()
      .from(blocklist)
      .where(and(...conds))
      .orderBy(desc(blocklist.date), desc(blocklist.id))
      .all();
    const hit = rows.find((r) => matchesBlocklistEntry(r, candidate));
    return hit ? this.toRecord(hit) : null;
  }

  isBlocklisted(scope: BlocklistScope, candidate: BlocklistCandidate): boolean {
    return this.findMatch(scope, candidate) !== null;
  }

  /** Grab-time check once the torrent hash is known (spec 2.3.4). */
  isHashBlocklisted(scope: BlocklistScope, hash: string): boolean {
    if (blank(hash)) return false;
    const row = this.db
      .select({ id: blocklist.id })
      .from(blocklist)
      .where(and(scopeCond(scope), sql`lower(${blocklist.torrentInfoHash}) = ${hash.trim().toLowerCase()}`))
      .limit(1)
      .get();
    return row !== undefined;
  }

  // ---- reads ------------------------------------------------------------------------

  get(id: number): BlocklistRecord | null {
    const row = this.db.select().from(blocklist).where(eq(blocklist.id, id)).get();
    return row ? this.toRecord(row) : null;
  }

  forSeries(seriesId: number): BlocklistRecord[] {
    return this.byScope({ seriesId });
  }

  forMovie(movieId: number): BlocklistRecord[] {
    return this.byScope({ movieId });
  }

  forArtist(artistId: number): BlocklistRecord[] {
    return this.byScope({ artistId });
  }

  forAuthor(authorId: number): BlocklistRecord[] {
    return this.byScope({ authorId });
  }

  list(query: BlocklistListQuery): BlocklistPage {
    const conds: SQL[] = [];
    if (query.mediaType) conds.push(eq(blocklist.mediaType, query.mediaType));
    const parentConds: SQL[] = [];
    if (query.seriesId && query.seriesId.length > 0) parentConds.push(inArray(blocklist.seriesId, query.seriesId));
    if (query.movieId && query.movieId.length > 0) parentConds.push(inArray(blocklist.movieId, query.movieId));
    if (query.artistId && query.artistId.length > 0) parentConds.push(inArray(blocklist.artistId, query.artistId));
    if (query.authorId && query.authorId.length > 0) parentConds.push(inArray(blocklist.authorId, query.authorId));
    if (parentConds.length > 0) conds.push(or(...parentConds)!);
    if (query.protocol && query.protocol.length > 0) conds.push(inArray(blocklist.protocol, query.protocol));
    const search = listSearchCondition(query.q, [
      blocklist.sourceTitle,
      blocklist.indexer,
      blocklist.message,
      blocklist.source,
      ...parentTitleSearchColumns(blocklist),
      ...episodeListSearchColumns(blocklist.episodeIds),
    ]);
    if (search) conds.push(search);
    const where = conds.length > 0 ? and(...conds) : undefined;

    const total = this.db
      .select({ n: sql<number>`count(*)` })
      .from(blocklist)
      .where(where)
      .get();

    const dir = query.sortDirection === 'asc' ? asc : desc;
    const sortExpr: SQL = (() => {
      switch (query.sortKey) {
        case 'indexer':
          return sql`lower(coalesce(${blocklist.indexer}, ''))`;
        case 'sourceTitle':
          return sql`lower(${blocklist.sourceTitle})`;
        case 'title':
          return sql`coalesce(${series.sortTitle}, ${movies.sortTitle}, ${artists.sortName}, ${authors.sortName})`;
        case 'quality':
          return sql`json_extract(${blocklist.quality}, '$.quality.weight')`;
        case 'date':
          return sql`${blocklist.date}`;
      }
    })();

    const rows = this.db
      .select({ b: blocklist })
      .from(blocklist)
      .leftJoin(series, eq(blocklist.seriesId, series.id))
      .leftJoin(movies, eq(blocklist.movieId, movies.id))
      .leftJoin(artists, eq(blocklist.artistId, artists.id))
      .leftJoin(authors, eq(blocklist.authorId, authors.id))
      .where(where)
      .orderBy(dir(sortExpr), dir(blocklist.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .all();

    return {
      page: query.page,
      pageSize: query.pageSize,
      sortKey: query.sortKey,
      sortDirection: query.sortDirection,
      totalRecords: Number(total?.n ?? 0),
      records: rows.map((r) => this.toRecord(r.b)),
    };
  }

  // ---- removal ----------------------------------------------------------------------

  remove(id: number): void {
    const { changes } = this.db.delete(blocklist).where(eq(blocklist.id, id)).run();
    if (changes === 0) throw new BlocklistError('NOT_FOUND', `blocklist item ${id} not found`);
  }

  bulkRemove(ids: readonly number[]): number {
    if (ids.length === 0) return 0;
    return this.db.delete(blocklist).where(inArray(blocklist.id, [...ids])).run().changes;
  }

  /** "Clear blocklist": every entry, every parent. */
  clear(): number {
    return this.db.delete(blocklist).run().changes;
  }

  deleteForParent(mediaType: MediaType, id: number): number {
    return this.db
      .delete(blocklist)
      .where(and(eq(blocklist.mediaType, mediaType), scopeCond(mediaType === 'series' ? { seriesId: id } : { movieId: id })))
      .run().changes;
  }

  /** Housekeeping: drop entries whose parent no longer exists. */
  cleanup(): number {
    let removed = this.db
      .delete(blocklist)
      .where(
        and(
          eq(blocklist.mediaType, 'series'),
          or(
            sql`${blocklist.seriesId} is null`,
            notInArray(blocklist.seriesId, this.db.select({ id: series.id }).from(series)),
          ),
        ),
      )
      .run().changes;
    removed += this.db
      .delete(blocklist)
      .where(
        and(
          eq(blocklist.mediaType, 'movie'),
          or(
            sql`${blocklist.movieId} is null`,
            notInArray(blocklist.movieId, this.db.select({ id: movies.id }).from(movies)),
          ),
        ),
      )
      .run().changes;
    removed += this.db
      .delete(blocklist)
      .where(
        and(
          eq(blocklist.mediaType, 'music'),
          or(sql`${blocklist.artistId} is null`, notInArray(blocklist.artistId, this.db.select({ id: artists.id }).from(artists))),
        ),
      )
      .run().changes;
    removed += this.db
      .delete(blocklist)
      .where(
        and(
          eq(blocklist.mediaType, 'audiobook'),
          or(sql`${blocklist.authorId} is null`, notInArray(blocklist.authorId, this.db.select({ id: authors.id }).from(authors))),
        ),
      )
      .run().changes;
    return removed;
  }

  // ---- internals --------------------------------------------------------------------

  private byScope(scope: BlocklistScope): BlocklistRecord[] {
    return this.db
      .select()
      .from(blocklist)
      .where(scopeCond(scope))
      .orderBy(desc(blocklist.date), desc(blocklist.id))
      .all()
      .map((r) => this.toRecord(r));
  }

  private toRecord(row: BlocklistRow): BlocklistRecord {
    const base: Omit<BlocklistRecord, 'customFormats'> = {
      id: row.id,
      mediaType: row.mediaType,
      seriesId: row.seriesId,
      episodeIds: row.episodeIds,
      movieId: row.movieId,
      sourceTitle: row.sourceTitle,
      quality: row.quality,
      languages: row.languages,
      date: row.date,
      publishedDate: row.publishedDate,
      size: row.size,
      protocol: row.protocol,
      indexer: row.indexer,
      indexerFlags: row.indexerFlags,
      message: row.message,
      torrentInfoHash: row.torrentInfoHash,
      source: row.source,
      releaseType: row.releaseType,
      ...(row.artistId !== null ? { artistId: row.artistId, albumIds: row.albumIds ?? [] } : {}),
      ...(row.authorId !== null ? { authorId: row.authorId, bookIds: row.bookIds ?? [] } : {}),
    };
    return { ...base, customFormats: this.resolveFormats ? this.resolveFormats(base) : [] };
  }
}

function scopeCond(scope: BlocklistScope): SQL {
  if ('seriesId' in scope) return eq(blocklist.seriesId, scope.seriesId);
  if ('movieId' in scope) return eq(blocklist.movieId, scope.movieId);
  return 'artistId' in scope ? eq(blocklist.artistId, scope.artistId) : eq(blocklist.authorId, scope.authorId);
}

/** The release fields of an entry (everything but the parent). */
type BlocklistFields = Omit<BlocklistAddRequestInput, 'mediaType' | 'seriesId' | 'episodeIds' | 'movieId' | 'quality'> & { quality: QualityModel };

function scopeOf(
  target: Exclude<HistoryTarget, { mediaType: 'music' | 'audiobook' }>,
): { mediaType: 'series'; seriesId: number; episodeIds: number[] } | { mediaType: 'movie'; movieId: number } {
  return target.mediaType === 'series'
    ? { mediaType: 'series', seriesId: target.seriesId, episodeIds: [...target.episodeIds] }
    : { mediaType: 'movie', movieId: target.movieId };
}

function trackedTarget(item: TrackedBlocklistItem): HistoryTarget | null {
  if (item.artistId !== undefined && (item.mediaType === undefined || item.mediaType === 'music')) {
    return { mediaType: 'music', artistId: item.artistId, albumIds: [...(item.albumIds ?? [])] };
  }
  if (item.authorId !== undefined && (item.mediaType === undefined || item.mediaType === 'audiobook')) {
    return { mediaType: 'audiobook', authorId: item.authorId, bookIds: [...(item.bookIds ?? [])] };
  }
  if (item.movieId !== undefined && item.mediaType !== 'series') return { mediaType: 'movie', movieId: item.movieId };
  if (item.seriesId !== undefined) {
    return { mediaType: 'series', seriesId: item.seriesId, episodeIds: [...(item.episodeIds ?? [])] };
  }
  return null;
}
