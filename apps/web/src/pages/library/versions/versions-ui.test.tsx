import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MediaFileVersion, QUALITIES, ReleaseDecision, type MediaVersion } from '@arclight/shared';
import { Table } from '../../../arclight/index.js';
import { ToastProvider } from '../../../components/toast.js';
import { createToastStore } from '../../../lib/toast.js';
import { createQueryClient } from '../../../query-client.js';
import { ReleaseTable } from '../interactive-search.js';
import { EpisodeVersionFiles, VersionPicker, VersionsEditor, WantedVersions, useVersionsDraft, versionColumn, type VersionsDraftState } from './versions-editor.js';

afterEach(() => vi.unstubAllGlobals());

const quality = { quality: { ...QUALITIES['WEBDL-1080p'], mediaTypes: [...QUALITIES['WEBDL-1080p'].mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } };
const profiles = [
  { id: 1, name: 'HD-1080p' },
  { id: 2, name: 'Ultra-HD' },
];

function EditorHarness({ initial, onState }: { initial: MediaVersion[] | null; onState: (s: VersionsDraftState) => void }) {
  const state = useVersionsDraft(initial);
  onState(state);
  return <VersionsEditor state={state} profiles={profiles} defaultProfileId={1} idPrefix="t" />;
}

describe('VersionsEditor', () => {
  it('adds rows with suggested tags, edits them and reports the patch', () => {
    let last: VersionsDraftState | undefined;
    render(<EditorHarness initial={null} onState={(s) => (last = s)} />);
    expect(screen.getByText(/Add versions to keep more than one copy/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add version' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add version' }));
    expect(screen.getAllByTestId('version-row')).toHaveLength(2);
    expect((screen.getByLabelText('Tag for version 1') as HTMLInputElement).value).toBe('Standard');
    expect((screen.getByLabelText('Tag for version 2') as HTMLInputElement).value).toBe('4K');
    fireEvent.change(screen.getByLabelText('Quality profile for version 2'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Version 2 wanted' }));
    expect(last?.valid).toBe(true);
    expect(last?.patch).toEqual({
      versions: [
        { tag: 'Standard', qualityProfileId: 1, enabled: true },
        { tag: '4K', qualityProfileId: 2, enabled: false },
      ],
    });
  });

  it('shows a row error for a duplicate tag and blocks the patch from being valid', () => {
    let last: VersionsDraftState | undefined;
    render(<EditorHarness initial={[{ tag: 'Standard', qualityProfileId: 1, enabled: true }, { tag: '4K', qualityProfileId: 2, enabled: true }]} onState={(s) => (last = s)} />);
    expect(last?.patch).toEqual({});
    fireEvent.change(screen.getByLabelText('Tag for version 2'), { target: { value: 'standard' } });
    expect(screen.getByRole('alert').textContent).toBe('Each tag must be unique');
    expect(last?.valid).toBe(false);
  });

  it('removing every version clears versions (null) and says so', () => {
    let last: VersionsDraftState | undefined;
    render(<EditorHarness initial={[{ tag: '4K', qualityProfileId: 2, enabled: true }]} onState={(s) => (last = s)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove version 1' }));
    expect(screen.queryAllByTestId('version-row')).toHaveLength(0);
    expect(last?.patch).toEqual({ versions: null });
    expect(screen.getByText(/goes back to one file per episode or movie/)).toBeTruthy();
  });

  it('stops at eight versions', () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ tag: `V${i}`, qualityProfileId: 1, enabled: true }));
    render(<EditorHarness initial={eight} onState={() => {}} />);
    expect((screen.getByRole('button', { name: 'Add version' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Up to 8 versions')).toBeTruthy();
  });
});

describe('version badges and columns', () => {
  it('adds a Version column only when some row has a tag', () => {
    const rows = [
      { id: 1, tag: '4K' as string | null },
      { id: 2, tag: null },
    ];
    expect(versionColumn(rows.map((r) => ({ ...r, tag: null })), (r) => r.tag, 'Version')).toHaveLength(0);
    const cols = versionColumn(rows, (r) => r.tag, 'Version');
    expect(cols).toHaveLength(1);
    render(<Table columns={cols} rows={rows} rowKey={(r) => r.id} caption="t" />);
    expect(screen.getByRole('columnheader', { name: /Version/ })).toBeTruthy();
    expect(screen.getAllByTestId('version-badge').map((b) => b.textContent)).toEqual(['4K']);
  });

  it('lists the wanted versions, or a dash for unversioned items', () => {
    const { rerender } = render(<WantedVersions tags={['4K', 'HDR']} />);
    expect(screen.getByRole('group', { name: 'Wanted versions: 4K, HDR' })).toBeTruthy();
    expect(screen.getAllByTestId('version-badge')).toHaveLength(2);
    rerender(<WantedVersions tags={[]} />);
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('lists every kept version of an episode in the drawer section', () => {
    const files = [
      MediaFileVersion.parse({ id: 1, versionTag: 'Standard', quality, sizeBytes: 1024 ** 3, relativePath: 'Season 01/E01.mkv' }),
      MediaFileVersion.parse({ id: 2, versionTag: '4K', quality, sizeBytes: 2 * 1024 ** 3, relativePath: 'Season 01/E01 - 4K.mkv' }),
    ];
    const { container, rerender } = render(<EpisodeVersionFiles files={files} />);
    const section = screen.getByRole('region', { name: 'Versions' });
    expect(within(section).getAllByTestId('version-badge').map((b) => b.textContent)).toEqual(['Standard', '4K']);
    expect(within(section).getByText('Season 01/E01 - 4K.mkv')).toBeTruthy();
    rerender(<EpisodeVersionFiles files={[{ ...files[0]!, versionTag: null }]} />);
    expect(container.textContent).toBe('');
  });

  it('version picker offers best fit plus the item tags', () => {
    const onChange = vi.fn();
    const { rerender } = render(<VersionPicker tags={['Standard', '4K']} value="" label="Version for a.mkv" onChange={onChange} />);
    const select = screen.getByLabelText('Version for a.mkv') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Best fit', 'Standard', '4K']);
    fireEvent.change(select, { target: { value: '4K' } });
    expect(onChange).toHaveBeenCalledWith('4K');
    rerender(<VersionPicker tags={[]} value="" label="Version for a.mkv" onChange={onChange} />);
    expect(screen.queryByLabelText('Version for a.mkv')).toBeNull();
  });
});

describe('interactive search', () => {
  it('shows the version slot each release was evaluated for', async () => {
    const base = {
      guid: 'g1',
      title: 'Dune.Part.Two.2024.2160p.WEB-DL',
      size: 20 * 1024 ** 3,
      publishDate: '2026-10-01T00:00:00.000Z',
      downloadUrl: 'http://x/1',
      categories: [2000],
      indexerId: 1,
      indexerName: 'Idx',
      indexerPriority: 25,
      protocol: 'torrent',
      age: 3,
      ageHours: 72,
      ageMinutes: 4320,
      rejections: [],
      approved: true,
      temporarilyRejected: false,
      downloadAllowed: true,
      source: 'interactiveSearch',
      movieId: 7,
      quality,
      languages: ['English'],
      customFormats: [],
      customFormatScore: 0,
      fullSeason: false,
    };
    const releases = [ReleaseDecision.parse({ ...base, versionTag: '4K' }), ReleaseDecision.parse({ ...base, guid: 'g2', title: 'Dune.Part.Two.2024.1080p', versionTag: 'Standard' })];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(releases), { status: 200, headers: { 'content-type': 'application/json' } })),
    );
    const toasts = createToastStore();
    render(
      <QueryClientProvider client={createQueryClient(toasts)}>
        <ToastProvider store={toasts}>
          <ReleaseTable target={{ movieId: 7 }} />
        </ToastProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getAllByTestId('version-badge')).toHaveLength(2));
    expect(screen.getByRole('columnheader', { name: /Version/ })).toBeTruthy();
    expect(screen.getAllByTestId('version-badge').map((b) => b.textContent).sort()).toEqual(['4K', 'Standard']);
  });
});
