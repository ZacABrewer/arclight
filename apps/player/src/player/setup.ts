import { Capacitor } from '@capacitor/core';
import type { QueryClient } from '@tanstack/react-query';
import type { PlayableItem, PlayerCapabilities, ProgressBeacon, ProgressReport, StreamLinksResponse } from '@arclight/shared';
import { playbackApi, playerKeys } from '@web/features/player/api';
import type { AudioEngine } from '@web/features/player/engine/audio-engine';
import { codecLabel } from '@web/features/player/engine/stream';
import { PlayerController } from '@web/features/player/player-controller';
import { loadPrefs } from '@web/features/player/device';
import { BOOK_SKIP_MS } from '@web/features/player/engine/media-session';
import { ApiError, appPlaybackApi, isNetworkError } from '../core/api';
import { netState } from '../core/network';
import { getSession } from '../core/session';
import { qualityRequest, type AppSettings } from '../core/settings';
import type { ArclightPlayerPlugin } from '../native/definitions';
import type { DownloadIndex } from '../offline/download-index';
import type { ProgressQueue } from '../offline/progress-queue';
import { NativeEngine, type ResolvedItem, type ResolveOptions } from './native-engine';
import { NativeSleepSync } from './native-sleep';

// Builds the web player's controller on the native engine, with the app's data sources:
// the server when online, the download index when not, and the offline progress queue.

export interface PlayerSetup {
  plugin: ArclightPlayerPlugin;
  qc: QueryClient;
  index: DownloadIndex;
  progressQueue: ProgressQueue;
  settings: () => AppSettings;
  caps: () => PlayerCapabilities | undefined;
  /** Stable per install (Preferences). */
  deviceId: string;
  deviceName: string;
  /** Maps a downloaded file's URI for the WebView (Capacitor.convertFileSrc). */
  toWebUrl?: (uri: string) => string;
  /** The plugin runs a native sleep timer (fires while JS is suspended). */
  nativeSleepTimer?: boolean;
}

const LINK_REUSE_MARGIN_MS = 5 * 60_000;

/** Signed links per item and quality, reused until close to their expiry. */
class LinkCache {
  private readonly map = new Map<string, { res: StreamLinksResponse; expiresAt: number }>();

  async get(key: string, fresh: boolean, fetcher: () => Promise<StreamLinksResponse>): Promise<StreamLinksResponse> {
    const hit = this.map.get(key);
    if (!fresh && hit && hit.expiresAt - Date.now() > LINK_REUSE_MARGIN_MS) return hit.res;
    const res = await fetcher();
    const expiresAt = Math.min(...res.links.map((l) => Date.parse(l.expiresAt) || Date.now() + 3600_000));
    this.map.set(key, { res, expiresAt });
    if (this.map.size > 300) this.map.delete(this.map.keys().next().value!);
    return res;
  }

  clear(): void {
    this.map.clear();
  }
}

const absolute = (url: string, serverUrl: string) => (url.startsWith('/') ? `${new URL(serverUrl).origin}${url}` : url);

export function makeResolver(s: PlayerSetup): { resolve: (item: PlayableItem, opts: ResolveOptions) => Promise<ResolvedItem>; links: LinkCache } {
  const links = new LinkCache();
  const resolve = async (item: PlayableItem, opts: ResolveOptions): Promise<ResolvedItem> => {
    const session = getSession();
    if (!session) throw Object.assign(new Error('Not signed in'), { code: 'auth' });
    const entry = s.index.get(session.accountId, item.itemKey);
    const localArt = entry?.artwork?.status === 'completed' ? entry.artwork.path : undefined;
    const artworkUrl = localArt ?? (item.artworkUrl && /^https?:/.test(item.artworkUrl) ? item.artworkUrl : undefined);
    const meta = (i: number) => {
      const part = item.parts[i]!;
      return {
        itemKey: item.itemKey,
        kind: item.kind === 'audiobook' ? ('audiobook' as const) : ('track' as const),
        partIndex: i,
        itemOffsetMs: part.startMs,
        durationMs: part.durationMs,
        title: item.title,
        ...(item.subtitle ? { artist: item.subtitle } : {}),
        ...(item.context ? { album: item.context } : {}),
        ...(artworkUrl ? { artworkUrl } : {}),
      };
    };
    const local = item.parts.map((_, i) => s.index.localPart(session.accountId, item.itemKey, i));
    const sourceLabel = codecLabel(item.parts[0]!);
    if (local.every(Boolean) && !opts.forceTranscode) {
      return {
        tracks: item.parts.map((p, i) => ({ ...meta(i), url: local[i]!, mimeType: p.mimeType })),
        stream: { format: 'original', transcoded: false, bitrateKbps: null, sourceLabel },
      };
    }
    if (!netState().online) throw Object.assign(new Error('Offline and not downloaded'), { code: 'network' });
    const settings = s.settings();
    const quality = netState().cellular ? settings.cellularQuality : settings.wifiQuality;
    let req = qualityRequest(quality, s.caps()?.maxBitrateKbps);
    if (opts.forceTranscode && req.format === 'original') req = qualityRequest('aac-256', s.caps()?.maxBitrateKbps);
    const key = `${session.accountId}|${item.itemKey}|${req.format}|${req.bitrateKbps ?? ''}`;
    const res = await links.get(key, Boolean(opts.fresh), () => appPlaybackApi.streamLinks(item.itemKey, req));
    const transcoded = req.format !== 'original';
    return {
      tracks: item.parts.map((p, i) => {
        // A part already downloaded plays from the file even when its siblings stream.
        if (local[i] && !opts.forceTranscode) return { ...meta(i), url: local[i]!, mimeType: p.mimeType };
        const link = res.links.find((l) => l.fileId === p.fileId) ?? res.links[i];
        if (!link) throw Object.assign(new Error(`No stream link for part ${i}`), { code: 'network' });
        return { ...meta(i), url: absolute(link.url, session.serverUrl), ...(transcoded ? { mimeType: 'audio/mp4' } : { mimeType: p.mimeType }) };
      }),
      stream: { format: req.format, transcoded, bitrateKbps: req.bitrateKbps ?? null, sourceLabel },
    };
  };
  return { resolve, links };
}

/** Errors worth queueing a progress report for (try again later) rather than dropping it. */
function retryable(err: unknown): boolean {
  return isNetworkError(err) || (err instanceof ApiError && (err.status >= 500 || err.status === 429));
}

/**
 * Progress reports for the active account: sent now when online, else (or when the server is
 * unreachable) kept in the offline queue. Used by the audio controller and the native video player.
 */
export function progressSender(s: Pick<PlayerSetup, 'progressQueue' | 'settings' | 'qc'>): {
  sendProgress: (itemKey: string, report: ProgressReport) => Promise<void>;
  queueReport: (body: ProgressBeacon) => void;
} {
  const queueReport = (body: ProgressBeacon) => {
    const session = getSession();
    if (session) void s.progressQueue.enqueue(session.accountId, body);
  };
  const sendProgress = async (key: string, report: ProgressReport) => {
    if (!s.settings().reportProgress) return;
    if (!netState().online) return queueReport({ ...report, itemKey: key } as ProgressBeacon);
    try {
      await appPlaybackApi.report(key, report);
      if (report.event === 'stop' || report.event === 'pause') void s.qc.invalidateQueries({ queryKey: playerKeys.continue });
    } catch (err) {
      if (retryable(err)) queueReport({ ...report, itemKey: key } as ProgressBeacon);
      else throw err;
    }
  };
  return { sendProgress, queueReport };
}

export interface AppPlayer {
  controller: PlayerController;
  engine: NativeEngine;
  /** Forget cached stream links (account switch, quality change). */
  resetLinks(): void;
  /** The app is in the foreground again (take back what native counted meanwhile). */
  onResume(): void;
  /** Tear down (account switch). */
  dispose(): void;
}

export function createAppPlayer(s: PlayerSetup): AppPlayer {
  const { resolve, links } = makeResolver(s);
  const engine = new NativeEngine({ plugin: s.plugin, resolve, skipMs: { back: BOOK_SKIP_MS, forward: BOOK_SKIP_MS } });
  const toWebUrl = s.toWebUrl ?? ((u: string) => Capacitor.convertFileSrc(u));

  const offlineItem = (key: string): PlayableItem | null => {
    const session = getSession();
    return session ? s.index.offlineItem(session.accountId, key, toWebUrl) : null;
  };

  const { sendProgress, queueReport } = progressSender(s);

  const controller = new PlayerController({
    // The controller only uses AudioEngine's public surface, which NativeEngine implements.
    engine: engine as unknown as AudioEngine,
    fetchItem: async (key) => {
      if (!netState().online) {
        const off = offlineItem(key);
        if (off) return off;
      }
      try {
        return await s.qc.fetchQuery({ queryKey: playerKeys.item(key), queryFn: () => playbackApi.item(key), staleTime: 10 * 60_000 });
      } catch (err) {
        const off = offlineItem(key);
        if (off) return off;
        throw err;
      }
    },
    fetchProgress: async (key) => {
      if (!netState().online) return null;
      const res = await playbackApi.progress([key]);
      return res.items.find((p) => p.itemKey === key) ?? null;
    },
    loadQueue: async () => (netState().online ? playbackApi.queue() : null),
    saveQueue: (q) => (netState().online ? playbackApi.saveQueue(q).catch(() => undefined) : Promise.resolve()),
    savePrefs: (key, p) => (netState().online ? playbackApi.updateProgress(key, { prefs: p }).catch(() => undefined) : Promise.resolve()),
    sendProgress,
    beacon: (body) => {
      if (!s.settings().reportProgress) return true;
      // The app is not going away like a tab: send it now, keep it if that fails.
      if (!netState().online) queueReport(body);
      else {
        const { itemKey, ...report } = body;
        void appPlaybackApi.report(itemKey, report).catch((err) => {
          if (retryable(err)) queueReport(body);
        });
      }
      return true;
    },
    deviceId: s.deviceId,
    deviceName: s.deviceName,
    initial: loadPrefs(),
    // Lock screen / notification come from the native plugin, not the WebView's Media Session.
    mediaSession: false,
  });

  engine.setExternalHandler(
    (c) => {
      if (c === 'play') controller.play();
      else if (c === 'pause') controller.pause();
      else if (c === 'next') {
        // Native waits only 2 s for an answer: when the next item is already queued natively,
        // switch to it at once; the controller's load of it then adopts what plays.
        const key = controller.peekNext();
        controller.next();
        if (key) engine.preAdvance(key);
      } else if (c === 'previous') controller.previous();
      else controller.reportExternalSeek();
    },
    { busy: () => controller.getState().loading },
  );

  const sleep = s.nativeSleepTimer && s.plugin.setSleepTimer ? new NativeSleepSync({ plugin: s.plugin, controller, engine }) : null;

  return {
    controller,
    engine,
    resetLinks: () => links.clear(),
    onResume: () => sleep?.onResume(),
    dispose: () => {
      sleep?.destroy();
      controller.onPageHide();
      controller.dispose();
    },
  };
}

const DEVICE_KEY = 'arclight.app.deviceId';

/** Stable random id for progress reports from this install (the server shows "playing on …"). */
export async function appDeviceId(kv: { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void> }): Promise<string> {
  const existing = await kv.get(DEVICE_KEY);
  if (existing) return existing;
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const id = `app-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  await kv.set(DEVICE_KEY, id);
  return id;
}
