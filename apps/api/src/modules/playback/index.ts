import type { AppContext, AppModule } from '../../app.js';
import { authServiceFor } from '../auth/index.js';
import { mediaServersServiceFor } from '../media-servers/index.js';
import { JellyfinEngine } from './jellyfin.js';
import { ProgressStore } from './progress.js';
import { playbackRoutes } from './routes.js';
import { AudioTranscoder, type AudioTranscoderOptions } from './transcode.js';

export { playbackProgress, playbackPlays, playbackQueue, playbackBookmarks, userPlaylists, userPlaylistTracks } from './schema.js';
export { decide, capabilitiesOf, type PlayerDecision } from './access.js';
export { mergeProgress, applyReport, ProgressStore } from './progress.js';
export { JellyfinEngine, matchAudioPath } from './jellyfin.js';

// Arclight's own player, phases 0 and 1 (music and audiobooks): settings section `player`,
// per-user access in users.settings.player, the /playback routes (browse, items, progress, queue,
// bookmarks, playlists) and GET /stream/audio/:fileId (ranges, live transcodes, signed links).
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

export const playbackModule: AppModule = (ctx) => async (app) => {
  const auth = authServiceFor(ctx);
  const servers = mediaServersServiceFor(ctx);
  const engine = new JellyfinEngine({
    servers: () => servers.stored(),
    clientFor: (config) => servers.clientFor(config),
    log: ctx.log.child({ component: 'player-engine' }),
  });
  await app.register(
    playbackRoutes({
      db: ctx.db,
      basePath: ctx.config.basePath ?? '',
      progress: new ProgressStore(ctx.db),
      transcoder: audioTranscoderFor(ctx),
      apiKey: () => auth.apiKey(),
      engine,
    }),
  );
};
