import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Wordmark } from './ui.js';
import { AboutScreen } from './screens.js';
import { WORDMARK_LETTERS } from '../../../../design/brand/wordmark.js';

describe('Wordmark (Light Slice)', () => {
  it('is an image named Arclight drawn from the shared letters', () => {
    const html = renderToStaticMarkup(<Wordmark height={24} />);
    expect(html).toMatch(/^<svg class="wordmark" role="img" aria-label="Arclight"/);
    expect(html).toContain(`d="${WORDMARK_LETTERS}"`);
    expect(html).toContain('height="24"');
  });

  it('takes its colours from the app tokens and gives each instance its own ids', () => {
    const html = renderToStaticMarkup(
      <>
        <Wordmark />
        <Wordmark />
      </>,
    );
    expect(html).toContain('var(--wordmark-from)');
    expect(html).toContain('var(--wordmark-line)');
    expect(html).not.toMatch(/#2f7bff|#6ef6ff/i);
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
  });

  it('replaces the ARCLIGHT text heading on the About screen', () => {
    const html = renderToStaticMarkup(<AboutScreen go={() => {}} />);
    expect(html).toMatch(/<h1><svg class="wordmark" role="img" aria-label="Arclight"/);
    expect(html).not.toContain('ARCLIGHT');
  });
});
