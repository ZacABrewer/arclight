import { z } from 'zod';
import {
  CustomFormat,
  CustomFormatInput,
  CustomFormatTestRequest,
  CustomFormatTestResponse,
  DelayProfile,
  DelayProfileInput,
  DelayProfileReorderRequest,
  ProfilesErrorResponse,
  QualityDefinitionItem,
  QualityDefinitionLimits,
  QualityProfile,
  QualityProfileInput,
  ReleaseProfile,
  ReleaseProfileInput,
  SpecImplementationDefinition,
} from '@arclight/shared';
import { specImplementations } from '@arclight/profiles-engine';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { ProfileError, type ProfilesService } from './service.js';
import { ADVANCED_REQUESTERS } from '../auth/hook.js';

const IdParams = z.object({ id: z.coerce.number().int().min(1) });
const QualityIdParams = z.object({ qualityId: z.coerce.number().int().min(0) });
const Empty = z.null();

const errors = { 400: ProfilesErrorResponse, 404: ProfilesErrorResponse, 409: ProfilesErrorResponse };

const statusFor: Record<ProfileError['code'], number> = { NOT_FOUND: 404, VALIDATION: 400, IN_USE: 409, CONFLICT: 409 };

/** A quality profile or custom format changed (published on the bus by the module). */
export interface ProfileChange {
  action: 'created' | 'updated' | 'deleted';
  kind: 'quality' | 'customFormat';
  id: number;
}

export function profilesRoutes(
  service: ProfilesService,
  onChange: (change: ProfileChange) => void = () => undefined,
): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    // Announced after the service call succeeded, so listeners (profile migration) see the new state.
    const changed = <T extends { id: number }>(action: ProfileChange['action'], kind: ProfileChange['kind'], row: T): T => {
      onChange({ action, kind, id: row.id });
      return row;
    };
    // Typed errors from the service map to HTTP here and nowhere else.
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof ProfileError) {
        return reply.code(statusFor[err.code]).send({ error: err.message, code: err.code });
      }
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error(err);
      return reply.code(500).send({ error: 'internal error' });
    });

    // ---- quality profiles --------------------------------------------------------------

    app.get('/qualityprofile', { config: { access: { areas: ['library', 'wanted'], permissions: ADVANCED_REQUESTERS } }, schema: { response: { 200: z.array(QualityProfile) } } }, async () =>
      service.listQualityProfiles(),
    );

    // The template has an empty name for the user to fill in, so it is not a valid input yet.
    app.get('/qualityprofile/schema', { schema: { response: { 200: QualityProfileInput.extend({ name: z.string() }) } } }, async () =>
      service.qualityProfileTemplate(),
    );

    app.get('/qualityprofile/:id', { config: { access: { areas: ['library', 'wanted'] } }, schema: { params: IdParams, response: { 200: QualityProfile, ...errors } } }, async (req) =>
      service.getQualityProfile(req.params.id),
    );

    app.post(
      '/qualityprofile',
      { schema: { body: QualityProfileInput, response: { 201: QualityProfile, ...errors } } },
      async (req, reply) => reply.code(201).send(changed('created', 'quality', service.createQualityProfile(req.body))),
    );

    app.put(
      '/qualityprofile/:id',
      { schema: { params: IdParams, body: QualityProfileInput, response: { 200: QualityProfile, ...errors } } },
      async (req) => changed('updated', 'quality', service.updateQualityProfile(req.params.id, req.body)),
    );

    app.delete('/qualityprofile/:id', { schema: { params: IdParams, response: { 204: Empty, ...errors } } }, async (req, reply) => {
      await service.deleteQualityProfile(req.params.id);
      changed('deleted', 'quality', { id: req.params.id });
      return reply.code(204).send(null);
    });

    // ---- custom formats ----------------------------------------------------------------

    app.get('/customformat', { schema: { response: { 200: z.array(CustomFormat) } } }, async () => service.listCustomFormats());

    app.get('/customformat/schema', { schema: { response: { 200: z.array(SpecImplementationDefinition) } } }, async () =>
      specImplementations(),
    );

    app.post(
      '/customformat/test',
      { schema: { body: CustomFormatTestRequest, response: { 200: CustomFormatTestResponse, ...errors } } },
      async (req) => service.testCustomFormats(req.body),
    );

    app.get('/customformat/:id', { schema: { params: IdParams, response: { 200: CustomFormat, ...errors } } }, async (req) =>
      service.getCustomFormat(req.params.id),
    );

    app.post(
      '/customformat',
      { schema: { body: CustomFormatInput, response: { 201: CustomFormat, ...errors } } },
      async (req, reply) => reply.code(201).send(changed('created', 'customFormat', service.createCustomFormat(req.body))),
    );

    app.put(
      '/customformat/:id',
      { schema: { params: IdParams, body: CustomFormatInput, response: { 200: CustomFormat, ...errors } } },
      async (req) => changed('updated', 'customFormat', service.updateCustomFormat(req.params.id, req.body)),
    );

    app.delete('/customformat/:id', { schema: { params: IdParams, response: { 204: Empty, ...errors } } }, async (req, reply) => {
      await service.deleteCustomFormat(req.params.id);
      changed('deleted', 'customFormat', { id: req.params.id });
      return reply.code(204).send(null);
    });

    // ---- delay profiles ----------------------------------------------------------------

    app.get('/delayprofile', { schema: { response: { 200: z.array(DelayProfile) } } }, async () => service.listDelayProfiles());

    app.put(
      '/delayprofile/reorder',
      { schema: { body: DelayProfileReorderRequest, response: { 200: z.array(DelayProfile), ...errors } } },
      async (req) => service.reorderDelayProfile(req.body.id, req.body.afterId),
    );

    app.get('/delayprofile/:id', { schema: { params: IdParams, response: { 200: DelayProfile, ...errors } } }, async (req) =>
      service.getDelayProfile(req.params.id),
    );

    app.post(
      '/delayprofile',
      { schema: { body: DelayProfileInput, response: { 201: DelayProfile, ...errors } } },
      async (req, reply) => reply.code(201).send(service.createDelayProfile(req.body)),
    );

    app.put(
      '/delayprofile/:id',
      { schema: { params: IdParams, body: DelayProfileInput, response: { 200: DelayProfile, ...errors } } },
      async (req) => service.updateDelayProfile(req.params.id, req.body),
    );

    app.delete('/delayprofile/:id', { schema: { params: IdParams, response: { 204: Empty, ...errors } } }, async (req, reply) => {
      service.deleteDelayProfile(req.params.id);
      return reply.code(204).send(null);
    });

    // ---- release profiles --------------------------------------------------------------

    app.get('/releaseprofile', { schema: { response: { 200: z.array(ReleaseProfile) } } }, async () => service.listReleaseProfiles());

    app.get('/releaseprofile/:id', { schema: { params: IdParams, response: { 200: ReleaseProfile, ...errors } } }, async (req) =>
      service.getReleaseProfile(req.params.id),
    );

    app.post(
      '/releaseprofile',
      { schema: { body: ReleaseProfileInput, response: { 201: ReleaseProfile, ...errors } } },
      async (req, reply) => reply.code(201).send(service.createReleaseProfile(req.body)),
    );

    app.put(
      '/releaseprofile/:id',
      { schema: { params: IdParams, body: ReleaseProfileInput, response: { 200: ReleaseProfile, ...errors } } },
      async (req) => service.updateReleaseProfile(req.params.id, req.body),
    );

    app.delete('/releaseprofile/:id', { schema: { params: IdParams, response: { 204: Empty, ...errors } } }, async (req, reply) => {
      service.deleteReleaseProfile(req.params.id);
      return reply.code(204).send(null);
    });

    // ---- quality definitions -----------------------------------------------------------

    app.get('/qualitydefinition', { schema: { response: { 200: z.array(QualityDefinitionItem) } } }, async () =>
      service.listQualityDefinitions(),
    );

    app.put(
      '/qualitydefinition/:qualityId',
      { schema: { params: QualityIdParams, body: QualityDefinitionLimits, response: { 200: QualityDefinitionItem, ...errors } } },
      async (req) => service.updateQualityDefinition(req.params.qualityId, req.body),
    );
  };
}
