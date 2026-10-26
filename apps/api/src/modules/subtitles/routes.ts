import multipart from '@fastify/multipart';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  LanguageProfile,
  LanguageProfileInput,
  MediaFileSubtitles,
  SubtitleBlacklistPage,
  SubtitleBlacklistQuery,
  SubtitleBlacklistRecord,
  SubtitleBlacklistRequest,
  SubtitleDownloadRequest,
  SubtitleErrorResponse,
  SubtitleFileQuery,
  SubtitleHistoryPage,
  SubtitleHistoryQuery,
  SubtitleLanguageOption,
  SubtitleManualSearchQuery,
  SubtitleManualSearchResponse,
  SubtitleProviderResetRequest,
  SubtitleProvidersResponse,
  SubtitleProviderTestRequest,
  SubtitleProviderTestResult,
  SubtitleSearchCommand,
  SubtitleSearchCommandResult,
  SubtitleSettings,
  SubtitleState,
  SubtitleSyncResult,
  SubtitleUploadFields,
  WantedSubtitlesPage,
  WantedSubtitlesQuery,
} from '@media-tron/shared';
import { requireAdmin } from '../auth/hook.js';
import { SubtitlesError, type SubtitlesService } from './service.js';

const IdParams = z.object({ id: z.coerce.number().int() });
const errors = { 400: SubtitleErrorResponse, 404: SubtitleErrorResponse, 409: SubtitleErrorResponse };
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const statusFor: Record<SubtitlesError['code'], number> = {
  NOT_FOUND: 404,
  VALIDATION: 400,
  CONFLICT: 409,
  EXPIRED: 410,
  UNSUPPORTED: 400,
  FAILED: 502,
};

export interface SubtitlesRoutesOptions {
  /** preHandler for admin-only routes; defaults to the auth module's requireAdmin. */
  admin?: typeof requireAdmin;
}

export function subtitlesRoutes(
  service: SubtitlesService,
  opts: SubtitlesRoutesOptions = {},
): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  const admin = opts.admin ?? requireAdmin;
  return async (app) => {
    // Encapsulated in this plugin scope; skip when a parent scope already registered it.
    if (!app.hasContentTypeParser('multipart/form-data')) {
      await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10 } });
    }

    app.setErrorHandler((err, req, reply) => {
      if (err instanceof SubtitlesError) return reply.code(statusFor[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      const code = (err as { code?: unknown }).code;
      if (code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'subtitle file too large', code: 'TOO_LARGE' });
      if (typeof code === 'string' && code.startsWith('FST_')) return reply.code(400).send({ error: (err as Error).message, code });
      req.log.error({ err }, 'unhandled subtitles error');
      return reply.code(500).send({ error: 'internal error' });
    });

    // ---- language profiles ---------------------------------------------------------------------
    app.get('/languageprofile', { schema: { response: { 200: z.array(LanguageProfile) } } }, async () => service.listProfiles());
    app.get('/languageprofile/:id', { schema: { params: IdParams, response: { 200: LanguageProfile, ...errors } } }, async (req) =>
      service.getProfile(req.params.id),
    );
    app.post('/languageprofile', { preHandler: admin, schema: { body: LanguageProfileInput, response: { 201: LanguageProfile, ...errors } } }, async (req, reply) =>
      reply.code(201).send(service.createProfile(req.body)),
    );
    app.put('/languageprofile/:id', { preHandler: admin, schema: { params: IdParams, body: LanguageProfileInput, response: { 200: LanguageProfile, ...errors } } }, async (req) =>
      service.updateProfile(req.params.id, req.body),
    );
    app.delete('/languageprofile/:id', { preHandler: admin, schema: { params: IdParams } }, async (req, reply) => {
      service.deleteProfile(req.params.id);
      return reply.code(204).send();
    });

    // ---- settings and providers ------------------------------------------------------------------
    app.get('/subtitle/languages', { schema: { response: { 200: z.array(SubtitleLanguageOption) } } }, async () => service.languages());
    app.get('/subtitle/settings', { preHandler: admin, schema: { response: { 200: SubtitleSettings } } }, async () => service.getMaskedSettings());
    app.put('/subtitle/settings', { preHandler: admin, schema: { body: SubtitleSettings, response: { 200: SubtitleSettings, ...errors } } }, async (req) =>
      service.updateSettings(req.body),
    );
    app.get('/subtitle/providers', { preHandler: admin, schema: { response: { 200: SubtitleProvidersResponse } } }, async () => service.providers());
    app.post('/subtitle/providers/test', { preHandler: admin, schema: { body: SubtitleProviderTestRequest, response: { 200: SubtitleProviderTestResult } } }, async (req) =>
      service.testProvider(req.body.id, req.body.settings),
    );
    app.post('/subtitle/providers/reset', { preHandler: admin, schema: { body: SubtitleProviderResetRequest, response: { 200: SubtitleProvidersResponse } } }, async (req) =>
      service.resetThrottles(req.body.onlyAuthOrConfig),
    );

    // ---- wanted, history, blacklist ----------------------------------------------------------------
    app.get('/subtitle/wanted', { schema: { querystring: WantedSubtitlesQuery, response: { 200: WantedSubtitlesPage } } }, async (req) => service.wanted(req.query));
    app.get('/subtitle/history', { schema: { querystring: SubtitleHistoryQuery, response: { 200: SubtitleHistoryPage } } }, async (req) => service.history(req.query));
    app.get('/subtitle/blacklist', { schema: { querystring: SubtitleBlacklistQuery, response: { 200: SubtitleBlacklistPage } } }, async (req) =>
      service.listBlacklist(req.query.page, req.query.pageSize),
    );
    app.post('/subtitle/blacklist', { preHandler: admin, schema: { body: SubtitleBlacklistRequest, response: { 201: SubtitleBlacklistRecord, ...errors } } }, async (req, reply) =>
      reply.code(201).send(await service.blacklist(req.body.subtitleId, req.body.search)),
    );
    app.delete('/subtitle/blacklist/:id', { preHandler: admin, schema: { params: IdParams } }, async (req, reply) => {
      service.removeBlacklist(req.params.id);
      return reply.code(204).send();
    });
    app.delete('/subtitle/blacklist', { preHandler: admin }, async (_req, reply) => {
      service.clearBlacklist();
      return reply.code(204).send();
    });

    // ---- per-file state, scan, manual search/download/upload ------------------------------------------
    app.get('/subtitle/file', { schema: { querystring: SubtitleFileQuery, response: { 200: z.array(MediaFileSubtitles), ...errors } } }, async (req) =>
      service.fileSubtitles(req.query),
    );
    app.post('/subtitle/scan', { preHandler: admin, schema: { body: SubtitleFileQuery, response: { 200: z.array(MediaFileSubtitles), ...errors } } }, async (req) =>
      service.scan(req.body),
    );
    app.get('/subtitle/search', { preHandler: admin, schema: { querystring: SubtitleManualSearchQuery, response: { 200: SubtitleManualSearchResponse, ...errors } } }, async (req) =>
      service.manualSearch(req.query.mediaFileId, req.query.language),
    );
    app.post('/subtitle/download', { preHandler: admin, schema: { body: SubtitleDownloadRequest, response: { 200: SubtitleState, ...errors } } }, async (req) =>
      service.manualDownload(req.body.mediaFileId, req.body.key),
    );
    app.post('/subtitle/upload', { preHandler: admin, schema: { response: { 201: SubtitleState, ...errors } } }, async (req, reply) => {
      if (!req.isMultipart()) throw new SubtitlesError('VALIDATION', 'expected multipart/form-data');
      const fields: Record<string, string> = {};
      let file: { name: string; bytes: Uint8Array } | null = null;
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          const buf = await part.toBuffer();
          if (part.file.truncated) throw new SubtitlesError('VALIDATION', 'subtitle file too large');
          file = { name: part.filename, bytes: new Uint8Array(buf) };
        } else {
          fields[part.fieldname] = String(part.value);
        }
      }
      if (!file) throw new SubtitlesError('VALIDATION', 'a file part is required');
      const parsed = SubtitleUploadFields.safeParse(fields);
      if (!parsed.success) throw new SubtitlesError('VALIDATION', parsed.error.message);
      return reply.code(201).send(await service.upload(parsed.data, file.bytes, file.name));
    });
    app.post('/subtitle/sync/:id', { preHandler: admin, schema: { params: IdParams, response: { 200: SubtitleSyncResult, ...errors } } }, async (req) =>
      service.sync(req.params.id),
    );
    app.post('/subtitle/extract/:id', { preHandler: admin, schema: { params: IdParams, response: { 200: SubtitleState, ...errors } } }, async (req) =>
      service.extract(req.params.id),
    );
    app.delete('/subtitle/:id', { preHandler: admin, schema: { params: IdParams } }, async (req, reply) => {
      await service.delete(req.params.id);
      return reply.code(204).send();
    });

    app.post('/command/subtitlesearch', { preHandler: admin, schema: { body: SubtitleSearchCommand, response: { 200: SubtitleSearchCommandResult, ...errors } } }, async (req) =>
      service.commandSearch(req.body),
    );
  };
}
