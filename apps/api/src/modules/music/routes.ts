import { z } from 'zod';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { isMbid, MetadataError, type MbArtistSearchResult, type MetadataErrorCode } from '@arclight/metadata';
import {
  AddArtistRequest,
  AlbumDetails,
  AlbumListQuery,
  AlbumListResponse,
  AlbumTypeProfile,
  AlbumTypeProfileInput,
  Artist,
  ArtistDetails,
  ArtistListQuery,
  ArtistListResponse,
  ArtistLookupQuery,
  ArtistSearchResponse,
  ArtistType,
  BulkAlbumMonitorRequest,
  BulkArtistUpdateRequest,
  DeleteArtistQuery,
  ErrorResponse,
  UpdateAlbumRequest,
  UpdateArtistRequest,
  WantedAlbumsPage,
  WantedAlbumsQuery,
  type ArtistSearchResult,
} from '@arclight/shared';
import type { AppContext } from '../../app.js';
import { LibraryError } from '../library/index.js';
import { httpStatusFor } from '../library/errors.js';
import { musicMetadataFor, musicRefresherFor, type MusicRefresher } from '../metadata/index.js';
import { ProfilesService } from '../profiles/index.js';
import * as svc from './service.js';

// Music routes under /api/v1 (design 4.3, 5.1). All of them answer 404 MUSIC_DISABLED while
// `features.music` is off. Reads open to app-area users exactly where the matching series/movie
// reads are (library, wanted); everything else is admin-only.

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const Empty = z.null();

const metadataStatus: Record<MetadataErrorCode, number> = {
  'not-found': 404,
  'rate-limited': 503,
  unreachable: 503,
  'bad-response': 502,
  unauthorized: 502,
};

class MusicDisabled extends Error {
  readonly code = 'MUSIC_DISABLED';
}

function toSearchResult(r: MbArtistSearchResult, artistId: number | undefined): ArtistSearchResult {
  return {
    mbArtistId: r.mbid,
    name: r.name,
    sortName: r.sortName,
    disambiguation: r.disambiguation ?? null,
    artistType: r.type ? (ArtistType.safeParse(r.type).data ?? 'Other') : null,
    country: r.country ?? null,
    beginDate: r.beginDate ?? null,
    endDate: r.endDate ?? null,
    ended: r.status === 'ended',
    genres: [],
    images: [],
    score: Math.max(0, Math.min(100, Math.round(r.score))),
    artistId: artistId ?? null,
  };
}

export const musicRoutes = (ctx: AppContext): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> => {
  return async (app) => {
    const db = ctx.db;

    app.setErrorHandler((err, req, reply) => {
      if (err instanceof MusicDisabled) return reply.code(404).send({ error: err.message, code: err.code });
      if (err instanceof LibraryError) return reply.code(httpStatusFor(err.code)).send({ error: err.message, code: err.code });
      if (err instanceof MetadataError) {
        return reply.code(metadataStatus[err.code]).send({ error: err.message, code: `METADATA_${err.code.toUpperCase().replace(/-/g, '_')}` });
      }
      if (err instanceof Error && 'validation' in err) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      const status = (err as { statusCode?: number }).statusCode;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        return reply.code(status).send({ error: err instanceof Error ? err.message : 'bad request', code: 'BAD_REQUEST' });
      }
      req.log.error({ err }, 'unhandled music error');
      return reply.code(500).send({ error: 'internal error' });
    });

    // The feature flag, checked per request so turning it on needs no restart.
    app.addHook('onRequest', async () => {
      if (!svc.musicEnabled(db)) throw new MusicDisabled('music is not enabled (Settings → Features)');
    });

    const refresher = (): MusicRefresher => {
      const r = musicRefresherFor(ctx);
      if (!r) throw new LibraryError('VALIDATION', 'music metadata is not available; the metadata module is not registered');
      return r;
    };
    const library = { config: { access: { areas: ['library' as const] } } };
    const wanted = { config: { access: { areas: ['wanted' as const] } } };

    // ----------------------------------------------------------------------------- artists
    app.get('/artist', { ...library, schema: { querystring: ArtistListQuery, response: { 200: ArtistListResponse } } }, async (req) =>
      svc.listArtists(db, req.query),
    );

    app.get(
      '/artist/lookup',
      { schema: { querystring: ArtistLookupQuery, response: { 200: ArtistSearchResponse, 400: ErrorResponse, 502: ErrorResponse, 503: ErrorResponse } } },
      async (req) => {
        const service = musicMetadataFor(ctx);
        if (!service) throw new LibraryError('VALIDATION', 'music metadata is not available');
        const client = service.musicBrainz();
        const term = req.query.term.replace(/^(?:mbid|musicbrainz|lidarr):/i, '').trim();
        let results: MbArtistSearchResult[];
        if (isMbid(term)) {
          try {
            const a = await client.getArtist(term, { priority: 'interactive' });
            results = [{ ...a, score: 100 }];
          } catch (err) {
            if (err instanceof MetadataError && err.code === 'not-found') return [];
            throw err;
          }
        } else {
          results = (await client.searchArtists(term, { priority: 'interactive', limit: 25 })).results;
        }
        const known = svc.artistIdsByMbid(
          db,
          results.map((r) => r.mbid),
        );
        return results.map((r) => toSearchResult(r, known.get(r.mbid.toLowerCase())));
      },
    );

    app.get('/artist/:id', { ...library, schema: { params: IdParams, response: { 200: ArtistDetails, 404: ErrorResponse } } }, async (req) =>
      svc.getArtistDetails(db, req.params.id),
    );

    app.post(
      '/artist',
      { schema: { body: AddArtistRequest, response: { 201: Artist, 400: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 502: ErrorResponse, 503: ErrorResponse } } },
      async (req, reply) => {
        const { artist } = await refresher().addArtist(req.body);
        return reply.code(201).send(artist);
      },
    );

    app.put(
      '/artist/editor',
      { schema: { body: BulkArtistUpdateRequest, response: { 200: z.array(Artist), 400: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse } } },
      async (req) => {
        const updated = svc.bulkUpdateArtists(db, req.body);
        if (req.body.refresh) refresher().refresh(req.body.ids);
        return updated;
      },
    );

    app.put(
      '/artist/:id',
      { schema: { params: IdParams, body: UpdateArtistRequest, response: { 200: Artist, 400: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse } } },
      async (req) => svc.updateArtist(db, req.params.id, req.body),
    );

    app.delete(
      '/artist/:id',
      { schema: { params: IdParams, querystring: DeleteArtistQuery, response: { 204: Empty, 400: ErrorResponse, 404: ErrorResponse } } },
      async (req, reply) => {
        await svc.deleteArtist(db, req.params.id, req.query);
        return reply.code(204).send(null);
      },
    );

    // ----------------------------------------------------------------------------- albums
    app.get('/album', { ...library, schema: { querystring: AlbumListQuery, response: { 200: AlbumListResponse } } }, async (req) =>
      svc.listAlbums(db, req.query),
    );

    app.get('/album/:id', { ...library, schema: { params: IdParams, response: { 200: AlbumDetails, 404: ErrorResponse } } }, async (req) =>
      svc.getAlbumDetails(db, req.params.id),
    );

    app.put(
      '/album/monitor',
      { schema: { body: BulkAlbumMonitorRequest, response: { 200: AlbumListResponse, 404: ErrorResponse } } },
      async (req) => svc.bulkSetAlbumsMonitored(db, req.body.albumIds, req.body.monitored),
    );

    app.put(
      '/album/:id',
      { schema: { params: IdParams, body: UpdateAlbumRequest, response: { 200: AlbumDetails, 400: ErrorResponse, 404: ErrorResponse, 502: ErrorResponse, 503: ErrorResponse } } },
      async (req) => {
        const { id } = req.params;
        if (req.body.selectedReleaseId !== undefined) svc.releaseRow(db, id, req.body.selectedReleaseId);
        svc.updateAlbumFlags(db, id, req.body);
        if (req.body.selectedReleaseId !== undefined) return refresher().switchRelease(id, req.body.selectedReleaseId);
        return svc.getAlbumDetails(db, id);
      },
    );

    // GET /audiofile and POST /command are shared with audiobooks: audiobooks/audio-routes.ts.

    // ----------------------------------------------------------------------------- album-type profiles
    app.get('/albumtypeprofile', { schema: { response: { 200: z.array(AlbumTypeProfile) } } }, async () => svc.listAlbumTypeProfiles(db));
    app.get('/albumtypeprofile/:id', { schema: { params: IdParams, response: { 200: AlbumTypeProfile, 404: ErrorResponse } } }, async (req) =>
      svc.getAlbumTypeProfile(db, req.params.id),
    );
    app.post(
      '/albumtypeprofile',
      { schema: { body: AlbumTypeProfileInput, response: { 201: AlbumTypeProfile, 400: ErrorResponse, 409: ErrorResponse } } },
      async (req, reply) => reply.code(201).send(svc.createAlbumTypeProfile(db, req.body)),
    );
    app.put(
      '/albumtypeprofile/:id',
      { schema: { params: IdParams, body: AlbumTypeProfileInput, response: { 200: AlbumTypeProfile, 400: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse } } },
      async (req) => svc.updateAlbumTypeProfile(db, req.params.id, req.body),
    );
    app.delete(
      '/albumtypeprofile/:id',
      { schema: { params: IdParams, response: { 204: Empty, 400: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse } } },
      async (req, reply) => {
        svc.deleteAlbumTypeProfile(db, req.params.id);
        return reply.code(204).send(null);
      },
    );

    // ----------------------------------------------------------------------------- wanted
    app.get(
      '/wanted/missing/albums',
      { ...wanted, schema: { querystring: WantedAlbumsQuery, response: { 200: WantedAlbumsPage } } },
      async (req) => svc.listMissingAlbums(db, req.query),
    );
    app.get(
      '/wanted/cutoff/albums',
      { ...wanted, schema: { querystring: WantedAlbumsQuery, response: { 200: WantedAlbumsPage } } },
      async (req) => svc.listCutoffUnmetAlbums(db, req.query, new ProfilesService({ db }).listQualityProfiles('music')),
    );
  };
};
