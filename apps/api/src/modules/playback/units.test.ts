import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { PlayerSettings, type PlaybackProgress, type ProgressReport } from '@arclight/shared';
import { decide } from './access.js';
import { commonLabel, formatLabel, mimeOf } from './format.js';
import { linkKey, linkQuery, verifyLink } from './links.js';
import { applyReport, mergeProgress, PLAYED_WINS_WITHIN_MS, type ProgressState } from './progress.js';
import { etagOf, notModified, parseRange, rangeStillValid } from './range.js';
import { AudioTranscoder, buildAudioTranscodeArgs, type RunningTranscode } from './transcode.js';

// Pure parts of the player: ranges, signed links, the access rule, progress rules and the
// effective-progress merge, labels, and the ffmpeg argument builder and limiter.

describe('parseRange', () => {
  it('reads full, partial, open-ended and suffix ranges', () => {
    expect(parseRange(undefined, 1000)).toEqual({ kind: 'full' });
    expect(parseRange('bytes=0-99', 1000)).toEqual({ kind: 'partial', start: 0, end: 99 });
    expect(parseRange('bytes=500-', 1000)).toEqual({ kind: 'partial', start: 500, end: 999 });
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ kind: 'partial', start: 900, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ kind: 'partial', start: 900, end: 999 });
    expect(parseRange('bytes=-5000', 1000)).toEqual({ kind: 'partial', start: 0, end: 999 });
  });

  it('rejects ranges past the end or backwards, and ignores what it cannot use', () => {
    expect(parseRange('bytes=1000-', 1000)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=50-10', 1000)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=-0', 1000)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=-', 1000)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=abc', 1000)).toEqual({ kind: 'unsatisfiable' });
    // Multi-range and other units: the whole file.
    expect(parseRange('bytes=0-1,5-6', 1000)).toEqual({ kind: 'full' });
    expect(parseRange('items=0-1', 1000)).toEqual({ kind: 'full' });
  });

  it('validators: ETag, If-None-Match, If-Modified-Since and If-Range', () => {
    const mtime = new Date('2026-01-02T03:04:05Z');
    const etag = etagOf({ size: 1000, mtimeMs: mtime.getTime() });
    expect(notModified({ 'if-none-match': etag }, etag, mtime)).toBe(true);
    expect(notModified({ 'if-none-match': '"other"' }, etag, mtime)).toBe(false);
    expect(notModified({ 'if-modified-since': mtime.toUTCString() }, etag, mtime)).toBe(true);
    expect(notModified({ 'if-modified-since': new Date(mtime.getTime() - 60_000).toUTCString() }, etag, mtime)).toBe(false);
    expect(rangeStillValid(undefined, etag, mtime)).toBe(true);
    expect(rangeStillValid(etag, etag, mtime)).toBe(true);
    expect(rangeStillValid('"stale"', etag, mtime)).toBe(false);
    expect(rangeStillValid(mtime.toUTCString(), etag, mtime)).toBe(true);
  });
});

describe('signed links', () => {
  const key = linkKey('install-key');
  const now = Date.parse('2026-05-01T12:00:00Z');
  const exp = Math.floor(now / 1000) + 3600;
  const query = (q: string) => Object.fromEntries(new URLSearchParams(q));

  it('accepts a valid link for its file', () => {
    expect(verifyLink(key, 7, query(linkQuery(key, { userId: 3, fileId: 7, exp })), now)).toEqual({ ok: true, userId: 3 });
  });

  it('rejects expired, tampered and wrong-file links', () => {
    const good = query(linkQuery(key, { userId: 3, fileId: 7, exp }));
    expect(verifyLink(key, 7, good, (exp + 1) * 1000)).toEqual({ ok: false, reason: 'EXPIRED' });
    expect(verifyLink(key, 8, good, now)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(verifyLink(key, 7, { ...good, u: '4' }, now)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(verifyLink(key, 7, { ...good, exp: String(exp + 100) }, now)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    const sig = good['sig']!;
    expect(verifyLink(key, 7, { ...good, sig: (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1) }, now)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(verifyLink(linkKey('other-key'), 7, good, now)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(verifyLink(key, 7, { u: 'x', exp: '1', sig: 'short' }, now)).toEqual({ ok: false, reason: 'MALFORMED' });
  });
});

describe('access rule', () => {
  const on = PlayerSettings.parse({ enabled: true });
  const user = (player?: unknown) => ({ userId: 2, isAdmin: false, settings: player === undefined ? {} : { player } });
  const admin = { userId: 1, isAdmin: true, settings: {} };

  it('is off for everyone while the player is disabled', () => {
    expect(decide(PlayerSettings.parse({}), admin, false).denial).toBe('PLAYER_DISABLED');
    expect(decide(PlayerSettings.parse({}), user({ allowed: true }), false).denial).toBe('PLAYER_DISABLED');
  });

  it('admins always may play; other users need player.allowed', () => {
    expect(decide(on, admin, false)).toMatchObject({ allowed: true, canStream: true, denial: null });
    expect(decide(on, user(), false).denial).toBe('PLAYER_NOT_ALLOWED');
    expect(decide(on, user({ allowed: false }), false).denial).toBe('PLAYER_NOT_ALLOWED');
    expect(decide(on, user({ allowed: 'yes' }), false).denial).toBe('PLAYER_NOT_ALLOWED');
    expect(decide(on, user({ allowed: true }), false)).toMatchObject({ canStream: true, maxBitrateKbps: 0 });
  });

  it('remote needs the server switch and the user switch', () => {
    expect(decide(on, user({ allowed: true }), true).denial).toBe('REMOTE_NOT_ALLOWED');
    expect(decide(on, admin, true).denial).toBe('REMOTE_NOT_ALLOWED');
    const remoteOn = PlayerSettings.parse({ enabled: true, allowRemote: true, remoteMaxBitrateKbps: 192 });
    expect(decide(remoteOn, user({ allowed: true }), true)).toMatchObject({ canStream: true, maxBitrateKbps: 192 });
    expect(decide(remoteOn, user({ allowed: true, allowRemote: false }), true).denial).toBe('REMOTE_NOT_ALLOWED');
    expect(decide(remoteOn, user({ allowed: true, maxBitrateKbps: 96 }), true).maxBitrateKbps).toBe(96);
    expect(decide(remoteOn, admin, true)).toMatchObject({ canStream: true, maxBitrateKbps: 192 });
  });
});

describe('progress rules', () => {
  const t0 = Date.parse('2026-05-01T12:00:00Z');
  const at = (s: number) => new Date(t0 + s * 1000).toISOString();
  const report = (positionMs: number, s: number, over: Partial<ProgressReport> = {}): ProgressReport => ({
    event: 'progress',
    positionMs,
    durationMs: 100_000,
    deviceId: 'dev',
    clientTime: at(s),
    ...over,
  });

  it('marks played at the threshold and counts the play once', () => {
    const first = applyReport(null, report(50_000, 0), t0 + 10_000);
    expect(first).toMatchObject({ accepted: true, completed: false, next: { played: false, playCount: 0, positionMs: 50_000 } });
    const done = applyReport(first.next, report(90_000, 5), t0 + 10_000);
    expect(done).toMatchObject({ completed: true, next: { played: true, playCount: 1 } });
    const again = applyReport(done.next, report(99_000, 6, { event: 'stop' }), t0 + 10_000);
    expect(again).toMatchObject({ completed: false, next: { played: true, playCount: 1 } });
  });

  it('starting a played item over clears played, and the next play-through counts again', () => {
    let state: ProgressState = applyReport(null, report(95_000, 0), t0 + 10_000).next;
    expect(state).toMatchObject({ played: true, playCount: 1 });
    state = applyReport(state, report(500, 2, { event: 'start' }), t0 + 10_000).next;
    expect(state.played).toBe(false);
    state = applyReport(state, report(92_000, 4), t0 + 10_000).next;
    expect(state).toMatchObject({ played: true, playCount: 2 });
    // A seek near the start of a played item does not clear it.
    expect(applyReport(state, report(100, 5, { event: 'seek' }), t0 + 10_000).next.played).toBe(true);
  });

  it('ignores stale reports and never dates a report after the server clock', () => {
    const state = applyReport(null, report(60_000, 10), t0 + 20_000).next;
    expect(applyReport(state, report(10_000, 5), t0 + 20_000)).toMatchObject({ accepted: false, next: { positionMs: 60_000 } });
    const future = applyReport(state, report(70_000, 3600), t0 + 20_000).next;
    expect(future.updatedAt).toBe(at(20));
  });

  it('keeps the speed as a per-item preference', () => {
    const state = applyReport(null, report(1000, 0, { speed: 1.5 }), t0).next;
    expect(state.prefs).toEqual({ speed: 1.5 });
    expect(applyReport(state, report(2000, 1), t0 + 1000).next.prefs).toEqual({ speed: 1.5 });
  });
});

describe('mergeProgress', () => {
  const base: PlaybackProgress = {
    itemKey: 'audiobook:1',
    positionMs: 1000,
    durationMs: 10_000,
    played: false,
    playCount: 0,
    lastPlayedAt: null,
    updatedAt: '2026-05-01T12:00:00.000Z',
    favorite: false,
    prefs: {},
    source: 'arclight',
  };
  const later = (ms: number) => new Date(Date.parse(base.updatedAt) + ms).toISOString();

  it('returns null without rows and the only row otherwise', () => {
    expect(mergeProgress(null, [])).toBeNull();
    expect(mergeProgress(base, [])).toEqual(base);
  });

  it('the newest wins; ties go to Arclight', () => {
    const jf = { ...base, positionMs: 5000, updatedAt: later(60_000), source: 'jellyfin' as const };
    expect(mergeProgress(base, [jf])).toMatchObject({ positionMs: 5000, source: 'jellyfin' });
    const tie = { ...base, positionMs: 7000, source: 'jellyfin' as const };
    expect(mergeProgress(base, [tie])).toMatchObject({ positionMs: 1000, source: 'arclight' });
  });

  it('a played row beats a slightly newer unplayed one, not a much newer one', () => {
    const played = { ...base, played: true, playCount: 2, positionMs: 10_000, source: 'jellyfin' as const };
    const own = { ...base, updatedAt: later(PLAYED_WINS_WITHIN_MS - 1000), favorite: true, prefs: { speed: 1.25 } };
    expect(mergeProgress(own, [played])).toMatchObject({ played: true, source: 'jellyfin', playCount: 2, favorite: true, prefs: { speed: 1.25 } });
    const muchLater = { ...own, updatedAt: later(PLAYED_WINS_WITHIN_MS + 1000) };
    expect(mergeProgress(muchLater, [played])).toMatchObject({ played: false, source: 'arclight', playCount: 2 });
  });

  it('works without an own row (external only)', () => {
    const jf = { ...base, favorite: true, source: 'emby' as const, lastPlayedAt: later(5) };
    expect(mergeProgress(null, [jf])).toMatchObject({ source: 'emby', favorite: true, lastPlayedAt: later(5) });
  });
});

describe('format labels', () => {
  const f = (codec: string, extra: Partial<{ bitrateKbps: number; sampleRateHz: number; bitDepth: number }> = {}) => ({
    codec,
    container: null,
    bitrateKbps: null,
    sampleRateHz: null,
    bitDepth: null,
    ...extra,
  });

  it('lossless shows depth/rate, lossy shows bitrate', () => {
    expect(formatLabel(f('FLAC', { bitDepth: 24, sampleRateHz: 96_000 }))).toBe('FLAC 24/96');
    expect(formatLabel(f('flac', { bitDepth: 16, sampleRateHz: 44_100 }))).toBe('FLAC 16/44.1');
    expect(formatLabel(f('MPEG 1 Layer 3', { bitrateKbps: 320 }))).toBe('MP3 320');
    expect(formatLabel(f('mp4a.40.2', { bitrateKbps: 256 }))).toBe('AAC 256');
    expect(formatLabel(f('mystery'))).toBeNull();
    expect(commonLabel(['MP3 320', 'FLAC 16/44.1', 'FLAC 16/44.1', null])).toBe('FLAC 16/44.1');
    expect(mimeOf('/x/a.FLAC')).toBe('audio/flac');
    expect(mimeOf('/x/a.m4b')).toBe('audio/mp4');
    expect(mimeOf('/x/a.xyz')).toBe('application/octet-stream');
  });
});

describe('ffmpeg arguments and the transcode limiter', () => {
  it('builds the argv per format', () => {
    expect(buildAudioTranscodeArgs('/m/a.flac', { format: 'opus', bitrateKbps: 128, startMs: 61_500, channels: 6 })).toEqual([
      ...['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', '61.500', '-i', '/m/a.flac'],
      ...['-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-ac', '2'],
      ...['-c:a', 'libopus', '-b:a', '128k', '-vbr', 'on', '-ar', '48000', '-f', 'ogg', 'pipe:1'],
    ]);
    const aac = buildAudioTranscodeArgs('/m/a.flac', { format: 'aac', bitrateKbps: 192 });
    expect(aac).not.toContain('-ss');
    expect(aac.slice(-7)).toEqual(['-c:a', 'aac', '-b:a', '192k', '-f', 'adts', 'pipe:1']);
    expect(buildAudioTranscodeArgs('/m/a.flac', { format: 'mp3', bitrateKbps: 256, channels: 2 }).slice(-7)).toEqual(['-c:a', 'libmp3lame', '-b:a', '256k', '-f', 'mp3', 'pipe:1']);
  });

  it('caps concurrent transcodes and frees a slot when one ends or is killed', async () => {
    const running: Array<{ end: () => void; killed: boolean }> = [];
    const launcher = (): RunningTranscode => {
      let end!: () => void;
      const done = new Promise<void>((r) => (end = r));
      const entry = { end, killed: false };
      running.push(entry);
      return {
        stdout: new PassThrough(),
        done,
        kill: () => {
          entry.killed = true;
          end();
        },
      };
    };
    const t = new AudioTranscoder({ launcher, locate: async () => '/bin/ffmpeg', max: 2 });
    const a = await t.start('/a', { format: 'opus', bitrateKbps: 96 });
    await t.start('/b', { format: 'opus', bitrateKbps: 96 });
    await expect(t.start('/c', { format: 'opus', bitrateKbps: 96 })).rejects.toMatchObject({ code: 'TRANSCODE_BUSY' });
    a.kill();
    expect(running[0]!.killed).toBe(true);
    expect(t.active).toBe(1);
    running[1]!.end();
    await new Promise((r) => setImmediate(r));
    expect(t.active).toBe(0);
  });

  it('reports a missing ffmpeg', async () => {
    const t = new AudioTranscoder({ locate: async () => null });
    await expect(t.start('/a', { format: 'mp3', bitrateKbps: 128 })).rejects.toMatchObject({ code: 'FFMPEG_MISSING' });
  });
});
