import { z } from 'zod';
import { ARCLIGHT_RAW_BASE } from './project.js';

// Scene / absolute numbering mappings: how release names number a series (scene) versus the
// library (TMDB/TVDB order). Per-series rules are edited by hand or pulled from the community
// feed; the release matcher and "apply to existing files" use them.

/**
 * - `season`: scene season (optionally from an episode anchor) → library season/episode, or → a
 *   library absolute number. Anchors are piecewise offsets: scene episode e ≥ `sceneEpisode`
 *   maps to `tvdbEpisode + (e - sceneEpisode)` until the next anchor of the same scene season.
 * - `absolute`: scene absolute number (anchor `sceneAbsolute`, optionally only within
 *   `sceneSeason`) → library season/episode or library absolute number, same offset rule.
 * - `title`: `sceneTitle` is an alias of the series; with `tvdbSeason` set, releases matched
 *   through the alias land in that season (restricted to parsed `sceneSeason` when set).
 */
export const SceneMappingKind = z.enum(['season', 'absolute', 'title']);
export type SceneMappingKind = z.infer<typeof SceneMappingKind>;

export const SceneMappingSource = z.enum(['manual', 'feed']);
export type SceneMappingSource = z.infer<typeof SceneMappingSource>;

const Num = z.number().int().min(0);

export const SceneMappingInput = z
  .object({
    kind: SceneMappingKind,
    sceneSeason: Num.nullable().default(null),
    sceneEpisode: Num.nullable().default(null),
    sceneAbsolute: Num.nullable().default(null),
    tvdbSeason: Num.nullable().default(null),
    tvdbEpisode: Num.nullable().default(null),
    tvdbAbsolute: Num.nullable().default(null),
    sceneTitle: z.string().trim().min(1).max(300).nullable().default(null),
    comment: z.string().max(500).default(''),
  })
  .superRefine((m, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (m.kind === 'season') {
      if (m.sceneSeason === null) issue('season mappings need sceneSeason');
      if (m.tvdbSeason === null && m.tvdbAbsolute === null) issue('season mappings need tvdbSeason or tvdbAbsolute');
    } else if (m.kind === 'absolute') {
      if (m.sceneAbsolute === null) issue('absolute mappings need sceneAbsolute');
      if (m.tvdbAbsolute === null && (m.tvdbSeason === null || m.tvdbEpisode === null)) {
        issue('absolute mappings need tvdbAbsolute or tvdbSeason + tvdbEpisode');
      }
    } else if (m.sceneTitle === null) {
      issue('title mappings need sceneTitle');
    }
  });
export type SceneMappingInput = z.input<typeof SceneMappingInput>;
export type SceneMappingValues = z.output<typeof SceneMappingInput>;

export const SceneMapping = z.object({
  id: z.number().int(),
  seriesId: z.number().int(),
  kind: SceneMappingKind,
  sceneSeason: z.number().int().nullable(),
  sceneEpisode: z.number().int().nullable(),
  sceneAbsolute: z.number().int().nullable(),
  tvdbSeason: z.number().int().nullable(),
  tvdbEpisode: z.number().int().nullable(),
  tvdbAbsolute: z.number().int().nullable(),
  sceneTitle: z.string().nullable(),
  source: SceneMappingSource,
  comment: z.string(),
});
export type SceneMapping = z.infer<typeof SceneMapping>;

/** POST /series/:id/scenemapping/apply result. */
export const SceneMappingApplyResult = z.object({
  /** Library files examined. */
  checked: z.number().int(),
  remapped: z.array(
    z.object({
      mediaFileId: z.number().int(),
      /** Id of the re-linked file row (files are re-registered with the new episode links). */
      newMediaFileId: z.number().int(),
      path: z.string(),
      fromEpisodeIds: z.array(z.number().int()),
      toEpisodeIds: z.array(z.number().int()),
    }),
  ),
  unchanged: z.number().int(),
  /** Files whose mapped episodes belong to another file still on disk, or did not map at all. */
  skipped: z.array(z.object({ mediaFileId: z.number().int(), path: z.string(), reason: z.string() })),
  /** The imports rescan run afterwards (picks up files that now map); null when not wired. */
  rescan: z
    .object({ scanned: z.number().int(), added: z.number().int(), unmapped: z.number().int() })
    .nullable(),
});
export type SceneMappingApplyResult = z.infer<typeof SceneMappingApplyResult>;

// ---- community feed ---------------------------------------------------------------------

export const SCENE_MAPPING_FEED_SCHEMA_VERSION = 1;
/** Path of the community mapping file inside the Arclight repository. */
export const DEFAULT_SCENE_MAPPING_FEED_PATH = 'feeds/scene-mappings.json';
export const DEFAULT_SCENE_MAPPING_FEED_URL = `${ARCLIGHT_RAW_BASE}${DEFAULT_SCENE_MAPPING_FEED_PATH}`;

/** One rule in the feed file: the `SceneMappingInput` fields (source is always `feed`). */
export const SceneMappingFeedRule = SceneMappingInput;

/** One series in the feed file; matched to the library by tvdbId, then tmdbId. */
export const SceneMappingFeedSeries = z
  .object({
    tvdbId: z.number().int().positive().optional(),
    tmdbId: z.number().int().positive().optional(),
    title: z.string().optional(),
    mappings: z.array(z.unknown()),
  })
  .refine((s) => s.tvdbId !== undefined || s.tmdbId !== undefined, { message: 'tvdbId or tmdbId is required' });

/** The feed document: `{ schemaVersion, generatedAt?, series: [{ tvdbId?, tmdbId?, title?, mappings: [...] }] }`. */
export const SceneMappingFeedFile = z.object({
  schemaVersion: z.number().int(),
  generatedAt: z.string().optional(),
  series: z.array(z.unknown()),
});
export type SceneMappingFeedFile = z.infer<typeof SceneMappingFeedFile>;

export const SceneMappingFeedStatus = z.object({
  url: z.string(),
  lastSyncAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastError: z.string().nullable(),
  /** The default feed answered 404 (not published yet): info, not an error. */
  notPublished: z.boolean(),
  /** Feed series in the last document / matched to library series / rules stored. */
  feedSeries: z.number().int(),
  matchedSeries: z.number().int(),
  mappings: z.number().int(),
  /** Feed rules dropped as invalid in the last sync. */
  rejected: z.number().int(),
});
export type SceneMappingFeedStatus = z.infer<typeof SceneMappingFeedStatus>;
