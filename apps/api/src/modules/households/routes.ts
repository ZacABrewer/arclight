import { z } from 'zod';
import {
  HouseholdProfile,
  HouseholdProfileCreate,
  HouseholdProfilesResponse,
  HouseholdProfileUpdate,
  ProfileSettings,
  ProfileSettingsPatch,
  SelectProfileRequest,
  SelectProfileResponse,
} from '@arclight/shared';
import type { FastifyPluginAsync, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Db } from '../../db/index.js';
import { requireAdmin } from '../auth/hook.js';
import { audit } from '../audit/recorder.js';
import type { RequestAuth } from '../auth/service.js';
import { findUserRow } from '../requests/users.js';
import { HouseholdError, type HouseholdService } from './service.js';

// /api/v1/households/* (the signed-in account's own profiles) and /api/v1/users/:userId/profiles*
// (admins, from the Users page). See spec §1.1 / §2.3:
//   GET  /households/profiles                  any credential with a user, any active profile
//   POST /households/profiles, PATCH|DELETE /households/profiles/:id   owner profile active
//   POST /households/profiles/:id/select       sessions and app devices only (PIN / password rule)
//   GET|PUT /households/profiles/active/settings   the active profile's own settings
// Bodies carry PINs and passwords: these routes keep out of the request audit and record their own entries
// (profile ids only, never a PIN).

type Plugin = FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider>;

const portal = { access: { portal: true }, audit: false } as const;
const admin = { audit: false } as const;
const ErrorBody = z.object({ error: z.string(), code: z.string().optional(), retryAfterSeconds: z.number().int().optional() });
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody, 429: ErrorBody };
const IdParams = z.object({ id: z.coerce.number().int().positive() });
const UserParams = z.object({ userId: z.coerce.number().int().positive() });
const UserProfileParams = z.object({ userId: z.coerce.number().int().positive(), id: z.coerce.number().int().positive() });
const Empty = z.null();

function accountOf(req: FastifyRequest): { auth: RequestAuth; userId: number; profileId: number; isOwner: boolean } {
  const auth = req.auth;
  if (!auth?.user || !auth.profile) throw new HouseholdError('unsupported-credential');
  return { auth, userId: auth.user.id, profileId: auth.profile.id, isOwner: auth.profile.isOwner };
}

function manager(req: FastifyRequest): { auth: RequestAuth; userId: number } {
  const a = accountOf(req);
  if (!a.isOwner) throw new HouseholdError('manage-forbidden');
  return a;
}

/** What an audit entry may say about a create/update body: never the PIN itself. */
function safeBody(body: { pin?: string | null | undefined } & Record<string, unknown>): Record<string, unknown> {
  const { pin, ...rest } = body;
  return { ...rest, ...(pin !== undefined ? { pin: pin === null ? 'removed' : 'set' } : {}) };
}

export function householdRoutes(service: HouseholdService, db: Db): Plugin {
  return async (app) => {
    const log = (req: FastifyRequest, action: string, target: number, details: Record<string, unknown> = {}) =>
      audit(db).record({
        action,
        userId: req.auth?.user?.id ?? null,
        username: req.auth?.user?.username ?? null,
        ip: req.ip,
        target,
        method: req.method,
        route: req.routeOptions.url ?? null,
        details,
      });

    app.setErrorHandler((err, req, reply) => {
      if (err instanceof HouseholdError) {
        if (err.retryAfterSeconds !== undefined) reply.header('retry-after', String(err.retryAfterSeconds));
        return reply.code(err.status).send(err.body());
      }
      if (err instanceof Error && 'validation' in err && err.validation) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      const status = (err as { statusCode?: number }).statusCode;
      if (status && status >= 400 && status < 500) return reply.code(status).send({ error: (err as Error).message, code: 'BAD_REQUEST' });
      req.log.error({ err }, 'unhandled households error');
      return reply.code(500).send({ error: 'internal error', code: 'INTERNAL' });
    });

    // ------------------------------------------------------------------ own account
    app.get('/households/profiles', { config: portal, schema: { response: { 200: HouseholdProfilesResponse, ...errors } } }, async (req) => {
      const a = accountOf(req);
      return service.list(a.userId, a.profileId, a.isOwner);
    });

    app.post('/households/profiles', { config: portal, schema: { body: HouseholdProfileCreate, response: { 201: HouseholdProfile, ...errors } } }, async (req, reply) => {
      const a = manager(req);
      const created = await service.create(a.userId, req.body);
      log(req, 'household.profile.create', created.id, { body: safeBody(req.body) });
      return reply.code(201).send(created);
    });

    // Registered before /:id so the static segment wins (it is also a different depth).
    app.get('/households/profiles/active/settings', { config: portal, schema: { response: { 200: ProfileSettings, ...errors } } }, async (req) => {
      const a = accountOf(req);
      return service.settings(a.userId, a.profileId);
    });

    app.put('/households/profiles/active/settings', { config: portal, schema: { body: ProfileSettingsPatch, response: { 200: ProfileSettings, ...errors } } }, async (req) => {
      const a = accountOf(req);
      return service.patchSettings(a.userId, a.profileId, req.body);
    });

    app.patch('/households/profiles/:id', { config: portal, schema: { params: IdParams, body: HouseholdProfileUpdate, response: { 200: HouseholdProfile, ...errors } } }, async (req) => {
      const a = manager(req);
      const updated = await service.update(a.userId, req.params.id, req.body);
      log(req, 'household.profile.update', updated.id, { body: safeBody(req.body) });
      return updated;
    });

    app.delete('/households/profiles/:id', { config: portal, schema: { params: IdParams, response: { 204: Empty, ...errors } } }, async (req, reply) => {
      const a = manager(req);
      service.remove(a.userId, req.params.id);
      log(req, 'household.profile.delete', req.params.id);
      return reply.code(204).send(null);
    });

    app.post(
      '/households/profiles/:id/select',
      { config: portal, schema: { params: IdParams, body: SelectProfileRequest.optional(), response: { 200: SelectProfileResponse, ...errors } } },
      async (req) => {
        const a = accountOf(req);
        const selected = await service.select(
          {
            via: a.auth.via,
            userId: a.userId,
            sessionId: a.auth.sessionId,
            appDeviceId: a.auth.appDeviceId,
            createdAt: a.auth.credentialCreatedAt,
            activeProfileId: a.profileId,
            ip: req.ip,
            username: a.auth.user?.username ?? null,
          },
          req.params.id,
          req.body?.pin,
          req.body?.password,
        );
        log(req, 'household.profile.select', selected.id, { profileId: selected.id, via: a.auth.via });
        return { activeProfile: selected };
      },
    );

    // ------------------------------------------------------------------ admin (Users page)
    const userExists = (userId: number) => {
      if (!findUserRow(db, userId)) throw new HouseholdError('not-found');
    };

    app.get('/users/:userId/profiles', { preHandler: requireAdmin, config: admin, schema: { params: UserParams, response: { 200: HouseholdProfilesResponse, ...errors } } }, async (req) => {
      userExists(req.params.userId);
      return service.list(req.params.userId, null, true);
    });

    app.post(
      '/users/:userId/profiles',
      { preHandler: requireAdmin, config: admin, schema: { params: UserParams, body: HouseholdProfileCreate, response: { 201: HouseholdProfile, ...errors } } },
      async (req, reply) => {
        userExists(req.params.userId);
        const created = await service.create(req.params.userId, req.body);
        log(req, 'household.profile.create', created.id, { userId: req.params.userId, body: safeBody(req.body) });
        return reply.code(201).send(created);
      },
    );

    app.patch(
      '/users/:userId/profiles/:id',
      { preHandler: requireAdmin, config: admin, schema: { params: UserProfileParams, body: HouseholdProfileUpdate, response: { 200: HouseholdProfile, ...errors } } },
      async (req) => {
        userExists(req.params.userId);
        const updated = await service.update(req.params.userId, req.params.id, req.body);
        log(req, 'household.profile.update', updated.id, { userId: req.params.userId, body: safeBody(req.body) });
        return updated;
      },
    );

    app.delete(
      '/users/:userId/profiles/:id',
      { preHandler: requireAdmin, config: admin, schema: { params: UserProfileParams, response: { 204: Empty, ...errors } } },
      async (req, reply) => {
        userExists(req.params.userId);
        service.remove(req.params.userId, req.params.id);
        log(req, 'household.profile.delete', req.params.id, { userId: req.params.userId });
        return reply.code(204).send(null);
      },
    );
  };
}
