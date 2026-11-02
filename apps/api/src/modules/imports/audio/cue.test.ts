import { describe, expect, it } from 'vitest';
import {
  CueParseError,
  cueMatchFiles,
  cueTrackSpans,
  cueVirtualPath,
  decodeCueText,
  framesToMs,
  parseCueSheet,
  parseCueTime,
  parseCueVirtualPath,
  resolveCueFile,
} from './cue.js';
import { matchTracks, type ReleaseCandidate } from './track-match.js';

const EAC = [
  'REM GENRE "Art Rock"',
  'REM DATE 1999',
  'REM DISCID 8A0B4C0D',
  'REM COMMENT "ExactAudioCopy v1.6"',
  'REM DISCNUMBER 2',
  'REM TOTALDISCS 2',
  'REM REPLAYGAIN_ALBUM_GAIN -7.25 dB',
  'REM REPLAYGAIN_ALBUM_PEAK 0.988800',
  'CATALOG 0724384960650',
  'PERFORMER "Fixture Artist"',
  'TITLE "First Record"',
  'FILE "Fixture Artist - First Record.wav" WAVE',
  '  TRACK 01 AUDIO',
  '    TITLE "Opening"',
  '    PERFORMER "Fixture Artist"',
  '    SONGWRITER "Some Writer"',
  '    ISRC GBAAA9900001',
  '    FLAGS DCP PRE',
  '    REM REPLAYGAIN_TRACK_GAIN -6.10 dB',
  '    INDEX 01 00:00:00',
  '  TRACK 02 AUDIO',
  '    TITLE "Middle Part"',
  '    PREGAP 00:02:00',
  '    INDEX 00 03:58:50',
  '    INDEX 01 04:00:00',
  '  TRACK 03 AUDIO',
  '    TITLE Closing Time',
  '    INDEX 01 08:30:37',
  '    POSTGAP 00:01:00',
].join('\r\n');

describe('cue time', () => {
  it('parses mm:ss:ff at 75 frames per second', () => {
    expect(parseCueTime('00:00:00')).toBe(0);
    expect(parseCueTime('01:02:03')).toBe((62 * 75) + 3);
    expect(parseCueTime('120:00:74')).toBe(120 * 60 * 75 + 74);
    expect(framesToMs(75)).toBe(1000);
    expect(framesToMs(parseCueTime('08:30:37')!)).toBe(510_493);
  });

  it('rejects malformed times', () => {
    expect(parseCueTime('1:60:00')).toBeNull();
    expect(parseCueTime('00:00:75')).toBeNull();
    expect(parseCueTime('00:00')).toBeNull();
    expect(parseCueTime('aa:bb:cc')).toBeNull();
  });
});

describe('parseCueSheet', () => {
  it('reads disc fields, REM fields and tracks (CRLF)', () => {
    const sheet = parseCueSheet(EAC);
    expect(sheet).toMatchObject({
      title: 'First Record',
      performer: 'Fixture Artist',
      catalog: '0724384960650',
      genre: 'Art Rock',
      date: '1999',
      discId: '8A0B4C0D',
      comment: 'ExactAudioCopy v1.6',
      discNumber: 2,
      totalDiscs: 2,
      replayGainAlbumGain: -7.25,
      replayGainAlbumPeak: 0.9888,
    });
    expect(sheet.files).toHaveLength(1);
    expect(sheet.files[0]).toMatchObject({ name: 'Fixture Artist - First Record.wav', type: 'WAVE' });
    expect(sheet.tracks.map((t) => t.title)).toEqual(['Opening', 'Middle Part', 'Closing Time']);
    expect(sheet.tracks[0]).toMatchObject({
      number: 1,
      type: 'AUDIO',
      performer: 'Fixture Artist',
      songwriter: 'Some Writer',
      isrc: 'GBAAA9900001',
      flags: ['DCP', 'PRE'],
      rem: { REPLAYGAIN_TRACK_GAIN: '-6.10 dB' },
    });
    expect(sheet.tracks[1]!.pregapFrames).toBe(150);
    expect(sheet.tracks[1]!.indexes).toEqual([
      { number: 0, frames: parseCueTime('03:58:50') },
      { number: 1, frames: parseCueTime('04:00:00') },
    ]);
    expect(sheet.tracks[2]!.postgapFrames).toBe(75);
    expect(sheet.warnings).toEqual([]);
  });

  it('strips a UTF-8 BOM and accepts LF and lower-case commands', () => {
    const sheet = parseCueSheet('﻿file "a.flac" wave\ntrack 1 audio\n  title "Ünïcödé"\n  index 01 00:00:00\n');
    expect(sheet.files[0]!.name).toBe('a.flac');
    expect(sheet.tracks[0]!.title).toBe('Ünïcödé');
  });

  it('decodes UTF-8 bytes, UTF-16 with a BOM and falls back to Windows-1252', () => {
    const text = 'FILE "a.flac" WAVE\nTRACK 01 AUDIO\nTITLE "Café — Señor"\nINDEX 01 00:00:00\n';
    expect(parseCueSheet(new TextEncoder().encode(text)).tracks[0]!.title).toBe('Café — Señor');
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
    expect(parseCueSheet(bom).tracks[0]!.title).toBe('Café — Señor');
    // Windows-1252: é = 0xE9, — = 0x97, ñ = 0xF1 (not valid UTF-8).
    const cp1252 = new Uint8Array([...new TextEncoder().encode('FILE "a.flac" WAVE\nTRACK 01 AUDIO\nTITLE "Caf'), 0xe9, 0x20, 0x97, 0x20, 0x53, 0x65, 0xf1, 0x6f, 0x72, ...new TextEncoder().encode('"\nINDEX 01 00:00:00\n')]);
    expect(parseCueSheet(cp1252).tracks[0]!.title).toBe('Café — Señor');
    const utf16 = new Uint8Array(2 + text.length * 2);
    utf16[0] = 0xff;
    utf16[1] = 0xfe;
    for (let i = 0; i < text.length; i++) {
      utf16[2 + i * 2] = text.charCodeAt(i) & 0xff;
      utf16[3 + i * 2] = text.charCodeAt(i) >> 8;
    }
    expect(decodeCueText(utf16)).toBe(text);
  });

  it('keeps unquoted values with spaces and file names with spaces', () => {
    const sheet = parseCueSheet('PERFORMER Some Band\nFILE My Album Image.flac WAVE\nTRACK 01 AUDIO\nTITLE A Song Title\nINDEX 01 00:00:00\n');
    expect(sheet.performer).toBe('Some Band');
    expect(sheet.files[0]!.name).toBe('My Album Image.flac');
    expect(sheet.tracks[0]!.title).toBe('A Song Title');
  });

  it('handles sheets with several FILE entries', () => {
    const sheet = parseCueSheet(
      ['FILE "01.wav" WAVE', 'TRACK 01 AUDIO', 'INDEX 01 00:00:00', 'FILE "02.wav" WAVE', 'TRACK 02 AUDIO', 'INDEX 00 00:00:00', 'INDEX 01 00:01:00'].join('\n'),
    );
    expect(sheet.files.map((f) => [f.name, f.tracks.map((t) => t.number)])).toEqual([
      ['01.wav', [1]],
      ['02.wav', [2]],
    ]);
    expect(sheet.tracks[1]!.file).toBe('02.wav');
  });

  it('throws on sheets without tracks and warns about junk', () => {
    expect(() => parseCueSheet('')).toThrow(CueParseError);
    expect(() => parseCueSheet('REM only a comment\nTITLE "x"')).toThrow(CueParseError);
    expect(() => parseCueSheet(new Uint8Array([0, 1, 2, 3, 255, 254]))).toThrow(CueParseError);
    const sheet = parseCueSheet('TRACK 01 AUDIO\nFILE "a.flac" WAVE\nTRACK xx AUDIO\nTRACK 02 AUDIO\nINDEX 01 99:99:99\nBOGUS line\n');
    expect(sheet.tracks.map((t) => t.number)).toEqual([2]);
    expect(sheet.warnings.join('\n')).toMatch(/TRACK before any FILE/);
    expect(sheet.warnings.join('\n')).toMatch(/bad track number/);
    expect(sheet.warnings.join('\n')).toMatch(/bad INDEX/);
    expect(sheet.warnings.join('\n')).toMatch(/unknown command BOGUS/);
    expect(sheet.warnings.join('\n')).toMatch(/track 2: no INDEX/);
  });
});

describe('cue track spans', () => {
  const sheet = parseCueSheet(EAC);
  const image = { path: '/dl/First Record/Fixture Artist - First Record.flac', durationMs: 720_000 };

  it('resolves the FILE by name, then by stem (sheet written for the .wav)', () => {
    expect(resolveCueFile('Fixture Artist - First Record.wav', [image])).toBe(image);
    expect(resolveCueFile('other.wav', [image], 2)).toBeNull();
    expect(resolveCueFile('other.wav', [image], 1)).toBe(image);
  });

  it('runs each track to the next INDEX 01 and the last to the end of the image', () => {
    const spans = cueTrackSpans(sheet, [image])!;
    expect(spans.map((s) => [s.track.number, s.startMs, s.endMs, s.durationMs])).toEqual([
      [1, 0, 240_000, 240_000],
      [2, 240_000, 510_493, 270_493],
      [3, 510_493, null, 209_507],
    ]);
    expect(cueTrackSpans(sheet, [{ ...image, durationMs: null }])![2]!.durationMs).toBeNull();
  });

  it('gives up on unresolvable files and out-of-order indexes', () => {
    expect(cueTrackSpans(sheet, [{ path: '/dl/x/unrelated.flac', durationMs: 1 }, { path: '/dl/x/other.flac', durationMs: 1 }])).toBeNull();
    const bad = parseCueSheet('FILE "a.flac" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:10:00\nTRACK 02 AUDIO\nINDEX 01 00:05:00\n');
    expect(cueTrackSpans(bad, [{ path: '/a.flac', durationMs: 60_000 }])).toBeNull();
  });

  it('virtual paths round-trip', () => {
    const v = cueVirtualPath(image.path, 12);
    expect(parseCueVirtualPath(v)).toEqual({ imagePath: image.path, trackNumber: 12 });
    expect(parseCueVirtualPath(image.path)).toBeNull();
  });

  it('maps cue tracks to a release with the existing matcher', () => {
    const spans = cueTrackSpans(sheet, [image])!;
    const files = cueMatchFiles(sheet, spans, [image]);
    expect(files[0]).toMatchObject({ title: 'Opening', artist: 'Fixture Artist', trackNo: 1, discNo: 2, durationMs: 240_000 });
    const release: ReleaseCandidate = {
      id: 'rel-1',
      media: [
        { position: 1, tracks: [{ position: 1, title: 'Something Else', durationMs: 100_000, recordingId: null }] },
        {
          position: 2,
          tracks: [
            { position: 1, title: 'Opening', durationMs: 240_500, recordingId: null, ref: 11 },
            { position: 2, title: 'Middle Part', durationMs: 270_000, recordingId: null, ref: 12 },
            { position: 3, title: 'Closing Time', durationMs: 209_000, recordingId: null, ref: 13 },
          ],
        },
      ],
    };
    const result = matchTracks(files, [release]);
    expect(result.best!.mapping.map((m) => [parseCueVirtualPath(m.path)!.trackNumber, m.ref])).toEqual([
      [1, 11],
      [2, 12],
      [3, 13],
    ]);
    expect(result.best!.missingTracks.map((t) => t.title)).toEqual(['Something Else']);
  });
});
