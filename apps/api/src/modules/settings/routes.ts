import {
  MetadataSettingsResponse,
  MetadataSettingsUpdate,
  SettingsErrorResponse,
} from '@media-tron/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Db } from '../../db/index.js';
import { getMetadataSettings, SettingsError, updateMetadataSettings } from './service.js';

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
  };
}
