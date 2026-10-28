import { describe, expect, it } from 'vitest';
import type { AudioCodec, AudioVbrPreset } from '@arclight/shared';
import {
  audiobookAudioEvaluation,
  audiobookFileLayout,
  audiobookQualityFor,
  audiobookReleaseKind,
  parseAudioPath,
  parseAudiobookRelease,
  type ParsedAudiobookInfo,
} from './index.js';

const info = (name: string): ParsedAudiobookInfo => {
  const r = parseAudiobookRelease(name).audiobook;
  if (!r) throw new Error(`not parsed: ${name}`);
  return r;
};

describe('audiobookQualityFor', () => {
  it.each<[AudioCodec, number | null, AudioVbrPreset | null, string]>([
    ['MP3', 32, null, 'AB-MP3-Low'],
    ['MP3', 63, null, 'AB-MP3-Low'],
    ['MP3', 64, null, 'AB-MP3'],
    ['MP3', 127, null, 'AB-MP3'],
    ['MP3', 128, null, 'AB-MP3-High'],
    ['MP3', 320, null, 'AB-MP3-High'],
    ['MP3', null, null, 'AB-MP3'],
    ['MP3', null, 'V0', 'AB-MP3-High'],
    ['AAC', 32, null, 'AB-AAC-Low'],
    ['AAC', 64, null, 'AB-AAC'],
    ['AAC', null, null, 'AB-AAC'],
    ['Opus', 24, null, 'AB-Opus'],
    ['FLAC', null, null, 'AB-Lossless'],
    ['ALAC', null, null, 'AB-Lossless'],
    ['WAV', null, null, 'AB-Lossless'],
    ['Vorbis', 64, null, 'Unknown'],
    ['Unknown', 64, null, 'Unknown'],
  ])('%s %s %s → %s', (codec, kbps, vbr, name) => {
    const q = audiobookQualityFor({ codec, bitrateKbps: kbps, vbrPreset: vbr });
    expect(q.name).toBe(name);
    expect(q.id === 0 || q.mediaTypes.includes('audiobook')).toBe(true);
  });
});

describe('audiobookFileLayout', () => {
  it('prefers the file count, then the stated layout, then the container', () => {
    expect(audiobookFileLayout({ container: 'mp3', fileLayout: null }, 1)).toBe('single');
    expect(audiobookFileLayout({ container: 'm4b', fileLayout: null }, 12)).toBe('multi');
    expect(audiobookFileLayout({ container: 'mp3', fileLayout: 'single' })).toBe('single');
    expect(audiobookFileLayout({ container: 'm4b', fileLayout: null })).toBe('single');
    expect(audiobookFileLayout({ container: 'mp3', fileLayout: null })).toBe('multi');
    expect(audiobookFileLayout({ container: 'flac', fileLayout: null })).toBe('multi');
    expect(audiobookFileLayout({ container: 'm4a', fileLayout: null })).toBeNull();
    expect(audiobookFileLayout({ container: 'unknown', fileLayout: null }, 0)).toBeNull();
  });
});

describe('audiobookAudioEvaluation', () => {
  it('builds the audio block profiles read', () => {
    const ev = audiobookAudioEvaluation(info('Mara Quill - The Glass Orchard (Unabridged) {Simon Vale} [M4B 64kbps]'));
    expect(ev).toEqual({ codec: 'AAC', bitrateKbps: 64, hasLog: false, hasCue: false, fileLayout: 'single', formatType: 'unabridged', narrators: ['Simon Vale'] });
  });

  it('leaves unknown facts out and takes a known file count', () => {
    const plain = audiobookAudioEvaluation(info('Mara Quill - The Glass Orchard'));
    expect(plain).toEqual({ codec: 'Unknown', hasLog: false, hasCue: false });
    const counted = audiobookAudioEvaluation(info('Mara Quill - The Glass Orchard [m4b]'), { fileCount: 3 });
    expect(counted.fileLayout).toBe('multi');
  });

  it('keeps the MP3 VBR preset', () => {
    expect(audiobookAudioEvaluation(info('Mara Quill - The Glass Orchard [MP3 V0]'))).toMatchObject({ codec: 'MP3', vbrPreset: 'V0', fileLayout: 'multi' });
  });
});

describe('audiobookReleaseKind', () => {
  it('tells packs from single books', () => {
    expect(audiobookReleaseKind(info('Tobias Wren - Ember Road Books 1-5 [mp3]'))).toBe('bookPack');
    expect(audiobookReleaseKind(info('Tobias Wren - Ember Road - Complete Series'))).toBe('bookPack');
    expect(audiobookReleaseKind(info('Tobias Wren - Ember Road 03 - The Salt Gate'))).toBe('single');
  });
});

describe('parseAudiobookRelease', () => {
  it('returns null info for an empty name', () => {
    expect(parseAudiobookRelease('').audiobook).toBeNull();
    expect(parseAudiobookRelease('[mp3] [64kbps]').audiobook).toBeNull();
  });

  it('maps the quality onto the release audio', () => {
    const r = parseAudiobookRelease('Mara Quill - The Glass Orchard [MP3 32kbps]');
    expect(r.audio.quality.name).toBe('AB-MP3-Low');
    expect(r.audiobook?.audio.quality.name).toBe('AB-MP3-Low');
  });
});

describe('parseAudioPath', () => {
  it('dispatches on the domain', () => {
    const book = parseAudioPath('/audiobooks/Andrew Pell/Meridian/Book 1 - The Iron Meridian/01.mp3', 'audiobook');
    expect(book.audiobook).toMatchObject({ authors: ['Andrew Pell'], series: 'Meridian', seriesPosition: '1', title: 'The Iron Meridian' });
    const album = parseAudioPath('/music/Artist/Album (2020)/01 - Track.flac');
    expect(album.music?.album).toBe('Album');
  });

  it('never takes a library root for the author', () => {
    const r = parseAudioPath('/audiobooks/The Iron Meridian/01.mp3', 'audiobook');
    expect(r.audiobook).toMatchObject({ authors: [], title: 'The Iron Meridian' });
  });
});
