import { describe, expect, it } from 'vitest';
import { evaluateComicRelease, evaluateEbookRelease, rankDecisions, titleKeysMatch, type ComicTargetFacts, type EbookTargetFacts, type ProfileFacts, type ReleaseFacts } from './decision.js';

// The pure release decision engine: format / size / term rules from the profile, and title,
// author, ISBN or series / issue matching against the wanted item.

const EBOOKS: ProfileFacts = {
  formats: ['epub', 'azw3', 'mobi', 'pdf'],
  cutoff: 'epub',
  upgradeAllowed: true,
  minSizeMb: 0,
  maxSizeMb: 100,
  ignoredTerms: [],
  preferredTerms: [],
};
const COMICS: ProfileFacts = { ...EBOOKS, formats: ['cbz', 'cbr', 'cb7', 'pdf'], cutoff: 'cbz', maxSizeMb: 2000 };

const MB = 1024 * 1024;
const release = (title: string, extra: Partial<ReleaseFacts> = {}): ReleaseFacts => ({
  guid: title,
  title,
  sizeBytes: 2 * MB,
  protocol: 'torrent',
  seeders: 10,
  ...extra,
});

const BOOK: EbookTargetFacts = { title: 'The Hobbit', authorName: 'J. R. R. Tolkien', isbns: ['9780547928227'], existingFormat: null };
const ISSUE: ComicTargetFacts = { seriesTitle: 'Saga', startYear: 2012, issueNumber: '54', seriesType: 'comic', existingFormat: null };

describe('ebook releases', () => {
  it('approves a matching epub and reads its format', () => {
    const d = evaluateEbookRelease(release('J.R.R. Tolkien - The Hobbit (2012) [epub]'), BOOK, { profile: EBOOKS });
    expect(d.rejections).toEqual([]);
    expect(d.approved).toBe(true);
    expect(d.format).toBe('epub');
  });

  it('rejects another title, a format outside the profile and an oversized release', () => {
    expect(evaluateEbookRelease(release('J.R.R. Tolkien - The Silmarillion [epub]'), BOOK, { profile: EBOOKS }).approved).toBe(false);
    const big = evaluateEbookRelease(release('J.R.R. Tolkien - The Hobbit [epub]', { sizeBytes: 300 * MB }), BOOK, { profile: EBOOKS });
    expect(big.approved).toBe(false);
    expect(big.rejections.join(' ')).toMatch(/size|large|MB/i);
    const onlyPdf = evaluateEbookRelease(release('J.R.R. Tolkien - The Hobbit [epub]'), BOOK, { profile: { ...EBOOKS, formats: ['pdf'], cutoff: 'pdf' } });
    expect(onlyPdf.approved).toBe(false);
  });

  it('rejects a longer title (a sequel) but accepts a shorter one the wanted title extends', () => {
    const dune: EbookTargetFacts = { title: 'Dune', authorName: 'Frank Herbert', isbns: [], existingFormat: null };
    expect(evaluateEbookRelease(release('Frank Herbert - Dune Messiah [epub]'), dune, { profile: EBOOKS }).approved).toBe(false);
    const long: EbookTargetFacts = { ...BOOK, title: 'The Hobbit, or There and Back Again', isbns: [] };
    expect(evaluateEbookRelease(release('J.R.R. Tolkien - The Hobbit [epub]'), long, { profile: EBOOKS }).approved).toBe(true);
  });

  it('rejects audiobook releases, blocked guids and ignored terms', () => {
    expect(evaluateEbookRelease(release('J.R.R. Tolkien - The Hobbit (Audiobook) [mp3]'), BOOK, { profile: EBOOKS }).approved).toBe(false);
    const title = 'J.R.R. Tolkien - The Hobbit [epub]';
    expect(evaluateEbookRelease(release(title), BOOK, { profile: EBOOKS, blockedGuids: new Set([title]) }).approved).toBe(false);
    expect(evaluateEbookRelease(release(title), BOOK, { profile: { ...EBOOKS, ignoredTerms: ['hobbit'] } }).approved).toBe(false);
  });

  it('accepts a better format as an upgrade but not the same format again', () => {
    const title = 'J.R.R. Tolkien - The Hobbit [epub]';
    expect(evaluateEbookRelease(release(title), { ...BOOK, existingFormat: 'pdf' }, { profile: EBOOKS }).approved).toBe(true);
    expect(evaluateEbookRelease(release(title), { ...BOOK, existingFormat: 'epub' }, { profile: EBOOKS }).approved).toBe(false);
    expect(evaluateEbookRelease(release(title), { ...BOOK, existingFormat: 'pdf' }, { profile: { ...EBOOKS, upgradeAllowed: false } }).approved).toBe(false);
  });

  it('scores the profile order: epub above pdf', () => {
    const epub = evaluateEbookRelease(release('J.R.R. Tolkien - The Hobbit [epub]'), BOOK, { profile: EBOOKS });
    const pdf = evaluateEbookRelease(release('J.R.R. Tolkien - The Hobbit [pdf]'), BOOK, { profile: EBOOKS });
    expect(pdf.approved).toBe(true);
    expect(epub.score).toBeGreaterThan(pdf.score);
    const ranked = rankDecisions([
      { ...pdf, publishDate: '2026-01-01' },
      { ...epub, publishDate: '2025-01-01' },
    ]);
    expect(ranked[0]!.format).toBe('epub');
  });
});

describe('comic releases', () => {
  it('approves the wanted issue', () => {
    const d = evaluateComicRelease(release('Saga 054 (2018) (Digital) (Group).cbz'), ISSUE, { profile: COMICS });
    expect(d.rejections).toEqual([]);
    expect(d.format).toBe('cbz');
  });

  it('rejects another issue, another series and packs', () => {
    expect(evaluateComicRelease(release('Saga 055 (2018) (Digital).cbz'), ISSUE, { profile: COMICS }).approved).toBe(false);
    expect(evaluateComicRelease(release('Paper Girls 054 (2018) (Digital).cbz'), ISSUE, { profile: COMICS }).approved).toBe(false);
    expect(evaluateComicRelease(release('Saga 001-054 (2012-2018) (Digital)'), ISSUE, { profile: COMICS }).approved).toBe(false);
  });

  it('rejects a release older than the series', () => {
    expect(evaluateComicRelease(release('Saga 054 (1990) (Digital).cbz'), ISSUE, { profile: COMICS }).approved).toBe(false);
  });
});

describe('titleKeysMatch', () => {
  it('matches equal keys and a key extended by a subtitle', () => {
    expect(titleKeysMatch('the hobbit', 'the hobbit')).toBe(true);
    expect(titleKeysMatch('the hobbit', 'the hobbit or there and back again')).toBe(true);
    expect(titleKeysMatch('the hob', 'the hobbit')).toBe(false);
    expect(titleKeysMatch('', 'x')).toBe(false);
  });
});
