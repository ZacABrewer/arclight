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
import { SOFTWARE_CAPS } from './hls/pipeline.js';
import { EncoderDetector, MediaCache, BackgroundMediaLimiter, type EncoderDetectorOptions, type MediaCacheOptions } from './video-stream.js';
import { SegmentService, type SegmentServiceOptions } from './segments.js';
import { segmentRoutes } from './segments-routes.js';
import { TrickplayService, type TrickplayOptions } from './trickplay.js';
import { trickplayRoutes } from './trickplay-routes.js';
import { locateFfprobe } from '../media-analysis/index.js';
import { CapacityModel } from './hls/capacity.js';
import { HlsSessions, hlsCacheRoot, type HlsSessionsOptions } from './hls/jobs.js';
import { KeyframeIndexer, type KeyframeIndexerOptions } from './hls/keyframes.js';
import { hlsRoutes, type HlsDeps } from './hls-routes.js';

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
      // A paused progressive stream sits idle for as long as the player is paused (0.24: 30 min).
      stallMs: 30 * 60_000,
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

/** Scrub thumbnails and intro / credits detection jobs. */
export const PLAYER_TRICKPLAY_JOB = 'player-trickplay';
export const PLAYER_SEGMENTS_JOB = 'player-segments';
/** A season is scanned this long after its last file import (a season pack lands as many imports). */
const SEGMENT_SCAN_DELAY_MS = 10 * 60 * 1000;

interface BackgroundServices {
  trickplay: TrickplayService;
  segments: SegmentService;
}
const backgroundServices = new WeakMap<AppContext, BackgroundServices>();

/** True while every live video slot is in use: background ffmpeg work waits. */
const liveBusyOf = (ctx: AppContext) => () => videoTranscoderFor(ctx).active >= playerSettings(ctx.db).videoMaxStreams;

/** The context's scrub-thumbnail and segment services; `opts` apply only on creation (tests). */
export function backgroundServicesFor(ctx: AppContext, opts: { trickplay?: Partial<TrickplayOptions>; segments?: Partial<SegmentServiceOptions> } = {}): BackgroundServices {
  let b = backgroundServices.get(ctx);
  if (!b) {
    const log = ctx.log.child({ component: 'player-background' });
    b = {
      trickplay: new TrickplayService({
        db: ctx.db,
        dir: join(ctx.config.configDir, 'cache', 'player', 'trickplay'),
        locate: () => locateFfmpeg(),
        // Resolved per run: tests set up the video parts after this service.
        zscale: async (bin) => (await videoPartsFor(ctx).encoders.pick(bin)).zscale,
        settings: () => playerSettings(ctx.db),
        liveBusy: liveBusyOf(ctx),
        limiter: BackgroundMediaLimiter,
        log,
        ...opts.trickplay,
      }),
      segments: new SegmentService({
        db: ctx.db,
        locate: () => locateFfmpeg(),
        settings: () => playerSettings(ctx.db),
        liveBusy: liveBusyOf(ctx),
        limiter: BackgroundMediaLimiter,
        log,
        ...opts.segments,
      }),
    };
    backgroundServices.set(ctx, b);
  }
  return b;
}

interface HlsParts {
  sessions: HlsSessions;
  keyframes: KeyframeIndexer;
}
const hlsParts = new WeakMap<AppContext, HlsParts>();

/**
 * HLS sessions and keyframe indexes (0.24); `opts` apply only on creation (tests pass a fake
 * launcher and their own directories).
 */
export function hlsPartsFor(ctx: AppContext, opts: { sessions?: Partial<HlsSessionsOptions>; keyframes?: Partial<KeyframeIndexerOptions>; capacityFile?: string | null; cpus?: number } = {}): HlsParts {
  let h = hlsParts.get(ctx);
  if (!h) {
    const playerCache = join(ctx.config.configDir, 'cache', 'player');
    const log = ctx.log.child({ component: 'player-hls' });
    h = {
      keyframes: new KeyframeIndexer({ dir: join(playerCache, 'keyframes'), locateProbe: () => locateFfprobe(), limiter: BackgroundMediaLimiter, log, ...opts.keyframes }),
      sessions: new HlsSessions({
        root: () => hlsCacheRoot(ctx.config.configDir, playerSettings(ctx.db).videoCachePath),
        cacheBytes: () => playerSettings(ctx.db).videoCacheGb * 1e9,
        maxStreams: () => playerSettings(ctx.db).videoMaxStreams,
        maxPerDevice: () => playerSettings(ctx.db).videoMaxStreamsPerUser,
        legacyActive: () => videoTranscoderFor(ctx).active,
        locate: () => locateFfmpeg(),
        capacity: new CapacityModel({ file: opts.capacityFile === undefined ? join(playerCache, 'capacity.json') : opts.capacityFile, ...(opts.cpus ? { cpus: opts.cpus } : {}) }),
        log,
        ...opts.sessions,
      }),
    };
    hlsParts.set(ctx, h);
  }
  return h;
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
  const background = backgroundServicesFor(ctx);
  const hlsParts = hlsPartsFor(ctx);
  const hls: HlsDeps = {
    db: ctx.db,
    apiKey: () => auth.apiKey(),
    sessions: hlsParts.sessions,
    keyframes: hlsParts.keyframes,
    caps: async () => {
      const bin = await locateFfmpeg();
      return bin ? parts.encoders.caps(bin) : SOFTWARE_CAPS;
    },
  };
  await hlsParts.sessions.start();
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
      trickplay: background.trickplay,
      hls,
    }),
  );
  await app.register(hlsRoutes(hls));
  // My List (per household profile).
  await app.register(myListRoutes({ db: ctx.db, basePath, progress }));
  await app.register(trickplayRoutes({ db: ctx.db, basePath, apiKey: () => auth.apiKey(), service: background.trickplay }));
  await app.register(segmentRoutes({ db: ctx.db, service: background.segments, chapters: parts.chapters }));

  ctx.scheduler.register({ name: PLAYER_TRICKPLAY_JOB, cron: '20 3 * * *', handler: () => background.trickplay.nightly() });
  ctx.scheduler.register({ name: PLAYER_SEGMENTS_JOB, cron: '40 3 * * *', handler: ({ signal }) => background.segments.nightly(signal) });

  // A season whose files changed is scanned a while after the last import (media analysis has
  // filled durations by then); the nightly job covers anything missed.
  const pendingScans = new Map<number, NodeJS.Timeout>();
  const unsubscribe = ctx.bus.subscribe((event) => {
    if (event.type !== 'library' || event.action !== 'fileAdded' || event.mediaType !== 'series') return;
    if (!playerSettings(ctx.db).segmentDetection) return;
    const seriesId = event.id;
    clearTimeout(pendingScans.get(seriesId));
    const timer = setTimeout(() => {
      pendingScans.delete(seriesId);
      background.segments
        .changedSeasons(seriesId)
        .then((seasons) => {
          for (const s of seasons) background.segments.enqueue(s.seriesId, s.seasonNumber, false);
        })
        .catch((err: unknown) => ctx.log.warn({ err, seriesId }, 'could not queue intro and credits detection'));
    }, SEGMENT_SCAN_DELAY_MS);
    timer.unref?.();
    pendingScans.set(seriesId, timer);
  });
  app.addHook('onClose', async () => {
    unsubscribe();
    for (const t of pendingScans.values()) clearTimeout(t);
    pendingScans.clear();
    background.segments.stop();
    background.trickplay.stop();
    await hlsParts.sessions.close();
  });
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
