import type { Scheduler } from '../../../scheduler.js';
import { MUSIC_PLAYLIST_SYNC_JOB, type MusicPlaylistService } from './service.js';

export { MUSIC_PLAYLIST_SYNC_JOB };

/** Hourly: syncs every enabled playlist whose own interval (hours) has passed. */
export function registerPlaylistJobs(scheduler: Scheduler, service: () => MusicPlaylistService): void {
  if (!scheduler.has(MUSIC_PLAYLIST_SYNC_JOB)) {
    scheduler.register({ name: MUSIC_PLAYLIST_SYNC_JOB, cron: '25 * * * *', handler: async ({ signal, log }) => service().syncDue(signal, log) });
  }
}
