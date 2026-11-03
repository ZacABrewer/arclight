import { describe, expect, it } from 'vitest';
import { formatHasToken } from './naming.js';

describe('formatHasToken', () => {
  it('matches the token spellings', () => {
    expect(formatHasToken('{Series Title} - {episode:00}', 'episode')).toBe(true);
    expect(formatHasToken('{ EPISODE }', 'episode')).toBe(true);
    expect(formatHasToken('{episode:000 }', 'episode')).toBe(true);
    expect(formatHasToken('{episode:01}', 'episode')).toBe(false);
    expect(formatHasToken('{episodes}', 'episode')).toBe(false);
    expect(formatHasToken('{{episode}', 'episode')).toBe(true);
    expect(formatHasToken('episode', 'episode')).toBe(false);
  });

  it('stays fast on long runs of spaces', () => {
    const evil = `{${' '.repeat(200_000)}`.repeat(5) + 'x';
    const t = Date.now();
    expect(formatHasToken(evil, 'episode')).toBe(false);
    expect(Date.now() - t).toBeLessThan(500);
  });
});
