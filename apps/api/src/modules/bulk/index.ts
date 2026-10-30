import {
  BulkCommandResponse,
  BulkRenamePreview,
  BulkRenameRequest,
  BulkSearchCommand,
  BulkSubtitleSearchCommand,
  ErrorResponse,
  RenameResult,
} from '@arclight/shared';
import type { AppContext, AppModule } from '../../app.js';
import { getImportsService, ImportsError } from '../imports/index.js';
import { createCutoffChecker } from '../library/index.js';
import { ProfilesService } from '../profiles/index.js';
import { releasesServiceFor, unreleasedNote, type SearchTarget } from '../releases/index.js';
import { subtitlesServiceFor } from '../subtitles/index.js';
import { planBulkSearch } from './plan.js';

export { planBulkSearch, type BulkSearchPlan } from './plan.js';

// Bulk commands for the library and Wanted lists (docs/using/library.md § Bulk actions):
//
// * POST /command/bulksearch: one `BulkSearch` job over many movies / series / episodes, with
//   the Wanted lists' missing / cutoff rules when asked (see planBulkSearch).
// * POST /rename/bulk previews, POST /command/bulkrename renames the files of many items
//   through the imports module's per-item rename.
// * POST /command/subtitlesearch/bulk: one `BulkSubtitleSearch` job over many files.
//
// Every route answers at once; the jobs report through GET /jobs and `job` events. Admin only
// (no `access` config), like the per-item commands.

export const BULK_SEARCH_JOB = 'BulkSearch';
export const BULK_SUBTITLE_SEARCH_JOB = 'BulkSubtitleSearch';

const errors = { 400: ErrorResponse, 404: ErrorResponse };

function searchKey(t: SearchTarget): string {
  if ('movieId' in t) return `m${t.movieId}`;
  if ('seriesId' in t) return `s${t.seriesId}${'episodeIds' in t && t.episodeIds?.length ? `:${t.episodeIds.join('+')}` : ''}`;
  return JSON.stringify(t);
}

/** Starts the job that searches each target in turn (user-invoked: delay and monitored specs relaxed). */
function startSearchJob(ctx: AppContext, targets: SearchTarget[]) {
  return ctx.scheduler.runTask(
    BULK_SEARCH_JOB,
    'manual',
    async ({ signal, log }) => {
      const releases = releasesServiceFor(ctx);
      let grabbed = 0;
      let found = 0;
      let failed = 0;
      let searched = 0;
      let unreleased = 0;
      for (const t of targets) {
        if (signal.aborted) break;
        try {
          const summary = await releases.searchFor(t, { userInvoked: true, signal });
          grabbed += summary.grabbed.length;
          found += summary.releases;
          unreleased += summary.skippedUnreleased ?? 0;
        } catch (err) {
          failed++;
          log.warn({ err, target: t }, 'bulk search failed');
        }
        searched++;
      }
      return `searched ${searched} of ${targets.length}: ${found} releases, ${grabbed} grabbed${failed ? `, ${failed} failed` : ''}${unreleasedNote(unreleased)}`;
    },
    // Two bulk searches over different items may overlap; the same selection never twice.
    { key: `${BULK_SEARCH_JOB}:${targets.map(searchKey).sort().join(',')}` },
  );
}

export const bulkModule: AppModule = (ctx) => async (app) => {
  const db = ctx.db;
  const profiles = new ProfilesService({ db });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ImportsError) {
      return reply.code(err.code === 'NOT_FOUND' ? 404 : 400).send({ error: err.message, code: err.code });
    }
    if (err instanceof Error && 'validation' in err && err.validation) {
      return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
    }
    req.log.error({ err }, 'unhandled bulk error');
    return reply.code(500).send({ error: 'internal error' });
  });

  app.post('/command/bulksearch', { schema: { body: BulkSearchCommand, response: { 202: BulkCommandResponse, ...errors } } }, async (req, reply) => {
    const plan = planBulkSearch(db, req.body, {
      isCutoffMet: () => createCutoffChecker(db, profiles),
      qualityProfiles: () => profiles.listQualityProfiles(),
      releaseGate: releasesServiceFor(ctx).releaseGate(true),
    });
    const job = plan.targets.length > 0 ? startSearchJob(ctx, plan.targets).job : null;
    return reply.code(202).send({ queued: plan.queued, skipped: plan.skipped, ...(plan.unreleased ? { unreleased: plan.unreleased } : {}), job });
  });

  app.post('/rename/bulk', { schema: { body: BulkRenameRequest, response: { 200: BulkRenamePreview, ...errors } } }, async (req) => {
    const imports = getImportsService(ctx);
    const out: BulkRenamePreview = { items: [], failed: [] };
    const run = (mediaType: 'series' | 'movie', id: number) => {
      try {
        out.items.push(...imports.previewRename(mediaType === 'series' ? { seriesId: id } : { movieId: id }));
      } catch (err) {
        out.failed.push({ mediaType, id, error: err instanceof Error ? err.message : String(err) });
      }
    };
    for (const id of new Set(req.body.seriesIds ?? [])) run('series', id);
    for (const id of new Set(req.body.movieIds ?? [])) run('movie', id);
    return out;
  });

  app.post('/command/bulkrename', { schema: { body: BulkRenameRequest, response: { 200: RenameResult, ...errors } } }, async (req) => {
    const imports = getImportsService(ctx);
    const files = req.body.files;
    const result: RenameResult = { renamed: [], failed: [] };
    const run = async (cmd: { seriesId: number } | { movieId: number }) => {
      try {
        const r = await imports.executeRename({ ...cmd, ...(files ? { files } : {}) });
        result.renamed.push(...r.renamed);
        result.failed.push(...r.failed);
      } catch (err) {
        // A deleted item has no files to report; keep going with the rest.
        req.log.warn({ err, ...cmd }, 'bulk rename skipped an item');
      }
    };
    for (const seriesId of new Set(req.body.seriesIds ?? [])) await run({ seriesId });
    for (const movieId of new Set(req.body.movieIds ?? [])) await run({ movieId });
    return result;
  });

  app.post(
    '/command/subtitlesearch/bulk',
    { schema: { body: BulkSubtitleSearchCommand, response: { 202: BulkCommandResponse, ...errors } } },
    async (req, reply) => {
      const subtitles = subtitlesServiceFor(ctx);
      let ids = [...new Set(req.body.mediaFileIds ?? [])];
      if (req.body.wanted) {
        const mediaType = req.body.wanted;
        const all: number[] = [];
        for (let page = 1; ; page++) {
          const p = subtitles.wanted({ mediaType, page, pageSize: 500 });
          all.push(...p.records.map((r) => r.mediaFileId));
          if (page * 500 >= p.totalRecords || p.records.length === 0) break;
        }
        ids = [...new Set([...ids, ...all])];
      }
      if (ids.length === 0) return reply.code(202).send({ queued: 0, skipped: 0, job: null });
      const { job } = ctx.scheduler.runTask(
        BULK_SUBTITLE_SEARCH_JOB,
        'manual',
        async ({ signal, log }) => {
          let searched = 0;
          let downloaded = 0;
          let failed = 0;
          for (const mediaFileId of ids) {
            if (signal.aborted) break;
            try {
              const r = await subtitles.commandSearch({ mediaFileId });
              searched += r.files;
              downloaded += r.downloaded;
              if (r.message === 'All providers are throttled') return `stopped after ${searched} of ${ids.length} files: all providers are throttled; ${downloaded} downloaded`;
            } catch (err) {
              failed++;
              log.warn({ err, mediaFileId }, 'bulk subtitle search failed');
            }
          }
          return `searched ${searched} of ${ids.length} files: ${downloaded} downloaded${failed ? `, ${failed} failed` : ''}`;
        },
        { key: BULK_SUBTITLE_SEARCH_JOB },
      );
      return reply.code(202).send({ queued: ids.length, skipped: 0, job });
    },
  );
};
