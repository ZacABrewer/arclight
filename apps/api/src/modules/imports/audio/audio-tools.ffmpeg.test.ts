import { execFile } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { promisify } from 'node:util';
import { parseFile } from 'music-metadata';
import { describe, expect, it } from 'vitest';
import { FfmpegAudioTools, type AudioExecFn } from './audio-tools.js';

// Opt-in check against a real ffmpeg (the unit tests in audio-tools.test.ts only see argument
// lists). Skipped unless ARCLIGHT_FFMPEG_IT names an ffmpeg binary:
//
//   ARCLIGHT_FFMPEG_IT=/usr/bin/ffmpeg pnpm vitest run audio-tools.ffmpeg
//
// ARCLIGHT_FFMPEG_IT_DOCKER=<image> runs that binary inside the image instead, with
// ARCLIGHT_FFMPEG_IT_DIR mounted at the same path in the container (so paths match on both sides;
// ARCLIGHT_FFMPEG_IT_HOST_DIR overrides the mount source, e.g. a drive path on Windows).

const BINARY = process.env['ARCLIGHT_FFMPEG_IT'];
const IMAGE = process.env['ARCLIGHT_FFMPEG_IT_DOCKER'];
const DIR = process.env['ARCLIGHT_FFMPEG_IT_DIR'] ?? join(process.cwd(), '.ffmpeg-it');
const HOST_DIR = process.env['ARCLIGHT_FFMPEG_IT_HOST_DIR'] ?? DIR;
const run = promisify(execFile);
/** A file in DIR; POSIX-joined when ffmpeg runs in a (Linux) container. */
const at = (name: string) => (IMAGE ? posix.join(DIR, name) : join(DIR, name));

const exec: AudioExecFn = async (file, args, opts) => {
  // A Windows host joins paths with backslashes (the tag temp file); the container wants slashes.
  const inner = IMAGE && process.platform === 'win32' ? args.map((a) => (a.startsWith('\\') ? a.replaceAll('\\', '/') : a)) : [...args];
  const [cmd, argv] = IMAGE ? ['docker', ['run', '--rm', '--network', 'none', '-v', `${HOST_DIR}:${DIR}`, '--entrypoint', file, IMAGE, ...inner]] : [file, inner];
  const { stdout, stderr } = await run(cmd, argv, { timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return { stdout, stderr };
};

describe.skipIf(!BINARY)('FfmpegAudioTools against a real ffmpeg', () => {
  it('splits a cue image losslessly, writes tags and measures ReplayGain', async () => {
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    try {
      const image = at('image.flac');
      // A 6 s stereo 16/44.1 test tone as the "single-file album".
      await exec(BINARY!, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=6', '-ac', '2', '-sample_fmt', 's16', image], { timeoutMs: 60_000 });
      const tools = new FfmpegAudioTools({ binary: BINARY!, exec });
      expect(await tools.available()).toBe(true);

      const spans = [
        { n: 1, startMs: 0, endMs: 2000 },
        { n: 2, startMs: 2000, endMs: 4500 },
        { n: 3, startMs: 4500, endMs: null },
      ];
      for (const s of spans) {
        await tools.split({
          source: image,
          destination: at(`0${s.n}.flac`),
          startMs: s.startMs,
          endMs: s.endMs,
          lossless: true,
          tags: { title: `Tone ${s.n}`, artist: 'Test Artist', album: 'Test Album', trackNumber: s.n, trackTotal: 3, mbRecordingId: '00000000-0000-4000-8000-00000000000' + s.n },
        });
      }
      const durations: number[] = [];
      for (const s of spans) {
        const meta = await parseFile(at(`0${s.n}.flac`));
        durations.push(meta.format.duration ?? 0);
        expect(meta.format.codec).toMatch(/flac/i);
        expect(meta.format.bitsPerSample).toBe(16);
        expect(meta.format.sampleRate).toBe(44_100);
        expect(meta.common.title).toBe(`Tone ${s.n}`);
        expect(meta.common.track.no).toBe(s.n);
      }
      expect(durations[0]).toBeCloseTo(2, 1);
      expect(durations[1]).toBeCloseTo(2.5, 1);
      expect(durations[2]).toBeCloseTo(1.5, 1);

      const gain = await tools.measureReplayGain(at('02.flac'));
      expect(gain).not.toBeNull();
      expect(Number.isFinite(gain!.gainDb)).toBe(true);
      expect(gain!.peak).toBeGreaterThan(0);

      const before = (await stat(at('02.flac'))).size;
      await tools.writeTags(at('02.flac'), {
        tags: { title: 'Retitled', artist: 'Test Artist', album: 'Test Album', trackNumber: 2, trackTotal: 3, replayGainTrackGain: gain!.gainDb, replayGainTrackPeak: gain!.peak },
      });
      const tagged = await parseFile(at('02.flac'));
      expect(tagged.common.title).toBe('Retitled');
      expect(tagged.format.duration).toBeCloseTo(2.5, 1);
      expect((await stat(at('02.flac'))).size).toBeGreaterThan(before / 2);
    } finally {
      await rm(DIR, { recursive: true, force: true });
    }
  });
});
