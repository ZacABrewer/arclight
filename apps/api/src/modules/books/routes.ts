import { z, ZodError } from 'zod';
import type { FastifyError, FastifyPluginAsync, FastifyReply, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  AddComicSeriesRequest,
  AddEbookAuthorRequest,
  AddEbookRequest,
  BooksCalendarEntry,
  BooksCalendarQuery,
  BooksCommand,
  BooksCommandResult,
  BooksDeclineRequest,
  BooksFormatProfile,
  BooksFormatProfileInput,
  BooksGrabRequest,
  BooksGrabResult,
  BooksKind,
  BooksLibraryApp,
  BooksLibraryAppInput,
  BooksLibraryAppTestResult,
  BooksLookupQuery,
  BooksOverview,
  BooksRelease,
  BooksRequest,
  BooksRequestList,
  BooksRequestListQuery,
  BooksSettings,
  BooksWantedPage,
  BooksWantedQuery,
  ComicLookupResult,
  ComicSeries,
  ComicSeriesDetails,
  CreateBooksRequest,
  Ebook,
  EbookAuthor,
  EbookAuthorDetails,
  EbookAuthorLookupResult,
  EbookLookupResult,
  EbookSeriesDetails,
  SetMonitoredRequest,
  UpdateComicSeriesRequest,
  UpdateEbookAuthorRequest,
} from '@arclight/shared';
import type { AppContext } from '../../app.js';
import type { TokenBuckets } from '../requests/portal.js';
import { REQUESTS_ERROR_STATUS, RequestsError } from '../requests/errors.js';
import { actorOf, portalRateLimit } from '../requests/routes.js';
import { getBooksSettings, SettingsError, updateBooksSettings } from '../settings/service.js';
import type { BooksCatalogService } from './catalog.js';
import { BOOKS_ERROR_STATUS, BooksError } from './errors.js';
import type { BooksImportService } from './import.js';
import * as lib from './library.js';
import type { BooksLibraryAppsService } from './library-apps.js';
import * as profiles from './profiles.js';
import type { BooksRequestsService } from './requests.js';
import type { BooksSearchService } from './search.js';

// Books routes under /api/v1/books (docs/books.md). They always answer; `features.books` hides
// the section in the web app and switches off the jobs and listeners (index.ts). Library reads
// open to app-area users like the audiobook ones (library, wanted, calendar); requests and the
// request lookups are portal routes (every signed-in user, scoped by the requests service);
// everything else is admin-only.

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const qsBool = () => z.union([z.boolean(), z.stringbool()]);
const DeleteQuery = z.object({ deleteFiles: qsBool().default(false) });
const ReleasesQuery = z.object({ kind: BooksKind, id: z.coerce.number().int().positive() });
const LibraryAppTest = BooksLibraryAppInput.extend({ id: z.number().int().positive().optional() });

/** Everything the routes call; built per app context in index.ts. */
export interface BooksRouteServices {
  catalog: BooksCatalogService;
  search: BooksSearchService;
  imports: BooksImportService;
  libraryApps: BooksLibraryAppsService;
  requests: BooksRequestsService;
  /** Starts a command in the background. */
  command(command: BooksCommand): BooksCommandResult;
  /** Search after an add (`searchOnAdd`), in the background. */
  searchAfterAdd(kind: BooksKind, ids: readonly number[]): void;
  /** Rate limit of the portal lookups for callers without a session (none in tests). */
  portalLimiter?: TokenBuckets;
}

export function booksErrorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof BooksError) return reply.code(BOOKS_ERROR_STATUS[err.code]).send({ error: err.message, code: err.code });
  if (err instanceof RequestsError) return reply.code(REQUESTS_ERROR_STATUS[err.code]).send({ error: err.message, code: err.code });
  if (err instanceof SettingsError || err instanceof ZodError || 'validation' in err) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
  const status = (err as { statusCode?: number }).statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) return reply.code(status).send({ error: err.message, code: 'BAD_REQUEST' });
  req.log.error({ err }, 'unhandled books error');
  return reply.code(500).send({ error: 'internal error' });
}

export const booksRoutes = (ctx: AppContext, s: BooksRouteServices): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> => {
  return async (app) => {
    const db = ctx.db;
    app.setErrorHandler(booksErrorHandler);

    const library = { config: { access: { areas: ['library' as const] } } };
    const wanted = { config: { access: { areas: ['wanted' as const] } } };
    const calendar = { config: { access: { areas: ['calendar' as const] } } };
    const portal = { config: { access: { portal: true } } } as const;
    const limit = portalRateLimit(s.portalLimiter);

    // ----------------------------------------------------------------------------- overview, settings
    app.get('/books/overview', { ...library, schema: { response: { 200: BooksOverview } } }, async () => lib.overview(db));

    app.get('/books/settings', { schema: { response: { 200: BooksSettings } } }, async () => getBooksSettings(db));
    app.put('/books/settings', { schema: { body: z.unknown(), response: { 200: BooksSettings } } }, async (req) => updateBooksSettings(db, req.body));

    // ----------------------------------------------------------------------------- catalogue lookups
    app.get('/books/lookup/authors', { schema: { querystring: BooksLookupQuery, response: { 200: EbookAuthorLookupResult } } }, async (req) =>
      s.catalog.lookupAuthors(req.query.term),
    );
    app.get('/books/lookup/ebooks', { schema: { querystring: BooksLookupQuery, response: { 200: EbookLookupResult } } }, async (req) =>
      s.catalog.lookupBooks(req.query.term),
    );
    app.get('/books/lookup/comics', { schema: { querystring: BooksLookupQuery, response: { 200: ComicLookupResult } } }, async (req) =>
      s.catalog.lookupComics(req.query.term),
    );

    // ----------------------------------------------------------------------------- authors, ebooks, series
    app.get('/books/authors', { ...library, schema: { response: { 200: z.array(EbookAuthor) } } }, async () => lib.listAuthors(db));

    app.post('/books/authors', { schema: { body: AddEbookAuthorRequest, response: { 201: EbookAuthor } } }, async (req, reply) => {
      const author = await s.catalog.addAuthor(req.body);
      if (req.body.searchOnAdd) s.searchAfterAdd('ebook', s.search.missingOf('ebook', author.id));
      return reply.code(201).send(author);
    });

    app.get('/books/authors/:id', { ...library, schema: { params: IdParams, response: { 200: EbookAuthorDetails } } }, async (req) =>
      lib.getAuthorDetails(db, req.params.id),
    );

    app.put('/books/authors/:id', { schema: { params: IdParams, body: UpdateEbookAuthorRequest, response: { 200: EbookAuthor } } }, async (req) =>
      lib.updateAuthor(db, req.params.id, req.body),
    );

    app.delete('/books/authors/:id', { schema: { params: IdParams, querystring: DeleteQuery } }, async (req, reply) => {
      await lib.deleteAuthor(db, req.params.id, { deleteFiles: req.query.deleteFiles });
      return reply.code(204).send();
    });

    app.post('/books/ebooks', { schema: { body: AddEbookRequest, response: { 201: Ebook } } }, async (req, reply) => {
      const ebook = await s.catalog.addEbook(req.body);
      if (req.body.searchOnAdd && !ebook.hasFile) s.searchAfterAdd('ebook', [ebook.id]);
      return reply.code(201).send(ebook);
    });

    // Before /books/ebooks/:id so "monitor" is not read as an id (PUT has no :id twin anyway).
    app.put('/books/ebooks/monitor', { schema: { body: SetMonitoredRequest } }, async (req, reply) => {
      lib.setEbooksMonitored(db, req.body.ids, req.body.monitored);
      return reply.code(204).send();
    });

    app.get('/books/ebooks/:id', { ...library, schema: { params: IdParams, response: { 200: Ebook } } }, async (req) => lib.getEbook(db, req.params.id));

    app.delete('/books/ebooks/:id', { schema: { params: IdParams, querystring: DeleteQuery } }, async (req, reply) => {
      await lib.deleteEbook(db, req.params.id, { deleteFiles: req.query.deleteFiles });
      return reply.code(204).send();
    });

    app.get('/books/series/:id', { ...library, schema: { params: IdParams, response: { 200: EbookSeriesDetails } } }, async (req) =>
      lib.getSeriesDetails(db, req.params.id),
    );

    // ----------------------------------------------------------------------------- comics
    app.get('/books/comics', { ...library, schema: { response: { 200: z.array(ComicSeries) } } }, async () => lib.listComicSeries(db));

    app.post('/books/comics', { schema: { body: AddComicSeriesRequest, response: { 201: ComicSeries } } }, async (req, reply) => {
      const series = await s.catalog.addComicSeries(req.body);
      if (req.body.searchOnAdd) s.searchAfterAdd('comic', s.search.missingOf('comic', series.id));
      return reply.code(201).send(series);
    });

    app.get('/books/comics/:id', { ...library, schema: { params: IdParams, response: { 200: ComicSeriesDetails } } }, async (req) =>
      lib.getComicDetails(db, req.params.id),
    );

    app.put('/books/comics/:id', { schema: { params: IdParams, body: UpdateComicSeriesRequest, response: { 200: ComicSeries } } }, async (req) =>
      lib.updateComicSeries(db, req.params.id, req.body),
    );

    app.delete('/books/comics/:id', { schema: { params: IdParams, querystring: DeleteQuery } }, async (req, reply) => {
      await lib.deleteComicSeries(db, req.params.id, { deleteFiles: req.query.deleteFiles });
      return reply.code(204).send();
    });

    app.put('/books/issues/monitor', { schema: { body: SetMonitoredRequest } }, async (req, reply) => {
      lib.setIssuesMonitored(db, req.body.ids, req.body.monitored);
      return reply.code(204).send();
    });

    app.delete('/books/files/:id', { schema: { params: IdParams } }, async (req, reply) => {
      await s.imports.deleteFile(req.params.id);
      return reply.code(204).send();
    });

    // ----------------------------------------------------------------------------- wanted, calendar
    app.get('/books/wanted', { ...wanted, schema: { querystring: BooksWantedQuery, response: { 200: BooksWantedPage } } }, async (req) =>
      lib.wanted(db, req.query),
    );
    app.get('/books/calendar', { ...calendar, schema: { querystring: BooksCalendarQuery, response: { 200: z.array(BooksCalendarEntry) } } }, async (req) =>
      lib.calendar(db, req.query),
    );

    // ----------------------------------------------------------------------------- releases, commands
    app.get('/books/releases', { schema: { querystring: ReleasesQuery, response: { 200: z.array(BooksRelease) } } }, async (req) =>
      s.search.interactive(req.query.kind, req.query.id),
    );
    app.post('/books/releases/grab', { schema: { body: BooksGrabRequest, response: { 200: BooksGrabResult } } }, async (req) => s.search.grab(req.body));

    app.post('/books/command', { schema: { body: BooksCommand, response: { 202: BooksCommandResult } } }, async (req, reply) =>
      reply.code(202).send(s.command(req.body)),
    );

    // ----------------------------------------------------------------------------- format profiles
    app.get('/books/profiles', { schema: { response: { 200: z.array(BooksFormatProfile) } } }, async () => profiles.listFormatProfiles(db));
    app.post('/books/profiles', { schema: { body: BooksFormatProfileInput, response: { 201: BooksFormatProfile } } }, async (req, reply) =>
      reply.code(201).send(profiles.createFormatProfile(db, req.body)),
    );
    app.put('/books/profiles/:id', { schema: { params: IdParams, body: BooksFormatProfileInput, response: { 200: BooksFormatProfile } } }, async (req) =>
      profiles.updateFormatProfile(db, req.params.id, req.body),
    );
    app.delete('/books/profiles/:id', { schema: { params: IdParams } }, async (req, reply) => {
      profiles.deleteFormatProfile(db, req.params.id);
      return reply.code(204).send();
    });

    // ----------------------------------------------------------------------------- library apps
    app.get('/books/library-apps', { schema: { response: { 200: z.array(BooksLibraryApp) } } }, async () => s.libraryApps.list());
    app.post('/books/library-apps', { schema: { body: BooksLibraryAppInput, response: { 201: BooksLibraryApp } } }, async (req, reply) =>
      reply.code(201).send(s.libraryApps.create(req.body)),
    );
    // Before /books/library-apps/:id; POST has no :id twin, so the order is for readers only.
    app.post('/books/library-apps/test', { schema: { body: LibraryAppTest, response: { 200: BooksLibraryAppTestResult } } }, async (req) => {
      const { id, ...input } = req.body;
      return s.libraryApps.test(input, id);
    });
    app.put('/books/library-apps/:id', { schema: { params: IdParams, body: BooksLibraryAppInput, response: { 200: BooksLibraryApp } } }, async (req) =>
      s.libraryApps.update(req.params.id, req.body),
    );
    app.delete('/books/library-apps/:id', { schema: { params: IdParams } }, async (req, reply) => {
      s.libraryApps.delete(req.params.id);
      return reply.code(204).send();
    });

    // ----------------------------------------------------------------------------- requests (portal)
    app.get('/books/requests', { ...portal, schema: { querystring: BooksRequestListQuery, response: { 200: BooksRequestList } } }, async (req) =>
      s.requests.list(actorOf(req), req.query),
    );
    app.post('/books/requests', { ...portal, schema: { body: CreateBooksRequest, response: { 201: BooksRequest } } }, async (req, reply) =>
      reply.code(201).send(await s.requests.create(actorOf(req), req.body)),
    );
    app.get('/books/requests/lookup/ebooks', { ...portal, preHandler: limit, schema: { querystring: BooksLookupQuery, response: { 200: EbookLookupResult } } }, async (req) =>
      s.catalog.lookupBooks(req.query.term),
    );
    app.get('/books/requests/lookup/comics', { ...portal, preHandler: limit, schema: { querystring: BooksLookupQuery, response: { 200: ComicLookupResult } } }, async (req) =>
      s.catalog.lookupComics(req.query.term),
    );
    app.post('/books/requests/:id/approve', { ...portal, schema: { params: IdParams, response: { 200: BooksRequest } } }, async (req) =>
      s.requests.approve(actorOf(req), req.params.id),
    );
    app.post('/books/requests/:id/decline', { ...portal, schema: { params: IdParams, body: BooksDeclineRequest.optional(), response: { 200: BooksRequest } } }, async (req) =>
      s.requests.decline(actorOf(req), req.params.id, req.body?.reason),
    );
    app.delete('/books/requests/:id', { ...portal, schema: { params: IdParams } }, async (req, reply) => {
      s.requests.delete(actorOf(req), req.params.id);
      return reply.code(204).send();
    });
  };
};
