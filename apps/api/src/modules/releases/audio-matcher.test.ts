import { parseMusicRelease } from '@arclight/parser';
import { describe, expect, it } from 'vitest';
import { albumKey, artistKey, hasAudioMarker, matchAlbum, stripEdition } from './audio-matcher.js';
import { audioSnapshot, makeAlbum, makeArtist, NOW } from './test-support.js';

const radiohead = makeArtist({ name: 'Radiohead', aliases: ['On a Friday'] });
const beatles = makeArtist({ name: 'The Beatles' });
const simon = makeArtist({ name: 'Simon & Garfunkel' });
const weezer = makeArtist({ name: 'Weezer' });
const various = makeArtist({ name: 'Various Artists' });

const okc = makeAlbum(radiohead.id, 'OK Computer', 1997);
const kidA = makeAlbum(radiohead.id, 'Kid A', 2000);
const inRainbows = makeAlbum(radiohead.id, 'In Rainbows', 2007);
const kingOfLimbs = makeAlbum(radiohead.id, 'The King of Limbs', 2011);
const radioheadLive = makeAlbum(radiohead.id, 'I Might Be Wrong', 2001, { secondaryTypes: ['Live'] });
const abbey = makeAlbum(beatles.id, 'Abbey Road (Super Deluxe Edition)', 1969);
const bookends = makeAlbum(simon.id, 'Bookends', 1968);
const blue = makeAlbum(weezer.id, 'Weezer', 1994);
const green = makeAlbum(weezer.id, 'Weezer', 2001);
const red = makeAlbum(weezer.id, 'Weezer', 2008);
const nowThats = makeAlbum(various.id, 'Now That’s What I Call Music! 50', 2001);
const studio = { primaryTypes: ['Album' as const, 'EP' as const], secondaryTypes: [], releaseStatuses: ['Official' as const] };

const lib = audioSnapshot(
  [radiohead, beatles, simon, weezer, various],
  [okc, kidA, inRainbows, kingOfLimbs, radioheadLive, abbey, bookends, blue, green, red, nowThats],
  { 1: studio },
);

function match(title: string, opts: Parameters<typeof matchAlbum>[2] = {}) {
  return matchAlbum(parseMusicRelease(title).music, lib, { now: NOW, ...opts });
}

function albumIds(title: string, opts: Parameters<typeof matchAlbum>[2] = {}) {
  const m = match(title, opts);
  return m.status === 'mapped' ? m.albums.map((a) => a.id) : m.reason;
}

describe('audio matcher keys', () => {
  it.each([
    ['The Beatles', 'Beatles'],
    ['Beatles, The', 'beatles'],
    ['Simon & Garfunkel', 'Simon and Garfunkel'],
    ['Sigur Rós', 'Sigur Ros'],
  ])('artist %s == %s', (a, b) => expect(artistKey(a)).toBe(artistKey(b)));

  it.each([
    ['Abbey Road (Super Deluxe Edition)', 'Abbey Road'],
    ['OK Computer - 20th Anniversary Edition', 'OK Computer'],
    ['Nevermind (2011 Remaster)', 'Nevermind'],
    ['Kid A Deluxe', 'Kid A'],
  ])('album %s == %s', (a, b) => expect(albumKey(a)).toBe(albumKey(b)));

  it('keeps non-edition brackets and titles made only of edition words', () => {
    expect(stripEdition('Abbey Road (2019 Mix)')).toBe('Abbey Road (2019 Mix)');
    expect(stripEdition('Remastered')).toBe('Remastered');
  });

  it('spots audio codec or container words', () => {
    expect(hasAudioMarker('Artist - Album (2020) [FLAC]')).toBe(true);
    expect(hasAudioMarker('Artist-Album-WEB-320-2020-GRP')).toBe(true);
    expect(hasAudioMarker('Magnum Opus 2019 1080p WEB-DL')).toBe(false);
    expect(hasAudioMarker('Show.S01E01.1080p.WEB-DL')).toBe(false);
  });
});

describe('matchAlbum', () => {
  it.each([
    ['Radiohead - OK Computer (1997) [FLAC]', okc.id],
    ['Radiohead-OK_Computer-CD-FLAC-1997-GROUP', okc.id],
    ['Radiohead - Kid A (2000) [MP3 320]', kidA.id],
    ['On a Friday - Kid A (2000) [FLAC]', kidA.id],
    ['Beatles - Abbey Road (1969) [FLAC]', abbey.id],
    ['The Beatles - Abbey Road (Super Deluxe Edition) (2019) [FLAC 24bit]', abbey.id],
    ['Simon and Garfunkel - Bookends (1968) [FLAC]', bookends.id],
  ])('%s', (title, id) => {
    expect(albumIds(title)).toEqual([id]);
  });

  it('accepts a year one off, and a reissue year when the title is unique for the artist', () => {
    expect(albumIds('Radiohead - OK Computer (1998) [FLAC]')).toEqual([okc.id]);
    expect(albumIds('Radiohead - OK Computer (2017) [FLAC]')).toEqual([okc.id]);
  });

  it('needs the year when several albums share a title; the searched album wins ties', () => {
    expect(albumIds('Weezer - Weezer (2001) [FLAC]')).toEqual([green.id]);
    expect(albumIds('Weezer - Weezer (2008) [FLAC]')).toEqual([red.id]);
    expect(albumIds('Weezer - Weezer (2015) [FLAC]')).toBe('unknownAlbum');
    const noYear = match('Weezer - Weezer [FLAC]');
    expect(noYear.status).toBe('ambiguous');
    expect(albumIds('Weezer - Weezer [FLAC]', { criteria: { mediaType: 'music', artistId: weezer.id, albumIds: [blue.id] } })).toEqual([blue.id]);
  });

  it('matches Various Artists releases on the album alone', () => {
    const m = match('VA - Now That’s What I Call Music! 50 (2001) [MP3 320]');
    expect(m).toMatchObject({ status: 'mapped', matchType: 'album' });
    expect(m.status === 'mapped' && m.albums[0]!.id).toBe(nowThats.id);
  });

  it('reports unknown artists and albums', () => {
    expect(match('Portishead - Dummy (1994) [FLAC]')).toMatchObject({ status: 'unknown', reason: 'unknownArtist' });
    expect(match('Radiohead - Amnesiac (2001) [FLAC]')).toMatchObject({ status: 'unknown', reason: 'unknownAlbum', artist: { id: radiohead.id } });
  });

  it('maps a discography to the albums inside its span that pass the album-type profile', () => {
    const all = match('Radiohead - Discography (1993-2016) [FLAC]');
    expect(all).toMatchObject({ status: 'mapped', pack: 'discography' });
    // The live album is filtered out by the studio profile.
    expect(all.status === 'mapped' && all.albums.map((a) => a.id)).toEqual([okc.id, kidA.id, inRainbows.id, kingOfLimbs.id]);
    expect(albumIds('Radiohead - Discography (1997-2001) [FLAC]')).toEqual([okc.id, kidA.id]);
    expect(albumIds('Radiohead - Discography (1980-1990) [FLAC]')).toBe('emptyPack');
  });
});
