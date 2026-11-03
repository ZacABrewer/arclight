import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const version = (rel: string) =>
  (JSON.parse(readFileSync(resolve(__dirname, rel), 'utf8')) as { version: string }).version;

describe('app version', () => {
  // The About screen (__APP_VERSION__) and Android's versionName/versionCode read apps/player's
  // package.json; scripts/bump-version.mjs keeps it at the repo version.
  it('matches the repo version', () => {
    expect(version('../package.json')).toBe(version('../../../package.json'));
  });

  it('derives an Android versionCode above 1', () => {
    const [major, minor, patch] = version('../package.json').split(/[.-]/).map(Number) as [number, number, number];
    expect(minor).toBeLessThan(100);
    expect(patch).toBeLessThan(100);
    expect(major * 10000 + minor * 100 + patch).toBeGreaterThan(1);
  });
});
