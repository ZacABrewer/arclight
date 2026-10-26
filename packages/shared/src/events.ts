import { z } from 'zod';
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
    mediaType: z.enum(['series', 'movie']).optional(),
    mediaId: z.number().int().optional(),
    message: z.string().optional(),
  }),
  z.object({ type: z.literal('indexer'), action: z.enum(['failed', 'recovered']), id: z.number().int(), name: z.string() }),
  z.object({ type: z.literal('history'), action: z.enum(['added']) }),
  z.object({ type: z.literal('settings'), section: z.string() }),
  z.object({ type: z.literal('vpn'), status: VpnStatus }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;
