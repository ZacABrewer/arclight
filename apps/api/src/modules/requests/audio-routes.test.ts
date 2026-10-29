import { describe, expect, it } from 'vitest';
import { Permission as P, RequestsSettings } from '@arclight/shared';
import { setSection } from '../settings/service.js';
import { ARTIST, FakeAudioLibrary, OK_COMPUTER, PHM, fakeAudioSources, fixtureFetch, seedAudioLibrary } from './audio-test-support.js';
import { addUser, buildApp } from './test-support.js';

async function app() {
  const net = fixtureFetch();
  let library!: FakeAudioLibrary;
  const h = await buildApp({
    extra: {
      audioSources: fakeAudioSources(net.fetchImpl),
      audioLibrary: {
        addArtist: (req) => library.addArtist(req),
        refreshArtist: (id) => library.refreshArtist(id),
        addAuthor: (req) => library.addAuthor(req),
        addBook: (req) => library.addBook(req),
        search: (kind, ids) => library.search(kind, ids),
      },
    },
  });
  library = new FakeAudioLibrary(h.db);
  seedAudioLibrary(h.db);
  const admin = addUser(h.db, { role: 'admin', username: 'boss' });
  const user = addUser(h.db, { username: 'listener', permissions: P.REQUEST });
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, cookie?: string, payload?: unknown) =>
    h.app.inject({ method, url: `/api/v1${url}`, ...(cookie ? { headers: { cookie } } : {}), ...(payload === undefined ? {} : { payload: payload as object }) });
  return { ...h, net, library, admin, user, adminCookie: h.cookieFor(admin.id), userCookie: h.cookieFor(user.id), call };
}

describe('audio request routes', () => {
  it('need sign-in; discover is public only while the portal allows anonymous discover', async () => {
    const h = await app();
    expect((await h.call('GET', '/audiorequest')).statusCode).toBe(401);
    expect((await h.call('GET', '/discover/music')).statusCode).toBe(401);
    const settings = h.services.requests.settings();
    h.services.requests.updateSettings(h.admin.actor, RequestsSettings.parse({ ...settings, publicPortal: { ...settings.publicPortal, enabled: true, allowAnonymousDiscover: true } }));
    const home = await h.call('GET', '/discover/music');
    expect(home.statusCode).toBe(200);
    expect(home.json().sections[0].items[0]).toMatchObject({ foreignId: OK_COMPUTER, mediaStatus: 'unknown' });
    expect((await h.call('GET', '/discover/audiobooks?region=uk')).statusCode).toBe(200);
    expect((await h.call('POST', '/audiorequest', undefined, { kind: 'album', foreignId: OK_COMPUTER })).statusCode).toBe(401);
  });

  it('serves the catalogue to signed-in users and validates queries', async () => {
    const h = await app();
    const search = await h.call('GET', '/discover/music/search?query=radiohead', h.userCookie);
    expect(search.statusCode).toBe(200);
    expect(search.json().people[0]).toMatchObject({ kind: 'artist', foreignId: ARTIST });
    expect((await h.call('GET', '/discover/music/search', h.userCookie)).statusCode).toBe(400);
    expect((await h.call('GET', `/discover/music/album/${OK_COMPUTER}`, h.userCookie)).json()).toMatchObject({ artistName: 'Radiohead' });
    expect((await h.call('GET', `/discover/music/artist/${ARTIST}`, h.userCookie)).json().item).toMatchObject({ title: 'Radiohead' });
    expect((await h.call('GET', '/discover/music/album/f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b', h.userCookie)).statusCode).toBe(404);
    expect((await h.call('GET', `/discover/audiobooks/book/${PHM}`, h.userCookie)).json().item).toMatchObject({ title: 'Project Hail Mary' });
    expect((await h.call('GET', '/discover/audiobooks/search?query=project%20hail%20mary', h.userCookie)).json().titles[0]).toMatchObject({ foreignId: PHM });
    expect((await h.call('GET', '/discover/audiobooks?region=xx', h.userCookie)).statusCode).toBe(400);
  });

  it('answers 404 MUSIC_DISABLED / AUDIOBOOKS_DISABLED while the feature is off', async () => {
    const h = await app();
    setSection(h.db, 'features', { music: false, audiobooks: false });
    const music = await h.call('GET', '/discover/music', h.userCookie);
    expect(music.statusCode).toBe(404);
    expect(music.json().code).toBe('MUSIC_DISABLED');
    const create = await h.call('POST', '/audiorequest', h.userCookie, { kind: 'book', foreignId: PHM });
    expect(create.statusCode).toBe(404);
    expect(create.json().code).toBe('AUDIOBOOKS_DISABLED');
  });

  it('create, approve, decline, retry and delete over HTTP with the usual status codes', async () => {
    const h = await app();
    const created = await h.call('POST', '/audiorequest', h.userCookie, { kind: 'album', foreignId: OK_COMPUTER });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ status: 'pending', title: 'OK Computer', requestedBy: { username: 'listener' } });
    const id = created.json().id as number;
    expect((await h.call('POST', '/audiorequest', h.userCookie, { kind: 'album', foreignId: OK_COMPUTER })).statusCode).toBe(409);
    expect((await h.call('POST', '/audiorequest', h.userCookie, { kind: 'album', foreignId: 'x' })).statusCode).toBe(400);
    expect((await h.call('POST', '/audiorequest', h.userCookie, { kind: 'film', foreignId: OK_COMPUTER })).statusCode).toBe(400);

    expect((await h.call('POST', `/audiorequest/${id}/approve`, h.userCookie)).statusCode).toBe(403);
    const approved = await h.call('POST', `/audiorequest/${id}/approve`, h.adminCookie);
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe('approved');
    expect((await h.call('POST', `/audiorequest/${id}/retry`, h.adminCookie)).statusCode).toBe(409);

    const artist = (await h.call('POST', '/audiorequest', h.userCookie, { kind: 'artist', foreignId: ARTIST })).json();
    const declined = await h.call('POST', `/audiorequest/${artist.id}/decline`, h.adminCookie, { reason: 'later' });
    expect(declined.json()).toMatchObject({ status: 'declined', declineReason: 'later' });

    expect((await h.call('GET', `/audiorequest/${id}`, h.userCookie)).json()).toMatchObject({ id, kind: 'album' });
    expect((await h.call('GET', '/audiorequest?domain=music&filter=declined', h.userCookie)).json().pageInfo.total).toBe(1);
    expect((await h.call('GET', '/audiorequest/count', h.adminCookie)).json()).toEqual({ total: 2, music: 2, audiobook: 0, pending: 0 });
    expect((await h.call('DELETE', `/audiorequest/${id}`, h.userCookie)).statusCode).toBe(403);
    expect((await h.call('DELETE', `/audiorequest/${id}`, h.adminCookie)).statusCode).toBe(204);
    expect((await h.call('GET', `/audiorequest/${id}`, h.adminCookie)).statusCode).toBe(404);
  });

  it('settings: MANAGE_SETTINGS reads and writes the audioRequests section; bad values are 400', async () => {
    const h = await app();
    expect((await h.call('GET', '/settings/audiorequests', h.userCookie)).statusCode).toBe(403);
    expect((await h.call('GET', '/settings/audiorequests', h.adminCookie)).json()).toEqual({
      music: { rootFolderPath: null, qualityProfileId: null },
      audiobook: { rootFolderPath: null, qualityProfileId: null },
    });
    const bad = await h.call('PUT', '/settings/audiorequests', h.adminCookie, { music: { rootFolderPath: '/nowhere', qualityProfileId: null } });
    expect(bad.statusCode).toBe(400);
    const ok = await h.call('PUT', '/settings/audiorequests', h.adminCookie, { music: { rootFolderPath: '/media/music', qualityProfileId: null } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().music.rootFolderPath).toBe('/media/music');
  });
});
