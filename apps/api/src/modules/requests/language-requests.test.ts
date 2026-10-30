import { describe, expect, it } from 'vitest';
import { Permission as P, RequestsSettings } from '@arclight/shared';
import { setSection } from '../settings/service.js';
import { RequestsError } from './errors.js';
import { addUser } from './test-support.js';
import { MOVIE, SHOW, additionalRows, languageHarness } from './language-test-support.js';

type H = Awaited<ReturnType<typeof languageHarness>>;

function settings(h: H, patch: Partial<RequestsSettings>): void {
  setSection(h.db, 'requests', RequestsSettings.parse({ ...h.services.requests.settings(), ...patch }), new Date().toISOString());
}

/** Nothing auto-approves: language requests stay pending. */
function manualApproval(h: H): void {
  settings(h, { autoApproveSubtitleRequests: false, autoApproveAudioRequests: false });
}

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return err instanceof RequestsError ? err.code : String(err);
  }
}

describe('language requests: creation', () => {
  it('saves a pending request with the library snapshot, the normalised language and the note, and tells admins', async () => {
    const h = await languageHarness();
    manualApproval(h);
    const r = await h.service.create(h.user.actor, { kind: 'subtitle', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'spa', hi: 'only', note: '  for my parents  ' });
    expect(r).toMatchObject({
      status: 'pending',
      kind: 'subtitle',
      mediaType: 'movie',
      movieId: h.movieId,
      seriesId: null,
      seasonNumber: null,
      title: 'The Matrix',
      year: 1999,
      language: 'es',
      languageName: 'Spanish',
      forced: 'never',
      hi: 'only',
      mode: null,
      note: 'for my parents',
      canRemove: true,
      requestedBy: { id: h.user.id },
    });
    expect(h.fake.applied).toEqual([]);
    expect(h.fake.previewed[0]).toMatchObject({ kind: 'subtitle', targets: [{ movieId: h.movieId }], languages: [{ code: 'es', forced: 'never', hi: 'only' }] });
    const created = h.events.find((e) => e.type === 'requestCreated');
    expect(created).toMatchObject({ request: { status: 'pending' }, media: { title: 'The Matrix (Spanish subtitles)' } });
  });

  it('needs REQUEST_LANGUAGE, which REQUEST also grants', async () => {
    const h = await languageHarness();
    manualApproval(h);
    const none = addUser(h.db, { permissions: P.CREATE_ISSUES | P.REQUEST_MUSIC });
    const general = addUser(h.db, { permissions: P.REQUEST });
    expect(await code(h.service.create(none.actor, { kind: 'subtitle', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'es' }))).toBe('FORBIDDEN');
    expect((await h.service.create(general.actor, { kind: 'subtitle', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'es' })).status).toBe('pending');
  });

  it('validates the language, the title and the season', async () => {
    const h = await languageHarness();
    expect(await code(h.service.create(h.user.actor, { kind: 'subtitle', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'klingonese' }))).toBe('VALIDATION');
    expect(await code(h.service.create(h.user.actor, { kind: 'subtitle', mediaType: 'movie', tmdbId: 999, language: 'es' }))).toBe('VALIDATION');
    // Season 2 has no files.
    expect(await code(h.service.create(h.user.actor, { kind: 'audio', mediaType: 'series', tmdbId: SHOW.tmdbId, seasonNumber: 2, language: 'de' }))).toBe('VALIDATION');
    h.fake.planned = 'noFile';
    expect(await code(h.service.create(h.user.actor, { kind: 'audio', mediaType: 'series', tmdbId: SHOW.tmdbId, language: 'de' }))).toBe('VALIDATION');
  });

  it('refuses duplicates: an identical open request, one for the whole series, a saved additional language, or a language already present', async () => {
    const h = await languageHarness();
    manualApproval(h);
    const first = await h.service.create(h.user.actor, { kind: 'audio', mediaType: 'series', tmdbId: SHOW.tmdbId, language: 'de' });
    // The whole series covers its seasons; the same language as subtitles is a different request.
    await expect(h.service.create(h.admin.actor, { kind: 'audio', mediaType: 'series', tmdbId: SHOW.tmdbId, seasonNumber: 1, language: 'ger' })).rejects.toThrow(new RegExp(`#${first.id}`));
    expect((await h.service.create(h.user.actor, { kind: 'subtitle', mediaType: 'series', tmdbId: SHOW.tmdbId, seasonNumber: 1, language: 'de' })).status).toBe('pending');
    // A declined request no longer blocks.
    await h.service.decline(h.admin.actor, first.id);
    expect((await h.service.create(h.user.actor, { kind: 'audio', mediaType: 'series', tmdbId: SHOW.tmdbId, language: 'de' })).status).toBe('pending');

    h.fake.planned = 'alreadyPresent';
    await expect(h.service.create(h.user.actor, { kind: 'subtitle', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'fr' })).rejects.toThrow(/already has French subtitles/);
    h.fake.planned = 'willSearch';
    await h.fake.apply({ kind: 'subtitle', targets: [{ movieId: h.movieId }], languages: [{ code: 'en', forced: 'never', hi: 'also' }], searchNow: true, useWhisper: false });
    expect(await code(h.service.create(h.user.actor, { kind: 'subtitle', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'en' }))).toBe('CONFLICT');
  });
});

describe('language requests: auto-approval', () => {
  it('subtitle requests auto-approve by default and go straight to "Add additional…" for the season', async () => {
    const h = await languageHarness();
    const r = await h.service.create(h.user.actor, { kind: 'subtitle', mediaType: 'series', tmdbId: SHOW.tmdbId, seasonNumber: 1, language: 'pt-BR', forced: 'only' });
    expect(r.status).toBe('approved');
    await h.service.whenIdle();
    expect(h.fake.applied).toEqual([
      { kind: 'subtitle', targets: [{ seriesId: h.seriesId, seasonNumber: 1 }], languages: [{ code: 'pt-BR', forced: 'only', hi: 'also' }], searchNow: true, useWhisper: false },
    ]);
    const after = h.service.get(h.user.actor, r.id);
    expect(after).toMatchObject({ status: 'approved', outcome: 'searching', outcomeMessage: 'fake searching', additionalLanguageIds: [additionalRows(h.db)[0]!.id] });
  });

  it('audio requests wait for approval unless the setting or the requester says otherwise', async () => {
    const h = await languageHarness();
    expect((await h.service.create(h.user.actor, { kind: 'audio', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'de' })).status).toBe('pending');
    const trusted = addUser(h.db, { permissions: P.REQUEST | P.AUTO_APPROVE });
    expect((await h.service.create(trusted.actor, { kind: 'audio', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'fr' })).status).toBe('approved');
    const manager = addUser(h.db, { permissions: P.MANAGE_REQUESTS | P.REQUEST_LANGUAGE });
    expect((await h.service.create(manager.actor, { kind: 'audio', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'es' })).status).toBe('approved');
    settings(h, { autoApproveAudioRequests: true });
    expect((await h.service.create(h.user.actor, { kind: 'audio', mediaType: 'series', tmdbId: SHOW.tmdbId, language: 'de' })).status).toBe('approved');
    await h.service.whenIdle();
    expect(h.fake.applied.map((a) => (a.kind === 'audio' ? [a.language, a.mode] : null))).toEqual([
      ['fr', 'replace'],
      ['es', 'replace'],
      ['de', 'replace'],
    ]);
    settings(h, { autoApproveSubtitleRequests: false });
    expect((await h.service.create(h.user.actor, { kind: 'subtitle', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'de' })).status).toBe('pending');
  });
});

describe('language requests: approval and outcome', () => {
  it('only request managers approve or decline', async () => {
    const h = await languageHarness();
    manualApproval(h);
    const r = await h.service.create(h.user.actor, { kind: 'audio', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'de' });
    expect(await code(h.service.approve(h.user.actor, r.id))).toBe('FORBIDDEN');
    expect(await code(h.service.decline(h.user.actor, r.id))).toBe('FORBIDDEN');
  });

  it('approves audio in the chosen mode; a version slot completes the request and tells the requester', async () => {
    const h = await languageHarness();
    manualApproval(h);
    const sub = await h.service.create(h.user.actor, { kind: 'subtitle', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'de' });
    expect(await code(h.service.approve(h.admin.actor, sub.id, { mode: 'version' }))).toBe('VALIDATION');
    h.fake.outcome = 'versionAdded';
    const other = await h.service.create(h.user.actor, { kind: 'audio', mediaType: 'series', tmdbId: SHOW.tmdbId, seasonNumber: 1, language: 'fr' });
    const approved = await h.service.approve(h.admin.actor, other.id, { mode: 'version' });
    expect(h.fake.applied).toEqual([{ kind: 'audio', targets: [{ seriesId: h.seriesId, seasonNumber: 1 }], language: 'fr', mode: 'version', searchNow: true }]);
    expect(approved).toMatchObject({ status: 'completed', mode: 'version', outcome: 'versionAdded', modifiedBy: { id: h.admin.id } });
    expect(h.events.filter((e) => e.type === 'requestAvailable').at(-1)).toMatchObject({ media: { title: 'Thrones (French audio)' }, request: { seasons: [1] } });
  });

  it('stays approved while searching and completes once the saved language is found', async () => {
    const h = await languageHarness();
    manualApproval(h);
    const r = await h.service.create(h.user.actor, { kind: 'subtitle', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'fr' });
    const approved = await h.service.approve(h.admin.actor, r.id);
    expect(approved).toMatchObject({ status: 'approved', outcome: 'searching', mode: null });
    expect(h.events.some((e) => e.type === 'requestApproved')).toBe(true);
    h.fake.finish('notFound');
    expect(await h.service.syncStatuses()).toMatch(/1 language requests checked, 0 completed/);
    expect(h.service.get(h.user.actor, r.id)).toMatchObject({ status: 'approved', outcome: 'notFound' });
    h.fake.finish('found');
    await h.service.syncStatuses();
    expect(h.service.get(h.user.actor, r.id)).toMatchObject({ status: 'completed', outcome: 'found' });
  });

  it('completes when the item has the language after all (a scheduled search found it)', async () => {
    const h = await languageHarness();
    const r = await h.service.create(h.user.actor, { kind: 'subtitle', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'fr' });
    await h.service.whenIdle();
    h.fake.finish('notFound');
    h.fake.planned = 'alreadyPresent';
    h.service.itemUpdated('movie', h.movieId);
    await h.service.whenIdle();
    expect(h.service.get(h.user.actor, r.id)).toMatchObject({ status: 'completed', outcome: 'alreadyPresent' });
    expect(h.events.filter((e) => e.type === 'requestAvailable')).toHaveLength(1);
  });

  it('fails with the reason when "Add additional…" throws or reports failed/noFile; retry runs it again', async () => {
    const h = await languageHarness();
    manualApproval(h);
    const r = await h.service.create(h.user.actor, { kind: 'audio', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'de' });
    h.fake.error = new Error('indexers are down');
    expect(await h.service.approve(h.admin.actor, r.id)).toMatchObject({ status: 'failed', failureReason: 'indexers are down' });
    expect(await code(h.service.retry(h.user.actor, r.id))).toBe('FORBIDDEN');
    h.fake.error = null;
    h.fake.outcome = 'grabbed';
    expect(await h.service.retry(h.admin.actor, r.id)).toMatchObject({ status: 'completed', outcome: 'grabbed', failureReason: null });
    expect(await code(h.service.retry(h.admin.actor, r.id))).toBe('CONFLICT');

    const s = await h.service.create(h.user.actor, { kind: 'subtitle', mediaType: 'series', tmdbId: SHOW.tmdbId, language: 'fr' });
    h.fake.outcome = 'noFile';
    expect(await h.service.approve(h.admin.actor, s.id)).toMatchObject({ status: 'failed', failureReason: 'fake noFile', outcome: 'noFile' });
  });

  it('fails an approved request whose saved language was removed, and open requests of a deleted item', async () => {
    const h = await languageHarness();
    const r = await h.service.create(h.user.actor, { kind: 'subtitle', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'fr' });
    await h.service.whenIdle();
    h.db.delete((await import('../../db/schema.js')).additionalLanguages).run();
    await h.service.syncStatuses();
    expect(h.service.get(h.user.actor, r.id)).toMatchObject({ status: 'failed', failureReason: expect.stringMatching(/removed/) });

    manualApproval(h);
    const p = await h.service.create(h.user.actor, { kind: 'audio', mediaType: 'series', tmdbId: SHOW.tmdbId, language: 'de' });
    h.service.itemDeleted('series', h.seriesId);
    expect(h.service.get(h.user.actor, p.id)).toMatchObject({ status: 'failed', failureReason: 'The title was removed from the library' });
  });

  it('declines with a reason and tells the requester', async () => {
    const h = await languageHarness();
    manualApproval(h);
    const r = await h.service.create(h.user.actor, { kind: 'audio', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'de' });
    expect(await h.service.decline(h.admin.actor, r.id, 'no dub exists')).toMatchObject({ status: 'declined', declineReason: 'no dub exists', canRemove: true });
    expect(h.events.find((e) => e.type === 'requestDeclined')).toMatchObject({ reason: 'no dub exists', media: { title: 'The Matrix (German audio)' } });
    expect(await code(h.service.approve(h.admin.actor, r.id))).toBe('CONFLICT');
  });
});

describe('language requests: reading and deleting', () => {
  it('lists own requests unless the caller may view all; filters by kind, status and text', async () => {
    const h = await languageHarness();
    manualApproval(h);
    const viewer = addUser(h.db, { username: 'watcher', permissions: P.REQUEST_VIEW | P.REQUEST });
    await h.service.create(h.user.actor, { kind: 'audio', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'de', note: 'dubbed please' });
    await h.service.create(viewer.actor, { kind: 'subtitle', mediaType: 'series', tmdbId: SHOW.tmdbId, language: 'fr' });
    expect(h.service.list(h.user.actor, {}).results.map((r) => r.language)).toEqual(['de']);
    expect(h.service.list(viewer.actor, {}).pageInfo.total).toBe(2);
    expect(h.service.list(viewer.actor, { kind: 'subtitle' }).results.map((r) => r.title)).toEqual(['Thrones']);
    expect(h.service.list(viewer.actor, { q: 'dubbed' }).results.map((r) => r.kind)).toEqual(['audio']);
    expect(h.service.list(viewer.actor, { filter: 'approved' }).results).toEqual([]);
    expect(await code(Promise.resolve().then(() => h.service.list(h.user.actor, { requestedBy: viewer.id })))).toBe('FORBIDDEN');
    expect(h.service.count(h.admin.actor)).toEqual({ total: 2, subtitle: 1, audio: 1, pending: 2 });
    expect(await code(Promise.resolve().then(() => h.service.get(h.user.actor, h.service.list(viewer.actor, { kind: 'subtitle' }).results[0]!.id)))).toBe('FORBIDDEN');
  });

  it('options: library ids, seasons with files, item languages and open requests (mine flagged)', async () => {
    const h = await languageHarness();
    manualApproval(h);
    h.fake.chips = { audio: [{ language: 'en', present: true, added: false }], subtitles: [{ language: 'en:forced', present: true, added: false }] };
    const mine = await h.service.create(h.user.actor, { kind: 'subtitle', mediaType: 'series', tmdbId: SHOW.tmdbId, seasonNumber: 1, language: 'es' });
    const o = h.service.options(h.user.actor, { mediaType: 'series', tmdbId: SHOW.tmdbId });
    expect(o).toMatchObject({
      inLibrary: true,
      seriesId: h.seriesId,
      movieId: null,
      seasons: [{ seasonNumber: 1, files: 2 }],
      audio: [{ language: 'en', present: true }],
      subtitles: [{ language: 'en:forced' }],
      openRequests: [{ id: mine.id, kind: 'subtitle', seasonNumber: 1, language: 'es', mine: true }],
      canRequest: true,
    });
    expect(h.service.options(h.admin.actor, { mediaType: 'series', tmdbId: SHOW.tmdbId }).openRequests[0]!.mine).toBe(false);
    expect(h.service.options(h.user.actor, { mediaType: 'movie', tmdbId: 42 })).toMatchObject({ inLibrary: false, movieId: null, canRequest: true });
  });

  it('deletes own pending requests; managers delete any', async () => {
    const h = await languageHarness();
    manualApproval(h);
    const a = await h.service.create(h.user.actor, { kind: 'audio', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'de' });
    const b = await h.service.create(h.user.actor, { kind: 'audio', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'fr' });
    const someone = addUser(h.db, { permissions: P.REQUEST });
    expect(await code(Promise.resolve().then(() => h.service.remove(someone.actor, a.id)))).toBe('FORBIDDEN');
    h.service.remove(h.user.actor, a.id);
    await h.service.approve(h.admin.actor, b.id);
    expect(await code(Promise.resolve().then(() => h.service.remove(h.user.actor, b.id)))).toBe('FORBIDDEN');
    h.service.remove(h.admin.actor, b.id);
    expect(h.service.list(h.admin.actor, {}).results).toEqual([]);
  });

  it('language requests do not use the media quota', async () => {
    const h = await languageHarness();
    const limited = addUser(h.db, { permissions: P.REQUEST, settings: { quota: { movieLimit: 0, movieDays: 7, tvLimit: 0, tvDays: 7 } } });
    expect((await h.service.create(limited.actor, { kind: 'subtitle', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'de' })).status).toBe('approved');
    await h.service.whenIdle();
  });
});
