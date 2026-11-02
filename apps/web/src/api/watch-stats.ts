import { z } from 'zod';
import { LibraryGrowth, NewsletterPreview, NewsletterRun, PlaybackStats, WatchStatsSettings, Wrapped, WrappedShare, type WrappedShareCreate } from '@arclight/shared';
import { ApiError, buildUrl, request } from './client.js';

// Paths mirror apps/api/src/modules/watch-stats/routes.ts (playback stats, Year in review,
// share links, the newsletter and the watch stats settings).

export const NewsletterOverview = z.object({ preview: NewsletterPreview, runs: z.array(NewsletterRun) });
export type NewsletterOverview = z.infer<typeof NewsletterOverview>;

export interface WrappedParams {
  year?: number | undefined;
  userId?: number | undefined;
}

/** "name-2026.svg" from a Content-Disposition header, else a plain fallback. */
export function attachmentName(header: string | null, fallback: string): string {
  const m = header ? /filename="?([^";]+)"?/i.exec(header) : null;
  return m?.[1] ?? fallback;
}

export interface StatsQuery { days: number; userId?: number | undefined; serverId?: string | undefined }

export const watchStatsApi = {
  stats: (query: StatsQuery) => request('/watchstats', PlaybackStats, { query: { days: query.days, userId: query.userId, serverId: query.serverId } }),
  growth: (days: number) => request('/watchstats/growth', LibraryGrowth, { query: { days } }),
  wrapped: (params: WrappedParams) => request('/watchstats/wrapped', Wrapped, { query: { year: params.year, userId: params.userId } }),
  shares: (userId?: number) => request('/watchstats/wrapped/shares', WrappedShare.array(), { query: { userId } }),
  createShare: (body: WrappedShareCreate) => request('/watchstats/wrapped/shares', WrappedShare, { method: 'POST', json: body }),
  revokeShare: (id: number) => request(`/watchstats/wrapped/shares/${id}`, null, { method: 'DELETE' }),
  settings: () => request('/settings/watchstats', WatchStatsSettings),
  saveSettings: (body: WatchStatsSettings) => request('/settings/watchstats', WatchStatsSettings, { method: 'PUT', json: body }),
  newsletter: () => request('/watchstats/newsletter', NewsletterOverview),
  sendNewsletter: () => request('/watchstats/newsletter/send', NewsletterRun, { method: 'POST' }),
  /** The Year in review card as an SVG file (signed-in fetch, then saved through a blob link). */
  downloadImage: async (params: WrappedParams): Promise<void> => {
    const path = '/watchstats/wrapped/image.svg';
    const res = await fetch(buildUrl(path, { year: params.year, userId: params.userId }), { credentials: 'same-origin' });
    if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`.trim(), path);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = attachmentName(res.headers.get('content-disposition'), `wrapped-${params.year ?? 'year'}.svg`);
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};
