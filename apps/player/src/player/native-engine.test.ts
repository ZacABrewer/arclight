import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayableItem } from '@arclight/shared';
import { book, track } from '@web/features/player/test-utils';
import type { ArclightPlayerPlugin, LoadOptions, NativeTrack } from '../native/definitions';
import { NativeEngine, type ResolvedItem, type ResolveOptions } from './native-engine';

type Listener = (e: unknown) => void;

/** Records calls and lets the test fire native events. */
function fakePlugin() {
  const listeners = new Map<string, Set<Listener>>();
  const calls: Array<[string, unknown]> = [];
  const rec =
    (name: string) =>
    async (arg?: unknown): Promise<void> => {
      calls.push([name, arg]);
    };
  const plugin = {
    load: rec('load'),
    setUpcoming: rec('setUpcoming'),
    play: rec('play'),
    pause: rec('pause'),
    seek: rec('seek'),
    skipTo: rec('skipTo'),
    setRate: rec('setRate'),
    setVolume: rec('setVolume'),
    stop: rec('stop'),
    configureRemote: rec('configureRemote'),
    addListener: async (name: string, l: Listener) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(l);
      return { remove: async () => void listeners.get(name)?.delete(l) };
    },
  };
  return {
    plugin: plugin as unknown as ArclightPlayerPlugin,
    calls,
    named: (n: string) => calls.filter(([c]) => c === n).map(([, a]) => a),
    emit: (name: string, e: unknown) => listeners.get(name)?.forEach((l) => l(e)),
  };
}

function resolver() {
  const seen: Array<{ key: string; opts: ResolveOptions }> = [];
  const resolve = vi.fn(async (item: PlayableItem, opts: ResolveOptions): Promise<ResolvedItem> => {
    seen.push({ key: item.itemKey, opts });
    return {
      tracks: item.parts.map((p, i) => ({
        itemKey: item.itemKey,
        kind: item.kind === 'audiobook' ? 'audiobook' : 'track',
        partIndex: i,
        itemOffsetMs: p.startMs,
        durationMs: p.durationMs,
        title: item.title,
        url: `https://music.example.com/stream/${p.fileId}${opts.forceTranscode ? '?format=aac' : ''}`,
        mimeType: p.mimeType,
      })),
      stream: { format: opts.forceTranscode ? 'aac' : 'original', transcoded: Boolean(opts.forceTranscode), bitrateKbps: null, sourceLabel: 'FLAC' },
    };
  });
  return { resolve, seen };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

let engine: NativeEngine | null = null;
afterEach(() => {
  engine?.destroy();
  engine = null;
});

async function setup() {
  const fake = fakePlugin();
  const { resolve, seen } = resolver();
  let now = 1_000_000;
  engine = new NativeEngine({ plugin: fake.plugin, resolve, now: () => now, externalPauseDelayMs: 0 });
  await engine.whenReady();
  return { fake, seen, engine, advance: (ms: number) => (now += ms) };
}

describe('NativeEngine', () => {
  it('loads an audiobook at the right file and offset', async () => {
    const { fake, engine } = await setup();
    const b = book();
    engine.load(b, 2_000_000);
    await settle();
    await settle();
    const load = fake.named('load')[0] as LoadOptions;
    expect(load.tracks).toHaveLength(2);
    expect(load.startIndex).toBe(1);
    expect(load.startMs).toBe(200_000);
    expect(engine.positionMs).toBe(2_000_000);
    expect(fake.named('configureRemote')[0]).toMatchObject({ mode: 'audiobook' });
  });

  it('queues the next item behind the current one and advances gaplessly', async () => {
    const { fake, engine } = await setup();
    const onAdvance = vi.fn();
    engine.setHooks({ onAdvance } as never);
    const a = track(1);
    const b = track(2);
    engine.setNext(b);
    engine.load(a, 0);
    await settle();
    await settle();
    const load = fake.named('load')[0] as LoadOptions;
    expect(load.tracks.map((t: NativeTrack) => t.itemKey)).toEqual(['track:1', 'track:2']);
    const nextId = load.tracks[1]!.id;
    fake.emit('trackChanged', { index: 1, trackId: nextId, previousTrackId: load.tracks[0]!.id, reason: 'auto' });
    expect(onAdvance).toHaveBeenCalledWith(b);
    expect(engine.current?.itemKey).toBe('track:2');
  });

  it('follows native position events', async () => {
    const { fake, engine } = await setup();
    const b = book();
    engine.load(b, 0);
    await settle();
    await settle();
    const load = fake.named('load')[0] as LoadOptions;
    fake.emit('position', { trackId: load.tracks[1]!.id, index: 1, positionMs: 60_000, durationMs: 1_800_000, bufferedMs: 0 });
    expect(engine.positionMs).toBe(1_860_000);
  });

  it('seeks within the loaded file, or skips to another file', async () => {
    const { fake, engine } = await setup();
    engine.load(book(), 0);
    await settle();
    await settle();
    engine.seek(100_000);
    await settle();
    expect(fake.named('seek').at(-1)).toEqual({ positionMs: 100_000 });
    engine.seek(1_900_000);
    await settle();
    expect(fake.named('skipTo').at(-1)).toEqual({ index: 1, positionMs: 100_000 });
  });

  it('refetches links once when native says they were refused', async () => {
    const { fake, seen, engine } = await setup();
    engine.load(track(1), 0);
    await settle();
    await settle();
    fake.emit('state', { status: 'error', trackId: null, index: 0, error: { code: 'auth', message: '403' } });
    await settle();
    await settle();
    expect(seen.map((s) => s.opts.fresh ?? false)).toEqual([false, true]);
    expect(fake.named('load')).toHaveLength(2);
    // A second refusal is an error.
    fake.emit('state', { status: 'error', trackId: null, index: 0, error: { code: 'auth', message: '403' } });
    await settle();
    expect(engine.snapshot().error).toBe('network');
  });

  it('asks for a transcode when the decoder cannot play the original', async () => {
    const { fake, seen, engine } = await setup();
    engine.load(track(1), 0);
    await settle();
    await settle();
    fake.emit('state', { status: 'error', trackId: null, index: 0, error: { code: 'unsupported', message: 'codec' } });
    await settle();
    await settle();
    expect(seen.at(-1)?.opts.forceTranscode).toBe(true);
  });

  it('hands lock-screen next / previous to the controller', async () => {
    const { fake, engine } = await setup();
    const external = vi.fn();
    engine.setExternalHandler(external);
    fake.emit('remoteCommand', { command: 'next', handled: false });
    fake.emit('remoteCommand', { command: 'previous', handled: false });
    expect(external.mock.calls.map((c) => c[0])).toEqual(['next', 'previous']);
  });

  it('a pause from the headset reaches the controller after the grace period', async () => {
    const { fake, engine, advance } = await setup();
    const external = vi.fn();
    engine.setExternalHandler(external);
    engine.load(track(1), 0);
    await settle();
    await settle();
    advance(5_000);
    fake.emit('state', { status: 'paused', trackId: null, index: 0 });
    await new Promise((r) => setTimeout(r, 5));
    expect(external).toHaveBeenCalledWith('pause');
  });

  it('volume, mute and speed go to native', async () => {
    const { fake, engine } = await setup();
    engine.load(track(1), 0);
    await settle();
    engine.setVolume(0.5);
    engine.setMuted(true);
    engine.setSpeed(1.5);
    await settle();
    expect(fake.named('setVolume').at(-1)).toEqual({ volume: 0 });
    expect(fake.named('setRate').at(-1)).toEqual({ rate: 1.5 });
    expect(engine.playbackSpeed).toBe(1.5);
  });
});
