import { z } from 'zod';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AudioFile, AudiobookCommand, ErrorResponse, Job, MusicCommand } from '@arclight/shared';
import type { AppContext } from '../../app.js';
import { LibraryError } from '../library/index.js';
import { audiobookRefresherFor, musicRefresherFor } from '../metadata/index.js';
import { clearAudioGrabOverride, musicEnabled, listAudioFiles } from '../music/service.js';
import { AudiobooksDisabled, audioErrorHandler } from './routes.js';
import { audiobooksEnabled, listAudiobookFiles } from './service.js';

// The two audio routes music and audiobooks share, so neither module registers them twice:
//
// * POST /command takes a music command (RefreshArtist, RescanArtist, ArtistSearch, AlbumSearch)
//   or an audiobook command (RefreshAuthor, RescanAuthor, AuthorSearch, BookSearch) and answers
//   202 with the started job. Each kind is gated by its own feature flag (404 MUSIC_DISABLED /
//   AUDIOBOOKS_DISABLED).
// * GET /audiofile lists music files by `artistId` / `albumId` or audiobook files by `authorId` /
//   `bookId` (one kind per request), gated the same way.
// * DELETE /audiofile/:id/grab-override ("Allow upgrades again") clears the "Grab anyway"
//   override of the file's whole album / book and answers with the files it changed.

const AUDIOBOOK_COMMANDS = new Set<string>(AudiobookCommand.options.map((o) => o.shape.name.value));

/** Every audio command; the name picks the module. */
export const AudioCommand = z.discriminatedUnion('name', [...MusicCommand.options, ...AudiobookCommand.options]);
export type AudioCommand = z.infer<typeof AudioCommand>;

/** GET /audiofile: music (`artistId`, `albumId`) or audiobook (`authorId`, `bookId`) filters. */
export const AudioFileQuery = z
  .object({
    artistId: z.coerce.number().int().optional(),
    albumId: z.coerce.number().int().optional(),
    authorId: z.coerce.number().int().optional(),
    bookId: z.coerce.number().int().optional(),
  })
  .refine((q) => q.artistId !== undefined || q.albumId !== undefined || q.authorId !== undefined || q.bookId !== undefined, {
    message: 'artistId, albumId, authorId or bookId is required',
  })
  .refine((q) => !((q.artistId !== undefined || q.albumId !== undefined) && (q.authorId !== undefined || q.bookId !== undefined)), {
    message: 'filter by music (artistId/albumId) or audiobook (authorId/bookId) ids, not both',
  });

class MusicDisabled extends Error {
  readonly code = 'MUSIC_DISABLED';
  constructor() {
    super('music is not enabled (Settings → Features)');
  }
}

function isAudiobookCommand(cmd: AudioCommand): cmd is AudiobookCommand {
  return AUDIOBOOK_COMMANDS.has(cmd.name);
}

export const audioRoutes = (ctx: AppContext): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> => {
  return async (app) => {
    const db = ctx.db;
    app.setErrorHandler(audioErrorHandler('audio'));

    app.post('/command', { schema: { body: AudioCommand, response: { 202: Job, 400: ErrorResponse, 404: ErrorResponse } } }, async (req, reply) => {
      const cmd = req.body;
      if (isAudiobookCommand(cmd)) {
        if (!audiobooksEnabled(db)) throw new AudiobooksDisabled();
        const r = audiobookRefresherFor(ctx);
        if (!r) throw new LibraryError('VALIDATION', 'audiobook metadata is not available; the metadata module is not registered');
        return reply.code(202).send(r.command(cmd).job);
      }
      if (!musicEnabled(db)) throw new MusicDisabled();
      const r = musicRefresherFor(ctx);
      if (!r) throw new LibraryError('VALIDATION', 'music metadata is not available; the metadata module is not registered');
      return reply.code(202).send(r.command(cmd as MusicCommand).job);
    });

    app.get(
      '/audiofile',
      { config: { access: { areas: ['library' as const] } }, schema: { querystring: AudioFileQuery, response: { 200: z.array(AudioFile) } } },
      async (req) => {
        const q = req.query;
        if (q.authorId !== undefined || q.bookId !== undefined) {
          if (!audiobooksEnabled(db)) throw new AudiobooksDisabled();
          return listAudiobookFiles(db, q);
        }
        if (!musicEnabled(db)) throw new MusicDisabled();
        return listAudioFiles(db, q as { artistId?: number; albumId?: number });
      },
    );

    app.delete(
      '/audiofile/:id/grab-override',
      { schema: { params: z.object({ id: z.coerce.number().int() }), response: { 200: z.array(AudioFile), 404: ErrorResponse } } },
      async (req) => clearAudioGrabOverride(db, req.params.id),
    );
  };
};
