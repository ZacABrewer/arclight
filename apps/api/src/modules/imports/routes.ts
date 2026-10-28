import {
  AudioManualImportItem,
  AudioManualImportQuery,
  AudioManualImportRequest,
  AudioManualImportResult,
  FileSystemEntry,
  FileSystemListing,
  FileSystemMkdirRequest,
  FileSystemQuery,
  ImportsErrorResponse,
  ManualImportItem,
  ManualImportQuery,
  ManualImportRequest,
  ManualImportResult,
  MediaManagementSettings,
  NamingConfig,
  NamingSamples,
  RenameCommand,
  RenamePreviewItem,
  RenamePreviewQuery,
  RenameResult,
  RescanCommand,
  RescanResult,
} from '@arclight/shared';
import { NamingFormatError } from '@arclight/organizer';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ImportsError, type ImportsErrorCode } from './errors.js';
import type { ImportsService } from './service.js';

const statusFor: Record<ImportsErrorCode, number> = { NOT_FOUND: 404, VALIDATION: 400, CONFLICT: 409 };
const errors = { 400: ImportsErrorResponse, 404: ImportsErrorResponse, 409: ImportsErrorResponse };

export function importsRoutes(service: ImportsService): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof ImportsError) return reply.code(statusFor[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof NamingFormatError) return reply.code(400).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error({ err }, 'unhandled imports error');
      return reply.code(500).send({ error: 'internal error' });
    });

    // ---- manual import ----------------------------------------------------------------
    app.get(
      '/manualimport',
      { schema: { querystring: ManualImportQuery, response: { 200: z.array(ManualImportItem), ...errors } } },
      async (req) => service.listManualImport(req.query),
    );
    app.post(
      '/manualimport',
      { schema: { body: ManualImportRequest, response: { 200: ManualImportResult, ...errors } } },
      async (req) => service.executeManualImport(req.body),
    );

    // Audio mode (music): same flow, per-file items carry artist/album/edition/track ids.
    app.get(
      '/manualimport/audio',
      { schema: { querystring: AudioManualImportQuery, response: { 200: z.array(AudioManualImportItem), ...errors } } },
      async (req) => service.listAudioManualImport(req.query),
    );
    app.post(
      '/manualimport/audio',
      { schema: { body: AudioManualImportRequest, response: { 200: AudioManualImportResult, ...errors } } },
      async (req) => service.executeAudioManualImport(req.body),
    );

    // ---- rename -----------------------------------------------------------------------
    app.get(
      '/rename',
      { schema: { querystring: RenamePreviewQuery, response: { 200: z.array(RenamePreviewItem), ...errors } } },
      async (req) => service.previewRename(req.query),
    );
    app.post(
      '/command/rename',
      { schema: { body: RenameCommand, response: { 200: RenameResult, ...errors } } },
      async (req) => service.executeRename(req.body),
    );

    // ---- rescan -----------------------------------------------------------------------
    app.post(
      '/command/rescan',
      { schema: { body: RescanCommand, response: { 200: RescanResult, ...errors } } },
      async (req) => {
        if (req.body.seriesId !== undefined) return service.rescanSeries(req.body.seriesId);
        if (req.body.movieId !== undefined) return service.rescanMovie(req.body.movieId);
        const series = await service.rescanAll('series');
        const movies = await service.rescanAll('movie');
        return {
          scanned: series.scanned + movies.scanned,
          added: [...series.added, ...movies.added],
          removed: [...series.removed, ...movies.removed],
          unmapped: [...series.unmapped, ...movies.unmapped],
        };
      },
    );

    // ---- settings ---------------------------------------------------------------------
    app.get('/settings/mediamanagement', { schema: { response: { 200: MediaManagementSettings } } }, async () =>
      service.getMediaManagement(),
    );
    app.put(
      '/settings/mediamanagement',
      { schema: { body: MediaManagementSettings, response: { 200: MediaManagementSettings, ...errors } } },
      async (req) => service.updateMediaManagement(req.body),
    );
    app.get('/settings/naming', { schema: { response: { 200: NamingConfig } } }, async () => service.getNaming());
    app.put(
      '/settings/naming',
      { schema: { body: NamingConfig, response: { 200: NamingConfig, ...errors } } },
      async (req) => service.updateNaming(req.body),
    );
    app.get('/settings/naming/samples', { schema: { response: { 200: NamingSamples } } }, async () => service.namingSamples());

    // ---- filesystem -------------------------------------------------------------------
    app.get(
      '/filesystem',
      { schema: { querystring: FileSystemQuery, response: { 200: FileSystemListing, ...errors } } },
      async (req) => service.listFileSystem(req.query),
    );
    app.post(
      '/filesystem/mkdir',
      { schema: { body: FileSystemMkdirRequest, response: { 201: FileSystemEntry, ...errors } } },
      async (req, reply) => reply.code(201).send(await service.makeDirectory(req.body)),
    );
  };
}
