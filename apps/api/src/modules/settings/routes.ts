import {
  MetadataSettingsResponse,
  MetadataSettingsUpdate,
  ReleasesSettings,
  SettingsErrorResponse,
} from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Db } from '../../db/index.js';
import {
  getMetadataSettings,
  getReleasesSettings,
  SettingsError,
  updateMetadataSettings,
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

    app.get('/settings/releases', { schema: { response: { 200: ReleasesSettings } } }, async () => getReleasesSettings(db));

    app.put(
      '/settings/releases',
      { schema: { body: ReleasesSettings, response: { 200: ReleasesSettings, 400: SettingsErrorResponse } } },
      async (req) => updateReleasesSettings(db, req.body),
    );
  };
}
