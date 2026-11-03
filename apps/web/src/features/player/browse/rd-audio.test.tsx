import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { albumDetails, api, bookDetails, mockPlayer, renderBrowse, stubFetch, track } from './test-utils.js';

// The title-page structure of the music and audiobook pages (features spec §5.1): the hero
// holds the backdrop, the cover, the title block, the primary action and the secondary
// actions; the track list follows it. Wide screens show icon buttons named by their label,
// phones put the label under the icon and stack the cover over the title.

const setViewport = (width: number, height: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
};

afterEach(() => {
  vi.unstubAllGlobals();
  setViewport(1024, 768);
});

describe('AudioDetail', () => {
  it('lays out the album title page on wide screens', async () => {
    setViewport(1280, 800);
    stubFetch({ [api('/music/albums/12')]: albumDetails(12, [track(1), track(2)], { title: 'Night Lines' }) });
    renderBrowse('/player/music/album/12', mockPlayer({ download: vi.fn(), downloadState: () => 'none' }));

    const title = await screen.findByRole('heading', { level: 1, name: 'Night Lines' });
    const page = title.closest('.rd-music-detail');
    expect(page?.classList.contains('rd-music-detail--wide')).toBe(true);
    const hero = title.closest('section')!;
    expect(hero.classList.contains('rd-music-detail__hero')).toBe(true);
    expect(hero.querySelector('.rd-music-detail__backdrop')).toBeTruthy();
    expect(hero.querySelector('.rd-music-detail__cover')).toBeTruthy();
    const buttons = hero.querySelector('.rd-detail__buttons')!;
    expect(within(buttons as HTMLElement).getByRole('button', { name: 'Play' }).className).toContain('rd-btn--primary');
    for (const name of ['Shuffle', 'Add to playlist', 'Download']) {
      const b = within(buttons as HTMLElement).getByRole('button', { name });
      expect(b.className).toContain('rd-btn--square');
      expect(b.getAttribute('title')).toBe(name);
    }
    // The tracks come after the hero, not inside it.
    expect(within(hero).queryByRole('list', { name: 'Tracks' })).toBeNull();
    expect(page?.querySelector('.rd-music-detail__content .pb-tracks')).toBeTruthy();
  });

  it('stacks the book title page on phones and labels the actions', async () => {
    setViewport(390, 844);
    stubFetch({ [api('/audiobooks/9')]: bookDetails(9, { title: 'Long Road' }), [api('/progress')]: { items: [] } });
    renderBrowse('/player/books/9', mockPlayer({ download: vi.fn(), downloadState: () => 'none' }));

    const title = await screen.findByRole('heading', { level: 1, name: 'Long Road' });
    expect(title.closest('.rd-music-detail')?.classList.contains('rd-music-detail--portrait')).toBe(true);
    const hero = title.closest('section')!;
    expect(within(hero).getByRole('button', { name: 'Play' }).className).toContain('rd-btn--block');
    const actions = hero.querySelector('.rd-music-detail__actions') as HTMLElement;
    expect(actions).toBeTruthy();
    expect(within(actions).getByRole('button', { name: 'Mark finished' }).className).toContain('rd-action');
    expect(within(actions).getByRole('button', { name: 'Download' }).textContent).toBe('Download');
  });
});
