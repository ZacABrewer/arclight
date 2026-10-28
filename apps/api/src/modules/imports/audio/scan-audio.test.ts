import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFlac, buildMp3, buildMp4, buildWav, type FixtureTags } from './fixtures/builders.js';
import { albumFolderOf, audioExtraKind, discNumberFromFolder, isAudioSample, scanAudioPath } from './scan-audio.js';
import { ScanError } from '../scan.js';

const root = mkdtempSync(join(tmpdir(), 'arclight-audio-scan-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function put(rel: string, bytes: Uint8Array | string): string {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, bytes);
  return full;
}

const RG = '00000000-0000-4000-8000-00000000aa01';
const REL_A = '00000000-0000-4000-8000-00000000bb01';
const REL_B = '00000000-0000-4000-8000-00000000bb02';

beforeAll(() => {
  // 1. Fully tagged album with extras.
  const a: FixtureTags = { album: 'Tagged Album', albumArtist: 'Fixture Artist', artist: 'Fixture Artist', mbReleaseGroupId: RG, mbReleaseId: REL_A };
  put('Artist/Tagged Album (2001)/01 - One.flac', buildFlac({ durationMs: 1000, tags: { ...a, title: 'One', trackNo: 1 } }));
  put('Artist/Tagged Album (2001)/02 - Two.flac', buildFlac({ durationMs: 1000, tags: { ...a, title: 'Two', trackNo: 2 } }));
  // Partially tagged: album tags only, same folder -> joins the id group.
  put('Artist/Tagged Album (2001)/03 - Three.flac', buildFlac({ durationMs: 1000, tags: { album: 'Tagged Album', albumArtist: 'Fixture Artist', title: 'Three', trackNo: 3 } }));
  put('Artist/Tagged Album (2001)/02 - Two.lrc', '[00:00.00] silence\n');
  put('Artist/Tagged Album (2001)/cover.jpg', 'not really a jpeg');
  put('Artist/Tagged Album (2001)/booklet-page.png', 'not really a png');
  put('Artist/Tagged Album (2001)/rip.log', 'log');
  put('Artist/Tagged Album (2001)/album.cue', 'FILE "x.flac" WAVE');
  put('Artist/Tagged Album (2001)/notes.nfo', 'unsupported');
  // Samples, hidden and system files.
  put('Artist/Tagged Album (2001)/track-sample.flac', buildFlac({ durationMs: 500 }));
  put('Artist/Tagged Album (2001)/Sample/one.flac', buildFlac({ durationMs: 500 }));
  put('Artist/Tagged Album (2001)/.hidden.flac', buildFlac({ durationMs: 500 }));
  put('Artist/Tagged Album (2001)/@eaDir/01 - One.flac', buildFlac({ durationMs: 500 }));
  put('Artist/Tagged Album (2001)/Thumbs.db', 'x');

  // 2. Multi-disc album in CD1/CD2 subfolders, album tags only (no MusicBrainz ids).
  const b: FixtureTags = { album: 'Double Album', albumArtist: 'Fixture Artist', artist: 'Fixture Artist', discOf: 2 };
  put('Artist/Double Album/CD1/01 - Alpha.mp3', buildMp3({ durationMs: 500, tags: { ...b, title: 'Alpha', trackNo: 1, discNo: 1 } }));
  put('Artist/Double Album/CD2/01 - Beta.mp3', buildMp3({ durationMs: 500, tags: { ...b, title: 'Beta', trackNo: 1 } }));

  // 3. Untagged files: grouped by folder.
  put('Artist/Loose Files/01 - Untitled.wav', buildWav({ durationMs: 200 }));
  put('Artist/Loose Files/02 - Untitled.wav', buildWav({ durationMs: 200 }));

  // 4. Two releases of the same release group in one folder -> split by release id.
  const c: FixtureTags = { album: 'Mixed', albumArtist: 'Fixture Artist', mbReleaseGroupId: '00000000-0000-4000-8000-00000000aa02' };
  put('Artist/Mixed/01 - Song.m4a', buildMp4({ durationMs: 500, tags: { ...c, title: 'Song', trackNo: 1, mbReleaseId: REL_A } }));
  put('Artist/Mixed/01 - Song (other edition).m4a', buildMp4({ durationMs: 500, tags: { ...c, title: 'Song', trackNo: 1, mbReleaseId: REL_B } }));

  // 5. A compilation without album artist: still one group.
  put('Artist/Comp/01.flac', buildFlac({ durationMs: 300, tags: { album: 'Comp', artist: 'One Act', title: 'X', trackNo: 1 } }));
  put('Artist/Comp/02.flac', buildFlac({ durationMs: 300, tags: { album: 'Comp', artist: 'Other Act', title: 'Y', trackNo: 2 } }));

  // 6. An unreadable file.
  put('Artist/Broken/01 - Broken.flac', Uint8Array.from([0x66, 0x4c, 0x61, 0x43, 0x7f, 0xff, 0xff, 0xff]));
});

describe('helpers', () => {
  it('classifies extras', () => {
    expect(audioExtraKind('album.cue')).toBe('cue');
    expect(audioExtraKind('EAC.log')).toBe('log');
    expect(audioExtraKind('01.lrc')).toBe('lyrics');
    expect(audioExtraKind('info.txt')).toBe('text');
    expect(audioExtraKind('Folder.JPG')).toBe('cover');
    expect(audioExtraKind('back.png')).toBe('image');
    expect(audioExtraKind('x.nfo')).toBeNull();
  });

  it('detects samples without flagging songs called "Sample"', () => {
    expect(isAudioSample('/a/track-sample.flac')).toBe(true);
    expect(isAudioSample('/a/sample.mp3')).toBe(true);
    expect(isAudioSample('/a/Samples/01.mp3')).toBe(true);
    expect(isAudioSample('/a/04 - Sample.flac')).toBe(false);
    expect(isAudioSample('/a/04 - Sample Text.flac')).toBe(false);
  });

  it('understands disc folders', () => {
    expect(discNumberFromFolder('CD2')).toBe(2);
    expect(discNumberFromFolder('Disc 03 - Bonus')).toBe(3);
    expect(discNumberFromFolder('disk_1')).toBe(1);
    expect(discNumberFromFolder('CDs of mine')).toBeNull();
    expect(albumFolderOf(join('m', 'Album', 'CD1', 'a.flac'))).toBe(join('m', 'Album'));
    expect(albumFolderOf(join('m', 'Album', 'a.flac'))).toBe(join('m', 'Album'));
  });
});

describe('scanAudioPath', () => {
  it('walks, filters, reads tags and groups', async () => {
    const scan = await scanAudioPath(join(root, 'Artist'));
    const names = (files: Array<{ path: string }>) => files.map((f) => basename(f.path)).sort();

    expect(scan.files).toHaveLength(12);
    expect(scan.skipped.filter((s) => s.reason === 'sample').map((s) => basename(s.path)).sort()).toEqual(['one.flac', 'track-sample.flac']);
    expect(scan.skipped.filter((s) => s.reason === 'excluded').map((s) => basename(s.path)).sort()).toEqual(['.hidden.flac', '@eaDir', 'Thumbs.db']);
    expect(scan.skipped.filter((s) => s.reason === 'unsupported').map((s) => basename(s.path))).toEqual(['notes.nfo']);
    expect(scan.unreadable.map((f) => basename(f.path))).toEqual(['01 - Broken.flac']);
    expect(scan.unreadable[0]!.error).toMatch(/no audio stream/);

    const byFolder = (name: string) => scan.groups.filter((g) => basename(g.folder) === name);

    const [tagged, ...moreTagged] = byFolder('Tagged Album (2001)');
    expect(moreTagged).toEqual([]);
    expect(tagged!.basis).toBe('releaseGroupId');
    expect(tagged!.mbReleaseGroupId).toBe(RG);
    expect(names(tagged!.files)).toEqual(['01 - One.flac', '02 - Two.flac', '03 - Three.flac']);
    expect(tagged!.hasCue).toBe(true);
    expect(tagged!.extras.map((e) => `${e.kind}:${e.name}`).sort()).toEqual(['cover:cover.jpg', 'cue:album.cue', 'image:booklet-page.png', 'log:rip.log', 'lyrics:02 - Two.lrc']);
    expect(tagged!.extras.find((e) => e.kind === 'lyrics')!.forFile).toBe(join(root, 'Artist/Tagged Album (2001)/02 - Two.flac'));

    const [double, ...moreDouble] = byFolder('Double Album');
    expect(moreDouble).toEqual([]);
    expect(double!.basis).toBe('albumTags');
    expect(double!.files.map((f) => [basename(f.path), f.tags?.discNo ?? f.discFromFolder])).toEqual([
      ['01 - Alpha.mp3', 1],
      ['01 - Beta.mp3', 2],
    ]);

    const loose = byFolder('Loose Files');
    expect(loose.map((g) => g.basis)).toEqual(['folder']);
    expect(loose[0]!.files).toHaveLength(2);

    const mixed = byFolder('Mixed');
    expect(mixed).toHaveLength(2);
    expect(mixed.map((g) => g.mbReleaseId).sort()).toEqual([REL_A, REL_B]);

    const comp = byFolder('Comp');
    expect(comp).toHaveLength(1);
    expect(comp[0]!.files).toHaveLength(2);

    expect(scan.tagReadMs).toBeGreaterThanOrEqual(0);
  });

  it('scans a single file', async () => {
    const scan = await scanAudioPath(join(root, 'Artist/Comp/01.flac'));
    expect(scan.isFile).toBe(true);
    expect(scan.groups).toHaveLength(1);
    expect(scan.files[0]!.tags?.title).toBe('X');
  });

  it('throws ScanError for a missing path', async () => {
    await expect(scanAudioPath(join(root, 'nope'))).rejects.toBeInstanceOf(ScanError);
  });
});
