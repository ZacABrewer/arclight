import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOME_PATH, PROFILES_PATH, startTvRuntime, type TvRuntime } from './tv-runtime';

let path = HOME_PATH;
const back = vi.fn();
const navigate = vi.fn();
const router = {
  history: { back },
  state: {
    location: {
      get pathname() {
        return path;
      },
    },
  },
  subscribe: () => () => undefined,
  navigate,
};
let rt: TvRuntime;

const STAGE = `
  <div data-tv-stage>
    <header data-tv-fixed><button data-tv-key="tab-home" id="tab-home">Home</button></header>
    <main><button id="play">Play</button></main>
  </div>`;

beforeEach(() => {
  vi.useFakeTimers();
  back.mockReset();
  navigate.mockReset();
  document.body.innerHTML = STAGE;
  rt = startTvRuntime(router);
});

afterEach(() => {
  rt.stop();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const active = () => (document.activeElement as HTMLElement | null)?.id;

describe('TV Back', () => {
  it('on Home moves to the Home tab, then leaves the app', () => {
    path = HOME_PATH;
    document.getElementById('play')!.focus();
    expect(rt.back(true)).toBe(true);
    expect(active()).toBe('tab-home');
    expect(rt.back(true)).toBe(false);
    expect(back).not.toHaveBeenCalled();
  });

  it('on another tab goes to Home', () => {
    path = '/player/watch/movies';
    expect(rt.back(true)).toBe(true);
    expect(navigate).toHaveBeenCalledWith({ to: HOME_PATH });
    expect(back).not.toHaveBeenCalled();
  });

  it('on a pushed screen goes back, or Home without history', () => {
    path = '/player/watch/movies/12';
    expect(rt.back(true)).toBe(true);
    expect(back).toHaveBeenCalledTimes(1);
    expect(rt.back(false)).toBe(true);
    expect(navigate).toHaveBeenCalledWith({ to: HOME_PATH });
  });

  it('does nothing on the profile picker', () => {
    path = PROFILES_PATH;
    expect(rt.back(true)).toBe(true);
    expect(back).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('closes an open panel first, as Escape', () => {
    path = '/player/watch/movies/12';
    document.querySelector('main')!.insertAdjacentHTML('beforeend', '<div data-tv-scope id="panel"><button id="in">In</button></div>');
    const esc = vi.fn();
    document.getElementById('panel')!.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') esc();
    });
    document.getElementById('in')!.focus();
    expect(rt.back(true)).toBe(true);
    expect(esc).toHaveBeenCalledTimes(1);
    expect(back).not.toHaveBeenCalled();
  });

  it('off the stage keeps the plain history back', () => {
    document.body.innerHTML = '<main><button>Sign in</button></main>';
    path = '/sign-in';
    expect(rt.back(true)).toBe(true);
    expect(back).toHaveBeenCalledTimes(1);
    expect(rt.back(false)).toBe(false);
  });
});
