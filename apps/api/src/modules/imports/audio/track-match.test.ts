import { describe, expect, it } from 'vitest';
import {
  assignMaxScore,
  durationScore,
  durationToleranceMs,
  matchFileFrom,
  matchTracks,
  parseTrackFileName,
  scoreRelease,
  titleSimilarity,
  trackTitleKey,
  type MatchFile,
  type MediumCandidate,
  type ReleaseCandidate,
  type TrackCandidate,
} from './track-match.js';

// Synthetic releases and files; no audio involved.

const TITLES = ['Northern Lights', 'Paper Boats', 'The Long Road', 'Glass Houses', 'Static', 'Morning After', 'Undertow', 'Satellites', 'Low Tide', 'Homeward'];
const BONUS = ['Paper Boats (Demo)', 'Static (Live)', 'Ghost Track', 'Satellites (Acoustic)'];
const dur = (i: number) => 150_000 + i * 17_000; // 2:30 .. 5:03

function tracks(titles: readonly string[], offset = 0, recPrefix = 'rec'): TrackCandidate[] {
  return titles.map((title, i) => ({
    position: i + 1,
    number: String(i + 1),
    title,
    durationMs: dur(i + offset),
    recordingId: `${recPrefix}-${i + offset}`,
  }));
}

function release(id: string, ...media: TrackCandidate[][]): ReleaseCandidate {
  return { id, media: media.map((t, i): MediumCandidate => ({ position: i + 1, format: 'CD', tracks: t })) };
}

function filesFor(r: ReleaseCandidate, opts: { recordingIds?: boolean; discTags?: boolean; jitterMs?: number; artist?: (t: TrackCandidate) => string | null } = {}): MatchFile[] {
  const out: MatchFile[] = [];
  for (const m of r.media) {
    for (const t of m.tracks) {
      out.push({
        path: `/music/A/${m.position}-${String(t.position).padStart(2, '0')} ${t.title}.flac`,
        title: t.title,
        artist: opts.artist ? opts.artist(t) : null,
        trackNo: t.position,
        discNo: opts.discTags === false ? null : m.position,
        durationMs: t.durationMs == null ? null : t.durationMs + (opts.jitterMs ?? 800),
        mbRecordingId: opts.recordingIds ? t.recordingId : null,
        mbReleaseId: null,
      });
    }
  }
  return out;
}

const standard = release('std', tracks(TITLES));
const deluxe = release('dlx', [...tracks(TITLES), ...tracks(BONUS, 10)]);

describe('title handling', () => {
  it('normalises decorations away but keeps version words', () => {
    expect(trackTitleKey('Glass Houses (feat. Someone Else)')).toBe(trackTitleKey('Glass Houses'));
    expect(trackTitleKey('Glass Houses - 2011 Remastered Version')).toBe(trackTitleKey('Glass Houses'));
    expect(trackTitleKey('Glass Houses [Remastered 2011]')).toBe(trackTitleKey('glass houses'));
    expect(trackTitleKey('Glass Houses (Bonus Track)')).toBe(trackTitleKey('Glass Houses'));
    expect(trackTitleKey('Static (Live)')).not.toBe(trackTitleKey('Static'));
    expect(titleSimilarity('Café del Mar', 'Cafe Del Mar')).toBe(1);
    expect(titleSimilarity('Paper Boats', 'Paper Boat')).toBeGreaterThan(0.8);
    expect(titleSimilarity('Paper Boats', 'Undertow')).toBeLessThan(0.3);
  });

  it('parses track file names', () => {
    expect(parseTrackFileName('01 - Northern Lights.flac')).toEqual({ discNo: null, trackNo: 1, title: 'Northern Lights' });
    expect(parseTrackFileName('2-05 - Some Artist - Static.mp3')).toEqual({ discNo: 2, trackNo: 5, title: 'Static' });
    expect(parseTrackFileName('105 Low Tide.m4a')).toEqual({ discNo: 1, trackNo: 5, title: 'Low Tide' });
    expect(parseTrackFileName('07_Homeward.ogg')).toEqual({ discNo: null, trackNo: 7, title: 'Homeward' });
    expect(parseTrackFileName('Homeward.ogg')).toEqual({ discNo: null, trackNo: null, title: 'Homeward' });
  });

  it('builds match files from tags, folder disc and file name', () => {
    const f = matchFileFrom({ path: '/m/CD2/03 - Paper Boats.flac', tags: null, discFromFolder: 2 });
    expect(f).toMatchObject({ title: 'Paper Boats', trackNo: 3, discNo: 2, durationMs: null });
  });
});

describe('durations', () => {
  it('uses ±7 s, or ±3% over four minutes', () => {
    expect(durationToleranceMs(200_000)).toBe(7_000);
    expect(durationToleranceMs(600_000)).toBe(18_000);
    expect(durationScore(200_000, 200_000)).toBe(1);
    expect(durationScore(207_000, 200_000)).toBeCloseTo(0.7);
    expect(durationScore(221_000, 200_000)).toBe(0);
    expect(durationScore(615_000, 600_000)).toBeGreaterThan(0.7);
  });
});

describe('assignMaxScore', () => {
  it('finds the best one-to-one pairing (greedy would not)', () => {
    // Greedy picks (0,0)=0.9 then (1,1)=0.1; optimal is (0,1)+(1,0)=1.6.
    const pairs = assignMaxScore([
      [0.9, 0.8],
      [0.8, 0.1],
    ]);
    expect(pairs.sort()).toEqual([
      [0, 1],
      [1, 0],
    ]);
  });

  it('handles more rows than columns', () => {
    expect(assignMaxScore([[0.2], [0.9], [0.5]])).toEqual([[1, 0]]);
  });
});

describe('matchTracks', () => {
  it('matches a complete album with high confidence', () => {
    const result = matchTracks(filesFor(standard), [standard]);
    expect(result.accepted).toBe(true);
    expect(result.best!.confidence).toBeGreaterThan(0.95);
    expect(result.best!.mapping).toHaveLength(10);
    expect(result.best!.unmatchedFiles).toEqual([]);
    expect(result.best!.missingTracks).toEqual([]);
    expect(result.best!.mapping.every((m) => m.path.includes(m.title))).toBe(true);
  });

  it('prefers the standard release for a standard rip and the deluxe for a deluxe rip', () => {
    const std = matchTracks(filesFor(standard), [deluxe, standard]);
    expect(std.best!.releaseId).toBe('std');
    expect(std.candidates[1]!.releaseId).toBe('dlx');
    expect(std.candidates[1]!.missingTracks).toHaveLength(4);

    const dlx = matchTracks(filesFor(deluxe), [standard, deluxe]);
    expect(dlx.best!.releaseId).toBe('dlx');
    expect(dlx.accepted).toBe(true);
    const asStandard = dlx.candidates.find((c) => c.releaseId === 'std')!;
    expect(asStandard.unmatchedFiles).toHaveLength(4);
    expect(asStandard.accepted).toBe(false);
  });

  it('accepts an incomplete album and reports the missing tracks', () => {
    const files = filesFor(standard).filter((_, i) => i !== 3 && i !== 7);
    const result = matchTracks(files, [standard]);
    expect(result.accepted).toBe(true);
    expect(result.best!.missingTracks.map((t) => t.title)).toEqual(['Glass Houses', 'Satellites']);
    expect(result.best!.stats.coverage).toBe(0.8);
  });

  it('matches multi-disc releases with disc tags, without disc tags, and with absolute numbering', () => {
    const two = release('2cd', tracks(TITLES.slice(0, 5)), tracks(TITLES.slice(5), 5));
    const tagged = matchTracks(filesFor(two), [two]);
    expect(tagged.accepted).toBe(true);
    expect(tagged.best!.mapping.map((m) => `${m.mediumNumber}-${m.trackPosition}`)).toEqual(['1-1', '1-2', '1-3', '1-4', '1-5', '2-1', '2-2', '2-3', '2-4', '2-5']);

    const untaggedDiscs = matchTracks(filesFor(two, { discTags: false }), [two]);
    expect(untaggedDiscs.accepted).toBe(true);
    expect(untaggedDiscs.best!.mapping.find((m) => m.title === 'Undertow')).toMatchObject({ mediumNumber: 2, trackPosition: 2 });

    const absolute = filesFor(two).map((f, i) => ({ ...f, discNo: null, trackNo: i + 1 }));
    const abs = matchTracks(absolute, [two]);
    expect(abs.accepted).toBe(true);
    expect(abs.best!.mapping.find((m) => m.title === 'Low Tide')).toMatchObject({ mediumNumber: 2, trackPosition: 4, absolutePosition: 9 });
  });

  it('matches a various-artists compilation, using track artists for duplicate titles', () => {
    const va: TrackCandidate[] = [
      { position: 1, title: 'Intro', durationMs: 60_000, recordingId: 'v1', artist: 'Alpha Band' },
      { position: 2, title: 'Night Drive', durationMs: 200_000, recordingId: 'v2', artist: 'Beta Collective' },
      { position: 3, title: 'Intro', durationMs: 61_000, recordingId: 'v3', artist: 'Gamma Trio' },
      { position: 4, title: 'Sunrise', durationMs: 230_000, recordingId: 'v4', artist: 'Delta' },
    ];
    const rel = release('va', va);
    // No track numbers at all: only titles, durations and artists to go on.
    const files: MatchFile[] = [
      { path: '/c/gamma.flac', title: 'Intro', artist: 'Gamma Trio', trackNo: null, discNo: null, durationMs: 60_500, mbRecordingId: null, mbReleaseId: null },
      { path: '/c/alpha.flac', title: 'Intro', artist: 'Alpha Band', trackNo: null, discNo: null, durationMs: 60_500, mbRecordingId: null, mbReleaseId: null },
      { path: '/c/beta.flac', title: 'Night Drive', artist: 'Beta Collective feat. Someone', trackNo: null, discNo: null, durationMs: 199_000, mbRecordingId: null, mbReleaseId: null },
      { path: '/c/delta.flac', title: 'Sunrise', artist: 'Delta', trackNo: null, discNo: null, durationMs: 231_000, mbRecordingId: null, mbReleaseId: null },
    ];
    const result = matchTracks(files, [rel]);
    expect(result.accepted).toBe(true);
    const at = (p: string) => result.best!.mapping.find((m) => m.path === p)!.trackPosition;
    expect(at('/c/alpha.flac')).toBe(1);
    expect(at('/c/gamma.flac')).toBe(3);
  });

  it('uses recording ids to rescue badly titled files and adds a bonus', () => {
    const files = filesFor(standard, { recordingIds: true }).map((f, i) => ({ ...f, title: `Track ${i + 1}`, trackNo: null, durationMs: null }));
    // Shuffle so that position cannot help.
    files.reverse();
    const result = matchTracks(files, [standard]);
    expect(result.accepted).toBe(true);
    expect(result.best!.stats.recordingIdMatches).toBe(10);
    expect(result.best!.mapping.every((m) => m.recordingIdMatch)).toBe(true);
    const withoutIds = scoreRelease(filesFor(standard), standard);
    const withIds = scoreRelease(filesFor(standard, { recordingIds: true }), standard);
    expect(withIds.confidence).toBeGreaterThan(withoutIds.confidence);
  });

  it('rejects the wrong album', () => {
    const other = release('other', tracks(['Completely', 'Different', 'Songs', 'Here', 'Now'], 3));
    const result = matchTracks(filesFor(standard), [other]);
    expect(result.accepted).toBe(false);
    expect(result.best!.confidence).toBeLessThan(0.8);
  });

  it('honours a custom threshold and prefers the selected release on exact ties', () => {
    const cd = release('cd', tracks(TITLES));
    const digital = { ...release('digital', tracks(TITLES)), preferred: true };
    const result = matchTracks(filesFor(cd), [cd, digital]);
    expect(result.best!.releaseId).toBe('digital');
    const strict = matchTracks(filesFor(standard).slice(0, 3), [standard], { threshold: 0.99 });
    expect(strict.accepted).toBe(false);
  });

  it('copes with tolerable duration drift and missing durations', () => {
    const drift = matchTracks(filesFor(standard, { jitterMs: 5_000 }), [standard]);
    expect(drift.accepted).toBe(true);
    const r = release('nodur', tracks(TITLES).map((t) => ({ ...t, durationMs: null })));
    expect(matchTracks(filesFor(standard), [r]).accepted).toBe(true);
  });

  it('returns nothing for empty input', () => {
    expect(matchTracks([], [standard])).toMatchObject({ accepted: false, best: null });
    expect(matchTracks(filesFor(standard), [])).toMatchObject({ accepted: false, best: null });
  });

  it('is fast enough for box sets', () => {
    const big = release('box', ...Array.from({ length: 10 }, (_, d) => tracks(Array.from({ length: 20 }, (_, i) => `Song ${d}-${i} ${TITLES[i % 10]}`), d * 20)));
    const files = filesFor(big);
    const started = performance.now();
    const result = matchTracks(files, [big, big, big]);
    expect(result.accepted).toBe(true);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
