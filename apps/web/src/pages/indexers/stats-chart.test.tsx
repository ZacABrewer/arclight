import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { IndexerStats } from '@arclight/shared';
import { IndexerStatsPage } from './stats-page.js';
import { areaPath, axisTicks } from './stats-model.js';

const byDay = [
  { date: '2026-10-24', queries: 20, grabs: 4, failures: 1 },
  { date: '2026-10-25', queries: 30, grabs: 6, failures: 0 },
];
const stats: IndexerStats = {
  days: 30,
  since: '2026-09-25T00:00:00.000Z',
  indexers: [
    { indexerId: 1, indexerName: 'YTS', queries: 40, grabs: 8, failures: 1, avgResponseMs: 320, byDay },
    { indexerId: 2, indexerName: 'Nyaa', queries: 10, grabs: 2, failures: 0, avgResponseMs: null, byDay },
  ],
  totals: { queries: 50, grabs: 10, failures: 1, avgResponseMs: 300, byDay },
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(stats), { status: 200 })),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <IndexerStatsPage />
    </QueryClientProvider>,
  );
}

/** Numeric opacity of an SVG attribute, defaulting to 1 when absent (an unset fill is opaque). */
const opacity = (el: Element, attr: string) => Number(el.getAttribute(attr) ?? '1');

describe('indexer stats charts', () => {
  it('draws hand-made SVG with 1px cyan strokes, fills at or under 12% and mono text-4 axes', async () => {
    renderPage();
    const bars = await screen.findByRole('img', { name: 'Queries per indexer' });
    const line = screen.getByRole('img', { name: 'Daily activity' });

    for (const svg of [bars, line]) {
      expect(svg.tagName.toLowerCase()).toBe('svg');
      // No glow filters, no rounded rects.
      expect(svg.querySelector('filter')).toBeNull();
      for (const rect of svg.querySelectorAll('rect')) {
        expect(rect.getAttribute('rx')).toBeNull();
        expect(rect.getAttribute('ry')).toBeNull();
      }
      // Every stroke is 1px.
      for (const el of svg.querySelectorAll('[stroke]')) {
        if (el.getAttribute('stroke') === 'none') continue;
        expect(el.getAttribute('stroke-width')).toBe('1');
      }
      // Any filled shape stays at or under 12% opacity.
      for (const el of svg.querySelectorAll('rect, path')) {
        const fill = el.getAttribute('fill');
        if (!fill || fill === 'none') continue;
        expect(opacity(el, 'fill-opacity')).toBeLessThanOrEqual(0.12);
      }
      // Axis labels: mono, text-4.
      const labels = [...svg.querySelectorAll('text')];
      expect(labels.length).toBeGreaterThan(0);
      for (const t of labels) {
        expect(t.getAttribute('font-family')).toBe('var(--al-mono)');
        expect(t.getAttribute('fill')).toBe('var(--al-text-4)');
      }
    }

    const barRects = bars.querySelectorAll('rect');
    expect(barRects).toHaveLength(2);
    for (const r of barRects) expect(r.getAttribute('stroke')).toBe('var(--al-cyan)');

    const series = line.querySelectorAll('path[data-metric]');
    expect(series).toHaveLength(3);
    expect(line.querySelector('path[data-metric="queries"]')!.getAttribute('stroke')).toBe('var(--al-cyan)');
    expect(line.querySelector('path[data-metric="grabs"]')!.getAttribute('stroke')).toBe('var(--al-cyan)');
  });

  it('shows totals in a key/value pane with mono values and the per-indexer table', async () => {
    renderPage();
    const totals = await screen.findByRole('region', { name: 'Totals' });
    const values = totals.querySelectorAll('.al-kv__value--mono');
    expect([...values].map((v) => v.textContent)).toEqual(['50', '10', '1 · 1.7%', '300 ms']);
    const table = screen.getByRole('table');
    expect(within(table).getByText('320 ms').closest('td')!.className).toContain('al-td--mono');
    expect(document.title).toBe('Indexer Stats · Arclight');
  });

  it('keeps the chart helpers pure', () => {
    expect(axisTicks(30)).toEqual([0, 8, 15, 23, 30]);
    expect(axisTicks(0)).toEqual([0, 1]);
    expect(areaPath('M0 10 L100 0', 100, 50, 2)).toBe('M0 10 L100 0 L100 50 L0 50 Z');
    expect(areaPath('', 100, 50, 0)).toBe('');
  });
});
