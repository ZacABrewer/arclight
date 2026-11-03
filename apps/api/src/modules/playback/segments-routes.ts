import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { ScanSegmentsRequest, ScanSegmentsResponse, SeasonSegmentsResponse, SetVideoSegmentsRequest, type VideoSegment } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { episodes, mediaFiles, series } from '../library/schema.js';
import { playerSettings } from './access.js';
import { clearManualSegments, setManualSegments, type SegmentService } from './segments.js';
import { segmentsFromChapters } from './video-info.js';
import type { ChapterReader } from './video-items.js';

// Admin routes for intro / credits / recap segments: a season's effective segments per episode,
// manual edits (which win over chapters and detection), and re-scanning a season. Admin-only
// (no config.access), like the library edit routes.

export interface SegmentRouteDeps {
  db: Db;
  service: SegmentService;
  chapters: ChapterReader;
  now?: () => number;
}

const ErrorBody = z.object({ error: z.string(), code: z.string() });
const errors = { 400: ErrorBody, 404: ErrorBody, 409: ErrorBody };
const SeasonParams = z.object({ seriesId: z.coerce.number().int().positive(), seasonNumber: z.coerce.number().int().min(0) });
const FileParams = z.object({ mediaFileId: z.coerce.number().int().positive() });

export function segmentRoutes(deps: SegmentRouteDeps): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  const { db } = deps;
  const now = deps.now ?? Date.now;

  const chaptersOf = async (f: { id: number; path: string; durationMs: number }): Promise<VideoSegment[]> => {
    const row = db.select({ id: mediaFiles.id, path: mediaFiles.path, sizeBytes: mediaFiles.sizeBytes }).from(mediaFiles).where(eq(mediaFiles.id, f.id)).get();
    if (!row) return [];
    return segmentsFromChapters(await deps.chapters.read(row, f.durationMs));
  };

  return async (app) => {
    app.get('/playback/segments/series/:seriesId/season/:seasonNumber', { schema: { params: SeasonParams, response: { 200: SeasonSegmentsResponse, ...errors } } }, async (req, reply) => {
      const { seriesId, seasonNumber } = req.params;
      if (!db.select({ id: series.id }).from(series).where(eq(series.id, seriesId)).get()) return reply.code(404).send({ error: `series ${seriesId} not found`, code: 'NOT_FOUND' });
      return deps.service.season(seriesId, seasonNumber, chaptersOf);
    });

    app.put('/playback/segments/file/:mediaFileId', { schema: { params: FileParams, body: SetVideoSegmentsRequest, response: { 204: z.null(), ...errors } } }, async (req, reply) => {
      const id = req.params.mediaFileId;
      if (!db.select({ id: mediaFiles.id }).from(mediaFiles).where(eq(mediaFiles.id, id)).get()) return reply.code(404).send({ error: `video file ${id} not found`, code: 'NOT_FOUND' });
      setManualSegments(db, id, req.body.segments, new Date(now()).toISOString());
      return reply.code(204).send(null);
    });

    app.delete('/playback/segments/file/:mediaFileId', { schema: { params: FileParams, response: { 204: z.null(), ...errors } } }, async (req, reply) => {
      clearManualSegments(db, req.params.mediaFileId);
      return reply.code(204).send(null);
    });

    app.post('/playback/segments/scan', { schema: { body: ScanSegmentsRequest, response: { 202: ScanSegmentsResponse, ...errors } } }, async (req, reply) => {
      if (!playerSettings(db).segmentDetection) return reply.code(409).send({ error: 'intro and credits detection is turned off (Settings → Player)', code: 'DETECTION_OFF' });
      const { seriesId, seasonNumber } = req.body;
      if (!db.select({ id: series.id }).from(series).where(eq(series.id, seriesId)).get()) return reply.code(404).send({ error: `series ${seriesId} not found`, code: 'NOT_FOUND' });
      let seasons: number[];
      if (seasonNumber !== undefined) seasons = [seasonNumber];
      else {
        const rows = db
          .selectDistinct({ seasonNumber: episodes.seasonNumber })
          .from(episodes)
          .where(and(eq(episodes.seriesId, seriesId), isNotNull(episodes.episodeFileId)))
          .all();
        seasons = rows.map((r) => r.seasonNumber).sort((a, b) => a - b);
      }
      let queued = 0;
      for (const n of seasons) {
        deps.service.enqueue(seriesId, n, true);
        queued++;
      }
      return reply.code(202).send({ queued });
    });
  };
}
