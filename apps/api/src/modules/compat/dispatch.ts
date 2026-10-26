import { ManualImportRequest, qualityById, type ManualImportRequestInput, type QualityModel } from '@arclight/shared';
import type { AppContext } from '../../app.js';
import { getImportsService } from '../imports/index.js';
import { libraryService as lib } from '../library/index.js';
import { releasesServiceFor, type SearchSummary, type SearchTarget } from '../releases/index.js';
import type { CommandPlan, CommandResolver, CommandWork } from './commands.js';
import { CommandBodies } from './commands.js';
import { parseOr400, type Json } from './common.js';
import type { CompatMetadata } from './lookup.js';
import { languageCodeForId } from './quality.js';

// Upstream command names -> Arclight work. Names are matched case-insensitively; anything
// else that exactly names a registered scheduler job (e.g. `RssSync`, `HealthCheck`) runs it.

const summary = (r: SearchSummary): string =>
  `${r.releases} releases found, ${r.approved} approved, ${r.grabbed.length} grabbed${r.pending ? `, ${r.pending} pending` : ''}`;

const work = (fn: CommandWork): CommandPlan => ({ kind: 'work', work: fn });

function toQualityModel(raw: unknown): QualityModel | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const q = raw as { quality?: { id?: unknown }; revision?: { version?: unknown; real?: unknown; isRepack?: unknown } };
  const id = Number(q.quality?.id);
  if (!Number.isInteger(id)) return undefined;
  const def = qualityById(id);
  return {
    quality: { ...def, mediaTypes: [...def.mediaTypes] },
    revision: {
      version: Number(q.revision?.version) || 1,
      real: Number(q.revision?.real) || 0,
      isRepack: q.revision?.isRepack === true,
    },
  };
}

export function createCommandResolver(ctx: AppContext, metadata: CompatMetadata): CommandResolver {
  const db = ctx.db;
  const releases = () => releasesServiceFor(ctx);
  const imports = () => getImportsService(ctx);
  const job = (name: string): CommandPlan | null => (ctx.scheduler.has(name) ? { kind: 'job', job: name } : null);

  const searchAll = (targets: SearchTarget[]) =>
    work(async (signal) => {
      const parts: string[] = [];
      for (const target of targets) {
        if (signal.aborted) break;
        parts.push(summary(await releases().searchFor(target, { userInvoked: true, signal })));
      }
      return parts.join('; ');
    });

  const refreshSeries = async (id: number): Promise<string> => {
    const series = lib.getSeries(db, id, { includeStatistics: false });
    const meta = await metadata.lookupSeries(series.tmdbId);
    if (!meta) return `${series.title}: no longer found at TMDB`;
    lib.refreshSeriesMetadata(db, id, meta);
    ctx.bus.publish({ type: 'library', action: 'refreshed', mediaType: 'series', id });
    return `refreshed ${series.title}`;
  };

  const refreshMovie = async (id: number): Promise<string> => {
    const movie = lib.getMovie(db, id);
    const meta = await metadata.lookupMovie(movie.tmdbId);
    if (!meta) return `${movie.title}: no longer found at TMDB`;
    lib.refreshMovieMetadata(db, id, meta);
    ctx.bus.publish({ type: 'library', action: 'refreshed', mediaType: 'movie', id });
    return `refreshed ${movie.title}`;
  };

  const rescanText = (r: { scanned: number; added: unknown[]; removed: unknown[]; unmapped: unknown[] }) =>
    `${r.scanned} files scanned; ${r.added.length} added, ${r.removed.length} removed, ${r.unmapped.length} unmapped`;

  const renameText = (r: { renamed: unknown[]; failed: unknown[] }) => `${r.renamed.length} renamed, ${r.failed.length} failed`;

  return (name: string, body: Json): CommandPlan | null => {
    switch (name.toLowerCase()) {
      case 'seriessearch': {
        const b = parseOr400(CommandBodies.seriesId, body);
        return searchAll([{ seriesId: b.seriesId }]);
      }
      case 'seasonsearch': {
        const b = parseOr400(CommandBodies.season, body);
        return searchAll([{ seriesId: b.seriesId, seasonNumber: b.seasonNumber }]);
      }
      case 'episodesearch': {
        const b = parseOr400(CommandBodies.episodes, body);
        const bySeries = new Map<number, number[]>();
        for (const id of b.episodeIds) {
          const seriesId = lib.getEpisode(db, id).seriesId;
          bySeries.set(seriesId, [...(bySeries.get(seriesId) ?? []), id]);
        }
        return searchAll([...bySeries].map(([seriesId, episodeIds]) => ({ seriesId, episodeIds })));
      }
      case 'moviessearch':
      case 'moviesearch': {
        const b = parseOr400(CommandBodies.movies, body);
        return searchAll(b.movieIds.map((movieId) => ({ movieId })));
      }
      case 'missingepisodesearch':
        return job('MissingEpisodeSearch');
      case 'missingmoviessearch':
        return job('MissingMovieSearch');
      case 'cutoffunmetepisodesearch':
      case 'cutoffunmetmoviessearch':
        return job('CutoffUnmetSearch');
      case 'rsssync':
        return job('RssSync');
      case 'refreshseries': {
        const b = parseOr400(CommandBodies.optionalSeriesId, body);
        const ids = [...(b.seriesIds ?? []), ...(b.seriesId !== undefined ? [b.seriesId] : [])];
        if (ids.length === 0) return job('RefreshSeries');
        return work(async () => (await Promise.all(ids.map(refreshSeries))).join('; '));
      }
      case 'refreshmovie': {
        const b = parseOr400(CommandBodies.optionalMovies, body);
        const ids = [...(b.movieIds ?? []), ...(b.movieId !== undefined ? [b.movieId] : [])];
        if (ids.length === 0) return job('RefreshMovie');
        return work(async () => (await Promise.all(ids.map(refreshMovie))).join('; '));
      }
      case 'rescanseries': {
        const b = parseOr400(CommandBodies.optionalSeriesId, body);
        const id = b.seriesId;
        return work(async () => rescanText(id !== undefined ? await imports().rescanSeries(id) : await imports().rescanAll('series')));
      }
      case 'rescanmovie': {
        const b = parseOr400(CommandBodies.optionalMovies, body);
        const id = b.movieId ?? b.movieIds?.[0];
        return work(async () => rescanText(id !== undefined ? await imports().rescanMovie(id) : await imports().rescanAll('movie')));
      }
      case 'renamefiles': {
        if (body['movieId'] !== undefined) {
          const b = parseOr400(CommandBodies.renameMovie, body);
          return work(async () => renameText(await imports().executeRename({ movieId: b.movieId, ...(b.files ? { files: b.files } : {}) })));
        }
        const b = parseOr400(CommandBodies.renameSeries, body);
        return work(async () => renameText(await imports().executeRename({ seriesId: b.seriesId, ...(b.files ? { files: b.files } : {}) })));
      }
      case 'renameseries': {
        const b = parseOr400(CommandBodies.renameSeriesMany, body);
        return work(async () => {
          const out: string[] = [];
          for (const seriesId of b.seriesIds) out.push(renameText(await imports().executeRename({ seriesId })));
          return out.join('; ');
        });
      }
      case 'renamemovie': {
        const b = parseOr400(CommandBodies.renameMovieMany, body);
        return work(async () => {
          const out: string[] = [];
          for (const movieId of b.movieIds) out.push(renameText(await imports().executeRename({ movieId })));
          return out.join('; ');
        });
      }
      case 'downloadedepisodesscan':
      case 'downloadedmoviesscan':
      case 'refreshmonitoreddownloads':
        return job('RefreshQueue');
      case 'manualimport': {
        const b = parseOr400(CommandBodies.manualImport, body);
        const mode = (b.importMode ?? 'auto').toLowerCase();
        const request: ManualImportRequestInput = {
          importMode: mode === 'move' || mode === 'copy' ? mode : 'auto',
          items: b.files.map((f) => {
            const quality = toQualityModel(f.quality);
            const languages = f.languages?.map((l) => languageCodeForId(l.id)).filter((c): c is string => c !== undefined);
            return {
              path: f.path,
              mediaType: f.movieId !== undefined ? ('movie' as const) : ('series' as const),
              ...(f.seriesId !== undefined ? { seriesId: f.seriesId } : {}),
              ...(f.seasonNumber !== undefined ? { seasonNumber: f.seasonNumber } : {}),
              ...(f.episodeIds ? { episodeIds: f.episodeIds } : {}),
              ...(f.movieId !== undefined ? { movieId: f.movieId } : {}),
              ...(quality ? { quality } : {}),
              ...(languages?.length ? { languages } : {}),
              ...(f.releaseGroup !== undefined ? { releaseGroup: f.releaseGroup } : {}),
              ...(f.downloadId ? { downloadId: f.downloadId } : {}),
            };
          }),
        };
        const parsed = parseOr400(ManualImportRequest, request);
        return work(async () => {
          const r = await imports().executeManualImport(parsed);
          return `${r.imported.length} imported, ${r.failed.length} failed`;
        });
      }
      case 'checkhealth':
      case 'healthcheck':
        return job('HealthCheck');
      default:
        return job(name);
    }
  };
}
