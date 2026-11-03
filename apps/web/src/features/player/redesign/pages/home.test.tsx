import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api, renderBrowse, stubFetch } from '../../browse/test-utils.js';
import { emptyHome } from '../../video/test-fixtures.js';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const me = { enabled: true, allowed: true, remote: false, canStream: true, maxBitrateKbps: 0, sections: { music: false, audiobooks: false, podcasts: false, books: false, video: true } };

describe('RdHomePage errors', () => {
  it('says why Movies & TV failed to load, not just that it did', async () => {
    stubFetch({
      [api('/me')]: me,
      // A fresh answer per call: the query retries and a body can only be read once.
      [api('/video/home')]: () => new Response(JSON.stringify({ error: 'Library database is locked', code: 'BUSY' }), { status: 503 }),
    });
    renderBrowse('/player/watch');
    const alert = await screen.findByRole('alert', {}, { timeout: 5000 });
    expect(alert.textContent).toContain("Couldn't load Movies & TV");
    expect(alert.textContent).toContain('Library database is locked');
  });

  it('retries and shows the page once the server answers', async () => {
    let fail = true;
    stubFetch({
      [api('/me')]: me,
      [api('/video/home')]: () => (fail ? new Response(JSON.stringify({ error: 'down', code: 'X' }), { status: 500 }) : emptyHome()),
    });
    renderBrowse('/player/watch');
    await screen.findByRole('alert', {}, { timeout: 5000 });
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: /retry|try again/i }));
    expect(await screen.findByText('Nothing to watch yet')).toBeTruthy();
  });
});
