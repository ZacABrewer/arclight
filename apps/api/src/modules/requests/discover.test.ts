import { describe, expect, it } from 'vitest';
import { Permission as P, RequestsSettings } from '@media-tron/shared';
import { setSection } from '../settings/service.js';
import { RequestsError } from './errors.js';
import { addUser, giveMovieFile, giveSeasonFiles, setup } from './test-support.js';

async function harness() {
  const h = await setup();
  h.tmdb
    .addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 })
    .addMovie({ tmdbId: 604, title: 'Reloaded', year: 2003 })
    .addMovie({ tmdbId: 605, title: 'Revolutions', year: 2003 })
    .addSeries({ tmdbId: 1399, title: 'Thrones', year: 2011, seasons: [1, 2, 2] });
  const admin = addUser(h.db, { role: 'admin' });
  const user = addUser(h.db, { permissions: P.REQUEST | P.CREATE_ISSUES });
  return { ...h, admin, user };
}

describe('discover status enrichment', () => {
  it('annotates TMDB results with library availability and active requests', async () => {
    const h = await harness();
    await h.services.requests.create(h.admin.actor, { mediaType: 'movie', tmdbId: 603 }); // approved + in library
    giveMovieFile(h.db, 603);
    const pending = await h.services.requests.create(h.user.actor, { mediaType: 'movie', tmdbId: 604 });
    const page = await h.services.discover.movies({ page: 1 });
    const byId = Object.fromEntries(page.results.map((r) => [r.tmdbId, r]));
    expect(byId[603]).toMatchObject({ mediaStatus: 'available', mediaStatus4k: 'unknown' });
    expect(byId[603]!.libraryId).toBeGreaterThan(0);
    expect(byId[604]).toMatchObject({ mediaStatus: 'pending', requestStatus: 'pending', requestId: pending.kind === 'created' ? pending.request.id : -1 });
    expect(byId[605]).toMatchObject({ mediaStatus: 'unknown', requestId: null, posterUrl: 'https://img/605.jpg' });
  });

  it('hides available and requested titles when the settings say so', async () => {
    const h = await harness();
    await h.services.requests.create(h.admin.actor, { mediaType: 'movie', tmdbId: 603 });
    giveMovieFile(h.db, 603);
    await h.services.requests.create(h.user.actor, { mediaType: 'movie', tmdbId: 604 });
    setSection(h.db, 'requests', RequestsSettings.parse({ hideAvailable: true, hideRequested: true }));
    const page = await h.services.discover.movies({});
    expect(page.results.map((r) => r.tmdbId)).toEqual([605]);
  });

  it('falls back to popularity.desc for invalid sorts and fills both ends of a date range', async () => {
    const h = await harness();
    await h.services.discover.movies({ sortBy: 'nonsense', releaseDateGte: '2001-01-01' });
    const call = h.tmdb.calls.find((c) => c.startsWith('discover:movie'))!;
    const opts = JSON.parse(call.slice('discover:movie:'.length));
    expect(opts).toMatchObject({ sortBy: 'popularity.desc', releaseDateGte: '2001-01-01', releaseDateLte: '2999-12-31' });
  });

  it('builds a series title page with per-season status, requests and request flags', async () => {
    const h = await harness();
    const out = await h.services.requests.create(h.admin.actor, { mediaType: 'series', tmdbId: 1399, seasons: [1] });
    giveSeasonFiles(h.db, 1399, 1);
    await h.services.requests.create(h.user.actor, { mediaType: 'series', tmdbId: 1399, seasons: [2] });
    const detail = await h.services.discover.title(h.user.actor, 'series', 1399);
    const seasons = Object.fromEntries(detail.seasons.map((s) => [s.seasonNumber, s]));
    expect(seasons[1]).toMatchObject({ status: 'available' });
    expect(seasons[2]).toMatchObject({ status: 'pending', requestStatus: 'pending' });
    expect(detail.mediaStatus).toBe('partiallyAvailable');
    expect(detail.canRequest).toBe(false); // every regular season is covered
    expect(detail.canRequest4k).toBe(false);
    expect(detail.canRequestAdvanced).toBe(false);
    expect(detail.requests.map((r) => r.requestedBy.id)).toEqual([h.user.id]); // own only
    expect(detail.cast[0]).toMatchObject({ name: 'Lead Actor', character: 'Hero' });
    expect(detail.videos[0]!.url).toBe('https://www.youtube.com/watch?v=abc');
    expect(out.kind).toBe('created');
  });

  it('builds a movie title page with similar titles annotated and the watchlist flag', async () => {
    const h = await harness();
    await h.services.watchlist.add(h.user.actor, { mediaType: 'movie', tmdbId: 603 });
    await h.services.requests.create(h.user.actor, { mediaType: 'movie', tmdbId: 604 });
    const detail = await h.services.discover.title(h.user.actor, 'movie', 603);
    expect(detail).toMatchObject({ title: 'The Matrix', onWatchlist: true, canRequest: true, tagline: 'A tagline', openIssues: 0 });
    expect(detail.similar.find((s) => s.tmdbId === 604)?.mediaStatus).toBe('pending');
    await h.services.issues.create(h.user.actor, { type: 'video', mediaType: 'movie', tmdbId: 603, message: 'x' });
    expect((await h.services.discover.title(h.user.actor, 'movie', 603)).openIssues).toBe(1);
  });

  it('enriches person credits and names network pages', async () => {
    const h = await harness();
    await h.services.requests.create(h.user.actor, { mediaType: 'movie', tmdbId: 603 });
    const person = await h.services.discover.person(1);
    expect(person.cast.find((c) => c.tmdbId === 603)).toMatchObject({ character: 'Hero', mediaStatus: 'pending' });
    const network = await h.services.discover.network(213, 1);
    expect(network.title).toBe('Network 213');
  });
});

describe('discover sliders', () => {
  it('seeds the twelve built-ins, reorders, toggles, and resets', async () => {
    const h = await harness();
    const sliders = h.services.discover.sliders(h.admin.actor);
    expect(sliders.map((s) => s.type).slice(0, 3)).toEqual(['recentlyAdded', 'recentRequests', 'watchlist']);
    expect(sliders).toHaveLength(12);
    const reversed = [...sliders].reverse().map((s, i) => ({ id: s.id, enabled: i !== 0 }));
    const ordered = h.services.discover.orderSliders(h.admin.actor, reversed);
    expect(ordered[0]!.type).toBe('networks');
    expect(ordered[0]!.enabled).toBe(false);
    expect(h.services.discover.sliders(h.user.actor)).toHaveLength(11);
    expect(() => h.services.discover.orderSliders(h.user.actor, reversed)).toThrow(RequestsError);
    const reset = h.services.discover.resetSliders(h.admin.actor);
    expect(reset[0]!.type).toBe('recentlyAdded');
    expect(reset.every((s) => s.enabled)).toBe(true);
  });

  it('custom sliders resolve to TMDB pages; built-ins cannot be deleted', async () => {
    const h = await harness();
    const custom = h.services.discover.createSlider(h.admin.actor, { type: 'tmdbSearch', title: 'Matrix films', data: 'matrix' });
    const items = await h.services.discover.sliderItems(h.user.actor, custom.id);
    expect(items.title).toBe('Matrix films');
    expect(items.results.map((r) => r.tmdbId)).toEqual([603]);
    const builtIn = h.services.discover.sliders(h.admin.actor).find((s) => s.isBuiltIn)!;
    expect(() => h.services.discover.deleteSlider(h.admin.actor, builtIn.id)).toThrow(/built-in/);
    expect(() => h.services.discover.createSlider(h.admin.actor, { type: 'trending', title: 'x', data: 'y' })).toThrow(/built-in/);
    h.services.discover.deleteSlider(h.admin.actor, custom.id);
  });

  it('recently added needs RECENT_VIEW; list sliders answer a validation error', async () => {
    const h = await harness();
    await h.services.requests.create(h.admin.actor, { mediaType: 'movie', tmdbId: 603 });
    const sliders = h.services.discover.sliders(h.admin.actor);
    const recent = sliders.find((s) => s.type === 'recentlyAdded')!;
    await expect(h.services.discover.sliderItems(h.user.actor, recent.id)).rejects.toThrow(/recently added/);
    const viewer = addUser(h.db, { permissions: P.RECENT_VIEW });
    const items = await h.services.discover.sliderItems(viewer.actor, recent.id);
    expect(items.results.map((r) => r.tmdbId)).toEqual([603]);
    const genres = sliders.find((s) => s.type === 'movieGenres')!;
    await expect(h.services.discover.sliderItems(h.user.actor, genres.id)).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
