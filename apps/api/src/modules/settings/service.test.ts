import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { SECRET_MASK } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { createTestDb } from '../../db/test-utils.js';
import { ProfilesService } from '../profiles/service.js';
import { settingsRoutes } from './routes.js';
import { applyMetadataUpdate, getSection, maskMetadataSettings, setSection } from './service.js';

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

describe('settings sections', () => {
  it('returns defaults when nothing is stored', () => {
    expect(getSection(db, 'metadata')).toEqual({ language: 'en-US', region: 'US' });
  });

  it('persists and reads back a section', () => {
    setSection(db, 'metadata', { tmdbApiKey: 'abc', language: 'de-DE', region: 'DE' });
    expect(getSection(db, 'metadata')).toEqual({ tmdbApiKey: 'abc', language: 'de-DE', region: 'DE' });
  });

  it('rejects an invalid section', () => {
    expect(() => setSection(db, 'metadata', { language: 'en-US', region: 'USA' })).toThrow();
  });
});

describe('metadata masking', () => {
  it('masks a stored key and reports null when none', () => {
    expect(maskMetadataSettings({ tmdbApiKey: 'secret', language: 'en-US', region: 'US' }).tmdbApiKey).toBe(SECRET_MASK);
    expect(maskMetadataSettings({ language: 'en-US', region: 'US' }).tmdbApiKey).toBeNull();
  });

  it('keeps the stored key when the mask or nothing is sent back', () => {
    const current = { tmdbApiKey: 'secret', language: 'en-US', region: 'US' };
    expect(applyMetadataUpdate(current, { tmdbApiKey: SECRET_MASK, region: 'GB' })).toEqual({
      tmdbApiKey: 'secret',
      language: 'en-US',
      region: 'GB',
    });
    expect(applyMetadataUpdate(current, {}).tmdbApiKey).toBe('secret');
  });

  it('replaces or clears the key', () => {
    const current = { tmdbApiKey: 'secret', language: 'en-US', region: 'US' };
    expect(applyMetadataUpdate(current, { tmdbApiKey: ' fresh ' }).tmdbApiKey).toBe('fresh');
    expect(applyMetadataUpdate(current, { tmdbApiKey: null })).not.toHaveProperty('tmdbApiKey');
    expect(applyMetadataUpdate(current, { tmdbApiKey: '' })).not.toHaveProperty('tmdbApiKey');
  });
});

describe('GET/PUT /settings/metadata', () => {
  async function app() {
    const a = Fastify().withTypeProvider<ZodTypeProvider>();
    a.setValidatorCompiler(validatorCompiler);
    a.setSerializerCompiler(serializerCompiler);
    await a.register(settingsRoutes(db), { prefix: '/api/v1' });
    return a;
  }

  it('round-trips with the key masked and preserved', async () => {
    const a = await app();
    const empty = await a.inject({ method: 'GET', url: '/api/v1/settings/metadata' });
    expect(empty.json()).toEqual({ tmdbApiKey: null, language: 'en-US', region: 'US' });

    const put = await a.inject({ method: 'PUT', url: '/api/v1/settings/metadata', payload: { tmdbApiKey: 'k1' } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ tmdbApiKey: SECRET_MASK, language: 'en-US', region: 'US' });

    await a.inject({ method: 'PUT', url: '/api/v1/settings/metadata', payload: { tmdbApiKey: SECRET_MASK, language: 'fr-FR' } });
    expect(getSection(db, 'metadata')).toEqual({ tmdbApiKey: 'k1', language: 'fr-FR', region: 'US' });

    const bad = await a.inject({ method: 'PUT', url: '/api/v1/settings/metadata', payload: { region: 'FRA' } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('music and feature sections', () => {
  const app = async () => {
    const a = Fastify().withTypeProvider<ZodTypeProvider>();
    a.setValidatorCompiler(validatorCompiler);
    a.setSerializerCompiler(serializerCompiler);
    await a.register(settingsRoutes(db), { prefix: '/api/v1' });
    return a;
  };

  it('defaults: features off, MusicBrainz at 1 req/s, track match 0.8', () => {
    expect(getSection(db, 'features')).toEqual({ music: false, audiobooks: false });
    expect(getSection(db, 'musicMetadata')).toEqual({
      baseUrl: 'https://musicbrainz.org/ws/2/',
      rateLimitPerSecond: 1,
      preferredCountries: ['XW', 'US', 'GB'],
      preferredFormats: ['Digital Media', 'CD'],
    });
    expect(getSection(db, 'audio')).toEqual({ trackMatchThreshold: 0.8, audiobookDurationTolerance: 15, renameAudiobookParts: true, writeAbsSidecars: false });
  });

  it('masks the Fanart.tv key and keeps it on a masked update', async () => {
    const a = await app();
    const put = await a.inject({
      method: 'PUT',
      url: '/api/v1/settings/musicmetadata',
      payload: { fanartApiKey: 'fan-key', contactEmail: 'ops@example.com', preferredCountries: ['gb'] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ fanartApiKey: SECRET_MASK, contactEmail: 'ops@example.com', preferredCountries: ['GB'] });
    await a.inject({ method: 'PUT', url: '/api/v1/settings/musicmetadata', payload: { fanartApiKey: SECRET_MASK, rateLimitPerSecond: 2 } });
    expect(getSection(db, 'musicMetadata')).toMatchObject({ fanartApiKey: 'fan-key', rateLimitPerSecond: 2, contactEmail: 'ops@example.com' });
    await a.inject({ method: 'PUT', url: '/api/v1/settings/musicmetadata', payload: { fanartApiKey: null, contactEmail: '' } });
    expect(getSection(db, 'musicMetadata')).not.toHaveProperty('fanartApiKey');
    expect(getSection(db, 'musicMetadata')).not.toHaveProperty('contactEmail');

    const features = await a.inject({ method: 'PUT', url: '/api/v1/settings/features', payload: { music: true } });
    expect(features.json()).toEqual({ music: true, audiobooks: false });
    const bad = await a.inject({ method: 'PUT', url: '/api/v1/settings/audio', payload: { trackMatchThreshold: 2 } });
    expect(bad.statusCode).toBe(400);
    await a.close();
  });

  it('audiobook metadata: defaults, partial updates, validation, and profiles seeded on enable', async () => {
    expect(getSection(db, 'audiobookMetadata')).toEqual({
      audibleRegion: 'us',
      audnexusBaseUrl: 'https://api.audnex.us/',
      openLibraryFallback: true,
      languages: [],
      audnexusRateLimitPerSecond: 1,
      audibleRateLimitPerSecond: 2,
      openLibraryRateLimitPerSecond: 1,
    });
    const a = await app();
    const get = await a.inject({ method: 'GET', url: '/api/v1/settings/audiobookmetadata' });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ audibleRegion: 'us' });

    const put = await a.inject({
      method: 'PUT',
      url: '/api/v1/settings/audiobookmetadata',
      payload: { audibleRegion: 'de', languages: ['German'], audibleRateLimitPerSecond: 1 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ audibleRegion: 'de', languages: ['german'], audibleRateLimitPerSecond: 1, openLibraryFallback: true });
    await a.inject({ method: 'PUT', url: '/api/v1/settings/audiobookmetadata', payload: { openLibraryFallback: false } });
    expect(getSection(db, 'audiobookMetadata')).toMatchObject({ audibleRegion: 'de', languages: ['german'], openLibraryFallback: false });

    const badRegion = await a.inject({ method: 'PUT', url: '/api/v1/settings/audiobookmetadata', payload: { audibleRegion: 'xx' } });
    expect(badRegion.statusCode).toBe(400);
    const badRate = await a.inject({ method: 'PUT', url: '/api/v1/settings/audiobookmetadata', payload: { audnexusRateLimitPerSecond: 0 } });
    expect(badRate.statusCode).toBe(400);

    const features = await a.inject({ method: 'PUT', url: '/api/v1/settings/features', payload: { music: false, audiobooks: true } });
    expect(features.json()).toEqual({ music: false, audiobooks: true });
    const names = new ProfilesService({ db }).listQualityProfiles('audiobook').map((p) => p.name);
    expect(names).toEqual(['Standard', 'M4B only', 'Any (audiobook)']);
    await a.close();
  });
});
