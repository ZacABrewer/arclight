import { Capacitor } from '@capacitor/core';
import { QueryClient } from '@tanstack/react-query';
import type { PlayerCapabilities } from '@arclight/shared';
import { toasts } from '@web/lib/toast';
import { createQueryClient } from '@web/query-client';
import { AccountStore, type Account } from '../core/accounts';
import { onArtworkLinkRenewed, resetArtworkLink, setUnauthorizedHandler } from '../core/api';
import { preferencesStore } from '../core/kv';
import { netState, onNetChange, startNetworkWatch } from '../core/network';
import { getSession } from '../core/session';
import { SettingsStore } from '../core/settings';
import { deviceInfo } from '../core/sign-in';
import { downloadPlugin, playerBackend, type PlayerBackend } from '../native';
import { DownloadIndex } from '../offline/download-index';
import { DownloadManager } from '../offline/downloads';
import { ProgressQueue } from '../offline/progress-queue';
import { CarBrowser } from '../player/car';
import { createCarLibrary } from '../player/car-library';
import { appDeviceId, createAppPlayer, progressSender, type AppPlayer } from '../player/setup';
import { browseKeys } from '@web/features/player/browse/api';
import { playbackApi, playerKeys } from '@web/features/player/api';
import { videoApi, videoKeys } from '@web/features/player/video/api';
import { setVideoLauncher } from '@web/features/player/video/video-launcher';
import { ArclightPlayer, type DeviceInfo } from '../native';
import { decideTvMode } from '../tv/tv-mode';
import { NativeVideoLauncher } from '../video/native-video';
import { documentTheme } from '../video/native-extras';
import { householdKeys, householdsApi } from '../households/api';
import { currentVideoQuality } from '../video/quality';

// Everything that lives for the whole app run, built once at start (main.tsx) and handed to
// React through AppServicesContext.

export interface AppServices {
  qc: QueryClient;
  accounts: AccountStore;
  settings: SettingsStore;
  index: DownloadIndex;
  downloads: DownloadManager;
  progressQueue: ProgressQueue;
  backend: PlayerBackend;
  /** The player for the active account (rebuilt when the account changes). */
  player(): AppPlayer;
  /** Latest GET /playback/me for the active account. */
  caps(): PlayerCapabilities | undefined;
  setCaps(caps: PlayerCapabilities | undefined): void;
  /** Make another account active: new session, fresh caches, a new player. */
  switchAccount(accountId: string | null): Promise<void>;
  /** Send queued offline progress now (when online). */
  flushProgress(): Promise<void>;
  /** The app is in the foreground again. */
  resumed(): void;
  subscribePlayer(listener: () => void): () => void;
  /** The 10-foot TV layout is on (Google TV / Android TV, or ?tv=1). */
  tv: boolean;
  /** The native video player (Android); null: videos open the web player page. */
  video: NativeVideoLauncher | null;
}

/** The native plugin's device info, when this build has the native video player. */
async function nativeDeviceInfo(backend: PlayerBackend): Promise<DeviceInfo | null> {
  if (!Capacitor.isNativePlatform() || !backend.native || backend.info.features.video !== true) return null;
  try {
    return await ArclightPlayer.getDeviceInfo();
  } catch (e) {
    console.warn('getDeviceInfo', e);
    return null;
  }
}

export async function createServices(): Promise<AppServices> {
  const qc = createQueryClient(toasts);
  const accounts = new AccountStore();
  const settings = new SettingsStore();
  const index = new DownloadIndex();
  const progressQueue = new ProgressQueue();
  await Promise.all([accounts.load(), settings.load(), index.load(), startNetworkWatch()]);
  await accounts.activate();

  const backend = await playerBackend();
  const downloads = new DownloadManager({
    plugin: (await downloadPlugin())?.plugin ?? null,
    index,
    settings: () => settings.get(),
    maxBitrateKbps: () => caps?.maxBitrateKbps,
  });
  void downloads.start().catch((e) => console.warn('downloads', e));

  const deviceId = await appDeviceId(preferencesStore);
  const { deviceName } = await deviceInfo();
  const device = await nativeDeviceInfo(backend);
  const tv = decideTvMode(device?.isTv ?? false);

  let caps: PlayerCapabilities | undefined;
  let player: AppPlayer | null = null;
  const playerListeners = new Set<() => void>();
  const build = () =>
    createAppPlayer({
      plugin: backend.plugin,
      qc,
      index,
      progressQueue,
      settings: () => settings.get(),
      caps: () => caps,
      deviceId,
      deviceName,
      toWebUrl: (u) => (Capacitor.isNativePlatform() ? Capacitor.convertFileSrc(u) : u),
      nativeSleepTimer: backend.native && backend.info.features.sleepTimer,
    });

  const flushProgress = async () => {
    if (!netState().online) return;
    await progressQueue
      .flush(async (accountId) => {
        const account = accounts.list().find((a) => a.id === accountId);
        const token = account ? await accounts.token(accountId) : null;
        return account && token ? { serverUrl: account.serverUrl, token } : null;
      })
      .catch(() => undefined);
  };

  const services: AppServices = {
    qc,
    accounts,
    settings,
    index,
    downloads,
    progressQueue,
    backend,
    player() {
      player ??= build();
      return player;
    },
    caps: () => caps,
    setCaps(next) {
      caps = next;
    },
    async switchAccount(accountId) {
      if (player) {
        player.dispose();
        player = null;
      }
      if (accountId) await accounts.setActive(accountId);
      resetArtworkLink();
      caps = undefined;
      await accounts.activate();
      qc.clear();
      for (const l of [...playerListeners]) l();
    },
    flushProgress,
    resumed() {
      player?.onResume();
      void flushProgress();
    },
    subscribePlayer(listener) {
      playerListeners.add(listener);
      return () => playerListeners.delete(listener);
    },
    tv,
    video: null,
  };

  // Movies & TV on Android: play buttons open the native player instead of the web page.
  if (device) {
    const { sendProgress } = progressSender({ progressQueue, settings: () => settings.get(), qc });
    const video = new NativeVideoLauncher({
      plugin: ArclightPlayer,
      profile: async () => device.videoProfile,
      fetchItem: (key) => qc.fetchQuery({ queryKey: playerKeys.item(key), queryFn: () => playbackApi.item(key), staleTime: 60_000 }),
      fetchProgress: async (key) => (await playbackApi.progress([key])).items.find((p) => p.itemKey === key) ?? null,
      requestSession: (body) => videoApi.session(body),
      sendProgress,
      markPlayed: (key) => videoApi.watched({ itemKeys: [key as never], played: true }),
      pauseAudio: () => {
        if (player?.controller.getState().playing) player.controller.pause();
      },
      refresh: () => {
        void qc.invalidateQueries({ queryKey: browseKeys.all });
        void qc.invalidateQueries({ queryKey: ['playback', 'progress'] });
        void qc.invalidateQueries({ queryKey: playerKeys.continue });
      },
      onError: (message) => toasts.push({ tone: 'error', title: message }),
      deviceId,
      deviceName,
      // Redesign extras (spec §5.9): the profile's languages and prefs, the episodes panel, the theme.
      profileSettings: () => qc.fetchQuery({ queryKey: householdKeys.settings(), queryFn: householdsApi.settings, staleTime: 60_000 }).catch(() => null),
      fetchSeries: (id) => qc.fetchQuery({ queryKey: videoKeys.show(id), queryFn: () => videoApi.show(id), staleTime: 30_000 }),
      saveProfileSettings: async (patch) => qc.setQueryData(householdKeys.settings(), await householdsApi.saveSettings(patch)),
      theme: documentTheme,
      quality: currentVideoQuality,
    });
    await video.start();
    setVideoLauncher(video.launch);
    services.video = video;
  }

  // Back online: send what was queued.
  onNetChange((s) => {
    if (s.online) void flushProgress();
  });
  void flushProgress();
  // CarPlay / Android Auto browse lists (only in builds whose native side has the car UI).
  if (backend.native && backend.info.features.car && !tv) {
    new CarBrowser({
      plugin: backend.plugin,
      library: createCarLibrary(qc, index),
      player: () => services.player().controller,
      onChange: (listener) => {
        const offIndex = index.subscribe(listener);
        const offNet = onNetChange(listener);
        const offPlayer = services.subscribePlayer(listener);
        return () => {
          offIndex();
          offNet();
          offPlayer();
        };
      },
    }).start();
  }
  // New artwork signature: refetch so images use it.
  onArtworkLinkRenewed(() => void qc.invalidateQueries());
  // The token was refused (device removed on the server): drop the token; the account stays
  // listed (with its queued progress) and asks to sign in again.
  setUnauthorizedHandler(() => {
    const s = getSession();
    if (!s) return;
    void accounts.expire(s.accountId).then(() => services.switchAccount(s.accountId));
  });
  return services;
}

export function activeAccount(services: AppServices): Account | null {
  return services.accounts.active();
}
