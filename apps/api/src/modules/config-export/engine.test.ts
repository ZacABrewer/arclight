import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { SECRET_MASK } from '@arclight/shared';
import { createTestDb } from '../../db/test-utils.js';
import { downloadClients, indexers, qualityProfiles, rootFolders, tags } from '../../db/schema.js';
import { getSection, setSection } from '../settings/service.js';
import { buildDocument, diffValues, importDocument, planImport } from './engine.js';
import { isSecretKey, maskSecrets, resolveMasks } from './secrets.js';
import { seededDb } from './test-support.js';

type Doc = Record<string, Record<string, Record<string, unknown>>>;

const SECRETS = ['qbit-password', 'geek-api-key', 'tmdb-secret-key', 'proxy-pass', 'https://discord/hook/abc'];

describe('config export', () => {
  it('covers every settings section and resource collection, keyed by name', async () => {
    const doc = buildDocument(await seededDb()) as Doc;
    expect(doc['version']).toBe(1);
    expect(Object.keys(doc['settings']!)).toEqual(expect.arrayContaining(['metadata', 'mediaManagement', 'security', 'metrics', 'audit']));
    expect(Object.keys(doc['qualityProfiles']!)).toEqual(['HD-1080p']);
    expect(Object.keys(doc['customFormats']!)).toEqual(['x265']);
    expect(Object.keys(doc['downloadClients']!)).toEqual(['qBit']);
    expect(Object.keys(doc['indexers']!)).toEqual(['NZBgeek']);
    expect(Object.keys(doc['indexerProxies']!)).toEqual(['Flare']);
    expect(Object.keys(doc['releaseProfiles']!)).toEqual(['No CAM']);
    expect(Object.keys(doc['rootFolders']!)).toEqual(['/tv', '/movies']);
    expect(Object.keys(doc['notifications']!)).toEqual(['Discord']);
    expect(Object.keys(doc['importLists']!)).toEqual(['Popular']);
    expect(Object.keys(doc['languageProfiles']!)).toEqual(['English']);
    expect(doc['tags']).toEqual(['hd', 'anime']);
  });

  it('replaces ids with names in references', async () => {
    const doc = buildDocument(await seededDb()) as Doc;
    expect(doc['qualityProfiles']!['HD-1080p']!['formatItems']).toEqual([{ format: 'x265', score: 50 }]);
    expect(doc['indexers']!['NZBgeek']).toMatchObject({ downloadClient: 'qBit', proxy: 'Flare', tags: ['anime'] });
    expect(doc['releaseProfiles']!['No CAM']).toMatchObject({ indexer: 'NZBgeek', tags: ['hd'] });
    expect(doc['importLists']!['Popular']).toMatchObject({ qualityProfile: 'HD-1080p' });
    const { settings: _settings, ...resources } = doc;
    expect(JSON.stringify(resources)).not.toMatch(/"(formatId|downloadClientId|proxyId|qualityProfileId|indexerId)"/);
  });

  it('keys delay profiles by tag set and remote path mappings by host:path', async () => {
    const doc = buildDocument(await seededDb()) as Doc;
    expect(Object.keys(doc['delayProfiles']!)).toEqual(['anime', 'default']);
    expect(Object.keys(doc['remotePathMappings']!)).toEqual(['qbit:/downloads/']);
  });

  it('masks secrets by default', async () => {
    const text = JSON.stringify(buildDocument(await seededDb()));
    for (const s of SECRETS) expect(text).not.toContain(s);
    const doc = buildDocument(await seededDb()) as Doc;
    expect((doc['downloadClients']!['qBit']!['settings'] as Record<string, unknown>)['password']).toBe(SECRET_MASK);
    expect((doc['downloadClients']!['qBit']!['settings'] as Record<string, unknown>)['username']).toBe('admin');
  });

  it('exports secrets in clear only when asked', async () => {
    const text = JSON.stringify(buildDocument(await seededDb(), { includeSecrets: true }));
    for (const s of SECRETS) expect(text).toContain(s);
  });

  it('leaves install state (setup flags) out of the security section', async () => {
    const doc = buildDocument(await seededDb()) as Doc;
    expect(doc['settings']!['security']).not.toHaveProperty('setupComplete');
  });
});

describe('config import round trip', () => {
  it('re-importing a masked export into the same database changes nothing', async () => {
    const db = await seededDb();
    const out = importDocument(db, buildDocument(db));
    expect(out.errors).toEqual([]);
    expect(out.changes).toEqual([]);
    expect(out.summary.create + out.summary.update + out.summary.delete).toBe(0);
    expect(out.summary.unchanged).toBeGreaterThan(10);
  });

  it('export -> import into a fresh database -> export is identical, and idempotent', async () => {
    const source = await seededDb();
    const doc = buildDocument(source, { includeSecrets: true });
    const target = await createTestDb();
    const first = importDocument(target, doc);
    expect(first.errors).toEqual([]);
    expect(first.applied).toBe(true);
    expect(buildDocument(target, { includeSecrets: true })).toEqual(doc);
    const second = importDocument(target, buildDocument(target, { includeSecrets: true }));
    expect(second.changes).toEqual([]);
  });

  it('a masked secret keeps the stored value on update', async () => {
    const db = await seededDb();
    const doc = buildDocument(db) as Doc;
    (doc['downloadClients']!['qBit']!['settings'] as Record<string, unknown>)['port'] = 9090;
    const out = importDocument(db, doc);
    expect(out.errors).toEqual([]);
    const row = db.select().from(downloadClients).where(eq(downloadClients.name, 'qBit')).get()!;
    expect(row.settings).toMatchObject({ port: 9090, password: 'qbit-password' });
    expect(getSection(db, 'metadata').tmdbApiKey).toBe('tmdb-secret-key');
  });

  it('a masked secret with nothing stored is left unset with a warning', async () => {
    const doc = buildDocument(await seededDb());
    const target = await createTestDb();
    const out = importDocument(target, doc);
    expect(out.errors).toEqual([]);
    expect(out.warnings.map((w) => w.path)).toContain('downloadClients.qBit.settings.password');
    const row = target.select().from(downloadClients).get()!;
    expect(row.settings).not.toHaveProperty('password');
    expect(row.settings).toMatchObject({ username: 'admin' });
  });

  it('resolves references by name on a fresh database (ids differ)', async () => {
    const target = await createTestDb();
    target.insert(tags).values({ label: 'unrelated' }).run();
    importDocument(target, buildDocument(await seededDb(), { includeSecrets: true }));
    const ix = target.select().from(indexers).get()!;
    const dc = target.select().from(downloadClients).get()!;
    expect(ix.downloadClientId).toBe(dc.id);
    const anime = target.select().from(tags).where(eq(tags.label, 'anime')).get()!;
    expect(ix.tags).toEqual([anime.id]);
  });
});

describe('config import planning', () => {
  it('dry run reports the diff and writes nothing', async () => {
    const db = await seededDb();
    const out = importDocument(
      db,
      { downloadClients: { qBit: { implementation: 'qbittorrent', protocol: 'torrent', priority: 5, settings: { host: 'qbit', port: 8080 } } }, rootFolders: { '/anime': { mediaType: 'series' } } },
      { dryRun: true },
    );
    expect(out.applied).toBe(false);
    expect(out.dryRun).toBe(true);
    expect(out.changes).toContainEqual({ kind: 'rootFolders', key: '/anime', op: 'create' });
    const update = out.changes.find((c) => c.kind === 'downloadClients')!;
    expect(update.op).toBe('update');
    expect(update.fields?.map((f) => f.path)).toEqual(expect.arrayContaining(['priority', 'tags', 'settings.password', 'settings.username']));
    expect(db.select().from(rootFolders).all()).toHaveLength(2);
    expect(db.select().from(downloadClients).get()!.priority).toBe(1);
  });

  it('masks secrets in diff values', async () => {
    const db = await seededDb();
    const doc = buildDocument(db) as Doc;
    (doc['downloadClients']!['qBit']!['settings'] as Record<string, unknown>)['password'] = 'new-password';
    const out = importDocument(db, doc, { dryRun: true });
    const field = out.changes[0]!.fields!.find((f) => f.path === 'settings.password')!;
    expect(field).toEqual({ path: 'settings.password', before: SECRET_MASK, after: SECRET_MASK });
  });

  it('upserts by name: updates the existing row instead of adding one', async () => {
    const db = await seededDb();
    const out = importDocument(db, { rootFolders: { '/tv': { mediaType: 'movie' } } });
    expect(out.changes).toEqual([{ kind: 'rootFolders', key: '/tv', op: 'update', fields: [{ path: 'mediaType', before: 'series', after: 'movie' }] }]);
    expect(db.select().from(rootFolders).all()).toHaveLength(2);
  });

  it('never deletes without prune', async () => {
    const db = await seededDb();
    const out = importDocument(db, { rootFolders: { '/tv': { mediaType: 'series' } } });
    expect(out.summary.delete).toBe(0);
    expect(db.select().from(rootFolders).all()).toHaveLength(2);
  });

  it('prune deletes what a present collection does not list, and only there', async () => {
    const db = await seededDb();
    const out = importDocument(db, { prune: true, rootFolders: { '/tv': { mediaType: 'series' } } });
    expect(out.changes).toEqual([{ kind: 'rootFolders', key: '/movies', op: 'delete' }]);
    expect(db.select().from(rootFolders).all().map((r) => r.path)).toEqual(['/tv']);
    expect(db.select().from(indexers).all()).toHaveLength(1);
  });

  it('the prune option overrides the document flag', async () => {
    const db = await seededDb();
    const out = importDocument(db, { prune: true, rootFolders: {} }, { prune: false });
    expect(out.summary.delete).toBe(0);
  });

  it('refuses to prune a resource that a kept entry still references', async () => {
    const db = await seededDb();
    const doc = buildDocument(db) as Doc;
    const out = importDocument(db, { prune: true, indexers: doc['indexers'], downloadClients: {} });
    expect(out.applied).toBe(false);
    expect(out.errors[0]!.message).toMatch(/would be pruned but is still referenced/);
    expect(db.select().from(downloadClients).all()).toHaveLength(1);
  });

  it('reports unknown references and applies nothing', async () => {
    const db = await seededDb();
    const doc = buildDocument(db) as Doc;
    const entry = { ...doc['importLists']!['Popular']!, qualityProfile: 'Nope' };
    const out = importDocument(db, { rootFolders: { '/new': { mediaType: 'movie' } }, importLists: { Popular: entry } });
    expect(out.applied).toBe(false);
    expect(out.errors).toEqual([{ path: 'importLists.Popular.qualityProfile', message: 'unknown qualityProfiles "Nope"' }]);
    expect(db.select().from(rootFolders).all()).toHaveLength(2);
  });

  it('accepts references to resources defined in the same document', async () => {
    const db = await createTestDb();
    const out = importDocument(db, {
      downloadClients: { SAB: { implementation: 'sabnzbd', protocol: 'usenet', settings: { host: 'sab' } } },
      indexers: {
        Geek: { implementation: 'newznab', downloadClient: 'SAB', settings: { baseUrl: 'https://x', apiPath: '/api', categories: [], animeCategories: [] } },
      },
    });
    expect(out.errors).toEqual([]);
    expect(db.select().from(indexers).get()!.downloadClientId).toBe(db.select().from(downloadClients).get()!.id);
  });

  it('creates tags that entries reference', async () => {
    const db = await createTestDb();
    const out = importDocument(db, { tags: ['a'], rootFolders: {}, delayProfiles: { b: { order: 1, tags: ['b'] } } });
    expect(out.changes.filter((c) => c.kind === 'tags').map((c) => c.key).sort()).toEqual(['a', 'b']);
    expect(db.select().from(tags).all().map((t) => t.label).sort()).toEqual(['a', 'b']);
  });

  it('reports invalid entries with their path', async () => {
    const db = await createTestDb();
    const out = importDocument(db, { rootFolders: { '/x': { mediaType: 'music' } }, downloadClients: { Y: { protocol: 'torrent' } } });
    expect(out.applied).toBe(false);
    expect(out.errors.map((e) => e.path)).toEqual(['downloadClients.Y.implementation', 'rootFolders./x.mediaType']);
  });

  it('rejects duplicate keys that resolve to the same identity', async () => {
    const db = await createTestDb();
    const out = importDocument(db, {
      remotePathMappings: {
        a: { host: 'h', remotePath: '/r/', localPath: '/l1/' },
        b: { host: 'h', remotePath: '/r/', localPath: '/l2/' },
      },
    });
    expect(out.errors[0]!.message).toMatch(/duplicate key "h:\/r\/"/);
  });

  it('rejects an unsupported version', async () => {
    const out = importDocument(await createTestDb(), { version: 2 });
    expect(out.applied).toBe(false);
    expect(out.errors[0]!.path).toBe('version');
  });

  it('warns about unknown top-level keys', async () => {
    const out = importDocument(await createTestDb(), { sonarr: {} }, { dryRun: true });
    expect(out.warnings).toContainEqual({ path: 'sonarr', message: 'unknown top-level key ignored' });
  });
});

describe('config import: settings', () => {
  it('merges the keys a document gives onto the stored section', async () => {
    const db = await seededDb();
    const out = importDocument(db, { settings: { metadata: { region: 'GB' } } });
    expect(out.changes).toEqual([{ kind: 'settings', key: 'metadata', op: 'update', fields: [{ path: 'region', before: 'US', after: 'GB' }] }]);
    expect(getSection(db, 'metadata')).toMatchObject({ region: 'GB', language: 'en-US', tmdbApiKey: 'tmdb-secret-key' });
    expect(out.changedSections).toEqual(['metadata']);
  });

  it('rejects an unknown section and an invalid value', async () => {
    const db = await seededDb();
    const out = importDocument(db, { settings: { nope: { a: 1 }, metadata: { region: 'GBR' } } });
    expect(out.applied).toBe(false);
    expect(out.errors.map((e) => e.path)).toEqual(['settings.nope', 'settings.metadata']);
    expect(getSection(db, 'metadata').region).toBe('US');
  });

  it('warns about unknown keys inside a section', async () => {
    const out = importDocument(await seededDb(), { settings: { metrics: { allowAnonymous: true, colour: 'red' } } });
    expect(out.errors).toEqual([]);
    expect(out.warnings).toContainEqual({ path: 'settings.metrics.colour', message: 'unknown settings key ignored' });
    expect(out.managed.settings['metrics']).toEqual(['allowAnonymous']);
  });

  it('carries ids inside settings as names, resolved again on import', async () => {
    const source = await seededDb();
    const requests = getSection(source, 'requests');
    const qp = source.select().from(qualityProfiles).get()!;
    const anime = source.select().from(tags).where(eq(tags.label, 'anime')).get()!;
    setSection(source, 'requests', { ...requests, movie: { ...requests.movie, qualityProfileId: qp.id, tags: [anime.id] } });
    const doc = buildDocument(source, { includeSecrets: true }) as Doc;
    expect(doc['settings']!['requests']!['movie']).toMatchObject({ qualityProfileId: 'HD-1080p', tags: ['anime'] });

    const target = await createTestDb();
    target.insert(qualityProfiles).values({ name: 'Other', cutoff: 1, items: [{ kind: 'quality', qualityId: 1, allowed: true }], formatItems: [], languages: [] }).run();
    const out = importDocument(target, doc);
    expect(out.errors).toEqual([]);
    const imported = target.select().from(qualityProfiles).where(eq(qualityProfiles.name, 'HD-1080p')).get()!;
    expect(imported.id).not.toBe(qp.id);
    expect(getSection(target, 'requests').movie).toMatchObject({ qualityProfileId: imported.id });
  });

  it('reports unknown names inside settings', async () => {
    const out = importDocument(await createTestDb(), { settings: { subtitles: { defaultMovieProfileId: 'Nope' } } });
    expect(out.errors).toContainEqual({ path: 'settings.subtitles.defaultMovieProfileId', message: 'unknown languageProfiles "Nope"' });
  });

  it('plans without touching the database', async () => {
    const db = await seededDb();
    const { outcome } = planImport(db, { settings: { audit: { retentionDays: 7 } } });
    expect(outcome.summary.update).toBe(1);
    expect(getSection(db, 'audit').retentionDays).toBe(90);
  });
});

describe('secret helpers', () => {
  it('recognises secret key names', () => {
    for (const k of ['password', 'apiKey', 'tmdbApiKey', 'token', 'botToken', 'cookie', 'privateKey', 'webhookUrl', 'clientSecret', 'key']) {
      expect(isSecretKey(k), k).toBe(true);
    }
    for (const k of ['username', 'host', 'sortKey', 'tokenExpiresAt', 'publicKey', 'keywords']) expect(isSecretKey(k), k).toBe(false);
  });

  it('masks nested secrets and resolves them back', () => {
    const stored = { a: { password: 'p', list: [{ token: 't' }] }, b: 1 };
    const masked = maskSecrets(stored);
    expect(masked).toEqual({ a: { password: SECRET_MASK, list: [{ token: SECRET_MASK }] }, b: 1 });
    const missing: string[] = [];
    expect(resolveMasks(masked, stored, (p) => missing.push(p))).toEqual(stored);
    expect(missing).toEqual([]);
  });

  it('diffs leaves with paths', () => {
    expect(diffValues({ a: { b: 1, c: [1] } }, { a: { b: 2, c: [1] }, d: true })).toEqual([
      { path: 'a.b', before: 1, after: 2 },
      { path: 'd', before: null, after: true },
    ]);
  });
});
