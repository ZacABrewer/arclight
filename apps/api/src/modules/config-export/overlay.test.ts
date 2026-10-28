import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../../events.js';
import { createTestDb } from '../../db/test-utils.js';
import { rootFolders } from '../../db/schema.js';
import { getSection, setSection } from '../settings/service.js';
import { ConfigParseError, coerceEnvValue, parseConfigText, parseEnvOverrides, toYaml } from './overlay.js';
import { ConfigService } from './service.js';
import { buildDocument } from './engine.js';
import { seededDb } from './test-support.js';

function configFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'arclight-config-'));
  const path = join(dir, 'arclight.yml');
  writeFileSync(path, text);
  return path;
}

const FILE = [
  'version: 1',
  'settings:',
  '  metadata:',
  '    region: GB',
  '  metrics:',
  '    allowAnonymous: true',
  'rootFolders:',
  '  /tv:',
  '    mediaType: series',
  '',
].join('\n');

describe('config text', () => {
  it('parses YAML and JSON with one parser, and serialises back', () => {
    expect(parseConfigText('a: 1\nb: [x, y]\n')).toEqual({ a: 1, b: ['x', 'y'] });
    expect(parseConfigText('{"a": 1}')).toEqual({ a: 1 });
    expect(parseConfigText(toYaml({ s: 'x: y', n: null }))).toEqual({ s: 'x: y', n: null });
  });

  it('throws ConfigParseError on broken YAML', () => {
    expect(() => parseConfigText('a: [1, 2')).toThrow(ConfigParseError);
  });

  it('a YAML export round-trips through the parser unchanged', async () => {
    const doc = buildDocument(await seededDb(), { includeSecrets: true });
    expect(parseConfigText(toYaml(doc))).toEqual(doc);
  });
});

describe('env overrides', () => {
  it('coerces by the type of the value being replaced', () => {
    expect(coerceEnvValue('true', false)).toBe(true);
    expect(coerceEnvValue('0', true)).toBe(false);
    expect(coerceEnvValue('42', 7)).toBe(42);
    expect(coerceEnvValue('42', 'x')).toBe('42');
    expect(coerceEnvValue('["a"]', undefined)).toEqual(['a']);
    expect(coerceEnvValue('plain', undefined)).toBe('plain');
  });

  it('matches sections and keys case-insensitively and reports unknown sections', async () => {
    const db = await createTestDb();
    const { overrides, errors } = parseEnvOverrides(db, {
      ARCLIGHT_SETTING__METADATA__REGION: 'DE',
      ARCLIGHT_SETTING__nope__x: '1',
      ARCLIGHT_SETTING__metadata: 'x',
      OTHER: 'y',
    });
    expect(overrides).toEqual([{ name: 'ARCLIGHT_SETTING__METADATA__REGION', section: 'metadata', path: ['region'], value: 'DE' }]);
    expect(errors.map((e) => e.path).sort()).toEqual(['ARCLIGHT_SETTING__metadata', 'ARCLIGHT_SETTING__nope__x']);
  });
});

describe('boot overlay (managed mode)', () => {
  it('applies the config file and lists the keys it manages', async () => {
    const db = await createTestDb();
    const path = configFile(FILE);
    const managed = new ConfigService({ db, env: { ARCLIGHT_CONFIG_FILE: path } }).applyBootOverlay('2026-01-01T00:00:00.000Z');
    expect(managed.errors).toEqual([]);
    expect(managed.file).toBe(path);
    expect(managed.appliedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(managed.settings).toEqual({ metadata: ['region'], metrics: ['allowAnonymous'] });
    expect(managed.resources).toEqual({ rootFolders: ['/tv'] });
    expect(getSection(db, 'metadata').region).toBe('GB');
    expect(db.select().from(rootFolders).all()).toHaveLength(1);
  });

  it('environment overrides win over the file, the file over stored values', async () => {
    const db = await createTestDb();
    setSection(db, 'metadata', { language: 'fr-FR', region: 'FR' });
    const managed = new ConfigService({
      db,
      env: { ARCLIGHT_CONFIG_FILE: configFile(FILE), ARCLIGHT_SETTING__metadata__region: 'NL', ARCLIGHT_SETTING__audit__retentionDays: '7' },
    }).applyBootOverlay();
    expect(getSection(db, 'metadata')).toMatchObject({ region: 'NL', language: 'fr-FR' });
    expect(getSection(db, 'audit').retentionDays).toBe(7);
    expect(managed.settings['audit']).toEqual(['retentionDays']);
    expect([...managed.env].sort()).toEqual(['ARCLIGHT_SETTING__audit__retentionDays', 'ARCLIGHT_SETTING__metadata__region']);
  });

  it('an invalid env value is reported and skipped', async () => {
    const db = await createTestDb();
    const managed = new ConfigService({ db, env: { ARCLIGHT_SETTING__metadata__region: 'TOOLONG' } }).applyBootOverlay();
    expect(managed.errors[0]!.path).toBe('ARCLIGHT_SETTING__metadata__region');
    expect(managed.env).toEqual([]);
    expect(getSection(db, 'metadata').region).toBe('US');
  });

  it('a broken file is reported, not thrown, and nothing from it is applied', async () => {
    const db = await createTestDb();
    const bad = configFile('rootFolders:\n  /tv:\n    mediaType: comics\n');
    const managed = new ConfigService({ db, env: { ARCLIGHT_CONFIG_FILE: bad } }).applyBootOverlay();
    expect(managed.errors[0]!.path).toMatch(/^file:rootFolders/);
    expect(managed.resources).toEqual({});
    expect(db.select().from(rootFolders).all()).toHaveLength(0);
    const unparsable = new ConfigService({ db, env: { ARCLIGHT_CONFIG_FILE: configFile('a: [') } }).applyBootOverlay();
    expect(unparsable.errors[0]!.path).toBe('file');
  });

  it('a missing file and no env leave nothing managed', async () => {
    const managed = new ConfigService({ db: await createTestDb(), env: { ARCLIGHT_CONFIG_FILE: '/nope/arclight.yml' } }).applyBootOverlay();
    expect(managed).toMatchObject({ file: null, appliedAt: null, settings: {}, resources: {}, env: [] });
  });

  it('reverts a UI change to a managed key when the section reports a change', async () => {
    const db = await createTestDb();
    const bus = new EventBus();
    const service = new ConfigService({ db, bus, env: { ARCLIGHT_CONFIG_FILE: configFile(FILE) } });
    service.applyBootOverlay();
    service.watch();
    setSection(db, 'metadata', { ...getSection(db, 'metadata'), region: 'US', language: 'de-DE' });
    bus.publish({ type: 'settings', section: 'metadata' });
    expect(getSection(db, 'metadata')).toMatchObject({ region: 'GB', language: 'de-DE' });
    service.stop();
  });

  it('warns when an API import touches a managed key', async () => {
    const db = await createTestDb();
    const service = new ConfigService({ db, env: { ARCLIGHT_CONFIG_FILE: configFile(FILE) } });
    service.applyBootOverlay();
    const out = service.import({ settings: { metadata: { region: 'SE' } } });
    expect(out.warnings).toContainEqual({ path: 'settings.metadata', message: expect.stringMatching(/managed/) });
  });
});
