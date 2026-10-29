import { z } from 'zod';
import { DownloadEvent } from './download-clients.js';
import { Job } from './jobs.js';
import { HealthResponse } from './system.js';
import { VpnStatus } from './vpn.js';

// Messages pushed over the WebSocket feed at /api/v1/events. Discriminated on `type` so the
// web client can switch exhaustively. Payloads carry ids, not whole resources: the client
// refetches what it shows.
export const ServerEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), serverTime: z.string().datetime() }),
  z.object({ type: z.literal('job'), job: Job }),
  z.object({ type: z.literal('health'), health: HealthResponse }),
  z.object({
    type: z.literal('library'),
    action: z.enum(['added', 'updated', 'deleted', 'fileAdded', 'fileDeleted', 'refreshed']),
    mediaType: z.enum(['series', 'movie']),
    id: z.number().int(),
  }),
  z.object({ type: z.literal('queue'), action: z.enum(['changed']) }),
  /** A new entry on a tracked download's timeline (GET /queue/:id/timeline). */
  z.object({ type: z.literal('download'), action: z.literal('event'), event: DownloadEvent }),
  /**
   * The built-in torrent engine entered or left lockdown (VPN kill switch). `infoHashes` are the
   * torrents it paused (lockdown) or resumed (unlocked) with this transition.
   */
  z.object({
    type: z.literal('torrent'),
    action: z.enum(['lockdown', 'unlocked']),
    reason: z.string().optional(),
    infoHashes: z.array(z.string()),
  }),
  z.object({
    type: z.literal('release'),
    action: z.enum(['grabbed', 'rejected', 'pending']),
    title: z.string(),
    mediaType: z.enum(['series', 'movie']).optional(),
    mediaId: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('import'),
    action: z.enum(['imported', 'failed', 'manualRequired']),
    title: z.string(),
    /** Music imports carry the artist id as `mediaId` and the album in `albumIds`. */
    mediaType: z.enum(['series', 'movie', 'music', 'audiobook']).optional(),
    mediaId: z.number().int().optional(),
    albumIds: z.array(z.number().int()).optional(),
    message: z.string().optional(),
  }),
  z.object({ type: z.literal('indexer'), action: z.enum(['failed', 'recovered']), id: z.number().int(), name: z.string() }),
  z.object({ type: z.literal('history'), action: z.enum(['added']) }),
  z.object({ type: z.literal('settings'), section: z.string() }),
  z.object({ type: z.literal('vpn'), status: VpnStatus }),
  z.object({
    type: z.literal('subtitle'),
    action: z.enum(['downloaded', 'upgraded', 'deleted', 'uploaded', 'synced', 'scanned', 'blacklisted', 'profiles', 'settings']),
    mediaType: z.enum(['series', 'movie']).optional(),
    mediaId: z.number().int().optional(),
    mediaFileId: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('request'),
    action: z.enum(['created', 'updated', 'approved', 'declined', 'failed', 'completed', 'deleted']),
    id: z.number().int(),
    /** true: `id` is a music/audiobook request (`/audiorequest/:id`), not a video request. */
    audio: z.boolean().optional(),
  }),
  /** A daily summary was stored (GET /summary/latest). */
  z.object({ type: z.literal('summary'), action: z.literal('generated'), id: z.number().int() }),
  z.object({ type: z.literal('issue'), action: z.enum(['created', 'updated', 'deleted']), id: z.number().int() }),
  /** A quality profile or custom format was created, edited or deleted. */
  z.object({
    type: z.literal('profile'),
    action: z.enum(['created', 'updated', 'deleted']),
    kind: z.enum(['quality', 'customFormat']),
    id: z.number().int(),
  }),
  /** File-fit statuses or the profile-migration work list changed (GET /profilemigration/*). */
  z.object({ type: z.literal('profileMigration'), action: z.literal('changed') }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;
