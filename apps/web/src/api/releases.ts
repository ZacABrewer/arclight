import {
  PendingRelease,
  ReleaseGrabResponse,
  ReleasePushResponse,
  type ReleaseGrabRequest,
  type ReleasePushRequest,
  type ReleaseResource,
} from '@media-tron/shared';
import { ApiError, request } from './client.js';

// Paths mirror apps/api/src/modules/releases/routes.ts.

export const releasesApi = {
  pending: () => request('/release/pending', PendingRelease.array()),
  removePending: (id: number) => request(`/release/pending/${id}`, null, { method: 'DELETE' }),
  grab: (body: ReleaseGrabRequest) => request('/release', ReleaseGrabResponse, { method: 'POST', json: body }),
  push: (body: ReleasePushRequest) => request('/release/push', ReleasePushResponse, { method: 'POST', json: body }),
};

/** The push body for a release seen by the cross-indexer search. */
export function toPushRequest(r: ReleaseResource): ReleasePushRequest {
  return {
    title: r.title,
    protocol: r.protocol,
    publishDate: r.publishDate,
    size: r.size,
    guid: r.guid,
    indexerId: r.indexerId,
    indexer: r.indexerName,
    ...(r.downloadUrl ? { downloadUrl: r.downloadUrl } : {}),
    ...(r.magnetUrl ? { magnetUrl: r.magnetUrl } : {}),
    ...(r.infoUrl ? { infoUrl: r.infoUrl } : {}),
    ...(r.infoHash ? { infoHash: r.infoHash } : {}),
    ...(r.seeders !== undefined ? { seeders: r.seeders } : {}),
    ...(r.leechers !== undefined ? { leechers: r.leechers } : {}),
    ...(r.tvdbId !== undefined ? { tvdbId: r.tvdbId } : {}),
    ...(r.tmdbId !== undefined ? { tmdbId: r.tmdbId } : {}),
    ...(r.imdbId !== undefined ? { imdbId: r.imdbId } : {}),
  };
}

export type GrabOutcome =
  | { kind: 'grabbed'; title: string }
  | { kind: 'pending'; title: string }
  | { kind: 'rejected'; title: string; reason: string };

/**
 * Grab a search result. POST /release only knows releases its own searches cached, so a
 * result from the cross-indexer search that it has not seen falls back to /release/push,
 * which runs the decision engine and grabs (or parks) when the release maps to the library.
 */
export async function grabSearchResult(r: ReleaseResource): Promise<GrabOutcome> {
  try {
    const res = await releasesApi.grab({ guid: r.guid, indexerId: r.indexerId });
    return { kind: 'grabbed', title: res.title };
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404 || err.code !== 'NOT_FOUND') throw err;
  }
  const pushed = await releasesApi.push(toPushRequest(r));
  if (pushed.grabbed) return { kind: 'grabbed', title: r.title };
  if (pushed.pending) return { kind: 'pending', title: r.title };
  const reason = pushed.decision?.rejections.map((x) => x.message).join('; ') || 'Not matched to a library item';
  return { kind: 'rejected', title: r.title, reason };
}
