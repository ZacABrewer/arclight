import type { PluginListenerHandle } from '@capacitor/core';
import type { VideoDelivery, VideoDeviceProfile, VideoHlsInfo } from '@arclight/shared';

/**
 * The ArclightPlayer native plugin: the contract between the app's TypeScript (this package)
 * and the native code in android/ (Java/Kotlin, Media3 ExoPlayer + MediaSessionService +
 * WorkManager) and ios/ (Swift, AVQueuePlayer + MPNowPlayingInfoCenter + URLSession background
 * downloads + CarPlay).
 *
 *   registerPlugin<ArclightPlayerPlugin>('ArclightPlayer')   (src/native/index.ts)
 *
 * Rules for implementers:
 *  - Every method returns a Promise and resolves with the documented result (or `void`).
 *    Reject with `call.reject(message, code)` using a code from `PlayerErrorCode`.
 *    A method a platform does not support yet rejects with Capacitor's `call.unimplemented()`
 *    (code `UNIMPLEMENTED`); the JS layer then falls back (see src/native/index.ts).
 *  - Times are integer milliseconds. `positionMs` in events and `getState()` is the offset
 *    inside the CURRENT TRACK (one file), not the item's timeline; JS maps it with
 *    `NativeTrack.itemOffsetMs`.
 *  - The JS layer owns the play queue, shuffle order, progress reporting and the server API.
 *    Native owns the audio session, background playback, the lock screen / notification /
 *    headset / car controls, downloads and casting. Native never calls the Arclight server
 *    itself, except to fetch the URLs (audio, artwork, downloads) that JS hands it, with the
 *    headers given alongside.
 *  - The WebView's JS may be suspended while the app is in the background (iOS especially).
 *    Native therefore keeps playing through the tracks it was given (`load` + `setUpcoming`),
 *    keeps the last car browse tree (`setBrowseTree`) and keeps downloading on its own. Events
 *    fired while JS is suspended may be coalesced: always send the latest `state`/`position`,
 *    and every `trackChanged`, `downloadCompleted` and `downloadFailed` (queue them until JS
 *    is back; Capacitor's `notifyListeners(..., retainUntilConsumed: true)` does this).
 */

// ---------------------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------------------

/** One playable file. An audiobook made of several files is several tracks in a row. */
export interface NativeTrack {
  /** Unique in the queue. The app uses `<itemKey>#<partIndex>`, e.g. "audiobook:7#2". */
  id: string;
  /** The Arclight item ("track:12" / "audiobook:7") this file belongs to. */
  itemKey: string;
  /** 'audiobook' tracks get ±30 s skip on the lock screen instead of next / previous. */
  kind: 'track' | 'audiobook';
  /** Index of this file within the item (0 for music). */
  partIndex: number;
  /** Where this file starts on the item's timeline (0 for music). */
  itemOffsetMs: number;
  /**
   * What to play: an absolute http(s) URL (a signed stream link: it carries its own auth, no
   * cookie) or a downloaded file as an absolute `file://` URL / absolute path inside the app's
   * storage (from `downloadCompleted.path`).
   */
  url: string;
  /** Extra request headers for `url` (rarely needed: signed links authenticate themselves). */
  headers?: Record<string, string>;
  /** MIME type when known ("audio/flac", "audio/mp4"): a hint for the native decoder. */
  mimeType?: string;
  /** The file's length from the library (0 when unknown); the decoder's own length wins. */
  durationMs: number;
  title: string;
  /** Artist (music) or author(s) (audiobooks). */
  artist?: string;
  /** Album (music) or series (audiobooks). */
  album?: string;
  /** Cover for the lock screen / notification / car: http(s) URL or local file. */
  artworkUrl?: string;
  /** Headers for `artworkUrl` (the server's artwork route needs `Authorization: Bearer ...`). */
  artworkHeaders?: Record<string, string>;
}

export type RepeatMode = 'off' | 'one' | 'all';

export type PlaybackStatus = 'idle' | 'loading' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error';

/** Error codes used in rejections and in `state` events. */
export type PlayerErrorCode =
  /** The stream answered 401/403 (expired link, lost access): JS fetches fresh links and reloads. */
  | 'auth'
  /** The network failed or the server answered 5xx / was unreachable. */
  | 'network'
  /** The server is out of transcode slots (HTTP 503 TRANSCODE_BUSY / 429). */
  | 'busy'
  /** The decoder cannot play this file (JS retries with a transcode). */
  | 'unsupported'
  /** A downloaded file is missing or unreadable. */
  | 'file'
  /** Bad arguments (unknown track id, index out of range). */
  | 'invalid'
  /** Anything else. */
  | 'unknown';

export interface LoadOptions {
  /** The tracks to play in order: the current item's files, then (optionally) what comes next. */
  tracks: NativeTrack[];
  /** Index in `tracks` to start at. */
  startIndex: number;
  /** Offset inside `tracks[startIndex]`. */
  startMs: number;
  /** Start playing at once (default true); false loads paused (restoring a queue). */
  autoplay?: boolean;
  /** Playback rate 0.5–3.5, pitch preserved (default 1). */
  rate?: number;
}

export interface PlayerSnapshot {
  status: PlaybackStatus;
  /** Index of the current track in the native queue; -1 when nothing is loaded. */
  index: number;
  trackId: string | null;
  /** Offset inside the current track. */
  positionMs: number;
  /** Current track's length (decoder's when known, else the track's `durationMs`). */
  durationMs: number;
  /** How far the current track is buffered (ms from its start). */
  bufferedMs: number;
  rate: number;
  volume: number;
  repeat: RepeatMode;
  /** Set when `status` is 'error'. */
  error?: { code: PlayerErrorCode; message: string; httpStatus?: number };
}

export interface StateEvent {
  status: PlaybackStatus;
  trackId: string | null;
  index: number;
  error?: { code: PlayerErrorCode; message: string; httpStatus?: number };
}

/** About once a second while playing, and once after every seek / pause. */
export interface PositionEvent {
  trackId: string;
  index: number;
  positionMs: number;
  durationMs: number;
  bufferedMs: number;
}

export interface TrackChangedEvent {
  index: number;
  trackId: string;
  previousTrackId: string | null;
  /**
   * 'auto': the previous track ended and this one started (gapless where possible);
   * 'skip': `skipTo`; 'load': `load`; 'remote': a lock-screen / car "next"/"previous" that
   * native handled itself because JS did not answer (see `remoteCommand`).
   */
  reason: 'auto' | 'skip' | 'load' | 'remote';
}

export type RemoteCommand = 'play' | 'pause' | 'togglePlayPause' | 'stop' | 'next' | 'previous' | 'seekTo' | 'skipForward' | 'skipBackward';

/**
 * A command from the lock screen, notification, headset, watch or car. Native applies
 * play / pause / seekTo / skip± itself at once (so they work while JS sleeps) and still fires
 * the event so JS can report progress. `next` / `previous` are NOT applied by native: JS
 * decides (queue, repeat, shuffle, "previous restarts after 3 s") and calls `load`/`skipTo`.
 * If JS does not react within 2 s (suspended), native moves within its own queue and fires
 * `trackChanged` with reason 'remote'.
 */
export interface RemoteCommandEvent {
  command: RemoteCommand;
  /** seekTo: target offset inside the current track. */
  positionMs?: number;
  /** skipForward / skipBackward: the interval used. */
  intervalMs?: number;
  /** Already applied natively (play, pause, seekTo, skip±). */
  handled: boolean;
}

export interface RemoteConfig {
  /** 'audiobook': show skip back / forward; 'music': show previous / next. */
  mode: 'music' | 'audiobook';
  skipBackMs: number;
  skipForwardMs: number;
}

/** Optional native sleep timer, so it fires while JS is suspended. */
export type NativeSleepTimer =
  | { kind: 'minutes'; endsAt: number; fadeMs: number }
  | { kind: 'endOfTrack'; trackId: string }
  | null;

// ---------------------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------------------

export interface DownloadRequest {
  /** Stable id chosen by JS ("track:12#0", "art:album:4"). Re-enqueueing a known id is a no-op. */
  id: string;
  /** http(s) URL (a signed link with `download=1`). */
  url: string;
  headers?: Record<string, string>;
  /**
   * File name inside the app's download folder (`<Data>/arclight-downloads/`), may contain
   * one level of sub-folder: "<serverId>/track-12-0.flac". Never a path outside that folder.
   */
  destName: string;
  /** Only download on an unmetered (Wi-Fi / Ethernet) network; wait otherwise. */
  wifiOnly: boolean;
  /** Shown in the system's download notification (Android) when given. */
  title?: string;
  /** Expected size in bytes when known (progress before the server answers; free-space check). */
  expectedBytes?: number;
}

export type DownloadStatus = 'queued' | 'waiting' | 'running' | 'paused' | 'completed' | 'failed';

export interface DownloadTask {
  id: string;
  status: DownloadStatus;
  destName: string;
  bytesWritten: number;
  /** -1 when unknown. */
  totalBytes: number;
  /** Absolute path when completed. */
  path?: string;
  /** Why it is 'waiting' (no Wi-Fi, no network) or 'failed'. */
  reason?: string;
}

export interface DownloadProgressEvent {
  id: string;
  bytesWritten: number;
  totalBytes: number;
}

export interface DownloadCompletedEvent {
  id: string;
  /** Absolute file path (play it as `NativeTrack.url`). */
  path: string;
  /** `Capacitor.convertFileSrc`-able URI, for images shown in the WebView. */
  uri: string;
  sizeBytes: number;
}

export interface DownloadFailedEvent {
  id: string;
  message: string;
  /** HTTP status when the server answered with an error. */
  httpStatus?: number;
  /** Worth retrying later (network loss) as opposed to a permanent failure (404, 403). */
  retryable: boolean;
}

export interface StorageInfo {
  /** Bytes used by `<Data>/arclight-downloads/`. */
  usedBytes: number;
  /** Free bytes on the volume. */
  freeBytes: number;
}

// ---------------------------------------------------------------------------------------
// Car (Android Auto media browser, CarPlay)
// ---------------------------------------------------------------------------------------

/**
 * One row in the car's browse UI. Node ids are opaque strings chosen by JS. The app uses:
 * root children "continue", "albums", "artists", "playlists", "books", "downloads"; then
 * "album:<id>", "artist:<id>", "playlist:<id>", "book:<id>"; playable rows carry `itemKey`.
 */
export interface BrowseNode {
  id: string;
  title: string;
  subtitle?: string;
  artworkUrl?: string;
  artworkHeaders?: Record<string, string>;
  /** Has children (opens a list). */
  browsable: boolean;
  /** Can be played (a track, a book, or a whole album/playlist). */
  playable: boolean;
  /** 0..1 progress (books, continue listening). */
  progress?: number;
}

export interface BrowseTree {
  /** Children of the root, in order. */
  root: BrowseNode[];
  /** Children of other nodes known in advance (cached for offline / JS-suspended use). */
  children: Record<string, BrowseNode[]>;
}

/** The car asks for a node's children (or a search). JS answers with `answerBrowse`. */
export interface BrowseRequestEvent {
  requestId: string;
  /** Parent node id ('root' for the top level); absent for a search. */
  parentId?: string;
  /** Voice / keyboard search ("play Abbey Road"). */
  query?: string;
}

/** The driver picked a playable node. JS builds the queue and calls `load`. */
export interface BrowsePlayEvent {
  nodeId: string;
  /** The list it was picked from (to queue the rest of an album, for example). */
  parentId?: string;
}

export interface CarConnectionEvent {
  connected: boolean;
  kind: 'android-auto' | 'carplay';
}

// ---------------------------------------------------------------------------------------
// Cast (AirPlay on iOS, Google Cast on Android)
// ---------------------------------------------------------------------------------------

export type CastStatus = 'unavailable' | 'available' | 'connecting' | 'connected';

export interface CastState {
  status: CastStatus;
  kind: 'airplay' | 'chromecast' | null;
  /** Receiver's name when connecting / connected. */
  deviceName?: string;
}

// ---------------------------------------------------------------------------------------
// Video (movies & TV; Android only in this release, iOS rejects with UNIMPLEMENTED)
// ---------------------------------------------------------------------------------------

/**
 * What this device decodes, sent to the server's video session endpoint so it picks direct
 * play, remux or transcode: the shared contract (packages/shared/src/playback.ts). Android fills
 * it from MediaCodecList (maxHeight = the largest standard height a decoder handles, so a 1080p
 * TV with a 4K decoder still direct-plays 4K), the display's HDR types and the audio output's
 * passthrough formats; phones report 2 channels.
 */
export type { VideoDeviceProfile };

export interface DeviceInfo {
  /** Google TV / Android TV (leanback / television UI mode). */
  isTv: boolean;
  videoProfile: VideoDeviceProfile;
  /** How this build takes converted video (VideoSessionRequest.deliveries); absent: progressive only. */
  deliveries?: VideoDelivery[];
}

/** A side-loaded WebVTT subtitle track (cues in media time; native adds the stream offset). */
export interface NativeVideoSubtitle {
  /** 'e<ordinal>' embedded or 'x<subtitleFileId>' external (VideoSubtitleTrack.id). */
  id: string;
  /** Absolute signed WebVTT URL. */
  url: string;
  label: string;
  language: string | null;
  default?: boolean;
  forced?: boolean;
}

export interface NativeVideoSegment {
  type: 'intro' | 'credits' | 'recap';
  /** Media time (absolute). */
  startMs: number;
  endMs: number;
}

// ---- redesign spec §1.4 ----------------------------------------------------------------

export interface NativeTrickplay {
  intervalMs: number; tileWidth: number; tileHeight: number; columns: number; rows: number; tileCount: number;
  /** Absolute signed JPEG URLs in sheet order. */
  sheets: string[];
}
export interface NativePauseInfo {
  /** Already-translated strings, built in JS. */
  title: string;
  /** "S2 · E5 · The Long Meridian" or null for movies. */
  episodeLine: string | null;
  /** Meta line pieces in order: year, certification (boxed when `boxed`), runtime, then chip labels. */
  meta: { text: string; boxed?: boolean; chip?: boolean }[];
  overview: string | null;
  logoUrl: string | null;
  backdropUrl: string | null;
}
export interface NativeEpisode {
  itemKey: string;
  episodeNumber: number;
  /** "5. The Long Meridian". */
  title: string;
  /** "45m". */
  runtime: string | null;
  overview: string | null;
  thumbUrl: string | null;
  /** 0..1, or null when unplayed. */
  progress: number | null;
  played: boolean;
}
export interface NativeEpisodeSeason { seasonNumber: number; title: string; episodes: NativeEpisode[] }
export interface NativeVideoPrefs {
  subtitleSize: 'small' | 'medium' | 'large';
  skipIntros: boolean;
  autoplayNext: boolean;
  focusStyle: 'white-frame' | 'cyan-glow';
  reduceMotion: boolean;
}
/** Colours and radii from the active theme, as #rrggbb / #aarrggbb and dp, so native matches the web layer. */
export interface NativeVideoTheme {
  bg: string; text: string; text2: string; text3: string; accent: string; primaryBg: string; primaryText: string;
  radiusButton: number; radiusTile: number;
}

export type NativeVideoString =
  | 'upNext' | 'playNow' | 'cancel' | 'nextIn' /* "Next episode in {s}s" */ | 'skipIntro' | 'skipRecap' | 'skipCredits'
  | 'endsAt' /* "Ends at {time}" */ | 'audioSubtitles' | 'audio' | 'subtitles' | 'off' | 'episodes' | 'nextEpisode'
  | 'nowPlaying';

/** The user picked another episode in the native episodes panel. JS answers with playVideo (or closeVideo). */
export interface VideoPickItemEvent { itemKey: string; fromItemKey: string; positionMs: number }

/**
 * The user changed a track in the native panel; JS keeps it for the item and saves its language
 * to ProfileSettings.audioLanguage / subtitleLanguage. `audioTrack` is always the JS-side ordinal
 * (PlayVideoOptions.audioTracks[].index), null when native could not match the file's track to one.
 */
export interface VideoTracksChangedEvent { itemKey: string; audioTrack: number | null; subtitle: string | null }

/** Cold-launch info for the launch intro (§6). Consumed once per process. */
export interface LaunchInfo {
  /** First call in this process (true once), else false. */
  coldStart: boolean;
  /** How the activity was started on that cold start. */
  source: 'launcher' | 'deep-link' | 'notification' | 'media-button' | 'car' | 'other';
  /** System "remove animations" (animator scale 0) is on. */
  systemReducedMotion: boolean;
}

export interface PlayVideoOptions {
  /** 'movie:<id>' / 'episode:<id>'; echoed in every video event. */
  itemKey: string;
  /** Absolute signed stream URL (VideoSession.url). */
  url: string;
  headers?: Record<string, string>;
  /** 'video/mp4', 'video/x-matroska', 'video/webm'. */
  mimeType: string;
  /** Media time the stream begins at (0 for direct play). Player time + this = media time. */
  streamStartMs: number;
  /** Absolute media time to start at (resume). */
  startPositionMs: number;
  /** True for direct play: native seeks itself. False: seeks become `videoSeekRequest`. */
  seekable: boolean;
  /** The whole item's length (the seek bar's scale; a remux stream does not know it). */
  durationMs: number;
  title: string;
  /** "S02 · E05 · The Long Meridian", the year, ... */
  subtitle?: string;
  /** Small technical line shown under the title ("DIRECT PLAY · 4K HDR10"). */
  streamInfo?: string;
  /** Poster / thumbnail for the media session (lock screen, remotes). */
  artworkUrl?: string;
  backdropUrl?: string;
  /** Text subtitle tracks (VideoSession.subtitles). */
  subtitles: NativeVideoSubtitle[];
  /** Subtitle id to show at start; null / absent = off. */
  selectedSubtitle?: string | null;
  /**
   * The item's audio tracks (ordinal = VideoAudioTrack.index). In direct play native lists the
   * file's own tracks and picks `selectedAudio` among them; otherwise picking another one fires
   * `videoSeekRequest` with `audioTrack`. Language, codec, channels and title let native match
   * the file's own tracks to these in direct play (so it reports `index`, not its own position).
   */
  audioTracks: { index: number; label: string; language?: string | null; codec?: string; channels?: number | null; title?: string | null }[];
  selectedAudio?: number;
  /** Chapter marks on the seek bar (media time). */
  chapters?: { title: string; startMs: number }[];
  /** Skip intro / recap / credits buttons. */
  segments?: NativeVideoSegment[];
  /** Up next: a card with a 10 s countdown at the credits (or 20 s before the end). Shows `subtitle` and `artworkUrl`. */
  next?: { itemKey: string; title: string; subtitle?: string; artworkUrl?: string };
  // ---- redesign spec §1.4 (all optional) ----
  /** Pause info screen. */
  pause?: NativePauseInfo;
  /** Scrub thumbnails; null / absent: none. */
  trickplay?: NativeTrickplay | null;
  /** Episodes panel. */
  seasons?: NativeEpisodeSeason[];
  currentSeason?: number;
  prefs?: NativeVideoPrefs;
  theme?: NativeVideoTheme;
  /** Overlay strings, translated in JS (R.string.video_* stay as fallbacks). */
  strings?: Record<NativeVideoString, string>;
  // ---- 0.24 HLS (all optional; absent = progressive) ----
  /** 'hls': `url` is the session's master playlist, seeks stay in the player. */
  delivery?: VideoDelivery;
  sessionId?: string | null;
  hls?: VideoHlsInfo;
  /** The viewer's quality setting ('auto', 'original', '1080p', ...): Auto adapts, others pin a variant. */
  quality?: string;
  /** Last measured throughput on this network (kbit/s), the bandwidth meter's start. */
  bandwidthKbps?: number;
}

export interface ReplaceVideoStreamOptions {
  url: string;
  mimeType: string;
  streamStartMs: number;
  seekable: boolean;
  /** Absolute media time to continue at. */
  positionMs: number;
  /** New signed subtitle links (same ids); the current choice is kept. */
  subtitles?: NativeVideoSubtitle[];
  /** The audio ordinal this stream carries (after an audio change). */
  selectedAudio?: number;
  /** The "Direct play · 1080p" line for the new stream (it can change with the audio track). */
  streamInfo?: string;
  delivery?: VideoDelivery;
  sessionId?: string | null;
  hls?: VideoHlsInfo;
}

/** Playback health native adds to progress and close events (0.24). */
export interface VideoPlaybackStats {
  /** Rebuffers after startup (not seeks), counted from 500 ms. */
  stalls?: number;
  stallMs?: number;
  /** Open to first frame. */
  startupMs?: number;
  /** The bandwidth meter's estimate (kbit/s). */
  bandwidthKbps?: number;
}

/** Every 10 s while playing, on pause, and once before `videoNext`. Times are media time. */
export interface VideoProgressEvent extends VideoPlaybackStats {
  itemKey: string;
  positionMs: number;
  durationMs: number;
  paused: boolean;
}

/**
 * The user sought outside a non-seekable stream or picked another audio track in remux /
 * transcode mode. JS asks the server for a new session at `positionMs` and answers with
 * `replaceVideoStream`.
 */
export interface VideoSeekRequestEvent {
  itemKey: string;
  positionMs: number;
  /** The audio ordinal wanted (always the current one when only seeking). */
  audioTrack?: number;
  /** The subtitle shown (null = off), so the new session keeps it. */
  subtitle?: string | null;
  /** Direct play keeps stalling (Auto quality): wanted is a converted stream at `positionMs`. */
  avoidDirect?: boolean;
  /**
   * The current stream failed, showed no picture in time or stayed buffering: wanted is a safe
   * converted stream (any quality; HLS falls back to progressive). Unanswered, the player closes.
   */
  failed?: boolean;
}

/**
 * Up-next fired (countdown, "Play now", or the item ended). The video screen stays open with a
 * spinner: JS calls `playVideo` for `itemKey` (replaces in place) or `closeVideo`.
 */
export interface VideoNextEvent {
  itemKey: string;
  /**
   * The current item counts as watched (countdown, the end, "Play now" on the up-next card).
   * False for the "Next episode" button / media key before the credits. Absent: true.
   */
  completed?: boolean;
}

export interface VideoClosedEvent extends VideoPlaybackStats {
  itemKey: string;
  positionMs: number;
  durationMs: number;
  /** Reached the end (or within the credits / last 2 %). */
  completed: boolean;
  /** Set when playback failed: a `PlayerErrorCode` ('auth', 'network', 'unsupported', ...). */
  error?: string;
}

// ---------------------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------------------

export interface PlayerInfo {
  /** 'web' for the JS fallback. */
  platform: 'ios' | 'android' | 'web';
  /** Native implementation version (free text). */
  version: string;
  /** What this build implements; JS hides the rest. `video`: the native video player (Android). */
  features: { audio: boolean; downloads: boolean; car: boolean; cast: boolean; sleepTimer: boolean; video?: boolean };
}

export interface ArclightPlayerPlugin {
  /** What is implemented. A stub rejects with UNIMPLEMENTED, which JS treats as "nothing". */
  getInfo(): Promise<PlayerInfo>;

  // ---- audio -------------------------------------------------------------------------
  /** Replace the queue and start (or prepare) `tracks[startIndex]` at `startMs`. */
  load(options: LoadOptions): Promise<void>;
  /**
   * Replace every track AFTER the current one (gapless pre-roll of the next item; queue edits).
   * Does not interrupt the current track.
   */
  setUpcoming(options: { tracks: NativeTrack[] }): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  /** Seek inside the current track. */
  seek(options: { positionMs: number }): Promise<void>;
  /** Jump to another track of the native queue. */
  skipTo(options: { index: number; positionMs?: number }): Promise<void>;
  setRate(options: { rate: number }): Promise<void>;
  /** 0..1 (the app's volume slider and the sleep-timer fade). */
  setVolume(options: { volume: number }): Promise<void>;
  /** 'one' loops the current track natively; 'all' wraps the native queue. */
  setRepeat(options: { mode: RepeatMode }): Promise<void>;
  /** Optional: JS owns shuffle order and sends tracks already shuffled. */
  setShuffle?(options: { enabled: boolean }): Promise<void>;
  /** Stop, clear the queue, drop the notification / now-playing info and the audio session. */
  stop(): Promise<void>;
  getState(): Promise<PlayerSnapshot>;
  /** Lock-screen buttons for the kind playing (music: prev/next; audiobooks: skip ±). */
  configureRemote(options: RemoteConfig): Promise<void>;
  /** Update the lock-screen subtitle while playing (the audiobook chapter title). */
  setNowPlayingExtra(options: { chapterTitle: string | null }): Promise<void>;
  /** Optional native sleep timer; null cancels. Fires `sleepTimerFired` and pauses. */
  setSleepTimer?(options: { timer: NativeSleepTimer }): Promise<void>;

  // ---- downloads ---------------------------------------------------------------------
  enqueueDownload(options: DownloadRequest): Promise<{ task: DownloadTask }>;
  pauseDownload(options: { id: string }): Promise<void>;
  resumeDownload(options: { id: string }): Promise<void>;
  /** Cancel and delete the partial file. */
  cancelDownload(options: { id: string }): Promise<void>;
  /** Every task native still knows (running, waiting, failed, and completed ones not yet acknowledged). */
  listDownloads(): Promise<{ tasks: DownloadTask[] }>;
  /** Delete a downloaded file (relative `destName` or the absolute `path`). */
  deleteDownload(options: { destName: string }): Promise<void>;
  getStorageInfo(): Promise<StorageInfo>;
  /** Re-check the Wi-Fi-only rule for waiting tasks (the setting changed). */
  setDownloadPolicy(options: { wifiOnly: boolean }): Promise<void>;

  // ---- car ---------------------------------------------------------------------------
  /** Cache the tree native shows when the car asks while JS is not answering (and offline). */
  setBrowseTree(options: BrowseTree): Promise<void>;
  /** Answer a `browseRequest` (within ~5 s; native falls back to the cached tree after that). */
  answerBrowse(options: { requestId: string; items: BrowseNode[] }): Promise<void>;

  // ---- cast --------------------------------------------------------------------------
  getCastState(): Promise<CastState>;
  /** AirPlay route picker (iOS) / Cast device dialog (Android). */
  showRoutePicker(): Promise<void>;
  /**
   * End the cast session and continue locally. While connected, `load`/`play`/`pause`/`seek`
   * control the receiver; JS sends http(s) signed links only (never local files) while casting.
   */
  endCastSession(): Promise<void>;

  // ---- video -------------------------------------------------------------------------
  /** TV detection and the video decode profile (web fallback: a browser profile, isTv false). */
  getDeviceInfo(): Promise<DeviceInfo>;
  /**
   * Opens (or reuses) the full-screen native video player and starts `url`. Pauses the audio
   * player. Resolves once the screen is opening; the outcome arrives as events.
   */
  playVideo(options: PlayVideoOptions): Promise<void>;
  /** A new stream for the open video (answer to `videoSeekRequest`). Rejects 'invalid' when none is open. */
  replaceVideoStream(options: ReplaceVideoStreamOptions): Promise<void>;
  /** Closes the video player (fires `videoClosed`). Resolves when nothing is open. */
  closeVideo(): Promise<void>;

  // ---- app ---------------------------------------------------------------------------
  /** Cold-launch info for the launch intro (web fallback: sessionStorage, source 'launcher'). */
  consumeLaunchInfo?(): Promise<LaunchInfo>;

  // ---- events ------------------------------------------------------------------------
  addListener(eventName: 'state', listener: (e: StateEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'position', listener: (e: PositionEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'trackChanged', listener: (e: TrackChangedEvent) => void): Promise<PluginListenerHandle>;
  /** The last track ended and repeat is off. */
  addListener(eventName: 'queueEnded', listener: (e: { trackId: string | null }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'remoteCommand', listener: (e: RemoteCommandEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'sleepTimerFired', listener: (e: Record<string, never>) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'downloadProgress', listener: (e: DownloadProgressEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'downloadCompleted', listener: (e: DownloadCompletedEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'downloadFailed', listener: (e: DownloadFailedEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'browseRequest', listener: (e: BrowseRequestEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'browsePlay', listener: (e: BrowsePlayEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'carConnection', listener: (e: CarConnectionEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'castState', listener: (e: CastState) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'videoProgress', listener: (e: VideoProgressEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'videoSeekRequest', listener: (e: VideoSeekRequestEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'videoNext', listener: (e: VideoNextEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'videoClosed', listener: (e: VideoClosedEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'videoPickItem', listener: (e: VideoPickItemEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'videoTracksChanged', listener: (e: VideoTracksChangedEvent) => void): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

/** Event name → payload, for typed helpers (src/native/index.ts). */
export interface PlayerEvents {
  state: StateEvent;
  position: PositionEvent;
  trackChanged: TrackChangedEvent;
  queueEnded: { trackId: string | null };
  remoteCommand: RemoteCommandEvent;
  sleepTimerFired: Record<string, never>;
  downloadProgress: DownloadProgressEvent;
  downloadCompleted: DownloadCompletedEvent;
  downloadFailed: DownloadFailedEvent;
  browseRequest: BrowseRequestEvent;
  browsePlay: BrowsePlayEvent;
  carConnection: CarConnectionEvent;
  castState: CastState;
  videoProgress: VideoProgressEvent;
  videoSeekRequest: VideoSeekRequestEvent;
  videoNext: VideoNextEvent;
  videoClosed: VideoClosedEvent;
  videoPickItem: VideoPickItemEvent;
  videoTracksChanged: VideoTracksChangedEvent;
}

export type PlayerEventName = keyof PlayerEvents;

/** Folder (under the app's Data directory) that holds every download. */
export const DOWNLOADS_DIR = 'arclight-downloads';
