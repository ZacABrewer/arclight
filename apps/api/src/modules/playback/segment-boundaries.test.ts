import { describe, expect, it } from 'vitest';
import { buildBoundaryProbeArgs, parseQuietGaps, probeWindow, SNAP_MS, snapToGap } from './segment-boundaries.js';

// Boundary snapping (features-spec §5.9): segment edges move onto a black frame or silence.

describe('boundary probes', () => {
  it('decodes a window around the edge, video and audio when the file has video', () => {
    expect(probeWindow(60_000, 1_200_000)).toEqual({ startMs: 57_500, lengthMs: 5_000 });
    expect(probeWindow(1_000, 1_200_000)).toEqual({ startMs: 0, lengthMs: 3_500 });
    expect(probeWindow(1_199_000, 1_200_000)).toEqual({ startMs: 1_196_500, lengthMs: 3_500 });
    expect(buildBoundaryProbeArgs('/m/e.mkv', 1, true, 57_500, 5_000)).toEqual([
      '-nostdin', '-hide_banner', '-nostats', '-v', 'info', '-ss', '57.500', '-t', '5.000', '-i', '/m/e.mkv',
      '-map', '0:v:0', '-vf', 'scale=160:-2,blackdetect=d=0.1:pix_th=0.10',
      '-map', '0:a:1', '-af', 'silencedetect=n=-50dB:d=0.3',
      '-f', 'null', '-',
    ]); // prettier-ignore
    const audioOnly = buildBoundaryProbeArgs('/m/e.mkv', 0, false, 0, 3_500);
    expect(audioOnly).not.toContain('-ss');
    expect(audioOnly).not.toContain('0:v:0');
  });

  it('reads black and silent stretches onto the file timeline', () => {
    const log = [
      '[blackdetect @ 0x1] black_start:1.2 black_end:1.68 black_duration:0.48',
      '[silencedetect @ 0x2] silence_start: 1.1',
      '[silencedetect @ 0x2] silence_end: 1.9 | silence_duration: 0.8',
      '[silencedetect @ 0x2] silence_start: 4.6',
    ].join('\n');
    expect(parseQuietGaps(log, 57_500, 5_000)).toEqual([
      { kind: 'silence', startMs: 58_600, endMs: 59_400 },
      { kind: 'black', startMs: 58_700, endMs: 59_180 },
      // Still silent when the window ends.
      { kind: 'silence', startMs: 62_100, endMs: 62_500 },
    ]);
    expect(parseQuietGaps('nothing here', 0, 5_000)).toEqual([]);
  });

  it('moves an edge to the end of the nearest gap within 2 s, and only then', () => {
    const gaps = [
      { kind: 'black' as const, startMs: 58_700, endMs: 59_180 },
      { kind: 'silence' as const, startMs: 61_000, endMs: 61_500 },
    ];
    expect(snapToGap(60_000, gaps)).toBe(59_180);
    expect(snapToGap(61_300, gaps)).toBe(61_500);
    expect(snapToGap(64_000, gaps)).toBe(64_000);
    expect(snapToGap(59_180 - SNAP_MS - 1, gaps)).toBe(59_180 - SNAP_MS - 1);
    // A long gap that contains the edge counts even when its end is further than 2 s.
    expect(snapToGap(10_000, [{ kind: 'silence', startMs: 9_000, endMs: 13_000 }])).toBe(13_000);
    expect(snapToGap(10_000, [])).toBe(10_000);
  });
});
