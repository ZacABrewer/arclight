import { describe, expect, it } from 'vitest';
import { browserCandidates, findBrowser } from './browser.js';

const winEnv = {
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  ProgramFiles: 'C:\\Program Files',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
};

describe('findBrowser', () => {
  it('prefers Edge under Program Files (x86) on Windows', () => {
    const first = browserCandidates('win32', winEnv)[0];
    expect(first).toEqual({ name: 'edge', path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' });
  });

  it('falls back to Chrome, then Brave, then Chromium', () => {
    const present = new Set(['C:\\Users\\me\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe']);
    expect(findBrowser({ platform: 'win32', env: winEnv, exists: (p) => present.has(p) })?.name).toBe('brave');
    present.add('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    expect(findBrowser({ platform: 'win32', env: winEnv, exists: (p) => present.has(p) })?.name).toBe('chrome');
  });

  it('uses only the configured path when one is set', () => {
    expect(findBrowser({ configuredPath: 'D:\\apps\\chrome.exe', exists: () => true })).toEqual({ name: 'custom', path: 'D:\\apps\\chrome.exe' });
    expect(findBrowser({ configuredPath: 'D:\\missing.exe', platform: 'win32', env: winEnv, exists: (p) => p !== 'D:\\missing.exe' })).toBeNull();
  });

  it('returns null when nothing is installed', () => {
    expect(findBrowser({ platform: 'linux', exists: () => false })).toBeNull();
    expect(browserCandidates('linux').some((c) => c.path === '/usr/bin/chromium')).toBe(true);
  });
});
