import { describe, expect, it } from 'vitest';
import { QualityProfileInput, type MediaVersion, type QualityName } from '@arclight/shared';
import { libraryService } from '../library/index.js';
import { GB, harness, makeProfile, makeRelease, quality } from './test-support.js';

// Multi-version library in the decision engine: a release is evaluated against the version
// slot whose profile it fits best, competes only with that slot's file/queue, and two slots
// of one movie can both be grabbed in one batch.

const UHD_ALLOWED: QualityName[] = ['WEBDL-2160p', 'WEBRip-2160p', 'Bluray-2160p', 'Remux-2160p'];

async function setup() {
  const h = await harness();
  const { id: _id, ...draft } = makeProfile(UHD_ALLOWED, {}, 'Remux-2160p');
  const uhd = h.profiles.createQualityProfile(QualityProfileInput.parse({ ...draft, name: 'UHD' }));
  const versions: MediaVersion[] = [
    { tag: '1080p', qualityProfileId: h.profile.id, enabled: true },
    { tag: '4K', qualityProfileId: uhd.id, enabled: true },
  ];
  return { ...h, uhd, versions };
}

function addFile(h: Awaited<ReturnType<typeof setup>>, movieId: number, q: QualityName, versionTag: string | null) {
  return libraryService.addMediaFile(h.db, {
    mediaType: 'movie',
    movieId,
    relativePath: `${q}.mkv`,
    path: `/movies/x/${q}-${movieId}.mkv`,
    sizeBytes: 4 * GB,
    quality: quality(q),
    languages: ['en'],
    versionTag,
  }).file;
}

const R2160 = 'Movie.2020.2160p.WEB-DL.DDP5.1.H.265-GRP';
const R1080 = 'Movie.2020.1080p.WEB-DL.DDP5.1.H.264-GRP';

describe('multi-version movie decisions', () => {
  it('search picks the 4K slot for a 2160p release while the 1080p slot is already met', async () => {
    const h = await setup();
    const movie = h.addMovie({ title: 'Movie', year: 2020, versions: h.versions });
    addFile(h, movie.id, 'WEBDL-1080p', '1080p');
    const decisions = await h.service.processReleases(
      [makeRelease(R2160, { size: 15 * GB }), makeRelease(R1080, { size: 6 * GB })],
      'rss',
    );
    const uhd = decisions.find((d) => d.title === R2160)!;
    const hd = decisions.find((d) => d.title === R1080)!;
    expect(uhd).toMatchObject({ versionTag: '4K', approved: true });
    expect(hd.versionTag).toBe('1080p');
    expect(hd.approved).toBe(false);
    expect(hd.rejections.map((r) => r.reason)).toContain('diskCutoffMet');
    expect(h.downloads.grabs.map((g) => g.request.title)).toEqual([R2160]);
  });

  it('grabs one release per version slot in the same batch', async () => {
    const h = await setup();
    const movie = h.addMovie({ title: 'Movie', year: 2020, versions: h.versions });
    await h.service.processReleases([makeRelease(R1080, { size: 6 * GB }), makeRelease(R2160, { size: 15 * GB })], 'rss');
    expect(h.downloads.grabs.map((g) => g.request.title).sort()).toEqual([R1080, R2160].sort());
    expect(h.downloads.grabs.every((g) => g.tracking.movieId === movie.id)).toBe(true);
  });

  it('an upgrade is judged only against its own slot file', async () => {
    const h = await setup();
    const movie = h.addMovie({ title: 'Movie', year: 2020, versions: h.versions });
    addFile(h, movie.id, 'WEBDL-1080p', '1080p');
    addFile(h, movie.id, 'WEBDL-2160p', '4K');
    const remux = 'Movie.2020.2160p.UHD.BluRay.REMUX.HDR.HEVC.TrueHD.Atmos-GRP';
    const [d] = await h.service.processReleases([makeRelease(remux, { size: 50 * GB })], 'rss');
    expect(d).toMatchObject({ versionTag: '4K', approved: true });
  });

  it('a disabled slot is not evaluated: the release falls to the enabled slot and is rejected there', async () => {
    const h = await setup();
    const movie = h.addMovie({ title: 'Movie', year: 2020, versions: [h.versions[0]!, { ...h.versions[1]!, enabled: false }] });
    addFile(h, movie.id, 'WEBDL-1080p', '1080p');
    const [d] = await h.service.processReleases([makeRelease(R2160, { size: 15 * GB })], 'rss');
    expect(d!.versionTag).toBe('1080p');
    expect(d!.approved).toBe(false);
  });

  it('backward compatible: an unversioned movie has no versionTag and one profile', async () => {
    const h = await setup();
    const movie = h.addMovie({ title: 'Movie', year: 2020 });
    addFile(h, movie.id, 'WEBDL-1080p', null);
    const decisions = await h.service.processReleases([makeRelease(R2160, { size: 15 * GB })], 'rss');
    expect(decisions[0]!.versionTag).toBeUndefined();
    expect(decisions[0]!.approved).toBe(false);
    expect(h.downloads.grabs).toHaveLength(0);
  });
});
