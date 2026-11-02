import { describe, expect, it } from 'vitest';
import { buildItems } from '@arclight/profiles-engine';
import { QUALITIES, type QualityProfile } from '@arclight/shared';
import type { SlskdResponse } from '@arclight/download-clients';
import type { ReleaseCandidate } from '../../imports/audio/track-match.js';
import { musicQualityFor } from '../quality.js';
import { chooseCandidates, sharedFileQuality, type ChooseOptions } from './choose.js';

const RELEASE: ReleaseCandidate = {
  id: 'rel-1',
  media: [
    {
      position: 1,
      tracks: [
        { position: 1, title: 'First Song', durationMs: 200_000, recordingId: null, ref: 11 },
        { position: 2, title: 'Second Song', durationMs: 210_000, recordingId: null, ref: 12 },
        { position: 3, title: 'Third Song', durationMs: 190_000, recordingId: null, ref: 13 },
        { position: 4, title: 'Fourth Song', durationMs: 230_000, recordingId: null, ref: 14 },
      ],
    },
  ],
};

const TITLES = ['First Song', 'Second Song', 'Third Song', 'Fourth Song'];
const LENGTHS = [200, 210, 190, 230];

function profile(allowed: Array<keyof typeof QUALITIES>, cutoff: keyof typeof QUALITIES): QualityProfile {
  return {
    id: 1,
    name: 'Test',
    upgradeAllowed: true,
    cutoff: QUALITIES[cutoff].id,
    items: buildItems(allowed as never, 'music'),
    minFormatScore: 0,
    cutoffFormatScore: 0,
    minUpgradeFormatScore: 1,
    formatItems: [],
    languages: [],
    mediaDomain: 'music',
  };
}

const ANY = profile(['MP3-256', 'MP3-320', 'FLAC', 'FLAC-24bit'], 'FLAC');
const LOSSLESS = profile(['FLAC', 'FLAC-24bit'], 'FLAC');

function folder(
  username: string,
  dir: string,
  ext: string,
  opts: { count?: number; bitRate?: number; bitDepth?: number; free?: boolean; queue?: number; speed?: number; sub?: (i: number) => string } = {},
): SlskdResponse {
  const count = opts.count ?? 4;
  return {
    username,
    hasFreeUploadSlot: opts.free ?? true,
    queueLength: opts.queue ?? 0,
    uploadSpeed: opts.speed ?? 1_000_000,
    files: TITLES.slice(0, count).map((title, i) => ({
      filename: `${dir}${opts.sub ? `\\${opts.sub(i)}` : ''}\\0${i + 1} - ${title}.${ext}`,
      size: 20_000_000,
      bitRate: opts.bitRate ?? null,
      bitDepth: opts.bitDepth ?? null,
      sampleRate: 44100,
      length: LENGTHS[i]!,
      extension: ext,
    })),
  };
}

const options = (overrides: Partial<ChooseOptions> = {}): ChooseOptions => ({ profile: ANY, threshold: 0.8, maxPeerQueue: 50, ...overrides });

describe('sharedFileQuality', () => {
  it('reads codec from the extension and bitrate / depth from what the peer reports', () => {
    expect(sharedFileQuality({ filename: 'a\\b.flac', bitDepth: 16 }).quality.name).toBe('FLAC');
    expect(sharedFileQuality({ filename: 'a\\b.flac', bitDepth: 24 }).quality.name).toBe('FLAC-24bit');
    expect(sharedFileQuality({ filename: 'a\\b.mp3', bitRate: 320 }).quality.name).toBe('MP3-320');
    expect(sharedFileQuality({ filename: 'a\\b.mp3', bitRate: 256 }).quality.name).toBe('MP3-256');
    expect(sharedFileQuality({ filename: 'a/b.m4a', bitDepth: 16 }).quality.name).toBe('ALAC');
    expect(sharedFileQuality({ filename: 'a/b.txt' }).quality.name).toBe('Unknown');
  });
});

describe('chooseCandidates', () => {
  it('prefers lossless over lossy and ranks with a descending score', () => {
    const result = chooseCandidates(
      [folder('lossy-peer', 'Music\\Artist - Album [MP3]', 'mp3', { bitRate: 320 }), folder('flac-peer', 'Music\\Artist - Album [FLAC]', 'flac', { bitDepth: 16 })],
      { release: RELEASE },
      options(),
    );
    expect(result.map((c) => [c.username, c.qualityName, c.accepted])).toEqual([
      ['flac-peer', 'FLAC', true],
      ['lossy-peer', 'MP3-320', true],
    ]);
    expect(result[0]!.score).toBeGreaterThan(result[1]!.score);
    expect(result[0]!.matchedTracks).toBe(4);
    expect(result[0]!.files.map((f) => f.filename.split('\\').at(-1))).toEqual(TITLES.map((t, i) => `0${i + 1} - ${t}.flac`));
  });

  it('rejects qualities the profile does not allow', () => {
    const [c] = chooseCandidates([folder('p', 'A', 'mp3', { bitRate: 320 })], { release: RELEASE }, options({ profile: LOSSLESS }));
    expect(c!.accepted).toBe(false);
    expect(c!.rejections).toContain('qualityNotAllowed');
  });

  it('rejects folders that are not an upgrade over the files on disk', () => {
    const current = musicQualityFor({ codec: 'flac', bitrateKbps: null, bitDepth: 16 });
    const result = chooseCandidates(
      [folder('same', 'A', 'flac', { bitDepth: 16 }), folder('better', 'B', 'flac', { bitDepth: 24 })],
      { release: RELEASE },
      options({ currentQuality: current }),
    );
    expect(result.find((c) => c.username === 'same')!.rejections).toEqual(['notAnUpgrade']);
    expect(result[0]).toMatchObject({ username: 'better', qualityName: 'FLAC-24bit', accepted: true });
  });

  it('rejects incomplete folders when the whole album is wanted', () => {
    const [c] = chooseCandidates([folder('p', 'A', 'flac', { count: 2 })], { release: RELEASE }, options());
    expect(c!.rejections).toContain('tooFewTracks');
  });

  it('accepts a partial folder that has every wanted track (per-track wanted)', () => {
    const album = { release: RELEASE, unwantedTrackIds: new Set([13, 14]) };
    const [partial] = chooseCandidates([folder('p', 'A', 'flac', { count: 2 })], album, options());
    expect(partial).toMatchObject({ accepted: true, wantedTracks: 2, totalTracks: 4, matchedTracks: 2 });

    const missing = chooseCandidates([folder('p', 'A', 'flac', { count: 1 })], album, options());
    expect(missing[0]!.rejections).toEqual(['missingWantedTracks']);
  });

  it('rejects peers with a long queue and no free slot, and prefers free slots', () => {
    const result = chooseCandidates(
      [folder('busy', 'A', 'flac', { free: false, queue: 500 }), folder('slow', 'B', 'flac', { free: false, queue: 3 }), folder('free', 'C', 'flac')],
      { release: RELEASE },
      options(),
    );
    expect(result.map((c) => c.username)).toEqual(['free', 'slow', 'busy']);
    expect(result[2]!.rejections).toEqual(['peerQueueTooLong']);
  });

  it('folds disc sub-folders into one album folder and skips non-audio and locked files', () => {
    const response = folder('p', 'Music\\Album', 'flac', { sub: (i) => (i < 2 ? 'CD1' : 'CD2') });
    response.files.push({ filename: 'Music\\Album\\cover.jpg', size: 100_000 }, { filename: 'Music\\Album\\CD1\\extra.flac', size: 1, isLocked: true });
    const twoDiscs: ReleaseCandidate = {
      id: 'rel-2',
      media: [
        { position: 1, tracks: RELEASE.media[0]!.tracks.slice(0, 2) },
        { position: 2, tracks: RELEASE.media[0]!.tracks.slice(2).map((t, i) => ({ ...t, position: i + 1 })) },
      ],
    };
    // Track numbers restart per disc, as on a real two-disc rip.
    response.files = response.files.map((f) =>
      f.filename.includes('CD2') ? { ...f, filename: f.filename.replace(/\\0(\d)/, (_m, n: string) => `\\0${Number(n) - 2}`) } : f,
    );
    const result = chooseCandidates([response], { release: twoDiscs }, options());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ directory: 'Music\\Album', matchedTracks: 4, accepted: true });
    expect(result[0]!.files).toHaveLength(4);
  });

  it('flags folders mixing lossless and lossy files', () => {
    const response = folder('p', 'A', 'flac');
    response.files[3] = { ...response.files[3]!, filename: 'A\\04 - Fourth Song.mp3', bitRate: 320 };
    const [c] = chooseCandidates([response], { release: RELEASE }, options());
    expect(c!.qualityName).toBe('MP3-320');
    expect(c!.rejections).toContain('mixedQuality');
  });

  it('returns nothing for folders without matching tracks', () => {
    const response: SlskdResponse = { username: 'p', files: [{ filename: 'X\\notes.txt', size: 10 }] };
    expect(chooseCandidates([response], { release: RELEASE }, options())).toEqual([]);
  });
});
