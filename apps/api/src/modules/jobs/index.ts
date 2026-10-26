import { z } from 'zod';
import { Job, RunJobRequest, ScheduledJob } from '@arclight/shared';
import type { AppModule } from '../../app.js';

export const jobsModule: AppModule = (ctx) => async (app) => {
  app.get('/jobs', { schema: { response: { 200: z.array(Job) } } }, async () => ctx.scheduler.listRecent());

  app.get('/jobs/scheduled', { schema: { response: { 200: z.array(ScheduledJob) } } }, async () =>
    ctx.scheduler.listScheduled(),
  );

  app.post(
    '/jobs/run',
    { schema: { body: RunJobRequest, response: { 202: Job, 404: z.object({ error: z.string() }) } } },
    async (req, reply) => {
      if (!ctx.scheduler.has(req.body.name)) {
        return reply.code(404).send({ error: `unknown job: ${req.body.name}` });
      }
      // Fire and return; progress arrives over the event feed.
      const job = ctx.scheduler.run(req.body.name, 'manual');
      return reply.code(202).send(await job);
    },
  );
};
