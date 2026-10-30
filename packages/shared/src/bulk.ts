import { z } from 'zod';
import { Job } from './jobs.js';
import { RenamePreviewItem } from './imports.js';
import { ListSearchParam } from './list-search.js';
import { WantedReleaseFilter } from './release-dates.js';

// Bulk commands for the library and Wanted lists: one request acts on many selected items
// (or on everything a Wanted list matches) and queues a single job. Per-item routes stay as
// they are; these only add the "many at once" shape where the api had none.

const ids = () => z.array(z.number().int().positive()).max(10_000);

/**
 * What a bulk search looks for in the items it is given:
 *
 * * `all`: search every selected item as a manual search would (the decision engine still
 *   rejects releases that are not an upgrade under the item's profile);
 * * `missing`: only monitored items (episodes) with no file, the Wanted → Missing rules;
 * * `upgrade`: only items whose file is below its profile's cutoff (quality and custom-format
 *   score, per version slot), the Wanted → Cutoff unmet rules. Items whose profile does not
 *   allow upgrades are skipped.
 */
export const BulkSearchMode = z.enum(['all', 'missing', 'upgrade']);
export type BulkSearchMode = z.infer<typeof BulkSearchMode>;

/**
 * POST /command/bulksearch. Give ids, or `allEpisodes` / `allMovies` to take everything the
 * matching Wanted list holds (`missing` or `upgrade` mode only). Answered 202 with the queued
 * job (null when nothing matched).
 */
export const BulkSearchCommand = z
  .object({
    mode: BulkSearchMode.default('all'),
    movieIds: ids().optional(),
    seriesIds: ids().optional(),
    episodeIds: ids().optional(),
    allMovies: z.literal(true).optional(),
    allEpisodes: z.literal(true).optional(),
    /**
     * With `allEpisodes` / `allMovies`: only the Wanted rows matching this text search (the
     * list's `q`), so "Select all" on a searched Wanted list acts on what the search shows.
     */
    q: ListSearchParam,
    /**
     * With `allEpisodes` / `allMovies`: the Wanted list's release filter, like `q`. Whatever it
     * shows, items that are not released yet are never searched (they count as skipped).
     */
    ...WantedReleaseFilter.shape,
  })
  .refine(
    (c) => (c.movieIds?.length ?? 0) + (c.seriesIds?.length ?? 0) + (c.episodeIds?.length ?? 0) > 0 || c.allMovies === true || c.allEpisodes === true,
    { message: 'give movieIds, seriesIds, episodeIds, allMovies or allEpisodes' },
  )
  .refine((c) => !(c.allMovies || c.allEpisodes) || c.mode !== 'all', { message: 'allMovies / allEpisodes need mode missing or upgrade' });
export type BulkSearchCommand = z.infer<typeof BulkSearchCommand>;
export type BulkSearchCommandInput = z.input<typeof BulkSearchCommand>;

/** Answer of the bulk commands: how many items went into the job, how many were skipped. */
export const BulkCommandResponse = z.object({
  /** Items (movies, episodes or files) the job will work through. */
  queued: z.number().int(),
  /** Selected items that did not match the mode (e.g. already at cutoff). */
  skipped: z.number().int(),
  /** Bulk search: how many of `skipped` were left out because they are not released yet. */
  unreleased: z.number().int().optional(),
  job: Job.nullable(),
});
export type BulkCommandResponse = z.infer<typeof BulkCommandResponse>;

/** POST /rename/bulk (preview) and POST /command/bulkrename: rename the files of many items. */
export const BulkRenameRequest = z
  .object({
    movieIds: ids().optional(),
    seriesIds: ids().optional(),
    /** Execute only: limit the rename to these media file ids (the previewed, ticked ones). */
    files: ids().optional(),
  })
  .refine((c) => (c.movieIds?.length ?? 0) + (c.seriesIds?.length ?? 0) > 0, { message: 'give movieIds or seriesIds' });
export type BulkRenameRequest = z.infer<typeof BulkRenameRequest>;

export const BulkRenamePreview = z.object({
  items: z.array(RenamePreviewItem),
  /** Items that could not be previewed (e.g. deleted meanwhile). */
  failed: z.array(z.object({ mediaType: z.enum(['series', 'movie']), id: z.number().int(), error: z.string() })),
});
export type BulkRenamePreview = z.infer<typeof BulkRenamePreview>;

/**
 * POST /command/subtitlesearch/bulk: search subtitles for many files in one job. Give
 * `mediaFileIds`, or `wanted` to take every file the Subtitles → Wanted list holds for that
 * media type.
 */
export const BulkSubtitleSearchCommand = z
  .object({
    mediaFileIds: ids().optional(),
    wanted: z.enum(['series', 'movie']).optional(),
  })
  .refine((c) => (c.mediaFileIds?.length ?? 0) > 0 || c.wanted !== undefined, { message: 'give mediaFileIds or wanted' });
export type BulkSubtitleSearchCommand = z.infer<typeof BulkSubtitleSearchCommand>;
