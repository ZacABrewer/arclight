// Test helpers for the music clients: virtual clocks and a MusicBrainz fixture router.
// Lives in src so it is typechecked, but is not exported from index.ts.

import type { Clock } from './rate-limit.js';
import { jsonResponse } from './test-support.js';

import artist from '../fixtures/musicbrainz/artist.json' with { type: 'json' };
import error404 from '../fixtures/musicbrainz/error-404.json' with { type: 'json' };
import error503 from '../fixtures/musicbrainz/error-503.json' with { type: 'json' };
import release from '../fixtures/musicbrainz/release.json' with { type: 'json' };
import release2disc from '../fixtures/musicbrainz/release-2disc.json' with { type: 'json' };
import releaseGroupsPage1 from '../fixtures/musicbrainz/release-groups-page-1.json' with { type: 'json' };
import releaseGroupsPage2 from '../fixtures/musicbrainz/release-groups-page-2.json' with { type: 'json' };
import releases from '../fixtures/musicbrainz/releases.json' with { type: 'json' };
import searchArtist from '../fixtures/musicbrainz/search-artist.json' with { type: 'json' };
import searchReleaseGroup from '../fixtures/musicbrainz/search-release-group.json' with { type: 'json' };
import wikidataClaims from '../fixtures/wikidata/claims-p18.json' with { type: 'json' };
import fanartMusic from '../fixtures/fanart/music.json' with { type: 'json' };

export const mbFixtures = {
  artist,
  error404,
  error503,
  release,
  release2disc,
  releaseGroupsPage1,
  releaseGroupsPage2,
  releases,
  searchArtist,
  searchReleaseGroup,
};

export const wikidataFixtures = { claims: wikidataClaims };
export const fanartFixtures = { music: fanartMusic };

/** Ids that appear in the recorded fixtures. */
export const MB_IDS = {
  artist: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
  releaseGroup: 'b1392450-e666-3926-a536-22c65f834433',
  release: '0b6b4ba0-d36f-47bd-b4ea-6a5b91842d29',
  release2disc: '2629071c-1d8f-43f1-be99-712d931e3bf1',
  missing: 'f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b',
} as const;

/** Serves the recorded MusicBrainz fixtures by path and query. */
export function musicBrainzRoute(url: URL): Response {
  const path = url.pathname.replace(/^\/ws\/2/, '');
  const q = url.searchParams;
  switch (true) {
    case path === '/artist' && q.has('query'):
      return jsonResponse(searchArtist);
    case path === `/artist/${MB_IDS.artist}`:
      return jsonResponse(artist);
    case path === '/release-group' && q.has('query'):
      return jsonResponse(searchReleaseGroup);
    case path === '/release-group' && q.get('artist') === MB_IDS.artist:
      return jsonResponse(q.get('offset') === '100' ? releaseGroupsPage2 : releaseGroupsPage1);
    case path === '/release' && q.get('release-group') === MB_IDS.releaseGroup:
      return jsonResponse(releases);
    case path === `/release/${MB_IDS.release}`:
      return jsonResponse(release);
    case path === `/release/${MB_IDS.release2disc}`:
      return jsonResponse(release2disc);
    default:
      return jsonResponse(error404, 404);
  }
}

export function throttledResponse(retryAfterSeconds?: number): Response {
  return jsonResponse(
    error503,
    503,
    retryAfterSeconds === undefined ? {} : { 'retry-after': String(retryAfterSeconds) },
  );
}

/** Lets every pending promise callback run. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface ManualClock extends Clock {
  /** Moves time forward, firing due sleepers in order and flushing between them. */
  advance(ms: number): Promise<void>;
  /** Sleepers not yet due. */
  pendingTimers(): number;
}

/** A clock that only moves when the test calls `advance`. */
export function createManualClock(start = 0): ManualClock {
  let now = start;
  let seq = 0;
  const timers: { at: number; seq: number; resolve: () => void }[] = [];
  return {
    now: () => now,
    sleep(ms) {
      return new Promise<void>((resolve) => {
        timers.push({ at: now + Math.max(0, ms), seq: seq++, resolve });
      });
    },
    async advance(ms) {
      const target = now + ms;
      await flush();
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const next = timers[0];
        if (!next || next.at > target) break;
        timers.shift();
        now = next.at;
        next.resolve();
        await flush();
      }
      now = target;
      await flush();
    },
    pendingTimers: () => timers.length,
  };
}

/** A clock whose sleeps return at once but advance virtual time (handy for client tests). */
export function createInstantClock(start = 0): Clock & { elapsed(): number } {
  let now = start;
  return {
    now: () => now,
    sleep(ms) {
      now += Math.max(0, ms);
      return Promise.resolve();
    },
    elapsed: () => now - start,
  };
}
