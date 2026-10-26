import type { Scheduler } from '../../scheduler.js';
import type { SceneMappingFeed } from './feed.js';

export const SCENE_MAPPING_SYNC_JOB = 'SceneMappingSync';

export function registerSceneMappingJobs(scheduler: Scheduler, feed: SceneMappingFeed): void {
  scheduler.register({
    name: SCENE_MAPPING_SYNC_JOB,
    cron: '23 5 * * *',
    handler: async ({ signal }) => {
      const s = await feed.sync({ signal });
      if (s.notPublished && s.lastSuccessAt === null) return 'scene mapping feed not published yet';
      return `scene mappings: ${s.mappings} for ${s.matchedSeries} series${s.rejected ? `, ${s.rejected} rejected` : ''}`;
    },
  });
}
