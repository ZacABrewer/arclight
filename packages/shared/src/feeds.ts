import { z } from 'zod';

// Self-updating data feeds (guides, indexer definitions, and whatever other modules register
// through the api's feeds registry). GET /system/feeds summarises them; the health checks
// warn when an enabled feed has not succeeded for three intervals.

export const FeedState = z.enum(['ok', 'stale', 'error', 'never', 'disabled', 'unregistered']);
export type FeedState = z.infer<typeof FeedState>;

export const FeedSummary = z.object({
  id: z.string(),
  name: z.string(),
  /** False for a known feed whose module is not loaded (a placeholder). */
  registered: z.boolean(),
  enabled: z.boolean(),
  /**
   * ok: last attempt succeeded and is recent. stale: no success for 3 intervals. error: the
   * last attempt failed (but a success is still recent). never: enabled, not synced yet.
   */
  state: FeedState,
  /** Sync interval in ms; null when on demand only or unknown. */
  intervalMs: z.number().int().nullable(),
  /** Stale after this long without a successful sync (3x the interval). */
  staleAfterMs: z.number().int().nullable(),
  lastSyncAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastError: z.string().nullable(),
  /** Pending changes waiting for the user, if the feed has such a notion. */
  pending: z.number().int().nullable(),
  /** One line about the feed's content (e.g. `8 definitions`). */
  detail: z.string().nullable(),
});
export type FeedSummary = z.infer<typeof FeedSummary>;

export const FeedsResponse = z.object({ feeds: z.array(FeedSummary) });
export type FeedsResponse = z.infer<typeof FeedsResponse>;
