import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { FIXTURE_IDS, FIXTURES } from './fixtures/generate.js';
import {
  audioTagsFromFfprobe,
  canonicalTagKey,
  createCombinedTagReader,
  createFfprobeTagReader,
  createMusicMetadataReader,
  durationLooksSuspect,
  emptyAudioTags,
  normalizeTagEntries,
  parseNumberPair,
  TagReadError,
  type AudioTags,
  type TagReader,
} from './tags.js';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const fx = (name: string) => join(fixtures, name);
const tmp = mkdtempSync(join(tmpdir(), 'arclight-tags-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('fixtures', () => {
  it('are tiny and match the generator byte for byte', () => {
    for (const [name, build] of Object.entries(FIXTURES)) {
      const onDisk = readFileSync(fx(name));
      expect(onDisk.length, name).toBeLessThan(20 * 1024);
      expect(Buffer.compare(onDisk, Buffer.from(build())), `${name} is stale: rerun fixtures/generate.ts`).toBe(0);
    }
  });
});

describe('canonicalTagKey', () => {
  it.each([
    // ID3v2
    ['TIT2', 'title'],
    ['TPE2', 'albumArtist'],
    ['TP2', 'albumArtist'],
    ['TPOS', 'disc'],
    ['TXXX:MusicBrainz Album Id', 'mbReleaseId'],
    ['TXXX:MusicBrainz Release Group Id', 'mbReleaseGroupId'],
    ['TXXX:MusicBrainz Release Track Id', 'mbReleaseTrackId'],
    ['UFID', 'mbRecordingId'],
    // Vorbis comments
    ['ALBUMARTIST', 'albumArtist'],
    ['MUSICBRAINZ_TRACKID', 'mbRecordingId'],
    ['MUSICBRAINZ_ALBUMID', 'mbReleaseId'],
    ['TRACKTOTAL', 'trackOf'],
    ['TOTALDISCS', 'discOf'],
    // MP4 atoms and iTunes freeform
    ['©nam', 'title'],
    ['aART', 'albumArtist'],
    ['trkn', 'track'],
    ['disk', 'disc'],
    ['©nrt', 'narrator'],
    ['©mvn', 'series'],
    ['----:com.apple.iTunes:MusicBrainz Track Id', 'mbRecordingId'],
    ['----:com.apple.iTunes:ASIN', 'asin'],
    // APEv2
    ['Album Artist', 'albumArtist'],
    ['MUSICBRAINZ_RELEASEGROUPID', 'mbReleaseGroupId'],
    ['Track', 'track'],
    // ffprobe generic names
    ['album_artist', 'albumArtist'],
    ['MusicBrainz Album Id', 'mbReleaseId'],
    ['SERIES-PART', 'seriesPart'],
  ] as const)('%s -> %s', (key, field) => {
    expect(canonicalTagKey(key)).toBe(field);
  });

  it('ignores unknown keys', () => {
    expect(canonicalTagKey('ENCODER')).toBeNull();
    expect(canonicalTagKey('TXXX:Something Else')).toBeNull();
  });
});

describe('normalizeTagEntries', () => {
  it('folds APE items with "n/total" numbers and the first value per field', () => {
    const tags = normalizeTagEntries([
      ['Title', 'Song'],
      ['Album Artist', 'Band'],
      ['Track', '3/12'],
      ['Disc', '2/2'],
      ['Year', '1999'],
      ['MUSICBRAINZ_ALBUMID', '00000000-0000-4000-8000-0000000000b9'],
      ['Title', 'Ignored second value'],
      ['Compilation', '1'],
    ]);
    expect(tags).toMatchObject({ title: 'Song', albumArtist: 'Band', trackNo: 3, trackOf: 12, discNo: 2, discOf: 2, date: '1999', compilation: true });
    expect(tags.mbReleaseId).toBe('00000000-0000-4000-8000-0000000000b9');
  });

  it('keeps only MusicBrainz-owned UFIDs and the first of several artist ids', () => {
    const tags = normalizeTagEntries([
      ['UFID', { owner_identifier: 'http://example.org', identifier: new TextEncoder().encode('nope') }],
      ['UFID', { owner_identifier: 'http://musicbrainz.org', identifier: new TextEncoder().encode(FIXTURE_IDS.recording1) }],
      ['MUSICBRAINZ_ARTISTID', `${FIXTURE_IDS.artist}; 00000000-0000-4000-8000-0000000000c2`],
    ]);
    expect(tags.mbRecordingId).toBe(FIXTURE_IDS.recording1);
    expect(tags.mbArtistId).toBe(FIXTURE_IDS.artist);
  });

  it('parses number pairs', () => {
    expect(parseNumberPair('03 of 12')).toEqual({ no: 3, of: 12 });
    expect(parseNumberPair('7')).toEqual({ no: 7, of: null });
    expect(parseNumberPair('A1')).toEqual({ no: null, of: null });
    expect(parseNumberPair('0/0')).toEqual({ no: null, of: null });
  });
});

describe('music-metadata reader', () => {
  const reader = createMusicMetadataReader();
  const album = {
    artist: 'Fixture Artist',
    albumArtist: 'Fixture Artist',
    album: 'Silent Album',
    date: '2001-02-03',
    trackOf: 3,
    discNo: 1,
    discOf: 1,
    mbReleaseId: FIXTURE_IDS.release,
    mbReleaseGroupId: FIXTURE_IDS.releaseGroup,
    mbArtistId: FIXTURE_IDS.artist,
    mbAlbumArtistId: FIXTURE_IDS.artist,
  };

  it('reads FLAC (Vorbis comments)', async () => {
    const t = await reader.read(fx('tagged.flac'));
    expect(t).toMatchObject({ ...album, title: 'First Light', trackNo: 1, mbRecordingId: FIXTURE_IDS.recording1 });
    expect(t).toMatchObject({ codec: 'FLAC', container: 'FLAC', sampleRateHz: 44100, bitDepth: 16, channels: 2, durationMs: 3000, lossless: true, chapters: null });
    expect(t.source).toBe('music-metadata');
  });

  it('reads MP3 (ID3v2.4 with TXXX and UFID)', async () => {
    const t = await reader.read(fx('tagged.mp3'));
    expect(t).toMatchObject({ ...album, title: 'Second Wind', trackNo: 2, mbRecordingId: FIXTURE_IDS.recording2 });
    expect(t).toMatchObject({ codec: 'MPEG 1 Layer 3', bitrateKbps: 32, sampleRateHz: 44100, channels: 1, lossless: false });
    expect(Math.abs(t.durationMs! - 3000)).toBeLessThan(50);
  });

  it('reads M4A (iTunes atoms and freeform MusicBrainz ids)', async () => {
    const t = await reader.read(fx('tagged.m4a'));
    expect(t).toMatchObject({ ...album, title: 'Third Time', trackNo: 3, mbRecordingId: FIXTURE_IDS.recording3 });
    expect(t.codec).toBe('MPEG-4/AAC');
    expect(Math.abs(t.durationMs! - 3000)).toBeLessThan(50);
  });

  it('reads M4B chapters, narrator, series and ASIN', async () => {
    const t = await reader.read(fx('chapters.m4b'));
    expect(t).toMatchObject({ title: 'A Quiet Book', artist: 'Fixture Author', narrator: 'Fixture Narrator', series: 'Quiet Series', seriesPart: '2', asin: 'B000000000' });
    expect(t.chapters).toEqual([
      { title: 'Opening', startMs: 0, endMs: 2000 },
      { title: 'Middle', startMs: 2000, endMs: 4000 },
      { title: 'Ending', startMs: 4000, endMs: t.durationMs },
    ]);
  });

  it('reads untagged WAV stream facts', async () => {
    const t = await reader.read(fx('untagged.wav'));
    expect(t).toMatchObject({ title: null, album: null, codec: 'PCM', sampleRateHz: 8000, bitDepth: 16, channels: 1, durationMs: 1000 });
  });

  it('rejects a corrupt FLAC and a text file posing as MP3', async () => {
    await expect(reader.read(fx('corrupt.flac'))).rejects.toMatchObject({ name: 'TagReadError', code: 'UNREADABLE' });
    const fake = join(tmp, 'notes.mp3');
    writeFileSync(fake, 'just some text, not audio at all\n'.repeat(4));
    await expect(reader.read(fake)).rejects.toBeInstanceOf(TagReadError);
  });

  it('stays in the low milliseconds per file once warm', async () => {
    const names = ['tagged.flac', 'tagged.mp3', 'tagged.m4a', 'chapters.m4b'];
    for (const n of names) await reader.read(fx(n));
    const rounds = 10;
    const started = performance.now();
    for (let i = 0; i < rounds; i++) for (const n of names) await reader.read(fx(n));
    const perFile = (performance.now() - started) / (rounds * names.length);
    expect(perFile).toBeLessThan(50); // generous for CI; ~1-3 ms locally
  });
});

// Shape of `ffprobe -v error -print_format json -show_format -show_streams -show_chapters`
// for an ID3-tagged MP3 (hand-written from the documented output format).
const FFPROBE_MP3 = JSON.stringify({
  streams: [
    { index: 0, codec_name: 'mp3', codec_type: 'audio', sample_fmt: 'fltp', sample_rate: '44100', channels: 2, bit_rate: '320000', duration: '245.123000' },
  ],
  chapters: [],
  format: {
    filename: 'x.mp3',
    format_name: 'mp3',
    duration: '245.123000',
    bit_rate: '320512',
    tags: {
      title: 'Song',
      artist: 'Band',
      album_artist: 'Band',
      album: 'Record',
      date: '2004',
      track: '5/11',
      disc: '1/1',
      'MusicBrainz Album Id': '00000000-0000-4000-8000-0000000000b5',
      'MusicBrainz Release Group Id': '00000000-0000-4000-8000-0000000000a5',
      'MusicBrainz Artist Id': '00000000-0000-4000-8000-0000000000c5',
    },
  },
});

const FFPROBE_M4B = JSON.stringify({
  streams: [{ codec_name: 'aac', codec_type: 'audio', sample_rate: '22050', channels: 1, bit_rate: '64000' }],
  chapters: [
    { id: 0, start_time: '0.000000', end_time: '600.500000', tags: { title: 'Chapter One' } },
    { id: 1, start_time: '600.500000', end_time: '1200.000000', tags: { title: 'Chapter Two' } },
  ],
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '1200.000000', tags: { title: 'Book', artist: 'Author', composer: 'Someone' } },
});

describe('ffprobe reader', () => {
  const runner = { locate: async () => '/usr/local/bin/ffprobe' };

  it('maps ffprobe JSON', () => {
    const t = audioTagsFromFfprobe(FFPROBE_MP3);
    expect(t).toMatchObject({
      title: 'Song',
      albumArtist: 'Band',
      trackNo: 5,
      trackOf: 11,
      discNo: 1,
      mbReleaseId: '00000000-0000-4000-8000-0000000000b5',
      mbReleaseGroupId: '00000000-0000-4000-8000-0000000000a5',
      codec: 'mp3',
      container: 'mp3',
      bitrateKbps: 320,
      sampleRateHz: 44100,
      channels: 2,
      durationMs: 245123,
      lossless: false,
      source: 'ffprobe',
      durationSource: 'ffprobe',
    });
    expect(audioTagsFromFfprobe(FFPROBE_M4B).chapters).toEqual([
      { title: 'Chapter One', startMs: 0, endMs: 600500 },
      { title: 'Chapter Two', startMs: 600500, endMs: 1200000 },
    ]);
  });

  it('runs the located binary with format, streams and chapters', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const reader = createFfprobeTagReader({
      runner,
      exec: async (file, args) => {
        calls.push({ file, args });
        return { stdout: FFPROBE_MP3 };
      },
    });
    expect((await reader.read('/music/a.mp3')).title).toBe('Song');
    expect(calls[0]!.file).toBe('/usr/local/bin/ffprobe');
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['-show_format', '-show_streams', '-show_chapters', '/music/a.mp3']));
  });

  it('reports a missing binary, a failed run and a stream without audio', async () => {
    await expect(createFfprobeTagReader({ runner: { locate: async () => null } }).read('x')).rejects.toMatchObject({ code: 'FFPROBE_MISSING' });
    const failing = createFfprobeTagReader({ runner, exec: async () => Promise.reject(new Error('Invalid data found')) });
    await expect(failing.read('x')).rejects.toMatchObject({ code: 'FFPROBE_FAILED' });
    const noAudio = createFfprobeTagReader({ runner, exec: async () => ({ stdout: JSON.stringify({ streams: [{ codec_type: 'video' }] }) }) });
    await expect(noAudio.read('x')).rejects.toMatchObject({ code: 'UNREADABLE' });
  });
});

describe('combined reader', () => {
  const fakeFfprobe = (durationMs: number | null, extra: Partial<AudioTags> = {}): TagReader & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      read: async (path) => {
        calls.push(path);
        return { ...emptyAudioTags('ffprobe'), title: 'From ffprobe', durationMs, durationSource: 'ffprobe', ...extra };
      },
    };
  };

  it('falls back to ffprobe when music-metadata cannot parse the file', async () => {
    const ff = fakeFfprobe(1234);
    const t = await createCombinedTagReader({ ffprobe: ff }).read(fx('corrupt.flac'));
    expect(t).toMatchObject({ title: 'From ffprobe', source: 'ffprobe', durationMs: 1234 });
  });

  it('rethrows without ffprobe (absent or not installed)', async () => {
    await expect(createCombinedTagReader().read(fx('corrupt.flac'))).rejects.toBeInstanceOf(TagReadError);
    const missing = { ...fakeFfprobe(1), available: async () => false };
    await expect(createCombinedTagReader({ ffprobe: missing }).read(fx('corrupt.flac'))).rejects.toBeInstanceOf(TagReadError);
  });

  it("takes ffprobe's duration only when the two disagree by more than 2 s", async () => {
    const far = await createCombinedTagReader({ ffprobe: fakeFfprobe(9000), durationCheck: 'always' }).read(fx('tagged.flac'));
    expect(far).toMatchObject({ title: 'First Light', durationMs: 9000, durationSource: 'ffprobe', source: 'music-metadata' });
    const near = await createCombinedTagReader({ ffprobe: fakeFfprobe(4500), durationCheck: 'always' }).read(fx('tagged.flac'));
    expect(near).toMatchObject({ durationMs: 3000, durationSource: 'music-metadata' });
  });

  it('only asks ffprobe about suspect durations by default', async () => {
    const ff = fakeFfprobe(9000);
    const t = await createCombinedTagReader({ ffprobe: ff }).read(fx('tagged.mp3'));
    expect(ff.calls).toEqual([]);
    expect(t.durationSource).toBe('music-metadata');
    // Pretend the file is ten times larger than a 32 kbit/s, 3 s stream can be.
    const sus = fakeFfprobe(30000);
    const t2 = await createCombinedTagReader({ ffprobe: sus, sizeOf: async () => 120_000 }).read(fx('tagged.mp3'));
    expect(sus.calls.length).toBe(1);
    expect(t2.durationMs).toBe(30000);
  });

  it('durationLooksSuspect', () => {
    const base = { ...emptyAudioTags(), durationMs: 180_000, bitrateKbps: 320, lossless: false };
    expect(durationLooksSuspect(base, 7_200_000)).toBe(false);
    expect(durationLooksSuspect(base, 1_000_000)).toBe(true);
    expect(durationLooksSuspect({ ...base, durationMs: null }, 1)).toBe(true);
    expect(durationLooksSuspect(base, 7_200_000, ['bad frame'])).toBe(true);
    expect(durationLooksSuspect({ ...base, lossless: true }, 1)).toBe(false);
  });
});
