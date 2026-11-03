import { describe, expect, it } from 'vitest';
import { decideLaunchIntro, introVideoUrl, readCachedReduceMotion, readPlayIntro, webLaunchInfo, writePlayIntro, cacheReduceMotion, type LaunchIntroContext } from './policy';
import type { LaunchInfo } from '../native/definitions';

const cold = (source: LaunchInfo['source'] = 'launcher') => ({ coldStart: true, source });

describe('decideLaunchIntro', () => {
  const cases: [string, LaunchIntroContext, ReturnType<typeof decideLaunchIntro>][] = [
    ['cold launch from the launcher', { launch: cold(), playIntro: true, reducedMotion: false }, 'video'],
    ['cold launch, reduce motion', { launch: cold(), playIntro: true, reducedMotion: true }, 'static'],
    ['setting off', { launch: cold(), playIntro: false, reducedMotion: false }, 'skip'],
    ['setting off, reduce motion', { launch: cold(), playIntro: false, reducedMotion: true }, 'skip'],
    ['warm start (reload, resume)', { launch: { coldStart: false, source: 'launcher' }, playIntro: true, reducedMotion: false }, 'skip'],
    ['deep link', { launch: cold('deep-link'), playIntro: true, reducedMotion: false }, 'skip'],
    ['notification', { launch: cold('notification'), playIntro: true, reducedMotion: false }, 'skip'],
    ['media button', { launch: cold('media-button'), playIntro: true, reducedMotion: false }, 'skip'],
    ['Android Auto', { launch: cold('car'), playIntro: true, reducedMotion: false }, 'skip'],
    ['other source', { launch: cold('other'), playIntro: true, reducedMotion: true }, 'skip'],
    ['unknown launch', { launch: null, playIntro: true, reducedMotion: false }, 'skip'],
  ];
  it.each(cases)('%s', (_name, ctx, want) => expect(decideLaunchIntro(ctx)).toBe(want));
});

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

describe('storage helpers', () => {
  it('web launch info is cold once per session', () => {
    const s = memory();
    expect(webLaunchInfo(s)).toEqual({ coldStart: true, source: 'launcher', systemReducedMotion: false });
    expect(webLaunchInfo(s).coldStart).toBe(false);
  });

  it('play intro defaults on and can be turned off', () => {
    const s = memory();
    expect(readPlayIntro(s)).toBe(true);
    writePlayIntro(s, false);
    expect(readPlayIntro(s)).toBe(false);
    writePlayIntro(s, true);
    expect(readPlayIntro(s)).toBe(true);
  });

  it('caches reduce motion', () => {
    const s = memory();
    expect(readCachedReduceMotion(s)).toBe(false);
    cacheReduceMotion(s, true);
    expect(readCachedReduceMotion(s)).toBe(true);
  });

  it('blocked storage falls back to the defaults', () => {
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } as unknown as Storage;
    expect(readPlayIntro(blocked)).toBe(true);
    expect(webLaunchInfo(blocked).coldStart).toBe(true);
  });

  it('picks the file per form factor', () => {
    expect(introVideoUrl(true)).toBe('intro/arclight-intro-1080p.mp4');
    expect(introVideoUrl(false)).toBe('intro/arclight-intro-720p.mp4');
  });
});
