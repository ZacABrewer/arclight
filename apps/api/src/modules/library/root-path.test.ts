import { describe, expect, it } from 'vitest';
import { insideAnyRoot, isStrictlyInside, rootFolderPathProblem } from './root-path.js';

const win = process.platform === 'win32';

describe('rootFolderPathProblem', () => {
  it('refuses relative paths and filesystem or drive roots', () => {
    expect(rootFolderPathProblem('relative/x')).toMatch(/absolute/);
    expect(rootFolderPathProblem('')).toMatch(/absolute/);
    expect(rootFolderPathProblem('/')).toMatch(/root/);
    expect(rootFolderPathProblem('/data/..')).toMatch(/root/);
    if (win) {
      expect(rootFolderPathProblem('C:\\')).toMatch(/root/);
      expect(rootFolderPathProblem('D:/')).toMatch(/root/);
      expect(rootFolderPathProblem('\\\\nas\\media')).toBeNull();
      expect(rootFolderPathProblem('D:\\TV')).toBeNull();
    }
  });

  it('accepts normal absolute folders', () => {
    expect(rootFolderPathProblem('/data/tv')).toBeNull();
    expect(rootFolderPathProblem(' /movies ')).toBeNull();
  });
});

describe('containment', () => {
  it('is strict and ignores invalid roots', () => {
    expect(isStrictlyInside('/data/tv', '/data/tv/Show')).toBe(true);
    expect(isStrictlyInside('/data/tv', '/data/tv')).toBe(false);
    expect(isStrictlyInside('/data/tv', '/data/tv/../x')).toBe(false);
    expect(isStrictlyInside('/data/tv', '/data/tv/..x')).toBe(true);
    expect(insideAnyRoot(['/', '/data/tv'], '/etc/passwd')).toBe(false);
    expect(insideAnyRoot(['/data/tv'], '/data/tv/a.mkv')).toBe(true);
  });
});
