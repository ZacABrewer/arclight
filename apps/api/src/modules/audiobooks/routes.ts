import { z } from 'zod';
import type { FastifyError, FastifyPluginAsync, FastifyReply, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { MetadataError, type CatalogAuthor, type CatalogBook, type MetadataErrorCode } from '@arclight/metadata';
import {
  AddAuthorRequest,
  AddBookRequest,
  Asin,
  Author,
  AuthorDetails,
  AuthorListQuery,
  AuthorListResponse,
  AuthorLookupQuery,
  AuthorSearchResponse,
  Book,
  BookDetails,
  BookListQuery,
  BookListResponse,
  BookLookupQuery,
  BookSearchResponse,
  BookSeriesDetails,
  BookSeriesListQuery,
  BookSeriesListResponse,
  BulkAuthorUpdateRequest,
  BulkBookMonitorRequest,
  DeleteAuthorQuery,
  DeleteBookQuery,
  ErrorResponse,
  UpdateAuthorRequest,
  UpdateBookRequest,
  WantedBooksPage,
  WantedBooksQuery,
  type AuthorSearchResult,
  type BookSearchResult,
} from '@arclight/shared';
import type { AppContext } from '../../app.js';
import { LibraryError } from '../library/index.js';
import { httpStatusFor } from '../library/errors.js';
import { audiobookMetadataFor, audiobookRefresherFor, type AudiobookRefresher } from '../metadata/index.js';
import { ProfilesService } from '../profiles/index.js';
import * as svc from './service.js';

// Audiobook routes under /api/v1 (design 4.4, 5.2). All of them answer 404 AUDIOBOOKS_DISABLED
// while `features.audiobooks` is off. Reads open to app-area users exactly where the matching
// music reads are (library, wanted); everything else is admin-only. POST /command and
// GET /audiofile are shared with music (audio-routes.ts).

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const Empty = z.null();

const metadataStatus: Record<MetadataErrorCode, number> = {
  'not-found': 404,
  'rate-limited': 503,
  unreachable: 503,
  'bad-response': 502,
  unauthorized: 502,
};

export class AudiobooksDisabled extends Error {
  readonly code = 'AUDIOBOOKS_DISABLED';
  constructor() {
    super('audiobooks are not enabled (Settings → Features)');
  }
}

/** Error mapping shared by the audiobook and audio routes. */
export function audioErrorHandler(label: string) {
  return (err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) => {
    const coded = err as { code?: unknown };
    if (err instanceof AudiobooksDisabled || coded.code === 'MUSIC_DISABLED') return reply.code(404).send({ error: err.message, code: String(coded.code) });
    if (err instanceof LibraryError) return reply.code(httpStatusFor(err.code)).send({ error: err.message, code: err.code });
    if (err instanceof MetadataError) {
      return reply.code(metadataStatus[err.code]).send({ error: err.message, code: `METADATA_${err.code.toUpperCase().replace(/-/g, '_')}` });
    }
    if ('validation' in err) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) return reply.code(status).send({ error: err.message, code: 'BAD_REQUEST' });
    req.log.error({ err }, `unhandled ${label} error`);
    return reply.code(500).send({ error: 'internal error' });
  };
}

function images(url: string | undefined, coverType: 'cover' | 'headshot') {
  return url ? [{ coverType, url, remoteUrl: url }] : [];
}

function toAuthorResult(a: CatalogAuthor, known: Map<string, number>): AuthorSearchResult {
  const asin = a.asin?.toUpperCase() ?? null;
  const olid = a.olid?.toUpperCase() ?? null;
  return {
    asin,
    olAuthorId: olid,
    name: a.name,
    overview: a.description ?? null,
    genres: a.genres,
    images: images(a.image, 'headshot'),
    bookCount: null,
    topBooks: [],
    source: a.sources[0] ?? 'audnexus',
    authorId: (asin ? known.get(asin) : undefined) ?? (olid ? known.get(olid) : undefined) ?? null,
  };
}

function toBookResult(db: AppContext['db'], b: CatalogBook, known: Map<string, { id: number; authorId: number }>): BookSearchResult {
  const asin = b.asin?.toUpperCase() ?? null;
  const credits = b.authors.map((c) => {
    const { name } = svc.creditRole(c.name);
    const hit = svc.findAuthorForCredit(db, { name, asin: c.asin ?? null, olid: c.olid ?? null });
    return { name, asin: c.asin ?? null, authorId: hit?.id ?? null };
  });
  const inLibrary = asin ? known.get(asin) : undefined;
  return {
    asin,
    isbn13: b.isbn ?? b.isbns[0] ?? null,
    olWorkId: b.olWorkId ?? null,
    region: b.region ?? null,
    title: b.title,
    subtitle: b.subtitle ?? null,
    authors: credits,
    narrators: b.narrators,
    publisher: b.publisher ?? null,
    language: b.language ?? null,
    releaseDate: b.releaseDate ?? null,
    year: b.releaseDate ? Number(b.releaseDate.slice(0, 4)) || null : null,
    runtimeMinutes: b.runtimeMinutes ?? null,
    formatType: b.formatType ?? null,
    series: b.series.map((s) => ({ name: s.name, asin: s.asin ?? null, position: s.position ?? null })),
    images: images(b.images.cover, 'cover'),
    source: b.sources[0] ?? 'audible',
    bookId: inLibrary?.id ?? null,
    authorId: inLibrary?.authorId ?? credits.find((c) => c.authorId != null)?.authorId ?? null,
  };
}

export const audiobookRoutes = (ctx: AppContext): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> => {
  return async (app) => {
    const db = ctx.db;

    app.setErrorHandler(audioErrorHandler('audiobook'));

    // The feature flag, checked per request so turning it on needs no restart.
    app.addHook('onRequest', async () => {
      if (!svc.audiobooksEnabled(db)) throw new AudiobooksDisabled();
    });

    const refresher = (): AudiobookRefresher => {
      const r = audiobookRefresherFor(ctx);
      if (!r) throw new LibraryError('VALIDATION', 'audiobook metadata is not available; the metadata module is not registered');
      return r;
    };
    const metadata = () => {
      const m = audiobookMetadataFor(ctx);
      if (!m) throw new LibraryError('VALIDATION', 'audiobook metadata is not available');
      return m;
    };
    const library = { config: { access: { areas: ['library' as const] } } };
    const wanted = { config: { access: { areas: ['wanted' as const] } } };
    const lookupErrors = { 400: ErrorResponse, 502: ErrorResponse, 503: ErrorResponse };

    // ----------------------------------------------------------------------------- authors
    app.get('/author', { ...library, schema: { querystring: AuthorListQuery, response: { 200: AuthorListResponse } } }, async (req) =>
      svc.listAuthors(db, req.query),
    );

    app.get('/author/lookup', { schema: { querystring: AuthorLookupQuery, response: { 200: AuthorSearchResponse, ...lookupErrors } } }, async (req) => {
      const term = req.query.term.replace(/^(?:asin|audible):/i, '').trim();
      const region = req.query.region ? { region: req.query.region } : {};
      const known = svc.authorIdsByForeignId(db);
      const asin = Asin.safeParse(term);
      if (asin.success && /\d/.test(asin.data)) {
        try {
          return [toAuthorResult(await metadata().authorRecord({ asin: asin.data }, { priority: 'interactive', ...region }), known)];
        } catch (err) {
          if (!(err instanceof MetadataError && err.code === 'not-found')) throw err;
        }
      }
      if (/^OL\d+A$/i.test(term)) {
        try {
          return [toAuthorResult(await metadata().authorRecord({ olid: term }, { priority: 'interactive' }), known)];
        } catch (err) {
          if (err instanceof MetadataError && err.code === 'not-found') return [];
          throw err;
        }
      }
      const found = await metadata().catalog().searchAuthors(term, { priority: 'interactive', ...region });
      return found.map((a) => toAuthorResult(a, known));
    });

    app.get('/author/:id', { ...library, schema: { params: IdParams, response: { 200: AuthorDetails, 404: ErrorResponse } } }, async (req) =>
      svc.getAuthorDetails(db, req.params.id),
    );

    app.post(
      '/author',
      { schema: { body: AddAuthorRequest, response: { 201: Author, 404: ErrorResponse, 409: ErrorResponse, ...lookupErrors } } },
      async (req, reply) => {
        const { author } = await refresher().addAuthor(req.body);
        return reply.code(201).send(author);
      },
    );

    app.put(
      '/author/editor',
      { schema: { body: BulkAuthorUpdateRequest, response: { 200: z.array(Author), 400: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse } } },
      async (req) => {
        const updated = svc.bulkUpdateAuthors(db, req.body);
        if (req.body.refresh) refresher().refresh(req.body.ids);
        return updated;
      },
    );

    app.put(
      '/author/:id',
      { schema: { params: IdParams, body: UpdateAuthorRequest, response: { 200: Author, 400: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse } } },
      async (req) => svc.updateAuthor(db, req.params.id, req.body),
    );

    app.delete(
      '/author/:id',
      { schema: { params: IdParams, querystring: DeleteAuthorQuery, response: { 204: Empty, 400: ErrorResponse, 404: ErrorResponse } } },
      async (req, reply) => {
        await svc.deleteAuthor(db, req.params.id, req.query);
        return reply.code(204).send(null);
      },
    );

    // ----------------------------------------------------------------------------- books
    app.get('/book', { ...library, schema: { querystring: BookListQuery, response: { 200: BookListResponse } } }, async (req) => svc.listBooks(db, req.query));

    app.get('/book/lookup', { schema: { querystring: BookLookupQuery, response: { 200: BookSearchResponse, ...lookupErrors } } }, async (req) => {
      const q = req.query;
      const region = q.region ? { region: q.region } : {};
      let found: CatalogBook[];
      if (q.asin || q.isbn) {
        try {
          found = [await metadata().getBook({ ...(q.asin ? { asin: q.asin } : {}), ...(q.isbn ? { isbn: q.isbn } : {}) }, { priority: 'interactive', ...region })];
        } catch (err) {
          if (err instanceof MetadataError && err.code === 'not-found') return [];
          throw err;
        }
      } else {
        const query = q.term ?? { ...(q.title ? { title: q.title } : {}), ...(q.author ? { author: q.author } : {}) };
        found = await metadata().catalog().searchBooks(query, { priority: 'interactive', ...region });
      }
      const known = svc.booksByAsin(
        db,
        found.flatMap((b) => (b.asin ? [b.asin] : [])),
      );
      return found.map((b) => toBookResult(db, b, known));
    });

    app.get('/book/:id', { ...library, schema: { params: IdParams, response: { 200: BookDetails, 404: ErrorResponse } } }, async (req) =>
      svc.getBookDetails(db, req.params.id),
    );

    app.post(
      '/book',
      { schema: { body: AddBookRequest, response: { 201: Book, 404: ErrorResponse, 409: ErrorResponse, ...lookupErrors } } },
      async (req, reply) => {
        const { book } = await refresher().addBook(req.body);
        return reply.code(201).send(book);
      },
    );

    app.put('/book/monitor', { schema: { body: BulkBookMonitorRequest, response: { 200: BookListResponse, 404: ErrorResponse } } }, async (req) =>
      svc.bulkSetBooksMonitored(db, req.body.bookIds, req.body.monitored),
    );

    app.put('/book/:id', { schema: { params: IdParams, body: UpdateBookRequest, response: { 200: Book, 404: ErrorResponse } } }, async (req) =>
      svc.updateBookFlags(db, req.params.id, req.body),
    );

    app.delete(
      '/book/:id',
      { schema: { params: IdParams, querystring: DeleteBookQuery, response: { 204: Empty, 400: ErrorResponse, 404: ErrorResponse } } },
      async (req, reply) => {
        await svc.deleteBook(db, req.params.id, req.query);
        return reply.code(204).send(null);
      },
    );

    // ----------------------------------------------------------------------------- series
    app.get('/bookseries', { ...library, schema: { querystring: BookSeriesListQuery, response: { 200: BookSeriesListResponse } } }, async (req) =>
      svc.listSeries(db, req.query),
    );

    app.get('/bookseries/:id', { ...library, schema: { params: IdParams, response: { 200: BookSeriesDetails, 404: ErrorResponse } } }, async (req) =>
      svc.getSeriesDetails(db, req.params.id),
    );

    // ----------------------------------------------------------------------------- wanted
    app.get('/wanted/missing/books', { ...wanted, schema: { querystring: WantedBooksQuery, response: { 200: WantedBooksPage } } }, async (req) =>
      svc.listMissingBooks(db, req.query),
    );
    app.get('/wanted/cutoff/books', { ...wanted, schema: { querystring: WantedBooksQuery, response: { 200: WantedBooksPage } } }, async (req) =>
      svc.listCutoffUnmetBooks(db, req.query, new ProfilesService({ db }).listQualityProfiles('audiobook')),
    );
  };
};
