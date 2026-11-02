import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Wordmark } from './Wordmark.js';
import { MIN_CUT_PX, MIN_LINE_PX, WORDMARK_BOX, WORDMARK_LETTERS, sliceGeometry } from '../../../../../design/brand/wordmark.js';

describe('Wordmark (Light Slice)', () => {
  it('draws the letters from design/brand/intro/wordmark.svg', () => {
    const svg = readFileSync(resolve(process.cwd(), '../../design/brand/intro/wordmark.svg'), 'utf8');
    expect(svg.match(/<path d="([^"]+)"/)![1]).toBe(WORDMARK_LETTERS);
  });

  it('has an accessible name when labelled and is decorative otherwise', () => {
    const { container } = render(
      <>
        <Wordmark label="Arclight" />
        <Wordmark />
      </>,
    );
    expect(screen.getByRole('img', { name: 'Arclight' })).toBeTruthy();
    const marks = container.querySelectorAll('.al-wordmark');
    expect(marks).toHaveLength(2);
    expect(marks[1]!.getAttribute('aria-hidden')).toBe('true');
  });

  it('scales by height and keeps the aspect ratio', () => {
    const { container } = render(<Wordmark height={20} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('height')).toBe('20');
    expect(Number(svg.getAttribute('width'))).toBeCloseTo((20 * WORDMARK_BOX.width) / WORDMARK_BOX.height, 1);
  });

  it('gives every instance its own gradient, mask and filter ids', () => {
    const { container } = render(
      <>
        <Wordmark />
        <Wordmark />
      </>,
    );
    const ids = Array.from(container.querySelectorAll('[id]')).map((n) => n.id);
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
    for (const ref of container.querySelectorAll('path, rect[filter]')) {
      for (const attr of ['fill', 'mask', 'filter']) {
        const m = ref.getAttribute(attr)?.match(/^url\(#(.+)\)$/);
        if (m) expect(ids).toContain(m[1]);
      }
    }
  });

  it('takes its colours from the theme tokens, not fixed values', () => {
    const { container } = render(<Wordmark />);
    const stops = Array.from(container.querySelectorAll('stop')).map((s) => s.getAttribute('style') ?? '');
    expect(stops.slice(0, 2).join(' ')).toMatch(/var\(--al-wordmark-from\).*var\(--al-wordmark-to\)/);
    expect(stops.slice(2).every((s) => s.includes('var(--al-wordmark-line)'))).toBe(true);
    expect(container.innerHTML).not.toMatch(/#2f7bff|#6ef6ff/i);
  });
});

describe('sliceGeometry', () => {
  it('is the brand geometry when drawn large', () => {
    expect(sliceGeometry(120)).toEqual({ cutY: 55.5, cutHeight: 6, lineY: 57.75, lineHeight: 1.5 });
  });

  it('keeps the cut and the line visible at top-bar size, centred on the same y', () => {
    for (const h of [12, 16, 18]) {
      const g = sliceGeometry(h);
      const px = h / WORDMARK_BOX.height;
      expect(g.cutHeight * px).toBeGreaterThanOrEqual(MIN_CUT_PX - 0.01);
      expect(g.lineHeight * px).toBeGreaterThanOrEqual(MIN_LINE_PX - 0.01);
      expect(g.lineHeight).toBeLessThan(g.cutHeight);
      expect(g.cutY + g.cutHeight / 2).toBeCloseTo(58.5, 1);
      expect(g.lineY + g.lineHeight / 2).toBeCloseTo(58.5, 1);
    }
  });
});
