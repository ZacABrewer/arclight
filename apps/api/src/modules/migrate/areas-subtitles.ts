import { existsSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { LanguageProfileInput, SubtitleSettings, type SubtitleProviderId } from '@arclight/shared';
import * as t from '../../db/schema.js';
import { getSection, setSection } from '../settings/service.js';
import { SkipItem, importedTarget, type AreaEnv, type Existing, type Handlers } from './areas.js';
import { importedFromArr } from './arr-refs.js';
import { isInside, parentPath, samePath } from './paths.js';
import type { SourceItem } from './types.js';
import type { BazarrMediaRef, SubtitleAssignmentPayload, SubtitleEventPayload, SubtitleFilePayload, SubtitleProfilePayload, SubtitleProviderPayload } from './types-subtitles.js';

// Bazarr areas applied to the subtitles module: language profiles, their assignment to series
// and movies, providers, subtitle history and blacklist, existing subtitle files.
//
// Media is found the way it most likely came into Arclight: by path (Bazarr's path after the
// source's path mappings), then by external ids, then through what an import of Sonarr/Radarr
// recorded in migrate_imported (any instance; used only when it is unambiguous).

// ---- media resolution --------------------------------------------------------------------------

interface ResolvedMedia {
  mediaType: 'series' | 'movie';
  id: number;
  title: string;
}

interface ResolvedFile {
  id: number;
  path: string;
  seriesId: number | null;
  movieId: number | null;
}

function fileByPath(env: AreaEnv, path: string | null): ResolvedFile | null {
  if (!path) return null;
  const row = env.db.select({ id: t.mediaFiles.id, path: t.mediaFiles.path, seriesId: t.mediaFiles.seriesId, movieId: t.mediaFiles.movieId }).from(t.mediaFiles).where(eq(t.mediaFiles.path, path)).get();
  if (row) return row;
  // Separator or case differences (a Windows-era Bazarr): compare inside the parent folder only.
  const parent = parentPath(path);
  return (
    env.db
      .select({ id: t.mediaFiles.id, path: t.mediaFiles.path, seriesId: t.mediaFiles.seriesId, movieId: t.mediaFiles.movieId })
      .from(t.mediaFiles)
      .all()
      .find((f) => isInside(parent, f.path) && samePath(f.path, path)) ?? null
  );
}

export function resolveMedia(env: AreaEnv, ref: BazarrMediaRef): ResolvedMedia | null {
  if (ref.mediaType === 'series') {
    const rows = env.db.select({ id: t.series.id, title: t.series.title, path: t.series.path, tvdbId: t.series.tvdbId, imdbId: t.series.imdbId }).from(t.series).all();
    const hit =
      (ref.path ? rows.find((r) => samePath(r.path, ref.path!)) : undefined) ??
      (ref.tvdbId ? rows.find((r) => r.tvdbId === ref.tvdbId) : undefined) ??
      (ref.imdbId ? rows.find((r) => r.imdbId === ref.imdbId) : undefined);
    if (hit) return { mediaType: 'series', id: hit.id, title: hit.title };
    const imported = importedFromArr(env, 'sonarr', 'series', ref.sonarrSeriesId);
    const row = imported !== null ? rows.find((r) => r.id === imported) : undefined;
    return row ? { mediaType: 'series', id: row.id, title: row.title } : null;
  }
  const rows = env.db.select({ id: t.movies.id, title: t.movies.title, path: t.movies.path, tmdbId: t.movies.tmdbId, imdbId: t.movies.imdbId }).from(t.movies).all();
  // Bazarr's movie path is the video file; the folder is its parent.
  let hit = ref.path ? rows.find((r) => samePath(r.path, ref.path!) || samePath(r.path, parentPath(ref.path!))) : undefined;
  if (!hit && ref.path) {
    const file = fileByPath(env, ref.path);
    if (file?.movieId) hit = rows.find((r) => r.id === file.movieId);
  }
  hit ??= (ref.tmdbId ? rows.find((r) => r.tmdbId === ref.tmdbId) : undefined) ?? (ref.imdbId ? rows.find((r) => r.imdbId === ref.imdbId) : undefined);
  if (hit) return { mediaType: 'movie', id: hit.id, title: hit.title };
  const imported = importedFromArr(env, 'radarr', 'movies', ref.radarrMovieId);
  const row = imported !== null ? rows.find((r) => r.id === imported) : undefined;
  return row ? { mediaType: 'movie', id: row.id, title: row.title } : null;
}

/** The library file a subtitle belongs to: by video path, else the episode / movie it came from. */
export function resolveFile(env: AreaEnv, ref: BazarrMediaRef, videoPath: string | null): ResolvedFile | null {
  const byPath = fileByPath(env, videoPath);
  if (byPath) return byPath;
  if (ref.mediaType === 'series') {
    const episodeId = importedFromArr(env, 'sonarr', 'episodes', ref.sonarrEpisodeId);
    if (episodeId === null) return null;
    const ep = env.db.select({ fileId: t.episodes.episodeFileId }).from(t.episodes).where(eq(t.episodes.id, episodeId)).get();
    if (!ep?.fileId) return null;
    return env.db.select({ id: t.mediaFiles.id, path: t.mediaFiles.path, seriesId: t.mediaFiles.seriesId, movieId: t.mediaFiles.movieId }).from(t.mediaFiles).where(eq(t.mediaFiles.id, ep.fileId)).get() ?? null;
  }
  const media = resolveMedia(env, ref);
  if (!media) return null;
  const movie = env.db.select({ fileId: t.movies.movieFileId }).from(t.movies).where(eq(t.movies.id, media.id)).get();
  if (!movie?.fileId) return null;
  return env.db.select({ id: t.mediaFiles.id, path: t.mediaFiles.path, seriesId: t.mediaFiles.seriesId, movieId: t.mediaFiles.movieId }).from(t.mediaFiles).where(eq(t.mediaFiles.id, movie.fileId)).get() ?? null;
}

function episodeIdsOf(env: AreaEnv, fileId: number | null): number[] {
  if (fileId === null) return [];
  return env.db.select({ id: t.episodes.id }).from(t.episodes).where(eq(t.episodes.episodeFileId, fileId)).all().map((e) => e.id);
}

/** Arclight profile id of a Bazarr profile: this run, an earlier run, or the same-named profile. */
function resolveProfile(env: AreaEnv, sourceProfileId: number | null): number | null {
  if (sourceProfileId === null) return null;
  const key = String(sourceProfileId);
  const mapped = env.idMap.get(`subtitleProfiles:${key}`);
  if (mapped !== undefined) return mapped;
  const prior = importedTarget(env.db, env.instance, 'subtitleProfiles', key);
  if (prior?.targetId) return prior.targetId;
  const item = env.bundle.areas.subtitleProfiles?.items.find((i) => i.sourceId === key);
  if (!item) return null;
  return env.db.select({ id: t.languageProfiles.id }).from(t.languageProfiles).where(eq(t.languageProfiles.name, item.payload.name)).get()?.id ?? null;
}

// ---- language profiles ---------------------------------------------------------------------------

function profileValues(p: SubtitleProfilePayload) {
  const parsed = LanguageProfileInput.parse({ name: p.name, languages: p.languages, cutoff: p.cutoff, mustContain: p.mustContain, mustNotContain: p.mustNotContain, originalFormat: p.originalFormat });
  return { name: parsed.name, languages: parsed.languages, cutoff: parsed.cutoff, mustContain: parsed.mustContain, mustNotContain: parsed.mustNotContain, originalFormat: parsed.originalFormat };
}

// ---- providers --------------------------------------------------------------------------------------

function subtitleSettings(env: AreaEnv) {
  return SubtitleSettings.parse(getSection(env.db, 'subtitles') ?? {});
}

function saveProvider(env: AreaEnv, id: SubtitleProviderId, settings: Record<string, unknown>, mode: 'replace' | 'merge' | 'fill'): void {
  const s = subtitleSettings(env);
  const providers = [...s.providers];
  const idx = providers.findIndex((p) => p.id === id);
  const current = idx >= 0 ? providers[idx]! : null;
  const merged =
    mode === 'replace' || !current
      ? { ...(current?.settings ?? {}), ...settings }
      : mode === 'merge'
        ? { ...current.settings, ...settings }
        : { ...settings, ...Object.fromEntries(Object.entries(current.settings).filter(([, v]) => v !== '' && v !== null && v !== undefined)) };
  const next = { id, enabled: mode === 'fill' && current ? current.enabled : true, settings: merged };
  if (idx >= 0) providers[idx] = next;
  else providers.push(next);
  setSection(env.db, 'subtitles', SubtitleSettings.parse({ ...s, providers }), env.now);
}

function providerExisting(env: AreaEnv, item: SourceItem<SubtitleProviderPayload>): Existing | null {
  const s = subtitleSettings(env);
  if (item.payload.kind === 'defaults') {
    return s.defaultSeriesProfileId !== null || s.defaultMovieProfileId !== null ? { id: null, reason: 'default subtitle profiles are already set' } : null;
  }
  const current = s.providers.find((p) => p.id === item.payload.provider);
  if (!current) return null;
  const configured = current.enabled || Object.values(current.settings).some((v) => v !== '' && v !== null && v !== undefined);
  return configured ? { id: null, reason: `provider ${item.payload.provider} is already configured` } : null;
}

function applyDefaults(env: AreaEnv, item: SourceItem<SubtitleProviderPayload>, onlyEmpty: boolean): void {
  const s = subtitleSettings(env);
  const seriesProfile = resolveProfile(env, (item.payload.settings['seriesProfile'] as number | null) ?? null);
  const movieProfile = resolveProfile(env, (item.payload.settings['movieProfile'] as number | null) ?? null);
  setSection(
    env.db,
    'subtitles',
    SubtitleSettings.parse({
      ...s,
      defaultSeriesProfileId: onlyEmpty && s.defaultSeriesProfileId !== null ? s.defaultSeriesProfileId : (seriesProfile ?? s.defaultSeriesProfileId),
      defaultMovieProfileId: onlyEmpty && s.defaultMovieProfileId !== null ? s.defaultMovieProfileId : (movieProfile ?? s.defaultMovieProfileId),
    }),
    env.now,
  );
}

// ---- assignments ------------------------------------------------------------------------------------

function assign(env: AreaEnv, media: ResolvedMedia, profileId: number): void {
  if (media.mediaType === 'series') env.db.update(t.series).set({ languageProfileId: profileId }).where(eq(t.series.id, media.id)).run();
  else env.db.update(t.movies).set({ languageProfileId: profileId }).where(eq(t.movies.id, media.id)).run();
}

function currentProfile(env: AreaEnv, media: ResolvedMedia): number | null {
  const row =
    media.mediaType === 'series'
      ? env.db.select({ p: t.series.languageProfileId }).from(t.series).where(eq(t.series.id, media.id)).get()
      : env.db.select({ p: t.movies.languageProfileId }).from(t.movies).where(eq(t.movies.id, media.id)).get();
  return row?.p ?? null;
}

function assignmentTarget(env: AreaEnv, item: SourceItem<SubtitleAssignmentPayload>): { media: ResolvedMedia; profileId: number } {
  const media = resolveMedia(env, item.payload);
  if (!media) throw new SkipItem(`${item.payload.mediaType === 'series' ? 'series' : 'movie'} is not in the Arclight library`);
  const profileId = resolveProfile(env, item.payload.sourceProfileId);
  if (profileId === null) throw new SkipItem(`subtitle profile ${item.payload.sourceProfileId} was not imported`);
  return { media, profileId };
}

// ---- history / blacklist ----------------------------------------------------------------------------

function eventExisting(env: AreaEnv, p: SubtitleEventPayload): Existing | null {
  if (p.kind === 'blacklist') {
    if (!p.provider || !p.subsId) return null;
    const row = env.db
      .select({ id: t.subtitleBlacklist.id })
      .from(t.subtitleBlacklist)
      .where(and(eq(t.subtitleBlacklist.provider, p.provider), eq(t.subtitleBlacklist.providerSubtitleId, p.subsId)))
      .get();
    return row ? { id: row.id, reason: 'already blacklisted' } : null;
  }
  if (!p.timestamp) return null;
  const row = env.db
    .select({ id: t.subtitleHistory.id, videoPath: t.subtitleHistory.videoPath, language: t.subtitleHistory.language })
    .from(t.subtitleHistory)
    .where(eq(t.subtitleHistory.date, p.timestamp))
    .all()
    .find((r) => r.language === p.language && (!p.videoPath || r.videoPath === p.videoPath));
  return row ? { id: row.id, reason: 'the same subtitle event exists' } : null;
}

function createEvent(env: AreaEnv, item: SourceItem<SubtitleEventPayload>): number {
  const p = item.payload;
  const file = resolveFile(env, p, p.videoPath);
  const media = resolveMedia(env, p);
  const seriesId = p.mediaType === 'series' ? (file?.seriesId ?? media?.id ?? null) : null;
  const movieId = p.mediaType === 'movie' ? (file?.movieId ?? media?.id ?? null) : null;
  const title = media?.title ?? p.title ?? item.name;
  if (p.kind === 'blacklist') {
    return env.db
      .insert(t.subtitleBlacklist)
      .values({ provider: p.provider!, providerSubtitleId: p.subsId!, language: p.language, forced: p.forced, hi: p.hi, mediaType: p.mediaType, seriesId, movieId, mediaFileId: file?.id ?? null, title, date: p.timestamp! })
      .returning({ id: t.subtitleBlacklist.id })
      .get().id;
  }
  const videoPath = p.videoPath ?? file?.path ?? null;
  if (!videoPath) throw new SkipItem('the video is not in the Arclight library');
  const score = p.score === null ? null : Math.round(p.score);
  return env.db
    .insert(t.subtitleHistory)
    .values({
      action: p.action,
      description: p.description || item.name,
      language: p.language,
      forced: p.forced,
      hi: p.hi,
      provider: p.provider,
      providerSubtitleId: p.subsId,
      score,
      // Bazarr's scale: 360 per episode, 120 per movie.
      scoreOutOf: score === null ? null : p.mediaType === 'series' ? 360 : 120,
      mediaType: p.mediaType,
      seriesId,
      movieId,
      episodeIds: episodeIdsOf(env, file?.id ?? null),
      mediaFileId: file?.id ?? null,
      title,
      subtitlePath: p.subtitlesPath,
      videoPath,
      matched: [],
      notMatched: [],
      date: p.timestamp!,
    })
    .returning({ id: t.subtitleHistory.id })
    .get().id;
}

// ---- handlers ---------------------------------------------------------------------------------------

export const SUBTITLE_HANDLERS: Handlers = {
  subtitleProfiles: {
    find: (env, item) => {
      const row = env.db.select({ id: t.languageProfiles.id }).from(t.languageProfiles).where(eq(t.languageProfiles.name, item.payload.name)).get();
      return row ? { id: row.id, reason: `subtitle profile "${item.payload.name}" exists` } : null;
    },
    create: (env, item) => env.db.insert(t.languageProfiles).values(profileValues(item.payload)).returning({ id: t.languageProfiles.id }).get().id,
    overwrite: (env, item, existing) => {
      env.db.update(t.languageProfiles).set(profileValues(item.payload)).where(eq(t.languageProfiles.id, existing.id!)).run();
      return existing.id;
    },
    merge: (_env, _item, existing) => existing.id,
  },

  subtitleAssignments: {
    find: (env, item) => {
      const media = resolveMedia(env, item.payload);
      if (!media) return null;
      const current = currentProfile(env, media);
      return current !== null ? { id: media.id, reason: `${media.title} already has a subtitle profile` } : null;
    },
    create: (env, item) => {
      const { media, profileId } = assignmentTarget(env, item);
      assign(env, media, profileId);
      return media.id;
    },
    overwrite: (env, item) => {
      const { media, profileId } = assignmentTarget(env, item);
      assign(env, media, profileId);
      return media.id;
    },
  },

  subtitleProviders: {
    find: (env, item) => providerExisting(env, item),
    create: (env, item) => {
      if (item.payload.kind === 'defaults') applyDefaults(env, item, false);
      else saveProvider(env, item.payload.provider as SubtitleProviderId, item.payload.settings, 'replace');
      return null;
    },
    overwrite: (env, item) => {
      if (item.payload.kind === 'defaults') applyDefaults(env, item, false);
      else saveProvider(env, item.payload.provider as SubtitleProviderId, item.payload.settings, 'merge');
      return null;
    },
    merge: (env, item) => {
      if (item.payload.kind === 'defaults') applyDefaults(env, item, true);
      else saveProvider(env, item.payload.provider as SubtitleProviderId, item.payload.settings, 'fill');
      return null;
    },
  },

  subtitleFiles: {
    find: (env, item) => {
      const row = env.db.select({ id: t.subtitleFiles.id }).from(t.subtitleFiles).where(eq(t.subtitleFiles.path, item.payload.subtitlePath)).get();
      return row ? { id: row.id, reason: 'the subtitle file is already indexed' } : null;
    },
    create: (env, item) => {
      const p = item.payload;
      if (!existsSync(p.subtitlePath)) throw new SkipItem(`${p.subtitlePath} is not on disk (check the path mappings)`);
      const file = resolveFile(env, p, p.videoPath);
      if (!file) throw new SkipItem('the video is not in the Arclight library');
      return env.db
        .insert(t.subtitleFiles)
        .values({ mediaFileId: file.id, language: p.language, forced: p.forced, hi: p.hi, path: p.subtitlePath, embedded: false, size: p.size, added: env.now })
        .returning({ id: t.subtitleFiles.id })
        .get().id;
    },
    overwrite: (env, item, existing) => {
      const p = item.payload;
      env.db.update(t.subtitleFiles).set({ language: p.language, forced: p.forced, hi: p.hi }).where(eq(t.subtitleFiles.id, existing.id!)).run();
      return existing.id;
    },
    merge: (_env, _item, existing) => existing.id,
  },

  subtitleHistory: {
    find: (env, item) => eventExisting(env, item.payload),
    create: (env, item) => createEvent(env, item),
    overwrite: (_env, _item, existing) => existing.id,
    merge: (_env, _item, existing) => existing.id,
  },
};
