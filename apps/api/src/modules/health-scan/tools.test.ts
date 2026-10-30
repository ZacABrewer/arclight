import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { errorLines, FfmpegHealthTools, locatePriorityTools, type ProcessFn, type RunResult } from './tools.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, '..', 'media-analysis', 'fixtures', 'sdr-h264-1080p.json'), 'utf8');

/** Records every process call; answers ffprobe with a recorded fixture and ffmpeg per `decode`. */
function fakeRun(decode: (args: readonly string[]) => RunResult = () => ({ exitCode: 0, stdout: '', stderr: '' }), probe: RunResult = { exitCode: 0, stdout: fixture, stderr: '' }) {
  const calls: Array<{ file: string; args: string[] }> = [];
  const run: ProcessFn = async (file, args) => {
    calls.push({ file, args: [...args] });
    return args.includes('-show_streams') ? probe : decode(args);
  };
  return { run, calls };
}

describe('FfmpegHealthTools', () => {
  it('probes with ffprobe and summarises streams', async () => {
    const { run, calls } = fakeRun();
    const tools = new FfmpegHealthTools({ run, binaries: { ffprobe: '/usr/bin/ffprobe', ffmpeg: '/usr/bin/ffmpeg' } });
    const r = await tools.probe('/m/x.mkv', { lowPriority: false });
    expect(r).toMatchObject({ ok: true, info: { hasVideo: true } });
    expect(r && r.ok && r.info.audioStreamCount).toBeGreaterThan(0);
    expect(calls[0]).toEqual({ file: '/usr/bin/ffprobe', args: expect.arrayContaining(['-show_format', '-show_streams', '/m/x.mkv']) });
  });

  it('runs at low priority through nice and ionice when they exist', async () => {
    const { run, calls } = fakeRun();
    const tools = new FfmpegHealthTools({ run, binaries: { ffprobe: '/usr/bin/ffprobe', ffmpeg: '/usr/bin/ffmpeg', nice: '/usr/bin/nice', ionice: '/usr/bin/ionice' } });
    await tools.decode('/m/x.mkv', 'video', 'quick', 3600, { lowPriority: true });
    expect(calls).toHaveLength(3);
    expect(calls[0]!.file).toBe('/usr/bin/nice');
    expect(calls[0]!.args.slice(0, 6)).toEqual(['-n', '19', '/usr/bin/ionice', '-c', '3', '/usr/bin/ffmpeg']);
    expect(calls.map((c) => (c.args.includes('-ss') ? c.args[c.args.indexOf('-ss') + 1] : '0'))).toEqual(['0', '1795', '3589']);
  });

  it('collects decode error lines and stops at a failing slice', async () => {
    const { run, calls } = fakeRun((args) =>
      args.includes('1795') ? { exitCode: 1, stdout: '', stderr: '[matroska] Read error\n\nInvalid data\n' } : { exitCode: 0, stdout: '', stderr: '[h264 @ 0x1] error while decoding MB 4 5\n' },
    );
    const tools = new FfmpegHealthTools({ run, binaries: { ffprobe: 'ffprobe', ffmpeg: 'ffmpeg' } });
    const r = await tools.decode('/m/x.mkv', 'video', 'quick', 3600, { lowPriority: true });
    expect(r).toEqual({ exitCode: 1, errors: ['[h264 @ 0x1] error while decoding MB 4 5', '[matroska] Read error', 'Invalid data'] });
    expect(calls).toHaveLength(2);
    // No nice/ionice available: the command runs as is.
    expect(calls[0]!.file).toBe('ffmpeg');
  });

  it('reports a failing probe and missing tools', async () => {
    const { run } = fakeRun(undefined, { exitCode: 1, stdout: '', stderr: 'x.mkv: Invalid data found when processing input\n' });
    const tools = new FfmpegHealthTools({ run, binaries: { ffprobe: 'ffprobe', ffmpeg: null } });
    expect(await tools.probe('/x.mkv', { lowPriority: false })).toEqual({ ok: false, message: 'x.mkv: Invalid data found when processing input' });
    expect(await tools.decode('/x.mkv', 'video', 'quick', 10, { lowPriority: false })).toBeNull();
    expect(await tools.available()).toEqual({ ffprobe: true, ffmpeg: false });
    const none = new FfmpegHealthTools({ run, binaries: { ffprobe: null, ffmpeg: null } });
    expect(await none.probe('/x.mkv', { lowPriority: false })).toBeNull();
  });
});

describe('locatePriorityTools', () => {
  it('finds nice and ionice on Linux only', async () => {
    const exists = async (p: string) => p === '/usr/bin/nice' || p === '/bin/ionice';
    expect(await locatePriorityTools({ PATH: '/usr/bin:/bin' }, exists, 'linux')).toEqual({ nice: '/usr/bin/nice', ionice: '/bin/ionice' });
    expect(await locatePriorityTools({ PATH: '/usr/bin:/bin' }, exists, 'win32')).toEqual({ nice: null, ionice: null });
    expect(await locatePriorityTools({ PATH: '' }, exists, 'linux')).toEqual({ nice: null, ionice: null });
  });

  it('splits stderr into error lines', () => {
    expect(errorLines('a\r\n\n  b  \n')).toEqual(['a', 'b']);
  });

  it('drops repeat summaries and harmless HEVC messages', () => {
    const stderr = '[hevc @ 0x1] PPS changed between slices.\nLast message repeated 6 times\n[hevc @ 0x2] Could not find ref with POC 12\n[h264 @ 0x3] error while decoding MB 4 5';
    expect(errorLines(stderr)).toEqual(['[h264 @ 0x3] error while decoding MB 4 5']);
  });
});
