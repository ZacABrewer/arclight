import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkI18n } from '../../scripts/i18n-check.mjs';
import { syncLocale } from '../../scripts/i18n-locales.mjs';

const FIXTURES = path.resolve(__dirname, '../../scripts/fixtures/i18n-check');
const run = (name: string) => checkI18n({ srcDir: path.join(FIXTURES, name, 'src'), localesDir: path.join(FIXTURES, name, 'src', 'locales') });

describe('i18n:check', () => {
  it('passes a complete fixture, counting template-prefixed keys as used', () => {
    const result = run('ok');
    expect(result.problems).toEqual([]);
    expect(result.keys).toBe(4);
    expect(result.locales).toEqual(['de']);
  });

  it('reports missing, extra, unused, unknown and mismatched keys', () => {
    const { problems } = run('bad');
    expect(problems).toEqual(
      expect.arrayContaining([
        'de.json: missing key page.title',
        'de.json: missing key page.unused',
        'de.json: key not in en.json: page.extra',
        'de.json: page.count: uses {n} but English uses {count}',
        expect.stringMatching(/^fr\.json: page\.count: Unterminated placeholder/),
        "page.tsx: t('page.notInCatalog') is not in en.json",
        'en.json: unused key page.unused',
      ]),
    );
  });

  it('passes on the real catalogue', () => {
    const result = checkI18n();
    expect(result.problems).toEqual([]);
    expect(result.keys).toBeGreaterThan(1500);
    expect(result.locales.sort()).toEqual(['de', 'es', 'fr', 'nl']);
  });
});

describe('i18n:locales', () => {
  it('adds placeholders, keeps translations, refreshes stale placeholders and drops removed keys', () => {
    const en = { 'a.save': 'Save', 'a.title': 'Library', 'a.new': 'New text' };
    const de = { 'a.save': 'Speichern', 'a.title': '[de] Libary', 'a.gone': 'Weg' };
    expect(syncLocale('de', en, de)).toEqual({ 'a.new': '[de] New text', 'a.save': 'Speichern', 'a.title': '[de] Library' });
  });
});
