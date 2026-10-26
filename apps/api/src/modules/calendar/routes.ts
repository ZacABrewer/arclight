import { z } from 'zod';
import { CalendarErrorResponse, CalendarFeedInfo, CalendarFeedQuery, CalendarItem, CalendarQuery } from '@media-tron/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { renderIcs } from './ics.js';
import { CalendarError, type CalendarService } from './service.js';

const DAY_MS = 24 * 60 * 60_000;
const statusFor: Record<CalendarError['code'], number> = { VALIDATION: 400, UNAUTHORIZED: 401 };

export function calendarRoutes(
  service: CalendarService,
  now: () => Date = () => new Date(),
): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof CalendarError) {
        return reply.code(statusFor[err.code]).send({ error: err.message, code: err.code });
      }
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error(err);
      return reply.code(500).send({ error: 'internal error', code: 'INTERNAL' });
    });

    app.get(
      '/calendar',
      { schema: { querystring: CalendarQuery, response: { 200: z.array(CalendarItem), 400: CalendarErrorResponse } } },
      async (req) => service.list(req.query),
    );

    // Calendar apps cannot send headers, so the feed authenticates with a per-install token.
    app.get(
      '/calendar/feed.ics',
      { schema: { querystring: CalendarFeedQuery } },
      async (req, reply) => {
        service.verifyToken(req.query.token);
        const t = now().getTime();
        const items = service.list({
          start: new Date(t - req.query.pastDays * DAY_MS).toISOString(),
          end: new Date(t + req.query.futureDays * DAY_MS).toISOString(),
          unmonitored: req.query.unmonitored,
          includeSeries: true,
          includeEpisodeFile: false,
          tags: req.query.tags,
        });
        return reply
          .header('content-type', 'text/calendar; charset=utf-8')
          .header('content-disposition', 'inline; filename="media-tron.ics"')
          .send(renderIcs(items, { now: now() }));
      },
    );

    app.get('/calendar/feed', { schema: { response: { 200: CalendarFeedInfo } } }, async () => {
      const token = service.icsToken();
      return { token, path: `/api/v1/calendar/feed.ics?token=${token}` };
    });
  };
}
