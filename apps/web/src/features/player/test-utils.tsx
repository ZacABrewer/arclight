import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { vi } from 'vitest';
import type { ItemKey, PlayableItem, PlayablePart, PlaybackProgress, PlayQueue } from '@arclight/shared';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { AudioEngine, type AudioLike, type EngineOptions } from './engine/audio-engine.js';
import { PlayerProvider } from './player-context.js';
import { PlayerController, type ControllerDeps } from './player-controller.js';

// Fakes for the player tests: an <audio> stand-in, item builders, and a controller wired to
// spies instead of the api.

export class FakeAudio implements AudioLike {
  static created: FakeAudio[] = [];
  private _src = '';
  currentTime = 0;
  duration = NaN;
  paused = true;
  playbackRate = 1;
  preservesPitch = true;
  volume = 1;
  muted = false;
  preload = '';
  error: { code: number } | null = null;
  playable = 'probably';
  /** Reject play() with this error name (autoplay blocked). */
  rejectPlay: string | null = null;
  readonly srcHistory: string[] = [];
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor() {
    FakeAudio.created.push(this);
  }

  get src(): string {
    return this._src;
  }
  set src(v: string) {
    this._src = v;
    this.srcHistory.push(v);
    this.currentTime = 0;
    this.error = null;
  }

  play(): Promise<void> {
    if (this.rejectPlay) {
      const err = new Error('blocked');
      err.name = this.rejectPlay;
      return Promise.reject(err);
    }
    this.paused = false;
    this.fire('playing');
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  load(): void {}
  removeAttribute(name: string): void {
    if (name === 'src') this._src = '';
  }
  addEventListener(type: string, fn: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  canPlayType(): string {
    return this.playable;
  }

  fire(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
  /** Move the element clock and fire timeupdate. */
  at(seconds: number): void {
    this.currentTime = seconds;
    this.fire('timeupdate');
  }
  fail(code: number): void {
    this.error = { code };
    this.fire('error');
  }
}

export function part(fileId: number, startMs: number, durationMs: number, over: Partial<PlayablePart> = {}): PlayablePart {
  return {
    fileId,
    startMs,
    durationMs,
    codec: 'flac',
    container: 'flac',
    mimeType: 'audio/flac',
    bitrateKbps: 900,
    sampleRateHz: 44_100,
    bitDepth: 16,
    channels: 2,
    sizeBytes: 1_000_000,
    ...over,
  };
}

export function track(id: number, over: Partial<PlayableItem> = {}): PlayableItem {
  const durationMs = over.durationMs ?? 180_000;
  return {
    itemKey: `track:${id}` as ItemKey,
    kind: 'track',
    title: `Song ${id}`,
    subtitle: 'Test Artist',
    context: 'Test Album',
    artworkUrl: null,
    durationMs,
    parts: [part(100 + id, 0, durationMs)],
    chapters: [],
    albumId: 1,
    artistId: 1,
    bookId: null,
    replayGain: null,
    ...over,
  };
}

/** An audiobook of two 30-minute files and three chapters. */
export function book(id = 7, over: Partial<PlayableItem> = {}): PlayableItem {
  return {
    itemKey: `audiobook:${id}` as ItemKey,
    kind: 'audiobook',
    title: 'The Test Book',
    subtitle: 'A. Writer',
    context: null,
    artworkUrl: null,
    durationMs: 3_600_000,
    parts: [part(200, 0, 1_800_000, { codec: 'mp3', container: 'mp3', mimeType: 'audio/mpeg', bitrateKbps: 64 }), part(201, 1_800_000, 1_800_000, { codec: 'mp3', container: 'mp3', mimeType: 'audio/mpeg', bitrateKbps: 64 })],
    chapters: [
      { title: 'Opening', startMs: 0, durationMs: 1_200_000 },
      { title: 'Middle', startMs: 1_200_000, durationMs: 1_200_000 },
      { title: 'Ending', startMs: 2_400_000, durationMs: 1_200_000 },
    ],
    albumId: null,
    artistId: null,
    bookId: id,
    replayGain: null,
    ...over,
  };
}

export function progress(itemKey: string, positionMs: number, durationMs: number, over: Partial<PlaybackProgress> = {}): PlaybackProgress {
  return {
    itemKey: itemKey as ItemKey,
    positionMs,
    durationMs,
    played: false,
    playCount: 0,
    lastPlayedAt: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    favorite: false,
    prefs: {},
    source: 'arclight',
    ...over,
  };
}

export function makeEngine(opts: EngineOptions = {}): { engine: AudioEngine; decks: FakeAudio[] } {
  const decks: FakeAudio[] = [];
  const engine = new AudioEngine({
    createElement: () => {
      const el = new FakeAudio();
      decks.push(el);
      return el;
    },
    streamUrl: (fileId, o) => `/stream/${fileId}?format=${o.format}${o.startMs ? `&startMs=${o.startMs}` : ''}`,
    createAudioContext: null,
    userAgent: 'test',
    // The stream answers fine: an element error is the browser's (decode) problem.
    probe: async () => 200,
    ...opts,
  });
  return { engine, decks };
}

export interface ControllerHarness {
  controller: PlayerController;
  engine: AudioEngine;
  decks: FakeAudio[];
  deps: ControllerDeps & {
    sendProgress: ReturnType<typeof vi.fn>;
    beacon: ReturnType<typeof vi.fn>;
    saveQueue: ReturnType<typeof vi.fn>;
    savePrefs: ReturnType<typeof vi.fn>;
  };
  clock: { now: number };
  /** The engine's active element. */
  active: () => FakeAudio;
}

export function makeController(
  items: PlayableItem[],
  over: { progress?: PlaybackProgress[]; queue?: PlayQueue | null; engine?: EngineOptions } = {},
): ControllerHarness {
  const { engine, decks } = makeEngine(over.engine);
  const byKey = new Map(items.map((i) => [i.itemKey, i]));
  const clock = { now: Date.parse('2026-01-01T12:00:00Z') };
  const deps = {
    engine,
    fetchItem: vi.fn(async (key: ItemKey) => {
      const item = byKey.get(key);
      if (!item) throw new Error(`no item ${key}`);
      return item;
    }),
    fetchProgress: vi.fn(async (key: ItemKey) => over.progress?.find((p) => p.itemKey === key) ?? null),
    loadQueue: vi.fn(async () => over.queue ?? null),
    saveQueue: vi.fn(async () => undefined),
    savePrefs: vi.fn(async () => undefined),
    sendProgress: vi.fn(async () => undefined),
    beacon: vi.fn(() => true),
    deviceId: 'device-test',
    now: () => clock.now,
    random: () => 0,
    mediaSession: false,
  };
  const controller = new PlayerController(deps);
  return { controller, engine, decks, deps, clock, active: () => engine.activeElement as FakeAudio };
}

/** Render `ui` under a PlayerProvider using `controller`, inside a router at /player. */
export function renderWithPlayer(ui: ReactNode, controller: PlayerController, path = '/player') {
  const toasts = createToastStore();
  const queryClient = createQueryClient(toasts);
  const root = createRootRoute();
  const page = createRoute({
    getParentRoute: () => root,
    path: '/player',
    component: () => (
      <PlayerProvider controller={controller} restoreQueue={false}>
        {ui}
      </PlayerProvider>
    ),
  });
  const nowPlaying = createRoute({ getParentRoute: () => root, path: '/player/now-playing', component: () => <p>now playing page</p> });
  const router = createRouter({ routeTree: root.addChildren([page, nowPlaying]), history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider store={toasts}>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { router, queryClient };
}

/** Let pending promises (fetchItem, fetchProgress) settle. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}
