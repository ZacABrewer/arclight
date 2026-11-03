import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

  // iOS: MARKETING_VERSION / CURRENT_PROJECT_VERSION are $(ARCLIGHT_VERSION) / $(ARCLIGHT_BUILD) from
  // ios/App/version.xcconfig, written by scripts/ios-version.mjs with the same rule as Android.
  const xcconfig = (file: string) => {
    const text = readFileSync(file, 'utf8');
    const get = (key: string) => new RegExp(`^${key} = (.+)$`, 'm').exec(text)?.[1]?.trim();
    return { version: get('ARCLIGHT_VERSION'), build: get('ARCLIGHT_BUILD') };
  };
  const script = resolve(__dirname, '../scripts/ios-version.mjs');
  const runScript = (args: string[], code?: string) => {
    const env = { ...process.env };
    delete env.ARCLIGHT_VERSION_CODE;
    delete env.CAPACITOR_PLATFORM_NAME;
    if (code !== undefined) env.ARCLIGHT_VERSION_CODE = code;
    return execFileSync(process.execPath, [script, ...args], { env, encoding: 'utf8', stdio: 'pipe' });
  };

  it('keeps the committed iOS version.xcconfig in step with package.json', () => {
    const [major, minor, patch] = version('../package.json').split(/[.-]/).map(Number) as [number, number, number];
    expect(xcconfig(resolve(__dirname, '../ios/App/version.xcconfig'))).toEqual({
      version: `${major}.${minor}.${patch}`,
      build: String(major * 10000 + minor * 100 + patch),
    });
    expect(() => runScript(['--check'])).not.toThrow();
  });

  it('uses ARCLIGHT_VERSION_CODE for the iOS build number when set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ios-version-'));
    try {
      const out = join(dir, 'version.xcconfig');
      runScript(['--out', out], '30042');
      expect(xcconfig(out).build).toBe('30042');
      expect(() => runScript(['--out', out], '1')).toThrow();
      expect(() => runScript(['--check', '--out', out])).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('wires the Xcode project to version.xcconfig', () => {
    const pbx = readFileSync(resolve(__dirname, '../ios/App/App.xcodeproj/project.pbxproj'), 'utf8');
    expect(pbx).not.toMatch(/MARKETING_VERSION = 1\.0;/);
    expect(pbx.match(/MARKETING_VERSION = "\$\(ARCLIGHT_VERSION\)";/g)).toHaveLength(2);
    expect(pbx.match(/CURRENT_PROJECT_VERSION = "\$\(ARCLIGHT_BUILD\)";/g)).toHaveLength(2);
    expect(pbx).toMatch(/PrivacyInfo\.xcprivacy in Resources \*\/,/);
    for (const cfg of ['debug.xcconfig', 'release.xcconfig']) {
      expect(readFileSync(resolve(__dirname, '../ios', cfg), 'utf8')).toContain('#include "App/version.xcconfig"');
    }
  });
});
