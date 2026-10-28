import { describe, expect, it } from 'vitest';
import { QUALITIES, type AudioManualImportItem, type CustomFormatSpec } from '@arclight/shared';
import { customFormatDomain, customFormatFitsDomain } from '../../../lib/custom-format-domain.js';
import { audioReducer, duplicateTracks, groupProblems, initAudioState, toAudioImportRequest, trackOptions } from './audio-mapping.js';

const quality = { quality: { ...QUALITIES.FLAC, mediaTypes: [...QUALITIES.FLAC.mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } };
const tags = { title: null, artist: null, albumArtist: null, album: null, trackNo: null, discNo: null, durationMs: null, codec: null, bitrateKbps: null, sampleRateHz: null, bitDepth: null };

const item = (n: number, over: Partial<AudioManualImportItem> = {}): AudioManualImportItem => ({
  path: `/dl/${n}.flac`,
  relativePath: `${n}.flac`,
  name: `${n}.flac`,
  sizeBytes: 1,
  quality,
  mediaType: 'music',
  groupKey: 'a',
  groupFolder: 'A',
  artistId: 1,
  albumId: 2,
  albumReleaseId: 3,
  trackIds: [100 + n],
  mediumNumber: 1,
  trackNumber: n,
  confidence: 0.9,
  trackScore: 0.9,
  tags,
  rejections: [],
  warnings: [],
  ...over,
});

const state = () => initAudioState([item(1), item(2), item(3, { trackIds: undefined, mediumNumber: undefined, trackNumber: undefined }), item(4, { groupKey: 'b', groupFolder: 'B', artistId: undefined, albumId: undefined, trackIds: undefined })]);
const options = (ids: number[]) => trackOptions(ids.map((id, i) => ({ id, mediumNumber: 1, trackNumber: i + 1, title: `T${i + 1}` })));

describe('audio mapping', () => {
  it('groups the scan by groupKey with the proposal and leaves unmatched files without a track', () => {
    const s = state();
    expect(s.groups.map((g) => [g.key, g.folder, g.artistId, g.albumId, g.files.length])).toEqual([
      ['a', 'A', 1, 2, 3],
      ['b', 'B', null, null, 1],
    ]);
    expect(s.groups[0]!.files.map((f) => f.trackId)).toEqual([101, 102, null]);
    expect(groupProblems(s.groups[1]!)).toEqual(['Choose an artist', 'No tracks mapped']);
  });

  it('a new album clears the track ids, and resolving maps the files back by position', () => {
    const cleared = audioReducer(state(), { type: 'album', key: 'a', albumId: 5 });
    expect(cleared.groups[0]!.files.map((f) => f.trackId)).toEqual([null, null, null]);
    expect(groupProblems(cleared.groups[0]!)).toEqual(['No tracks mapped']);
    const resolved = audioReducer(cleared, { type: 'resolve', key: 'a', tracks: options([51, 52, 53]) });
    expect(resolved.groups[0]!.files.map((f) => f.trackId)).toEqual([51, 52, null]);
    // Nothing to fill: the same state comes back (no re-render loop).
    expect(audioReducer(resolved, { type: 'resolve', key: 'a', tracks: options([51, 52, 53]) })).toBe(resolved);
  });

  it('another artist drops the album', () => {
    const next = audioReducer(state(), { type: 'artist', key: 'a', artistId: 9 });
    expect(next.groups[0]).toMatchObject({ artistId: 9, albumId: null });
    expect(groupProblems(next.groups[0]!)).toEqual(['Choose an album', 'No tracks mapped']);
  });

  it('flags duplicate tracks and imports only mapped files of groups without problems', () => {
    const dup = audioReducer(state(), { type: 'track', key: 'a', path: '/dl/3.flac', discNumber: 1, trackNumber: 2, trackId: 102 });
    expect([...duplicateTracks(dup.groups[0]!)]).toEqual([102]);
    expect(toAudioImportRequest(dup, 'move').items).toEqual([]);
    expect(toAudioImportRequest(state(), 'copy')).toEqual({
      importMode: 'copy',
      items: [
        { path: '/dl/1.flac', artistId: 1, albumId: 2, trackIds: [101] },
        { path: '/dl/2.flac', artistId: 1, albumId: 2, trackIds: [102] },
      ],
    });
  });
});

describe('custom format domains (mirror of the profiles engine)', () => {
  const spec = (implementation: string, fields: Record<string, unknown> = {}) => ({ implementation, name: implementation, negate: false, required: false, fields }) as unknown as CustomFormatSpec;
  it('labels and filters formats by domain', () => {
    expect(customFormatDomain({ specifications: [] })).toBe('any');
    expect(customFormatDomain({ specifications: [spec('releaseTitle', { pattern: 'x' })] })).toBe('any');
    expect(customFormatDomain({ specifications: [spec('resolution', { resolution: 1080 })] })).toBe('video');
    expect(customFormatDomain({ specifications: [spec('ripLog')] })).toBe('music');
    expect(customFormatDomain({ specifications: [spec('narrator', { pattern: 'x' })] })).toBe('audiobook');
    expect(customFormatDomain({ specifications: [spec('releaseType', { releaseType: 'discography' })] })).toBe('music');
    const codec = { specifications: [spec('audioCodec', { codec: 'FLAC' })] };
    expect(customFormatDomain(codec)).toBe('music');
    expect(customFormatFitsDomain(codec, 'audiobook')).toBe(true);
    expect(customFormatFitsDomain(codec, 'video')).toBe(false);
    expect(customFormatFitsDomain({ specifications: [spec('source', { source: 'web' }), spec('audioCodec')] }, 'music')).toBe(false);
  });
});
