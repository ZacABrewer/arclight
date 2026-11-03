import type { AppContext, AppModule } from '../../app.js';
import { authServiceFor } from '../auth/index.js';
import { mediaServersServiceFor } from '../media-servers/index.js';
import { JellyfinEngine } from './jellyfin.js';
import { ProgressStore } from './progress.js';
import { playbackRoutes } from './routes.js';
import { join } from 'node:path';
import { locateFfmpeg } from '../transcode/runner.js';
import { playerSettings } from './access.js';
import { AudioTranscoder, type AudioTranscoderOptions } from './transcode.js';
import { ChapterReader } from './video-items.js';
import { videoRoutes } from './video-routes.js';
import { myListRoutes } from './my-list.js';
import { EncoderDetector, MediaCache, type EncoderDetectorOptions, type MediaCacheOptions } from './video-stream.js';

export { playbackProgress, playbackPlays, playbackQueue, playbackBookmarks, userPlaylists, userPlaylistTracks } from './schema.js';
export { decide, capabilitiesOf, type PlayerDecision } from './access.js';
export { mergeProgress, applyReport, ProgressStore } from './progress.js';
export { JellyfinEngine, matchAudioPath } from './jellyfin.js';
export { myListHas } from './my-list.js';

// Arclight's own player, phases 0 and 1 (music and audiobooks): settings section `player`,
// per-user access in users.settings.player, the /playback routes (browse, items, progress, queue,
// bookmarks, playlists) and GET /stream/audio/:fileId (ranges, live transcodes, signed links).
// Movies & TV (video-routes.ts): sessions, live video streams, subtitles, artwork and browse.
// See routes.ts for the access rules.

const transcoders = new WeakMap<AppContext, AudioTranscoder>();

/** The context's audio transcoder; `opts` apply only when this call creates it (tests pass a fake launcher). */
export function audioTranscoderFor(ctx: AppContext, opts: AudioTranscoderOptions = {}): AudioTranscoder {
  let t = transcoders.get(ctx);
  if (!t) {
    t = new AudioTranscoder(opts);
    transcoders.set(ctx, t);
  }
  return t;
}

const videoTranscoders = new WeakMap<AppContext, AudioTranscoder>();

/**
 * The context's live-video slots (remux/transcode), sized by Settings → Player (videoMaxStreams,
 * videoMaxStreamsPerUser); separate from the audio slots. `opts` apply only on creation.
 */
export function videoTranscoderFor(ctx: AppContext, opts: AudioTranscoderOptions = {}): AudioTranscoder {
  let t = videoTranscoders.get(ctx);
  if (!t) {
    t = new AudioTranscoder({
      label: 'video',
      stallMs: 60_000,
      max: () => playerSettings(ctx.db).videoMaxStreams,
      maxPerUser: () => playerSettings(ctx.db).videoMaxStreamsPerUser,
      ...opts,
    });
    videoTranscoders.set(ctx, t);
  }
  return t;
}

interface VideoParts {
  encoders: EncoderDetector;
  cache: MediaCache;
  chapters: ChapterReader;
}
const videoParts = new WeakMap<AppContext, VideoParts>();

/** Encoder detection, the subtitle/thumbnail cache and the chapter reader; `opts` apply only on creation (tests). */
export function videoPartsFor(ctx: AppContext, opts: { encoders?: EncoderDetectorOptions; cache?: Partial<MediaCacheOptions>; chapters?: ChapterReader } = {}): VideoParts {
  let p = videoParts.get(ctx);
  if (!p) {
    p = {
      encoders: new EncoderDetector(opts.encoders),
      cache: new MediaCache({ dir: join(ctx.config.configDir, 'cache', 'player'), locate: () => locateFfmpeg(), ...opts.cache }),
      chapters: opts.chapters ?? new ChapterReader(),
    };
    videoParts.set(ctx, p);
  }
  return p;
}

export const playbackModule: AppModule = (ctx) => async (app) => {
  const auth = authServiceFor(ctx);
  const servers = mediaServersServiceFor(ctx);
  const engine = new JellyfinEngine({
    servers: () => servers.stored(),
    clientFor: (config) => servers.clientFor(config),
    log: ctx.log.child({ component: 'player-engine' }),
  });
  const progress = new ProgressStore(ctx.db);
  const parts = videoPartsFor(ctx);
  const basePath = ctx.config.basePath ?? '';
  // Registered first: its static /playback/artwork/{movie,series,episode}/:id routes and the
  // video error handler live in their own encapsulated plugin.
  await app.register(
    videoRoutes({
      db: ctx.db,
      basePath,
      progress,
      apiKey: () => auth.apiKey(),
      transcoder: videoTranscoderFor(ctx),
      encoders: parts.encoders,
      cache: parts.cache,
    }),
  );
  // My List (per household profile).
  await app.register(myListRoutes({ db: ctx.db, basePath, progress }));
  await app.register(
    playbackRoutes({
      db: ctx.db,
      basePath,
      progress,
      transcoder: audioTranscoderFor(ctx),
      apiKey: () => auth.apiKey(),
      engine,
      chapters: parts.chapters,
    }),
  );
};
