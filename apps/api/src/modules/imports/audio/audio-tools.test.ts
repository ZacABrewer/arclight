import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FfmpegAudioTools,
  canEmbedCover,
  metadataArgs,
  parseReplayGain,
  replayGainArgs,
  splitArgs,
  tagFamilyOf,
  tagTempPath,
  tagWriteArgs,
  type AudioExecFn,
} from './audio-tools.js';

const TAGS = {
  title: 'Opening',
  artist: 'Fixture Artist',
  albumArtist: 'Fixture Artist',
  album: 'First Record',
  date: '2001-05-01',
  trackNumber: 1,
  trackTotal: 3,
  discNumber: 1,
  discTotal: 1,
  mbRecordingId: 'rec-1',
  mbReleaseTrackId: 'trk-1',
  mbReleaseId: 'rel-1',
  mbReleaseGroupId: 'rg-1',
  mbArtistId: 'art-1',
  mbAlbumArtistId: 'art-1',
};

/** `-metadata` pairs as a map. */
function meta(args: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '-metadata') continue;
    const [k, ...v] = args[i + 1]!.split('=');
    out[k!] = v.join('=');
  }
  return out;
}

describe('tag arguments', () => {
  it('knows the tag dialects and cover support', () => {
    expect(tagFamilyOf('/a/b.FLAC')).toBe('vorbis');
    expect(tagFamilyOf('/a/b.opus')).toBe('vorbis');
    expect(tagFamilyOf('/a/b.mp3')).toBe('id3');
    expect(tagFamilyOf('/a/b.m4a')).toBe('mp4');
    expect(tagFamilyOf('/a/b.wv')).toBe('other');
    expect(canEmbedCover('/a/b.flac')).toBe(true);
    expect(canEmbedCover('/a/b.opus')).toBe(false);
  });

  it('writes Picard-style Vorbis comments with MusicBrainz ids and ReplayGain', () => {
    expect(meta(metadataArgs('/x/01.flac', { ...TAGS, replayGainTrackGain: -6.5, replayGainTrackPeak: 0.98765432, genre: null }))).toEqual({
      title: 'Opening',
      artist: 'Fixture Artist',
      album_artist: 'Fixture Artist',
      album: 'First Record',
      date: '2001-05-01',
      TRACKNUMBER: '1',
      TRACKTOTAL: '3',
      DISCNUMBER: '1',
      DISCTOTAL: '1',
      MUSICBRAINZ_TRACKID: 'rec-1',
      MUSICBRAINZ_RELEASETRACKID: 'trk-1',
      MUSICBRAINZ_ALBUMID: 'rel-1',
      MUSICBRAINZ_RELEASEGROUPID: 'rg-1',
      MUSICBRAINZ_ARTISTID: 'art-1',
      MUSICBRAINZ_ALBUMARTISTID: 'art-1',
      REPLAYGAIN_TRACK_GAIN: '-6.50 dB',
      REPLAYGAIN_TRACK_PEAK: '0.987654',
    });
  });

  it('writes ID3 TXXX descriptions and n/total numbers for MP3', () => {
    const m = meta(metadataArgs('/x/01.mp3', { ...TAGS, replayGainTrackGain: 1.234 }));
    expect(m).toMatchObject({ track: '1/3', disc: '1/1', 'MusicBrainz Album Id': 'rel-1', 'MusicBrainz Release Track Id': 'trk-1', REPLAYGAIN_TRACK_GAIN: '+1.23 dB' });
    expect(m['TRACKNUMBER']).toBeUndefined();
  });

  it('writes only standard atoms for MP4', () => {
    const m = meta(metadataArgs('/x/01.m4a', TAGS));
    expect(m).toMatchObject({ title: 'Opening', track: '1/3' });
    expect(Object.keys(m).some((k) => /musicbrainz/i.test(k))).toBe(false);
  });

  it('remuxes into a hidden temporary file with -c copy and an attached cover', () => {
    const temp = tagTempPath('/lib/A/01 - Opening.flac');
    expect(temp).toBe(join('/lib/A', '.01 - Opening.arclight-tagging.flac'));
    const args = tagWriteArgs('/lib/A/01 - Opening.flac', temp, { tags: { title: 'Opening' }, coverPath: '/lib/A/cover.jpg' });
    expect(args.slice(0, 13)).toEqual(['-hide_banner', '-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-i', '/lib/A/01 - Opening.flac', '-protocol_whitelist', 'file,pipe', '-i', '/lib/A/cover.jpg']);
    expect(args.join(' ')).toContain('-map 0:a -map 1:v:0 -disposition:v:0 attached_pic');
    expect(args.join(' ')).toContain('-c copy -map_metadata 0');
    expect(args[args.length - 1]).toBe(temp);
    // No cover: an existing picture stays.
    expect(tagWriteArgs('/a.flac', '/t.flac', { tags: {} }).join(' ')).toContain('-map 0:v?');
    // Opus cannot carry a picture through ffmpeg: the cover is ignored.
    expect(tagWriteArgs('/a.opus', '/t.opus', { tags: {}, coverPath: '/c.jpg' })).not.toContain('/c.jpg');
  });
});

describe('split arguments', () => {
  it('re-encodes lossless spans to FLAC with an input seek and a duration', () => {
    const args = splitArgs({ source: '/dl/img.wav', destination: '/st/02 - Middle Part.flac', startMs: 240_000, endMs: 510_493, lossless: true, tags: { title: 'Middle Part', trackNumber: 2 } });
    expect(args).toEqual([
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-ss',
      '240.000',
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      '/dl/img.wav',
      '-t',
      '270.493',
      '-map',
      '0:a:0',
      '-map_metadata',
      '-1',
      '-c:a',
      'flac',
      '-compression_level',
      '5',
      '-metadata',
      'title=Middle Part',
      '-metadata',
      'TRACKNUMBER=2',
      '/st/02 - Middle Part.flac',
    ]);
  });

  it('stream-copies lossy images; the first track needs no seek, the last no duration', () => {
    const first = splitArgs({ source: '/dl/img.mp3', destination: '/st/01.mp3', startMs: 0, endMs: 1000, lossless: false, tags: {} });
    expect(first).not.toContain('-ss');
    expect(first.join(' ')).toContain('-c:a copy');
    const last = splitArgs({ source: '/dl/img.mp3', destination: '/st/03.mp3', startMs: 5000, endMs: null, lossless: false, tags: {} });
    expect(last).not.toContain('-t');
  });
});

describe('ReplayGain', () => {
  it('parses the replaygain filter log', () => {
    const log = '[Parsed_replaygain_0 @ 0x55d] track_gain = -7.89 dB\n[Parsed_replaygain_0 @ 0x55d] track_peak = 0.991211\n';
    expect(parseReplayGain(log)).toEqual({ gainDb: -7.89, peak: 0.991211 });
    expect(parseReplayGain('nothing here')).toBeNull();
  });

  it('measures a span with null output', () => {
    expect(replayGainArgs('/a.flac', { startMs: 1000, endMs: 3000 }).join(' ')).toBe(
      '-hide_banner -nostdin -nostats -v info -ss 1.000 -protocol_whitelist file,pipe -i /a.flac -t 2.000 -map 0:a:0 -af replaygain -f null -',
    );
  });
});

describe('FfmpegAudioTools', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-audio-tools-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports a missing ffmpeg and refuses to run', async () => {
    const tools = new FfmpegAudioTools({ env: { PATH: '' }, exists: async () => false });
    expect(await tools.available()).toBe(false);
    await expect(tools.measureReplayGain('/a.flac')).rejects.toThrow(/ffmpeg was not found/);
  });

  it('locates ffmpeg through ARCLIGHT_FFMPEG', async () => {
    const tools = new FfmpegAudioTools({ env: { ARCLIGHT_FFMPEG: '/opt/ffmpeg' }, exists: async (p) => p === '/opt/ffmpeg' });
    expect(await tools.available()).toBe(true);
  });

  it('writes tags through a temporary file and renames it over the original', async () => {
    const file = join(dir, '01 - Opening.flac');
    await writeFile(file, 'old');
    const calls: string[][] = [];
    const exec: AudioExecFn = async (_bin, args) => {
      calls.push([...args]);
      await writeFile(args[args.length - 1]!, 'new');
      return { stdout: '', stderr: '' };
    };
    await new FfmpegAudioTools({ binary: '/bin/ffmpeg', exec }).writeTags(file, { tags: { title: 'Opening' } });
    expect(await readFile(file, 'utf8')).toBe('new');
    expect(calls[0]![calls[0]!.length - 1]).toBe(tagTempPath(file));
    expect(await readdir(dir)).toEqual(['01 - Opening.flac']);
  });

  it('keeps the original and removes the temporary file when ffmpeg fails', async () => {
    const file = join(dir, '01.flac');
    await writeFile(file, 'old');
    const exec: AudioExecFn = async (_bin, args) => {
      await writeFile(args[args.length - 1]!, 'half');
      throw new Error('Invalid data found when processing input');
    };
    await expect(new FfmpegAudioTools({ binary: '/bin/ffmpeg', exec }).writeTags(file, { tags: { title: 'x' } })).rejects.toThrow(/Invalid data/);
    expect(await readFile(file, 'utf8')).toBe('old');
    expect(await readdir(dir)).toEqual(['01.flac']);
  });

  it('reads the gain from stderr', async () => {
    const exec: AudioExecFn = async () => ({ stdout: '', stderr: 'track_gain = +2.10 dB\ntrack_peak = 0.5\n' });
    expect(await new FfmpegAudioTools({ binary: '/bin/ffmpeg', exec }).measureReplayGain('/a.flac')).toEqual({ gainDb: 2.1, peak: 0.5 });
  });
});
