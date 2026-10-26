import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NotificationEvent } from '@arclight/notifications';
import { QualityProfileInput, type HistoryPage, type QueuePage, type ReleaseResource } from '@arclight/shared';
import { authServiceFor } from './modules/auth/index.js';
import { buildApp, type AppContext } from './app.js';
import type { AppConfig } from './config.js';
import type { Db } from './db/index.js';
import { mediaFiles } from './db/schema.js';
import { createTestDb } from './db/test-utils.js';
import { FakeDownloadClient, item, qbit } from './modules/download-clients/test-support.js';
import { getDownloadClientsService } from './modules/download-clients/index.js';
import { indexersServiceFor } from './modules/indexers/index.js';
import type { MetadataLookup } from './modules/library/index.js';
import { notificationsServiceFor } from './modules/notifications/index.js';
import { HD_ALLOWED, makeIndexer, makeProfile, makeRelease } from './modules/releases/test-support.js';

// End-to-end pipeline through the real modules and wiring: search -> decide -> grab -> queue
// -> completed -> import -> history + notifications. Only the edges are fake: the indexer
// search results, the download client, and the metadata lookup.

const HASH = '0123456789abcdef0123456789abcdef01234567';
const TITLE = 'Show.Name.S01E01.1080p.WEB-DL.DDP5.1.H.264-GRP';

let tmp: string;
let db: Db;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mt-pipeline-'));
  db = await createTestDb();
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const metadata: MetadataLookup = {
  series: async (tmdbId) => ({
    tmdbId,
    title: 'Show Name',
    year: 2020,
    status: 'continuing',
    runtimeMinutes: 45,
    originalLanguage: 'en',
    seasons: [{ seasonNumber: 1 }],
    episodes: [1, 2].map((n) => ({
      seasonNumber: 1,
      episodeNumber: n,
      title: `Episode ${n}`,
      airDate: `2020-01-0${n}`,
      airDateUtc: `2020-01-0${n}T20:00:00Z`,
    })),
  }),
  movie: async () => null,
};

describe('phase 1 pipeline', () => {
  it('searches, grabs, tracks, imports and records a release end to end', async () => {
    const tvRoot = join(tmp, 'tv');
    const downloads = join(tmp, 'downloads');
    await mkdir(tvRoot, { recursive: true });
    await writeFile(join(tvRoot, '.keep'), '');

    const fakes: FakeDownloadClient[] = [];
    const dispatched: NotificationEvent[] = [];
    let ctxRef: AppContext | undefined;

    const release: ReleaseResource = makeRelease(TITLE, {
      guid: 'guid-1',
      downloadUrl: `magnet:?xt=urn:btih:${HASH}`,
      infoHash: HASH,
      publishDate: new Date(Date.now() - 60 * 60_000).toISOString(),
    });

    const config: AppConfig = {
      configDir: tmp,
      dbPath: ':memory:',
      logDir: tmp,
      port: 0,
      host: '127.0.0.1',
      logLevel: 'silent',
      isDocker: false,
      webDist: null,
    };
    const app = await buildApp(config, db, pino({ level: 'silent' }), {
      metadata,
      probe: false,
      onContext: (ctx) => {
        ctxRef = ctx;
        getDownloadClientsService(ctx, {
          directoryExists: async () => true,
          clientFactory: (cfg) => {
            const existing = fakes.find((f) => f.config.id === cfg.id);
            const fake = new FakeDownloadClient(cfg);
            fake.nextId = HASH;
            if (existing) {
              fake.items = existing.items;
              fake.added = existing.added;
            }
            if (cfg.id !== 0) fakes.push(fake);
            return fake;
          },
        });
        const indexers = indexersServiceFor(ctx);
        indexers.list = () => [makeIndexer()];
        indexers.search = async () => [release];
        const notifications = notificationsServiceFor(ctx);
        const dispatch = notifications.dispatch.bind(notifications);
        notifications.dispatch = async (event) => {
          dispatched.push(event);
          return dispatch(event);
        };
      },
    });
    await app.ready();
    try {
      const ctx = ctxRef!;
      const api = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
        app.inject({
          method,
          url: `/api/v1${url}`,
          headers: { 'x-api-key': authServiceFor(ctx).apiKey() },
          ...(payload === undefined ? {} : { payload: payload as object }),
        });

      // Library setup: root folder, quality profile, series (metadata injected).
      expect((await api('POST', '/rootfolder', { path: tvRoot, mediaType: 'series' })).statusCode).toBe(201);
      const { id: _id, ...draft } = makeProfile(HD_ALLOWED);
      const profileRes = await api('POST', '/qualityprofile', QualityProfileInput.parse({ ...draft, name: 'Pipeline HD' }));
      expect(profileRes.statusCode).toBe(201);
      const profileId = profileRes.json<{ id: number }>().id;
      const seriesRes = await api('POST', '/series', { tmdbId: 4242, rootFolderPath: tvRoot, qualityProfileId: profileId });
      expect(seriesRes.statusCode).toBe(201);
      const seriesId = seriesRes.json<{ id: number }>().id;

      // Download client (fake implementation behind the qBittorrent template).
      const clientRes = await api('POST', '/downloadclient', qbit('Fake qBit'));
      expect(clientRes.statusCode).toBeLessThan(300);

      // Search: the release is approved and grabbed.
      const search = await api('POST', '/command/search', { seriesId });
      expect(search.statusCode).toBe(200);
      const summary = search.json<{ releases: number; approved: number; grabbed: string[] }>();
      expect(summary).toMatchObject({ releases: 1, approved: 1, grabbed: [TITLE] });
      const fake = fakes.find((f) => f.added.length > 0)!;
      expect(fake.added).toHaveLength(1);

      // The tracked download shows in the queue.
      const queue = (await api('GET', '/queue')).json<QueuePage>();
      expect(queue.records).toHaveLength(1);
      expect(queue.records[0]).toMatchObject({ downloadId: HASH, title: TITLE, seriesId });

      // The client reports it completed, with a matching .mkv in its output folder.
      const outputPath = join(downloads, TITLE);
      await mkdir(outputPath, { recursive: true });
      await writeFile(join(outputPath, `${TITLE}.mkv`), Buffer.alloc(4096, 1));
      fake.items = [
        item({
          id: HASH,
          title: TITLE,
          status: 'completed',
          progress: 1,
          remainingBytes: 0,
          downloadedBytes: 4096,
          totalBytes: 4096,
          etaSeconds: 0,
          outputPath,
          isReadOnly: false,
          canMoveFiles: true,
          canBeRemoved: true,
        }),
      ];
      await getDownloadClientsService(ctx).refreshQueue();

      // Imported: library file, episode has file, history grabbed + imported, notifications.
      const files = db.select().from(mediaFiles).where(eq(mediaFiles.seriesId, seriesId)).all();
      expect(files).toHaveLength(1);
      const episodes = (await api('GET', `/episode?seriesId=${seriesId}`)).json<Array<{ episodeNumber: number; hasFile: boolean }>>();
      expect(episodes.find((e) => e.episodeNumber === 1)?.hasFile).toBe(true);
      expect(episodes.find((e) => e.episodeNumber === 2)?.hasFile).toBe(false);

      const history = (await api('GET', '/history?pageSize=50')).json<HistoryPage>();
      const types = history.records.map((r) => r.eventType).sort();
      expect(types).toEqual(['downloadFolderImported', 'grabbed']);
      expect(history.records.every((r) => r.downloadId === HASH)).toBe(true);

      // mediaAdded (library bus event), one grab (bus translator) and one import (wiring):
      // no duplicate grab/import notifications.
      const kinds = dispatched.map((e) => e.type).sort();
      expect(kinds).toEqual(['grab', 'import', 'mediaAdded']);
      const imported = dispatched.find((e) => e.type === 'import');
      expect(imported && 'file' in imported ? imported.file.path : '').toBe(files[0]!.path);
    } finally {
      await app.close();
    }
  });

  it('replaces a release: fails it through history, blocklists it and searches again', async () => {
    const tvRoot = join(tmp, 'tv');
    await mkdir(tvRoot, { recursive: true });
    let ctxRef: AppContext | undefined;
    let searches = 0;
    const release = makeRelease(TITLE, {
      guid: 'guid-1',
      downloadUrl: `magnet:?xt=urn:btih:${HASH}`,
      infoHash: HASH,
      publishDate: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    const config: AppConfig = { configDir: tmp, dbPath: ':memory:', logDir: tmp, port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null };
    const app = await buildApp(config, db, pino({ level: 'silent' }), {
      metadata,
      probe: false,
      onContext: (ctx) => {
        ctxRef = ctx;
        getDownloadClientsService(ctx, {
          directoryExists: async () => true,
          clientFactory: (cfg) => {
            const fake = new FakeDownloadClient(cfg);
            fake.nextId = HASH;
            return fake;
          },
        });
        const indexers = indexersServiceFor(ctx);
        indexers.list = () => [makeIndexer()];
        indexers.search = async () => {
          searches++;
          return [release];
        };
      },
    });
    await app.ready();
    try {
      const ctx = ctxRef!;
      const api = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
        app.inject({
          method,
          url: `/api/v1${url}`,
          headers: { 'x-api-key': authServiceFor(ctx).apiKey() },
          ...(payload === undefined ? {} : { payload: payload as object }),
        });
      await api('POST', '/rootfolder', { path: tvRoot, mediaType: 'series' });
      const { id: _id, ...draft } = makeProfile(HD_ALLOWED);
      const profileId = (await api('POST', '/qualityprofile', QualityProfileInput.parse({ ...draft, name: 'Pipeline HD' }))).json<{ id: number }>().id;
      const seriesId = (await api('POST', '/series', { tmdbId: 4242, rootFolderPath: tvRoot, qualityProfileId: profileId })).json<{ id: number }>().id;
      await api('POST', '/downloadclient', qbit('Fake qBit'));
      expect((await api('POST', '/command/search', { seriesId })).json()).toMatchObject({ grabbed: [TITLE] });
      const queued = (await api('GET', '/queue')).json<QueuePage>().records[0]!;

      const res = await api('POST', `/queue/${queued.id}/replace`, {});
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ blocklisted: true, searchStarted: true });

      const history = (await api('GET', '/history?pageSize=50')).json<HistoryPage>();
      const failed = history.records.find((r) => r.eventType === 'downloadFailed');
      expect(failed).toBeDefined();
      expect(JSON.stringify(failed)).toContain('Replaced by the user');
      const blocklist = (await api('GET', '/blocklist')).json<{ records: Array<{ sourceTitle: string }> }>();
      expect(blocklist.records.map((r) => r.sourceTitle)).toEqual([TITLE]);
      // The replacement search runs as a job; the only release is blocklisted now.
      for (let i = 0; i < 50 && searches < 2; i++) await new Promise((r) => setTimeout(r, 20));
      expect(searches).toBe(2);
      expect((await api('GET', '/queue')).json<QueuePage>().records).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
