import { z } from 'zod';
import { Job } from './jobs.js';
import { HealthResponse } from './system.js';

// Messages pushed over the WebSocket feed at /api/v1/events. Discriminated on `type` so the
// web client can switch exhaustively.
export const ServerEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), serverTime: z.string().datetime() }),
  z.object({ type: z.literal('job'), job: Job }),
  z.object({ type: z.literal('health'), health: HealthResponse }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;
