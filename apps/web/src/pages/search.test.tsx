import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReleaseResource } from '@arclight/shared';
import { Table } from '../arclight/index.js';
import { releaseColumns } from './search.js';
import { releaseQuality, releaseScores } from './search-model.js';

const release = (over: Partial<ReleaseResource> = {}): ReleaseResource => ({
  guid: 'g1',
  title: 'Show.S01E01.1080p.WEB-DL-GRP',
  size: 1_500_000_000,
  publishDate: '2026-10-20T00:00:00Z',
  downloadUrl: 'https://indexer/dl/1.torrent',
  categories: [5040],
  indexerId: 1,
  indexerName: 'Idx',
  indexerPriority: 25,
  protocol: 'torrent',
  seeders: 12,
  leechers: 3,
  age: 5,
  ageHours: 120,
  ageMinutes: 7200,
  rejections: ['Quality WEB-DL 720p is below cutoff', 'Size 0.4 GB under minimum 1.2 GB'],
  approved: false,
  ...over,
});

function renderTable(rows: ReleaseResource[], onGrab = vi.fn()) {
  render(
    <Table
      caption="Search results"
      columns={releaseColumns({ categoryName: (c) => (c === 5040 ? 'TV/HD' : String(c)), onGrab, grabbing: () => false })}
      rows={rows}
      rowKey={(r) => `${r.indexerId}:${r.guid}`}
    />,
  );
  return onGrab;
}

describe('search release table', () => {
  it('shows a secondary sm Grab, a rejection tooltip, mono size/age/peers and the kit tags', () => {
    vi.useFakeTimers();
    try {
      const r = release({ customFormats: [{ id: 1, name: 'DV' }], customFormatScore: 150 } as Partial<ReleaseResource>);
      const onGrab = renderTable([r]);
      const row = screen.getByText(r.title).closest('tr')!;

      const grab = within(row).getByRole('button', { name: `Grab ${r.title}` });
      expect(grab.className).toContain('al-btn--secondary');
      expect(grab.className).toContain('al-btn--sm');
      fireEvent.click(grab);
      expect(onGrab).toHaveBeenCalledWith(r);

      // Size, age and peers render in mono cells.
      const size = within(row).getByText('1.4 GB');
      const age = within(row).getByText('5d');
      const peers = within(row).getByText('12 / 3');
      for (const el of [size, age, peers]) expect(el.closest('td')!.className).toContain('al-td--mono');

      expect(within(row).getByText('TOR').className).toContain('al-proto');
      expect(within(row).getByText('WEB-DL 1080p').className).toContain('al-quality');
      expect(within(row).getByText('DV +150').className).toContain('al-score');

      // Rejections live in a tooltip on an icon button.
      const rejected = within(row).getByRole('button', { name: `2 rejections for ${r.title}` });
      expect(screen.queryByRole('tooltip')).toBeNull();
      fireEvent.focus(rejected);
      const tip = screen.getByRole('tooltip');
      expect(tip.textContent).toContain('2 rejections');
      expect(tip.textContent).toContain('Size 0.4 GB under minimum 1.2 GB');
      expect(rejected.getAttribute('aria-describedby')).toBe(tip.id);

      // Download is an icon link with an aria-label and a tooltip.
      const link = within(row).getByRole('link', { name: `Download ${r.title}` });
      expect(link.getAttribute('href')).toBe(`/api/v1/indexer/1/download?url=${encodeURIComponent(r.downloadUrl)}`);
      fireEvent.mouseEnter(link.parentElement!);
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.getAllByRole('tooltip').some((t) => t.textContent === 'Download .torrent')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('omits the rejection button and score tags when there are none', () => {
    const r = release({ guid: 'g2', rejections: [], title: 'Plain.Release', protocol: 'usenet', grabs: 4, seeders: undefined, leechers: undefined });
    renderTable([r]);
    const row = screen.getByText('Plain.Release').closest('tr')!;
    expect(within(row).queryByRole('button', { name: /rejection/ })).toBeNull();
    expect(within(row).getByText('NZB')).toBeTruthy();
    expect(within(row).getByText('4 grabs')).toBeTruthy();
  });
});

describe('release display helpers', () => {
  it('reads a quality hint from the title and scores only when present', () => {
    expect(releaseQuality('Movie.2024.2160p.UHD.BluRay.REMUX')).toBe('Remux 2160p');
    expect(releaseQuality('Show.S01E01.720p.HDTV')).toBe('HDTV 720p');
    expect(releaseQuality('Some Random Name')).toBeNull();
    expect(releaseScores(release())).toEqual([]);
    expect(releaseScores({ customFormatScore: -10000, customFormats: [{ id: 2, name: 'x265 HD' }] })).toEqual([{ name: 'x265 HD', score: -10000 }]);
  });
});
