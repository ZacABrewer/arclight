import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';

// Tables owned by the scene-mapping module.

/**
 * Scene / absolute numbering rules per series (semantics: packages/shared/src/scene-mapping.ts).
 * `source` = `manual` (edited by hand, wins) or `feed` (replaced by every SceneMappingSync).
 */
export const sceneMappings = sqliteTable(
  'scene_mappings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    seriesId: integer('series_id').notNull(),
    kind: text('kind', { enum: ['season', 'absolute', 'title'] }).notNull(),
    sceneSeason: integer('scene_season'),
    sceneEpisode: integer('scene_episode'),
    sceneAbsolute: integer('scene_absolute'),
    tvdbSeason: integer('tvdb_season'),
    tvdbEpisode: integer('tvdb_episode'),
    tvdbAbsolute: integer('tvdb_absolute'),
    sceneTitle: text('scene_title'),
    source: text('source', { enum: ['manual', 'feed'] }).notNull(),
    comment: text('comment').notNull().default(''),
  },
  (t) => [index('scene_mappings_series_idx').on(t.seriesId), index('scene_mappings_source_idx').on(t.source)],
);
