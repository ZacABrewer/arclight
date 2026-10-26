import type { DecisionLogBatch, DecisionLogEntry, QualityModel } from '@arclight/shared';

// Test fixtures for the decision log (shape of packages/shared DecisionLog*).

export const webdl1080: QualityModel = {
  quality: { id: 9, name: 'WEBDL-1080p', source: 'web', resolution: 1080, modifier: 'none', weight: 15, mediaTypes: ['series', 'movie'] },
  revision: { version: 1, real: 0, isRepack: false },
} as QualityModel;

export function makeDecision(over: Partial<DecisionLogEntry> = {}): DecisionLogEntry {
  return {
    id: 1,
    batchId: 'b-1',
    time: '2026-10-25T10:00:00.000Z',
    source: 'search',
    mediaType: 'series',
    seriesId: 1,
    episodeIds: [12],
    movieId: null,
    guid: `guid-${over.id ?? 1}`,
    indexerId: 3,
    title: 'Show.S01E02.1080p.WEB-DL-GRP',
    quality: webdl1080,
    formats: [],
    score: 0,
    approved: true,
    rejections: [],
    chosen: false,
    rank: 1,
    ...over,
  };
}

export function makeBatch(over: Partial<DecisionLogBatch> = {}): DecisionLogBatch {
  return {
    batchId: 'b-1',
    time: '2026-10-25T10:00:00.000Z',
    source: 'search',
    total: 3,
    approved: 2,
    grabbed: true,
    winnerId: 1,
    decisions: [
      makeDecision({ id: 1, rank: 1, chosen: true, title: 'Show.S01E02.1080p.WEB-DL-WINNER', formats: [{ id: 4, name: 'x265' }], score: 120 }),
      makeDecision({ id: 2, rank: 2, title: 'Show.S01E02.720p.HDTV-SECOND', score: 10 }),
      makeDecision({
        id: 3,
        rank: 3,
        approved: false,
        title: 'Show.S01E02.CAM-BAD',
        rejections: [
          { reason: 'qualityNotWanted', message: 'CAM is not wanted in profile', type: 'permanent' },
          { reason: 'delay', message: 'Waiting for the delay profile', type: 'temporary' },
        ],
      }),
    ],
    ...over,
  };
}
