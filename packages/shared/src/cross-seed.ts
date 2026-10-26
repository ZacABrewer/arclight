import { z } from 'zod';

// Cross-seeding (cross-seed module): find the same release on other torrent indexers and seed
// it from the file already in the library, without downloading anything.

export const CrossSeedSettings = z.object({
  enabled: z.boolean().default(false).describe('Search for cross-seeds on a schedule and after imports.'),
  indexerIds: z
    .array(z.number().int())
    .default([])
    .describe('Torrent indexers to search. Empty = every enabled torrent indexer with automatic search.'),
  sizeTolerancePercent: z
    .number()
    .min(0)
    .max(10)
    .default(0.5)
    .describe('How far a release size may differ from the file size to be considered (exact matches are preferred).'),
  onImport: z.boolean().default(false).describe('Search right after a file is imported.'),
  schedule: z.string().trim().min(1).default('0 4 * * *').describe('Cron expression for the CrossSeedSearch job (daily by default).'),
  excludeTags: z.array(z.number().int()).default([]).describe('Skip series and movies carrying any of these tags.'),
  downloadClientId: z
    .number()
    .int()
    .nullable()
    .default(null)
    .describe('Built-in or qBittorrent client to seed with. Empty = the first enabled one (Built-in first).'),
  category: z
    .string()
    .trim()
    .default('cross-seed')
    .describe('Client category for cross-seeds (keep it different from the import category).'),
  linkDir: z
    .string()
    .trim()
    .default('')
    .describe(
      'Folder for hard links when the torrent names the file differently. Empty = a "cross-seed" folder in the engine downloads folder.',
    ),
  searchIntervalDays: z
    .number()
    .int()
    .min(1)
    .default(30)
    .describe('The scheduled search skips files searched within this many days.'),
  maxPerRun: z.number().int().min(1).default(50).describe('Files searched per scheduled run.'),
});
export type CrossSeedSettings = z.infer<typeof CrossSeedSettings>;

export const CrossSeedState = z.enum(['seeding', 'failed']);
export type CrossSeedState = z.infer<typeof CrossSeedState>;

export const CrossSeedResource = z.object({
  id: z.number().int(),
  mediaFileId: z.number().int().nullable(),
  indexerId: z.number().int().nullable(),
  indexerName: z.string().nullable(),
  /** Lowercase hex v1 info-hash. */
  infoHash: z.string(),
  title: z.string(),
  /** Bytes. */
  size: z.number().int(),
  state: CrossSeedState,
  message: z.string().nullable(),
  downloadClientId: z.number().int().nullable(),
  savePath: z.string().nullable(),
  /** ISO-8601. */
  addedAt: z.string(),
});
export type CrossSeedResource = z.infer<typeof CrossSeedResource>;

/** POST /crossseed/search: exactly one target. */
export const CrossSeedSearchRequest = z
  .object({
    mediaFileId: z.number().int().optional(),
    seriesId: z.number().int().optional(),
    movieId: z.number().int().optional(),
  })
  .refine((r) => [r.mediaFileId, r.seriesId, r.movieId].filter((v) => v !== undefined).length === 1, {
    message: 'pass exactly one of mediaFileId, seriesId or movieId',
  });
export type CrossSeedSearchRequest = z.infer<typeof CrossSeedSearchRequest>;

/** Why a candidate release was not used (for the search report). */
export const CrossSeedSkip = z.object({
  title: z.string(),
  indexerId: z.number().int(),
  reason: z.string(),
});
export type CrossSeedSkip = z.infer<typeof CrossSeedSkip>;

export const CrossSeedSearchResult = z.object({
  filesSearched: z.number().int(),
  candidates: z.number().int(),
  added: z.array(CrossSeedResource),
  skipped: z.array(CrossSeedSkip),
});
export type CrossSeedSearchResult = z.infer<typeof CrossSeedSearchResult>;

export const CrossSeedListQuery = z.object({
  mediaFileId: z.coerce.number().int().optional(),
  state: CrossSeedState.optional(),
});
export type CrossSeedListQuery = z.infer<typeof CrossSeedListQuery>;

export const CrossSeedErrorResponse = z.object({ error: z.string(), code: z.string() });
export type CrossSeedErrorResponse = z.infer<typeof CrossSeedErrorResponse>;
