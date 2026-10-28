import { describe, expect, it } from 'vitest';
import { DEFAULT_RELEASE_SETTINGS } from './deps.js';
import { musicSpecifications } from './audio-specs.js';
import { albumsGainedBy, evaluate, specApplies, specifications, type ExistingFile } from './engine.js';
import { audioSnapshot, makeAlbum, makeArtist, makeAudioCandidate, makeContext, makeMusicProfile, makeRelease, NOW, quality } from './test-support.js';

const MB = 1024 * 1024;
const artist = makeArtist({ name: 'Radiohead' });
const okc = makeAlbum(artist.id, 'OK Computer', 1997, { durationMs: 53 * 60_000, trackFileCount: 12 });
const kidA = makeAlbum(artist.id, 'Kid A', 2000, { durationMs: 50 * 60_000, trackFileCount: 12 });
const rainbows = makeAlbum(artist.id, 'In Rainbows', 2007, { durationMs: 42 * 60_000, trackFileCount: 12 });
const future = makeAlbum(artist.id, 'Next One', 2026, { releaseDate: '2026-09-01', durationMs: null, trackCount: 0 });
const lib = audioSnapshot([artist], [okc, kidA, rainbows, future]);
const profile = makeMusicProfile();

function reasons(title: string, ctx: Partial<Parameters<typeof makeContext>[0]> = {}, size = 300 * MB) {
  const c = makeAudioCandidate(makeRelease(title, { size }), lib, profile);
  return evaluate(makeContext({ profile, ...ctx }), c, musicSpecifications).rejections.map((r) => r.reason);
}

function albumFile(albumId: number, name: Parameters<typeof quality>[0]): ExistingFile {
  return { id: albumId * 100, quality: quality(name), formatScore: 0, releaseGroup: null, dateAdded: NOW.toISOString(), episodeIds: [], albumIds: [albumId], sizeBytes: 300 * MB };
}

describe('spec domains', () => {
  it('runs shared specs for music and keeps video-only ones off it', () => {
    const byId = new Map(specifications.map((s) => [s.id, s.appliesTo]));
    expect(byId.get('qualityAllowed')).toBe('all');
    expect(byId.get('sizeLimits')).toBe('all');
    expect(byId.get('language')).toBe('video');
    expect(byId.get('hardcodedSubs')).toBe('video');
    expect(byId.get('availability')).toBe('movie');
    expect(specApplies('video', 'music')).toBe(false);
    expect(specApplies('audio', 'music')).toBe(true);
    expect(specApplies('all', 'audiobook')).toBe(true);
    expect(specApplies('video', 'series')).toBe(true);
  });
});

describe('music specs', () => {
  it('approves a wanted FLAC album', () => {
    expect(reasons('Radiohead - OK Computer (1997) [FLAC]')).toEqual([]);
  });

  it('albumReleased: refuses albums that are not out yet, unless the user searched', () => {
    expect(reasons('Radiohead - Next One (2026) [FLAC]')).toContain('albumNotReleased');
    expect(reasons('Radiohead - Next One (2026) [FLAC]', { source: 'interactiveSearch' })).not.toContain('albumNotReleased');
  });

  it('discographyPack: off unless allowed, then needs enough wanted albums; interactive grabs always may', () => {
    const title = 'Radiohead - Discography (1997-2007) [FLAC]';
    expect(reasons(title)).toContain('discographyNotAllowed');
    expect(reasons(title, { source: 'interactiveSearch' })).not.toContain('discographyNotAllowed');
    const allowed = { ...DEFAULT_RELEASE_SETTINGS, allowDiscographyPacks: true };
    // OK Computer and Kid A are missing: 2 wanted.
    expect(reasons(title, { settings: allowed, existingFiles: [albumFile(rainbows.id, 'FLAC')] })).toEqual([]);
    // Only one wanted album left when Kid A is on disk in FLAC (cutoff met).
    expect(reasons(title, { settings: allowed, existingFiles: [albumFile(rainbows.id, 'FLAC'), albumFile(kidA.id, 'FLAC')] })).toContain('packTooFewWanted');
    expect(reasons(title, { settings: { ...allowed, minPackWanted: 1 }, existingFiles: [albumFile(rainbows.id, 'FLAC'), albumFile(kidA.id, 'FLAC')] })).toEqual([]);
  });

  it('packs gain only the albums they beat', () => {
    const c = makeAudioCandidate(makeRelease('Radiohead - Discography (1997-2007) [MP3 320]', { size: 300 * MB }), lib, profile);
    const ctx = makeContext({ profile, existingFiles: [albumFile(okc.id, 'MP3-192'), albumFile(kidA.id, 'FLAC'), albumFile(rainbows.id, 'FLAC')] });
    // OK Computer (MP3-192 → MP3-320) improves; Kid A and In Rainbows are already FLAC.
    expect(albumsGainedBy(ctx, c)).toEqual([okc.id]);
    const none = makeContext({ profile, existingFiles: [albumFile(okc.id, 'FLAC'), albumFile(kidA.id, 'FLAC'), albumFile(rainbows.id, 'FLAC')] });
    expect(evaluate(none, c, musicSpecifications).rejections.map((r) => r.reason)).toContain('diskNotUpgrade');
  });

  it('uses the lowest track quality: an album with one MP3 track is upgradable by FLAC', () => {
    expect(reasons('Radiohead - In Rainbows (2007) [FLAC]', { existingFiles: [albumFile(rainbows.id, 'MP3-320')] })).toEqual([]);
    expect(reasons('Radiohead - In Rainbows (2007) [MP3 320]', { existingFiles: [albumFile(rainbows.id, 'FLAC')] })).toContain('diskCutoffMet');
  });

  it('audioSizePlausible: rejects a FLAC album far too small or too large for its running time', () => {
    // 53 min of FLAC needs at least 3.5 × 0.5 × 53 ≈ 93 MB.
    expect(reasons('Radiohead - OK Computer (1997) [FLAC]', {}, 40 * MB)).toContain('audioSizeImplausible');
    expect(reasons('Radiohead - OK Computer (1997) [FLAC]', {}, 2000 * MB)).toContain('audioSizeImplausible');
    expect(reasons('Radiohead - OK Computer (1997) [MP3 320]', {}, 120 * MB)).toEqual([]);
  });

  it('sizeLimits: MB per minute × album duration from the quality definitions', () => {
    const limits = () => ({ qualityId: 131, title: 'FLAC', minSize: 5, maxSize: 7, preferredSize: 6 });
    expect(reasons('Radiohead - OK Computer (1997) [FLAC]', { qualityLimits: limits }, 200 * MB)).toContain('belowMinimumSize');
    expect(reasons('Radiohead - OK Computer (1997) [FLAC]', { qualityLimits: limits }, 300 * MB)).toEqual([]);
  });

  it('monitored and search-item specs speak about artists and albums', () => {
    const unmonitored = audioSnapshot([{ ...artist, monitored: false }], [okc]);
    const c = makeAudioCandidate(makeRelease('Radiohead - OK Computer (1997) [FLAC]', { size: 300 * MB }), unmonitored, profile);
    expect(evaluate(makeContext({ profile }), c, musicSpecifications).rejections.map((r) => r.reason)).toContain('artistNotMonitored');
    expect(
      reasons('Radiohead - OK Computer (1997) [FLAC]', { criteria: { mediaType: 'music', artistId: artist.id, albumIds: [kidA.id], userInvoked: false } }),
    ).toContain('wrongAlbum');
  });
});
