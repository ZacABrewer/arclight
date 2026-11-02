import { describe, expect, it } from 'vitest';
import { buildPlays, MIN_PLAY_MS, type TimelineRow } from './plays.js';

let nextId = 1;
const MIN = 60_000;
const T0 = Date.parse('2026-03-10T20:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * MIN).toISOString();

function row(over: Partial<TimelineRow> & Pick<TimelineRow, 'type' | 'at'>): TimelineRow {
  return {
    id: nextId++,
    serverId: 'jf1',
    mediaServerUserId: 1,
    itemType: 'movie',
    itemKey: 'movie:1',
    title: 'Night Train',
    seriesTitle: null,
    movieId: 1,
    seriesId: null,
    episodeId: null,
    tmdbId: 101,
    positionMs: null,
    durationMs: 100 * MIN,
    client: 'Jellyfin Web',
    device: 'Firefox',
    playMethod: 'DirectPlay',
    sessionId: 's1',
    ...over,
  };
}

describe('buildPlays', () => {
  it('counts the position moved, bounded by wall time, and marks a session finished by a played row', () => {
    const plays = buildPlays([
      row({ type: 'start', at: at(0), positionMs: 0 }),
      row({ type: 'progress', at: at(30), positionMs: 30 * MIN }),
      // Skipped ahead 50 minutes in 10: only the 10 minutes that passed count.
      row({ type: 'progress', at: at(40), positionMs: 80 * MIN }),
      row({ type: 'stop', at: at(60), positionMs: 99 * MIN }),
      row({ type: 'played', at: at(61), sessionId: null }),
    ]);
    expect(plays).toHaveLength(1);
    expect(plays[0]).toMatchObject({ completed: true, fromSession: true, watchMs: 60 * MIN, client: 'Jellyfin Web', playMethod: 'DirectPlay', at: at(0) });
  });

  it('drops short unfinished peeks and keeps a lone played row as a play of the full runtime', () => {
    const plays = buildPlays([
      row({ type: 'start', at: at(0), positionMs: 0, sessionId: 'peek' }),
      row({ type: 'stop', at: at(0.5), positionMs: 30_000, sessionId: 'peek' }),
      row({ type: 'played', at: at(600), sessionId: null, playMethod: null, client: null, device: null }),
    ]);
    expect(MIN_PLAY_MS).toBe(MIN);
    expect(plays).toHaveLength(1);
    expect(plays[0]).toMatchObject({ fromSession: false, completed: true, watchMs: 100 * MIN, playMethod: null });
  });

  it('splits one session id into two plays on a restart after a stop or a long gap, and keeps accounts apart', () => {
    const plays = buildPlays([
      row({ type: 'start', at: at(0), positionMs: 0 }),
      row({ type: 'stop', at: at(20), positionMs: 20 * MIN }),
      row({ type: 'start', at: at(25), positionMs: 20 * MIN }),
      row({ type: 'stop', at: at(45), positionMs: 40 * MIN }),
      row({ type: 'start', at: at(400), positionMs: 40 * MIN }),
      row({ type: 'stop', at: at(410), positionMs: 50 * MIN }),
      row({ type: 'start', at: at(0), positionMs: 0, mediaServerUserId: 2 }),
      row({ type: 'stop', at: at(5), positionMs: 5 * MIN, mediaServerUserId: 2 }),
    ]);
    expect(plays.filter((p) => p.accountId === 1).map((p) => p.watchMs)).toEqual([20 * MIN, 20 * MIN, 10 * MIN]);
    expect(plays.filter((p) => p.accountId === 2).map((p) => p.watchMs)).toEqual([5 * MIN]);
  });

  it('ignores unplayed rows and caps watch time at the runtime', () => {
    const plays = buildPlays([
      row({ type: 'start', at: at(0), positionMs: 0, durationMs: 22 * MIN, itemType: 'episode', itemKey: 'episode:7' }),
      row({ type: 'stop', at: at(200), positionMs: null, durationMs: 22 * MIN, itemType: 'episode', itemKey: 'episode:7' }),
      row({ type: 'unplayed', at: at(201), sessionId: null }),
    ]);
    expect(plays).toHaveLength(1);
    expect(plays[0]!.watchMs).toBe(22 * MIN);
  });
});
