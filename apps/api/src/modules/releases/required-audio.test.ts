import { describe, expect, it } from 'vitest';
import type { MediaInfo, MediaVersion, QualityName } from '@arclight/shared';
import { additionalLanguages } from '../../db/schema.js';
import { libraryService } from '../library/index.js';
import { GB, harness, makeRelease, quality } from './test-support.js';

// "Add additional…" → audio in the decision engine: saved required audio languages reject
// releases without them, a release that adds the language may replace a file that already
// meets cutoff (same quality or better), and a version slot that asks for a language attracts
// releases carrying it.

const ENGLISH: MediaInfo = { audioStreams: [{ codec: 'eac3', language: 'eng' }] };

type H = Awaited<ReturnType<typeof harness>>;

function addFile(h: H, movieId: number, q: QualityName, versionTag: string | null = null, mediaInfo: MediaInfo | null = ENGLISH) {
  const { file } = libraryService.addMediaFile(h.db, {
    mediaType: 'movie',
    movieId,
    relativePath: `${q}-${versionTag ?? 'x'}.mkv`,
    path: `/movies/x/${q}-${versionTag ?? 'x'}-${movieId}.mkv`,
    sizeBytes: 4 * GB,
    quality: quality(q),
    languages: ['en'],
    versionTag,
    mediaInfo,
  });
  return file;
}

function requireAudio(h: H, movieId: number, language: string) {
  const now = new Date().toISOString();
  h.db
    .insert(additionalLanguages)
    .values({ kind: 'audio', mediaType: 'movie', movieId, scopeKey: `movie:${movieId}`, language, mode: 'replace', status: 'saved', createdAt: now, updatedAt: now })
    .run();
}

const ENGLISH_ONLY = 'Movie.2020.1080p.WEB-DL.DDP5.1.H.264-GRP';
const DUAL = 'Movie.2020.SPANISH.ENGLISH.1080p.WEB-DL.DDP5.1.H.264-GRP';
const DUAL_720 = 'Movie.2020.SPANISH.ENGLISH.720p.WEB-DL.DDP5.1.H.264-GRP';
const SPANISH_ONLY = 'Movie.2020.SPANISH.1080p.WEB-DL.DDP5.1.H.264-GRP';

describe('required audio languages', () => {
  it('rejects releases without the required language and its current languages', async () => {
    const h = await harness();
    const movie = h.addMovie({ title: 'Movie', year: 2020 });
    addFile(h, movie.id, 'WEBDL-720p');
    requireAudio(h, movie.id, 'es');
    const decisions = await h.service.decide([makeRelease(ENGLISH_ONLY, { size: 6 * GB }), makeRelease(SPANISH_ONLY, { size: 6 * GB })], 'search');
    const en = decisions.find((d) => d.decision.title === ENGLISH_ONLY)!.decision;
    const es = decisions.find((d) => d.decision.title === SPANISH_ONLY)!.decision;
    expect(en.rejections.map((r) => r.reason)).toContain('missingRequiredAudioLanguage');
    expect(en.rejections.find((r) => r.reason === 'missingRequiredAudioLanguage')!.message).toMatch(/Spanish/);
    // Spanish alone would drop the English the current file has.
    expect(es.rejections.find((r) => r.reason === 'missingRequiredAudioLanguage')!.message).toMatch(/English/);
  });

  it('lets a release that adds the language replace a file that meets cutoff, at the same quality or better', async () => {
    const h = await harness();
    const movie = h.addMovie({ title: 'Movie', year: 2020 });
    addFile(h, movie.id, 'WEBDL-1080p');
    requireAudio(h, movie.id, 'es');
    const [same] = await h.service.decide([makeRelease(DUAL, { size: 6 * GB })], 'search');
    expect(same!.decision.approved).toBe(true);
    const [lower] = await h.service.decide([makeRelease(DUAL_720, { size: 3 * GB })], 'search');
    expect(lower!.decision.rejections.map((r) => r.reason)).toContain('languageReplacementLowerQuality');
    await h.service.processReleases([makeRelease(DUAL, { size: 6 * GB })], 'search');
    expect(h.downloads.grabs.map((g) => g.request.title)).toEqual([DUAL]);
  });

  it('without a requirement nothing changes: the file meets cutoff', async () => {
    const h = await harness();
    const movie = h.addMovie({ title: 'Movie', year: 2020 });
    addFile(h, movie.id, 'WEBDL-1080p');
    const [d] = await h.service.decide([makeRelease(DUAL, { size: 6 * GB })], 'search');
    expect(d!.decision.rejections.map((r) => r.reason)).toEqual(['diskCutoffMet']);
  });

  it('a file lacking a required language does not meet cutoff (so cutoff-unmet searches pick it up)', async () => {
    const h = await harness();
    const movie = h.addMovie({ title: 'Movie', year: 2020 });
    const file = addFile(h, movie.id, 'WEBDL-1080p');
    const isMet = h.service.isFileCutoffMet();
    expect(isMet(libraryService.getMediaFile(h.db, file.id))).toBe(true);
    requireAudio(h, movie.id, 'es');
    expect(h.service.isFileCutoffMet()(libraryService.getMediaFile(h.db, file.id))).toBe(false);
  });

  it('a version slot that asks for a language attracts releases carrying it', async () => {
    const h = await harness();
    const versions: MediaVersion[] = [
      { tag: 'Standard', qualityProfileId: h.profile.id, enabled: true },
      { tag: 'Spanish', qualityProfileId: h.profile.id, enabled: true, audioLanguages: ['es'] },
    ];
    const movie = h.addMovie({ title: 'Movie', year: 2020, versions });
    addFile(h, movie.id, 'WEBDL-1080p', 'Standard');
    const decisions = await h.service.decide([makeRelease(SPANISH_ONLY, { size: 6 * GB }), makeRelease(ENGLISH_ONLY, { size: 6 * GB })], 'search');
    const es = decisions.find((d) => d.decision.title === SPANISH_ONLY)!.decision;
    const en = decisions.find((d) => d.decision.title === ENGLISH_ONLY)!.decision;
    expect(es).toMatchObject({ versionTag: 'Spanish', approved: true });
    expect(en.versionTag).toBe('Standard');
    expect(en.rejections.map((r) => r.reason)).toEqual(['diskCutoffMet']);
  });
});
