import { afterEach, describe, expect, it } from 'vitest';
import { decideTvMode, isTvMode, setTvMode, tvParam } from './tv-mode';

afterEach(() => {
  sessionStorage.clear();
  setTvMode(false);
  document.documentElement.classList.remove('tv-mode');
});

describe('TV mode', () => {
  it('reads ?tv= from the query or the hash', () => {
    expect(tvParam('http://localhost/?tv=1')).toBe(true);
    expect(tvParam('http://localhost/#/player?tv=0')).toBe(false);
    expect(tvParam('http://localhost/#/player?x=1&tv=yes')).toBe(true);
    expect(tvParam('http://localhost/#/player')).toBeNull();
  });

  it('is on for a TV device, and marks <html>', () => {
    expect(decideTvMode(true, 'http://localhost/')).toBe(true);
    expect(isTvMode()).toBe(true);
    expect(document.documentElement.classList.contains('tv-mode')).toBe(true);
  });

  it('keeps ?tv=1 for the browser session, until ?tv=0', () => {
    expect(decideTvMode(false, 'http://localhost/?tv=1')).toBe(true);
    expect(decideTvMode(false, 'http://localhost/#/player/search')).toBe(true);
    expect(decideTvMode(false, 'http://localhost/?tv=0')).toBe(false);
    expect(decideTvMode(false, 'http://localhost/')).toBe(false);
    expect(document.documentElement.classList.contains('tv-mode')).toBe(false);
  });
});
