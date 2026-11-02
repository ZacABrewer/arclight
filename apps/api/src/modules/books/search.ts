import { eq } from 'drizzle-orm';
import type { SearchRequest } from '@arclight/indexers';
import { parseComicRelease, parseEbookRelease, bookTitleKey } from '@arclight/parser';
import { BooksGrabRequest, type BooksKind, type BooksRelease, type BooksGrabResult, type ReleaseResource } from '@arclight/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import { getSection } from '../settings/service.js';
import { parseBody } from './catalog.js';
import { evaluateComicRelease, evaluateEbookRelease, rankDecisions, type Decision, type DecisionContext } from './decision.js';
import { BooksError } from './errors.js';
import { blockedGuids, grabRelease, hasActiveGrab, type BooksDownloadsPort, type BooksIndexersPort } from './grab.js';
import { authorRow, comicSeriesRow, ebookRow, issueRow, markSearched, wantedItems } from './library.js';
import { formatProfileRow } from './profiles.js';
import { bookFiles, comicIssues, comicSeries } from './schema.js';

// Searching indexers for wanted ebooks and comic issues (docs/books.md "Searching"):
//
//   - interactive: every release for one item with the decision's verdict (Search tab);
//   - automatic: the best approved release for an item is grabbed (search on add, commands,
//     the missing search job, approved requests);
//   - RSS: each RSS sync's releases are matched to wanted items and the best one grabbed.
//
// Ebooks use the indexers' book search (author + title), which falls back to free text on
// indexers without it; comics use free text ("Series 54" and "Series 054"). Categories come
// from the `books.search` settings. Interactive results are kept in memory per item so a grab
// can name a release by guid.

const HOUR_MS = 60 * 60 * 1000;
/** Items one missing-search run looks at, at most. */
const MISSING_SEARCH_LIMIT = 50;
/** Interactive results kept per item. */
const CACHE_TTL_MS = 30 * 60 * 1000;

interface Target {
  kind: BooksKind;
  id: number;
  tags: number[];
  requests: SearchRequest[];
  categories: number[];
  evaluate(release: ReleaseResource, ctx: DecisionContext): Decision;
  ctx: DecisionContext;
}

function releaseFacts(r: ReleaseResource) {
  return { guid: r.guid, title: r.title, sizeBytes: r.size, protocol: r.protocol, seeders: r.seeders ?? null };
}

function toBooksRelease(r: ReleaseResource, d: Decision): BooksRelease {
  return {
    guid: r.guid,
    indexerId: r.indexerId,
    indexer: r.indexerName,
    title: r.title,
    sizeBytes: r.size,
    protocol: r.protocol,
    seeders: r.seeders ?? null,
    publishDate: r.publishDate,
    categories: r.categories,
    format: d.format,
    releaseGroup: d.releaseGroup,
    approved: d.approved,
    rejections: d.rejections,
    score: d.score,
  };
}

export class BooksSearchService {
  private readonly cache = new Map<string, { at: number; releases: ReleaseResource[] }>();

  constructor(
    private readonly deps: {
      db: Db;
      log: Logger;
      indexers: () => BooksIndexersPort;
      downloads: () => BooksDownloadsPort;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private settings() {
    return getSection(this.deps.db, 'books');
  }

  /** Everything the engine needs to judge releases for one item. */
  target(kind: BooksKind, id: number): Target {
    const db = this.deps.db;
    const settings = this.settings();
    if (kind === 'ebook') {
      const book = ebookRow(db, id);
      const author = authorRow(db, book.authorId);
      const profile = formatProfileRow(db, author.formatProfileId);
      const file = db.select({ format: bookFiles.format }).from(bookFiles).where(eq(bookFiles.ebookId, id)).get();
      const facts = { title: book.title, subtitle: book.subtitle, authorName: author.name, isbns: [...new Set([...(book.isbn13 ? [book.isbn13] : []), ...book.isbns])], existingFormat: file?.format ?? null };
      return {
        kind,
        id,
        tags: author.tags,
        requests: [{ kind: 'book', author: author.name, title: book.title }],
        categories: settings.search.ebookCategories,
        ctx: { profile, blockedGuids: blockedGuids(db, 'ebook', [id]), languages: settings.metadata.languages },
        evaluate: (r, ctx) => evaluateEbookRelease(releaseFacts(r), facts, ctx),
      };
    }
    const issue = issueRow(db, id);
    const series = comicSeriesRow(db, issue.seriesId);
    const profile = formatProfileRow(db, series.formatProfileId);
    const file = db.select({ format: bookFiles.format }).from(bookFiles).where(eq(bookFiles.comicIssueId, id)).get();
    const facts = { seriesTitle: series.title, startYear: series.startYear, issueNumber: issue.issueNumber, seriesType: series.seriesType, existingFormat: file?.format ?? null };
    const queries = new Set([`${series.title} ${issue.issueNumber}`]);
    if (/^\d{1,2}$/.test(issue.issueNumber)) queries.add(`${series.title} ${issue.issueNumber.padStart(3, '0')}`);
    return {
      kind,
      id,
      tags: series.tags,
      requests: [...queries].map((query) => ({ kind: 'search' as const, query })),
      categories: settings.search.comicCategories,
      ctx: { profile, blockedGuids: blockedGuids(db, 'comic', [id]) },
      evaluate: (r, ctx) => evaluateComicRelease(releaseFacts(r), facts, ctx),
    };
  }

  private async fetchReleases(target: Target, mode: 'automatic' | 'interactive'): Promise<ReleaseResource[]> {
    const indexers = this.deps.indexers();
    const seen = new Map<string, ReleaseResource>();
    for (const request of target.requests) {
      const found = await indexers.search(request, { mode, ...(target.categories.length > 0 ? { categories: target.categories } : {}) });
      for (const r of found) {
        const key = `${r.indexerId}:${r.guid}`;
        if (!seen.has(key)) seen.set(key, r);
      }
    }
    return [...seen.values()];
  }

  /** Every release for one item with the decision's verdict, best first. */
  async interactive(kind: BooksKind, id: number): Promise<BooksRelease[]> {
    const target = this.target(kind, id);
    const releases = await this.fetchReleases(target, 'interactive');
    this.cache.set(`${kind}:${id}`, { at: this.now().getTime(), releases });
    markSearched(this.deps.db, kind, [id], this.now());
    return rankDecisions(releases.map((r) => ({ ...toBooksRelease(r, target.evaluate(r, target.ctx)), publishDate: r.publishDate })));
  }

  /** Grabs a release from the item's last interactive search (`force` skips the verdict). */
  async grab(raw: BooksGrabRequest): Promise<BooksGrabResult> {
    const req = parseBody(BooksGrabRequest, raw);
    const cached = this.cache.get(`${req.kind}:${req.id}`);
    const release = cached && this.now().getTime() - cached.at < CACHE_TTL_MS ? cached.releases.find((r) => r.guid === req.guid && r.indexerId === req.indexerId) : undefined;
    if (!release) throw new BooksError('NOT_FOUND', 'release not found; search again');
    const target = this.target(req.kind, req.id);
    const decision = target.evaluate(release, target.ctx);
    if (!decision.approved && !req.force) throw new BooksError('CONFLICT', `release rejected: ${decision.rejections.join('; ')}`);
    return this.send(target, release, decision);
  }

  private send(target: Target, release: ReleaseResource, decision: Decision): Promise<BooksGrabResult> {
    return grabRelease(
      { db: this.deps.db, indexers: this.deps.indexers(), downloads: this.deps.downloads(), log: this.deps.log, now: () => this.now() },
      { kind: target.kind, targetId: target.id, release, format: decision.format, releaseGroup: decision.releaseGroup, tags: target.tags },
    );
  }

  /** Searches one item and grabs the best approved release; null when nothing qualified. */
  async searchAndGrab(kind: BooksKind, id: number): Promise<BooksGrabResult | null> {
    if (hasActiveGrab(this.deps.db, kind, id, this.now())) return null;
    const target = this.target(kind, id);
    const releases = await this.fetchReleases(target, 'automatic');
    markSearched(this.deps.db, kind, [id], this.now());
    const best = rankDecisions(releases.map((r) => ({ r, ...target.evaluate(r, target.ctx), publishDate: r.publishDate }))).find((d) => d.approved);
    if (!best) return null;
    return this.send(target, best.r, best);
  }

  /** Automatic search over items; returns how many were grabbed. Failures are logged per item. */
  async searchItems(kind: BooksKind, ids: readonly number[], signal?: AbortSignal): Promise<{ searched: number; grabbed: number }> {
    let grabbed = 0;
    let searched = 0;
    for (const id of ids) {
      if (signal?.aborted) break;
      try {
        searched += 1;
        if (await this.searchAndGrab(kind, id)) grabbed += 1;
      } catch (err) {
        this.deps.log.warn({ err, kind, id }, 'book search failed');
      }
    }
    return { searched, grabbed };
  }

  /** Ids of an author's monitored books without a file / a series' monitored missing issues. */
  missingOf(kind: BooksKind, parentId: number): number[] {
    return wantedItems(this.deps.db, kind, 'missing', this.now())
      .filter((w) => w.parentId === parentId)
      .map((w) => w.id);
  }

  /** Wanted items (missing, then below cutoff) not searched within the cooldown. */
  async missingSearch(kind: 'all' | BooksKind, signal?: AbortSignal): Promise<string> {
    const cooldownMs = this.settings().search.itemSearchCooldownHours * HOUR_MS;
    const cutoff = this.now().getTime() - cooldownMs;
    const kinds: BooksKind[] = kind === 'all' ? ['ebook', 'comic'] : [kind];
    let searched = 0;
    let grabbed = 0;
    for (const k of kinds) {
      const due = [...wantedItems(this.deps.db, k, 'missing', this.now()), ...wantedItems(this.deps.db, k, 'cutoff', this.now())]
        .filter((w) => !w.lastSearchedAt || Date.parse(w.lastSearchedAt) <= cutoff)
        .sort((a, b) => (a.lastSearchedAt ?? '').localeCompare(b.lastSearchedAt ?? ''))
        .slice(0, MISSING_SEARCH_LIMIT - searched);
      const r = await this.searchItems(k, [...new Set(due.map((w) => w.id))], signal);
      searched += r.searched;
      grabbed += r.grabbed;
      if (searched >= MISSING_SEARCH_LIMIT) break;
    }
    return `searched ${searched} item(s), grabbed ${grabbed}`;
  }

  /**
   * RSS: releases in the books categories are matched to wanted items (title / series key) and
   * the best approved release per item is grabbed. Returns how many were grabbed.
   */
  async handleRss(releases: readonly ReleaseResource[]): Promise<number> {
    const settings = this.settings();
    const db = this.deps.db;
    const ebookCats = new Set(settings.search.ebookCategories);
    const comicCats = new Set(settings.search.comicCategories);
    const inCats = (r: ReleaseResource, cats: Set<number>) => r.categories.some((c) => cats.has(c) || cats.has(Math.floor(c / 1000) * 1000));
    const candidates = new Map<string, { kind: BooksKind; id: number; releases: ReleaseResource[] }>();
    const add = (kind: BooksKind, id: number, r: ReleaseResource) => {
      const key = `${kind}:${id}`;
      const entry = candidates.get(key) ?? { kind, id, releases: [] };
      entry.releases.push(r);
      candidates.set(key, entry);
    };

    const ebookReleases = releases.filter((r) => inCats(r, ebookCats));
    if (ebookReleases.length > 0) {
      const wanted = [...wantedItems(db, 'ebook', 'missing', this.now()), ...wantedItems(db, 'ebook', 'cutoff', this.now())];
      const byTitle = new Map<string, number[]>();
      for (const w of wanted) {
        const key = bookTitleKey(w.title);
        byTitle.set(key, [...(byTitle.get(key) ?? []), w.id]);
      }
      for (const r of ebookReleases) {
        const parsed = parseEbookRelease(r.title);
        if (!parsed) continue;
        const keys = [parsed.title, ...(parsed.orderAmbiguous ? [parsed.author] : [])].filter((t): t is string => !!t).map(bookTitleKey);
        for (const key of keys) for (const id of byTitle.get(key) ?? []) add('ebook', id, r);
      }
    }

    const comicReleases = releases.filter((r) => inCats(r, comicCats));
    if (comicReleases.length > 0) {
      const rows = db
        .select({ id: comicIssues.id, title: comicSeries.title })
        .from(comicIssues)
        .innerJoin(comicSeries, eq(comicSeries.id, comicIssues.seriesId))
        .all();
      const titleOf = new Map(rows.map((r) => [r.id, bookTitleKey(r.title)] as const));
      const wanted = [...wantedItems(db, 'comic', 'missing', this.now()), ...wantedItems(db, 'comic', 'cutoff', this.now())];
      const bySeries = new Map<string, number[]>();
      for (const w of wanted) {
        const key = titleOf.get(w.id);
        if (key) bySeries.set(key, [...(bySeries.get(key) ?? []), w.id]);
      }
      for (const r of comicReleases) {
        const parsed = parseComicRelease(r.title);
        if (!parsed) continue;
        for (const id of bySeries.get(bookTitleKey(parsed.series)) ?? []) add('comic', id, r);
      }
    }

    let grabbed = 0;
    for (const { kind, id, releases: list } of candidates.values()) {
      try {
        if (hasActiveGrab(db, kind, id, this.now())) continue;
        const target = this.target(kind, id);
        const best = rankDecisions(list.map((r) => ({ r, ...target.evaluate(r, target.ctx), publishDate: r.publishDate }))).find((d) => d.approved);
        if (!best) continue;
        await this.send(target, best.r, best);
        grabbed += 1;
      } catch (err) {
        this.deps.log.warn({ err, kind, id }, 'books RSS grab failed');
      }
    }
    return grabbed;
  }
}
