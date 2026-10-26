import { describe, expect, it } from 'vitest';
import { ContentRestrictions, Permission as P } from '@arclight/shared';
import { movieRating, restrictionReason, tvRating } from './certification.js';
import { addUser, buildApp, setup } from './test-support.js';

const caps = (over: { movie?: string | null; tv?: string | null; hideAdultContent?: boolean }): ContentRestrictions =>
  ContentRestrictions.parse({ maxCertification: { movie: over.movie ?? null, tv: over.tv ?? null }, hideAdultContent: over.hideAdultContent ?? false });

describe('certification rules', () => {
  it('normalizes ratings; unknown movie ratings count as NR and unknown TV ratings as unrated', () => {
    expect(movieRating(' pg-13 ')).toBe('PG-13');
    expect(movieRating('15')).toBe('NR');
    expect(movieRating(null)).toBe('NR');
    expect(tvRating('tv-ma')).toBe('TV-MA');
    expect(tvRating('TV-Y7')).toBe('TV-Y7');
    expect(tvRating('PG')).toBeNull();
  });

  it('a movie cap admits ratings up to it; unrated titles only under an NR cap', () => {
    const pg13 = caps({ movie: 'PG-13' });
    expect(restrictionReason(pg13, 'movie', 'PG')).toBeNull();
    expect(restrictionReason(pg13, 'movie', 'PG-13')).toBeNull();
    expect(restrictionReason(pg13, 'movie', 'R')).toMatch(/rated R, above .*PG-13/);
    expect(restrictionReason(pg13, 'movie', null)).toMatch(/unrated/);
    expect(restrictionReason(caps({ movie: 'NR' }), 'movie', null)).toBeNull();
    // A movie cap does not limit series.
    expect(restrictionReason(pg13, 'series', 'TV-MA')).toBeNull();
  });

  it('a TV cap admits guidelines up to it and refuses unrated series', () => {
    const tv14 = caps({ tv: 'TV-14' });
    expect(restrictionReason(tv14, 'series', 'TV-PG')).toBeNull();
    expect(restrictionReason(tv14, 'series', 'TV-MA')).toMatch(/TV-MA/);
    expect(restrictionReason(tv14, 'series', null)).toMatch(/unrated series/);
  });

  it('hideAdultContent hides NC-17 movies and TV-MA series only', () => {
    const adult = caps({ hideAdultContent: true });
    expect(restrictionReason(adult, 'movie', 'NC-17')).toMatch(/adult/);
    expect(restrictionReason(adult, 'movie', 'R')).toBeNull();
    expect(restrictionReason(adult, 'series', 'TV-MA')).toMatch(/adult/);
    expect(restrictionReason(adult, 'movie', null)).toBeNull();
  });
});

describe('certification guard', () => {
  it('caches the TMDB certification per title', async () => {
    const h = await setup();
    h.tmdb.addMovie({ tmdbId: 1, title: 'Kids Film', year: 2020, certification: 'G' });
    const guard = h.services.requests.certifications;
    expect(await guard.rating('movie', 1)).toBe('G');
    expect(await guard.rating('movie', 1)).toBe('G');
    expect(h.tmdb.calls.filter((c) => c === 'movie:1')).toHaveLength(1);
    // Lookups that fail count as unrated.
    expect(await guard.rating('movie', 404)).toBeNull();
  });
});

describe('content caps over HTTP', () => {
  async function app() {
    const h = await buildApp();
    h.tmdb
      .addMovie({ tmdbId: 1, title: 'Kids Film', year: 2020, certification: 'G' })
      .addMovie({ tmdbId: 2, title: 'Grown-up Film', year: 2021, certification: 'R' })
      .addMovie({ tmdbId: 3, title: 'Unrated Film', year: 2022 })
      .addSeries({ tmdbId: 10, title: 'Cartoon', year: 2019, seasons: [0, 3], certification: 'TV-Y' })
      .addSeries({ tmdbId: 11, title: 'Crime Drama', year: 2018, seasons: [0, 2], certification: 'TV-MA' });
    const admin = addUser(h.db, { role: 'admin' });
    const kid = addUser(h.db, { permissions: P.REQUEST });
    const adminCookie = h.cookieFor(admin.id);
    const kidCookie = h.cookieFor(kid.id);
    const put = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/user/${kid.id}/permissions`,
      headers: { cookie: adminCookie },
      payload: { permissions: P.REQUEST, contentRestrictions: { maxCertification: { movie: 'PG', tv: 'TV-Y7' } } },
    });
    expect(put.statusCode).toBe(200);
    return { ...h, admin, kid, adminCookie, kidCookie, put };
  }

  it('admins set caps on /user/:id/permissions; users cannot lift their own', async () => {
    const h = await app();
    expect(h.put.json()).toMatchObject({ contentRestrictions: { maxCertification: { movie: 'PG', tv: 'TV-Y7' }, hideAdultContent: false } });
    const read = await h.app.inject({ method: 'GET', url: `/api/v1/user/${h.kid.id}/permissions`, headers: { cookie: h.kidCookie } });
    expect(read.json().contentRestrictions.maxCertification.movie).toBe('PG');
    const lift = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/user/${h.kid.id}/permissions`,
      headers: { cookie: h.kidCookie },
      payload: { permissions: P.REQUEST, contentRestrictions: { maxCertification: { movie: null, tv: null } } },
    });
    expect(lift.statusCode).toBe(403);
    // Permission-only updates keep the caps.
    await h.app.inject({ method: 'PUT', url: `/api/v1/user/${h.kid.id}/permissions`, headers: { cookie: h.adminCookie }, payload: { permissions: P.REQUEST | P.CREATE_ISSUES } });
    const again = await h.app.inject({ method: 'GET', url: `/api/v1/user/${h.kid.id}/permissions`, headers: { cookie: h.adminCookie } });
    expect(again.json()).toMatchObject({ permissions: P.REQUEST | P.CREATE_ISSUES, contentRestrictions: { maxCertification: { movie: 'PG' } } });
  });

  it('discover hides titles above the cap for that user only', async () => {
    const h = await app();
    const kidMovies = await h.app.inject({ method: 'GET', url: '/api/v1/discover/movies', headers: { cookie: h.kidCookie } });
    expect(kidMovies.json().results.map((r: { tmdbId: number }) => r.tmdbId)).toEqual([1]);
    const kidTv = await h.app.inject({ method: 'GET', url: '/api/v1/discover/tv', headers: { cookie: h.kidCookie } });
    expect(kidTv.json().results.map((r: { tmdbId: number }) => r.tmdbId)).toEqual([10]);
    const adminMovies = await h.app.inject({ method: 'GET', url: '/api/v1/discover/movies', headers: { cookie: h.adminCookie } });
    expect(adminMovies.json().results).toHaveLength(3);
  });

  it('title pages above the cap answer 403 and their similar titles are filtered', async () => {
    const h = await app();
    const blocked = await h.app.inject({ method: 'GET', url: '/api/v1/discover/movie/2', headers: { cookie: h.kidCookie } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toMatch(/rated R/);
    const ok = await h.app.inject({ method: 'GET', url: '/api/v1/discover/movie/1', headers: { cookie: h.kidCookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().similar).toEqual([]);
    const person = await h.app.inject({ method: 'GET', url: '/api/v1/discover/person/5', headers: { cookie: h.kidCookie } });
    expect(person.json().cast.map((c: { tmdbId: number }) => c.tmdbId)).toEqual([1]);
  });

  it('requests above the cap are refused; allowed titles go through', async () => {
    const h = await app();
    const denied = await h.app.inject({ method: 'POST', url: '/api/v1/request', headers: { cookie: h.kidCookie }, payload: { mediaType: 'series', tmdbId: 11, seasons: 'all' } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toMatch(/TV-MA/);
    const unrated = await h.app.inject({ method: 'POST', url: '/api/v1/request', headers: { cookie: h.kidCookie }, payload: { mediaType: 'movie', tmdbId: 3 } });
    expect(unrated.statusCode).toBe(403);
    const allowed = await h.app.inject({ method: 'POST', url: '/api/v1/request', headers: { cookie: h.kidCookie }, payload: { mediaType: 'movie', tmdbId: 1 } });
    expect(allowed.statusCode).toBe(201);
    // An admin requesting on the kid's behalf is still held to the kid's caps.
    const onBehalf = await h.app.inject({ method: 'POST', url: '/api/v1/request', headers: { cookie: h.adminCookie }, payload: { mediaType: 'movie', tmdbId: 2, userId: h.kid.id } });
    expect(onBehalf.statusCode).toBe(403);
  });
});
