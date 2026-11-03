import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localPathFor } from './pull.js';

// DATA-28: paths from the agent must not escape the local folder, and on Windows must not name
// an NTFS alternate data stream or a DOS device.

describe('localPathFor', () => {
  const root = join('/srv', 'pull');

  it('maps a protocol path under the root', () => {
    expect(localPathFor(root, 'Show.S01/ep1.mkv', 'linux')).toBe(join(root, 'Show.S01', 'ep1.mkv'));
  });

  it('refuses traversal, empty segments and backslashes everywhere', () => {
    for (const bad of ['../x', 'a/../../x', 'a//b', 'a\\b', 'C:', 'a/./b', 'a\0b']) {
      expect(() => localPathFor(root, bad, 'linux')).toThrow(/unsafe/);
      expect(() => localPathFor(root, bad, 'win32')).toThrow(/unsafe/);
    }
  });

  it('refuses ":" (alternate data streams) and reserved device names on Windows', () => {
    for (const bad of ['a:b', 'Show/ep.mkv:stream', 'CON', 'con.txt', 'Show/NUL', 'Show/aux.srt', 'COM1.log', 'lpt9', 'CON .txt', 'COM¹']) {
      expect(() => localPathFor(root, bad, 'win32')).toThrow(/unsafe/);
    }
    expect(localPathFor(root, 'Show/CONTROL.txt', 'win32')).toBe(join(root, 'Show', 'CONTROL.txt'));
    expect(localPathFor(root, 'Show/com10.txt', 'win32')).toBe(join(root, 'Show', 'com10.txt'));
  });

  it('keeps ":" and those names on other platforms, where they are ordinary file names', () => {
    expect(localPathFor(root, 'Movie: The Sequel/a.mkv', 'linux')).toBe(join(root, 'Movie: The Sequel', 'a.mkv'));
    expect(localPathFor(root, 'Show/CON.txt', 'linux')).toBe(join(root, 'Show', 'CON.txt'));
  });
});
