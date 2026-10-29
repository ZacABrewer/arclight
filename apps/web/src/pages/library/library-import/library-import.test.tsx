import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { LibraryImportCandidate, LibraryImportMatch, LibraryImportScan } from '@arclight/shared';
import { renderAt, stubApi } from '../../../test/route-harness.js';
import { AB_FEATURES_ON, audiobookProfiles, audiobookRoots } from '../audiobooks/audiobook-fixtures.js';
import { defaultSelection, effectiveMatch, filterCandidates, progressText, searchTermFor, toImportRequest } from './library-import-model.js';

// Library import page and model. Every name, title and narrator here is invented.

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const match = (over: Partial<LibraryImportMatch> = {}): LibraryImportMatch => ({
  foreignId: 'B0ABCDE123',
  title: 'The Glass Orchard',
  subtitle: null,
  creditName: 'Mara Quill',
  creditForeignId: 'B0AUTHOR01',
  year: 2019,
  coverUrl: null,
  narrators: ['Tamsin Vale'],
  runtimeMinutes: 600,
  series: null,
  seriesPosition: null,
  albumType: null,
  inLibrary: false,
  score: 0.92,
  ...over,
});

const candidate = (over: Partial<LibraryImportCandidate> = {}): LibraryImportCandidate => ({
  id: 'c1',
  mediaType: 'audiobook',
  folder: '/data/audiobooks/Mara Quill/The Glass Orchard',
  relativeFolder: 'Mara Quill/The Glass Orchard',
  files: [{ path: '/data/audiobooks/Mara Quill/The Glass Orchard/01.mp3', relativePath: '01.mp3', sizeBytes: 1000, durationMs: 60_000, readable: true }],
  sizeBytes: 1000,
  durationMs: 60_000,
  detected: { author: 'Mara Quill', title: 'The Glass Orchard', series: null, seriesPosition: null, narrator: null, year: null, asin: null, isbn: null, mbReleaseGroupId: null, mbReleaseId: null, mbArtistId: null },
  match: match(),
  alternatives: [],
  confidence: 0.92,
  matchedBy: 'search',
  warnings: [],
  status: 'pending',
  message: null,
  ...over,
});

const glass = candidate();
const lantern = candidate({
  id: 'c2',
  folder: '/data/audiobooks/Lantern Road',
  relativeFolder: 'Lantern Road',
  detected: { ...glass.detected, author: null, title: 'Lantern Road' },
  match: match({ foreignId: 'B0LANTERN1', title: 'Lantern Road', creditName: 'Oswin Hale', score: 0.4 }),
  alternatives: [match({ foreignId: 'B0LANTERN2', title: 'Lantern Road: A Novel', creditName: 'Oswin Hale', score: 0.38 })],
  confidence: 0.4,
  warnings: ["Total duration 1 min is 99% off the book's runtime of 10 h (tolerance 15%)"],
});
const unknown = candidate({ id: 'c3', relativeFolder: 'Misc', detected: { ...glass.detected, author: null, title: null }, match: null, confidence: 0, matchedBy: 'none' });

const scan = (over: Partial<LibraryImportScan> = {}): LibraryImportScan => ({
  id: 'scan-1',
  mediaType: 'audiobook',
  path: '/data/audiobooks',
  rootFolderPath: '/data/audiobooks',
  status: 'ready',
  progress: { done: 3, total: 3 },
  jobId: null,
  startedAt: '2026-10-29T10:00:00.000Z',
  finishedAt: '2026-10-29T10:01:00.000Z',
  error: null,
  stats: { files: 5, alreadyInLibrary: 2, unreadable: 0, candidates: 3, imported: 0, failed: 0 },
  candidates: [glass, lantern, unknown],
  ...over,
});

describe('library import model', () => {
  it('selects confident proposals, applies overrides and builds the request', () => {
    expect([...defaultSelection([glass, lantern, unknown])]).toEqual(['c1']);
    const overrides = new Map<string, LibraryImportMatch | null>([
      ['c2', lantern.alternatives[0]!],
      ['c1', null],
    ]);
    expect(effectiveMatch(glass, overrides)).toBeNull();
    expect(filterCandidates([glass, lantern, unknown], 'unmatched', '', overrides).map((c) => c.id)).toEqual(['c1', 'c3']);
    expect(filterCandidates([glass, lantern, unknown], 'warnings', '', new Map()).map((c) => c.id)).toEqual(['c2']);
    expect(filterCandidates([glass, lantern, unknown], 'all', 'oswin', new Map()).map((c) => c.id)).toEqual(['c2']);
    const req = toImportRequest(scan(), new Set(['c1', 'c2', 'c3']), overrides, { qualityProfileId: 21, mode: 'inPlace' });
    expect(req.items).toEqual([{ candidateId: 'c2', foreignId: 'B0LANTERN2' }]);
    expect(searchTermFor(unknown)).toBe('Misc');
    expect(searchTermFor(glass)).toBe('Mara Quill The Glass Orchard');
    expect(progressText(scan({ status: 'matching', progress: { done: 2, total: 9 } }))).toBe('Matching 2 of 9 folders');
  });
});

describe('library import page', () => {
  it('scans a root folder, reviews the proposals, changes a match and imports the selection', async () => {
    let current = scan({ status: 'matching', progress: { done: 1, total: 3 }, candidates: [] });
    const api = stubApi({
      '/api/v1/settings/features': AB_FEATURES_ON,
      '/api/v1/qualityprofile': audiobookProfiles,
      '/api/v1/rootfolder': audiobookRoots,
      '/api/v1/tag': [],
      '/api/v1/libraryimport/scan': [],
      'POST /api/v1/libraryimport/scan': () => current,
      '/api/v1/libraryimport/scan/scan-1': () => current,
      '/api/v1/libraryimport/lookup': [match({ foreignId: 'B0OTHER001', title: 'Lantern Road (Dramatised)', creditName: 'Oswin Hale' })],
      'POST /api/v1/libraryimport/import': () => (current = scan({ status: 'importing', candidates: current.candidates.map((c) => (c.id === 'c1' || c.id === 'c2' ? { ...c, status: 'importing' } : c)) })),
    });
    renderAt('/library/audiobooks/import');
    expect(await screen.findByRole('heading', { name: 'Import existing audiobooks' })).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Root folder' }) as HTMLSelectElement).value).toBe('/data/audiobooks'));
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }));
    expect(await screen.findByText('Matching 1 of 3 folders')).toBeTruthy();
    expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({ mediaType: 'audiobook', path: '/data/audiobooks' });

    current = scan();
    const list = await screen.findByRole('list', { name: 'Books found' }, { timeout: 3000 });
    const rows = within(list).getAllByRole('listitem').filter((li) => li.classList.contains('li-row'));
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('Mara Quill – The Glass Orchard (2019)')).toBeTruthy();
    expect((within(rows[0]!).getByRole('checkbox', { name: 'Select Mara Quill/The Glass Orchard' }) as HTMLInputElement).checked).toBe(true);
    expect((within(rows[1]!).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect(within(rows[1]!).getByText(/off the book's runtime/)).toBeTruthy();
    expect(within(rows[2]!).getByText('No match found')).toBeTruthy();
    expect((within(rows[2]!).getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);

    // Change the second folder's match through the search box.
    fireEvent.click(within(rows[1]!).getByRole('button', { name: 'Change' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Search' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: /Lantern Road \(Dramatised\)/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((within(rows[1]!).getByRole('checkbox') as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Import 2 items' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/libraryimport/import')).toBe(true));
    const body = api.calls.find((c) => c.path === '/api/v1/libraryimport/import')!.body;
    expect(body).toEqual({ scanId: 'scan-1', items: [{ candidateId: 'c1' }, { candidateId: 'c2', foreignId: 'B0OTHER001' }], mode: 'inPlace', qualityProfileId: 21 });
  });

  it('is offered on the audiobook index page', async () => {
    stubApi({ '/api/v1/settings/features': AB_FEATURES_ON, '/api/v1/qualityprofile': audiobookProfiles, '/api/v1/rootfolder': audiobookRoots, '/api/v1/tag': [], '/api/v1/author': [] });
    renderAt('/library/audiobooks');
    const links = await screen.findAllByRole('link', { name: 'Import existing' });
    expect(links[0]!.getAttribute('href')).toBe('/library/audiobooks/import');
  });
});
