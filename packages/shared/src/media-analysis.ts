import { z } from 'zod';

// Media analysis (ffprobe) contract: the analyze command and the queue summary. The analysis
// result itself is `MediaInfo` on the media file (library.ts).

export const AnalyzeCommand = z
  .object({
    seriesId: z.number().int().positive().optional(),
    movieId: z.number().int().positive().optional(),
    all: z.boolean().optional(),
    /** Re-analyze files that already have media info. Default true for a series/movie, false for `all`. */
    force: z.boolean().optional(),
  })
  .refine((c) => [c.seriesId !== undefined, c.movieId !== undefined, c.all === true].filter(Boolean).length === 1, {
    message: 'exactly one of seriesId, movieId or all: true is required',
  });
export type AnalyzeCommand = z.infer<typeof AnalyzeCommand>;

export const AnalyzeResult = z.object({
  /** Media files put (back) on the queue. */
  queued: z.number().int(),
  /** False when ffprobe is missing: the files stay queued until it is installed. */
  ffprobeAvailable: z.boolean(),
});
export type AnalyzeResult = z.infer<typeof AnalyzeResult>;

export const MediaAnalysisStatus = z.enum(['pending', 'running', 'done', 'failed']);
export type MediaAnalysisStatus = z.infer<typeof MediaAnalysisStatus>;

export const MediaAnalysisQueueSummary = z.object({
  ffprobePath: z.string().nullable(),
  concurrency: z.number().int(),
  pending: z.number().int(),
  running: z.number().int(),
  done: z.number().int(),
  failed: z.number().int(),
  /** Most recent failures (newest first). */
  recentFailures: z.array(
    z.object({ mediaFileId: z.number().int(), path: z.string().nullable(), error: z.string(), finishedAt: z.string().nullable() }),
  ),
});
export type MediaAnalysisQueueSummary = z.infer<typeof MediaAnalysisQueueSummary>;
