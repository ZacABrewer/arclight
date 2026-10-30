import { TranscodeHwaccel, type TranscodeBackendStatus } from '@arclight/shared';
import { capabilityTestArgs } from './ffmpeg.js';
import { backendsFor, type ProcessResult, type TranscodeRunner } from './runner.js';

// Hardware backends: which ones really work (a 1-frame test encode per backend, since
// `ffmpeg -hwaccels` only lists what the build was compiled with) and how to recognise a job that
// failed because the device could not be opened, so it can be retried in software.

export const HWACCEL_NAMES: Record<TranscodeHwaccel, string> = {
  none: 'software',
  vaapi: 'VA-API',
  qsv: 'Intel Quick Sync (QSV)',
  nvenc: 'NVIDIA NVENC',
  videotoolbox: 'VideoToolbox',
};

/** Where the docs explain passing the GPU through. */
export const HWACCEL_DOCS = 'docs/using/hardware-transcoding.md';

// ffmpeg's messages when a hardware device, driver or session cannot be set up. Most specific
// first: the first pattern that matches any line picks the line reported.
const HW_FAILURE_PATTERNS: RegExp[] = [
  /No supported child device type is enabled/i,
  /No VA display found/i,
  /Failed to initiali[sz]e VAAPI connection/i,
  /vaInitialize failed/i,
  /Cannot load libcuda/i,
  /Could not dynamically load CUDA/i,
  /No NVENC capable devices found/i,
  /Driver does not support the required nvenc API version/i,
  /Error creating a MFX session/i,
  /Error initializing an internal MFX session/i,
  /Hardware device setup failed/i,
  /Failed to set value '[^']*' for option '(?:init_hw_device|vaapi_device|hwaccel|qsv_device|hwaccel_device)'/i,
  /Device creation failed/i,
  /\binit_hw_device\b/i,
];

/** `[AVHWDeviceContext @ 0x55d0...] message` -> `message`. */
function stripContext(line: string): string {
  return line.replace(/^(?:\[[^\]]*@ ?0x[0-9a-f]+\]\s*|\[[a-z]+#[^\]]*\]\s*)+/i, '').trim();
}

/**
 * The stderr line saying a hardware device/session could not be initialised, or null when the
 * failure is something else (bad input, disk full ...).
 */
export function hwInitFailure(stderr: string): string | null {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const pattern of HW_FAILURE_PATTERNS) {
    const hit = lines.find((l) => pattern.test(l));
    if (hit) return stripContext(hit);
  }
  return null;
}

/** Why a capability test failed: the hardware line, else the last stderr line, else the exit code. */
export function failureReason(res: ProcessResult): string {
  const text = res.stderr ?? res.stderrTail;
  const hw = hwInitFailure(text);
  if (hw) return hw;
  const last = text.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (last) return stripContext(last);
  return res.exitCode === null ? 'ffmpeg was stopped by a signal' : `ffmpeg exited with code ${res.exitCode}`;
}

/** Runs one ffmpeg command, killing it after `timeoutMs`. Resolves null on timeout. */
async function runWithTimeout(runner: TranscodeRunner, bin: string, args: readonly string[], timeoutMs: number): Promise<ProcessResult | null> {
  const proc = runner.start(bin, args, () => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      proc.kill();
      resolve(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([proc.done, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface CapabilityTestOptions {
  /** Per-backend limit. Default 20 s (a first QSV/NVENC session can take a few seconds). */
  timeoutMs?: number;
}

/**
 * Tests every backend in `TranscodeHwaccel` order, one at a time. Backends the build has no
 * hwaccel for are reported without running ffmpeg.
 */
export async function testBackends(runner: TranscodeRunner, bin: string, methods: readonly string[], opts: CapabilityTestOptions = {}): Promise<TranscodeBackendStatus[]> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const built = new Set(backendsFor(methods));
  const out: TranscodeBackendStatus[] = [];
  for (const backend of TranscodeHwaccel.options) {
    if (!built.has(backend)) {
      out.push({ backend, available: false, reason: `this ffmpeg build has no ${HWACCEL_NAMES[backend]} support` });
      continue;
    }
    let res: ProcessResult | null;
    try {
      res = await runWithTimeout(runner, bin, capabilityTestArgs(backend), timeoutMs);
    } catch (err) {
      out.push({ backend, available: false, reason: `could not start ffmpeg: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    if (!res) out.push({ backend, available: false, reason: `the test encode did not finish within ${Math.ceil(timeoutMs / 1000)} s` });
    else if (res.exitCode === 0) out.push({ backend, available: true, reason: null });
    else out.push({ backend, available: false, reason: failureReason(res) });
  }
  return out;
}

/** Job message when a hardware backend failed and fallback is off. */
export function hwFailureMessage(hwaccel: TranscodeHwaccel, reason: string): string {
  return (
    `hardware acceleration (${HWACCEL_NAMES[hwaccel]}) is unavailable: ${reason}. ` +
    'Pass the GPU to the container (devices: /dev/dri:/dev/dri for Intel/AMD, the NVIDIA Container Toolkit for NVIDIA), ' +
    'make sure the device is readable by the app user, and use Test again in Settings > Transcode ' +
    `(see ${HWACCEL_DOCS}). Turn on "Fall back to software" there to encode without the GPU instead.`
  );
}

/** Note added to a job that fell back to software. */
export function hwFallbackNote(hwaccel: TranscodeHwaccel, reason: string): string {
  return `hardware acceleration (${HWACCEL_NAMES[hwaccel]}) was unavailable (${reason}); encoded in software instead`;
}
