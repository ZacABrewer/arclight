import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VideoInfo } from '@arclight/shared';
import { CapacityModel } from './capacity.js';
import { Fmp4Splitter, initTracks, type Fmp4Fragment, type Fmp4Track } from './fmp4.js';
import { HlsSessions, spawnHls, type HlsLauncher, type HlsSession } from './jobs.js';
import { probeIndex, readMkvIndex, readMp4Index, type KeyframeIndex, type ProbeExec } from './keyframes.js';
import { buildLadder, type Ladder } from './ladder.js';
import { SOFTWARE_CAPS } from './pipeline.js';
import { segmentPlan, type SegmentPlan } from './plan.js';
import { mediaPlaylist } from './playlist.js';

// Opt-in check of the HLS segmenter against a real ffmpeg (hls.test.ts and jobs.test.ts only see
// argument lists and synthetic fragments). Skipped unless ARCLIGHT_FFMPEG_IT names an ffmpeg
// binary (ffprobe is expected next to it):
//
//   ARCLIGHT_FFMPEG_IT=/usr/bin/ffmpeg pnpm vitest run hls.ffmpeg
//
// ARCLIGHT_FFMPEG_IT_DOCKER=<image> runs ffmpeg and ffprobe inside the image instead (no network),
// with ARCLIGHT_FFMPEG_IT_DIR mounted at the same path in the container (ARCLIGHT_FFMPEG_IT_HOST_DIR
// overrides the mount source, e.g. a drive path on Windows). The test media is generated with
// ffmpeg's own test sources.

const BINARY = process.env['ARCLIGHT_FFMPEG_IT'];
const PROBE = BINARY ? BINARY.replace(/ffmpeg(\.exe)?$/, (_m, ext: string | undefined) => `ffprobe${ext ?? ''}`) : '';
const IMAGE = process.env['ARCLIGHT_FFMPEG_IT_DOCKER'];
const DIR = process.env['ARCLIGHT_FFMPEG_IT_DIR'] ?? join(process.cwd(), '.ffmpeg-it-hls');
const HOST_DIR = process.env['ARCLIGHT_FFMPEG_IT_HOST_DIR'] ?? DIR;
const run = promisify(execFile);
/** A path as ffmpeg sees it. */
const at = (name: string) => (IMAGE ? posix.join(DIR, name) : join(DIR, name));
/** The same path on this machine. */
const host = (name: string) => join(HOST_DIR, name);
const DURATION = 60;

const dockerArgs = (bin: string, args: readonly string[], name?: string) => ['run', '--rm', '-i', '--network', 'none', ...(name ? ['--name', name] : []), '-v', `${HOST_DIR}:${DIR}`, '--entrypoint', bin, IMAGE!, ...args];

async function tool(bin: string, args: readonly string[]): Promise<string> {
  const [cmd, argv] = IMAGE ? ['docker', dockerArgs(bin, args)] : [bin, [...args]];
  const { stdout } = await run(cmd, argv, { timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}
/** probeIndex reads the file size here, then runs ffprobe on the same file where ffmpeg runs. */
const probeExec: ProbeExec = (bin, args) => {
  const root = join(HOST_DIR);
  return tool(bin, args.map((a) => (IMAGE && a.startsWith(root) ? at(a.slice(root.length).replace(/^[\\/]+/, '').replaceAll('\\', '/')) : a)));
};

/** The HLS launcher; in a container each run gets a name so a kill stops the container too. */
let runs = 0;
const launcher: HlsLauncher = (bin, args) => {
  if (process.env['HLS_IT_DEBUG']) console.info('ARGS', JSON.stringify(args));
  if (!IMAGE) return spawnHls(bin, args);
  const name = `arclight-hls-it-${process.pid}-${++runs}`;
  const proc = spawnHls('docker', dockerArgs(bin, args, name));
  return {
    ...proc,
    pause: () => false,
    kill: () => {
      spawn('docker', ['kill', name], { stdio: 'ignore' }).on('error', () => undefined);
      proc.kill();
    },
  };
};

const INFO = {
  mediaFileId: 1,
  versionTag: null,
  container: 'mkv',
  videoCodec: 'h264',
  videoProfile: 'High',
  bitDepth: 8,
  width: 1280,
  height: 720,
  fps: 24,
  dynamicRange: 'sdr',
  sizeBytes: 1,
  bitrateKbps: 2000,
  audioTracks: [{ index: 0, codec: 'ac3', channels: 2, language: 'eng', title: null, default: true }],
  subtitleTracks: [],
} as unknown as VideoInfo;
const BROWSER = { containers: ['mp4'], videoCodecs: ['h264'], hevc10bit: false, hdr: [], audioCodecs: ['aac'], maxAudioChannels: 2, maxHeight: 2160 };

interface Packet {
  stream: number;
  pts: number;
  key: boolean;
}
async function packets(file: string): Promise<Packet[]> {
  const out = await tool(PROBE, ['-v', 'error', '-show_entries', 'packet=stream_index,pts_time,flags', '-of', 'csv=p=0', file]);
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [s, pts, flags] = l.split(',');
      return { stream: Number(s), pts: Number(pts), key: (flags ?? '').includes('K') };
    });
}

let mkvIndex: KeyframeIndex;
let plan: SegmentPlan;
let ladder: Ladder;
let sessions: HlsSessions;
const timings: string[] = [];

function newSessions() {
  return new HlsSessions({
    root: () => host('hls'),
    cacheBytes: () => 10e9,
    maxStreams: () => 4,
    maxPerDevice: () => 4,
    locate: async () => BINARY!,
    capacity: new CapacityModel({ file: null }),
    launcher,
  });
}
async function open(rung: string, device: string): Promise<HlsSession> {
  return sessions.create({ userId: 1, deviceKey: device, mediaFileId: 1, input: at('film.mkv'), info: INFO, plan, index: mkvIndex, ladder: { ...ladder, startRung: rung as Ladder['startRung'] }, caps: SOFTWARE_CAPS, burnSource: null });
}

describe.skipIf(!BINARY)('HLS segmenter against a real ffmpeg', { timeout: 600_000 }, () => {
  beforeAll(async () => {
    await rm(HOST_DIR, { recursive: true, force: true });
    await mkdir(host('hls'), { recursive: true });
    // 60 s of 720p24 H.264 (B-frames, a keyframe every 2.5 s) with stereo AC-3, in MKV and MP4.
    const src = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=24:duration=${DURATION}`, '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${DURATION}`, '-c:v', 'libx264', '-preset', 'veryfast', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-ac', '2'];
    await tool(BINARY!, [...src, '-c:a', 'ac3', at('film.mkv')]);
    await tool(BINARY!, [...src, '-c:a', 'aac', '-movflags', '+faststart', at('film.mp4')]);
    sessions = newSessions();
    await sessions.start();
  }, 600_000);
  afterAll(async () => {
    await sessions?.close();
    if (timings.length) console.info(`[hls.ffmpeg] ${timings.join('; ')}`);
    await rm(HOST_DIR, { recursive: true, force: true });
  });

  it('the MKV Cues and the MP4 sync samples match the keyframes ffprobe finds', async () => {
    const mkv = await readMkvIndex(host('film.mkv'));
    const mp4 = await readMp4Index(host('film.mp4'));
    const probed = await probeIndex(PROBE, host('film.mkv'), probeExec);
    const probedMp4 = await probeIndex(PROBE, host('film.mp4'), probeExec);
    expect(mkv && mp4 && probed && probedMp4).toBeTruthy();
    expect(mkv!.keyframes.length).toBe(DURATION / 2.5);
    expect(probed!.keyframes.length).toBe(mkv!.keyframes.length);
    mkv!.keyframes.forEach((t, i) => expect(Math.abs(t - probed!.keyframes[i]!)).toBeLessThan(0.002));
    expect(mp4!.keyframes.length).toBe(probedMp4!.keyframes.length);
    mp4!.keyframes.forEach((t, i) => expect(Math.abs(t - probedMp4!.keyframes[i]!)).toBeLessThan(0.002));
    mkvIndex = mkv!;
    plan = segmentPlan(mkvIndex, DURATION);
    expect(plan.keyframeAligned).toBe(true);
    ladder = buildLadder({ info: INFO, baseRange: null, profile: BROWSER, audioTrack: 0, subtitle: null, quality: 'auto', capKbps: 0, remote: false, plan, index: mkvIndex, caps: SOFTWARE_CAPS, predict: () => ({ speed: 10, measured: true }) });
    expect(ladder.rungs.map((r) => r.id)).toContain('src');
    expect(ladder.rungs.some((r) => r.mode === 'transcode')).toBe(true);
  });

  for (const which of ['transcode', 'copy'] as const) {
    it(`${which}: keyframe-first segments at media time, continuous across a seek restart, and a playlist ffprobe reads`, async () => {
      const rung = ladder.rungs.find((r) => r.mode === which)!.id;
      const K = Math.floor(plan.starts.length / 2);
      // Reference: one run from the start.
      const a = await open(rung, `a-${rung}`);
      sessions.waitMs = 120_000;
      let t0 = Date.now();
      await a.segment(rung, 0);
      timings.push(`${rung} first segment ${Date.now() - t0} ms`);
      t0 = Date.now();
      for (let n = 0; n < plan.starts.length; n++) await a.segment(rung, n);
      const wall = (Date.now() - t0) / 1000;
      timings.push(`${rung} whole file ${wall.toFixed(1)} s (${(DURATION / Math.max(wall, 0.001)).toFixed(1)}x incl. the first segment)`);
      // A second session that starts at K (a seek): its segments meet the reference's K-1.
      const b = await open(rung, `b-${rung}`);
      t0 = Date.now();
      const bK = await b.segment(rung, K);
      timings.push(`${rung} seek restart to segment ${K} ${Date.now() - t0} ms`);
      await b.segment(rung, K + 1);

      const dir = host(`out-${rung}`);
      await mkdir(dir, { recursive: true });
      const aInit = await a.initSegment(rung);
      const seam = Buffer.concat([await readFile(aInit), await readFile(join(a.dir, rung, `s${K - 1}.m4s`)), await readFile(bK), await readFile(join(b.dir, rung, `s${K + 1}.m4s`))]);
      await writeFile(join(dir, 'seam.mp4'), seam);
      const pk = await packets(at(`out-${rung}/seam.mp4`));
      const video = pk.filter((p) => p.stream === 0).sort((x, y) => x.pts - y.pts);
      const audio = pk.filter((p) => p.stream === 1);
      // The new run's first video frame is a keyframe at the segment's start (media time).
      const firstOfK = video.find((p) => p.pts >= plan.starts[K]! - 0.01)!;
      expect(firstOfK.key).toBe(true);
      expect(Math.abs(firstOfK.pts - plan.starts[K]!)).toBeLessThan(1 / 24 + 0.002);
      // No gap or overlap in video (one frame = 41.7 ms) or audio (one AAC frame = 21.3 ms).
      for (let i = 1; i < video.length; i++) expect(video[i]!.pts - video[i - 1]!.pts).toBeCloseTo(1 / 24, 2);
      if (process.env['HLS_IT_DEBUG']) console.info(rung, K, plan.starts[K], audio.map((p) => p.pts.toFixed(4)).join(' '));
      for (let i = 1; i < audio.length; i++) {
        const d = audio[i]!.pts - audio[i - 1]!.pts;
        expect(d).toBeGreaterThan(0.015);
        expect(d).toBeLessThan(0.03);
      }

      // Every segment of the reference starts with a keyframe at its planned time. The time is read
      // from the boxes (tfdt + the first composition offset): ffprobe moves a stream whose first
      // composition offset is negative (segment 0, CMAF style) up by that offset, players do not.
      const initBytes = await readFile(aInit);
      for (const n of [0, 1, K, plan.starts.length - 1]) {
        const one = Buffer.concat([initBytes, await readFile(join(a.dir, rung, `s${n}.m4s`))]);
        await writeFile(join(dir, `one-${n}.mp4`), one);
        const v = (await packets(at(`out-${rung}/one-${n}.mp4`))).filter((p) => p.stream === 0);
        expect(v.reduce((m, p) => (p.pts < m.pts ? p : m)).key, `segment ${n}`).toBe(true);
        let tracks: Fmp4Track[] = [];
        const frags: Fmp4Fragment[] = [];
        new Fmp4Splitter(
          (i) => (tracks = initTracks(i)),
          (f) => frags.push(f),
        ).push(one);
        const vt = tracks.find((t) => t.kind === 'video')!;
        const first = frags[0]!.trafs.find((t) => t.trackId === vt.id)!;
        const pts = Number(first.decodeTime + BigInt(first.firstCts)) / vt.timescale;
        expect(Math.abs(pts - plan.starts[n]!), `segment ${n} starts at ${pts}`).toBeLessThan(0.002);
      }

      // The VOD playlist over the reference's files plays end to end.
      await copyFile(aInit, join(dir, 'init.mp4'));
      for (let n = 0; n < plan.starts.length; n++) await copyFile(join(a.dir, rung, `s${n}.m4s`), join(dir, `${n}.m4s`));
      await writeFile(join(dir, 'index.m3u8'), mediaPlaylist(plan, ''));
      const all = await packets(at(`out-${rung}/index.m3u8`));
      const frames = all.filter((p) => p.stream === 0).length;
      expect(Math.abs(frames - DURATION * 24)).toBeLessThanOrEqual(2);
      const speed = a.encoder?.speed ?? null;
      if (speed !== null) timings.push(`${rung} encoder speed ${speed.toFixed(1)}x`);
      console.info(`[hls.ffmpeg] ${timings.splice(0).join('; ')}`);
      await sessions.delete(a.id);
      await sessions.delete(b.id);
    });
  }
});
