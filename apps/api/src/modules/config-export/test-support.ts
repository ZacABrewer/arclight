import type { Db } from '../../db/index.js';
import {
  customFormats,
  delayProfiles,
  downloadClients,
  importLists,
  indexerProxies,
  indexers,
  languageProfiles,
  notifications,
  qualityProfiles,
  releaseProfiles,
  remotePathMappings,
  rootFolders,
  tags,
} from '../../db/schema.js';
import { createTestDb } from '../../db/test-utils.js';
import { setSection } from '../settings/service.js';

const NOW = '2026-01-01T00:00:00.000Z';

/** One of everything, with secrets in clear, referencing each other by id. Not used by production code. */
export async function seededDb(): Promise<Db> {
  const db = await createTestDb();
  setSection(db, 'metadata', { tmdbApiKey: 'tmdb-secret-key', language: 'en-US', region: 'US' });
  const hd = db.insert(tags).values({ label: 'hd' }).returning().get();
  const anime = db.insert(tags).values({ label: 'anime' }).returning().get();
  const cf = db
    .insert(customFormats)
    .values({
      name: 'x265',
      includeWhenRenaming: false,
      specifications: [{ implementation: 'releaseTitle', name: 'x265', negate: false, required: false, fields: { pattern: 'x265|hevc' } }],
    })
    .returning()
    .get();
  const qp = db
    .insert(qualityProfiles)
    .values({
      name: 'HD-1080p',
      upgradeAllowed: true,
      cutoff: 7,
      items: [
        { kind: 'quality', qualityId: 4, allowed: true },
        { kind: 'quality', qualityId: 7, allowed: true },
      ],
      formatItems: [{ formatId: cf.id, score: 50 }],
      languages: ['en'],
    })
    .returning()
    .get();
  const dc = db
    .insert(downloadClients)
    .values({
      name: 'qBit',
      implementation: 'qbittorrent',
      protocol: 'torrent',
      tags: [hd.id],
      settings: { host: 'qbit', port: 8080, username: 'admin', password: 'qbit-password' },
      updatedAt: NOW,
    })
    .returning()
    .get();
  const proxy = db
    .insert(indexerProxies)
    .values({ name: 'Flare', type: 'flaresolverr', host: 'flaresolverr', port: 8191, password: 'proxy-pass', tags: [] })
    .returning()
    .get();
  const ix = db
    .insert(indexers)
    .values({
      name: 'NZBgeek',
      implementation: 'newznab',
      downloadClientId: dc.id,
      proxyId: proxy.id,
      tags: [anime.id],
      settings: { baseUrl: 'https://api.nzbgeek.info', apiPath: '/api', apiKey: 'geek-api-key', categories: [5030], animeCategories: [] },
      addedAt: NOW,
    })
    .returning()
    .get();
  db.insert(releaseProfiles).values({ name: 'No CAM', required: [], ignored: ['CAM'], indexerId: ix.id, tags: [hd.id] }).run();
  db.insert(delayProfiles).values({ order: 2147483647, tags: [], usenetDelayMinutes: 60 }).run();
  db.insert(delayProfiles).values({ order: 1, tags: [anime.id], torrentDelayMinutes: 30 }).run();
  db.insert(remotePathMappings).values({ host: 'qbit', remotePath: '/downloads/', localPath: '/data/downloads/' }).run();
  db.insert(rootFolders).values({ path: '/tv', mediaType: 'series' }).run();
  db.insert(rootFolders).values({ path: '/movies', mediaType: 'movie' }).run();
  db.insert(notifications)
    .values({ name: 'Discord', implementation: 'discord', onGrab: true, tags: [], settings: { webhookUrl: 'https://discord/hook/abc' }, addedAt: NOW, updatedAt: NOW })
    .run();
  db.insert(importLists)
    .values({
      name: 'Popular',
      implementation: 'tmdbPopular',
      rootFolderPath: '/movies',
      qualityProfileId: qp.id,
      tags: [],
      mediaType: 'movie',
      settings: { limit: 50 },
      addedAt: NOW,
    })
    .run();
  db.insert(languageProfiles)
    .values({ name: 'English', languages: [{ code: 'en', forced: 'never', hi: 'also' }], cutoff: 'en', mustContain: [], mustNotContain: [] })
    .run();
  return db;
}
