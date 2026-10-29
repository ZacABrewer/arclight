import { z } from 'zod';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  ErrorResponse,
  LibraryImportLookupQuery,
  LibraryImportMatch,
  LibraryImportRequest,
  LibraryImportScan,
  LibraryImportScanRequest,
  LibraryImportScanSummary,
} from '@arclight/shared';
import type { AppContext } from '../../../app.js';
import { audioErrorHandler } from '../../audiobooks/routes.js';
import { libraryImportFor } from './library-import.js';

// Library import of existing music / audiobook folders (library-import.ts). Each route is gated
// by the flag of the media type it names (404 MUSIC_DISABLED / AUDIOBOOKS_DISABLED):
//
// * POST /libraryimport/scan starts a scan job (202 with the scan; poll GET /libraryimport/scan/:id).
// * GET /libraryimport/scan lists the kept scans (no candidates), newest first.
// * GET /libraryimport/scan/:id is one scan with its candidates; DELETE drops a finished scan.
// * GET /libraryimport/lookup searches the catalogue / MusicBrainz to change a match.
// * POST /libraryimport/import starts the import job for the chosen candidates (202 with the scan).
//
// Admin only, like adding artists and authors.

const ScanParams = z.object({ id: z.string().min(1) });
const errors = { 400: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };

export const libraryImportRoutes = (ctx: AppContext): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> => {
  return async (app) => {
    app.setErrorHandler(audioErrorHandler('library import'));
    const svc = () => libraryImportFor(ctx);

    app.post('/libraryimport/scan', { schema: { body: LibraryImportScanRequest, response: { 202: LibraryImportScan, ...errors } } }, async (req, reply) =>
      reply.code(202).send(await svc().startScan(req.body)),
    );

    app.get('/libraryimport/scan', { schema: { response: { 200: z.array(LibraryImportScanSummary) } } }, async () => svc().list());

    app.get('/libraryimport/scan/:id', { schema: { params: ScanParams, response: { 200: LibraryImportScan, ...errors } } }, async (req) =>
      svc().get(req.params.id),
    );

    app.delete('/libraryimport/scan/:id', { schema: { params: ScanParams, response: { 204: z.null(), ...errors } } }, async (req, reply) => {
      svc().remove(req.params.id);
      return reply.code(204).send(null);
    });

    app.get(
      '/libraryimport/lookup',
      { schema: { querystring: LibraryImportLookupQuery, response: { 200: z.array(LibraryImportMatch), ...errors, 502: ErrorResponse, 503: ErrorResponse } } },
      async (req) => svc().lookup(req.query),
    );

    app.post('/libraryimport/import', { schema: { body: LibraryImportRequest, response: { 202: LibraryImportScan, ...errors } } }, async (req, reply) =>
      reply.code(202).send(svc().startImport(req.body)),
    );
  };
};
