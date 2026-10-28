import {
  AudioImportSettings,
  FeatureSettings,
  MetadataSettingsResponse,
  MetadataSettingsUpdate,
  MusicMetadataSettingsResponse,
  MusicMetadataSettingsUpdate,
  ReleasesSettings,
  SettingsErrorResponse,
} from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Db } from '../../db/index.js';
import { ProfilesService } from '../profiles/service.js';
import {
  getAudioImportSettings,
  getFeatureSettings,
  getMetadataSettings,
  getMusicMetadataSettings,
  getReleasesSettings,
  SettingsError,
  updateAudioImportSettings,
  updateFeatureSettings,
  updateMetadataSettings,
  updateMusicMetadataSettings,
  updateReleasesSettings,
} from './service.js';

export function settingsRoutes(db: Db): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof SettingsError) return reply.code(400).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error({ err }, 'unhandled settings error');
      return reply.code(500).send({ error: 'internal error' });
    });

    app.get('/settings/metadata', { schema: { response: { 200: MetadataSettingsResponse } } }, async () =>
      getMetadataSettings(db),
    );

    app.put(
      '/settings/metadata',
      { schema: { body: MetadataSettingsUpdate, response: { 200: MetadataSettingsResponse, 400: SettingsErrorResponse } } },
      async (req) => updateMetadataSettings(db, req.body),
    );

    // Every signed-in user reads the feature flags: the nav shows Music/Audiobooks from them.
    app.get('/settings/features', { config: { access: { portal: true } }, schema: { response: { 200: FeatureSettings } } }, async () => getFeatureSettings(db));

    app.put(
      '/settings/features',
      { schema: { body: FeatureSettings, response: { 200: FeatureSettings, 400: SettingsErrorResponse } } },
      async (req) => {
        const saved = updateFeatureSettings(db, req.body);
        // Switching music on gives it starter quality profiles, so an artist can be added at once.
        if (saved.music) new ProfilesService({ db }).seedMusicDefaults();
        return saved;
      },
    );

    app.get('/settings/musicmetadata', { schema: { response: { 200: MusicMetadataSettingsResponse } } }, async () =>
      getMusicMetadataSettings(db),
    );

    app.put(
      '/settings/musicmetadata',
      { schema: { body: MusicMetadataSettingsUpdate, response: { 200: MusicMetadataSettingsResponse, 400: SettingsErrorResponse } } },
      async (req) => updateMusicMetadataSettings(db, req.body),
    );

    app.get('/settings/audio', { schema: { response: { 200: AudioImportSettings } } }, async () => getAudioImportSettings(db));

    app.put(
      '/settings/audio',
      { schema: { body: AudioImportSettings, response: { 200: AudioImportSettings, 400: SettingsErrorResponse } } },
      async (req) => updateAudioImportSettings(db, req.body),
    );

    app.get('/settings/releases', { schema: { response: { 200: ReleasesSettings } } }, async () => getReleasesSettings(db));

    app.put(
      '/settings/releases',
      { schema: { body: ReleasesSettings, response: { 200: ReleasesSettings, 400: SettingsErrorResponse } } },
      async (req) => updateReleasesSettings(db, req.body),
    );
  };
}
