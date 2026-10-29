import { describe, expect, it } from 'vitest';
import { DEFAULT_RELEASE_SETTINGS } from './deps.js';
import { audiobookSpecifications, languageCode, wantedPackBooks } from './audio-specs.js';
import { booksGainedBy, evaluate, releaseKindOf, runtimeMinutes, specApplies, type ExistingFile } from './engine.js';
import { bookSnapshot, makeAudiobookProfile, makeAuthor, makeBook, makeBookCandidate, makeContext, makeRelease, NOW, quality } from './test-support.js';

const MB = 1024 * 1024;
const corey = makeAuthor({ name: 'James S. A. Corey', languages: ['english'] });
const leviathan = makeBook(corey.id, 'Leviathan Wakes', { seriesName: 'The Expanse', position: '1', runtimeMinutes: 1000 });
const calibans = makeBook(corey.id, "Caliban's War", { seriesName: 'The Expanse', position: '2', runtimeMinutes: 1000 });
const abaddon = makeBook(corey.id, "Abaddon's Gate", { seriesName: 'The Expanse', position: '3', runtimeMinutes: 1000, monitored: false });
const german = makeBook(corey.id, 'Cibola Burn', { seriesName: 'The Expanse', position: '4', language: 'german', runtimeMinutes: 1000 });
const abridged = makeBook(corey.id, 'Nemesis Games', { formatType: 'abridged', runtimeMinutes: 300 });
const unknownRuntime = makeBook(corey.id, 'Persepolis Rising', { runtimeMinutes: null });
const lib = bookSnapshot([corey], [leviathan, calibans, abaddon, german, abridged, unknownRuntime]);
const profile = makeAudiobookProfile();

function ctxFor(overrides: Parameters<typeof makeContext>[0] = {}) {
  return makeContext({ profile, ...overrides });
}

function reasons(title: string, size: number, ctx = ctxFor()) {
  const c = makeBookCandidate(makeRelease(title, { size, categories: [3030] }), lib, profile);
  return evaluate(ctx, c, audiobookSpecifications).rejections.map((r) => r.reason);
}

function fileOf(bookId: number, q: Parameters<typeof quality>[0]): ExistingFile {
  return { id: bookId * 10, quality: quality(q), formatScore: 0, releaseGroup: null, dateAdded: NOW.toISOString(), episodeIds: [], bookIds: [bookId], sizeBytes: 100 * MB };
}

describe('audiobook specs', () => {
  it('applies audio and audiobook specs to books, never music or video only ones', () => {
    const byId = new Map(audiobookSpecifications.map((s) => [s.id, s.appliesTo]));
    for (const id of ['bookPack', 'formatTypeMatch', 'bookLanguage', 'bookReleased', 'audioSizePlausible', 'sizeLimits', 'monitored', 'blocklist']) {
      expect(specApplies(byId.get(id)!, 'audiobook'), id).toBe(true);
    }
    for (const id of ['discographyPack', 'albumReleased', 'language', 'sample', 'hardcodedSubs']) {
      expect(specApplies(byId.get(id)!, 'audiobook'), id).toBe(false);
    }
    expect(specApplies(byId.get('bookPack')!, 'music')).toBe(false);
  });

  it('approves a plain unabridged m4b of a wanted book', () => {
    expect(reasons('James S. A. Corey - Leviathan Wakes (Unabridged) [m4b]', 500 * MB)).toEqual([]);
  });

  it('bookPack: automatic grabs need allowBookPacks and minPackWanted; interactive grabs always may', () => {
    const title = 'James S. A. Corey - The Expanse Books 1-3 [m4b]';
    expect(reasons(title, 1500 * MB)).toContain('bookPackNotAllowed');
    const allowed = { ...DEFAULT_RELEASE_SETTINGS, allowBookPacks: true };
    expect(reasons(title, 1500 * MB, ctxFor({ settings: allowed }))).not.toContain('bookPackNotAllowed');
    // Book 3 is unmonitored; with files for 1 the pack brings only book 2.
    const ctx = ctxFor({ settings: { ...allowed, minPackWanted: 2 }, existingFiles: [fileOf(leviathan.id, 'AB-AAC')] });
    const c = makeBookCandidate(makeRelease(title, { size: 1500 * MB }), lib, profile);
    expect(releaseKindOf(c.match)).toBe('bookPack');
    expect(wantedPackBooks(ctx, c)).toEqual([calibans.id]);
    expect(evaluate(ctx, c, audiobookSpecifications).rejections.map((r) => r.reason)).toContain('packTooFewWanted');
    expect(reasons(title, 1500 * MB, ctxFor({ source: 'interactiveSearch' }))).not.toContain('bookPackNotAllowed');
  });

  it('formatTypeMatch: abridged releases of unabridged books are refused unless allowAbridged', () => {
    expect(reasons('James S. A. Corey - Leviathan Wakes (Abridged) [m4b]', 300 * MB)).toContain('abridgedNotWanted');
    expect(reasons('James S. A. Corey - Leviathan Wakes (Abridged) [m4b]', 300 * MB, ctxFor({ settings: { ...DEFAULT_RELEASE_SETTINGS, allowAbridged: true } }))).not.toContain(
      'abridgedNotWanted',
    );
    // The catalogue lists this one as abridged: an abridged release is what is wanted.
    expect(reasons('James S. A. Corey - Nemesis Games (Abridged) [m4b]', 120 * MB)).not.toContain('abridgedNotWanted');
  });

  it("bookLanguage: a stated language must be the author's or the book's", () => {
    expect(languageCode('English')).toBe('en');
    expect(languageCode('de-DE')).toBe('de');
    expect(reasons('James S. A. Corey - Leviathan Wakes [German] [m4b]', 500 * MB)).toContain('wrongBookLanguage');
    expect(reasons('James S. A. Corey - Leviathan Wakes [English] [m4b]', 500 * MB)).not.toContain('wrongBookLanguage');
    // The book itself is German: German is fine, English is fine (author language).
    expect(reasons('James S. A. Corey - Cibola Burn [German] [m4b]', 500 * MB)).not.toContain('wrongBookLanguage');
  });

  it('size checks use MB per minute times the catalogue runtime', () => {
    const c = makeBookCandidate(makeRelease('James S. A. Corey - Leviathan Wakes [m4b]', { size: 500 * MB }), lib, profile);
    expect(runtimeMinutes(c, NOW)).toBe(1000);
    // AB-AAC: user limits 0.25-1.5 MB/min → 250-1500 MB for 1000 min.
    const limits = (id: number) => (id === c.quality.quality.id ? { minSize: 0.25, maxSize: 1.5, preferredSize: 0.6 } : undefined);
    const ctx = ctxFor({ qualityLimits: limits });
    expect(reasons('James S. A. Corey - Leviathan Wakes [m4b]', 100 * MB, ctx)).toEqual(expect.arrayContaining(['belowMinimumSize', 'audioSizeImplausible']));
    expect(reasons('James S. A. Corey - Leviathan Wakes [m4b]', 2000 * MB, ctx)).toContain('aboveMaximumSize');
    expect(reasons('James S. A. Corey - Leviathan Wakes [m4b]', 600 * MB, ctx)).toEqual([]);
    // Unknown runtime: no size verdict either way.
    expect(reasons('James S. A. Corey - Persepolis Rising [m4b]', 5 * MB, ctx)).toEqual([]);
  });

  it('monitored and upgrade rules use the books; a pack upgrades only books below cutoff', () => {
    expect(reasons("James S. A. Corey - Abaddon's Gate [m4b]", 500 * MB)).toContain('bookNotMonitored');
    const met = ctxFor({ existingFiles: [fileOf(leviathan.id, 'AB-AAC')] });
    expect(reasons('James S. A. Corey - Leviathan Wakes [m4b]', 500 * MB, met)).toContain('diskCutoffMet');
    const low = ctxFor({ existingFiles: [fileOf(leviathan.id, 'AB-MP3')] });
    expect(reasons('James S. A. Corey - Leviathan Wakes [m4b]', 500 * MB, low)).toEqual([]);
    const pack = makeBookCandidate(makeRelease('James S. A. Corey - The Expanse Books 1-2 [m4b]', { size: 1200 * MB }), lib, profile);
    const both = ctxFor({ existingFiles: [fileOf(leviathan.id, 'AB-AAC'), fileOf(calibans.id, 'AB-MP3')], source: 'interactiveSearch' });
    expect(booksGainedBy(both, pack)).toEqual([calibans.id]);
    const none = ctxFor({ existingFiles: [fileOf(leviathan.id, 'AB-AAC'), fileOf(calibans.id, 'AB-AAC')], source: 'interactiveSearch' });
    expect(evaluate(none, pack, audiobookSpecifications).rejections.map((r) => r.reason)).toContain('diskNotUpgrade');
  });

  it('bookReleased: future books wait for automatic grabs only', () => {
    const future = makeBook(corey.id, 'Leviathan Falls', { releaseDate: '2026-12-01', year: 2026 });
    const futureLib = bookSnapshot([corey], [future]);
    const c = makeBookCandidate(makeRelease('James S. A. Corey - Leviathan Falls [m4b]', { size: 500 * MB }), futureLib, profile);
    expect(evaluate(ctxFor(), c, audiobookSpecifications).rejections.map((r) => r.reason)).toContain('bookNotReleased');
    expect(evaluate(ctxFor({ source: 'interactiveSearch' }), c, audiobookSpecifications).rejections.map((r) => r.reason)).not.toContain('bookNotReleased');
  });

  it('searchItem rejects other authors and books', () => {
    const criteria = { mediaType: 'audiobook' as const, authorId: corey.id, bookIds: [calibans.id], userInvoked: false };
    expect(reasons('James S. A. Corey - Leviathan Wakes [m4b]', 500 * MB, ctxFor({ criteria, source: 'search' }))).toContain('wrongBook');
    expect(reasons('James S. A. Corey - Leviathan Wakes [m4b]', 500 * MB, ctxFor({ criteria: { ...criteria, authorId: 999, bookIds: [] }, source: 'search' }))).toContain(
      'wrongAuthor',
    );
  });
});
