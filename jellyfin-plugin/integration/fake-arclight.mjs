#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A tiny stand-in for Arclight's /api/v1/jellyfin/* API, used only by the integration test.
// It records every call (method, path, query, headers, body) and answers with canned data.
//
//   node integration/fake-arclight.mjs --port 18097 --key <api key> [--unlinked <id,...>] [--repo-dir <dir>]
//
// --repo-dir also serves <dir>/manifest.json and the zips in it under /__repo/ so Jellyfin can
// install the plugin through its normal repository flow.
//
// Test hooks (no auth): GET /__calls, DELETE /__calls, POST /__unlinked {"users":["<id>"]}
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const port = Number(args.port ?? 18097);
const apiKey = String(args.key ?? 'test-key');
let unlinked = new Set(String(args.unlinked ?? '').split(',').filter(Boolean).map(norm));
let calls = [];
const watchlist = new Map();

function norm(id) {
  return String(id).replace(/-/g, '').toLowerCase();
}

function send(res, status, body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://fake');
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = { __invalidJson: raw }; }

    if (url.pathname === '/__calls') {
      if (req.method === 'DELETE') { calls = []; return send(res, 204); }
      return send(res, 200, calls);
    }
    if (url.pathname.startsWith('/__repo/') && args['repo-dir']) {
      const file = join(String(args['repo-dir']), basename(url.pathname));
      if (!existsSync(file)) return send(res, 404, { code: 'not_found' });
      calls.push({ at: new Date().toISOString(), method: req.method, path: url.pathname, query: {}, headers: req.headers, body: null });
      res.writeHead(200, { 'content-type': file.endsWith('.json') ? 'application/json' : 'application/zip' });
      return res.end(readFileSync(file));
    }
    if (url.pathname === '/__unlinked' && req.method === 'POST') {
      unlinked = new Set((body?.users ?? []).map(norm));
      return send(res, 204);
    }

    const call = { at: new Date().toISOString(), method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body };
    calls.push(call);

    if (!url.pathname.startsWith('/api/v1/jellyfin/')) return send(res, 404, { code: 'not_found' });
    if (req.headers['x-api-key'] !== apiKey) return send(res, 401, { code: 'unauthorized' });
    const route = url.pathname.slice('/api/v1/jellyfin/'.length);
    const user = req.headers['x-arclight-jellyfin-user'];
    const perUser = !['ping', 'events', 'themes'].includes(route) && !route.startsWith('theme/') && !route.startsWith('theme-fonts/');
    if (perUser) {
      if (!user) return send(res, 400, { code: 'user_required' });
      if (unlinked.has(norm(user))) return send(res, 403, { code: 'not_linked' });
    }

    switch (`${req.method} ${route.split('/')[0]}`) {
      case 'GET discover': {
        const cat = url.searchParams.get('category');
        const mk = (i, mediaType, status = 'none') => ({ tmdbId: 9000 + i, mediaType, title: `${cat} ${i + 1}`, year: 2026, posterUrl: null, overview: 'Fake discover item.', status, canRequest: status === 'none', canRequest4k: false, requestBlockedReason: status === 'none' ? null : status === 'available' ? 'available' : 'requested' });
        const type = cat === 'popularSeries' || cat === 'upcomingSeries' ? 'series' : 'movie';
        return send(res, 200, { page: 1, totalPages: 1, totalResults: 8, results: Array.from({ length: 8 }, (_, i) => mk(i, cat === 'trending' && i % 2 ? 'series' : type, i === 1 ? 'available' : i === 2 ? 'requested' : 'none')) });
      }
      case 'GET upcoming':
        return send(res, 200, {
          days: Number(url.searchParams.get('days') ?? 30),
          items: [
            { date: new Date(Date.now() + 3 * 86400000).toISOString(), kind: 'episode', releaseType: null, mediaType: 'series', tmdbId: 1396, title: 'Breaking Bad', year: 2008, posterUrl: null, seasonNumber: 6, episodeNumber: 1, episodeTitle: 'Return', hasFile: false },
            { date: new Date(Date.now() + 10 * 86400000).toISOString(), kind: 'movie', releaseType: 'digital', mediaType: 'movie', tmdbId: 603, title: 'The Matrix', year: 1999, posterUrl: null, seasonNumber: null, episodeNumber: null, episodeTitle: null, hasFile: false },
          ],
        });
      case 'GET providers':
        return send(res, 200, {
          region: url.searchParams.get('region') ?? 'US',
          link: 'https://www.themoviedb.org/movie/550/watch',
          flatrate: [{ id: 8, name: 'Netflix', logoUrl: null }, { id: 337, name: 'Disney Plus', logoUrl: null }],
          rent: [{ id: 2, name: 'Apple TV', logoUrl: null }],
          buy: [],
          attribution: 'Data from JustWatch',
        });
      case 'GET requests':
        return send(res, 200, {
          total: 2,
          items: [
            { kind: 'media', id: 42, mediaType: 'movie', tmdbId: 603, title: 'The Matrix', year: 1999, posterUrl: null, status: 'pending', is4k: false, seasons: [], language: null, createdAt: '2026-10-30T10:00:00Z', progress: null, canCancel: true },
            { kind: 'language', id: 43, mediaType: 'movie', tmdbId: 550, title: 'Fight Club', year: 1999, posterUrl: null, status: 'approved', is4k: false, seasons: [], language: { kind: 'subtitle', language: 'Spanish' }, createdAt: '2026-10-29T10:00:00Z', progress: 0.3, canCancel: false },
          ],
        });
      case 'DELETE requests':
        return send(res, 204);
      case 'GET userconfig':
        return send(res, 200, { theme: 'fakepack', canRequestMovies: true, canRequestSeries: false, canRequest4k: false, canViewAllRequests: false });
      case 'GET themes':
        return send(res, 200, { defaultTheme: null, themes: [{ id: 'fakepack', name: 'Fake Pack', version: '1.0.0', dark: true }] });
      case 'GET theme':
        if (route !== 'theme/fakepack.css') return send(res, 404, { code: 'NOT_FOUND' });
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', etag: '"fake-1"' });
        return res.end(':root{--arclight-accent:#ff00aa}body{background-color:#200018!important}');
      case 'GET ping':
        return send(res, 200, { version: '9.9.9-fake', serverName: 'Fake Arclight', features: ['events', 'search', 'requests', 'watchlist'], linkedUsers: 1 });
      case 'POST events':
        if (!Array.isArray(body?.events) || body.events.length > 500) return send(res, 400, { code: 'invalid' });
        return send(res, 202, { accepted: body.events.length });
      case 'POST status':
        return send(res, 200, {
          items: (body?.items ?? []).map((i) => ({
            id: i.id,
            inLibrary: true,
            monitored: true,
            request: { id: 7, status: 'approved', requestedBy: 'Test Admin', requestedAt: '2026-10-30T10:00:00Z', is4k: false },
            download: { progress: 0.45, etaSeconds: 720, status: 'downloading' },
            upcoming: { releaseDate: '2027-03-18' },
            missingEpisodes: i.type === 'Series' ? 3 : undefined,
          })),
        });
      case 'GET search':
        return send(res, 200, {
          results: [
            { tmdbId: 603, mediaType: 'movie', title: 'The Matrix', year: 1999, posterUrl: null, overview: 'A hacker learns the truth.', status: 'none', canRequest: true, canRequest4k: true },
            { tmdbId: 1396, mediaType: 'series', title: 'Breaking Bad', year: 2008, posterUrl: null, overview: 'Chemistry.', status: 'partial', canRequest: true, canRequest4k: false },
            { tmdbId: 550, mediaType: 'movie', title: 'Fight Club', year: 1999, posterUrl: null, overview: 'In the library.', status: 'available', canRequest: false, canRequest4k: false, requestBlockedReason: 'available' },
            { tmdbId: 1399, mediaType: 'series', title: 'Game of Thrones', year: 2011, posterUrl: null, overview: 'Dragons.', status: 'none', canRequest: false, canRequest4k: false, requestBlockedReason: 'request_type' },
          ],
          page: Number(url.searchParams.get('page') ?? 1),
          totalPages: 1,
        });
      case 'GET title':
        return send(res, 200, {
          mediaType: route.split('/')[1],
          tmdbId: Number(route.split('/')[2]),
          seasons: [{ seasonNumber: 1, status: 'available' }, { seasonNumber: 2, status: 'none' }, { seasonNumber: 3, status: 'requested' }],
          canRequest4k: true,
          canRequestSubtitles: true,
          canRequestAudio: true,
          languages: [{ code: 'en', name: 'English' }, { code: 'es', name: 'Spanish' }],
        });
      case 'POST request':
        return send(res, 201, { id: 42, status: 'pending' });
      case 'POST language-request':
        return send(res, 201, { id: 43, status: 'pending' });
      case 'POST issue':
        return send(res, 201, { id: 44, status: 'open' });
      case 'GET watchlist':
        return send(res, 200, { items: [...(watchlist.get(norm(user)) ?? new Map()).values()] });
      case 'POST watchlist': {
        const list = watchlist.get(norm(user)) ?? new Map();
        list.set(`${body.mediaType}:${body.tmdbId}`, { mediaType: body.mediaType, tmdbId: body.tmdbId, title: 'x' });
        watchlist.set(norm(user), list);
        return send(res, 201, { ok: true });
      }
      case 'DELETE watchlist': {
        watchlist.get(norm(user))?.delete(`${url.searchParams.get('mediaType')}:${url.searchParams.get('tmdbId')}`);
        return send(res, 204);
      }
      default:
        return send(res, 404, { code: 'not_found' });
    }
  });
});

server.listen(port, '0.0.0.0', () => console.log(`fake Arclight listening on :${port}`));
