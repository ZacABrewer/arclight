import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QUALITIES } from '@arclight/shared';
import { renderAt, stubApi } from '../../../test/route-harness.js';
import { audiobookFacts } from '../../../api/audiobook-acquisition.js';
import { bitrateText, matchedBookTitles, narratorsText, seriesText } from './audiobook-release-model.js';
import { AB_FEATURES_ON, audiobookProfiles, audiobookRoots, makeAuthor, makeAuthorDetails, makeBook, makeBookDetails, seriesLink } from './audiobook-fixtures.js';

// Audiobook interactive search (WP 3E). Names are invented.

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const author = makeAuthor({ id: 1, name: 'Mara Quill' });
const book = makeBook({ id: 12, title: 'Harbor of Glass', series: [seriesLink(30, 'The Tidewright Cycle', '2', 12)] });
const third = makeBook({ id: 13, title: 'Storm Ledger', series: [seriesLink(30, 'The Tidewright Cycle', '3', 13)] });
const abq = { quality: { ...QUALITIES['AB-AAC'], mediaTypes: [...QUALITIES['AB-AAC'].mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } };

function info(over: Record<string, unknown> = {}) {
  return {
    authors: ['Mara Quill'],
    title: 'Harbor of Glass',
    subtitle: null,
    series: 'The Tidewright Cycle',
    seriesPosition: '2',
    narrators: ['Tess Arden'],
    year: 2017,
    formatType: 'unabridged',
    container: 'm4b',
    codec: 'AAC',
    bitrateKbps: 64,
    asin: null,
    isbn: null,
    isPack: false,
    language: null,
    ...over,
  };
}

function decision(over: Record<string, unknown>) {
  return {
    guid: 'g1',
    title: 'Mara Quill - The Tidewright Cycle 02 - Harbor of Glass (Unabridged) [m4b]',
    size: 400 * 1024 ** 2,
    publishDate: '2026-10-20T00:00:00.000Z',
    downloadUrl: 'http://indexer.invalid/1',
    categories: [3030],
    indexerId: 2,
    indexerName: 'Book Idx',
    indexerPriority: 25,
    protocol: 'torrent',
    seeders: 9,
    leechers: 0,
    age: 6,
    ageHours: 144,
    ageMinutes: 8640,
    rejections: [],
    approved: true,
    temporarilyRejected: false,
    downloadAllowed: true,
    source: 'interactiveSearch',
    mediaType: 'audiobook',
    authorId: 1,
    bookIds: [12],
    quality: abq,
    languages: [],
    customFormats: [],
    customFormatScore: 0,
    fullSeason: false,
    audiobook: info(),
    ...over,
  };
}

function stub(extra: Record<string, unknown> = {}) {
  return stubApi({
    '/api/v1/settings/features': AB_FEATURES_ON,
    '/api/v1/qualityprofile': audiobookProfiles,
    '/api/v1/rootfolder': audiobookRoots,
    '/api/v1/tag': [],
    ...extra,
  });
}

describe('audiobook release facts', () => {
  it('reads narrators, series, bitrate and matched books', () => {
    const f = audiobookFacts({ audiobook: info({ narrators: ['A', 'B'], seriesPosition: '1-3', formatType: 'unknown', container: 'unknown' }) as never });
    expect(narratorsText(f)).toBe('A, B');
    expect(seriesText(f)).toBe('The Tidewright Cycle · Books 1–3');
    expect(bitrateText(f)).toBe('64 kbps');
    expect(f.formatType).toBeNull();
    expect(f.container).toBeNull();
    expect(audiobookFacts({}).narrators).toEqual([]);
    expect(matchedBookTitles({ bookIds: [12, 99] }, new Map([[12, 'Harbor of Glass']]))).toEqual(['Harbor of Glass', '#99']);
  });
});

describe('audiobook interactive search', () => {
  it('shows the audiobook columns and grabs with the author and books', async () => {
    const releases = [
      decision({}),
      decision({
        guid: 'g2',
        title: 'Mara Quill - The Tidewright Cycle Books 1-3 (Abridged) [mp3]',
        approved: false,
        rejections: [{ reason: 'bookPack', message: 'Book packs are off', type: 'permanent' }],
        bookIds: [12, 13],
        books: [
          { id: 12, title: 'Harbor of Glass', series: 'The Tidewright Cycle', seriesPosition: '2', year: 2017 },
          { id: 13, title: 'Storm Ledger', series: 'The Tidewright Cycle', seriesPosition: '3', year: 2019 },
        ],
        audiobook: info({ title: null, seriesPosition: '1-3', isPack: true, formatType: 'abridged', container: 'mp3', bitrateKbps: 128, narrators: ['Tess Arden', 'Rowan Pike'] }),
      }),
    ];
    const api = stub({
      '/api/v1/book/12': makeBookDetails(book, { author }),
      '/api/v1/release': releases,
      'POST /api/v1/release': { title: releases[1]!.title, queueItemId: 3, downloadId: 'abc', downloadClientId: 1 },
    });
    renderAt('/library/audiobooks/book/12');
    fireEvent.click(await screen.findByRole('button', { name: 'Interactive search' }));
    const dialog = await screen.findByRole('dialog');
    const table = await within(dialog).findByRole('table', { name: 'Releases' });
    for (const h of ['Narrators', 'Format', 'Container', 'Bitrate', 'Series']) expect(within(table).getByRole('columnheader', { name: h })).toBeTruthy();
    expect(api.calls.find((c) => c.path === '/api/v1/release')).toBeTruthy();

    const single = within(table).getByRole('row', { name: /Harbor of Glass \(Unabridged\)/ });
    expect(within(single).getByText('Tess Arden')).toBeTruthy();
    expect(within(single).getByText('Unabridged')).toBeTruthy();
    expect(within(single).getByText('m4b')).toBeTruthy();
    expect(within(single).getByText('64 kbps')).toBeTruthy();
    expect(within(single).getByText('The Tidewright Cycle · Book 2')).toBeTruthy();
    expect(within(single).queryByTestId('pack-badge')).toBeNull();

    const pack = within(table).getByRole('row', { name: /Books 1-3/ });
    expect(within(pack).getByTestId('pack-badge').textContent).toBe('Pack');
    expect(within(pack).getByText('Covers 2 books: Harbor of Glass, Storm Ledger')).toBeTruthy();
    expect(within(pack).getByText('Abridged')).toBeTruthy();
    expect(within(pack).getByText('Tess Arden, Rowan Pike')).toBeTruthy();
    expect(within(pack).getByText('The Tidewright Cycle · Books 1–3')).toBeTruthy();

    // Rejected (book packs are off) but mapped: Grab anyway, after a confirmation.
    fireEvent.click(within(pack).getByRole('button', { name: /^Grab .* anyway$/ }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Grab a rejected release?' })).getByRole('button', { name: 'Grab anyway' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/release')?.body).toEqual({ guid: 'g2', indexerId: 2, authorId: 1, bookIds: [12, 13] }),
    );
  });

  it('searches an author for packs and every wanted book', async () => {
    const api = stub({
      '/api/v1/author/1': makeAuthorDetails(author, [book, third]),
      '/api/v1/release': (_i: RequestInit | undefined, url: URL) => (url.searchParams.get('authorId') === '1' ? [decision({})] : []),
    });
    renderAt('/library/audiobooks/author/1');
    fireEvent.click(await screen.findByRole('button', { name: 'Interactive search' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Tess Arden')).toBeTruthy();
    expect(api.calls.some((c) => c.path === '/api/v1/release')).toBe(true);
  });
});
