import { and, asc, desc, eq, like, ne, not, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import {
  hasAnyPermission,
  Permission,
  rankMatches,
  searchWords,
  TERMINAL_TRACKED_STATES,
  UNIVERSAL_SEARCH_SCAN,
  UniversalSearchKind,
  type AppArea,
  type UniversalSearchHit,
  type UniversalSearchKindResult,
  type UniversalSearchQuery,
  type UniversalSearchResponse,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import {
  albums,
  artists,
  authors,
  books,
  customFormats,
  downloadClients,
  episodes,
  history,
  importLists,
  indexers,
  issues,
  mediaRequests,
  movies,
  notifications,
  qualityProfiles,
  scheduledJobs,
  series,
  tags,
  trackedDownloads,
  users,
} from '../../db/schema.js';

// GET /search/universal: the server-side lookups behind the topbar search, one round trip.
//
// Per kind the caller may see, candidates are read with a cheap SQL prefilter on the longest
// query word, then ranked in JS with the shared matcher (`rankMatches`), so the browser and the
// server agree on the order. The prefilter runs in two passes, each capped so that at most
// UNIVERSAL_SEARCH_SCAN rows are read per kind:
//   1. strict: the column contains the word (`LIKE %word%`): exact, prefix and substring hits;
//   2. loose, only while pass 1 left room: the word's characters in order (`LIKE %w%o%r%d%`),
//      minus the pass 1 rows, which is what the matcher's loose (subsequence) step needs.
// SQLite LIKE folds ASCII case only and the titles are not accent-folded, so a query without
// accents can miss an accented title ("amelie" vs "Amélie"); other query words are not
// prefiltered, the matcher requires them.

/** Who is searching; built from `req.auth` (searchScopeOf) or by tests. */
export interface SearchScope {
  isAdmin: boolean;
  appAccess: readonly AppArea[];
  /** The signed-in user; null for the API key / local bypass. */
  userId: number | null;
  /** Permission bitfield of the user (0 without one). */
  permissions: number;
}

export function searchScopeOf(auth: { isAdmin: boolean; appAccess: readonly AppArea[]; user: { id: number; permissions: number } | null }): SearchScope {
  return { isAdmin: auth.isAdmin, appAccess: auth.appAccess, userId: auth.user?.id ?? null, permissions: auth.user?.permissions ?? 0 };
}

const canLibrary = (s: SearchScope) => s.isAdmin || s.appAccess.includes('library');
const canActivity = (s: SearchScope) => s.isAdmin || s.appAccess.includes('activity');
const adminOnly = (s: SearchScope) => s.isAdmin;
const allRequests = (s: SearchScope) => s.isAdmin || hasAnyPermission(s.permissions, [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW]);
const allIssues = (s: SearchScope) => s.isAdmin || hasAnyPermission(s.permissions, [Permission.MANAGE_ISSUES, Permission.VIEW_ISSUES]);

/** Builds the prefilter over the given columns / expressions. */
type Filter = (cols: Array<SQLiteColumn | SQL>) => SQL;

type HitFields = Omit<UniversalSearchHit, 'kind' | 'score'>;

interface Source<R> {
  visible: (scope: SearchScope) => boolean;
  read: (db: Db, scope: SearchScope, filter: Filter, limit: number) => R[];
  text: (row: R) => string;
  keywords?: (row: R) => readonly string[];
  hit: (row: R) => HitFields;
}

const source = <R>(s: Source<R>): Source<unknown> => s as Source<unknown>;

function image(images: readonly { coverType: string; url: string }[] | null | undefined, ...types: string[]): string | null {
  for (const type of types) {
    const found = images?.find((i) => i.coverType === type && i.url);
    if (found) return found.url;
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const yearText = (year: number | null) => (year ? String(year) : null);
const monitoredStatus = (monitored: boolean) => (monitored ? 'monitored' : 'unmonitored');
const fileStatus = (monitored: boolean, hasFile: boolean) => (hasFile ? 'downloaded' : monitored ? 'missing' : 'unmonitored');
const enabledStatus = (enabled: boolean) => (enabled ? 'enabled' : 'disabled');
const entity = (id: number, title: string, subtitle: string | null, status: string | null): HitFields => ({ id, title, subtitle, poster: null, status, parentId: null });

const SOURCES: Record<UniversalSearchKind, Source<unknown>> = {
  series: source({
    visible: canLibrary,
    read: (db, _s, f, n) =>
      db
        .select({ id: series.id, title: series.title, year: series.year, images: series.images, monitored: series.monitored })
        .from(series)
        .where(f([series.title]))
        .orderBy(asc(series.sortTitle))
        .limit(n)
        .all(),
    text: (r) => r.title,
    hit: (r) => ({ id: r.id, title: r.title, subtitle: yearText(r.year), poster: image(r.images, 'poster'), status: monitoredStatus(r.monitored), parentId: null }),
  }),
  movie: source({
    visible: canLibrary,
    read: (db, _s, f, n) =>
      db
        .select({ id: movies.id, title: movies.title, year: movies.year, images: movies.images, monitored: movies.monitored, hasFile: movies.hasFile })
        .from(movies)
        .where(f([movies.title]))
        .orderBy(asc(movies.sortTitle))
        .limit(n)
        .all(),
    text: (r) => r.title,
    hit: (r) => ({ id: r.id, title: r.title, subtitle: yearText(r.year), poster: image(r.images, 'poster'), status: fileStatus(r.monitored, r.hasFile), parentId: null }),
  }),
  episode: source({
    visible: canLibrary,
    read: (db, _s, f, n) =>
      db
        .select({
          id: episodes.id,
          title: episodes.title,
          seriesId: episodes.seriesId,
          seriesTitle: series.title,
          seasonNumber: episodes.seasonNumber,
          episodeNumber: episodes.episodeNumber,
          monitored: episodes.monitored,
          hasFile: episodes.hasFile,
        })
        .from(episodes)
        .innerJoin(series, eq(series.id, episodes.seriesId))
        .where(and(ne(episodes.title, 'TBA'), f([episodes.title])))
        .orderBy(asc(series.sortTitle), asc(episodes.seasonNumber), asc(episodes.episodeNumber))
        .limit(n)
        .all(),
    text: (r) => r.title,
    hit: (r) => ({
      id: r.id,
      title: r.title,
      subtitle: `${r.seriesTitle} · S${pad(r.seasonNumber)}E${pad(r.episodeNumber)}`,
      poster: null,
      status: fileStatus(r.monitored, r.hasFile),
      parentId: r.seriesId,
    }),
  }),
  artist: source({
    visible: canLibrary,
    read: (db, _s, f, n) =>
      db
        .select({ id: artists.id, name: artists.name, disambiguation: artists.disambiguation, images: artists.images, monitored: artists.monitored })
        .from(artists)
        .where(f([artists.name]))
        .orderBy(asc(artists.sortName))
        .limit(n)
        .all(),
    text: (r) => r.name,
    hit: (r) => ({ id: r.id, title: r.name, subtitle: r.disambiguation || null, poster: image(r.images, 'poster', 'cover'), status: monitoredStatus(r.monitored), parentId: null }),
  }),
  album: source({
    visible: canLibrary,
    read: (db, _s, f, n) =>
      db
        .select({ id: albums.id, title: albums.title, artistId: albums.artistId, artistName: artists.name, images: albums.images, monitored: albums.monitored })
        .from(albums)
        .innerJoin(artists, eq(artists.id, albums.artistId))
        .where(f([albums.title]))
        .orderBy(asc(albums.title))
        .limit(n)
        .all(),
    text: (r) => r.title,
    hit: (r) => ({ id: r.id, title: r.title, subtitle: r.artistName, poster: image(r.images, 'cover'), status: monitoredStatus(r.monitored), parentId: r.artistId }),
  }),
  author: source({
    visible: canLibrary,
    read: (db, _s, f, n) =>
      db
        .select({ id: authors.id, name: authors.name, images: authors.images, monitored: authors.monitored })
        .from(authors)
        .where(f([authors.name]))
        .orderBy(asc(authors.sortName))
        .limit(n)
        .all(),
    text: (r) => r.name,
    hit: (r) => ({ id: r.id, title: r.name, subtitle: null, poster: image(r.images, 'headshot'), status: monitoredStatus(r.monitored), parentId: null }),
  }),
  book: source({
    visible: canLibrary,
    read: (db, _s, f, n) =>
      db
        .select({
          id: books.id,
          title: books.title,
          authorId: books.authorId,
          authorName: authors.name,
          images: books.images,
          monitored: books.monitored,
          hasFile: books.hasFile,
        })
        .from(books)
        .innerJoin(authors, eq(authors.id, books.authorId))
        .where(f([books.title]))
        .orderBy(asc(books.sortTitle))
        .limit(n)
        .all(),
    text: (r) => r.title,
    hit: (r) => ({ id: r.id, title: r.title, subtitle: r.authorName, poster: image(r.images, 'cover'), status: fileStatus(r.monitored, r.hasFile), parentId: r.authorId }),
  }),
  indexer: source({
    visible: adminOnly,
    read: (db, _s, f, n) =>
      db
        .select({
          id: indexers.id,
          name: indexers.name,
          implementation: indexers.implementation,
          rss: indexers.enableRss,
          auto: indexers.enableAutomaticSearch,
          interactive: indexers.enableInteractiveSearch,
        })
        .from(indexers)
        .where(f([indexers.name]))
        .orderBy(asc(indexers.name))
        .limit(n)
        .all(),
    text: (r) => r.name,
    hit: (r) => entity(r.id, r.name, r.implementation, enabledStatus(r.rss || r.auto || r.interactive)),
  }),
  downloadClient: source({
    visible: adminOnly,
    read: (db, _s, f, n) =>
      db
        .select({ id: downloadClients.id, name: downloadClients.name, implementation: downloadClients.implementation, enable: downloadClients.enable })
        .from(downloadClients)
        .where(f([downloadClients.name]))
        .orderBy(asc(downloadClients.name))
        .limit(n)
        .all(),
    text: (r) => r.name,
    hit: (r) => entity(r.id, r.name, r.implementation, enabledStatus(r.enable)),
  }),
  notification: source({
    visible: adminOnly,
    read: (db, _s, f, n) =>
      db
        .select({ id: notifications.id, name: notifications.name, implementation: notifications.implementation, enabled: notifications.enabled })
        .from(notifications)
        .where(f([notifications.name]))
        .orderBy(asc(notifications.name))
        .limit(n)
        .all(),
    text: (r) => r.name,
    hit: (r) => entity(r.id, r.name, r.implementation, enabledStatus(r.enabled)),
  }),
  importList: source({
    visible: adminOnly,
    read: (db, _s, f, n) =>
      db
        .select({ id: importLists.id, name: importLists.name, implementation: importLists.implementation, enabled: importLists.enabled })
        .from(importLists)
        .where(f([importLists.name]))
        .orderBy(asc(importLists.name))
        .limit(n)
        .all(),
    text: (r) => r.name,
    hit: (r) => entity(r.id, r.name, r.implementation, enabledStatus(r.enabled)),
  }),
  qualityProfile: source({
    visible: adminOnly,
    read: (db, _s, f, n) =>
      db
        .select({ id: qualityProfiles.id, name: qualityProfiles.name, domain: qualityProfiles.mediaDomain })
        .from(qualityProfiles)
        .where(f([qualityProfiles.name]))
        .orderBy(asc(qualityProfiles.name))
        .limit(n)
        .all(),
    text: (r) => r.name,
    hit: (r) => entity(r.id, r.name, r.domain, null),
  }),
  customFormat: source({
    visible: adminOnly,
    read: (db, _s, f, n) =>
      db.select({ id: customFormats.id, name: customFormats.name }).from(customFormats).where(f([customFormats.name])).orderBy(asc(customFormats.name)).limit(n).all(),
    text: (r) => r.name,
    hit: (r) => entity(r.id, r.name, null, null),
  }),
  user: source({
    visible: adminOnly,
    read: (db, _s, f, n) =>
      db
        .select({ id: users.id, username: users.username, displayName: users.displayName, role: users.role })
        .from(users)
        // coalesce: a NULL display name must not turn the loose pass's NOT(strict) into NULL.
        .where(f([users.username, sql`coalesce(${users.displayName}, '')`]))
        .orderBy(asc(users.usernameKey))
        .limit(n)
        .all(),
    text: (r) => r.displayName || r.username,
    keywords: (r) => (r.displayName ? [r.username] : []),
    hit: (r) => entity(r.id, r.displayName || r.username, r.displayName ? r.username : r.role, r.role),
  }),
  tag: source({
    visible: adminOnly,
    read: (db, _s, f, n) => db.select({ id: tags.id, label: tags.label }).from(tags).where(f([tags.label])).orderBy(asc(tags.label)).limit(n).all(),
    text: (r) => r.label,
    hit: (r) => entity(r.id, r.label, null, null),
  }),
  task: source({
    visible: adminOnly,
    read: (db, _s, f, n) =>
      db
        .select({ name: scheduledJobs.name, interval: scheduledJobs.interval, enabled: scheduledJobs.enabled })
        .from(scheduledJobs)
        .where(f([scheduledJobs.name]))
        .orderBy(asc(scheduledJobs.name))
        .limit(n)
        .all(),
    text: (r) => r.name,
    hit: (r) => ({ id: r.name, title: r.name, subtitle: r.interval, poster: null, status: enabledStatus(r.enabled), parentId: null }),
  }),
  queue: source({
    visible: canActivity,
    read: (db, _s, f, n) =>
      db
        .select({ id: trackedDownloads.id, title: trackedDownloads.title, state: trackedDownloads.state, clientStatus: trackedDownloads.clientStatus })
        .from(trackedDownloads)
        // Imported / failed / ignored rows are no longer in the queue.
        .where(and(notInArray(trackedDownloads.state, [...TERMINAL_TRACKED_STATES]), f([trackedDownloads.title])))
        .orderBy(desc(trackedDownloads.addedAt))
        .limit(n)
        .all(),
    text: (r) => r.title,
    hit: (r) =>
      entity(r.id, r.title, null, r.state === 'downloading' && r.clientStatus !== 'unknown' && r.clientStatus !== 'downloading' ? r.clientStatus : r.state),
  }),
  history: source({
    visible: canActivity,
    read: (db, _s, f, n) =>
      db
        .select({ id: history.id, sourceTitle: history.sourceTitle, eventType: history.eventType, date: history.date })
        .from(history)
        .where(f([history.sourceTitle]))
        // Most recent first: the candidate cap keeps the newest, and equal scores keep this order.
        .orderBy(desc(history.date), desc(history.id))
        .limit(n)
        .all(),
    text: (r) => r.sourceTitle,
    hit: (r) => entity(r.id, r.sourceTitle, `${r.eventType} · ${r.date.slice(0, 10)}`, r.eventType),
  }),
  request: source({
    visible: (s) => allRequests(s) || s.userId !== null,
    read: (db, s, f, n) =>
      db
        .select({ id: mediaRequests.id, title: mediaRequests.title, type: mediaRequests.type, year: mediaRequests.year, poster: mediaRequests.poster, status: mediaRequests.status })
        .from(mediaRequests)
        .where(and(f([mediaRequests.title]), allRequests(s) ? undefined : eq(mediaRequests.requestedById, s.userId ?? -1)))
        .orderBy(desc(mediaRequests.createdAt), desc(mediaRequests.id))
        .limit(n)
        .all(),
    text: (r) => r.title,
    hit: (r) => ({ id: r.id, title: r.title, subtitle: r.year ? `${r.type} · ${r.year}` : r.type, poster: r.poster, status: r.status, parentId: null }),
  }),
  issue: source({
    visible: (s) => allIssues(s) || s.userId !== null,
    read: (db, s, f, n) =>
      db
        .select({ id: issues.id, title: issues.title, type: issues.type, poster: issues.poster, status: issues.status })
        .from(issues)
        .where(and(f([issues.title]), allIssues(s) ? undefined : eq(issues.createdById, s.userId ?? -1)))
        .orderBy(desc(issues.createdAt), desc(issues.id))
        .limit(n)
        .all(),
    text: (r) => r.title,
    hit: (r) => ({ id: r.id, title: r.title, subtitle: r.type, poster: r.poster, status: r.status, parentId: null }),
  }),
};

/** Strict and loose prefilters on the longest query word (see the header comment). */
function prefilters(words: readonly string[]): { strict: Filter; loose: Filter | null } {
  const word = words.reduce((a, b) => (b.length > a.length ? b : a));
  // Normalized words hold only letters and digits, so no LIKE wildcard needs escaping.
  const strict: Filter = (cols) => or(...cols.map((c) => like(c, `%${word}%`)))!;
  if (word.length < 2) return { strict, loose: null };
  const pattern = `%${[...word].join('%')}%`;
  const loose: Filter = (cols) => and(or(...cols.map((c) => like(c, pattern))), not(strict(cols)))!;
  return { strict, loose };
}

function searchKind(db: Db, scope: SearchScope, kind: UniversalSearchKind, src: Source<unknown>, query: UniversalSearchQuery, filters: ReturnType<typeof prefilters>): UniversalSearchKindResult | null {
  let rows = src.read(db, scope, filters.strict, UNIVERSAL_SEARCH_SCAN);
  if (filters.loose && rows.length < UNIVERSAL_SEARCH_SCAN) {
    rows = rows.concat(src.read(db, scope, filters.loose, UNIVERSAL_SEARCH_SCAN - rows.length));
  }
  const ranked = rankMatches(query.q, rows, src.text, src.keywords);
  if (ranked.length === 0) return null;
  return {
    kind,
    total: ranked.length,
    hits: ranked.slice(0, query.limit).map(({ item, score }) => ({ kind, ...src.hit(item), score })),
  };
}

/** Every kind the scope may see that matched, in UniversalSearchKind order. */
export function universalSearch(db: Db, scope: SearchScope, query: UniversalSearchQuery): UniversalSearchResponse {
  const words = searchWords(query.q);
  if (words.length === 0) return { query: query.q, results: [] };
  const filters = prefilters(words);
  const results: UniversalSearchKindResult[] = [];
  for (const kind of UniversalSearchKind.options) {
    const src = SOURCES[kind];
    if (!src.visible(scope)) continue;
    const result = searchKind(db, scope, kind, src, query, filters);
    if (result) results.push(result);
  }
  return { query: query.q, results };
}
