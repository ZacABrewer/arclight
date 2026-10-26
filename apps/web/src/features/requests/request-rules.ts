import type { RequestsSettings, TitleDetail, TitleSeason } from '@arclight/shared';
import { MEDIA_STATUS_META, REQUEST_STATUS_META } from './status.js';

/** Why a season cannot be requested on a track, or null when it can. */
export function seasonBlocker(season: TitleSeason, is4k: boolean): string | null {
  const status = is4k ? season.status4k : season.status;
  const requestStatus = is4k ? season.requestStatus4k : season.requestStatus;
  if (status !== 'unknown') return MEDIA_STATUS_META[status].label;
  if (requestStatus && requestStatus !== 'declined' && requestStatus !== 'failed') return REQUEST_STATUS_META[requestStatus].label;
  return null;
}

/** Whether the 4K option applies to this title. */
export function show4kToggle(title: Pick<TitleDetail, 'mediaType' | 'canRequest4k'>, settings: RequestsSettings | undefined): boolean {
  if (!title.canRequest4k || !settings) return false;
  return title.mediaType === 'movie' ? settings.movie4k.enabled : settings.series4k.enabled;
}
