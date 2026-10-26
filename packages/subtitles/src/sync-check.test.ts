import { describe, expect, it } from 'vitest';
import type { Cue } from './formats.js';
import {
  buildAudioActivityCommand,
  buildSyncCheckCommand,
  compareTimings,
  estimateSync,
  parseCues,
  parseEbur128,
  parseSilenceDetect,
  planAudioWindows,
  robustTimingFit,
  syncAutoAction,
  syncCheckOutputPath,
  syncScoreFromError,
  type AudioWindow,
  type TimeInterval,
} from './sync-check.js';

// Deterministic PRNG (mulberry32) so the synthetic signals are the same on every run.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Speech intervals: 0.8-3.5 s of speech, 0.4-3 s gaps, over the given windows. */
function speechIn(windows: AudioWindow[], seed = 1): TimeInterval[] {
  const r = rng(seed);
  const out: TimeInterval[] = [];
  for (const w of windows) {
    let t = w.startMs + 1500;
    const end = w.startMs + w.durationMs;
    while (t < end - 4000) {
      const dur = 800 + r() * 2700;
      out.push({ startMs: Math.round(t), endMs: Math.round(t + dur) });
      t += dur + 400 + r() * 2600;
    }
  }
  return out;
}

/**
 * Cues whose true correction is `onset = a + b * cueStart`, with +-jitter ms noise and a share
 * of speech left without a cue (music, untranslated lines).
 */
function cuesFor(speech: TimeInterval[], a: number, b: number, o: { jitter?: number; dropEvery?: number; seed?: number } = {}): Cue[] {
  const r = rng(o.seed ?? 7);
  const cues: Cue[] = [];
  speech.forEach((s, i) => {
    if (o.dropEvery && i % o.dropEvery === 0) return;
    const noise = ((r() * 2 - 1) * (o.jitter ?? 60)) | 0;
    const start = (s.startMs - a) / b + noise;
    cues.push({ startMs: Math.round(start), endMs: Math.round(start + (s.endMs - s.startMs) / b), text: `line ${i}` });
  });
  return cues;
}

const W10: AudioWindow[] = [{ startMs: 0, durationMs: 600_000 }];

describe('estimateSync (builtin correlation)', () => {
  it('scores an in-sync subtitle near 100 with no offset or drift', () => {
    const speech = speechIn(W10);
    const e = estimateSync(speech, cuesFor(speech, 0, 1, { dropEvery: 7 }), { windows: W10 });
    expect(e.reliable).toBe(true);
    expect(e.syncScore).toBeGreaterThanOrEqual(95);
    expect(Math.abs(e.offsetMs!)).toBeLessThan(100);
    expect(e.driftPpm).toBe(0);
  });

  it('finds a constant offset of +2.5 s and scores it low', () => {
    const speech = speechIn(W10, 3);
    const e = estimateSync(speech, cuesFor(speech, 2500, 1), { windows: W10 });
    expect(e.reliable).toBe(true);
    expect(e.offsetMs!).toBeGreaterThan(2400);
    expect(e.offsetMs!).toBeLessThan(2600);
    expect(e.driftPpm).toBe(0);
    expect(e.syncScore!).toBeLessThan(10);
  });

  it('finds a large negative offset (-12 s) inside the default search range', () => {
    const speech = speechIn(W10, 5);
    const e = estimateSync(speech, cuesFor(speech, -12_000, 1, { dropEvery: 5 }), { windows: W10 });
    expect(Math.abs(e.offsetMs! + 12_000)).toBeLessThan(100);
  });

  it('detects a 25 vs 23.976 fps mismatch as drift', () => {
    const speech = speechIn(W10, 11);
    const ratio = 25 / 23.976;
    const e = estimateSync(speech, cuesFor(speech, 0, ratio), { windows: W10 });
    expect(e.reliable).toBe(true);
    expect(Math.abs(e.driftPpm! - Math.round((ratio - 1) * 1e6))).toBeLessThan(1500);
    expect(Math.abs(e.offsetMs!)).toBeLessThan(300);
    expect(e.syncScore!).toBeLessThan(20);
  });

  it('measures a small drift (1000 ppm) across two windows', () => {
    const windows: AudioWindow[] = [
      { startMs: 0, durationMs: 600_000 },
      { startMs: 3_000_000, durationMs: 300_000 },
    ];
    const speech = speechIn(windows, 13);
    const e = estimateSync(speech, cuesFor(speech, 200, 1.001, { jitter: 40 }), { windows });
    expect(e.reliable).toBe(true);
    expect(Math.abs(e.driftPpm! - 1000)).toBeLessThan(200);
    expect(Math.abs(e.offsetMs! - 200)).toBeLessThan(150);
  });

  it('reports an unrelated subtitle as unreliable', () => {
    const speech = speechIn(W10, 17);
    const other = cuesFor(speechIn(W10, 999), 0, 1);
    const e = estimateSync(speech, other, { windows: W10 });
    expect(e.reliable).toBe(false);
    expect(e.confidence).toBeLessThan(0.2);
  });

  it('needs enough cues and onsets', () => {
    const speech = speechIn(W10);
    const e = estimateSync(speech, cuesFor(speech, 0, 1).slice(0, 3), { windows: W10 });
    expect(e.reliable).toBe(false);
    expect(e.syncScore).toBeNull();
    expect(e.message).toMatch(/cue/);
  });
});

describe('audio activity parsing and commands', () => {
  it('turns silencedetect output into speech intervals in media time', () => {
    const stderr = [
      '[silencedetect @ 0x1] silence_start: 0',
      '[silencedetect @ 0x1] silence_end: 2.5 | silence_duration: 2.5',
      '[silencedetect @ 0x1] silence_start: 4.25',
      '[silencedetect @ 0x1] silence_end: 6 | silence_duration: 1.75',
    ].join('\n');
    const w = { startMs: 60_000, durationMs: 10_000 };
    expect(parseSilenceDetect(stderr, w)).toEqual([
      { startMs: 62_500, endMs: 64_250 },
      { startMs: 66_000, endMs: 70_000 },
    ]);
  });

  it('handles speech at the start and a silence running to the end', () => {
    const stderr = 'silence_start: 3.0\nsilence_end: 4.0 | silence_duration: 1\nsilence_start: 8.5\n';
    expect(parseSilenceDetect(stderr, { startMs: 0, durationMs: 10_000 })).toEqual([
      { startMs: 0, endMs: 3000 },
      { startMs: 4000, endMs: 8500 },
    ]);
  });

  it('turns ebur128 frame logs into active intervals', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) {
      const t = i / 10;
      const loud = t > 1 && t <= 2 ? -25.3 : -70;
      lines.push(`[Parsed_ebur128_0 @ 0x5] t: ${t.toFixed(1)}      TARGET:-23 LUFS    M: ${loud} S: -40.0     I: -30.0 LUFS`);
    }
    expect(parseEbur128(lines.join('\n'), { startMs: 1000, durationMs: 3000 })).toEqual([{ startMs: 2000, endMs: 3000 }]);
  });

  it('builds the ffmpeg command for one window', () => {
    const cmd = buildAudioActivityCommand({ ffmpegPath: '/usr/bin/ffmpeg', input: '/m/a.mkv', window: { startMs: 90_000, durationMs: 600_000 } });
    expect(cmd.command).toBe('/usr/bin/ffmpeg');
    expect(cmd.args).toEqual([
      '-nostdin', '-hide_banner', '-nostats', '-ss', '90.000', '-t', '600.000', '-i', '/m/a.mkv',
      '-map', '0:a:0', '-vn', '-sn', '-dn', '-af', 'silencedetect=noise=-30dB:d=0.300', '-f', 'null', '-',
    ]);
    const loud = buildAudioActivityCommand({ input: 'x', window: { startMs: 0, durationMs: 1000 }, detector: 'ebur128', audioStream: '0:a:1' });
    expect(loud.args).toContain('ebur128=framelog=info');
    expect(loud.args).toContain('0:a:1');
  });

  it('plans a second window for long media', () => {
    expect(planAudioWindows(1_200_000, 600_000)).toEqual([{ startMs: 0, durationMs: 600_000 }]);
    expect(planAudioWindows(6_000_000, 600_000)).toEqual([
      { startMs: 0, durationMs: 600_000 },
      { startMs: 3_600_000, durationMs: 300_000 },
    ]);
  });
});

describe('sync tool check mode', () => {
  it('runs ffsubsync with --no-fix-framerate into a scratch file', () => {
    const cmd = buildSyncCheckCommand({ tool: 'ffsubsync', video: '/m/a.mkv', subtitle: '/m/a.en.srt', maxOffsetSeconds: 30 });
    expect(cmd.output).toBe('/m/a.en.synccheck.srt');
    expect(cmd.command).toBe('ffsubsync');
    expect(cmd.args.slice(0, 5)).toEqual(['/m/a.mkv', '-i', '/m/a.en.srt', '-o', '/m/a.en.synccheck.srt']);
    expect(cmd.args).toContain('--no-fix-framerate');
    expect(cmd.args.join(' ')).toContain('--max-offset-seconds 30');
  });

  it('runs alass with fps guessing disabled', () => {
    const cmd = buildSyncCheckCommand({ tool: 'alass', binary: '/opt/alass', video: 'v.mkv', subtitle: 's.srt' });
    expect(cmd.command).toBe('/opt/alass');
    expect(cmd.args).toEqual(['v.mkv', 's.srt', 's.synccheck.srt', '--disable-fps-guessing']);
    expect(syncCheckOutputPath('noext')).toBe('noext.synccheck');
  });

  it('measures offset and drift from the corrected copy', () => {
    const original: Cue[] = Array.from({ length: 50 }, (_, i) => ({ startMs: i * 20_000, endMs: i * 20_000 + 1500, text: `${i}` }));
    const shifted = original.map((c) => ({ ...c, startMs: c.startMs + 1200, endMs: c.endMs + 1200 }));
    const e = compareTimings(original, shifted, 'ffsubsync');
    expect(e).toMatchObject({ reliable: true, method: 'ffsubsync', offsetMs: 1200, driftPpm: 0, meanErrorMs: 1200 });
    expect(e.syncScore).toBe(syncScoreFromError(1200));
    const scaled = original.map((c) => ({ ...c, startMs: Math.round(c.startMs * 1.002) }));
    const d = compareTimings(original, scaled, 'alass');
    expect(Math.abs(d.driftPpm! - 2000)).toBeLessThan(5);
    expect(compareTimings(original, original, 'alass').syncScore).toBe(100);
  });

  it('refuses a corrected copy with a different cue list', () => {
    const original: Cue[] = Array.from({ length: 40 }, (_, i) => ({ startMs: i * 1000, endMs: i * 1000 + 500, text: '' }));
    expect(compareTimings(original, original.slice(0, 20), 'alass').reliable).toBe(false);
  });
});

describe('scoring helpers', () => {
  it('maps the mean error to 0-100', () => {
    expect(syncScoreFromError(0)).toBe(100);
    expect(syncScoreFromError(100)).toBe(100);
    expect(syncScoreFromError(300)).toBe(86);
    expect(syncScoreFromError(600)).toBe(50);
    expect(syncScoreFromError(1100)).toBe(20);
    expect(syncScoreFromError(5000)).toBeLessThan(2);
  });

  it('snaps an insignificant slope to 1 and ignores outliers', () => {
    const xs = Array.from({ length: 40 }, (_, i) => i * 10_000);
    const ys = xs.map((x, i) => x + 500 + (i % 2 ? 30 : -30));
    ys[5] = xs[5]! + 9000; // outlier
    const fit = robustTimingFit(xs, ys)!;
    expect(fit.b).toBe(1);
    expect(Math.abs(fit.a - 500)).toBeLessThanOrEqual(30);
    expect(fit.n).toBe(39);
  });

  it('decides the auto action from the thresholds', () => {
    const s = { autoFixBelow: 70, autoRetryProviderBelow: 40 };
    expect(syncAutoAction({ reliable: true, syncScore: 90 }, s, { fixed: false, fromProvider: true })).toBe('none');
    expect(syncAutoAction({ reliable: true, syncScore: 50 }, s, { fixed: false, fromProvider: true })).toBe('fix');
    expect(syncAutoAction({ reliable: true, syncScore: 30 }, s, { fixed: true, fromProvider: true })).toBe('retry');
    expect(syncAutoAction({ reliable: true, syncScore: 30 }, s, { fixed: true, fromProvider: false })).toBe('none');
    expect(syncAutoAction({ reliable: false, syncScore: null }, s, { fixed: false, fromProvider: true })).toBe('none');
    expect(syncAutoAction({ reliable: true, syncScore: 30 }, { autoFixBelow: 0, autoRetryProviderBelow: 0 }, { fixed: false, fromProvider: true })).toBe('none');
  });

  it('parses cues from WebVTT too', () => {
    const cues = parseCues('WEBVTT\n\n00:00:02.000 --> 00:00:03.000\nB\n\n00:00:01.000 --> 00:00:01.500\nA\n');
    expect(cues.map((c) => c.startMs)).toEqual([1000, 2000]);
  });
});
