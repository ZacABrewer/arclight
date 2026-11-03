import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { MediaInfo } from '@arclight/shared';
import { createTestDb, seedAdmin } from '../../db/test-utils.js';
import { SAMPLE_RATE } from './fingerprint.js';
import { chordTheme, episode, mix, speechLike } from './fingerprint.fixtures.js';
import { SDR_1080, seedMovie, seedSeries } from './media-services.fixtures.js';
import { ffmpegLog, type LogRunner } from './segment-boundaries.js';
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

/** The boundary probe through the same host / image switch. */
const probe: LogRunner = (_bin, args, timeoutMs) => {
  const [cmd, argv] = cmdOf(args);
  return ffmpegLog(cmd, argv, timeoutMs);
};

/** 8 kHz mono PCM as a WAV file (ffmpeg encodes it from there). */
function wav(pcm: Int16Array): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.byteLength, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([h, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}

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
      probe,
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

  it('dialogue over the intro, recaps and black frames: four H.264/AAC episodes', async () => {
    await mkdir(DIR, { recursive: true });
    const S = SAMPLE_RATE;
    // 240 s: the 96 s head window holds every intro.
    const EP = 240;
    // head 0-72 s, body 72-117 s, tail 117-180 s.
    const introAt = [20.3, 33.7, 26.1, 30.9];
    const theme = chordTheme(40, 11);
    const bed = (seed: number) => {
      const n = episode(EP, seed, new Int16Array(0), 0);
      let y = 0;
      return n.map((v) => {
        y = 0.95 * y + 0.05 * v;
        return Math.round(y * 2);
      }) as Int16Array;
    };
    const pcms: Int16Array[] = [];
    // Recap clips: [episode, from s, length s], played back to back from 0.
    const recaps: Array<Array<[number, number, number]>> = [
      [],
      [[0, 80, 6], [0, 100, 5], [0, 130, 7], [0, 90, 6], [0, 150, 5]],
      [[1, 85, 8], [1, 140, 6], [0, 105, 5], [1, 95, 7]],
      [[2, 78, 7], [2, 110, 8], [2, 125, 6], [2, 160, 9]],
    ];
    for (let i = 0; i < 4; i++) {
      const at0 = Math.round(introAt[i]! * S);
      // Dialogue all through, the theme's last 10 s in the clear.
      const speech = speechLike(EP, 900 + i);
      speech.fill(0, at0 + 30 * S, at0 + 40 * S);
      const music = new Int16Array(EP * S);
      music.set(theme, at0);
      const pcm = mix(mix(bed(400 + i), speech), music, 0.5);
      let t = 0;
      for (const [from, fromS, len] of recaps[i]!) {
        pcm.set(pcms[from]!.subarray(fromS * S, (fromS + len) * S), t * S);
        t += len;
      }
      pcms.push(pcm);
      await writeFile(at(`d${i + 1}.wav`), wav(pcm));
      // A black moment of 0.4 s before the intro and right after it.
      const a = introAt[i]!;
      const black = `drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(t,${(a - 0.4).toFixed(2)},${a.toFixed(2)})+between(t,${(a + 40).toFixed(2)},${(a + 40.4).toFixed(2)})'`;
      await ffmpeg([
        '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=10:duration=${EP}`,
        '-i', at(`d${i + 1}.wav`),
        '-vf', black, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-shortest', at(`d${i + 1}.mkv`),
      ]); // prettier-ignore
    }
    const recapEnd = [0, 29, 26, 30];
    const db = await createTestDb();
    seedAdmin(db);
    const info = { ...SDR_1080, width: 320, height: 180, durationMs: EP * 1000, audioStreams: [{ codec: 'aac', channels: 1, language: 'eng', title: null, default: true }] } as MediaInfo;
    const { show } = seedSeries(db, DIR, { title: 'Dialogue', tmdbId: 10, episodes: introAt.map((_, i) => ({ season: 1, episode: i + 1, info, path: at(`d${i + 1}.mkv`) })) });
    const svc = new SegmentService({
      db,
      locate: async () => (IMAGE ? 'docker' : BINARY!),
      settings: () => ({ segmentDetection: true, segmentDetectionRecaps: true }) as never,
      probe,
      liveBusy: () => false,
      limiter: new Limiter(1, 100),
      extract: (_bin, args, timeoutMs) => {
        const [cmd, argv] = cmdOf(args);
        return ffmpegPcm(cmd, argv, timeoutMs);
      },
    });
    const t0 = Date.now();
    await svc.scanSeason(show.id, 1);
    const files = svc.seasonFiles(show.id, 1);
    const report: string[] = [`scan ${Date.now() - t0} ms`];
    let lateStarts = 0;
    for (let i = 0; i < 4; i++) {
      const segs = await effectiveSegments(db, { id: files[i]!.mediaFileId, path: files[i]!.path }, []);
      report.push(`ep${i + 1} ${segs.map((x) => `${x.type} ${x.startMs}-${x.endMs}`).join(', ')}`);
      // eslint-disable-next-line no-console
      console.log(report[report.length - 1]);
      const intro = segs.find((x) => x.type === 'intro');
      expect(intro, `intro of episode ${i + 1}`).toBeDefined();
      // Snapped onto the black frames where the audio match lands within 2 s of them. Dialogue
      // can hide the theme's first seconds from some neighbours (a late start); never by more
      // than 20 s here, and at most one episode of four.
      const startOff = Math.abs(intro!.startMs - introAt[i]! * 1000);
      if (startOff > 500) lateStarts++;
      expect(startOff, `intro start ${i + 1}`).toBeLessThanOrEqual(20_000);
      expect(Math.abs(intro!.endMs - (introAt[i]! + 40) * 1000), `intro end ${i + 1}`).toBeLessThanOrEqual(1000);
      const recap = segs.find((x) => x.type === 'recap');
      if (i === 0) expect(recap).toBeUndefined();
      else {
        expect(recap, `recap of episode ${i + 1}`).toBeDefined();
        expect(recap!.startMs).toBe(0);
        expect(Math.abs(recap!.endMs - recapEnd[i]! * 1000), `recap end ${i + 1}`).toBeLessThanOrEqual(3000);
      }
    }
    // eslint-disable-next-line no-console
    console.log(report.join(' | '));
    expect(lateStarts).toBeLessThanOrEqual(1);
  }, 1_500_000);
});
