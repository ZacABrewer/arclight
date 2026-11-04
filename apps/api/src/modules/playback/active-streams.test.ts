import { describe, expect, it } from 'vitest';
import type { ProgressReport } from '@arclight/shared';
import { ActiveStreams, IDLE_MS, PAUSED_IDLE_MS, type StreamOrigin } from './active-streams.js';

// The in-memory "Now playing" list on its own: heartbeats, sessions and stream requests in, rows
// out, with a test clock for the idle timeouts.

function setup() {
  const clock = { t: Date.parse('2026-05-01T12:00:00.000Z') };
  const streams = new ActiveStreams({ now: () => clock.t });
  const report = (event: ProgressReport['event'], positionMs: number, extra: Partial<ProgressReport> = {}): ProgressReport => ({
    event,
    positionMs,
    durationMs: 200_000,
    deviceId: 'web-1',
    deviceName: 'Firefox',
    clientTime: new Date(clock.t).toISOString(),
    ...extra,
  });
  return { clock, streams, report };
}

const viewer = { userId: 1, profileKey: 0 };
const kid = { userId: 1, profileKey: 7 };
const web: StreamOrigin = { ip: '192.0.2.10', remote: false, client: { kind: 'web', deviceName: null, platform: null, appVersion: null } };
const link: StreamOrigin = { ip: '192.0.2.10', remote: false, client: null };

describe('ActiveStreams', () => {
  it('a heartbeat adds a row; the position runs on while playing and stops while paused', () => {
    const { clock, streams, report } = setup();
    streams.heartbeat(viewer, 'track:1', report('start', 10_000), web);
    clock.t += 5_000;
    const [row] = streams.list();
    expect(row).toMatchObject({ itemKey: 'track:1', state: 'playing', positionNowMs: 15_000, durationMs: 200_000, ip: '192.0.2.10', deviceId: 'web-1' });
    expect(row!.client).toEqual({ kind: 'web', deviceName: 'Firefox', platform: null, appVersion: null });
    streams.heartbeat(viewer, 'track:1', report('pause', 16_000), web);
    clock.t += 60_000;
    expect(streams.list()[0]).toMatchObject({ state: 'paused', positionNowMs: 16_000 });
    // A seek keeps the paused state.
    streams.heartbeat(viewer, 'track:1', report('seek', 30_000), web);
    expect(streams.list()[0]).toMatchObject({ state: 'paused', positionNowMs: 30_000 });
    // The position never runs past the end.
    streams.heartbeat(viewer, 'track:1', report('progress', 199_000), web);
    clock.t += 30_000;
    expect(streams.list()[0]!.positionNowMs).toBe(200_000);
  });

  it('rows end on stop and after the idle timeouts (longer while paused)', () => {
    const { clock, streams, report } = setup();
    streams.heartbeat(viewer, 'track:1', report('progress', 0), web);
    streams.heartbeat(viewer, 'track:1', report('stop', 5_000), web);
    expect(streams.size).toBe(0);

    streams.heartbeat(viewer, 'track:1', report('progress', 0), web);
    clock.t += IDLE_MS - 1;
    expect(streams.list()).toHaveLength(1);
    clock.t += 2;
    expect(streams.list()).toHaveLength(0);

    streams.heartbeat(viewer, 'track:2', report('pause', 0), web);
    clock.t += IDLE_MS + 1;
    expect(streams.list()).toHaveLength(1);
    clock.t += PAUSED_IDLE_MS;
    expect(streams.list()).toHaveLength(0);
  });

  it('a new item on the same device restarts the row; profiles are separate streams', () => {
    const { clock, streams, report } = setup();
    streams.heartbeat(viewer, 'track:1', report('progress', 0), web);
    const first = streams.list()[0]!;
    clock.t += 1_000;
    streams.heartbeat(viewer, 'track:2', report('start', 0), web);
    const rows = streams.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.itemKey).toBe('track:2');
    expect(rows[0]!.id).not.toBe(first.id);
    streams.heartbeat(kid, 'track:2', report('start', 0), web);
    expect(streams.list().map((r) => r.viewer.profileKey).sort()).toEqual([0, 7]);
  });

  it('ignores reports an offline queue replays long after the fact', () => {
    const { clock, streams, report } = setup();
    streams.heartbeat(viewer, 'track:1', report('progress', 0, { clientTime: new Date(clock.t - 10 * 60_000).toISOString() }), web);
    expect(streams.size).toBe(0);
  });

  it('a stream request alone shows a provisional row; the first heartbeat takes it over', () => {
    const { clock, streams, report } = setup();
    const done = streams.streamOpened(viewer, 'track:1', { method: 'transcode', delivery: 'progressive', audioFormat: 'opus', bitrateKbps: 128 }, link);
    const [p] = streams.list();
    expect(p).toMatchObject({ deviceId: null, itemKey: 'track:1', client: { kind: 'other' } });
    expect(p!.delivery).toMatchObject({ method: 'transcode', audioFormat: 'opus', bitrateKbps: 128 });
    // The open response keeps it past the idle timeout.
    clock.t += IDLE_MS * 3;
    expect(streams.list()).toHaveLength(1);
    streams.heartbeat(viewer, 'track:1', report('progress', 30_000), web);
    const rows = streams.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: p!.id, deviceId: 'web-1', startedAt: p!.startedAt });
    // The heartbeat's playMethod does not overwrite what the stream said.
    streams.heartbeat(viewer, 'track:1', report('progress', 31_000, { playMethod: 'DirectPlay' }), web);
    expect(streams.list()[0]!.delivery!.method).toBe('transcode');
    done();
    done();
    clock.t += IDLE_MS + 1;
    expect(streams.list()).toHaveLength(0);
  });

  it('HLS sessions: segment requests keep the row; ending the session removes it', () => {
    const { clock, streams } = setup();
    streams.videoSession(viewer, { deviceKey: 'tv-1', itemKey: 'movie:1', startMs: 60_000, durationMs: 600_000, delivery: { method: 'transcode', delivery: 'hls', hlsSessionId: 's1' } }, web);
    expect(streams.list()[0]).toMatchObject({ deviceId: 'tv-1', positionNowMs: 60_000, durationMs: 600_000 });
    for (let i = 0; i < 4; i++) {
      clock.t += IDLE_MS / 2;
      streams.hlsTouched('s1');
    }
    expect(streams.list()).toHaveLength(1);
    // An older session of the same item ending does not remove the newer one.
    streams.videoSession(viewer, { deviceKey: 'tv-1', itemKey: 'movie:1', startMs: 0, durationMs: 600_000, delivery: { method: 'remux', delivery: 'hls', hlsSessionId: 's2' } }, web);
    streams.hlsEnded('s1');
    expect(streams.list()[0]!.delivery).toMatchObject({ method: 'remux', hlsSessionId: 's2' });
    streams.hlsEnded('s2');
    expect(streams.list()).toHaveLength(0);
  });

  it('the list is bounded', () => {
    const { streams, report } = setup();
    for (let i = 0; i < 2100; i++) streams.heartbeat(viewer, 'track:1', report('progress', 0, { deviceId: `d${i}` }), web);
    expect(streams.size).toBeLessThanOrEqual(2000);
  });
});
