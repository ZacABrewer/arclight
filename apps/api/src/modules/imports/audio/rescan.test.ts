import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFlac, buildMp3, type FixtureTags } from './fixtures/builders.js';
import { albumTitleFromFolder, matchArtistScan, rescanArtist, type KnownAlbum } from './rescan.js';
import { scanAudioPath } from './scan-audio.js';
import type { ReleaseCandidate, TrackCandidate } from './track-match.js';

// An artist folder built from tiny silent files (1-3 s durations stand in for real ones).

const root = mkdtempSync(join(tmpdir(), 'arclight-rescan-'));
const artist = join(root, 'Fixture Artist');
afterAll(() => rmSync(root, { recursive: true, force: true }));

function put(rel: string, bytes: Uint8Array | string): void {
  const full = join(artist, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, bytes);
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const RG_FIRST = id(101);
const RG_SECOND = id(102);
const REL_FIRST_STD = id(201);
const REL_FIRST_DLX = id(202);
const REL_SECOND = id(203);

const FIRST = ['Opening', 'Middle Part', 'Closing'];
const FIRST_BONUS = ['Opening (Demo)', 'Hidden One'];
const SECOND_DISC1 = ['Side One', 'Side Two'];
const SECOND_DISC2 = ['Side Three', 'Side Four'];

const track = (title: string, position: number, durationMs: number, rec: number): TrackCandidate => ({
  position,
  number: String(position),
  title,
  durationMs,
  recordingId: id(rec),
  ref: `track:${title}`,
});

const firstStd: ReleaseCandidate = { id: REL_FIRST_STD, ref: 'release:std', media: [{ position: 1, tracks: FIRST.map((t, i) => track(t, i + 1, 1000 + i * 1000, 300 + i)) }] };
const firstDlx: ReleaseCandidate = {
  id: REL_FIRST_DLX,
  ref: 'release:dlx',
  media: [{ position: 1, tracks: [...FIRST, ...FIRST_BONUS].map((t, i) => track(t, i + 1, 1000 + i * 1000, 300 + i)) }],
};
const second: ReleaseCandidate = {
  id: REL_SECOND,
  media: [
    { position: 1, tracks: SECOND_DISC1.map((t, i) => track(t, i + 1, 2000, 400 + i)) },
    { position: 2, tracks: SECOND_DISC2.map((t, i) => track(t, i + 1, 2000, 410 + i)) },
  ],
};
const third: ReleaseCandidate = { id: id(204), media: [{ position: 1, tracks: ['Not Here', 'Never Ripped'].map((t, i) => track(t, i + 1, 3000, 500 + i)) }] };

const albums: KnownAlbum[] = [
  { albumId: 1, title: 'First Record', mbReleaseGroupId: RG_FIRST, selectedReleaseId: REL_FIRST_DLX, anyReleaseOk: true, releases: [firstDlx, firstStd] },
  { albumId: 2, title: 'Second Record', mbReleaseGroupId: RG_SECOND, selectedReleaseId: REL_SECOND, anyReleaseOk: false, releases: [second] },
  { albumId: 3, title: 'Third Record', mbReleaseGroupId: id(103), selectedReleaseId: third.id, anyReleaseOk: true, releases: [third] },
];

beforeAll(() => {
  // First Record: standard edition, fully tagged with MusicBrainz ids, plus a cover.
  const a: FixtureTags = { album: 'First Record', albumArtist: 'Fixture Artist', artist: 'Fixture Artist', mbReleaseGroupId: RG_FIRST, mbReleaseId: REL_FIRST_STD };
  FIRST.forEach((t, i) => put(`First Record (2001)/0${i + 1} - ${t}.flac`, buildFlac({ durationMs: 1000 + i * 1000, tags: { ...a, title: t, trackNo: i + 1, mbRecordingId: id(300 + i) } })));
  put('First Record (2001)/folder.jpg', 'img');
  // A duplicate copy of First Record in another folder (lower quality rip).
  FIRST.forEach((t, i) => put(`First Record [MP3]/0${i + 1} - ${t}.mp3`, buildMp3({ durationMs: 1000 + i * 1000, tags: { ...a, title: t, trackNo: i + 1 } })));

  // Second Record: two discs, no MusicBrainz ids, disc 2 missing one track, discs in subfolders.
  const b: FixtureTags = { album: 'Second Record', albumArtist: 'Fixture Artist' };
  put('Second Record/CD1/01 - Side One.mp3', buildMp3({ durationMs: 2000, tags: { ...b, title: 'Side One', trackNo: 1 } }));
  put('Second Record/CD1/02 - Side Two.mp3', buildMp3({ durationMs: 2000, tags: { ...b, title: 'Side Two', trackNo: 2 } }));
  put('Second Record/CD2/01 - Side Three.mp3', buildMp3({ durationMs: 2000, tags: { ...b, title: 'Side Three', trackNo: 1 } }));

  // Something the artist's catalogue does not know.
  put('Unknown Bootleg/01 - Jam.flac', buildFlac({ durationMs: 1500, tags: { album: 'Unknown Bootleg', title: 'Jam', trackNo: 1 } }));
  put('Unknown Bootleg/02 - Jam Again.flac', buildFlac({ durationMs: 1500, tags: { album: 'Unknown Bootleg', title: 'Jam Again', trackNo: 2 } }));
});

describe('albumTitleFromFolder', () => {
  it('strips year and format decorations', () => {
    expect(albumTitleFromFolder('/m/A/First Record (2001) [FLAC]')).toBe('First Record');
    expect(albumTitleFromFolder('2001 - First Record')).toBe('First Record');
    expect(albumTitleFromFolder('First Record - 2001')).toBe('First Record');
  });
});

describe('rescanArtist', () => {
  it('assigns files to tracks and reports what is left', async () => {
    const result = await rescanArtist({ artistFolder: artist, albums });

    // First Record: standard rip switches the selected (deluxe) release, since anyReleaseOk.
    const first = result.albums.find((a) => a.albumId === 1)!;
    expect(first).toMatchObject({ releaseId: REL_FIRST_STD, releaseRef: 'release:std', releaseChanged: true, incomplete: false, matchedCount: 3 });
    expect(first.confidence).toBeGreaterThan(0.95);
    expect(first.extras.map((e) => e.name)).toEqual(['folder.jpg']);
    expect(first.folders.map((f) => basename(f))).toEqual(['First Record (2001)']);

    // Second Record: both disc folders merge; the selected release is kept (anyReleaseOk false).
    const secondAlbum = result.albums.find((a) => a.albumId === 2)!;
    expect(secondAlbum).toMatchObject({ releaseId: REL_SECOND, releaseChanged: false, incomplete: true, matchedCount: 3 });
    expect(secondAlbum.missingTracks.map((t) => `${t.mediumNumber}-${t.trackPosition} ${t.title}`)).toEqual(['2-2 Side Four']);

    expect(result.albums.find((a) => a.albumId === 3)).toBeUndefined();

    const assigned = (name: string) => result.assignments.find((a) => basename(a.path) === name);
    expect(assigned('02 - Middle Part.flac')).toMatchObject({ albumId: 1, mediumNumber: 1, trackPosition: 2, recordingId: id(301), trackRef: 'track:Middle Part' });
    expect(assigned('01 - Side Three.mp3')).toMatchObject({ albumId: 2, mediumNumber: 2, trackPosition: 1 });
    expect(assigned('01 - Side Three.mp3')!.tags.codec).toBe('MPEG 1 Layer 3');
    expect(result.assignments).toHaveLength(6);

    const reasons = Object.fromEntries(result.unmatchedGroups.map((u) => [basename(u.group.folder), u.reason]));
    expect(reasons).toEqual({ 'First Record [MP3]': 'albumAlreadyMatched', 'Unknown Bootleg': 'belowThreshold' });
    expect(result.unmatchedGroups.find((u) => u.reason === 'albumAlreadyMatched')!.best).toMatchObject({ albumId: 1 });
    expect(result.stats).toMatchObject({ fileCount: 11, matchedFileCount: 6 });
  });

  it('matches a pre-made scan without touching the disk again (pure)', async () => {
    const scan = await scanAudioPath(artist);
    // Only the album tagged with recording ids reaches 1.0; everything else falls below.
    const strict = matchArtistScan(scan, albums, { threshold: 0.999 });
    expect(strict.albums.map((a) => a.albumId)).toEqual([1]);
    expect(strict.assignments.map((a) => basename(a.path))).toEqual(['01 - Opening.flac', '02 - Middle Part.flac', '03 - Closing.flac']);
    expect(strict.unmatchedGroups.map((u) => u.reason).sort()).toEqual(['albumAlreadyMatched', 'belowThreshold', 'belowThreshold']);
    const none = matchArtistScan(scan, []);
    expect(none.unmatchedGroups.every((u) => u.reason === 'noCandidateAlbum')).toBe(true);
  });
});
