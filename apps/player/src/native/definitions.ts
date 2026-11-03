import type { PluginListenerHandle } from '@capacitor/core';

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
// Plugin
// ---------------------------------------------------------------------------------------

export interface PlayerInfo {
  /** 'web' for the JS fallback. */
  platform: 'ios' | 'android' | 'web';
  /** Native implementation version (free text). */
  version: string;
  /** What this build implements; JS hides the rest. */
  features: { audio: boolean; downloads: boolean; car: boolean; cast: boolean; sleepTimer: boolean };
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
}

export type PlayerEventName = keyof PlayerEvents;

/** Folder (under the app's Data directory) that holds every download. */
export const DOWNLOADS_DIR = 'arclight-downloads';
