import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { AdditionalAudioMode, AdditionalLanguageKind, AdditionalLanguageOutcome, LanguageProfileFlagMode } from '@arclight/shared';

// "Add additional…" records: audio and subtitle languages asked for on an item, on top of what
// its profiles already want. No foreign keys to the library (same rule as history/subtitles):
// rows of deleted items are pruned on `library` bus events.
//
// Scope: a movie, a whole series, one season of it, or one episode. `scope_key` spells the
// scope out ("movie:1", "series:2", "series:2:s1", "series:2:e7") so the unique index works
// (SQLite treats NULLs as distinct, so the nullable columns alone could not enforce it).

export const additionalLanguages = sqliteTable(
  'additional_languages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind').$type<AdditionalLanguageKind>().notNull(),
    mediaType: text('media_type', { enum: ['series', 'movie'] }).notNull(),
    movieId: integer('movie_id'),
    seriesId: integer('series_id'),
    seasonNumber: integer('season_number'),
    episodeId: integer('episode_id'),
    scopeKey: text('scope_key').notNull(),
    /** Normalised IETF-style tag ("es", "pt-BR"). */
    language: text('language').notNull(),
    /** Subtitles: forced / HI modes, as on a language profile item. */
    forced: text('forced').$type<LanguageProfileFlagMode>().notNull().default('never'),
    hi: text('hi').$type<LanguageProfileFlagMode>().notNull().default('also'),
    /** Audio: replace (multi-audio release replaces the file) or version (separate slot). */
    mode: text('mode').$type<AdditionalAudioMode>(),
    versionTag: text('version_tag'),
    status: text('status').$type<AdditionalLanguageOutcome>().notNull(),
    message: text('message').notNull().default(''),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('additional_languages_scope_idx').on(t.kind, t.scopeKey, t.language),
    index('additional_languages_series_idx').on(t.seriesId),
    index('additional_languages_movie_idx').on(t.movieId),
  ],
);

export type AdditionalLanguageRow = typeof additionalLanguages.$inferSelect;
