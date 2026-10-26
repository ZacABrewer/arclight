import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createAnalysisProbe, FfprobeError, FfprobeRunner, locateFfprobe, type ExecFn } from './runner.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, 'fixtures', name), 'utf8');

/** Records calls; answers stream probes, frame probes and duration probes from fixtures. */
function fakeExec(streams: string, frames?: string): ExecFn & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = Object.assign(async (_file: string, args: readonly string[]) => {
    calls.push([...args]);
    if (args.includes('-show_frames')) {
      if (!frames) throw new FfprobeError('FAILED', 'no frames');
      return { stdout: frames };
    }
    if (args.includes('format=duration')) return { stdout: JSON.stringify({ format: { duration: '2551.104000' } }) };
    return { stdout: streams };
  }, { calls });
  return fn;
}

describe('locateFfprobe', () => {
  it('prefers ARCLIGHT_FFPROBE when the file exists', async () => {
    const found = await locateFfprobe({ ARCLIGHT_FFPROBE: '/opt/ff/ffprobe', PATH: '/usr/bin' }, async (p) => p === '/opt/ff/ffprobe', 'linux');
    expect(found).toBe('/opt/ff/ffprobe');
  });

  it('returns null when ARCLIGHT_FFPROBE points nowhere (no silent PATH fallback)', async () => {
    expect(await locateFfprobe({ ARCLIGHT_FFPROBE: '/missing', PATH: '/usr/bin' }, async (p) => p.endsWith('ffprobe') && !p.startsWith('/missing'), 'linux')).toBeNull();
  });

  it('walks PATH and tries .exe on Windows', async () => {
    const seen: string[] = [];
    const found = await locateFfprobe(
      { PATH: 'C:\\a;C:\\ffmpeg\\bin' },
      async (p) => {
        seen.push(p);
        return p.toLowerCase().includes('ffmpeg') && p.endsWith('ffprobe.exe');
      },
      'win32',
    );
    expect(found).toContain('ffprobe.exe');
    expect(seen.length).toBeGreaterThan(1);
    expect(await locateFfprobe({ PATH: '' }, async () => false, 'linux')).toBeNull();
  });
});

describe('FfprobeRunner', () => {
  it('runs ffprobe with JSON output and parses streams', async () => {
    const exec = fakeExec(fixture('sdr-h264-1080p.json'));
    const runner = new FfprobeRunner({ binary: '/usr/bin/ffprobe', exec });
    const info = await runner.analyze('/tv/x.mkv');
    expect(info.videoCodec).toBe('AVC');
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0]).toEqual(expect.arrayContaining(['-print_format', 'json', '-show_format', '-show_streams', '/tv/x.mkv']));
  });

  it('probes the first frame for PQ content and detects HDR10+', async () => {
    const exec = fakeExec(fixture('dv-p8-hdr10plus.json'), fixture('dv-p8-hdr10plus.frames.json'));
    const info = await new FfprobeRunner({ binary: 'ffprobe', exec }).analyze('/m.mp4');
    expect(exec.calls).toHaveLength(2);
    expect(exec.calls[1]).toEqual(expect.arrayContaining(['-show_frames', '-read_intervals', '%+#1', '-select_streams', 'v:0']));
    expect(info.videoDynamicRange).toBe('DV HDR10Plus');
  });

  it('a failing frame probe does not fail the analysis', async () => {
    const exec = fakeExec(fixture('hdr10-hevc-2160p.json'));
    const info = await new FfprobeRunner({ binary: 'ffprobe', exec }).analyze('/m.mkv');
    expect(info.videoDynamicRange).toBe('HDR10');
  });

  it('throws MISSING when ffprobe cannot be found, and PARSE on garbage output', async () => {
    const missing = new FfprobeRunner({ env: { PATH: '' }, exists: async () => false });
    await expect(missing.analyze('/x.mkv')).rejects.toMatchObject({ code: 'MISSING' });
    expect(await missing.available()).toBe(false);
    const garbage = new FfprobeRunner({ binary: 'ffprobe', exec: async () => ({ stdout: 'oops' }) });
    await expect(garbage.analyze('/x.mkv')).rejects.toMatchObject({ code: 'PARSE' });
  });

  it('probeDuration reads the container duration; null on failure', async () => {
    const runner = new FfprobeRunner({ binary: 'ffprobe', exec: fakeExec('{}') });
    expect(await runner.probeDuration('/x.mkv')).toBeCloseTo(2551.104);
    const failing = new FfprobeRunner({ binary: 'ffprobe', exec: async () => Promise.reject(new Error('boom')) });
    expect(await failing.probeDuration('/x.mkv')).toBeNull();
  });

  it('createAnalysisProbe maps MediaInfo to the imports ProbeResult (null when unreadable)', async () => {
    const probe = createAnalysisProbe(new FfprobeRunner({ binary: 'ffprobe', exec: fakeExec(fixture('multi-audio-anime.json')) }));
    expect(await probe('/a.mkv')).toEqual({ runtimeSeconds: 1420, audioStreams: 3, width: 1920, height: 1080, videoCodec: 'hevc', audioCodec: 'flac', audioChannels: 2 });
    const broken = createAnalysisProbe({ analyze: () => Promise.reject(new Error('unreadable')) });
    expect(await broken('/a.mkv')).toBeNull();
  });
});
