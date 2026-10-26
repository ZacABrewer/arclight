import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { parsePath, parseRelease, type ParsedRelease } from '@arclight/parser';
import {
  SceneMappingInput,
  type MediaFile,
  type SceneMapping,
  type SceneMappingApplyResult,
  type SceneMappingValues,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import type { EventBus } from '../../events.js';
import { libraryService } from '../library/index.js';
import { mapSeriesEpisodes } from '../releases/matcher.js';
import type { SceneRule } from './mapping.js';
import { sceneMappings } from './schema.js';

// Per-series scene mapping rules: CRUD for the manual editor, the rule loader the release
// matcher reads, and "apply to existing files" (re-link library files to the episodes their
// names map to under the current rules).

export class SceneMappingError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'VALIDATION' | 'UPSTREAM',
    message: string,
  ) {
    super(message);
    this.name = 'SceneMappingError';
  }
}

type Row = typeof sceneMappings.$inferSelect;

function toMapping(row: Row): SceneMapping {
  return { ...row };
}

/**
 * Every rule, or none when the table does not exist yet (module loaded before its migration):
 * the matcher must keep working without scene mappings.
 */
export function loadSceneRules(db: Db, log?: Logger): SceneRule[] {
  try {
    return db.select().from(sceneMappings).all();
  } catch (err) {
    log?.debug({ err }, 'scene mappings unavailable');
    return [];
  }
}

export interface RescanSummary {
  scanned: number;
  added: unknown[];
  unmapped: unknown[];
}

export interface SceneMappingServiceOptions {
  db: Db;
  bus?: EventBus;
  log?: Logger;
  /** The imports rescan of one series, run after re-linking (picks up files that now map). */
  rescan?: (seriesId: number) => Promise<RescanSummary>;
}

export class SceneMappingService {
  private readonly db: Db;
  private readonly bus: EventBus | undefined;
  private readonly log: Logger | undefined;
  private rescan: ((seriesId: number) => Promise<RescanSummary>) | undefined;

  constructor(opts: SceneMappingServiceOptions) {
    this.db = opts.db;
    this.bus = opts.bus;
    this.log = opts.log;
    this.rescan = opts.rescan;
  }

  setRescan(rescan: ((seriesId: number) => Promise<RescanSummary>) | undefined): void {
    this.rescan = rescan;
  }

  private requireSeries(seriesId: number) {
    return libraryService.getSeries(this.db, seriesId, { includeStatistics: false });
  }

  // ---- CRUD ---------------------------------------------------------------------------

  /** Rules of a series: manual first, then feed; by kind and scene numbers. */
  list(seriesId: number): SceneMapping[] {
    this.requireSeries(seriesId);
    const kindOrder = { season: 0, absolute: 1, title: 2 } as const;
    return this.db
      .select()
      .from(sceneMappings)
      .where(eq(sceneMappings.seriesId, seriesId))
      .all()
      .sort(
        (a, b) =>
          (a.source === b.source ? 0 : a.source === 'manual' ? -1 : 1) ||
          kindOrder[a.kind] - kindOrder[b.kind] ||
          (a.sceneSeason ?? -1) - (b.sceneSeason ?? -1) ||
          (a.sceneEpisode ?? a.sceneAbsolute ?? -1) - (b.sceneEpisode ?? b.sceneAbsolute ?? -1) ||
          a.id - b.id,
      )
      .map(toMapping);
  }

  get(seriesId: number, id: number): SceneMapping {
    const row = this.db
      .select()
      .from(sceneMappings)
      .where(and(eq(sceneMappings.id, id), eq(sceneMappings.seriesId, seriesId)))
      .get();
    if (!row) throw new SceneMappingError('NOT_FOUND', `Scene mapping ${id} not found for series ${seriesId}`);
    return toMapping(row);
  }

  create(seriesId: number, input: SceneMappingValues): SceneMapping {
    this.requireSeries(seriesId);
    const values = this.validate(input);
    const row = this.db
      .insert(sceneMappings)
      .values({ ...values, seriesId, source: 'manual' })
      .returning()
      .get();
    return toMapping(row);
  }

  /** Feed rules are read-only (the next sync would overwrite them); add a manual rule instead. */
  update(seriesId: number, id: number, input: SceneMappingValues): SceneMapping {
    const current = this.get(seriesId, id);
    if (current.source !== 'manual') throw new SceneMappingError('VALIDATION', 'Feed mappings are read-only; add a manual mapping to override it');
    const values = this.validate(input);
    const row = this.db.update(sceneMappings).set(values).where(eq(sceneMappings.id, id)).returning().get();
    return toMapping(row!);
  }

  delete(seriesId: number, id: number): void {
    const current = this.get(seriesId, id);
    if (current.source !== 'manual') throw new SceneMappingError('VALIDATION', 'Feed mappings are read-only; add a manual mapping to override it');
    this.db.delete(sceneMappings).where(eq(sceneMappings.id, id)).run();
  }

  /** Library deletion of a series drops its rules. */
  deleteForSeries(seriesId: number): void {
    try {
      this.db.delete(sceneMappings).where(eq(sceneMappings.seriesId, seriesId)).run();
    } catch (err) {
      this.log?.debug({ err }, 'scene mappings unavailable');
    }
  }

  private validate(input: SceneMappingValues) {
    const parsed = SceneMappingInput.safeParse(input);
    if (!parsed.success) throw new SceneMappingError('VALIDATION', parsed.error.issues.map((i) => i.message).join('; '));
    const v = parsed.data;
    return {
      kind: v.kind,
      sceneSeason: v.sceneSeason,
      sceneEpisode: v.sceneEpisode,
      sceneAbsolute: v.sceneAbsolute,
      tvdbSeason: v.tvdbSeason,
      tvdbEpisode: v.tvdbEpisode,
      tvdbAbsolute: v.tvdbAbsolute,
      sceneTitle: v.sceneTitle,
      comment: v.comment,
    };
  }

  // ---- apply to existing files --------------------------------------------------------

  /**
   * Re-map the series's library files under the current rules: each file's scene name (else its
   * path) is parsed and mapped; files whose episodes change are re-registered with the new links
   * (the bytes on disk are untouched). A file is skipped when it maps to nothing or to episodes
   * another file keeps. Then the imports rescan picks up files that previously did not map.
   */
  async applyToFiles(seriesId: number): Promise<SceneMappingApplyResult> {
    const series = this.requireSeries(seriesId);
    const episodes = libraryService.listEpisodes(this.db, { seriesId });
    const rules = loadSceneRules(this.db, this.log).filter((r) => r.seriesId === seriesId);
    const files = libraryService.listMediaFiles(this.db, { seriesId });

    const out: SceneMappingApplyResult = { checked: files.length, remapped: [], unchanged: 0, skipped: [], rescan: null };
    const plans: Array<{ file: MediaFile; to: number[] }> = [];
    for (const file of files) {
      const parsed = parseFileName(file);
      const mapped = parsed ? mapSeriesEpisodes(parsed, series, episodes, rules) : null;
      const to = mapped ? mapped.episodes.map((e) => e.id) : [];
      if (to.length === 0) {
        out.skipped.push({ mediaFileId: file.id, path: file.path, reason: 'name does not map to an episode' });
        continue;
      }
      if (sameSet(to, file.episodeIds)) {
        out.unchanged++;
        continue;
      }
      plans.push({ file, to });
    }

    // Episodes kept by files that are not moving may not be taken; two moving files may not
    // claim the same episode. Repeat until stable, since a skipped file keeps its episodes.
    const fixed = new Set(files.filter((f) => !plans.some((p) => p.file.id === f.id)).flatMap((f) => f.episodeIds));
    let accepted = plans;
    for (;;) {
      const claims = new Map<number, number>();
      for (const p of accepted) for (const id of p.to) claims.set(id, (claims.get(id) ?? 0) + 1);
      const next = accepted.filter((p) => p.to.every((id) => !fixed.has(id) && claims.get(id) === 1));
      if (next.length === accepted.length) break;
      for (const p of accepted) if (!next.includes(p)) for (const id of p.file.episodeIds) fixed.add(id);
      accepted = next;
    }
    for (const p of plans) {
      if (!accepted.includes(p)) out.skipped.push({ mediaFileId: p.file.id, path: p.file.path, reason: 'mapped episodes belong to another file' });
    }

    for (const p of accepted) await libraryService.deleteMediaFile(this.db, p.file.id, { deleteFromDisk: false });
    for (const p of accepted) {
      const f = p.file;
      const seasonNumber = episodes.find((e) => e.id === p.to[0])!.seasonNumber;
      const { file } = libraryService.addMediaFile(this.db, {
        mediaType: 'series',
        seriesId,
        seasonNumber,
        episodeIds: p.to,
        relativePath: f.relativePath,
        path: f.path,
        sizeBytes: f.sizeBytes,
        dateAdded: f.dateAdded,
        quality: f.quality,
        languages: f.languages,
        releaseGroup: f.releaseGroup ?? null,
        sceneName: f.sceneName ?? null,
        edition: f.edition ?? null,
        ...(f.mediaInfo ? { mediaInfo: f.mediaInfo } : {}),
      });
      out.remapped.push({ mediaFileId: f.id, newMediaFileId: file.id, path: f.path, fromEpisodeIds: f.episodeIds, toEpisodeIds: p.to });
    }
    if (accepted.length > 0) {
      this.log?.info({ seriesId, remapped: accepted.length }, 'scene mappings applied to library files');
      this.bus?.publish({ type: 'library', action: 'fileAdded', mediaType: 'series', id: seriesId });
    }

    if (this.rescan) {
      try {
        const r = await this.rescan(seriesId);
        out.rescan = { scanned: r.scanned, added: r.added.length, unmapped: r.unmapped.length };
      } catch (err) {
        this.log?.warn({ err, seriesId }, 'rescan after applying scene mappings failed');
      }
    }
    return out;
  }
}

/** The release name a file came from (scene name), else its path. */
function parseFileName(file: MediaFile): ParsedRelease | null {
  if (file.sceneName) {
    const fromScene = parseRelease(file.sceneName, 'series');
    if (fromScene.series) return fromScene;
  }
  const fromPath = parsePath(file.path, 'series');
  return fromPath.series ? fromPath : null;
}

function sameSet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}
