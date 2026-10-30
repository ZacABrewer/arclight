import { eq } from 'drizzle-orm';
import type { ServerEvent, TagEntityType } from '@arclight/shared';
import type { AppContext, AppModule } from '../../app.js';
import * as s from '../../db/schema.js';
import { tagRulesRoutes } from './routes.js';
import { TagRulesService } from './service.js';

export { TagRulesService, TagRulesError, writeItemTags, type TagRulesServiceOptions } from './service.js';
export { rewriteTagReferences, tagUsageCounts } from './references.js';
export { STARTER_RULES } from './starters.js';
export * from './schema.js';

export const TAG_RULES_JOB = 'ApplyTagRules';
/** Daily at 04:15, after the nightly refreshes and retention. */
export const TAG_RULES_CRON = '15 4 * * *';
/** Events for one item are gathered this long before its rules run. */
export const TAG_RULES_DEBOUNCE_MS = 2000;

/**
 * Which items an event touches, or null. Rules run when an item is added, a file is imported or
 * upgraded, metadata is refreshed, media analysis finishes (it publishes `library updated`), and
 * when a request is created or approved.
 */
export function itemsForEvent(ctx: Pick<AppContext, 'db'>, event: ServerEvent): Array<{ type: TagEntityType; id: number }> | null {
  switch (event.type) {
    case 'library':
      if (event.action === 'deleted') return null;
      return [{ type: event.mediaType, id: event.id }];
    case 'import':
      if (event.action !== 'imported' || event.mediaId === undefined || !event.mediaType) return null;
      return [{ type: event.mediaType === 'music' ? 'artist' : event.mediaType === 'audiobook' ? 'author' : event.mediaType, id: event.mediaId }];
    case 'request': {
      if (event.action !== 'created' && event.action !== 'approved' && event.action !== 'completed') return null;
      if (event.audio) {
        const r = ctx.db.select().from(s.audioRequests).where(eq(s.audioRequests.id, event.id)).get();
        if (!r || r.libraryId === null) return null;
        if (r.kind === 'artist') return [{ type: 'artist', id: r.libraryId }];
        if (r.kind === 'author') return [{ type: 'author', id: r.libraryId }];
        if (r.kind === 'album') {
          const album = ctx.db.select({ artistId: s.albums.artistId }).from(s.albums).where(eq(s.albums.id, r.libraryId)).get();
          return album ? [{ type: 'artist', id: album.artistId }] : null;
        }
        const book = ctx.db.select({ authorId: s.books.authorId }).from(s.books).where(eq(s.books.id, r.libraryId)).get();
        return book ? [{ type: 'author', id: book.authorId }] : null;
      }
      const r = ctx.db.select({ type: s.mediaRequests.type, tmdbId: s.mediaRequests.tmdbId }).from(s.mediaRequests).where(eq(s.mediaRequests.id, event.id)).get();
      if (!r) return null;
      const table = r.type === 'movie' ? s.movies : s.series;
      const item = ctx.db.select({ id: table.id }).from(table).where(eq(table.tmdbId, r.tmdbId)).get();
      return item ? [{ type: r.type, id: item.id }] : null;
    }
    default:
      return null;
  }
}

/** Per-context service, so other modules (and tests) reach the same instance. */
const services = new WeakMap<AppContext, TagRulesService>();
export function tagRulesServiceFor(ctx: AppContext): TagRulesService {
  let svc = services.get(ctx);
  if (!svc) {
    svc = new TagRulesService({ db: ctx.db, bus: ctx.bus, log: ctx.log.child({ module: 'tag-rules' }) });
    services.set(ctx, svc);
  }
  return svc;
}

export interface TagRulesModuleOptions {
  /** Debounce for event-triggered runs (tests pass 0). */
  debounceMs?: number;
}

// Tag management (usage, merge, bulk delete) and tag rules: CRUD, preview, run, the daily
// ApplyTagRules pass and the event listener that tags items as they change.
export const tagRulesModuleWith =
  (opts: TagRulesModuleOptions = {}): AppModule =>
  (ctx) =>
  async (app) => {
    const service = tagRulesServiceFor(ctx);
    service.seedStarterRules();
    await app.register(tagRulesRoutes(service));

    ctx.scheduler.register({
      name: TAG_RULES_JOB,
      cron: TAG_RULES_CRON,
      handler: async () => {
        const pruned = service.pruneOrphans();
        const r = service.run();
        return `${r.itemsEvaluated} item(s) evaluated, ${r.itemsChanged} changed (+${r.add.reduce((n, a) => n + a.count, 0)} / -${r.remove.reduce((n, a) => n + a.count, 0)} tags)${pruned > 0 ? `, ${pruned} stale record(s) pruned` : ''}`;
      },
    });

    const debounceMs = opts.debounceMs ?? TAG_RULES_DEBOUNCE_MS;
    const pending = new Map<TagEntityType, Set<number>>();
    let timer: NodeJS.Timeout | null = null;
    const log = ctx.log.child({ module: 'tag-rules' });
    const flush = () => {
      timer = null;
      if (pending.size === 0) return;
      const items: Partial<Record<TagEntityType, number[]>> = {};
      for (const [type, ids] of pending) items[type] = [...ids];
      pending.clear();
      try {
        service.runForItems(items);
      } catch (err) {
        log.warn({ err }, 'tag rules failed for changed items');
      }
    };
    const unsubscribe = ctx.bus.subscribe((event) => {
      let items: ReturnType<typeof itemsForEvent>;
      try {
        items = itemsForEvent(ctx, event);
      } catch (err) {
        log.debug({ err }, 'tag rules: could not resolve event');
        return;
      }
      if (!items) return;
      for (const { type, id } of items) {
        const set = pending.get(type) ?? new Set<number>();
        set.add(id);
        pending.set(type, set);
      }
      if (timer) return;
      timer = setTimeout(flush, debounceMs);
      timer.unref?.();
    });
    app.addHook('onClose', async () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
      timer = null;
    });
  };

export const tagRulesModule: AppModule = tagRulesModuleWith();
