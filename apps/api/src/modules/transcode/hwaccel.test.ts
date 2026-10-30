import { describe, expect, it } from 'vitest';
import { capabilityTestArgs } from './ffmpeg.js';
import { failureReason, hwFailureMessage, hwFallbackNote, hwInitFailure, testBackends } from './hwaccel.js';
import type { ProcessResult, RunningProcess, TranscodeRunner } from './runner.js';
import { FakeRunner } from './test-support.js';

// ffmpeg's stderr for the common hardware failures (addresses vary per run).
const QSV_NO_CHILD = [
  '[AVHWDeviceContext @ 0x7f3990204340] No supported child device type is enabled',
  'Device creation failed: -38.',
  "Failed to set value 'qsv=hw' for option 'init_hw_device': Function not implemented",
  'Error parsing global options: Function not implemented',
].join('\n');
const QSV_NO_GPU = [
  'Device creation failed: -542398533.',
  "Failed to set value 'qsv=hw' for option 'init_hw_device': Generic error in an external library",
  'Error parsing global options: Generic error in an external library',
].join('\n');
const VAAPI_NO_DEVICE = [
  '[AVHWDeviceContext @ 0x55d0c1a2b3c0] No VA display found for device /dev/dri/renderD128.',
  'Device creation failed: -22.',
  "Failed to set value '/dev/dri/renderD128' for option 'vaapi_device': Invalid argument",
].join('\n');
const CUDA_NO_DRIVER = [
  '[AVHWDeviceContext @ 0x5c8b6b857740] Cannot load libcuda.so.1',
  '[AVHWDeviceContext @ 0x5c8b6b857740] Could not dynamically load CUDA',
  'Device creation failed: -1.',
  '[vist#0:0/h264 @ 0x5c8b6b857740] [dec:h264 @ 0x5c8b6b874640] Hardware device setup failed for decoder: Operation not permitted',
  'Error opening output file /tv/x.mkv.',
].join('\n');
const MFX_SESSION = '[h264_qsv @ 0x5600] Error creating a MFX session: -9.\nError initializing output stream 0:0';

describe('hwInitFailure', () => {
  it.each([
    ['QSV without a VA-API child device', QSV_NO_CHILD, 'No supported child device type is enabled'],
    ['QSV without a GPU', QSV_NO_GPU, "Failed to set value 'qsv=hw' for option 'init_hw_device': Generic error in an external library"],
    ['VA-API without /dev/dri', VAAPI_NO_DEVICE, 'No VA display found for device /dev/dri/renderD128.'],
    ['NVENC without the driver', CUDA_NO_DRIVER, 'Cannot load libcuda.so.1'],
    ['a QSV encoder session', MFX_SESSION, 'Error creating a MFX session: -9.'],
    ['a bare device creation failure', 'Device creation failed: -5.', 'Device creation failed: -5.'],
    [
      'a decoder device failure (context prefixes stripped)',
      '[vist#0:0/wrapped_avframe @ 0x5c8b] [dec:wrapped_avframe @ 0x5c8c] Hardware device setup failed for decoder: Operation not permitted',
      'Hardware device setup failed for decoder: Operation not permitted',
    ],
  ])('recognises %s', (_label, stderr, line) => {
    expect(hwInitFailure(stderr)).toBe(line);
  });

  it.each([
    ['a missing input', '/tv/x.mkv: No such file or directory'],
    ['a full disk', 'av_interleaved_write_frame(): No space left on device\nConversion failed!'],
    ['an unknown encoder option', "Unrecognized option 'foo'.\nError splitting the argument list: Option not found"],
    ['empty stderr', ''],
  ])('ignores %s', (_label, stderr) => {
    expect(hwInitFailure(stderr)).toBeNull();
  });
});

describe('failureReason', () => {
  it('prefers the hardware line, then the last line, then the exit code', () => {
    expect(failureReason({ exitCode: 218, stderrTail: 'Error parsing global options', stderr: QSV_NO_CHILD })).toBe('No supported child device type is enabled');
    expect(failureReason({ exitCode: 1, stderrTail: 'first\n[h264 @ 0x1f] Unknown encoder' })).toBe('Unknown encoder');
    expect(failureReason({ exitCode: 1, stderrTail: '' })).toBe('ffmpeg exited with code 1');
    expect(failureReason({ exitCode: null, stderrTail: '' })).toBe('ffmpeg was stopped by a signal');
  });
});

describe('messages', () => {
  it('name the backend, the reason and the fix', () => {
    const msg = hwFailureMessage('qsv', 'No supported child device type is enabled');
    expect(msg).toContain('Intel Quick Sync (QSV)');
    expect(msg).toContain('No supported child device type is enabled');
    expect(msg).toContain('/dev/dri:/dev/dri');
    expect(msg).toContain('docs/using/hardware-transcoding.md');
    expect(hwFallbackNote('nvenc', 'Cannot load libcuda.so.1')).toBe('hardware acceleration (NVIDIA NVENC) was unavailable (Cannot load libcuda.so.1); encoded in software instead');
  });
});

describe('testBackends', () => {
  const methods = ['vaapi', 'qsv', 'cuda', 'drm'];

  it('runs the real init args + encoder per backend and reports each result', async () => {
    const runner = new FakeRunner();
    runner.respond = (args) => {
      if (args.includes('h264_qsv')) return { exitCode: 218, stderr: QSV_NO_CHILD };
      if (args.includes('h264_nvenc')) return { exitCode: 1, stderr: CUDA_NO_DRIVER };
      return undefined;
    };
    const results = await testBackends(runner, '/usr/bin/ffmpeg', methods);
    expect(results).toEqual([
      { backend: 'none', available: true, reason: null },
      { backend: 'vaapi', available: true, reason: null },
      { backend: 'qsv', available: false, reason: 'No supported child device type is enabled' },
      { backend: 'nvenc', available: false, reason: 'Cannot load libcuda.so.1' },
      { backend: 'videotoolbox', available: false, reason: 'this ffmpeg build has no VideoToolbox support' },
    ]);
    // videotoolbox is not in the build: never run. The others run the same argv a job would.
    expect(runner.calls).toHaveLength(4);
    expect(runner.calls[2]).toEqual(capabilityTestArgs('qsv'));
    const qsv = runner.calls[2]!;
    expect(qsv.slice(qsv.indexOf('-init_hw_device'), qsv.indexOf('-init_hw_device') + 4)).toEqual(['-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw']);
    expect(qsv).toContain('testsrc2=size=256x256:rate=1');
    expect(qsv.at(-1)).toBe('-');
    expect(runner.calls[1]).toEqual(expect.arrayContaining(['-vaapi_device', '/dev/dri/renderD128', '-c:v', 'h264_vaapi']));
  });

  it('times out a hung test and kills ffmpeg', async () => {
    let killed = 0;
    const hung: TranscodeRunner = {
      locate: async () => '/usr/bin/ffmpeg',
      exec: async () => '',
      start: (_bin, args): RunningProcess => {
        if (args.includes('libx264')) return { done: Promise.resolve<ProcessResult>({ exitCode: 0, stderrTail: '' }), kill: () => undefined };
        return { done: new Promise<ProcessResult>(() => undefined), kill: () => void killed++ };
      },
    };
    const results = await testBackends(hung, '/usr/bin/ffmpeg', ['vaapi'], { timeoutMs: 20 });
    expect(results.find((r) => r.backend === 'vaapi')).toEqual({ backend: 'vaapi', available: false, reason: 'the test encode did not finish within 1 s' });
    expect(killed).toBe(1);
  });

  it('reports a backend whose ffmpeg cannot start', async () => {
    const broken: TranscodeRunner = {
      locate: async () => '/usr/bin/ffmpeg',
      exec: async () => '',
      start: () => {
        throw new Error('spawn EACCES');
      },
    };
    const results = await testBackends(broken, '/usr/bin/ffmpeg', []);
    expect(results[0]).toEqual({ backend: 'none', available: false, reason: 'could not start ffmpeg: spawn EACCES' });
  });
});
