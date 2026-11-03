import { execFile } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { MediaInfo } from '@arclight/shared';
import { createTestDb, seedAdmin } from '../../db/test-utils.js';
import { SAMPLE_RATE } from './fingerprint.js';
import { SDR_1080, seedMovie, seedSeries } from './media-services.fixtures.js';
import { buildAudioExtractArgs, effectiveSegments, ffmpegPcm, SegmentService } from './segments.js';
import { jpegSize, TrickplayService, type TrickplayRunner } from './trickplay.js';
import { Limiter } from './video-stream.js';

// Opt-in checks of scrub thumbnails and intro detection against a real ffmpeg on generated media
// (the unit tests only see argument lists and fake output). Skipped unless ARCLIGHT_FFMPEG_IT
// names an ffmpeg binary:
//
//   ARCLIGHT_FFMPEG_IT=/usr/bin/ffmpeg pnpm vitest run media-services.ffmpeg
//
// ARCLIGHT_FFMPEG_IT_DOCKER=<image> runs that binary inside the image instead, with
// ARCLIGHT_FFMPEG_IT_DIR mounted at the same path in the container (so paths match on both sides;
// ARCLIGHT_FFMPEG_IT_HOST_DIR overrides the mount source, e.g. a drive path on Windows).

const BINARY = process.env['ARCLIGHT_FFMPEG_IT'];
const IMAGE = process.env['ARCLIGHT_FFMPEG_IT_DOCKER'];
const DIR = join(process.env['ARCLIGHT_FFMPEG_IT_DIR'] ?? join(process.cwd(), '.ffmpeg-it'), 'player');
const HOST_DIR = join(process.env['ARCLIGHT_FFMPEG_IT_HOST_DIR'] ?? process.env['ARCLIGHT_FFMPEG_IT_DIR'] ?? join(process.cwd(), '.ffmpeg-it'), 'player');
const run = promisify(execFile);
const at = (name: string) => (IMAGE ? posix.join(DIR.replaceAll('\\', '/'), name) : join(DIR, name));
/** Host paths joined on Windows start with a backslash; the container wants slashes. */
const inner = (args: readonly string[]) => (IMAGE && process.platform === 'win32' ? args.map((a) => (a.startsWith('\\') ? a.replaceAll('\\', '/') : a)) : [...args]);
const mount = () => ['run', '--rm', '-i', '--network', 'none', '-v', `${HOST_DIR}:${DIR.replaceAll('\\', '/')}`, '--entrypoint', BINARY!, IMAGE!];
/** [command, argv] that runs ffmpeg with `args` on the host or in the image. */
const cmdOf = (args: readonly string[]): [string, string[]] => (IMAGE ? ['docker', [...mount(), ...inner(args)]] : [BINARY!, [...args]]);
const ffmpeg = async (args: string[]) => {
  const [cmd, argv] = cmdOf(['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  await run(cmd, argv, { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
};

const runner: TrickplayRunner = async (_bin, args, timeoutMs) => {
  const [cmd, argv] = cmdOf(args);
  try {
    await run(cmd, argv, { timeout: timeoutMs });
    return 0;
  } catch (err) {
    return (err as { code?: number }).code ?? 1;
  }
};

describe.skipIf(!BINARY)('player media services against a real ffmpeg', () => {
  it('scrub thumbnails of a 30 s test video: one sheet of 320x180 tiles, 3 tiles', async () => {
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    await ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=24:duration=30', '-c:v', 'libx264', '-g', '24', '-pix_fmt', 'yuv420p', at('clip.mkv')]);
    const db = await createTestDb();
    seedAdmin(db);
    const { file } = seedMovie(db, DIR, { title: 'Clip', tmdbId: 1, path: at('clip.mkv'), info: { ...SDR_1080, width: 1280, height: 720, durationMs: 30_000 } as MediaInfo });
    const svc = new TrickplayService({
      db,
      dir: at('cache'),
      locate: async () => BINARY!,
      zscale: async () => false,
      settings: () => ({ trickplay: 'on-play' }) as never,
      liveBusy: () => false,
      limiter: new Limiter(1, 100),
      run: runner,
    });
    svc.enqueue(file.id);
    await svc.idle();
    const st = await svc.status(file.id, { enqueue: false });
    expect(st.status).toBe('ready');
    const m = (st as { manifest: { stamp: string; sheetCount: number; tileWidth: number; tileHeight: number; tileCount: number } }).manifest;
    expect(m).toMatchObject({ sheetCount: 1, tileWidth: 320, tileHeight: 180, tileCount: 3 });
    const sheet = await svc.sheetPath(file.id, 0, m.stamp);
    expect(jpegSize(await readFile(sheet!))).toEqual({ width: 3200, height: 1800 });
  }, 180_000);

  it('PCM extraction: mono 8 kHz s16le of the asked window', async () => {
    await mkdir(DIR, { recursive: true });
    await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=10', '-c:a', 'flac', at('tone.mkv')]);
    const [cmd, argv] = cmdOf(buildAudioExtractArgs(at('tone.mkv'), 0, 2000, 5000));
    const pcm = await ffmpegPcm(cmd, argv, 60_000);
    expect(pcm.length).toBe(5 * SAMPLE_RATE * 2);
    const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
    let crossings = 0;
    for (let i = 1; i < s.length; i++) if (s[i - 1]! < 0 !== s[i]! < 0) crossings++;
    // 1 kHz: two zero crossings per period.
    expect(crossings / 5).toBeGreaterThan(1950);
    expect(crossings / 5).toBeLessThan(2050);
  }, 120_000);

  it('intro detection on three AAC episodes sharing a theme at different offsets', async () => {
    await mkdir(DIR, { recursive: true });
    // A 40 s theme: a 2.5 s rising chirp and a stepped melody that does not repeat within 40 s.
    await ffmpeg(['-f', 'lavfi', '-i', 'aevalsrc=0.45*sin(2*PI*(400*t+420*mod(t\\,2.5)*mod(t\\,2.5)))+0.3*sin(2*PI*(500+150*mod(floor(t*3)*floor(t*3)\\,13))*t):s=48000:d=40', '-c:a', 'pcm_s16le', at('theme.wav')]);
    const offsets = [8.4, 27.25, 15.6];
    // Each episode: its own pink noise, the theme (the same master, as real intros are), more
    // noise; encoded to AAC separately, so frames and resampling never line up exactly.
    for (let i = 0; i < offsets.length; i++) {
      await ffmpeg([
        '-f', 'lavfi', '-i', `anoisesrc=d=${offsets[i]}:c=pink:r=48000:a=0.3:seed=${100 + i}`,
        '-i', at('theme.wav'),
        '-f', 'lavfi', '-i', `anoisesrc=d=${160 - offsets[i]!}:c=pink:r=48000:a=0.3:seed=${200 + i}`,
        '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1[out]', '-map', '[out]',
        '-c:a', 'aac', '-b:a', '128k', at(`ep${i + 1}.mkv`),
      ]); // prettier-ignore
    }
    const db = await createTestDb();
    seedAdmin(db);
    const info = { ...SDR_1080, durationMs: 200_000, audioStreams: [{ codec: 'aac', channels: 1, language: 'eng', title: null, default: true }] } as MediaInfo;
    const { show } = seedSeries(db, DIR, { title: 'Real', tmdbId: 9, episodes: offsets.map((_, i) => ({ season: 1, episode: i + 1, info, path: at(`ep${i + 1}.mkv`) })) });
    const svc = new SegmentService({
      db,
      locate: async () => (IMAGE ? 'docker' : BINARY!),
      settings: () => ({ segmentDetection: true }) as never,
      liveBusy: () => false,
      limiter: new Limiter(1, 100),
      extract: (_bin, args, timeoutMs) => {
        const [cmd, argv] = cmdOf(args);
        return ffmpegPcm(cmd, argv, timeoutMs);
      },
    });
    expect(await svc.scanSeason(show.id, 1)).toBeGreaterThanOrEqual(3);
    const files = svc.seasonFiles(show.id, 1);
    for (let i = 0; i < offsets.length; i++) {
      const segs = await effectiveSegments(db, { id: files[i]!.mediaFileId, path: files[i]!.path }, []);
      const intro = segs.find((s) => s.type === 'intro');
      expect(intro, `intro of episode ${i + 1}`).toBeDefined();
      expect(Math.abs(intro!.startMs - offsets[i]! * 1000)).toBeLessThanOrEqual(1000);
      expect(Math.abs(intro!.endMs - (offsets[i]! + 40) * 1000)).toBeLessThanOrEqual(1500);
    }
  }, 300_000);
});
